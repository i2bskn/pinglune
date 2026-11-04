import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotDetail, DeliveryList, SubscriptionList } from "../src/api/types";
import { clock } from "../src/clock";
import type { SourceRow, SubscriptionRow, UserRow } from "../src/db/schema";
import { subscriptionDeliveriesStatement } from "../src/deliveries/queries";
import { newMcpConnectionId } from "../src/ids";
import { MAX_ACTIVE_QUEUES_PER_WORKSPACE } from "../src/queues/constants";
import { MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE } from "../src/routes/subscriptions";
import { acceptEvent } from "../src/intake/service";
import { decryptSecret, subscriptionSecretKey } from "../src/subscriptions/secret";
import {
  countTable,
  createQueue,
  createSource,
  createSubscription,
  createUser,
  d1With,
  fakeQueue,
  listDeliveries,
  login,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
  TEST_JWT_SECRET,
  type SessionCookies,
} from "./helpers";

const NO_EXPIRY = 253402300799999;
const HOOK_URL = "https://hooks.example.com/pinglune?x=1";
const TOKEN = "secret-token-1";

let alice: UserRow;
let bob: UserRow;
let aliceCookies: SessionCookies;
let bobCookies: SessionCookies;
let source: SourceRow;
let now: number;
let sequence = 0;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  aliceCookies = await login(alice.email);
  bobCookies = await login(bob.email);
  source = await createSource({ workspaceId: (await personalWorkspaceOf(alice)).id, name: "app" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

type SubscriptionRecord = {
  id: string;
  kind: string;
  name: string | null;
  arguments: string;
  callback_url: string;
  secret: string;
  unsubscribed_at: number | null;
  connection_id: string | null;
};

type BotRecord = { name: string; delivery_kind: string; delivery_subscription_id: string | null; deleted_at: number | null };

async function errorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return { status: res.status, code: body.error.code, message: body.error.message };
}

async function expectApiError(res: Response, status: number, code: string): Promise<string> {
  const error = await errorOf(res);
  expect({ status: error.status, code: error.code }).toEqual({ status, code });
  return error.message;
}

function create(body: unknown, cookies = aliceCookies) {
  return send("/api/v1/bots", { cookies, json: body });
}

async function created(body: Record<string, unknown>, cookies = aliceCookies): Promise<Bot> {
  const res = await create(body, cookies);
  expect(res.status).toBe(201);
  return (await res.json()) as Bot;
}

function update(id: string, body: unknown, options: { cookies?: SessionCookies; db?: D1Database } = {}) {
  return send(`/api/v1/bots/${id}/update`, {
    cookies: options.cookies ?? aliceCookies,
    json: body,
    ...(options.db === undefined ? {} : { env: { DB: options.db } }),
  });
}

function remove(id: string, options: { db?: D1Database; query?: string } = {}) {
  return send(`/api/v1/bots/${id}/delete${options.query ?? ""}`, {
    method: "POST",
    cookies: aliceCookies,
    ...(options.db === undefined ? {} : { env: { DB: options.db } }),
  });
}

async function subscriptionRow(id: string): Promise<SubscriptionRecord> {
  const row = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first<SubscriptionRecord>();
  if (!row) throw new Error("subscription not found");
  return row;
}

async function botRecord(id: string): Promise<BotRecord> {
  const row = await env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(id).first<BotRecord>();
  if (!row) throw new Error("bot not found");
  return row;
}

async function linkedSourceIds(botId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT source_id FROM bot_sources WHERE bot_id = ? ORDER BY source_id")
    .bind(botId)
    .all<{ source_id: string }>();
  return results.map((row) => row.source_id);
}

async function tokenOf(row: SubscriptionRecord): Promise<string | null> {
  const plain = await decryptSecret(await subscriptionSecretKey(TEST_JWT_SECRET), row.id, row.secret);
  return plain === null ? null : new TextDecoder().decode(plain);
}

async function ingest(labels: Record<string, string> = {}): Promise<string> {
  sequence++;
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now },
    { id: source.id, workspaceId: source.workspaceId, name: source.name, enabled: true, screeningEnabled: false },
    { idempotency_key: `k-${sequence}`, type: "alert.observed", summary: `s${sequence}`, labels },
  );
  if (!result.ok) throw new Error(`ingest failed: ${result.error.code}`);
  return result.event_id;
}

// A D1 binding whose batch runs change() first, as if another request changed the data right after the route read it.
function changingBeforeBatch(change: () => Promise<unknown>): D1Database {
  let done = false;
  return d1With({
    batch: async (statements: D1PreparedStatement[]) => {
      if (!done) {
        done = true;
        await change();
      }
      return env.DB.batch(statements);
    },
  });
}

// A snapshot of the tables a bot's batches change, to check that a batch changed nothing.
async function snapshot(): Promise<unknown> {
  const tables = ["bots", "subscriptions", "bot_sources", "deliveries", "mcp_connections"];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    result[table] = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  }
  return result;
}

describe("POST /api/v1/bots with a new destination", () => {
  it("makes a webhook destination named after the bot, in the same request", async () => {
    const bot = await created({
      name: "Grok",
      delivery_kind: "webhook",
      webhook: { url: HOOK_URL, token: TOKEN },
      conditions: { types: ["alert.observed"], labels: { env: "prod" } },
      source_ids: [source.id],
    });
    expect(bot).toMatchObject({
      name: "Grok",
      delivery_kind: "webhook",
      delivery: { name: "Grok", callback_host: "hooks.example.com", status: "active" },
      sources: [{ id: source.id, name: "app", enabled: true }],
    });
    const row = await subscriptionRow(bot.delivery?.subscription_id ?? "");
    expect(row).toMatchObject({
      kind: "webhook",
      name: "Grok",
      callback_url: HOOK_URL,
      arguments: '{"labels":{"env":"prod"},"types":["alert.observed"]}',
      unsubscribed_at: null,
      connection_id: null,
    });
    // Encrypted as the registration of a webhook destination encrypts it.
    expect(row.secret).not.toContain(TOKEN);
    expect(await tokenOf(row)).toBe(TOKEN);
    expect((await botRecord(bot.id)).delivery_subscription_id).toBe(row.id);
    // Events of the linked source that match the conditions reach it.
    const eventId = await ingest({ env: "prod" });
    expect(await listDeliveries("event_id = ?", eventId)).toEqual([expect.objectContaining({ subscription_id: row.id })]);
  });

  it("makes a polling queue when no destination is given", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue" });
    const row = await subscriptionRow(bot.delivery?.subscription_id ?? "");
    expect(row).toMatchObject({ kind: "queue", name: "Muse", arguments: "{}", callback_url: "", secret: "" });
    const withConditions = await created({ name: "Muse 2", delivery_kind: "queue", conditions: { types: ["a.b"] } });
    expect((await subscriptionRow(withConditions.delivery?.subscription_id ?? "")).arguments).toBe('{"types":["a.b"]}');
  });

  it("still takes an existing destination", async () => {
    const hook = await createSubscription({ user: alice, kind: "webhook", name: "hook", expiresAt: NO_EXPIRY });
    const bot = await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    expect(bot.delivery?.subscription_id).toBe(hook.id);
    // Its name is kept.
    expect((await subscriptionRow(hook.id)).name).toBe("hook");
    expect(await countTable("subscriptions")).toBe(1);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["webhook with delivery_subscription_id", { delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN }, delivery_subscription_id: `sub_${"a".repeat(32)}` }, "invalid_request"],
    ["conditions with delivery_subscription_id", { delivery_kind: "queue", conditions: {}, delivery_subscription_id: `sub_${"a".repeat(32)}` }, "invalid_request"],
    ["webhook for a queue", { delivery_kind: "queue", webhook: { url: HOOK_URL, token: TOKEN } }, "invalid_request"],
    ["webhook for mcp", { delivery_kind: "mcp", webhook: { url: HOOK_URL, token: TOKEN } }, "invalid_request"],
    ["conditions for mcp", { delivery_kind: "mcp", conditions: {} }, "invalid_request"],
    ["no destination for webhook", { delivery_kind: "webhook" }, "invalid_delivery"],
    ["a webhook that is not an object", { delivery_kind: "webhook", webhook: "x" }, "invalid_request"],
    ["an unknown field of webhook", { delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN, x: 1 } }, "unknown_field"],
    ["an http URL", { delivery_kind: "webhook", webhook: { url: "http://hooks.example.com/", token: TOKEN } }, "invalid_url"],
    ["a URL of this service", { delivery_kind: "webhook", webhook: { url: "https://pinglune.test/hook", token: TOKEN } }, "invalid_url"],
    ["a key with a space", { delivery_kind: "webhook", webhook: { url: HOOK_URL, token: "a b" } }, "invalid_token"],
    ["conditions with sources", { delivery_kind: "queue", conditions: { sources: ["app"] } }, "invalid_filter"],
    ["empty types", { delivery_kind: "queue", conditions: { types: [] } }, "invalid_filter"],
    ["conditions that are not an object", { delivery_kind: "queue", conditions: [] }, "invalid_filter"],
    ["an unknown field of conditions", { delivery_kind: "queue", conditions: { kinds: ["a"] } }, "unknown_field"],
  ])("rejects %s and makes nothing", async (_, body, code) => {
    await expectApiError(await create({ name: "x", ...body }), 400, code);
    expect(await countTable("bots")).toBe(0);
    expect(await countTable("subscriptions")).toBe(0);
  });

  it("makes neither the bot nor the destination when the name is taken", async () => {
    await created({ name: "Grok", delivery_kind: "mcp" });
    await expectApiError(
      await create({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN }, source_ids: [source.id] }),
      409,
      "name_conflict",
    );
    expect(await countTable("bots")).toBe(1);
    expect(await countTable("subscriptions")).toBe(0);
    expect(await countTable("bot_sources")).toBe(0);
  });

  it("makes nothing when a source is invalid", async () => {
    await expectApiError(await create({ name: "Muse", delivery_kind: "queue", source_ids: ["src_x"] }), 400, "invalid_source");
    expect(await countTable("subscriptions")).toBe(0);
  });

  it("keeps the limits of webhook destinations and polling queues", async () => {
    for (let i = 0; i < MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE; i++) {
      await createSubscription({ user: alice, kind: "webhook", name: `w${i}`, expiresAt: NO_EXPIRY });
    }
    for (let i = 0; i < MAX_ACTIVE_QUEUES_PER_WORKSPACE; i++) await createQueue({ user: alice, name: `q${i}` });
    const webhook = await create({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } });
    expect(await expectApiError(webhook, 409, "limit_exceeded")).toBe("Webhook 配信先は 100 件までです");
    const queue = await create({ name: "Muse", delivery_kind: "queue" });
    expect(await expectApiError(queue, 409, "limit_exceeded")).toBe("ポーリング用キューは 100 件までです");
    expect(await countTable("bots")).toBe(0);
  });
});

describe("POST /api/v1/bots/:id/update of the destination", () => {
  it("replaces a webhook destination with a new one and ends the old one, leaving its deliveries to the consumer", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN }, source_ids: [source.id] });
    const old = bot.delivery?.subscription_id ?? "";
    await ingest();
    now += 1000;
    const res = await update(bot.id, { webhook: { url: "https://other.example.com/hook", token: "t2" }, conditions: { types: ["a.b"] } });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Bot;
    const next = updated.delivery?.subscription_id ?? "";
    expect(next).not.toBe(old);
    expect(await subscriptionRow(next)).toMatchObject({ kind: "webhook", name: "Grok", arguments: '{"types":["a.b"]}' });
    expect((await subscriptionRow(old)).unsubscribed_at).toBe(now);
    // A webhook destination is ended as the screen deletes it: the consumer fails what is left pending.
    expect((await listDeliveries("subscription_id = ?", old)).map((d) => d.status)).toEqual(["pending"]);
  });

  it("changes a webhook bot to a new queue and fails the pending deliveries of an ended queue", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } });
    const hook = bot.delivery?.subscription_id ?? "";
    const toQueue = (await (await update(bot.id, { delivery_kind: "queue" })).json()) as Bot;
    expect(toQueue.delivery_kind).toBe("queue");
    const queue = toQueue.delivery?.subscription_id ?? "";
    expect(await subscriptionRow(queue)).toMatchObject({ kind: "queue", name: "Grok" });
    expect((await subscriptionRow(hook)).unsubscribed_at).toBe(now);

    await update(bot.id, { source_ids: [source.id] });
    await ingest();
    now += 1000;
    const toMcp = await update(bot.id, { delivery_kind: "mcp" });
    expect((await toMcp.json()) as Bot).toMatchObject({ delivery_kind: "mcp", delivery: null });
    expect((await subscriptionRow(queue)).unsubscribed_at).toBe(now);
    expect(await listDeliveries("subscription_id = ?", queue)).toEqual([
      expect.objectContaining({ status: "failed", last_error: "subscription_inactive" }),
    ]);
    expect((await botRecord(bot.id)).delivery_subscription_id).toBeNull();
  });

  it("ends the old destination when another one is given by delivery_subscription_id, with or without delivery_kind", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } });
    const first = bot.delivery?.subscription_id ?? "";
    const other = await createSubscription({ user: alice, kind: "webhook", name: "other", expiresAt: NO_EXPIRY });
    expect((await update(bot.id, { delivery_subscription_id: other.id })).status).toBe(200);
    expect((await subscriptionRow(first)).unsubscribed_at).toBe(now);
    // The given destination keeps its name.
    expect((await subscriptionRow(other.id)).name).toBe("other");
    const queue = await createQueue({ user: alice, name: "q" });
    expect((await update(bot.id, { delivery_kind: "queue", delivery_subscription_id: queue.id })).status).toBe(200);
    expect((await subscriptionRow(other.id)).unsubscribed_at).toBe(now);
    expect((await subscriptionRow(queue.id)).unsubscribed_at).toBeNull();
  });

  it("changes nothing about the destination when it would stay the same", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue" });
    const queue = bot.delivery?.subscription_id ?? "";
    for (const body of [{ delivery_subscription_id: queue }, { delivery_kind: "queue" }, { delivery_kind: "queue", delivery_subscription_id: queue }]) {
      expect((await update(bot.id, body)).status).toBe(200);
    }
    expect(await countTable("subscriptions")).toBe(1);
    expect((await subscriptionRow(queue)).unsubscribed_at).toBeNull();
    const dot = await created({ name: "Dot", delivery_kind: "mcp" });
    expect((await update(dot.id, { delivery_kind: "mcp", delivery_subscription_id: null })).status).toBe(200);
  });

  it("changes the conditions of the current destination, keeping its ID", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue", conditions: { types: ["a.b"] } });
    const queue = bot.delivery?.subscription_id ?? "";
    const res = await update(bot.id, { conditions: { labels: { env: "prod" } }, name: "Muse 2" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Bot).delivery?.subscription_id).toBe(queue);
    expect(await subscriptionRow(queue)).toMatchObject({ arguments: '{"labels":{"env":"prod"}}', name: "Muse 2" });
    expect((await update(bot.id, { conditions: {} })).status).toBe(200);
    expect((await subscriptionRow(queue)).arguments).toBe("{}");
  });

  it("rejects conditions for mcp, for an ended destination and with another destination", async () => {
    const dot = await created({ name: "Dot", delivery_kind: "mcp" });
    expect(await expectApiError(await update(dot.id, { conditions: {} }), 400, "invalid_request")).toBe(
      "MCP Event の条件は AI 側で決まります",
    );
    await expectApiError(await update(dot.id, { delivery_kind: "mcp", conditions: {} }), 400, "invalid_request");

    const bot = await created({ name: "Muse", delivery_kind: "queue" });
    const queue = bot.delivery?.subscription_id ?? "";
    const other = await createQueue({ user: alice, name: "other" });
    await expectApiError(await update(bot.id, { delivery_subscription_id: other.id, conditions: {} }), 400, "invalid_request");
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?").bind(now, queue).run();
    expect(await expectApiError(await update(bot.id, { conditions: {} }), 400, "invalid_request")).toBe("配信先が終了しています");
    expect((await subscriptionRow(other.id)).unsubscribed_at).toBeNull();
  });

  it("rejects a webhook for a bot of another kind and a change to webhook without a destination", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue" });
    await expectApiError(await update(bot.id, { webhook: { url: HOOK_URL, token: TOKEN } }), 400, "invalid_request");
    await expectApiError(await update(bot.id, { delivery_kind: "queue", webhook: { url: HOOK_URL, token: TOKEN } }), 400, "invalid_request");
    await expectApiError(
      await update(bot.id, { webhook: { url: HOOK_URL, token: TOKEN }, delivery_subscription_id: null }),
      400,
      "invalid_request",
    );
    await expectApiError(await update(bot.id, { delivery_kind: "webhook" }), 400, "invalid_request");
    await expectApiError(
      await update(bot.id, { delivery_kind: "webhook", webhook: { url: HOOK_URL, token: "a b" } }),
      400,
      "invalid_token",
    );
    await expectApiError(await update(bot.id, { conditions: { x: 1 } }), 400, "unknown_field");
    expect(await countTable("subscriptions")).toBe(1);
  });

  it("renames the current destination with the bot, but not an ended one", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } });
    const hook = bot.delivery?.subscription_id ?? "";
    await update(bot.id, { name: "Grok 2" });
    expect((await subscriptionRow(hook)).name).toBe("Grok 2");
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?").bind(now, hook).run();
    expect((await update(bot.id, { name: "Grok 3" })).status).toBe(200);
    expect((await subscriptionRow(hook)).name).toBe("Grok 2");
    expect((await botRecord(bot.id)).name).toBe("Grok 3");
  });

  it("does not count the destination it ends against the limit", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } });
    for (let i = 0; i < MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE - 1; i++) {
      await createSubscription({ user: alice, kind: "webhook", name: `w${i}`, expiresAt: NO_EXPIRY });
    }
    expect((await update(bot.id, { webhook: { url: HOOK_URL, token: "t2" } })).status).toBe(200);
    const queueBot = await created({ name: "Muse", delivery_kind: "queue" });
    for (let i = 0; i < MAX_ACTIVE_QUEUES_PER_WORKSPACE - 1; i++) await createQueue({ user: alice, name: `q${i}` });
    // A webhook destination is not of the same kind: the limit of queues is full.
    await expectApiError(await update(bot.id, { delivery_kind: "queue" }), 409, "limit_exceeded");
    expect((await update(queueBot.id, { delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } })).status).toBe(409);
  });

  it("changes nothing and answers 409 when the bot changed since it was read", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue", source_ids: [source.id] });
    const queue = bot.delivery?.subscription_id ?? "";
    await ingest();
    const other = await createQueue({ user: alice, name: "other" });
    const app2 = await createSource({ workspaceId: source.workspaceId, name: "app2" });
    // Another request moves the bot to another queue between the read and the batch.
    const db = changingBeforeBatch(() =>
      env.DB.prepare("UPDATE bots SET delivery_subscription_id = ? WHERE id = ?").bind(other.id, bot.id).run(),
    );
    const res = await update(
      bot.id,
      { delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN }, name: "Muse 2", source_ids: [app2.id] },
      { db },
    );
    // Snapshot after the other request's change: the update itself must leave everything as it is.
    const after = await snapshot();
    expect(await expectApiError(res, 409, "conflict")).toBe("Bot がほかの操作で変わりました。読み込み直してください");
    expect(await countTable("subscriptions")).toBe(2);
    expect((await subscriptionRow(queue)).unsubscribed_at).toBeNull();
    expect((await listDeliveries("subscription_id = ?", queue)).map((d) => d.status)).toEqual(["pending"]);
    expect(await botRecord(bot.id)).toMatchObject({ name: "Muse", delivery_kind: "queue", delivery_subscription_id: other.id });
    expect(await linkedSourceIds(bot.id)).toEqual([source.id]);
    expect(await snapshot()).toEqual(after);
  });

  it("leaves the conditions and the name as they are when the bot changed since it was read", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue" });
    const queue = bot.delivery?.subscription_id ?? "";
    const other = await createQueue({ user: alice, name: "other" });
    const db = changingBeforeBatch(() =>
      env.DB.prepare("UPDATE bots SET delivery_subscription_id = ? WHERE id = ?").bind(other.id, bot.id).run(),
    );
    await expectApiError(await update(bot.id, { conditions: { types: ["a.b"] }, name: "Muse 2" }, { db }), 409, "conflict");
    expect(await subscriptionRow(queue)).toMatchObject({ name: "Muse", arguments: "{}" });
    expect(await subscriptionRow(other.id)).toMatchObject({ name: "other", arguments: "{}" });
  });

  it("answers 404 when the bot was deleted since it was read", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue" });
    const db = changingBeforeBatch(() => env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, bot.id).run());
    await expectApiError(await update(bot.id, { delivery_kind: "mcp" }, { db }), 404, "not_found");
    expect((await subscriptionRow(bot.delivery?.subscription_id ?? "")).unsubscribed_at).toBeNull();
  });
});

describe("POST /api/v1/bots/:id/delete with its destination", () => {
  it("ends a polling queue with the bot and fails its pending deliveries", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue", source_ids: [source.id] });
    const queue = bot.delivery?.subscription_id ?? "";
    await ingest();
    expect((await remove(bot.id)).status).toBe(204);
    expect((await subscriptionRow(queue)).unsubscribed_at).toBe(now);
    expect(await listDeliveries("subscription_id = ?", queue)).toEqual([
      expect.objectContaining({ status: "failed", last_error: "subscription_inactive" }),
    ]);
  });

  it("ends a webhook destination given by ID too, and leaves the MCP Events subscriptions of an mcp bot", async () => {
    const hook = await createSubscription({ user: alice, kind: "webhook", name: "hook", expiresAt: NO_EXPIRY });
    const grok = await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    expect((await remove(grok.id)).status).toBe(204);
    expect((await subscriptionRow(hook.id)).unsubscribed_at).toBe(now);

    const dot = await created({ name: "Dot", delivery_kind: "mcp" });
    const connection = newMcpConnectionId(now);
    await env.DB.prepare(
      `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name, redirect_uri, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 'client-1', 'ChatGPT', 'https://chatgpt.com/cb', ?, ?)`,
    )
      .bind(connection, alice.id, source.workspaceId, dot.id, now, now)
      .run();
    const mcp = await createSubscription({ user: alice });
    await env.DB.prepare("UPDATE subscriptions SET connection_id = ? WHERE id = ?").bind(connection, mcp.id).run();
    expect((await remove(dot.id)).status).toBe(204);
    expect((await subscriptionRow(mcp.id)).unsubscribed_at).toBeNull();
    const row = await env.DB.prepare("SELECT bot_id FROM mcp_connections WHERE id = ?").bind(connection).first<{ bot_id: string | null }>();
    expect(row?.bot_id).toBeNull();
  });

  it("changes nothing and answers 409 when the bot changed since it was read", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue", source_ids: [source.id] });
    const queue = bot.delivery?.subscription_id ?? "";
    await ingest();
    const other = await createQueue({ user: alice, name: "other" });
    const db = changingBeforeBatch(() =>
      env.DB.prepare("UPDATE bots SET delivery_subscription_id = ? WHERE id = ?").bind(other.id, bot.id).run(),
    );
    const res = await remove(bot.id, { db });
    const after = await snapshot();
    await expectApiError(res, 409, "conflict");
    expect((await subscriptionRow(queue)).unsubscribed_at).toBeNull();
    expect((await subscriptionRow(other.id)).unsubscribed_at).toBeNull();
    expect((await botRecord(bot.id)).deleted_at).toBeNull();
    expect(await linkedSourceIds(bot.id)).toEqual([source.id]);
    expect((await listDeliveries("subscription_id = ?", queue)).map((d) => d.status)).toEqual(["pending"]);
    expect(await snapshot()).toEqual(after);
  });

  it("answers 204 when another request deleted the bot meanwhile", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue" });
    const db = changingBeforeBatch(() => env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, bot.id).run());
    expect((await remove(bot.id, { db })).status).toBe(204);
    // The other request did not end the queue, and this one changed nothing.
    expect((await subscriptionRow(bot.delivery?.subscription_id ?? "")).unsubscribed_at).toBeNull();
  });
});

describe("POST /api/v1/bots/:id/delete?keep_destination=", () => {
  it("ends the destination with keep_destination=false, as without it", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue", source_ids: [source.id] });
    const queue = bot.delivery?.subscription_id ?? "";
    await ingest();
    expect((await remove(bot.id, { query: "?keep_destination=false" })).status).toBe(204);
    expect((await subscriptionRow(queue)).unsubscribed_at).toBe(now);
    expect((await listDeliveries("subscription_id = ?", queue)).map((d) => d.status)).toEqual(["failed"]);
  });

  it("keeps a webhook destination, not assigned to a bot, with what is pending on it, for another bot", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN }, source_ids: [source.id] });
    const hook = bot.delivery?.subscription_id ?? "";
    await ingest();
    now += 1000;
    expect((await remove(bot.id, { query: "?keep_destination=true" })).status).toBe(204);
    expect((await botRecord(bot.id)).deleted_at).toBe(now);
    expect(await linkedSourceIds(bot.id)).toEqual([]);
    const row = await subscriptionRow(hook);
    expect(row).toMatchObject({ kind: "webhook", name: "Grok", callback_url: HOOK_URL, unsubscribed_at: null });
    expect(await tokenOf(row)).toBe(TOKEN);
    expect((await listDeliveries("subscription_id = ?", hook)).map((d) => d.status)).toEqual(["pending"]);

    const list = (await (await send("/api/v1/subscriptions", { cookies: aliceCookies })).json()) as SubscriptionList;
    expect(list.subscriptions.find((s) => s.id === hook)).toMatchObject({ bot: null });

    const next = await created({ name: "Next", delivery_kind: "webhook", delivery_subscription_id: hook });
    expect(next.delivery?.subscription_id).toBe(hook);
    expect((await botRecord(next.id)).delivery_subscription_id).toBe(hook);
  });

  it("keeps a polling queue without failing its pending deliveries", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue", source_ids: [source.id] });
    const queue = bot.delivery?.subscription_id ?? "";
    await ingest();
    expect((await remove(bot.id, { query: "?keep_destination=true" })).status).toBe(204);
    expect((await subscriptionRow(queue)).unsubscribed_at).toBeNull();
    expect((await listDeliveries("subscription_id = ?", queue)).map((d) => d.status)).toEqual(["pending"]);
    const next = await created({ name: "Next", delivery_kind: "queue", delivery_subscription_id: queue });
    expect(next.delivery?.subscription_id).toBe(queue);
  });

  it("takes keep_destination=true for an mcp bot, which has no destination", async () => {
    const bot = await created({ name: "Dot", delivery_kind: "mcp" });
    expect((await remove(bot.id, { query: "?keep_destination=true" })).status).toBe(204);
    expect((await botRecord(bot.id)).deleted_at).toBe(now);
  });

  it("rejects a value other than true or false, before 404 and 204, and changes nothing", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue" });
    const before = await snapshot();
    for (const query of ["?keep_destination=", "?keep_destination=1", "?keep_destination=TRUE", "?keep_destination=true&keep_destination=true"]) {
      const message = await expectApiError(await remove(bot.id, { query }), 400, "invalid_request");
      expect(message).toBe("keep_destination は true か false で指定してください");
    }
    expect(await snapshot()).toEqual(before);
    await expectApiError(await remove("bot_missing", { query: "?keep_destination=yes" }), 400, "invalid_request");
    expect((await remove(bot.id)).status).toBe(204);
    await expectApiError(await remove(bot.id, { query: "?keep_destination=yes" }), 400, "invalid_request");
  });

  it("ignores other query parameters", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue" });
    expect((await remove(bot.id, { query: "?other=1&keep_destination=true" })).status).toBe(204);
    expect((await subscriptionRow(bot.delivery?.subscription_id ?? "")).unsubscribed_at).toBeNull();
  });

  it("changes nothing and answers 409 when the bot changed since it was read, keeping or not", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue", source_ids: [source.id] });
    const other = await createQueue({ user: alice, name: "other" });
    const db = changingBeforeBatch(() =>
      env.DB.prepare("UPDATE bots SET delivery_subscription_id = ? WHERE id = ?").bind(other.id, bot.id).run(),
    );
    const res = await remove(bot.id, { db, query: "?keep_destination=true" });
    const after = await snapshot();
    await expectApiError(res, 409, "conflict");
    expect((await botRecord(bot.id)).deleted_at).toBeNull();
    expect(await linkedSourceIds(bot.id)).toEqual([source.id]);
    expect(await snapshot()).toEqual(after);
  });
});

describe("GET /api/v1/bots/:id", () => {
  it("returns the bot with its destination, ended or not", async () => {
    const bot = await created({ name: "Muse", delivery_kind: "queue", conditions: { types: ["a.b"] } });
    const queue = bot.delivery?.subscription_id ?? "";
    const res = await send(`/api/v1/bots/${bot.id}`, { cookies: aliceCookies });
    expect(res.status).toBe(200);
    expect((await res.json()) as BotDetail).toEqual({
      ...bot,
      destination: { subscription_id: queue, kind: "queue", name: "Muse", callback_host: null, status: "active", arguments: { types: ["a.b"] } },
    });
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?").bind(now, queue).run();
    const ended = (await (await send(`/api/v1/bots/${bot.id}`, { cookies: aliceCookies })).json()) as BotDetail;
    expect(ended.delivery).toBeNull();
    expect(ended.destination?.status).toBe("unsubscribed");

    const dot = await created({ name: "Dot", delivery_kind: "mcp" });
    expect(((await (await send(`/api/v1/bots/${dot.id}`, { cookies: aliceCookies })).json()) as BotDetail).destination).toBeNull();
  });

  it("answers a deleted, missing, malformed or other user's bot with 404", async () => {
    const bot = await created({ name: "Dot", delivery_kind: "mcp" });
    await expectApiError(await send(`/api/v1/bots/${bot.id}`, { cookies: bobCookies }), 404, "not_found");
    await remove(bot.id);
    await expectApiError(await send(`/api/v1/bots/${bot.id}`, { cookies: aliceCookies }), 404, "not_found");
    await expectApiError(await send("/api/v1/bots/bot_x", { cookies: aliceCookies }), 404, "not_found");
  });
});

describe("GET /api/v1/deliveries?subscription_id=", () => {
  it("lists the deliveries to one subscription, with the status and the cursor", async () => {
    const muse = await created({ name: "Muse", delivery_kind: "queue", source_ids: [source.id] });
    const grok = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN }, source_ids: [source.id] });
    const queue = muse.delivery?.subscription_id ?? "";
    const first = await ingest();
    const second = await ingest();
    await env.DB.prepare("UPDATE deliveries SET status = 'failed' WHERE event_id = ? AND subscription_id = ?").bind(first, queue).run();

    const list = async (query: string) => {
      const res = await send(`/api/v1/deliveries?${query}`, { cookies: aliceCookies });
      expect(res.status).toBe(200);
      return (await res.json()) as DeliveryList;
    };
    const all = await list(`subscription_id=${queue}`);
    expect(all.deliveries.map((d) => [d.event_id, d.subscription_id])).toEqual([
      [second, queue],
      [first, queue],
    ]);
    expect((await list(`subscription_id=${queue}&status=failed`)).deliveries.map((d) => d.event_id)).toEqual([first]);
    const cursor = all.deliveries[0]?.id ?? "";
    expect((await list(`subscription_id=${queue}&cursor=${cursor}`)).deliveries.map((d) => d.event_id)).toEqual([first]);
    expect((await list(`subscription_id=${grok.delivery?.subscription_id ?? ""}`)).deliveries).toHaveLength(2);
    // Another workspace sees nothing.
    const bobs = await send(`/api/v1/deliveries?subscription_id=${queue}`, { cookies: bobCookies });
    expect(((await bobs.json()) as DeliveryList).deliveries).toEqual([]);
  });

  it.each(["sub_x", "", "abc"])("rejects the subscription_id %j", async (value) => {
    await expectApiError(
      await send(`/api/v1/deliveries?subscription_id=${value}`, { cookies: aliceCookies }),
      400,
      "invalid_subscription_id",
    );
  });

  it("reads the deliveries with deliveries_subscription_id_idx", async () => {
    const statement = subscriptionDeliveriesStatement(env.DB, source.workspaceId, `sub_${"a".repeat(32)}`, { status: "failed" }, 51);
    // EXPLAIN QUERY PLAN with the same SQL and bindings.
    const sql = (statement as unknown as { statement: string }).statement;
    const params = (statement as unknown as { params: unknown[] }).params;
    expect(typeof sql).toBe("string");
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    expect(results.map((row) => row.detail).join("\n")).toContain("deliveries_subscription_id_idx");
  });
});

describe("GET /api/v1/subscriptions with many connections", () => {
  it("returns the connection of every MCP Events subscription, beyond one IN list", async () => {
    const workspaceId = source.workspaceId;
    const rows: SubscriptionRow[] = [];
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 95; i++) {
      const row = await createSubscription({ user: alice, callbackUrl: `https://hooks.example.com/${i}` });
      const connection = newMcpConnectionId(now + i);
      statements.push(
        env.DB.prepare(
          `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name, redirect_uri, created_at, updated_at)
          VALUES (?, ?, ?, NULL, NULL, 'client-1', ?, 'https://chatgpt.com/cb', ?, ?)`,
        ).bind(connection, alice.id, workspaceId, `app ${i}`, now, now),
        env.DB.prepare("UPDATE subscriptions SET connection_id = ? WHERE id = ?").bind(connection, row.id),
      );
      rows.push({ ...row, connectionId: connection });
    }
    await env.DB.batch(statements);
    const res = await send("/api/v1/subscriptions", { cookies: aliceCookies });
    const body = (await res.json()) as SubscriptionList;
    expect(body.subscriptions).toHaveLength(95);
    for (const row of rows) {
      expect(body.subscriptions.find((s) => s.id === row.id)?.connection).toEqual({
        id: row.connectionId,
        client_name: expect.stringMatching(/^app \d+$/),
        bot_name: null,
      });
    }
  });
});
