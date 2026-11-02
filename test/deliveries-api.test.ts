import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryList, SubscriptionList } from "../src/api/types";
import { clock } from "../src/clock";
import type { SourceRow, UserRow } from "../src/db/schema";
import { acceptEvent } from "../src/intake/service";
import {
  createQueue,
  createSource,
  createSubscription,
  createUser,
  fakeQueue,
  listDeliveries,
  login,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
  type SessionCookies,
} from "./helpers";

const HOUR = 60 * 60 * 1000;
const CALLBACK = "https://hooks.example.com/pinglune/secret-path?token=abc";

let alice: UserRow;
let bob: UserRow;
let aliceCookies: SessionCookies;
let aliceSource: SourceRow;
let bobSource: SourceRow;
let now: number;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  aliceCookies = await login(alice.email);
  aliceSource = await createSource({ workspaceId: (await personalWorkspaceOf(alice)).id, name: "app" });
  bobSource = await createSource({ workspaceId: (await personalWorkspaceOf(bob)).id, name: "app" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

let sequence = 0;

async function ingest(source: SourceRow): Promise<string> {
  sequence++;
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now },
    { id: source.id, workspaceId: source.workspaceId, name: source.name, enabled: true },
    { idempotency_key: `k-${sequence}`, type: "alert.observed", summary: "s" },
  );
  if (!result.ok) throw new Error("ingest failed");
  return result.event_id;
}

async function getJson<T>(path: string, cookies: SessionCookies | undefined = aliceCookies): Promise<{ status: number; body: T }> {
  const res = await send(path, { cookies });
  return { status: res.status, body: (await res.json()) as T };
}

describe("GET /api/v1/subscriptions", () => {
  it("lists the workspace's subscriptions without secrets or the whole callback URL", async () => {
    const active = await createSubscription({
      user: alice,
      callbackUrl: CALLBACK,
      arguments: '{"types":["alert.observed"]}',
      previousSecret: crypto.getRandomValues(new Uint8Array(32)),
      secretRotatedAt: now,
      createdAt: now - 3 * HOUR,
    });
    const expired = await createSubscription({ user: alice, expiresAt: now, createdAt: now - 2 * HOUR });
    const ended = await createSubscription({ user: alice, unsubscribedAt: now - HOUR, createdAt: now - HOUR });
    const broken = await createSubscription({ user: alice, arguments: "{broken", createdAt: now - HOUR });
    await createSubscription({ user: bob });

    const { status, body } = await getJson<SubscriptionList>("/api/v1/subscriptions");
    expect(status).toBe(200);
    // Newest first; the same created_at by id, descending.
    const sameTime = [ended.id, broken.id].sort().reverse();
    expect(body.subscriptions.map((s) => s.id)).toEqual([...sameTime, expired.id, active.id]);

    const first = body.subscriptions.find((s) => s.id === active.id);
    expect(first).toEqual({
      id: active.id,
      kind: "mcp",
      name: null,
      callback_host: "hooks.example.com",
      arguments: { types: ["alert.observed"] },
      status: "active",
      refresh_before: active.expiresAt - HOUR,
      expires_at: active.expiresAt,
      created_at: active.createdAt,
      updated_at: active.updatedAt,
    });
    expect(body.subscriptions.find((s) => s.id === expired.id)?.status).toBe("expired");
    expect(body.subscriptions.find((s) => s.id === ended.id)?.status).toBe("unsubscribed");
    expect(body.subscriptions.find((s) => s.id === broken.id)?.arguments).toBeNull();

    const text = JSON.stringify(body);
    for (const hidden of ["secret", "callback_url", "user_id", "secret-path", "token=abc", active.secret, alice.id]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("requires a signed-in user", async () => {
    expect((await send("/api/v1/subscriptions")).status).toBe(401);
  });
});

describe("GET /api/v1/deliveries", () => {
  it("lists the workspace's deliveries, newest first, with the callback host", async () => {
    const subscription = await createSubscription({ user: alice, callbackUrl: CALLBACK });
    await createSubscription({ user: bob, callbackUrl: "https://bob.example.com/hook" });
    const first = await ingest(aliceSource);
    const second = await ingest(aliceSource);
    await ingest(bobSource);
    await env.DB.prepare(
      "UPDATE deliveries SET status = 'failed', attempts = 6, last_attempt_at = ?, last_http_status = 503, last_error = 'http_5xx' WHERE event_id = ?",
    )
      .bind(now, first)
      .run();

    const { status, body } = await getJson<DeliveryList>("/api/v1/deliveries");
    expect(status).toBe(200);
    expect(body.next_cursor).toBeNull();
    expect(body.deliveries.map((d) => d.event_id)).toEqual([second, first]);
    const [rowSecond, rowFirst] = await Promise.all([
      listDeliveries("event_id = ?", second),
      listDeliveries("event_id = ?", first),
    ]);
    expect(body.deliveries).toEqual([
      {
        id: rowSecond[0]?.id,
        event_id: second,
        subscription_id: subscription.id,
        callback_host: "hooks.example.com",
        destination_kind: "mcp",
        destination_name: null,
        status: "pending",
        attempts: 0,
        last_attempt_at: null,
        last_http_status: null,
        last_error: null,
        delivered_at: null,
        created_at: now,
      },
      {
        id: rowFirst[0]?.id,
        event_id: first,
        subscription_id: subscription.id,
        callback_host: "hooks.example.com",
        destination_kind: "mcp",
        destination_name: null,
        status: "failed",
        attempts: 6,
        last_attempt_at: now,
        last_http_status: 503,
        last_error: "http_5xx",
        delivered_at: null,
        created_at: now,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-path");
  });

  it("shows a polling queue with its kind and name, without a callback host", async () => {
    const queue = await createQueue({ user: alice, name: "Muse" });
    const eventId = await ingest(aliceSource);
    const { body } = await getJson<DeliveryList>("/api/v1/deliveries");
    expect(body.deliveries).toEqual([
      expect.objectContaining({
        event_id: eventId,
        subscription_id: queue.id,
        callback_host: null,
        destination_kind: "queue",
        destination_name: "Muse",
        status: "pending",
      }),
    ]);
  });

  it("filters by event, and an event of another workspace gives an empty list", async () => {
    await createSubscription({ user: alice });
    await createSubscription({ user: bob });
    const mine = await ingest(aliceSource);
    await ingest(aliceSource);
    const theirs = await ingest(bobSource);

    const filtered = await getJson<DeliveryList>(`/api/v1/deliveries?event_id=${mine}`);
    expect(filtered.body.deliveries.map((d) => d.event_id)).toEqual([mine]);

    const other = await getJson<DeliveryList>(`/api/v1/deliveries?event_id=${theirs}`);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ deliveries: [], next_cursor: null });
  });

  it("pages by 50 with the cursor", async () => {
    for (let i = 0; i < 51; i++) await createSubscription({ user: alice });
    const eventId = await ingest(aliceSource);

    const page1 = await getJson<DeliveryList>("/api/v1/deliveries");
    expect(page1.body.deliveries).toHaveLength(50);
    expect(page1.body.next_cursor).toBe(page1.body.deliveries.at(-1)?.id);

    const page2 = await getJson<DeliveryList>(`/api/v1/deliveries?cursor=${page1.body.next_cursor}&event_id=${eventId}`);
    expect(page2.body.deliveries).toHaveLength(1);
    expect(page2.body.next_cursor).toBeNull();
    const all = [...page1.body.deliveries, ...page2.body.deliveries].map((d) => d.id);
    expect(new Set(all).size).toBe(51);
    expect(all).toEqual([...all].sort().reverse());
  });

  it.each([
    ["cursor=", "invalid_cursor"],
    ["cursor=evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V", "invalid_cursor"],
    ["cursor=dlv_x", "invalid_cursor"],
    ["event_id=", "invalid_event_id"],
    ["event_id=dlv_01JC9Z7H2K4M6N8P0Q2R4S6T8V", "invalid_event_id"],
  ])("rejects %s", async (query, code) => {
    const { status, body } = await getJson<{ error: { code: string } }>(`/api/v1/deliveries?${query}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe(code);
  });

  it("requires a signed-in user", async () => {
    expect((await send("/api/v1/deliveries")).status).toBe(401);
  });
});
