import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotList } from "../src/api/types";
import { MAX_BOTS_PER_WORKSPACE, resolveBotDeliveries } from "../src/bots/queries";
import { clock } from "../src/clock";
import type { BotRow, SourceRow, SubscriptionRow, UserRow } from "../src/db/schema";
import { newBotId, newMcpConnectionId } from "../src/ids";
import {
  countTable,
  createQueue,
  createSource,
  createSubscription,
  createUser,
  db,
  login,
  personalWorkspaceOf,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

const NO_EXPIRY = 253402300799999;

let alice: UserRow;
let bob: UserRow;
let aliceCookies: SessionCookies;
let bobCookies: SessionCookies;
let hook: SubscriptionRow;
let queue: SubscriptionRow;
let now: number;

beforeEach(async () => {
  await resetDb();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  aliceCookies = await login(alice.email);
  bobCookies = await login(bob.email);
  hook = await createSubscription({ user: alice, kind: "webhook", name: "grok", expiresAt: NO_EXPIRY });
  queue = await createQueue({ user: alice, name: "muse" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

async function expectApiError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
}

function create(body: unknown, cookies = aliceCookies) {
  return send("/api/v1/bots", { cookies, json: body });
}

async function created(body: Record<string, unknown>, cookies = aliceCookies): Promise<Bot> {
  const res = await create(body, cookies);
  expect(res.status).toBe(201);
  return (await res.json()) as Bot;
}

function update(id: string, body: unknown, cookies = aliceCookies) {
  return send(`/api/v1/bots/${id}/update`, { cookies, json: body });
}

function remove(id: string, cookies = aliceCookies) {
  return send(`/api/v1/bots/${id}/delete`, { method: "POST", cookies });
}

async function list(cookies = aliceCookies): Promise<Bot[]> {
  const res = await send("/api/v1/bots", { cookies });
  expect(res.status).toBe(200);
  return ((await res.json()) as BotList).bots;
}

// Inserts an active MCP connection of the user, assigned to botId.
async function connect(user: UserRow, botId: string | null, clientName = "ChatGPT"): Promise<string> {
  const id = newMcpConnectionId(now);
  await env.DB.prepare(
    `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name, redirect_uri, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, 'client-1', ?, 'https://chatgpt.com/connector/cb', ?, ?)`,
  )
    .bind(id, user.id, (await personalWorkspaceOf(user)).id, botId, clientName, now, now)
    .run();
  return id;
}

// An MCP Events subscription of alice made by a connection, updated at updatedAt.
async function mcpSubscription(connectionId: string | null, callbackUrl: string, updatedAt = now): Promise<SubscriptionRow> {
  const row = await createSubscription({ user: alice, callbackUrl });
  await env.DB.prepare("UPDATE subscriptions SET connection_id = ?, updated_at = ? WHERE id = ?")
    .bind(connectionId, updatedAt, row.id)
    .run();
  return { ...row, connectionId, updatedAt };
}

async function botRow(id: string): Promise<BotRow> {
  const raw = await env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!raw) throw new Error("bot not found");
  return {
    id: raw.id as string,
    workspaceId: raw.workspace_id as string,
    createdByUserId: raw.created_by_user_id as string,
    name: raw.name as string,
    deliveryKind: raw.delivery_kind as BotRow["deliveryKind"],
    deliverySubscriptionId: raw.delivery_subscription_id as string | null,
    canStartConversations: raw.can_start_conversations as number,
    startDailyLimit: raw.start_daily_limit as number,
    startMaxAiMessages: raw.start_max_ai_messages as number,
    createdAt: raw.created_at as number,
    updatedAt: raw.updated_at as number,
    deletedAt: raw.deleted_at as number | null,
  };
}

describe("POST /api/v1/bots", () => {
  it("creates bots of each delivery kind", async () => {
    const dot = await created({ name: "  Dot  ", delivery_kind: "mcp" });
    expect(dot).toEqual({
      id: expect.stringMatching(/^bot_[0-9A-HJKMNP-TV-Z]{26}$/),
      name: "Dot",
      delivery_kind: "mcp",
      delivery: null,
      connection: null,
      status: "no_connection",
      sources: [],
      conversation_start: { enabled: false, daily_limit: 10, max_ai_messages: 10 },
      created_at: now,
      updated_at: now,
    });
    const grok = await created({ name: "Grok Bot", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    expect(grok.delivery).toEqual({ subscription_id: hook.id, name: "grok", callback_host: "hooks.example.com", status: "active" });
    const muse = await created({ name: "Muse", delivery_kind: "queue", delivery_subscription_id: queue.id });
    expect(muse.delivery).toMatchObject({ subscription_id: queue.id, name: "muse", callback_host: null });
    expect((await list()).map((bot) => bot.name)).toEqual(["Dot", "Grok Bot", "Muse"]);
    expect(await list(bobCookies)).toEqual([]);
  });

  it.each([
    ["an unknown field", { name: "x", delivery_kind: "mcp", extra: 1 }, "unknown_field"],
    ["an empty name", { name: " ", delivery_kind: "mcp" }, "invalid_request"],
    ["a name over 64 characters", { name: "a".repeat(65), delivery_kind: "mcp" }, "invalid_request"],
    ["an unknown delivery kind", { name: "x", delivery_kind: "email" }, "invalid_request"],
    ["a destination for mcp", { name: "x", delivery_kind: "mcp", delivery_subscription_id: "sub_" + "0".repeat(32) }, "invalid_delivery"],
    ["no destination for webhook", { name: "x", delivery_kind: "webhook" }, "invalid_delivery"],
    ["a malformed destination", { name: "x", delivery_kind: "queue", delivery_subscription_id: "sub_x" }, "invalid_delivery"],
  ])("rejects %s", async (_, body, code) => {
    await expectApiError(await create(body), 400, code);
    expect(await countTable("bots")).toBe(0);
  });

  it("rejects a destination of another kind, ended, missing or of another user", async () => {
    const ended = await createQueue({ user: alice, name: "old", unsubscribedAt: now - 1 });
    const bobs = await createQueue({ user: bob, name: "bob" });
    const cases = [
      { delivery_kind: "webhook", delivery_subscription_id: queue.id },
      { delivery_kind: "queue", delivery_subscription_id: hook.id },
      { delivery_kind: "queue", delivery_subscription_id: ended.id },
      { delivery_kind: "queue", delivery_subscription_id: bobs.id },
      { delivery_kind: "queue", delivery_subscription_id: "sub_" + "a".repeat(32) },
    ];
    for (const body of cases) await expectApiError(await create({ name: "x", ...body }), 400, "invalid_delivery");
    expect(await countTable("bots")).toBe(0);
  });

  it("rejects a name or a destination taken by another bot, and allows them again after a delete", async () => {
    const grok = await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    await expectApiError(await create({ name: "Grok", delivery_kind: "mcp" }), 409, "name_conflict");
    await expectApiError(
      await create({ name: "Grok 2", delivery_kind: "webhook", delivery_subscription_id: hook.id }),
      409,
      "delivery_in_use",
    );
    expect((await remove(grok.id)).status).toBe(204);
    // The name is free again; the destination ended with the bot.
    await expectApiError(
      await create({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id }),
      400,
      "invalid_delivery",
    );
    const other = await createSubscription({ user: alice, kind: "webhook", name: "other", expiresAt: NO_EXPIRY });
    await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: other.id });
    // Another user may use the same name.
    await created({ name: "Grok", delivery_kind: "mcp" }, bobCookies);
  });

  it("allows 100 bots", async () => {
    const workspaceId = (await personalWorkspaceOf(alice)).id;
    await env.DB.batch(
      Array.from({ length: MAX_BOTS_PER_WORKSPACE - 1 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO bots (id, workspace_id, created_by_user_id, name, delivery_kind, delivery_subscription_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'mcp', NULL, ?, ?)`,
        ).bind(newBotId(now), workspaceId, alice.id, `bot ${i}`, now, now),
      ),
    );
    await created({ name: "the last", delivery_kind: "mcp" });
    const res = await create({ name: "one more", delivery_kind: "mcp" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({
      code: "limit_exceeded",
      message: "Bot は 100 個までです",
    });
  });

  it("requires a login", async () => {
    expect((await send("/api/v1/bots", { json: { name: "x", delivery_kind: "mcp" } })).status).toBe(401);
  });
});

describe("POST /api/v1/bots/:id/update", () => {
  it("renames a bot and changes its delivery kind", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    now += 1000;
    const renamed = await update(bot.id, { name: "Grok Bot" });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()) as Bot).toMatchObject({ name: "Grok Bot", delivery_kind: "webhook", updated_at: now });
    const toQueue = await update(bot.id, { delivery_kind: "queue", delivery_subscription_id: queue.id });
    expect(((await toQueue.json()) as Bot).delivery?.subscription_id).toBe(queue.id);
    const toMcp = await update(bot.id, { delivery_kind: "mcp", delivery_subscription_id: null });
    expect((await toMcp.json()) as Bot).toMatchObject({ delivery_kind: "mcp", delivery: null });
  });

  it("checks a destination given alone against the current delivery kind", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    await expectApiError(await update(bot.id, { delivery_subscription_id: queue.id }), 400, "invalid_delivery");
    const other = await createSubscription({ user: alice, kind: "webhook", name: "other", expiresAt: NO_EXPIRY });
    expect((await update(bot.id, { delivery_subscription_id: other.id })).status).toBe(200);
  });

  it("rejects a change of the delivery kind without a destination, unknown fields and an empty body", async () => {
    const bot = await created({ name: "Dot", delivery_kind: "mcp" });
    await expectApiError(await update(bot.id, { delivery_kind: "webhook" }), 400, "invalid_request");
    await expectApiError(await update(bot.id, { extra: 1 }), 400, "unknown_field");
    await expectApiError(await update(bot.id, {}), 400, "invalid_request");
    await expectApiError(await update(bot.id, { delivery_subscription_id: queue.id }), 400, "invalid_delivery");
  });

  it("answers a name taken by another bot with 409", async () => {
    await created({ name: "Dot", delivery_kind: "mcp" });
    const other = await created({ name: "Dot2", delivery_kind: "mcp" });
    await expectApiError(await update(other.id, { name: "Dot" }), 409, "name_conflict");
  });

  it("answers a bot that is deleted, missing or of another user with 404, and leaves it as it is", async () => {
    const theirs = await created({ name: "Bob's", delivery_kind: "mcp" }, bobCookies);
    await expectApiError(await update(theirs.id, { name: "mine" }), 404, "not_found");
    expect((await botRow(theirs.id)).name).toBe("Bob's");
    const deleted = await created({ name: "old", delivery_kind: "mcp" });
    await remove(deleted.id);
    await expectApiError(await update(deleted.id, { name: "again" }), 404, "not_found");
    await expectApiError(await update("bot_x", { name: "x" }), 404, "not_found");
  });
});

describe("POST /api/v1/bots/:id/delete", () => {
  it("deletes a bot and ends its destination, and keeps its connection, not assigned", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    const connection = await connect(alice, bot.id);
    expect((await remove(bot.id)).status).toBe(204);
    expect((await botRow(bot.id)).deletedAt).toBe(now);
    const row = await env.DB.prepare("SELECT bot_id, revoked_at FROM mcp_connections WHERE id = ?")
      .bind(connection)
      .first<{ bot_id: string | null; revoked_at: number | null }>();
    expect(row).toEqual({ bot_id: null, revoked_at: null });
    const destination = await env.DB.prepare("SELECT unsubscribed_at FROM subscriptions WHERE id = ?")
      .bind(hook.id)
      .first<{ unsubscribed_at: number | null }>();
    expect(destination?.unsubscribed_at).toBe(now);
    expect(await list()).toEqual([]);
    // Again: nothing changes.
    now += 1000;
    expect((await remove(bot.id)).status).toBe(204);
    expect((await botRow(bot.id)).deletedAt).toBe(now - 1000);
  });

  it("answers a bot that is missing or of another user with 404", async () => {
    const theirs = await created({ name: "Bob's", delivery_kind: "mcp" }, bobCookies);
    await expectApiError(await remove(theirs.id), 404, "not_found");
    expect((await botRow(theirs.id)).deletedAt).toBeNull();
    await expectApiError(await remove("bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V"), 404, "not_found");
  });
});

describe("the state and the destination of a bot", () => {
  it("is ready with a connection and a destination", async () => {
    const grok = await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    const dot = await created({ name: "Dot", delivery_kind: "mcp" });
    await connect(alice, grok.id, "Grok");
    const dotConnection = await connect(alice, dot.id);
    const bots = await list();
    expect(bots.find((b) => b.id === grok.id)).toMatchObject({
      status: "ready",
      connection: { client_name: "Grok", redirect_host: "chatgpt.com", created_at: now },
    });
    // An mcp bot has no destination until its connection subscribes.
    expect(bots.find((b) => b.id === dot.id)?.status).toBe("no_delivery");
    await mcpSubscription(dotConnection, "https://connectors.example.com/a");
    expect((await list()).find((b) => b.id === dot.id)).toMatchObject({
      status: "ready",
      delivery: { callback_host: "connectors.example.com", status: "active" },
    });
  });

  it("resolves the destination of each kind of bot", async () => {
    const dot = await created({ name: "Dot", delivery_kind: "mcp" });
    const grok = await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    const muse = await created({ name: "Muse", delivery_kind: "queue", delivery_subscription_id: queue.id });
    const lonely = await created({ name: "Lonely", delivery_kind: "mcp" });
    const connection = await connect(alice, dot.id);
    const older = await mcpSubscription(connection, "https://connectors.example.com/old", now - 60_000);
    const newer = await mcpSubscription(connection, "https://connectors.example.com/new", now);
    // A subscription of another connection, newer still, is not the bot's.
    await mcpSubscription(await connect(alice, null), "https://connectors.example.com/other", now + 1);
    const workspaceId = (await personalWorkspaceOf(alice)).id;
    const rows = await Promise.all([dot, grok, muse, lonely].map((bot) => botRow(bot.id)));

    const resolved = await resolveBotDeliveries(db, workspaceId, rows, now);
    expect(resolved.get(dot.id)?.id).toBe(newer.id);
    expect(resolved.get(grok.id)?.id).toBe(hook.id);
    expect(resolved.get(muse.id)?.id).toBe(queue.id);
    expect(resolved.get(lonely.id)).toBeNull();

    // The newest ends: the older one is used. Ended destinations and deleted bots have none.
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id IN (?, ?)").bind(now, newer.id, queue.id).run();
    await env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, grok.id).run();
    const again = await resolveBotDeliveries(db, workspaceId, await Promise.all(rows.map((r) => botRow(r.id))), now);
    expect(again.get(dot.id)?.id).toBe(older.id);
    expect(again.get(grok.id)).toBeNull();
    expect(again.get(muse.id)).toBeNull();

    // Without an active connection there is no destination.
    await env.DB.prepare("UPDATE mcp_connections SET revoked_at = ?, revoke_reason = 'user' WHERE id = ?").bind(now, connection).run();
    expect((await resolveBotDeliveries(db, workspaceId, [await botRow(dot.id)], now)).get(dot.id)).toBeNull();
  });

  it("gives a shared callback to the bot whose connection subscribed last", async () => {
    const dot = await created({ name: "Dot", delivery_kind: "mcp" });
    const dot2 = await created({ name: "Dot2", delivery_kind: "mcp" });
    const first = await connect(alice, dot.id);
    const second = await connect(alice, dot2.id);
    // One row for both: the ID of a subscription does not include the connection. The last subscribe owns it.
    const shared = await mcpSubscription(first, "https://connectors.example.com/shared");
    await env.DB.prepare("UPDATE subscriptions SET connection_id = ? WHERE id = ?").bind(second, shared.id).run();
    const bots = await list();
    expect(bots.find((b) => b.id === dot2.id)?.status).toBe("ready");
    expect(bots.find((b) => b.id === dot.id)?.status).toBe("no_delivery");
  });
});

describe("the sources of a bot", () => {
  let app: SourceRow;
  let worker: SourceRow;
  let disabled: SourceRow;

  beforeEach(async () => {
    const workspaceId = (await personalWorkspaceOf(alice)).id;
    worker = await createSource({ workspaceId, name: "worker" });
    app = await createSource({ workspaceId, name: "app" });
    disabled = await createSource({ workspaceId, name: "batch", enabled: false });
  });

  async function linkedSourceIds(botId: string): Promise<string[]> {
    const { results } = await env.DB.prepare("SELECT source_id FROM bot_sources WHERE bot_id = ? ORDER BY source_id")
      .bind(botId)
      .all<{ source_id: string }>();
    return results.map((row) => row.source_id);
  }

  it("links the given sources on create, by name in the response, disabled ones included", async () => {
    const bot = await created({
      name: "Dot",
      delivery_kind: "mcp",
      source_ids: [worker.id, app.id, disabled.id, worker.id],
    });
    expect(bot.sources).toEqual([
      { id: app.id, name: "app", enabled: true },
      { id: disabled.id, name: "batch", enabled: false },
      { id: worker.id, name: "worker", enabled: true },
    ]);
    expect(await linkedSourceIds(bot.id)).toEqual([app.id, disabled.id, worker.id].sort());
    expect((await list())[0]?.sources.map((source) => source.name)).toEqual(["app", "batch", "worker"]);
  });

  it("replaces the sources on update, and keeps them when source_ids is left out", async () => {
    const bot = await created({ name: "Dot", delivery_kind: "mcp", source_ids: [app.id, worker.id] });
    const renamed = await update(bot.id, { name: "Dot 2" });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as Bot).sources.map((source) => source.id)).toEqual([app.id, worker.id]);

    const replaced = await update(bot.id, { source_ids: [disabled.id] });
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as Bot).sources).toEqual([{ id: disabled.id, name: "batch", enabled: false }]);
    expect(await linkedSourceIds(bot.id)).toEqual([disabled.id]);

    const cleared = await update(bot.id, { source_ids: [] });
    expect(((await cleared.json()) as Bot).sources).toEqual([]);
    expect(await linkedSourceIds(bot.id)).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["not an array", "src_x"],
    ["null", null],
    ["an item that is not a string", [1]],
  ])("rejects source_ids that is %s with invalid_request", async (_, sourceIds) => {
    await expectApiError(await create({ name: "x", delivery_kind: "mcp", source_ids: sourceIds }), 400, "invalid_request");
    const bot = await created({ name: "Dot", delivery_kind: "mcp", source_ids: [app.id] });
    await expectApiError(await update(bot.id, { source_ids: sourceIds }), 400, "invalid_request");
    expect(await linkedSourceIds(bot.id)).toEqual([app.id]);
  });

  it("allows up to 100 sources after removing duplicates", async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `src_${String(i).padStart(26, "0")}`);
    await expectApiError(await create({ name: "x", delivery_kind: "mcp", source_ids: tooMany }), 400, "invalid_request");
    const bot = await created({ name: "Dot", delivery_kind: "mcp", source_ids: Array.from({ length: 101 }, () => app.id) });
    expect(bot.sources.map((source) => source.id)).toEqual([app.id]);
  });

  it("rejects sources that are malformed, of another workspace or the conversation source with invalid_source", async () => {
    const bobs = await createSource({ workspaceId: (await personalWorkspaceOf(bob)).id, name: "app" });
    const conversationId = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
    await env.DB.prepare(
      `INSERT INTO sources (id, workspace_id, name, enabled, kind, created_at, updated_at)
      VALUES (?, ?, 'conversations', 1, 'conversation', ?, ?)`,
    )
      .bind(conversationId, (await personalWorkspaceOf(alice)).id, now, now)
      .run();
    const bot = await created({ name: "Dot", delivery_kind: "mcp", source_ids: [app.id] });
    for (const id of ["src_x", bobs.id, conversationId, "src_" + "0".repeat(26)]) {
      await expectApiError(await create({ name: "x", delivery_kind: "mcp", source_ids: [app.id, id] }), 400, "invalid_source");
      await expectApiError(await update(bot.id, { name: "renamed", source_ids: [id] }), 400, "invalid_source");
    }
    expect(await countTable("bots")).toBe(1);
    expect((await botRow(bot.id)).name).toBe("Dot");
    expect(await linkedSourceIds(bot.id)).toEqual([app.id]);
  });

  it("answers an invalid destination before an invalid source", async () => {
    await expectApiError(
      await create({ name: "x", delivery_kind: "queue", delivery_subscription_id: "sub_" + "a".repeat(32), source_ids: ["src_x"] }),
      400,
      "invalid_delivery",
    );
    await expectApiError(
      await create({ name: "x", delivery_kind: "mcp", source_ids: "src_x", delivery_subscription_id: "sub_x" }),
      400,
      "invalid_request",
    );
  });

  it("deletes the links with the bot", async () => {
    const bot = await created({ name: "Dot", delivery_kind: "mcp", source_ids: [app.id, worker.id] });
    const other = await created({ name: "Grok", delivery_kind: "webhook", delivery_subscription_id: hook.id, source_ids: [app.id] });
    expect((await remove(bot.id)).status).toBe(204);
    expect(await linkedSourceIds(bot.id)).toEqual([]);
    expect(await linkedSourceIds(other.id)).toEqual([app.id]);
  });
});

describe("deleting the user", () => {
  it("deletes the bots and the MCP connections", async () => {
    const bot = await created({ name: "Dot", delivery_kind: "webhook", delivery_subscription_id: hook.id });
    await connect(alice, bot.id);
    await created({ name: "Bob's", delivery_kind: "mcp" }, bobCookies);
    await connect(bob, null);
    const admin = await createUser({ email: "admin@example.com", role: "admin" });
    const res = await send(`/api/v1/users/${alice.id}`, { method: "DELETE", cookies: await login(admin.email) });
    expect(res.status).toBe(204);
    expect(await countTable("bots")).toBe(1);
    expect(await countTable("mcp_connections")).toBe(1);
  });
});
