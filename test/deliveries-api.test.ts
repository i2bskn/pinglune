import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryList, DeliveryListItem, SubscriptionList } from "../src/api/types";
import { clock } from "../src/clock";
import type { SourceRow, SubscriptionRow, UserRow } from "../src/db/schema";
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
  routeToBot,
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
      connection: null,
      bot: null,
    });
    expect(body.subscriptions.find((s) => s.id === expired.id)?.status).toBe("expired");
    expect(body.subscriptions.find((s) => s.id === ended.id)?.status).toBe("unsubscribed");
    expect(body.subscriptions.find((s) => s.id === broken.id)?.arguments).toBeNull();

    const text = JSON.stringify(body);
    for (const hidden of ["secret", "callback_url", "user_id", "secret-path", "token=abc", active.secret, alice.id]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("leaves sources out of the arguments, keeping the stored value", async () => {
    const row = await createSubscription({
      user: alice,
      arguments: '{"labels":{"env":"prod"},"sources":["app"],"types":["alert.observed"]}',
    });
    const { body } = await getJson<SubscriptionList>("/api/v1/subscriptions");
    expect(body.subscriptions.find((s) => s.id === row.id)?.arguments).toEqual({
      labels: { env: "prod" },
      types: ["alert.observed"],
    });
    const stored = await env.DB.prepare("SELECT arguments FROM subscriptions WHERE id = ?").bind(row.id).first<{ arguments: string }>();
    expect(stored?.arguments).toBe(row.arguments);
  });

  it("returns the bot of each subscription", async () => {
    const webhook = await createSubscription({ user: alice, kind: "webhook", name: "hook" });
    const webhookBot = await routeToBot(webhook, [], { name: "Grok" });
    const queue = await createQueue({ user: alice, name: "Muse" });
    const queueBot = await routeToBot(queue, [], { name: "Muse" });
    const mcp = await createSubscription({ user: alice, callbackUrl: "https://hooks.example.com/a" });
    const mcpBot = await routeToBot(mcp, [], { name: "Dot" });
    // Not assigned: a destination of no bot, a subscription without a connection, one whose connection is revoked,
    // one whose bot is deleted, and one whose connection's bot is a webhook bot.
    const lonely = await createSubscription({ user: alice, kind: "webhook", name: "lonely" });
    const legacy = await createSubscription({ user: alice, callbackUrl: "https://hooks.example.com/b" });
    const revoked = await createSubscription({ user: alice, callbackUrl: "https://hooks.example.com/c" });
    const revokedBot = await routeToBot(revoked, [], { name: "Revoked" });
    await env.DB.prepare("UPDATE mcp_connections SET revoked_at = ?, revoke_reason = 'user' WHERE id = ?")
      .bind(now, revokedBot.connectionId)
      .run();
    const deleted = await createSubscription({ user: alice, callbackUrl: "https://hooks.example.com/d" });
    const deletedBot = await routeToBot(deleted, [], { name: "Deleted" });
    await env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, deletedBot.botId).run();
    const crossed = await createSubscription({ user: alice, callbackUrl: "https://hooks.example.com/e" });
    const crossedBot = await routeToBot(crossed, [], { name: "Crossed" });
    await env.DB.prepare("UPDATE mcp_connections SET bot_id = ? WHERE id = ?")
      .bind(webhookBot.botId, crossedBot.connectionId)
      .run();

    const { body } = await getJson<SubscriptionList>("/api/v1/subscriptions");
    const botOf = (id: string) => body.subscriptions.find((s) => s.id === id)?.bot;
    expect(botOf(webhook.id)).toEqual({ id: webhookBot.botId, name: "Grok" });
    expect(botOf(queue.id)).toEqual({ id: queueBot.botId, name: "Muse" });
    expect(botOf(mcp.id)).toEqual({ id: mcpBot.botId, name: "Dot" });
    for (const row of [lonely, legacy, revoked, deleted, crossed]) expect(botOf(row.id), row.id).toBeNull();
    // The connection still names the bot it is assigned to, whatever its delivery kind.
    expect(body.subscriptions.find((s) => s.id === crossed.id)?.connection).toEqual({
      id: crossedBot.connectionId,
      client_name: "Test client",
      bot_name: "Grok",
    });
  });

  it("requires a signed-in user", async () => {
    expect((await send("/api/v1/subscriptions")).status).toBe(401);
  });
});

describe("GET /api/v1/deliveries", () => {
  it("lists the workspace's deliveries, newest first, with the callback host", async () => {
    const subscription = await createSubscription({ user: alice, callbackUrl: CALLBACK });
    await routeToBot(subscription, [aliceSource.id]);
    await routeToBot(await createSubscription({ user: bob, callbackUrl: "https://bob.example.com/hook" }), [bobSource.id]);
    const first = await ingest(aliceSource);
    const second = await ingest(aliceSource);
    await ingest(bobSource);
    await env.DB.prepare(
      "UPDATE deliveries SET status = 'failed', attempts = 6, last_attempt_at = ?1, last_http_status = 503, last_error = 'http_5xx' WHERE event_id = ?",
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
        destination_name: "Test client",
        status: "pending",
        attempts: 0,
        last_attempt_at: null,
        last_http_status: null,
        last_error: null,
        delivered_at: null,
        created_at: now,
        event: { type: "alert.observed", summary: "s", source_name: "app" },
      },
      {
        id: rowFirst[0]?.id,
        event_id: first,
        subscription_id: subscription.id,
        callback_host: "hooks.example.com",
        destination_kind: "mcp",
        destination_name: "Test client",
        status: "failed",
        attempts: 6,
        last_attempt_at: now,
        last_http_status: 503,
        last_error: "http_5xx",
        delivered_at: null,
        created_at: now,
        event: { type: "alert.observed", summary: "s", source_name: "app" },
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-path");
  });

  it("shows a polling queue with its kind and name, without a callback host", async () => {
    const queue = await createQueue({ user: alice, name: "Muse" });
    await routeToBot(queue, [aliceSource.id]);
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
    await routeToBot(await createSubscription({ user: alice }), [aliceSource.id]);
    await routeToBot(await createSubscription({ user: bob }), [bobSource.id]);
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
    const rows: SubscriptionRow[] = [];
    for (let i = 0; i < 51; i++) {
      rows.push(await createSubscription({ user: alice, callbackUrl: `https://hooks.example.com/pinglune/${i}` }));
    }
    await routeToBot(rows, [aliceSource.id]);
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

  it("filters by status, with the cursor and the event", async () => {
    const rows: SubscriptionRow[] = [];
    for (let i = 0; i < 3; i++) {
      rows.push(await createSubscription({ user: alice, callbackUrl: `https://hooks.example.com/pinglune/${i}` }));
    }
    await routeToBot(rows, [aliceSource.id]);
    const first = await ingest(aliceSource);
    const second = await ingest(aliceSource);
    await env.DB.prepare("UPDATE deliveries SET status = 'failed' WHERE subscription_id != ?").bind(rows[0]?.id).run();
    await env.DB.prepare("UPDATE deliveries SET status = 'delivered' WHERE event_id = ? AND subscription_id = ?")
      .bind(second, rows[1]?.id)
      .run();
    const failed = await listDeliveries("status = 'failed'");
    expect(failed).toHaveLength(3);

    const all = await getJson<DeliveryList>("/api/v1/deliveries?status=failed");
    expect(all.status).toBe(200);
    expect(all.body.deliveries.map((d) => d.id)).toEqual(failed.map((d) => d.id).reverse());
    expect(all.body.deliveries.every((d) => d.status === "failed")).toBe(true);

    const pending = await getJson<DeliveryList>("/api/v1/deliveries?status=pending");
    expect(pending.body.deliveries.map((d) => d.event_id)).toEqual([second, first]);

    const ofFirst = await getJson<DeliveryList>(`/api/v1/deliveries?status=failed&event_id=${first}`);
    expect(ofFirst.body.deliveries.map((d) => d.event_id)).toEqual([first, first]);

    const [newest] = all.body.deliveries;
    const older = await getJson<DeliveryList>(`/api/v1/deliveries?status=failed&cursor=${newest?.id}`);
    expect(older.body.deliveries.map((d) => d.id)).toEqual(failed.map((d) => d.id).reverse().slice(1));
  });

  it("returns the type, the summary and the source of the event of each delivery", async () => {
    const subscription = await createSubscription({ user: alice });
    await routeToBot(subscription, [aliceSource.id]);
    const eventId = await ingest(aliceSource);
    const { body } = await getJson<DeliveryList>("/api/v1/deliveries");
    expect(body.deliveries.map((d) => [d.event_id, d.event])).toEqual([
      [eventId, { type: "alert.observed", summary: "s", source_name: "app" }],
    ]);
  });

  it.each([
    ["cursor=", "invalid_cursor"],
    ["cursor=evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V", "invalid_cursor"],
    ["cursor=dlv_x", "invalid_cursor"],
    ["event_id=", "invalid_event_id"],
    ["event_id=dlv_01JC9Z7H2K4M6N8P0Q2R4S6T8V", "invalid_event_id"],
    ["status=", "invalid_status"],
    ["status=FAILED", "invalid_status"],
    ["status=done", "invalid_status"],
    ["status=failed&status=pending", "invalid_status"],
  ])("rejects %s", async (query, code) => {
    const { status, body } = await getJson<{ error: { code: string } }>(`/api/v1/deliveries?${query}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe(code);
  });

  it("requires a signed-in user", async () => {
    expect((await send("/api/v1/deliveries")).status).toBe(401);
  });
});

describe("POST /api/v1/deliveries/:id/retry", () => {
  type ErrorBody = { error: { code: string; message: string } };

  // A failed delivery of an event of alice's source to the subscription.
  async function failedDelivery(subscription: SubscriptionRow): Promise<string> {
    await routeToBot(subscription, [aliceSource.id]);
    const eventId = await ingest(aliceSource);
    await env.DB.prepare(
      `UPDATE deliveries SET status = 'failed', attempts = 6, last_attempt_at = ?1, last_http_status = 503,
        last_error = 'http_5xx', updated_at = ?1 WHERE event_id = ?2`,
    )
      .bind(now - HOUR, eventId)
      .run();
    const [row] = await listDeliveries("event_id = ?", eventId);
    if (!row) throw new Error("no delivery");
    return row.id;
  }

  function retry(id: string, queue = fakeQueue(), cookies: SessionCookies | null = aliceCookies) {
    return send(`/api/v1/deliveries/${id}/retry`, {
      method: "POST",
      cookies: cookies ?? undefined,
      env: { DELIVERY_QUEUE: queue },
    });
  }

  it("makes a failed webhook delivery pending from the first try and enqueues it", async () => {
    const id = await failedDelivery(await createSubscription({ user: alice, kind: "webhook", name: "hook" }));
    const queue = fakeQueue();
    const res = await retry(id, queue);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeliveryListItem;
    expect(body).toEqual(
      expect.objectContaining({
        id,
        destination_kind: "webhook",
        destination_name: "hook",
        status: "pending",
        attempts: 0,
        last_attempt_at: null,
        last_http_status: null,
        last_error: null,
        delivered_at: null,
        event: { type: "alert.observed", summary: "s", source_name: "app" },
      }),
    );
    expect(queue.messages).toEqual([{ delivery_id: id }]);
    const [row] = await listDeliveries("id = ?", id);
    expect(row).toEqual(
      expect.objectContaining({
        status: "pending",
        attempts: 0,
        last_attempt_at: null,
        last_http_status: null,
        last_error: null,
        delivered_at: null,
        updated_at: now,
      }),
    );
  });

  it("retries a delivery to an MCP Events subscription, whatever the bots link now", async () => {
    const id = await failedDelivery(await createSubscription({ user: alice }));
    await env.DB.prepare("DELETE FROM bot_sources").run();
    const queue = fakeQueue();
    const res = await retry(id, queue);
    expect(res.status).toBe(200);
    expect(queue.messages).toEqual([{ delivery_id: id }]);
  });

  it("answers 409 for a delivery that is not failed, and for a second retry", async () => {
    const id = await failedDelivery(await createSubscription({ user: alice, kind: "webhook" }));
    expect((await retry(id)).status).toBe(200);
    const queue = fakeQueue();
    const res = await retry(id, queue);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error).toEqual({
      code: "not_retryable",
      message: "失敗した配信だけを再送できます",
    });
    expect(queue.messages).toEqual([]);
  });

  it("answers 409 for a delivery to a polling queue, even when it is not failed", async () => {
    const queue = await createQueue({ user: alice });
    await routeToBot(queue, [aliceSource.id]);
    const eventId = await ingest(aliceSource);
    const [row] = await listDeliveries("event_id = ?", eventId);
    for (const status of ["pending", "failed"]) {
      await env.DB.prepare("UPDATE deliveries SET status = ? WHERE id = ?").bind(status, row?.id).run();
      const res = await retry(row?.id ?? "");
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.message).toBe("ポーリング用キューの配信は再送できません");
    }
    const [after] = await listDeliveries("event_id = ?", eventId);
    expect(after?.status).toBe("failed");
  });

  it("answers 409 for an ended or expired destination", async () => {
    const ended = await createSubscription({ user: alice, kind: "webhook" });
    const endedId = await failedDelivery(ended);
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?").bind(now, ended.id).run();
    const expired = await createSubscription({ user: alice, callbackUrl: "https://hooks.example.com/expired" });
    const expiredId = await failedDelivery(expired);
    await env.DB.prepare("UPDATE subscriptions SET expires_at = ? WHERE id = ?").bind(now, expired.id).run();
    for (const id of [endedId, expiredId]) {
      const res = await retry(id);
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error).toEqual({
        code: "not_retryable",
        message: "配信先が終了しているため再送できません",
      });
      const [row] = await listDeliveries("id = ?", id);
      expect(row?.status).toBe("failed");
      expect(row?.last_error).toBe("http_5xx");
    }
  });

  it("ends the delivery as failed again and answers 503 when the queue fails", async () => {
    const id = await failedDelivery(await createSubscription({ user: alice, kind: "webhook" }));
    const queue = fakeQueue();
    queue.fail = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await retry(id, queue);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorBody).error).toEqual({
      code: "temporarily_unavailable",
      message: "再送を受け付けられませんでした。しばらくしてからもう一度お試しください",
    });
    expect(errors).toHaveBeenCalled();
    const [row] = await listDeliveries("id = ?", id);
    expect(row).toEqual(
      expect.objectContaining({ status: "failed", attempts: 0, last_error: "retry_enqueue_failed", last_http_status: null }),
    );
  });

  it("answers 404 for a delivery of another workspace and a malformed ID", async () => {
    await routeToBot(await createSubscription({ user: bob, kind: "webhook" }), [bobSource.id]);
    const theirs = await ingest(bobSource);
    await env.DB.prepare("UPDATE deliveries SET status = 'failed' WHERE event_id = ?").bind(theirs).run();
    const [row] = await listDeliveries("event_id = ?", theirs);
    for (const id of [row?.id ?? "", "dlv_x", "dlv_01JC9Z7H2K4M6N8P0Q2R4S6T8V"]) {
      const queue = fakeQueue();
      const res = await retry(id, queue);
      expect(res.status, id).toBe(404);
      expect(((await res.json()) as ErrorBody).error).toEqual({ code: "not_found", message: "配信が見つかりません" });
      expect(queue.messages).toEqual([]);
    }
    const [after] = await listDeliveries("event_id = ?", theirs);
    expect(after?.status).toBe("failed");
  });

  it("requires a signed-in user and the same origin", async () => {
    const id = await failedDelivery(await createSubscription({ user: alice, kind: "webhook" }));
    expect((await retry(id, fakeQueue(), null)).status).toBe(401);
    const crossSite = await send(`/api/v1/deliveries/${id}/retry`, {
      method: "POST",
      cookies: aliceCookies,
      origin: "https://evil.example.com",
      env: { DELIVERY_QUEUE: fakeQueue() },
    });
    expect(crossSite.status).toBe(403);
    const [row] = await listDeliveries("id = ?", id);
    expect(row?.status).toBe("failed");
  });
});
