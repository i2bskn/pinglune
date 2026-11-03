import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Subscription, SubscriptionList } from "../src/api/types";
import { clock } from "../src/clock";
import { MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE } from "../src/routes/subscriptions";
import type { SourceRow, UserRow } from "../src/db/schema";
import { acceptEvent } from "../src/intake/service";
import { findSubscriptionById, NO_EXPIRY } from "../src/subscriptions/queries";
import { decryptSecret, subscriptionSecretKey } from "../src/subscriptions/secret";
import {
  createSource,
  createSubscription,
  createUser,
  db,
  fakeQueue,
  listDeliveries,
  login,
  ORIGIN,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  routeToBot,
  send,
  TEST_JWT_SECRET,
  type SessionCookies,
} from "./helpers";

const URL_WITH_SECRET = "https://api2.example.com/automations/webhook/abc-123?x=1";
const TOKEN = "crsr_0123456789abcdefghijklmnopqrstuvwxyz";

let alice: UserRow;
let bob: UserRow;
let aliceCookies: SessionCookies;
let bobCookies: SessionCookies;
let aliceSource: SourceRow;
let now: number;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  aliceCookies = await login(alice.email);
  bobCookies = await login(bob.email);
  aliceSource = await createSource({ workspaceId: (await personalWorkspaceOf(alice)).id, name: "app" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

type Body = Record<string, unknown>;

function create(body: Body, cookies: SessionCookies = aliceCookies, options: { env?: Record<string, string> } = {}) {
  return send("/api/v1/subscriptions/webhooks", { cookies, json: body, env: options.env });
}

function remove(id: string, cookies: SessionCookies = aliceCookies) {
  return send(`/api/v1/subscriptions/${id}/delete`, { method: "POST", cookies });
}

async function created(body: Body = {}, cookies: SessionCookies = aliceCookies): Promise<Subscription> {
  const res = await create({ name: "Grok Bot", url: URL_WITH_SECRET, token: TOKEN, ...body }, cookies);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Subscription;
}

async function errorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return { status: res.status, code: body.error.code, message: body.error.message };
}

async function list(cookies: SessionCookies = aliceCookies): Promise<Subscription[]> {
  const res = await send("/api/v1/subscriptions", { cookies });
  expect(res.status).toBe(200);
  return ((await res.json()) as SubscriptionList).subscriptions;
}

let sequence = 0;

async function ingest(input: Record<string, unknown> = {}): Promise<string> {
  sequence++;
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now },
    { id: aliceSource.id, workspaceId: aliceSource.workspaceId, name: aliceSource.name, enabled: true },
    { idempotency_key: `k-${sequence}`, type: "alert.observed", summary: "s", labels: { project: "a" }, ...input },
  );
  if (!result.ok) throw new Error("ingest failed");
  return result.event_id;
}

describe("POST /api/v1/subscriptions/webhooks", () => {
  it("creates a webhook destination without returning the key or the whole URL", async () => {
    const res = await create({
      name: "  Grok Bot  ",
      url: URL_WITH_SECRET,
      token: TOKEN,
      types: ["alert.observed"],
      labels: { project: "a" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Subscription;
    expect(body).toEqual({
      id: expect.stringMatching(/^sub_[0-9a-f]{32}$/),
      kind: "webhook",
      name: "Grok Bot",
      callback_host: "api2.example.com",
      arguments: { labels: { project: "a" }, types: ["alert.observed"] },
      status: "active",
      refresh_before: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
      connection: null,
      bot: null,
    });
    const text = JSON.stringify(body);
    for (const hidden of [TOKEN, "abc-123", "automations", "x=1", alice.id]) expect(text).not.toContain(hidden);

    const row = await findSubscriptionById(db, body.id);
    expect(row).toMatchObject({
      userId: alice.id,
      workspaceId: (await personalWorkspaceOf(alice)).id,
      kind: "webhook",
      name: "Grok Bot",
      eventName: "pinglune.event",
      arguments: '{"labels":{"project":"a"},"types":["alert.observed"]}',
      callbackUrl: URL_WITH_SECRET,
      previousSecret: null,
      secretRotatedAt: null,
      expiresAt: NO_EXPIRY,
      unsubscribedAt: null,
    });
    // Encrypted with the ID, not the plain key.
    expect(row?.secret).not.toContain(TOKEN);
    const key = await subscriptionSecretKey(TEST_JWT_SECRET);
    const plain = await decryptSecret(key, body.id, row?.secret ?? "");
    expect(plain === null ? null : new TextDecoder().decode(plain)).toBe(TOKEN);
  });

  it("stores no conditions as {}", async () => {
    const body = await created();
    expect(body.arguments).toEqual({});
    expect((await findSubscriptionById(db, body.id))?.arguments).toBe("{}");
  });

  it("allows the same name twice", async () => {
    const first = await created();
    const second = await created();
    expect(first.id).not.toBe(second.id);
  });

  it.each<[string, unknown]>([
    ["missing", undefined],
    ["empty", "   "],
    ["too long", "あ".repeat(65)],
    ["with a control character", "a\u0007b"],
    ["not a string", 1],
  ])("rejects a name that is %s", async (_label, name) => {
    const body: Body = { url: URL_WITH_SECRET, token: TOKEN };
    if (name !== undefined) body.name = name;
    expect(await errorOf(await create(body))).toEqual({
      status: 400,
      code: "invalid_name",
      message: "名前は制御文字を含まない 1〜64 文字にしてください",
    });
  });

  it("accepts a name of 64 characters", async () => {
    expect((await create({ name: "あ".repeat(64), url: URL_WITH_SECRET, token: TOKEN })).status).toBe(201);
  });

  it.each([
    "http://hooks.example.com/x",
    "https://user:pass@hooks.example.com/x",
    "https://hooks.example.com:8443/x",
    "https://hooks.example.com/x#frag",
    "not a url",
    `https://hooks.example.com/${"a".repeat(2048)}`,
  ])("rejects the URL %s", async (url) => {
    expect(await errorOf(await create({ name: "x", url, token: TOKEN }))).toEqual({
      status: 400,
      code: "invalid_url",
      message: "URL が正しくありません（https のみ）",
    });
  });

  it("rejects a URL to the host of the request", async () => {
    const host = new URL(ORIGIN).hostname;
    const res = await create({ name: "x", url: `https://${host.toUpperCase()}./hook`, token: TOKEN });
    expect(await errorOf(res)).toMatchObject({ status: 400, code: "invalid_url" });
  });

  it("rejects a URL to the host of APP_ORIGIN", async () => {
    const res = await create(
      { name: "x", url: "https://app.example.com/hook", token: TOKEN },
      aliceCookies,
      { env: { APP_ORIGIN: "https://app.example.com" } },
    );
    expect(await errorOf(res)).toMatchObject({ status: 400, code: "invalid_url" });
  });

  it("accepts a key of 1024 characters", async () => {
    expect((await create({ name: "x", url: URL_WITH_SECRET, token: "k".repeat(1024) })).status).toBe(201);
  });

  it.each<[string, unknown]>([
    ["empty", ""],
    ["of 1025 characters", "k".repeat(1025)],
    ["with a space inside", "crsr abc"],
    ["with a space around", ` ${TOKEN}`],
    ["with a newline", `${TOKEN}\n`],
    ["not ASCII", "crsr_鍵"],
    ["not a string", 123],
  ])("rejects a key that is %s", async (_label, token) => {
    expect(await errorOf(await create({ name: "x", url: URL_WITH_SECRET, token }))).toEqual({
      status: 400,
      code: "invalid_token",
      message: "キーは空白を含まない印字可能な ASCII（1〜1024 文字）にしてください",
    });
  });

  it.each<[string, Body]>([
    ["empty types", { types: [] }],
    ["empty sources", { sources: [] }],
    ["empty labels", { labels: {} }],
    ["an invalid type", { types: ["Not A Type!"] }],
    ["types that are not an array", { types: "alert.observed" }],
    ["null sources", { sources: null }],
    ["sources, which the bot's linked sources decide", { sources: ["app"] }],
    ["a label value that is not a string", { labels: { project: 1 } }],
  ])("rejects %s", async (_label, filter) => {
    expect(await errorOf(await create({ name: "x", url: URL_WITH_SECRET, token: TOKEN, ...filter }))).toEqual({
      status: 400,
      code: "invalid_filter",
      message: "条件が正しくありません",
    });
  });

  it("rejects unknown fields", async () => {
    const res = await create({ name: "x", url: URL_WITH_SECRET, token: TOKEN, ttlMs: 1 });
    expect(await errorOf(res)).toMatchObject({ status: 400, code: "unknown_field" });
  });

  it("allows 100 active destinations per workspace, not counting deleted ones", async () => {
    const first = await created();
    for (let i = 1; i < MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE; i++) {
      await createSubscription({ user: alice, kind: "webhook", name: `w${i}`, expiresAt: NO_EXPIRY });
    }
    expect(await errorOf(await create({ name: "x", url: URL_WITH_SECRET, token: TOKEN }))).toEqual({
      status: 409,
      code: "limit_exceeded",
      message: "Webhook 配信先は 100 件までです",
    });
    // Other workspaces and MCP subscriptions have their own counts.
    await created({}, bobCookies);
    expect((await remove(first.id)).status).toBe(200);
    expect((await create({ name: "x", url: URL_WITH_SECRET, token: TOKEN })).status).toBe(201);
  });

  it("does not count MCP subscriptions", async () => {
    for (let i = 0; i < MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE; i++) await createSubscription({ user: alice });
    expect((await create({ name: "x", url: URL_WITH_SECRET, token: TOKEN })).status).toBe(201);
  });

  it("requires a signed-in user", async () => {
    expect((await send("/api/v1/subscriptions/webhooks", { json: { name: "x" } })).status).toBe(401);
  });

  it("requires the same origin", async () => {
    const res = await send("/api/v1/subscriptions/webhooks", {
      cookies: aliceCookies,
      json: { name: "x", url: URL_WITH_SECRET, token: TOKEN },
      origin: "https://evil.example.com",
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/subscriptions/:id/delete", () => {
  it("ends the destination and keeps the first unsubscribed_at", async () => {
    const destination = await created();
    now += 1000;
    const res = await remove(destination.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: destination.id, kind: "webhook", status: "unsubscribed", updated_at: now });
    const ended = now;
    expect((await findSubscriptionById(db, destination.id))?.unsubscribedAt).toBe(ended);

    now += 1000;
    const again = await remove(destination.id);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "unsubscribed", updated_at: ended });
    expect((await findSubscriptionById(db, destination.id))?.unsubscribedAt).toBe(ended);
  });

  it("returns 404 for another workspace's destination", async () => {
    const theirs = await created({}, bobCookies);
    expect(await errorOf(await remove(theirs.id))).toEqual({
      status: 404,
      code: "not_found",
      message: "配信先が見つかりません",
    });
    expect((await findSubscriptionById(db, theirs.id))?.unsubscribedAt).toBeNull();
  });

  it("stops an MCP subscription", async () => {
    const subscription = await createSubscription({ user: alice });
    const res = await remove(subscription.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: subscription.id, kind: "mcp", status: "unsubscribed", updated_at: now });
    expect((await findSubscriptionById(db, subscription.id))?.unsubscribedAt).toBe(now);
  });

  it("returns 404 for another workspace's MCP subscription", async () => {
    const subscription = await createSubscription({ user: bob });
    expect(await errorOf(await remove(subscription.id))).toMatchObject({ status: 404, code: "not_found" });
    expect((await findSubscriptionById(db, subscription.id))?.unsubscribedAt).toBeNull();
  });

  it.each(["sub_123", "sub_0123456789ABCDEF0123456789ABCDEF", "x"])("returns 404 for the malformed ID %s", async (id) => {
    expect(await errorOf(await remove(id))).toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("GET /api/v1/subscriptions with webhook destinations", () => {
  it("lists MCP subscriptions first, then webhook destinations with the active ones first", async () => {
    const mcp = await createSubscription({ user: alice });
    const older = await created({ name: "older" });
    now += 1000;
    const newer = await created({ name: "newer" });
    expect((await remove(newer.id)).status).toBe(200);
    await created({}, bobCookies);

    const subscriptions = await list();
    expect(subscriptions.map((s) => [s.id, s.kind, s.status])).toEqual([
      [mcp.id, "mcp", "active"],
      [older.id, "webhook", "active"],
      [newer.id, "webhook", "unsubscribed"],
    ]);
    expect(subscriptions[0]).toMatchObject({ name: null, refresh_before: mcp.expiresAt - 60 * 60 * 1000 });
    expect(subscriptions[1]).toMatchObject({ name: "older", refresh_before: null, expires_at: null });
  });

  it("returns the active webhook destinations when there are 100 or more MCP subscriptions", async () => {
    const destination = await created();
    // Many ended destinations newer than the active one.
    for (let i = 0; i < 101; i++) {
      await createSubscription({
        user: alice,
        kind: "webhook",
        name: "old",
        secret: new TextEncoder().encode(TOKEN),
        expiresAt: NO_EXPIRY,
        unsubscribedAt: now,
        createdAt: now + 1 + i,
      });
    }
    for (let i = 0; i < 101; i++) await createSubscription({ user: alice, createdAt: now + 1 + i });

    const subscriptions = await list();
    expect(subscriptions.filter((s) => s.kind === "mcp")).toHaveLength(100);
    const webhooks = subscriptions.filter((s) => s.kind === "webhook");
    expect(webhooks).toHaveLength(100);
    expect(webhooks[0]?.id).toBe(destination.id);
  });

  it("does not return rows of an unknown kind", async () => {
    const row = await createSubscription({ user: alice });
    await env.DB.prepare("UPDATE subscriptions SET kind = 'other' WHERE id = ?").bind(row.id).run();
    expect(await list()).toEqual([]);
  });
});

describe("deliveries to webhook destinations", () => {
  // A webhook destination created through the API, delivered to by a bot linked to alice's source.
  async function routed(body: Body = {}): Promise<Subscription> {
    const destination = await created(body);
    const row = await findSubscriptionById(db, destination.id);
    if (!row) throw new Error("created webhook destination not found");
    await routeToBot(row, [aliceSource.id]);
    return destination;
  }

  it("creates deliveries for matching events only", async () => {
    const all = await routed();
    const byType = await routed({ types: ["alert.observed"] });
    const otherType = await routed({ types: ["job.finished"] });
    const byLabel = await routed({ labels: { project: "a" } });
    const otherLabel = await routed({ labels: { project: "b" } });
    const ended = await routed();
    expect((await remove(ended.id)).status).toBe(200);

    const eventId = await ingest();
    const ids = (await listDeliveries("event_id = ?", eventId)).map((row) => row.subscription_id).sort();
    expect(ids).toEqual([all.id, byType.id, byLabel.id].sort());
    expect(ids).not.toContain(otherType.id);
    expect(ids).not.toContain(otherLabel.id);
    expect(ids).not.toContain(ended.id);
  });
});

describe("the kind column", () => {
  it("defaults to mcp for rows inserted without it, as by code before the migration", async () => {
    const workspace = await personalWorkspaceOf(alice);
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, workspace_id, event_name, arguments, callback_url, secret, expires_at,
        created_at, updated_at) VALUES (?, ?, ?, 'pinglune.event', '{}', 'https://hooks.example.com/', 'x', ?, ?, ?)`,
    )
      .bind("sub_ffffffffffffffffffffffffffffffff", alice.id, workspace.id, now + 1000, now, now)
      .run();
    const row = await findSubscriptionById(db, "sub_ffffffffffffffffffffffffffffffff");
    expect(row).toMatchObject({ kind: "mcp", name: null });
  });
});
