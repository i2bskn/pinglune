import type { OAuthHelpers, OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationDetail,
  ConversationList,
  ConversationMessageList,
  EventDetail,
  EventList,
  McpConnectionList,
  PostedConversationMessage,
  SourceList,
} from "../src/api/types";
import { clock } from "../src/clock";
import { CONVERSATION_SOURCE_NAME } from "../src/conversations/queries";
import { messageLabels, messageSummary } from "../src/conversations/service";
import type { BotRow, SubscriptionRow, UserRow } from "../src/db/schema";
import { handleEmail } from "../src/intake/email";
import { newBotId, newMcpConnectionId, newParticipantId } from "../src/ids";
import { validateIntakeInput } from "../src/intake/validation";
import { mcpHandler } from "../src/mcp/handler";
import {
  countTable,
  createApiKey,
  createEmailAddress,
  createQueue,
  createSource,
  createSubscription,
  createUser,
  fakeQueue,
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
const MISSING_CONVERSATION = "cnv_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
// The fixed source of the INTAKE binding (vitest.config.ts).
const RPC_SOURCE_ID = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V";

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
type McpMessage = {
  event_id: string;
  sender: string;
  sender_kind: string;
  text: string;
  truncated: boolean;
  data_ref: string | null;
  size: number;
  created_at: string;
};
type GetConversationResult = {
  you: { bot_name: string | null };
  conversation: {
    conversation_id: string;
    title: string;
    status: string;
    stop_reason: string | null;
    max_ai_messages: number;
    ai_message_count: number;
    remaining_ai_messages: number;
    created_at: string;
  };
  participants: { name: string; is_you: boolean }[];
  messages: McpMessage[];
  older_cursor: string | null;
};
type PostResult = { event_id: string; conversation_status: string; remaining_ai_messages: number };

let alice: UserRow;
let bob: UserRow;
let admin: UserRow;
let aliceCookies: SessionCookies;
let dotHook: SubscriptionRow;
let grokQueue: SubscriptionRow;
let museMcp: SubscriptionRow;
let dotBot: BotRow;
let grokBot: BotRow;
let museBot: BotRow;
// The MCP connection of each client of alice, by client ID.
let connections: Record<string, string>;
let queue: FakeQueue;
let now: number;
let keySequence = 0;

// An OAUTH_PROVIDER with the grants of alice: one per client, in two pages, with a repeated client.
function fakeOAuth(options: { names?: Record<string, string>; failLookup?: boolean } = {}): OAuthHelpers {
  const names = options.names ?? { [DOT]: "dot", [GROK]: "Grok Bot", [MUSE]: "Muse" };
  const grant = (clientId: string, index: number) => ({
    id: `g${index}`,
    clientId,
    userId: alice.id,
    scope: ["mcp"],
    metadata: {},
    createdAt: 0,
  });
  const oauth = {
    async listUserGrants(userId: string, listOptions?: { cursor?: string }) {
      if (userId !== alice.id) return { items: [] };
      if (listOptions?.cursor === undefined) return { items: [grant(DOT, 1), grant(GROK, 2)], cursor: "next" };
      return { items: [grant(MUSE, 3), grant(DOT, 4)] };
    },
    async lookupClient(clientId: string) {
      if (options.failLookup) throw new Error("lookup failed");
      const clientName = names[clientId];
      return clientName === undefined ? null : { clientId, clientName, redirectUris: [] };
    },
  };
  return oauth as unknown as OAuthHelpers;
}

function apiEnv(oauth: OAuthHelpers | undefined = fakeOAuth()) {
  return oauth === undefined ? { DELIVERY_QUEUE: queue } : { DELIVERY_QUEUE: queue, OAUTH_PROVIDER: oauth };
}

function nextKey(): string {
  keySequence++;
  return `key-${keySequence}`;
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "週次の相談",
    participants: [{ bot_id: dotBot.id }, { bot_id: grokBot.id }],
    message: "こんにちは。\n今週の予定を相談しましょう。",
    idempotency_key: nextKey(),
    ...overrides,
  };
}

function createConversationRequest(body: unknown, options: { cookies?: SessionCookies; oauth?: OAuthHelpers } = {}) {
  return send("/api/v1/conversations", {
    json: body,
    cookies: options.cookies ?? aliceCookies,
    env: apiEnv(options.oauth ?? fakeOAuth()),
  });
}

async function createConversation(overrides: Record<string, unknown> = {}): Promise<ConversationDetail> {
  const res = await createConversationRequest(createBody(overrides));
  expect(res.status).toBe(201);
  return (await res.json()) as ConversationDetail;
}

async function expectApiError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
}

async function messages(id: string, cursor?: string): Promise<ConversationMessageList> {
  const res = await send(`/api/v1/conversations/${id}/messages${cursor === undefined ? "" : `?cursor=${cursor}`}`, {
    cookies: aliceCookies,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ConversationMessageList;
}

function postUserMessage(id: string, text: string, key = nextKey()) {
  return send(`/api/v1/conversations/${id}/messages`, {
    json: { text, idempotency_key: key },
    cookies: aliceCookies,
    env: apiEnv(),
  });
}

// Inserts a bot of alice directly.
async function createBot(name: string, kind: "mcp" | "webhook" | "queue", subscriptionId: string | null): Promise<BotRow> {
  const id = newBotId(now);
  await env.DB.prepare(
    `INSERT INTO bots (id, workspace_id, created_by_user_id, name, delivery_kind, delivery_subscription_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, (await personalWorkspaceOf(alice)).id, alice.id, name, kind, subscriptionId, now, now)
    .run();
  const row = await env.DB.prepare("SELECT * FROM bots WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) throw new Error("bot not found");
  return {
    id,
    workspaceId: row.workspace_id as string,
    createdByUserId: alice.id,
    name,
    deliveryKind: kind,
    deliverySubscriptionId: subscriptionId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

// Inserts an active MCP connection of alice directly, and makes it the connection of clientId in rpc().
async function connect(clientId: string, clientName: string, botId: string | null): Promise<string> {
  const id = newMcpConnectionId(now);
  await env.DB.prepare(
    `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name, redirect_uri, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, 'https://client.example/cb', ?, ?)`,
  )
    .bind(id, alice.id, (await personalWorkspaceOf(alice)).id, botId, clientId, clientName, now, now)
    .run();
  connections[clientId] = id;
  return id;
}

// The MCP connection of clientId is passed in the props, as a grant made by POST /authorize carries it. A client
// without a connection (undefined, or another user) is a legacy connection.
async function rpc(user: UserRow, clientId: string | undefined, method: string, params: unknown): Promise<unknown> {
  const connectionId = user.id === alice.id && clientId !== undefined ? connections[clientId] : undefined;
  const ctx = Object.assign(createExecutionContext(), {
    props: { userId: user.id, authMode: "password", ...(connectionId === undefined ? {} : { connectionId }) },
    auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"], clientId },
  }) as unknown as OAuthResourceContext<unknown>;
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  // The deliveries go to the fake queue only.
  const res = await mcpHandler.fetch(request, { ...env, DELIVERY_QUEUE: queue }, ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

function callTool(clientId: string | undefined, name: string, args: Record<string, unknown>, user = alice) {
  return rpc(user, clientId, "tools/call", { name, arguments: args }) as Promise<ToolResult>;
}

function parse<T>(result: ToolResult): T {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

function expectToolError(result: ToolResult, code: string) {
  expect(result.isError).toBe(true);
  expect((JSON.parse(result.content[0]?.text ?? "") as { error: { code: string } }).error.code).toBe(code);
}

async function post(clientId: string | undefined, conversationId: string, text: string, key?: string) {
  return callTool(clientId, "post_message", {
    conversation_id: conversationId,
    text,
    ...(key === undefined ? {} : { idempotency_key: key }),
  });
}

async function getConversation(clientId: string | undefined, args: Record<string, unknown>) {
  return parse<GetConversationResult>(await callTool(clientId, "get_conversation", args));
}

async function conversationRow(id: string) {
  return env.DB.prepare("SELECT status, stop_reason, ai_message_count, stopped_at FROM conversations WHERE id = ?")
    .bind(id)
    .first<{ status: string; stop_reason: string | null; ai_message_count: number; stopped_at: number | null }>();
}

async function conversationSourceId(): Promise<string> {
  const workspace = await personalWorkspaceOf(alice);
  const row = await env.DB.prepare("SELECT id FROM sources WHERE workspace_id = ? AND kind = 'conversation'")
    .bind(workspace.id)
    .first<{ id: string }>();
  if (!row) throw new Error("conversation source not found");
  return row.id;
}

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  queue = fakeQueue();
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  admin = await createUser({ email: "admin@example.com", role: "admin" });
  aliceCookies = await login(alice.email);
  dotHook = await createSubscription({ user: alice, kind: "webhook", name: "dot", expiresAt: 253402300799999 });
  grokQueue = await createQueue({ user: alice, name: "grok" });
  museMcp = await createSubscription({ user: alice, callbackUrl: "https://muse.example.com/hook" });
  connections = {};
  dotBot = await createBot("dot", "webhook", dotHook.id);
  grokBot = await createBot("Grok", "queue", grokQueue.id);
  museBot = await createBot("Muse", "mcp", null);
  await connect(DOT, "dot", dotBot.id);
  await connect(GROK, "Grok Bot", grokBot.id);
  await connect(MUSE, "Muse", museBot.id);
  // Muse's MCP Events subscription was made by its connection.
  await env.DB.prepare("UPDATE subscriptions SET connection_id = ? WHERE id = ?").bind(connections[MUSE], museMcp.id).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

describe("POST /api/v1/conversations", () => {
  it("creates a conversation and delivers the first message to every participant", async () => {
    const created = await createConversation();
    expect(created).toMatchObject({
      title: "週次の相談",
      status: "open",
      stop_reason: null,
      max_ai_messages: 20,
      ai_message_count: 0,
      participants: [
        {
          name: "dot",
          bot: { id: dotBot.id, name: "dot", deleted: false },
          connection_client_name: "dot",
          destination: { kind: "webhook", name: "dot", callback_host: "hooks.example.com", status: "active" },
        },
        {
          name: "Grok",
          bot: { id: grokBot.id, name: "Grok", deleted: false },
          connection_client_name: "Grok Bot",
          destination: { kind: "queue", name: "grok", callback_host: null, status: "active" },
        },
      ],
    });
    expect(created.id).toMatch(/^cnv_/);

    const list = await messages(created.id);
    expect(list.messages).toEqual([
      {
        event_id: expect.stringMatching(/^evt_/),
        sender: "alice@example.com",
        sender_kind: "user",
        is_user: true,
        text: "こんにちは。\n今週の予定を相談しましょう。",
        created_at: now,
      },
    ]);
    const eventId = list.messages[0]?.event_id ?? "";
    const deliveries = await listDeliveries("event_id = ?", eventId);
    expect(deliveries.map((d) => [d.subscription_id, d.status]).sort()).toEqual(
      [
        [dotHook.id, "pending"],
        [grokQueue.id, "pending"],
      ].sort(),
    );
    // Only the webhook delivery is queued; the polling queue waits for claim_events.
    const webhookDelivery = deliveries.find((d) => d.subscription_id === dotHook.id);
    expect(queue.messages).toEqual([{ delivery_id: webhookDelivery?.id }]);

    const event = await env.DB.prepare("SELECT type, summary, labels, conversation_id, source_id FROM events WHERE id = ?")
      .bind(eventId)
      .first<{ type: string; summary: string; labels: string; conversation_id: string; source_id: string }>();
    expect(event).toMatchObject({
      type: "conversation.message",
      summary: "alice@example.com: こんにちは。 今週の予定を相談しましょう。",
      conversation_id: created.id,
      source_id: await conversationSourceId(),
    });
    expect(JSON.parse(event?.labels ?? "")).toEqual({
      conversation_id: created.id,
      sender: "alice@example.com",
      sender_kind: "user",
      sender_id: alice.id,
    });
  });

  it("returns the first conversation on a retry with the same key, whatever the contents", async () => {
    const body = createBody();
    const first = await createConversationRequest(body);
    expect(first.status).toBe(201);
    const created = (await first.json()) as ConversationDetail;
    const again = await createConversationRequest({ ...body, title: "別の件名" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as ConversationDetail).id).toBe(created.id);
    expect(await countTable("conversations")).toBe(1);
    expect(await countTable("events")).toBe(1);
  });

  it("uses the name of the user as the sender", async () => {
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind("アリス", alice.id).run();
    const created = await createConversation();
    expect((await messages(created.id)).messages[0]?.sender).toBe("アリス");
  });

  it.each([
    ["an unknown field", { extra: 1 }, "unknown_field"],
    ["an empty title", { title: " " }, "invalid_name"],
    ["a title over 64 characters", { title: "a".repeat(65) }, "invalid_name"],
    ["a limit of 0", { max_ai_messages: 0 }, "invalid_limit"],
    ["a limit of 101", { max_ai_messages: 101 }, "invalid_limit"],
    ["a fractional limit", { max_ai_messages: 1.5 }, "invalid_limit"],
    ["a limit as a string", { max_ai_messages: "5" }, "invalid_limit"],
    ["no participants", { participants: [] }, "invalid_participants"],
    ["participants that are not an array", { participants: {} }, "invalid_participants"],
    ["a blank message", { message: " \n " }, "invalid_text"],
    ["a message with a control character", { message: "a\u0001b" }, "invalid_text"],
    ["a message over 65,536 bytes", { message: "あ".repeat(21_846) }, "invalid_text"],
    ["no idempotency key", { idempotency_key: undefined }, "invalid_idempotency_key"],
    ["an idempotency key with a space", { idempotency_key: "a b" }, "invalid_idempotency_key"],
  ])("rejects %s", async (_, overrides, code) => {
    await expectApiError(await createConversationRequest(createBody(overrides)), 400, code);
    expect(await countTable("conversations")).toBe(0);
  });

  it("rejects 6 participants, a repeated bot, the participants before bots and malformed IDs", async () => {
    const others = await Promise.all([1, 2, 3].map((i) => createBot(`ai-${i}`, "mcp", null)));
    const cases = [
      [dotBot, grokBot, museBot, ...others].map((bot) => ({ bot_id: bot.id })),
      [{ bot_id: dotBot.id }, { bot_id: dotBot.id }],
      [{ bot_id: dotBot.id, extra: 1 }],
      [{ name: "dot", oauth_client_id: DOT, subscription_id: dotHook.id }],
      [{ bot_id: "bot_x" }],
      [{ bot_id: 1 }],
      ["x"],
    ];
    for (const participants of cases) {
      await expectApiError(await createConversationRequest(createBody({ participants })), 400, "invalid_participants");
    }
    expect(await countTable("conversations")).toBe(0);
  });

  it("rejects bots that are deleted, of another user or missing", async () => {
    const deleted = await createBot("old", "mcp", null);
    await env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, deleted.id).run();
    const bobsBot = newBotId(now);
    await env.DB.prepare(
      `INSERT INTO bots (id, workspace_id, created_by_user_id, name, delivery_kind, delivery_subscription_id, created_at, updated_at)
      VALUES (?, ?, ?, 'bob', 'mcp', NULL, ?, ?)`,
    )
      .bind(bobsBot, (await personalWorkspaceOf(bob)).id, bob.id, now, now)
      .run();
    for (const id of [deleted.id, bobsBot, newBotId(now)]) {
      await expectApiError(
        await createConversationRequest(createBody({ participants: [{ bot_id: dotBot.id }, { bot_id: id }] })),
        400,
        "invalid_participants",
      );
    }
    expect(await countTable("conversations")).toBe(0);
    expect(await countTable("events")).toBe(0);
  });

  it("accepts a bot without a connection or a destination, and stores the message without delivering to it", async () => {
    const lonely = await createBot("lonely", "mcp", null);
    const created = await createConversation({ participants: [{ bot_id: lonely.id }] });
    expect(created.participants).toEqual([
      { name: "lonely", bot: { id: lonely.id, name: "lonely", deleted: false }, connection_client_name: null, destination: null },
    ]);
    expect(await countTable("events")).toBe(1);
    expect(await listDeliveries()).toEqual([]);
  });

  it("allows 20 open conversations", async () => {
    for (let i = 0; i < 20; i++) await createConversation();
    await expectApiError(await createConversationRequest(createBody()), 409, "limit_exceeded");
    // A stopped conversation does not count.
    const list = (await (await send("/api/v1/conversations", { cookies: aliceCookies })).json()) as ConversationList;
    const res = await send(`/api/v1/conversations/${list.conversations[0]?.id}/stop`, {
      method: "POST",
      cookies: aliceCookies,
    });
    expect(res.status).toBe(200);
    expect((await createConversationRequest(createBody())).status).toBe(201);
  });

  it("creates a conversation without OAUTH_PROVIDER", async () => {
    const origin = "http://pinglune.internal.example";
    const res = await send(`${origin}/api/v1/conversations`, {
      json: createBody(),
      cookies: aliceCookies,
      env: { DELIVERY_QUEUE: queue },
    });
    expect(res.status).toBe(201);
    expect(await countTable("conversations")).toBe(1);
  });

  it("answers 503 and keeps the message when queueing fails, and queues it on the retry", async () => {
    const body = createBody();
    queue.fail = true;
    await expectApiError(await createConversationRequest(body), 503, "temporarily_unavailable");
    expect(await countTable("conversations")).toBe(1);
    queue.fail = false;
    const again = await createConversationRequest(body);
    expect(again.status).toBe(200);
    expect(queue.messages).toHaveLength(1);
  });

  it("requires a login", async () => {
    const res = await send("/api/v1/conversations", { json: createBody(), env: apiEnv() });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/mcp-connections", () => {
  it("lists the grants without a connection as legacy connections, with the names of their clients", async () => {
    const res = await send("/api/v1/mcp-connections", { cookies: aliceCookies, env: apiEnv() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as McpConnectionList;
    const legacy = body.connections.filter((c) => c.kind === "legacy");
    expect(legacy.map((c) => [c.grant_id, c.client_name]).sort()).toEqual(
      [
        ["g1", "dot"],
        ["g2", "Grok Bot"],
        ["g3", "Muse"],
        ["g4", "dot"],
      ].sort(),
    );
  });

  it("names a client that cannot be looked up by its ID", async () => {
    const res = await send("/api/v1/mcp-connections", {
      cookies: aliceCookies,
      env: apiEnv(fakeOAuth({ failLookup: true })),
    });
    const body = (await res.json()) as McpConnectionList;
    expect(
      body.connections
        .filter((c) => c.kind === "legacy")
        .map((c) => c.client_name)
        .sort(),
    ).toEqual([DOT, DOT, GROK, MUSE].sort());
  });

  it("answers 503 without OAUTH_PROVIDER", async () => {
    const res = await send("http://pinglune.internal.example/api/v1/mcp-connections", { cookies: aliceCookies });
    await expectApiError(res, 503, "temporarily_unavailable");
  });
});

describe("the management API of a conversation", () => {
  it("lists the conversations newest first", async () => {
    const first = await createConversation({ title: "一つ目" });
    now += 1000;
    const second = await createConversation({ title: "二つ目" });
    const res = await send("/api/v1/conversations", { cookies: aliceCookies });
    const body = (await res.json()) as ConversationList;
    expect(body.conversations.map((c) => [c.id, c.title])).toEqual([
      [second.id, "二つ目"],
      [first.id, "一つ目"],
    ]);
    expect(body.conversations[0]?.participants).toEqual([{ name: "dot" }, { name: "Grok" }]);
    expect(body.next_cursor).toBeNull();
    const older = await send(`/api/v1/conversations?cursor=${second.id}`, { cookies: aliceCookies });
    expect(((await older.json()) as ConversationList).conversations.map((c) => c.id)).toEqual([first.id]);
    await expectApiError(await send("/api/v1/conversations?cursor=evt_x", { cookies: aliceCookies }), 400, "invalid_cursor");
  });

  it("answers another user's conversation as not found", async () => {
    const created = await createConversation();
    const bobCookies = await login(bob.email);
    for (const [path, method] of [
      [`/api/v1/conversations/${created.id}`, "GET"],
      [`/api/v1/conversations/${created.id}/messages`, "GET"],
      [`/api/v1/conversations/${created.id}/stop`, "POST"],
      [`/api/v1/conversations/${MISSING_CONVERSATION}`, "GET"],
      ["/api/v1/conversations/not-an-id", "GET"],
    ] as const) {
      await expectApiError(await send(path, { method, cookies: bobCookies }), 404, "not_found");
    }
    await expectApiError(
      await send(`/api/v1/conversations/${created.id}/messages`, {
        json: { text: "hi", idempotency_key: "k" },
        cookies: bobCookies,
        env: apiEnv(),
      }),
      404,
      "not_found",
    );
    const list = (await (await send("/api/v1/conversations", { cookies: bobCookies })).json()) as ConversationList;
    expect(list.conversations).toEqual([]);
  });

  it("shows the state of the destinations and the client ID without OAUTH_PROVIDER", async () => {
    const created = await createConversation();
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?").bind(now, dotHook.id).run();
    const res = await send(`http://pinglune.internal.example/api/v1/conversations/${created.id}`, {
      cookies: aliceCookies,
    });
    const detail = (await res.json()) as ConversationDetail;
    // An ended destination is no destination of the bot anymore.
    expect(detail.participants.map((p) => [p.name, p.connection_client_name, p.destination?.status ?? null])).toEqual([
      ["dot", "dot", null],
      ["Grok", "Grok Bot", "active"],
    ]);
  });

  it("posts messages of the user to every AI with an active destination, without counting them", async () => {
    const created = await createConversation({
      participants: [{ bot_id: dotBot.id }, { bot_id: grokBot.id }, { bot_id: museBot.id }],
    });
    // A subscription of the workspace that is not a participant gets nothing.
    const bystander = await createSubscription({ user: alice, kind: "webhook", name: "all", expiresAt: 253402300799999 });
    // An ended destination keeps its participant, but gets nothing.
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?").bind(now, museMcp.id).run();
    queue.messages.length = 0;
    now += 1000;

    const res = await postUserMessage(created.id, "  前後の空白も\tそのまま  ");
    expect(res.status).toBe(201);
    const body = (await res.json()) as PostedConversationMessage;
    expect(body.conversation.ai_message_count).toBe(0);
    expect(body.conversation.updated_at).toBe(now);
    const deliveries = await listDeliveries("event_id = ?", body.event_id);
    expect(deliveries.map((d) => d.subscription_id).sort()).toEqual([dotHook.id, grokQueue.id].sort());
    expect(deliveries.some((d) => d.subscription_id === bystander.id)).toBe(false);
    expect(queue.messages).toHaveLength(1);
    expect((await messages(created.id)).messages.at(-1)?.text).toBe("  前後の空白も\tそのまま  ");
  });

  it("returns the same message on a retry and rejects other contents with the same key", async () => {
    const created = await createConversation();
    const first = await postUserMessage(created.id, "a", "same");
    expect(first.status).toBe(201);
    const again = await postUserMessage(created.id, "a", "same");
    expect(again.status).toBe(200);
    expect(((await again.json()) as PostedConversationMessage).event_id).toBe(
      ((await first.json()) as PostedConversationMessage).event_id,
    );
    await expectApiError(await postUserMessage(created.id, "b", "same"), 409, "idempotency_conflict");
    expect((await messages(created.id)).messages).toHaveLength(2);
  });

  it("rejects an invalid message", async () => {
    const created = await createConversation();
    await expectApiError(await postUserMessage(created.id, ""), 400, "invalid_text");
    await expectApiError(
      await send(`/api/v1/conversations/${created.id}/messages`, {
        json: { text: "a", idempotency_key: "k", extra: 1 },
        cookies: aliceCookies,
        env: apiEnv(),
      }),
      400,
      "unknown_field",
    );
  });

  it("stops a conversation and fails the notifications not delivered yet", async () => {
    const created = await createConversation();
    const stopped = await send(`/api/v1/conversations/${created.id}/stop`, { method: "POST", cookies: aliceCookies });
    expect(stopped.status).toBe(200);
    expect((await stopped.json()) as ConversationDetail).toMatchObject({ status: "stopped", stop_reason: "user" });
    const deliveries = await listDeliveries();
    expect(deliveries.map((d) => [d.status, d.last_error])).toEqual([
      ["failed", "conversation_stopped"],
      ["failed", "conversation_stopped"],
    ]);
    // Stopping again changes nothing.
    const again = await send(`/api/v1/conversations/${created.id}/stop`, { method: "POST", cookies: aliceCookies });
    expect(again.status).toBe(200);
    await expectApiError(await postUserMessage(created.id, "まだいますか"), 409, "conversation_stopped");
    expectToolError(await post(DOT, created.id, "はい"), "conversation_stopped");
  });

  it("pages the messages from the newest", async () => {
    const created = await createConversation();
    for (let i = 0; i < 51; i++) {
      now += 1;
      expect((await postUserMessage(created.id, `m${i}`)).status).toBe(201);
    }
    const page = await messages(created.id);
    expect(page.messages).toHaveLength(50);
    expect(page.messages[0]?.text).toBe("m1");
    expect(page.messages.at(-1)?.text).toBe("m50");
    expect(page.older_cursor).toBe(page.messages[0]?.event_id);
    const older = await messages(created.id, page.older_cursor ?? "");
    expect(older.messages.map((m) => m.text)).toEqual(["こんにちは。\n今週の予定を相談しましょう。", "m0"]);
    expect(older.older_cursor).toBeNull();
    await expectApiError(
      await send(`/api/v1/conversations/${created.id}/messages?cursor=cnv_x`, { cookies: aliceCookies }),
      400,
      "invalid_cursor",
    );
  });
});

describe("post_message", () => {
  it("stores a message of a participant and delivers it to the others only", async () => {
    const created = await createConversation();
    queue.messages.length = 0;
    now += 1000;
    const result = parse<PostResult>(await post(GROK, created.id, "了解です。\n水曜はどうですか"));
    expect(result).toEqual({ event_id: expect.stringMatching(/^evt_/), conversation_status: "open", remaining_ai_messages: 19 });
    const deliveries = await listDeliveries("event_id = ?", result.event_id);
    expect(deliveries.map((d) => d.subscription_id)).toEqual([dotHook.id]);
    expect(queue.messages).toEqual([{ delivery_id: deliveries[0]?.id }]);
    const row = await env.DB.prepare("SELECT labels, summary FROM events WHERE id = ?")
      .bind(result.event_id)
      .first<{ labels: string; summary: string }>();
    const participantId = JSON.parse(row?.labels ?? "{}").sender_id as string;
    expect(participantId).toMatch(/^cpt_/);
    expect(JSON.parse(row?.labels ?? "")).toEqual({
      conversation_id: created.id,
      sender: "Grok",
      sender_kind: "ai",
      sender_id: participantId,
    });
    expect(row?.summary).toBe("Grok: 了解です。 水曜はどうですか");
    expect(await conversationRow(created.id)).toMatchObject({ status: "open", ai_message_count: 1 });
  });

  it("rejects a connection that is not a participant, without storing or counting", async () => {
    const created = await createConversation();
    const intruder = await post(MUSE, created.id, "割り込み");
    expectToolError(intruder, "not_participant");
    expect(JSON.parse(intruder.content[0]?.text ?? "").error.message).toBe(
      "あなたは Bot「Muse」として接続していますが、この会話の参加者ではありません",
    );
    const unnamed = await post(undefined, created.id, "名無し");
    expectToolError(unnamed, "not_participant");
    expect(JSON.parse(unnamed.content[0]?.text ?? "").error.message).toBe(
      "この MCP 接続は Bot に割り当てられていません。Pinglune の Bot 画面で、この接続を Bot に割り当ててもらってください",
    );
    expect(await countTable("events")).toBe(1);
    expect(await conversationRow(created.id)).toMatchObject({ ai_message_count: 0 });
  });

  it("answers another workspace's or a missing conversation as not found", async () => {
    const created = await createConversation();
    expectToolError(await callTool(DOT, "post_message", { conversation_id: created.id, text: "x" }, bob), "not_found");
    expectToolError(await post(DOT, MISSING_CONVERSATION, "x"), "not_found");
    expectToolError(await post(DOT, "cnv_x", "x"), "not_found");
  });

  it.each([
    ["blank", " \n\t "],
    ["empty", ""],
    ["a control character", "a\u0007"],
    ["a lone surrogate", "a\uD800b"],
    ["over 65,536 bytes", "a".repeat(65_537)],
  ])("rejects a text that is %s", async (_, text) => {
    const created = await createConversation();
    expectToolError(await post(DOT, created.id, text), "invalid_text");
    expect(await conversationRow(created.id)).toMatchObject({ ai_message_count: 0 });
  });

  it("accepts the message that reaches the limit, delivers it, and stops the conversation", async () => {
    const created = await createConversation({ max_ai_messages: 2 });
    parse<PostResult>(await post(DOT, created.id, "1"));
    now += 1000;
    const last = parse<PostResult>(await post(GROK, created.id, "2"));
    expect(last).toMatchObject({ conversation_status: "stopped", remaining_ai_messages: 0 });
    expect(await conversationRow(created.id)).toEqual({
      status: "stopped",
      stop_reason: "limit",
      ai_message_count: 2,
      stopped_at: now,
    });
    // The last message is still delivered.
    const deliveries = await listDeliveries("event_id = ?", last.event_id);
    expect(deliveries.map((d) => [d.subscription_id, d.status])).toEqual([[dotHook.id, "pending"]]);
    expectToolError(await post(DOT, created.id, "3"), "conversation_stopped");
    expect(await conversationRow(created.id)).toMatchObject({ ai_message_count: 2 });
    // Stopping on the screen afterwards keeps the delivery of the last message.
    await send(`/api/v1/conversations/${created.id}/stop`, { method: "POST", cookies: aliceCookies });
    expect((await listDeliveries("event_id = ?", last.event_id))[0]?.status).toBe("pending");
    expect(await conversationRow(created.id)).toMatchObject({ stop_reason: "limit" });
  });

  it("lets only one of two AIs take the last message", async () => {
    const created = await createConversation({ max_ai_messages: 1 });
    const results = await Promise.all([post(DOT, created.id, "私が"), post(GROK, created.id, "いや私が")]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expectToolError(results.find((r) => r.isError) as ToolResult, "conversation_stopped");
    expect(await conversationRow(created.id)).toMatchObject({ ai_message_count: 1, status: "stopped" });
    expect(await countTable("events")).toBe(2);
  });

  it("returns the same message for a retry with the same key, without counting it, even after a stop", async () => {
    const created = await createConversation({ max_ai_messages: 1 });
    const first = parse<PostResult>(await post(DOT, created.id, "一度だけ", "evt-1"));
    const again = parse<PostResult>(await post(DOT, created.id, "一度だけ", "evt-1"));
    expect(again).toEqual({ event_id: first.event_id, conversation_status: "stopped", remaining_ai_messages: 0 });
    expect(await conversationRow(created.id)).toMatchObject({ ai_message_count: 1 });
    expectToolError(await post(DOT, created.id, "別の内容", "evt-1"), "idempotency_conflict");
    expect(await countTable("events")).toBe(2);
  });

  it("rejects an idempotency key of the wrong form as invalid arguments", async () => {
    const created = await createConversation();
    const result = await post(DOT, created.id, "x", "a b");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^MCP error -32602: Input validation error/);
  });

  it("answers temporarily_unavailable when queueing fails, and queues it on a retry with the same key", async () => {
    const created = await createConversation();
    queue.messages.length = 0;
    queue.fail = true;
    expectToolError(await post(GROK, created.id, "届くかな", "k1"), "temporarily_unavailable");
    queue.fail = false;
    const retried = parse<PostResult>(await post(GROK, created.id, "届くかな", "k1"));
    expect(queue.messages).toHaveLength(1);
    expect(await countTable("events")).toBe(2);
    expect(retried.remaining_ai_messages).toBe(19);
  });

  it("does not deliver to a participant whose destination has ended", async () => {
    const created = await createConversation();
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?").bind(now, dotHook.id).run();
    const result = parse<PostResult>(await post(GROK, created.id, "誰か"));
    expect(await listDeliveries("event_id = ?", result.event_id)).toEqual([]);
  });

  it("fails the pending notifications of the AI messages when the user stops the conversation", async () => {
    const created = await createConversation();
    const result = parse<PostResult>(await post(GROK, created.id, "通知されるはず"));
    await send(`/api/v1/conversations/${created.id}/stop`, { method: "POST", cookies: aliceCookies });
    const deliveries = await listDeliveries("event_id = ?", result.event_id);
    expect(deliveries.map((d) => [d.status, d.last_error])).toEqual([["failed", "conversation_stopped"]]);
  });
});

describe("get_conversation", () => {
  it("returns the state, the participants and the messages oldest first", async () => {
    const created = await createConversation();
    now += 1000;
    parse<PostResult>(await post(GROK, created.id, "返信です"));
    const result = await getConversation(DOT, { conversation_id: created.id });
    expect(result.conversation).toEqual({
      conversation_id: created.id,
      title: "週次の相談",
      status: "open",
      stop_reason: null,
      max_ai_messages: 20,
      ai_message_count: 1,
      remaining_ai_messages: 19,
      created_at: new Date(created.created_at).toISOString(),
    });
    expect(result.participants).toEqual([
      { name: "dot", is_you: true },
      { name: "Grok", is_you: false },
    ]);
    expect(result.you).toEqual({ bot_name: "dot" });
    expect(result.messages.map((m) => [m.sender, m.sender_kind, m.text, m.truncated])).toEqual([
      ["alice@example.com", "user", "こんにちは。\n今週の予定を相談しましょう。", false],
      ["Grok", "ai", "返信です", false],
    ]);
    expect(result.messages[1]?.created_at).toBe(new Date(now).toISOString());
    expect(result.older_cursor).toBeNull();
    // A connection that is not a participant can read it too.
    const muse = await getConversation(MUSE, { conversation_id: created.id });
    expect(muse.participants.every((p) => !p.is_you)).toBe(true);
    expect(muse.you).toEqual({ bot_name: "Muse" });
    expect((await getConversation(undefined, { conversation_id: created.id })).you).toEqual({ bot_name: null });
  });

  it("returns the newest messages and pages to older ones", async () => {
    const created = await createConversation();
    for (let i = 0; i < 4; i++) {
      now += 1;
      parse<PostResult>(await post(DOT, created.id, `m${i}`));
    }
    const page = await getConversation(DOT, { conversation_id: created.id, limit: 2 });
    expect(page.messages.map((m) => m.text)).toEqual(["m2", "m3"]);
    expect(page.older_cursor).toBe(page.messages[0]?.event_id);
    const older = await getConversation(DOT, { conversation_id: created.id, limit: 2, cursor: page.older_cursor });
    expect(older.messages.map((m) => m.text)).toEqual(["m0", "m1"]);
    const oldest = await getConversation(DOT, { conversation_id: created.id, limit: 2, cursor: older.older_cursor });
    expect(oldest.messages).toHaveLength(1);
    expect(oldest.older_cursor).toBeNull();
    expectToolError(
      await callTool(DOT, "get_conversation", { conversation_id: created.id, cursor: "cnv_x" }),
      "invalid_cursor",
    );
  });

  it("cuts a long message at a character boundary and points to read_data", async () => {
    const created = await createConversation();
    // 3 bytes per character: 8,192 bytes end inside the 2,731st character.
    const text = "あ".repeat(3000);
    parse<PostResult>(await post(DOT, created.id, text));
    const message = (await getConversation(DOT, { conversation_id: created.id })).messages.at(-1);
    expect(message?.truncated).toBe(true);
    expect(message?.text).toBe("あ".repeat(2730));
    expect(message?.size).toBe(9000);
    const read = parse<{ text: string; next_offset: number | null }>(
      await callTool(DOT, "read_data", { data_ref: message?.data_ref, offset: 8190 }),
    );
    expect(read.text).toBe("あ".repeat(270));
  });

  it("answers another workspace's or a missing conversation as not found", async () => {
    const created = await createConversation();
    expectToolError(await callTool(DOT, "get_conversation", { conversation_id: created.id }, bob), "not_found");
    expectToolError(await callTool(DOT, "get_conversation", { conversation_id: MISSING_CONVERSATION }), "not_found");
  });
});

describe("the participants of conversations", () => {
  it("delivers to the subscription of the new connection after the connection of a bot is replaced", async () => {
    const created = await createConversation({ participants: [{ bot_id: dotBot.id }, { bot_id: museBot.id }] });
    const old = connections[MUSE] ?? "";
    // Muse is installed again: the old connection is replaced, and the new one subscribes with another callback.
    await env.DB.prepare("UPDATE mcp_connections SET revoked_at = ?, revoke_reason = 'replaced' WHERE id = ?")
      .bind(now, old)
      .run();
    const fresh = await connect(MUSE, "Muse", museBot.id);
    const subscription = await createSubscription({ user: alice, callbackUrl: "https://muse.example.com/new" });
    await env.DB.prepare("UPDATE subscriptions SET connection_id = ? WHERE id = ?").bind(fresh, subscription.id).run();
    now += 1000;

    const sent = parse<PostResult>(await post(MUSE, created.id, "新しい接続から"));
    expect((await listDeliveries("event_id = ?", sent.event_id)).map((d) => d.subscription_id)).toEqual([dotHook.id]);
    const reply = parse<PostResult>(await post(DOT, created.id, "届きましたか"));
    expect((await listDeliveries("event_id = ?", reply.event_id)).map((d) => d.subscription_id)).toEqual([
      subscription.id,
    ]);

    // The token of the old connection is rejected.
    const ctx = Object.assign(createExecutionContext(), {
      props: { userId: alice.id, authMode: "password", connectionId: old },
      auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"], clientId: MUSE },
    }) as unknown as OAuthResourceContext<unknown>;
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect((await mcpHandler.fetch(request, { ...env, DELIVERY_QUEUE: queue }, ctx)).status).toBe(401);
  });

  it("does not deliver to a bot whose connection or subscription is gone, nor to a deleted bot", async () => {
    const created = await createConversation({
      participants: [{ bot_id: dotBot.id }, { bot_id: grokBot.id }, { bot_id: museBot.id }],
    });
    await env.DB.prepare("UPDATE mcp_connections SET bot_id = NULL WHERE id = ?").bind(connections[MUSE]).run();
    await env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, grokBot.id).run();
    const sent = parse<PostResult>(await post(DOT, created.id, "誰かいますか"));
    expect(await listDeliveries("event_id = ?", sent.event_id)).toEqual([]);
    const res = await send(`/api/v1/conversations/${created.id}`, { cookies: aliceCookies });
    const detail = (await res.json()) as ConversationDetail;
    expect(detail.participants.map((p) => [p.name, p.bot?.deleted, p.connection_client_name, p.destination])).toEqual([
      ["dot", false, "dot", { kind: "webhook", name: "dot", callback_host: "hooks.example.com", status: "active" }],
      ["Grok", true, null, null],
      ["Muse", false, null, null],
    ]);
  });

  it("matches and notifies a participant created before bots by its client and its subscription", async () => {
    const created = await createConversation({ participants: [{ bot_id: dotBot.id }] });
    const workspaceId = (await personalWorkspaceOf(alice)).id;
    // A row of the form before bots, as the migration copies it.
    await env.DB.prepare(
      `INSERT INTO conversation_participants (id, conversation_id, workspace_id, name, oauth_client_id, subscription_id, created_at)
      VALUES (?, ?, ?, 'old', 'client-legacy', ?, ?)`,
    )
      .bind(newParticipantId(now), created.id, workspaceId, grokQueue.id, now)
      .run();

    // client-legacy has no MCP connection: a legacy connection, matched by its OAuth client.
    const sent = parse<PostResult>(await post("client-legacy", created.id, "以前の参加者です"));
    expect((await listDeliveries("event_id = ?", sent.event_id)).map((d) => d.subscription_id)).toEqual([dotHook.id]);
    const reply = parse<PostResult>(await post(DOT, created.id, "お久しぶりです"));
    expect((await listDeliveries("event_id = ?", reply.event_id)).map((d) => d.subscription_id)).toEqual([
      grokQueue.id,
    ]);
    const read = await getConversation("client-legacy", { conversation_id: created.id });
    expect(read.participants).toEqual([
      { name: "dot", is_you: false },
      { name: "old", is_you: true },
    ]);
    const res = await send(`/api/v1/conversations/${created.id}`, { cookies: aliceCookies });
    expect(((await res.json()) as ConversationDetail).participants[1]).toEqual({
      name: "old",
      bot: null,
      connection_client_name: "client-legacy",
      destination: { kind: "queue", name: "grok", callback_host: null, status: "active" },
    });
  });
});

describe("the events of conversations", () => {
  it("are not listed, but can be read", async () => {
    const created = await createConversation();
    const eventId = (await messages(created.id)).messages[0]?.event_id ?? "";

    const list = (await (await send("/api/v1/events", { cookies: aliceCookies })).json()) as EventList;
    expect(list.events).toEqual([]);
    const mcpList = parse<{ events: unknown[] }>(await callTool(DOT, "list_events", {}));
    expect(mcpList.events).toEqual([]);
    const bySource = parse<{ events: unknown[] }>(await callTool(DOT, "list_events", { sources: [CONVERSATION_SOURCE_NAME] }));
    expect(bySource.events).toEqual([]);

    const detail = await send(`/api/v1/events/${eventId}`, { cookies: aliceCookies });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as EventDetail;
    expect(body).toMatchObject({
      event_id: eventId,
      type: "conversation.message",
      source: { name: CONVERSATION_SOURCE_NAME },
      conversation_id: created.id,
      data: [{ role: "body", name: "message.txt", content_type: "text/plain; charset=utf-8" }],
    });
    const event = parse<{ data: { data_ref: string }[]; conversation_id?: string }>(
      await callTool(DOT, "get_event", { event_id: eventId }),
    );
    // MCP get_event is unchanged: the conversation is in the labels.
    expect(event.conversation_id).toBeUndefined();
    const read = parse<{ text: string }>(await callTool(DOT, "read_data", { data_ref: event.data[0]?.data_ref }));
    expect(read.text).toBe("こんにちは。\n今週の予定を相談しましょう。");
  });

  it("are not delivered to the subscriptions of the workspace by their filters", async () => {
    const all = await createSubscription({ user: alice, kind: "webhook", name: "all", expiresAt: 253402300799999 });
    await createConversation();
    expect(await listDeliveries("subscription_id = ?", all.id)).toEqual([]);
  });

  it("have a summary and labels that the intake would accept", () => {
    const sender = { kind: "ai" as const, id: "cpt_01JC9Z7H2K4M6N8P0Q2R4S6T8V", name: "あ".repeat(64) };
    const summary = messageSummary(sender.name, "い\n".repeat(3000));
    expect(Array.from(summary)).toHaveLength(2000);
    expect(summary.endsWith("…")).toBe(true);
    const validated = validateIntakeInput({
      idempotency_key: "k",
      type: "conversation.message",
      summary,
      labels: messageLabels(MISSING_CONVERSATION, sender),
    });
    expect(validated.ok).toBe(true);
  });
});

describe("the conversation source", () => {
  it("is hidden from the sources, their keys and addresses, and the limit", async () => {
    const workspaceId = (await personalWorkspaceOf(alice)).id;
    // The user's own source with the same name does not get in the way.
    await createSource({ workspaceId, name: CONVERSATION_SOURCE_NAME });
    await createConversation();
    const hidden = await conversationSourceId();

    const list = (await (await send("/api/v1/sources", { cookies: aliceCookies })).json()) as SourceList;
    expect(list.sources.map((s) => s.id)).not.toContain(hidden);
    expect(list.sources).toHaveLength(1);
    for (const [path, method] of [
      [`/api/v1/sources/${hidden}/api-keys`, "GET"],
      [`/api/v1/sources/${hidden}/api-keys`, "POST"],
      [`/api/v1/sources/${hidden}/email-addresses`, "GET"],
    ] as const) {
      await expectApiError(await send(path, { method, cookies: aliceCookies }), 404, "not_found");
    }
    await expectApiError(
      await send(`/api/v1/sources/${hidden}`, { method: "PATCH", json: { enabled: false }, cookies: aliceCookies }),
      404,
      "not_found",
    );

    // With 98 more sources of programs, one more reaches the limit of 100: the conversation source is not counted.
    for (let i = 0; i < 98; i++) await createSource({ workspaceId, name: `s${i}` });
    const created = await send("/api/v1/sources", { json: { name: "last" }, cookies: aliceCookies });
    expect(created.status).toBe(201);
    await expectApiError(await send("/api/v1/sources", { json: { name: "over" }, cookies: aliceCookies }), 409, "limit_exceeded");
  });

  it("cannot take events through an API key, an email address or Service Bindings", async () => {
    await createConversation();
    const hidden = await conversationSourceId();
    const { key } = await createApiKey(hidden);
    const res = await send("/ingest/v1/events", {
      headers: { Authorization: `Bearer ${key}` },
      json: { idempotency_key: "k", type: "a.b", summary: "s" },
      env: { DELIVERY_QUEUE: queue },
    });
    expect(res.status).toBe(401);

    const localPart = await createEmailAddress(hidden);
    const rejects: string[] = [];
    const raw = new TextEncoder().encode("From: a@example.net\r\nSubject: x\r\n\r\nbody\r\n");
    const message = {
      from: "a@example.net",
      to: `${localPart}@example.com`,
      headers: new Headers(),
      raw: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(raw);
          controller.close();
        },
      }),
      rawSize: raw.byteLength,
      setReject(reason: string) {
        rejects.push(reason);
      },
    } as unknown as ForwardableEmailMessage;
    await handleEmail(message, { ...env, EMAIL_DOMAIN: "example.com", DELIVERY_QUEUE: queue });
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatch(/Unknown recipient/i);

    // The source of the binding, made a conversation source.
    await env.DB.prepare(
      "INSERT INTO sources (id, workspace_id, name, enabled, kind, created_at, updated_at) VALUES (?, ?, 'x', 1, 'conversation', ?, ?)",
    )
      .bind(RPC_SOURCE_ID, (await personalWorkspaceOf(bob)).id, now, now)
      .run();
    const result = await env.INTAKE.submit({ idempotency_key: "k", type: "a.b", summary: "s" });
    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await countTable("events")).toBe(1);
  });

  it("is created once per workspace", async () => {
    await createConversation();
    await createConversation();
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sources WHERE kind = 'conversation'").first<{
      count: number;
    }>();
    expect(row?.count).toBe(1);
  });
});

describe("deleting the user", () => {
  it("deletes the conversations and their participants with the workspace", async () => {
    const created = await createConversation();
    parse<PostResult>(await post(GROK, created.id, "消える前に"));
    expect(await countTable("conversations")).toBe(1);
    const cookies = await login(admin.email);
    const res = await send(`/api/v1/users/${alice.id}`, { method: "DELETE", cookies });
    expect(res.status).toBe(204);
    expect(await countTable("conversations")).toBe(0);
    expect(await countTable("conversation_participants")).toBe(0);
    expect(await countTable("events")).toBe(0);
    expect(await countTable("sources")).toBe(0);
  });
});
