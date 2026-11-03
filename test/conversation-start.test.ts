import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotList, ConversationDetail, ConversationList } from "../src/api/types";
import { clock } from "../src/clock";
import type { SubscriptionRow, UserRow } from "../src/db/schema";
import { newBotId, newMcpConnectionId } from "../src/ids";
import { mcpHandler } from "../src/mcp/handler";
import {
  createQueue,
  createSubscription,
  createUser,
  fakeQueue,
  insertOpenConversations,
  listDeliveries,
  login,
  ORIGIN,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
  type FakeQueue,
  type SessionCookies,
} from "./helpers";

const MCP_ACCEPT = "application/json, text/event-stream";
const DOT = "client-dot";
const GROK = "client-grok";
const MUSE = "client-muse";
const NONE = "client-none";
const DAY_MS = 86_400_000;

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
type ListBotsResult = {
  bots: { name: string; is_you: boolean }[];
  you: {
    bot_name: string | null;
    can_start_conversations: boolean;
    daily_limit: number | null;
    started_last_24h: number | null;
    max_ai_messages: number | null;
  };
};
type StartResult = {
  conversation_id: string;
  title: string;
  status: string;
  max_ai_messages: number;
  ai_message_count: number;
  remaining_ai_messages: number;
  participants: { name: string; is_you: boolean; notified: boolean | null }[];
  event_id: string;
  duplicate: boolean;
};

let alice: UserRow;
let bob: UserRow;
let aliceCookies: SessionCookies;
let bobCookies: SessionCookies;
let dotHook: SubscriptionRow;
let grokQueue: SubscriptionRow;
let museMcp: SubscriptionRow;
let dotBotId: string;
let grokBotId: string;
let museBotId: string;
let connections: Record<string, string>;
let queue: FakeQueue;
let now: number;

// Inserts a bot of the user directly.
async function createBot(user: UserRow, name: string, kind: "mcp" | "webhook" | "queue", subscriptionId: string | null) {
  const id = newBotId(now);
  await env.DB.prepare(
    `INSERT INTO bots (id, workspace_id, created_by_user_id, name, delivery_kind, delivery_subscription_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, (await personalWorkspaceOf(user)).id, user.id, name, kind, subscriptionId, now, now)
    .run();
  return id;
}

// Inserts an active MCP connection of alice directly, and makes it the connection of clientId in rpc().
async function connect(clientId: string, clientName: string, botId: string | null): Promise<void> {
  const id = newMcpConnectionId(now);
  await env.DB.prepare(
    `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name, redirect_uri, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, 'https://client.example/cb', ?, ?)`,
  )
    .bind(id, alice.id, (await personalWorkspaceOf(alice)).id, botId, clientId, clientName, now, now)
    .run();
  connections[clientId] = id;
}

async function rpc(clientId: string, method: string, params: unknown): Promise<unknown> {
  const connectionId = connections[clientId];
  const ctx = Object.assign(createExecutionContext(), {
    props: { userId: alice.id, authMode: "password", ...(connectionId === undefined ? {} : { connectionId }) },
    auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"], clientId },
  }) as unknown as OAuthResourceContext<unknown>;
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await mcpHandler.fetch(request, { ...env, DELIVERY_QUEUE: queue }, ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

function callTool(clientId: string, name: string, args: Record<string, unknown>) {
  return rpc(clientId, "tools/call", { name, arguments: args }) as Promise<ToolResult>;
}

function parse<T>(result: ToolResult): T {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

function toolError(result: ToolResult): { code: string; message: string } {
  expect(result.isError).toBe(true);
  return (JSON.parse(result.content[0]?.text ?? "") as { error: { code: string; message: string } }).error;
}

function startArgs(overrides: Record<string, unknown> = {}) {
  return { title: "レビューの依頼", participants: ["Grok"], message: "このアラートを見てください", ...overrides };
}

function start(overrides: Record<string, unknown> = {}, clientId = DOT) {
  return callTool(clientId, "start_conversation", startArgs(overrides));
}

async function started(overrides: Record<string, unknown> = {}): Promise<StartResult> {
  return parse<StartResult>(await start(overrides));
}

async function listBots(clientId = DOT): Promise<ListBotsResult> {
  return parse<ListBotsResult>(await callTool(clientId, "list_bots", {}));
}

function setConversationStart(botId: string, body: unknown, cookies = aliceCookies) {
  return send(`/api/v1/bots/${botId}/conversation-start`, { json: body, cookies });
}

async function allow(botId: string, dailyLimit = 10, maxAiMessages = 10): Promise<void> {
  const res = await setConversationStart(botId, { enabled: true, daily_limit: dailyLimit, max_ai_messages: maxAiMessages });
  expect(res.status).toBe(200);
}

async function expectApiError(res: Response, status: number, code: string): Promise<string> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  return body.error.message;
}

async function conversationRow(id: string) {
  return env.DB.prepare(
    "SELECT status, stop_reason, ai_message_count, max_ai_messages, started_by_bot_id, created_by_user_id, stopped_at FROM conversations WHERE id = ?",
  )
    .bind(id)
    .first<{
      status: string;
      stop_reason: string | null;
      ai_message_count: number;
      max_ai_messages: number;
      started_by_bot_id: string | null;
      created_by_user_id: string;
      stopped_at: number | null;
    }>();
}

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  queue = fakeQueue();
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  aliceCookies = await login(alice.email);
  bobCookies = await login(bob.email);
  dotHook = await createSubscription({ user: alice, kind: "webhook", name: "dot", expiresAt: 253402300799999 });
  grokQueue = await createQueue({ user: alice, name: "grok" });
  museMcp = await createSubscription({ user: alice, callbackUrl: "https://muse.example.com/hook" });
  connections = {};
  dotBotId = await createBot(alice, "dot", "webhook", dotHook.id);
  grokBotId = await createBot(alice, "Grok", "queue", grokQueue.id);
  museBotId = await createBot(alice, "Muse", "mcp", null);
  await connect(DOT, "dot", dotBotId);
  await connect(GROK, "Grok Bot", grokBotId);
  await connect(MUSE, "Muse", museBotId);
  await connect(NONE, "None", null);
  await env.DB.prepare("UPDATE subscriptions SET connection_id = ? WHERE id = ?").bind(connections[MUSE], museMcp.id).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

describe("POST /api/v1/bots/:id/conversation-start", () => {
  it("saves the settings and returns the bot", async () => {
    now += 1000;
    const res = await setConversationStart(dotBotId, { enabled: true, daily_limit: 1000, max_ai_messages: 100 });
    expect(res.status).toBe(200);
    const bot = (await res.json()) as Bot;
    expect(bot).toMatchObject({
      id: dotBotId,
      name: "dot",
      conversation_start: { enabled: true, daily_limit: 1000, max_ai_messages: 100 },
      updated_at: now,
    });
    const detail = (await (await send(`/api/v1/bots/${dotBotId}`, { cookies: aliceCookies })).json()) as Bot;
    expect(detail.conversation_start).toEqual({ enabled: true, daily_limit: 1000, max_ai_messages: 100 });

    const off = await setConversationStart(dotBotId, { enabled: false, daily_limit: 1, max_ai_messages: 1 });
    expect(((await off.json()) as Bot).conversation_start).toEqual({ enabled: false, daily_limit: 1, max_ai_messages: 1 });
  });

  it("lists the settings of every bot, with the defaults for the others", async () => {
    await allow(grokBotId, 3, 4);
    const list = (await (await send("/api/v1/bots", { cookies: aliceCookies })).json()) as BotList;
    expect(list.bots.map((bot) => [bot.name, bot.conversation_start])).toEqual([
      ["Grok", { enabled: true, daily_limit: 3, max_ai_messages: 4 }],
      ["Muse", { enabled: false, daily_limit: 10, max_ai_messages: 10 }],
      ["dot", { enabled: false, daily_limit: 10, max_ai_messages: 10 }],
    ]);
  });

  it("gives a new bot the defaults", async () => {
    const res = await send("/api/v1/bots", { json: { name: "New", delivery_kind: "mcp" }, cookies: aliceCookies });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Bot).conversation_start).toEqual({ enabled: false, daily_limit: 10, max_ai_messages: 10 });
  });

  it.each([
    [{ enabled: true, daily_limit: 10, max_ai_messages: 10, extra: 1 }, "unknown_field"],
    [{ daily_limit: 10, max_ai_messages: 10 }, "invalid_request"],
    [{ enabled: "true", daily_limit: 10, max_ai_messages: 10 }, "invalid_request"],
    [{ enabled: true, max_ai_messages: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 0, max_ai_messages: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 1001, max_ai_messages: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 1.5, max_ai_messages: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: "10", max_ai_messages: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 10, max_ai_messages: 0 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 10, max_ai_messages: 101 }, "invalid_limit"],
  ])("rejects %j with %s", async (body, code) => {
    await expectApiError(await setConversationStart(dotBotId, body), 400, code);
    const row = await env.DB.prepare("SELECT can_start_conversations FROM bots WHERE id = ?")
      .bind(dotBotId)
      .first<{ can_start_conversations: number }>();
    expect(row?.can_start_conversations).toBe(0);
  });

  it("names the limit in the message", async () => {
    expect(
      await expectApiError(await setConversationStart(dotBotId, { enabled: true, daily_limit: 0, max_ai_messages: 10 }), 400, "invalid_limit"),
    ).toBe("1日に始められる会話の数は 1〜1000 の整数にしてください");
    expect(
      await expectApiError(await setConversationStart(dotBotId, { enabled: true, daily_limit: 1, max_ai_messages: 0 }), 400, "invalid_limit"),
    ).toBe("AI の発言の上限は 1〜100 の整数にしてください");
  });

  it("answers a deleted bot, another user's bot and a missing bot as not found", async () => {
    const body = { enabled: true, daily_limit: 10, max_ai_messages: 10 };
    await expectApiError(await setConversationStart(dotBotId, body, bobCookies), 404, "not_found");
    await env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, museBotId).run();
    await expectApiError(await setConversationStart(museBotId, body), 404, "not_found");
    await expectApiError(await setConversationStart("bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V", body), 404, "not_found");
    await expectApiError(await setConversationStart("nope", body), 404, "not_found");
    const row = await env.DB.prepare("SELECT can_start_conversations FROM bots WHERE id = ?")
      .bind(dotBotId)
      .first<{ can_start_conversations: number }>();
    expect(row?.can_start_conversations).toBe(0);
  });
});

describe("list_bots", () => {
  it("lists the bots and the settings of the caller", async () => {
    await allow(dotBotId, 5, 7);
    expect(await listBots()).toEqual({
      bots: [
        { name: "Grok", is_you: false },
        { name: "Muse", is_you: false },
        { name: "dot", is_you: true },
      ],
      you: { bot_name: "dot", can_start_conversations: true, daily_limit: 5, started_last_24h: 0, max_ai_messages: 7 },
    });
    await started();
    await started({ participants: ["Muse"] });
    expect((await listBots()).you.started_last_24h).toBe(2);
    // Another bot has started none.
    expect((await listBots(GROK)).you).toEqual({
      bot_name: "Grok",
      can_start_conversations: false,
      daily_limit: 10,
      started_last_24h: 0,
      max_ai_messages: 10,
    });
    now += DAY_MS;
    expect((await listBots()).you.started_last_24h).toBe(0);
  });

  it("has no settings for a connection without a bot", async () => {
    expect(await listBots(NONE)).toEqual({
      bots: [
        { name: "Grok", is_you: false },
        { name: "Muse", is_you: false },
        { name: "dot", is_you: false },
      ],
      you: { bot_name: null, can_start_conversations: false, daily_limit: null, started_last_24h: null, max_ai_messages: null },
    });
  });

  it("leaves out deleted bots and the bots of other users", async () => {
    await createBot(bob, "Bob's bot", "mcp", null);
    await env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, museBotId).run();
    expect((await listBots()).bots.map((bot) => bot.name)).toEqual(["Grok", "dot"]);
  });
});

describe("start_conversation", () => {
  beforeEach(async () => {
    await allow(dotBotId);
  });

  it("starts a conversation with the caller first and delivers the first message to the invited bots only", async () => {
    const result = await started({ participants: ["Grok", " Muse "], max_ai_messages: 5 });
    expect(result).toEqual({
      conversation_id: expect.stringMatching(/^cnv_/),
      title: "レビューの依頼",
      status: "open",
      max_ai_messages: 5,
      ai_message_count: 1,
      remaining_ai_messages: 4,
      participants: [
        { name: "dot", is_you: true, notified: false },
        { name: "Grok", is_you: false, notified: true },
        { name: "Muse", is_you: false, notified: true },
      ],
      event_id: expect.stringMatching(/^evt_/),
      duplicate: false,
    });
    expect(await conversationRow(result.conversation_id)).toMatchObject({
      status: "open",
      ai_message_count: 1,
      max_ai_messages: 5,
      started_by_bot_id: dotBotId,
      created_by_user_id: alice.id,
    });
    const deliveries = await listDeliveries("event_id = ?", result.event_id);
    expect(deliveries.map((d) => d.subscription_id).sort()).toEqual([grokQueue.id, museMcp.id].sort());
    expect(deliveries.some((d) => d.subscription_id === dotHook.id)).toBe(false);

    // The first message is the caller's, as an AI message.
    const event = await env.DB.prepare("SELECT labels FROM events WHERE id = ?").bind(result.event_id).first<{ labels: string }>();
    const labels = JSON.parse(event?.labels ?? "{}") as Record<string, string>;
    expect(labels).toMatchObject({ conversation_id: result.conversation_id, sender: "dot", sender_kind: "ai" });
    const sender = await env.DB.prepare("SELECT bot_id FROM conversation_participants WHERE id = ?")
      .bind(labels.sender_id)
      .first<{ bot_id: string }>();
    expect(sender?.bot_id).toBe(dotBotId);
  });

  it("shows who started it on the management screen", async () => {
    const result = await started();
    const list = (await (await send("/api/v1/conversations", { cookies: aliceCookies })).json()) as ConversationList;
    expect(list.conversations[0]?.started_by).toEqual({ kind: "bot", bot_id: dotBotId, name: "dot" });
    const detail = (await (
      await send(`/api/v1/conversations/${result.conversation_id}`, { cookies: aliceCookies })
    ).json()) as ConversationDetail;
    expect(detail.started_by).toEqual({ kind: "bot", bot_id: dotBotId, name: "dot" });
    // The name of the participant, not the current name of the bot.
    await env.DB.prepare("UPDATE bots SET name = 'dot2' WHERE id = ?").bind(dotBotId).run();
    const renamed = (await (await send("/api/v1/conversations", { cookies: aliceCookies })).json()) as ConversationList;
    expect(renamed.conversations[0]?.started_by).toEqual({ kind: "bot", bot_id: dotBotId, name: "dot" });
  });

  it("lets an invited bot answer, delivered to the caller", async () => {
    const result = await started();
    const reply = await callTool(GROK, "post_message", { conversation_id: result.conversation_id, text: "見ました" });
    const posted = parse<{ event_id: string; conversation_status: string; remaining_ai_messages: number }>(reply);
    expect(posted).toMatchObject({ conversation_status: "open", remaining_ai_messages: 8 });
    const deliveries = await listDeliveries("event_id = ?", posted.event_id);
    expect(deliveries.map((d) => d.subscription_id)).toEqual([dotHook.id]);
  });

  it("uses the limit of the bot by default and rejects a larger one", async () => {
    await allow(dotBotId, 10, 6);
    const result = await started();
    expect(result).toMatchObject({ max_ai_messages: 6, remaining_ai_messages: 5 });
    const over = toolError(await start({ max_ai_messages: 7 }));
    expect(over.code).toBe("invalid_limit");
    expect(over.message).toContain("6");
    expect(toolError(await start({ max_ai_messages: 0 })).code).toBe("invalid_limit");
  });

  it("stops a conversation with a limit of 1 as it starts, and still delivers the first message", async () => {
    const result = await started({ max_ai_messages: 1 });
    expect(result).toMatchObject({ status: "stopped", ai_message_count: 1, remaining_ai_messages: 0 });
    expect(await conversationRow(result.conversation_id)).toMatchObject({
      status: "stopped",
      stop_reason: "limit",
      stopped_at: now,
    });
    expect((await listDeliveries("event_id = ?", result.event_id)).map((d) => d.subscription_id)).toEqual([grokQueue.id]);
    expect(toolError(await callTool(GROK, "post_message", { conversation_id: result.conversation_id, text: "x" })).code).toBe(
      "conversation_stopped",
    );
  });

  it("reports an invited bot without a destination as not notified", async () => {
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?").bind(now - 1, museMcp.id).run();
    const result = await started({ participants: ["Muse"] });
    expect(result.participants).toEqual([
      { name: "dot", is_you: true, notified: false },
      { name: "Muse", is_you: false, notified: false },
    ]);
    expect(await listDeliveries("event_id = ?", result.event_id)).toEqual([]);
  });

  it("is not allowed for a bot that is not allowed", async () => {
    const error = toolError(await start({ participants: ["dot"] }, GROK));
    expect(error).toEqual({
      code: "start_not_allowed",
      message:
        "Bot「Grok」は会話を始めることを許可されていません。Pinglune の Bot の画面で「会話の開始」を許可してもらってください",
    });
    await allow(dotBotId);
    await setConversationStart(dotBotId, { enabled: false, daily_limit: 10, max_ai_messages: 10 });
    expect(toolError(await start()).code).toBe("start_not_allowed");
  });

  it("is unassigned for a connection without a bot", async () => {
    const error = toolError(await start({}, NONE));
    expect(error.code).toBe("unassigned");
    expect(error.message).toContain("Bot に割り当てられていません");
  });

  it.each([
    [["dot"], "yourself"],
    [["Grok", "Grok"], "a name twice"],
    [["Grok", " Grok "], "a name twice after trimming"],
    [["Nobody"], "a missing name"],
    [[], "no name"],
    [[""], "an empty name"],
    [["Grok", "Muse", "a", "b", "c"], "five names"],
  ])("rejects %j (%s)", async (participants) => {
    expect(toolError(await start({ participants })).code).toBe("invalid_participants");
  });

  it("names the missing bots", async () => {
    const error = toolError(await start({ participants: ["Grok", "Nobody"] }));
    expect(error.code).toBe("invalid_participants");
    expect(error.message).toContain("Nobody");
    expect(error.message).toContain("list_bots");
  });

  it("does not find a deleted bot or the bot of another user", async () => {
    await env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, museBotId).run();
    expect(toolError(await start({ participants: ["Muse"] })).code).toBe("invalid_participants");
    await createBot(bob, "Bob's bot", "mcp", null);
    expect(toolError(await start({ participants: ["Bob's bot"] })).code).toBe("invalid_participants");
  });

  it.each([
    [{ title: "" }, "invalid_title"],
    [{ title: "a".repeat(65) }, "invalid_title"],
    [{ message: "   " }, "invalid_text"],
  ])("rejects %j with %s", async (overrides, code) => {
    expect(toolError(await start(overrides)).code).toBe(code);
  });

  it("limits the conversations of the last 24 hours", async () => {
    await allow(dotBotId, 2, 10);
    await started();
    now += 1000;
    await started();
    const error = toolError(await start());
    expect(error).toEqual({ code: "rate_limited", message: "Bot「dot」が 24 時間に始められる会話は 2 件までです" });
    // A stopped conversation is still counted.
    await env.DB.prepare("UPDATE conversations SET status = 'stopped', stop_reason = 'user'").run();
    expect(toolError(await start()).code).toBe("rate_limited");
    // The first one is 24 hours old: not counted anymore.
    now += DAY_MS - 1000;
    await started();
    expect(toolError(await start()).code).toBe("rate_limited");
  });

  it("returns the same conversation for a retry with the same key, even at the limit", async () => {
    await allow(dotBotId, 1, 10);
    const first = await started({ idempotency_key: "review-1" });
    const retried = await started({ idempotency_key: "review-1", message: "別の内容", participants: ["Muse"] });
    expect(retried).toEqual({
      ...first,
      participants: first.participants.map((p) => ({ ...p, notified: null })),
      duplicate: true,
    });
    expect(toolError(await start({ idempotency_key: "review-2" })).code).toBe("rate_limited");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("starts a conversation after many open conversations of the screen and of AIs", async () => {
    await insertOpenConversations(alice, 25, null, now);
    // Started by another bot: those of the calling bot would count in its daily limit.
    await insertOpenConversations(alice, 25, grokBotId, now);
    const result = await started();
    expect(result.status).toBe("open");
  });
});

describe("POST /api/v1/conversations", () => {
  it("is started by the user after many open conversations of the screen and of AIs", async () => {
    await insertOpenConversations(alice, 25, null, now);
    await insertOpenConversations(alice, 25, dotBotId, now);
    const res = await send("/api/v1/conversations", {
      json: { title: "画面から", participants: [{ bot_id: grokBotId }], message: "こんにちは", idempotency_key: "screen-2" },
      cookies: aliceCookies,
      env: { DELIVERY_QUEUE: queue },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as ConversationDetail).started_by).toEqual({ kind: "user" });
  });
});
