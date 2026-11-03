import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationDetail,
  ConversationList,
  ConversationMessageList,
  Source,
  SourceList,
} from "../src/api/types";
import type { SourceRow, SubscriptionRow, UserRow, WorkspaceRow } from "../src/db/schema";
import { newBotId, newConversationId, newMcpConnectionId } from "../src/ids";
import type { Intake } from "../src/intake/rpc";
import { mcpHandler } from "../src/mcp/handler";
import {
  createApiKey,
  createQueue,
  createSource,
  createSubscription,
  createUser,
  d1With,
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

// The props of the INTAKE binding in vitest.config.ts: the source of the RPC calls. The API key of the HTTP calls
// belongs to the same source, so that both entry points are checked against the same rows.
const RPC_SOURCE_ID = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
const MCP_ACCEPT = "application/json, text/event-stream";
const GROK = "client-grok";
const DAY_MS = 86_400_000;

type Outcome = {
  // The HTTP status; null for RPC.
  status: number | null;
  ok: boolean;
  body: Record<string, unknown> | null;
  error: { code: string; message: string; retryable?: boolean; fields?: Record<string, string> } | null;
};

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

let alice: UserRow;
let bob: UserRow;
let aliceCookies: SessionCookies;
let bobCookies: SessionCookies;
let workspace: WorkspaceRow;
let source: SourceRow;
let apiKey: string;
let dotHook: SubscriptionRow;
let grokQueue: SubscriptionRow;
let dotBotId: string;
let grokBotId: string;
let museBotId: string;
let grokConnectionId: string;
let queue: FakeQueue;

async function createBot(user: UserRow, name: string, kind: "mcp" | "webhook" | "queue", subscriptionId: string | null) {
  const now = Date.now();
  const id = newBotId(now);
  await env.DB.prepare(
    `INSERT INTO bots (id, workspace_id, created_by_user_id, name, delivery_kind, delivery_subscription_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, (await personalWorkspaceOf(user)).id, user.id, name, kind, subscriptionId, now, now)
    .run();
  return id;
}

async function connect(clientId: string, botId: string): Promise<string> {
  const now = Date.now();
  const id = newMcpConnectionId(now);
  await env.DB.prepare(
    `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name, redirect_uri, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, 'https://client.example/cb', ?, ?)`,
  )
    .bind(id, alice.id, workspace.id, botId, clientId, clientId, now, now)
    .run();
  return id;
}

async function callTool(connectionId: string, clientId: string, name: string, args: Record<string, unknown>) {
  const ctx = Object.assign(createExecutionContext(), {
    props: { userId: alice.id, authMode: "password", connectionId },
    auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"], clientId },
  }) as unknown as OAuthResourceContext<unknown>;
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await mcpHandler.fetch(request, { ...env, DELIVERY_QUEUE: queue }, ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: ToolResult };
  return body.result;
}

function toolResult<T>(result: ToolResult): T {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "夜間ビルドの結果",
    participants: ["Grok"],
    message: "夜間ビルドが失敗しました",
    idempotency_key: "nightly-1",
    ...overrides,
  };
}

async function viaHttp(body: unknown, options: { key?: string; contentType?: string } = {}): Promise<Outcome> {
  const res = await send("/ingest/v1/conversations", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${options.key ?? apiKey}`,
      "Content-Type": options.contentType ?? "application/json",
    },
    env: { DELIVERY_QUEUE: queue },
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.ok) return { status: res.status, ok: true, body: json, error: null };
  return { status: res.status, ok: false, body: null, error: json.error as Outcome["error"] };
}

async function viaRpc(body: unknown, binding: Service<Intake> = env.INTAKE): Promise<Outcome> {
  const result = await binding.startConversation(body);
  if (!result.ok) return { status: null, ok: false, body: null, error: result.error };
  const { ok, ...rest } = result;
  return { status: null, ok, body: rest, error: null };
}

const entryPoints: [string, (body: unknown) => Promise<Outcome>][] = [
  ["HTTP", (body) => viaHttp(body)],
  ["RPC", (body) => viaRpc(body)],
];

function setSourceStart(sourceId: string, body: unknown, cookies = aliceCookies) {
  return send(`/api/v1/sources/${sourceId}/conversation-start`, { json: body, cookies });
}

async function allow(dailyLimit = 10, maxAiMessages = 10): Promise<void> {
  const res = await setSourceStart(source.id, { enabled: true, daily_limit: dailyLimit, max_ai_messages: maxAiMessages });
  expect(res.status).toBe(200);
}

// Inserts conversations of alice's workspace directly, started by the bot or the source, created at createdAt.
async function insertConversations(
  count: number,
  startedBy: { botId?: string; sourceId?: string },
  createdAt: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await env.DB.prepare(
      `INSERT INTO conversations (id, workspace_id, title, status, max_ai_messages, ai_message_count, created_by_user_id,
        started_by_bot_id, started_by_source_id, created_at, updated_at)
      VALUES (?, ?, 'old', 'open', 10, 0, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newConversationId(createdAt),
        workspace.id,
        alice.id,
        startedBy.botId ?? null,
        startedBy.sourceId ?? null,
        createdAt,
        createdAt,
      )
      .run();
  }
}

async function conversationRow(id: string) {
  return env.DB.prepare(
    `SELECT workspace_id, status, stop_reason, ai_message_count, max_ai_messages, started_by_bot_id, started_by_source_id,
      created_by_user_id FROM conversations WHERE id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
}

async function firstMessage(conversationId: string): Promise<{ id: string; labels: Record<string, string> }> {
  const row = await env.DB.prepare("SELECT id, labels FROM events WHERE conversation_id = ? ORDER BY id LIMIT 1")
    .bind(conversationId)
    .first<{ id: string; labels: string }>();
  if (!row) throw new Error("no message");
  return { id: row.id, labels: JSON.parse(row.labels) as Record<string, string> };
}

async function countConversations(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM conversations").first<{ count: number }>();
  return row?.count ?? 0;
}

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  queue = fakeQueue();
  // Another user first, so that a wrong workspace would show.
  bob = await createUser({ email: "bob@example.com" });
  alice = await createUser({ email: "alice@example.com" });
  aliceCookies = await login(alice.email);
  bobCookies = await login(bob.email);
  workspace = await personalWorkspaceOf(alice);
  source = await createSource({ id: RPC_SOURCE_ID, workspaceId: workspace.id, name: "nightly" });
  apiKey = (await createApiKey(source.id)).key;
  dotHook = await createSubscription({ user: alice, kind: "webhook", name: "dot", expiresAt: 253402300799999 });
  grokQueue = await createQueue({ user: alice, name: "grok" });
  dotBotId = await createBot(alice, "dot", "webhook", dotHook.id);
  grokBotId = await createBot(alice, "Grok", "queue", grokQueue.id);
  museBotId = await createBot(alice, "Muse", "mcp", null);
  await createBot(bob, "Other", "mcp", null);
  grokConnectionId = await connect(GROK, grokBotId);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

describe("POST /api/v1/sources/:id/conversation-start", () => {
  it("saves the settings and returns the source", async () => {
    const res = await setSourceStart(source.id, { enabled: true, daily_limit: 1000, max_ai_messages: 100 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Source;
    expect(body).toMatchObject({
      id: source.id,
      name: "nightly",
      conversation_start: { enabled: true, daily_limit: 1000, max_ai_messages: 100 },
    });
    expect(body.updated_at).toBeGreaterThanOrEqual(source.updatedAt);

    const off = await setSourceStart(source.id, { enabled: false, daily_limit: 1, max_ai_messages: 1 });
    expect(((await off.json()) as Source).conversation_start).toEqual({ enabled: false, daily_limit: 1, max_ai_messages: 1 });
  });

  it("lists the settings of every source, with the defaults for the others", async () => {
    await createSource({ workspaceId: workspace.id, name: "other", createdAt: Date.now() + 1000 });
    await allow(3, 4);
    const list = (await (await send("/api/v1/sources", { cookies: aliceCookies })).json()) as SourceList;
    expect(list.sources.map((s) => [s.name, s.conversation_start])).toEqual([
      ["nightly", { enabled: true, daily_limit: 3, max_ai_messages: 4 }],
      ["other", { enabled: false, daily_limit: 10, max_ai_messages: 10 }],
    ]);
  });

  it("gives a new source the defaults", async () => {
    const res = await send("/api/v1/sources", { json: { name: "new" }, cookies: aliceCookies });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Source).conversation_start).toEqual({
      enabled: false,
      daily_limit: 10,
      max_ai_messages: 10,
    });
  });

  it("saves the settings of a disabled source", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(source.id).run();
    const res = await setSourceStart(source.id, { enabled: true, daily_limit: 5, max_ai_messages: 5 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Source).conversation_start.enabled).toBe(true);
  });

  it.each([
    [{ enabled: true, daily_limit: 10, max_ai_messages: 10, extra: 1 }, "unknown_field"],
    [{ daily_limit: 10, max_ai_messages: 10 }, "invalid_request"],
    [{ enabled: "true", daily_limit: 10, max_ai_messages: 10 }, "invalid_request"],
    [{ enabled: true, max_ai_messages: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 0, max_ai_messages: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 1001, max_ai_messages: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 1.5, max_ai_messages: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 10 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 10, max_ai_messages: 0 }, "invalid_limit"],
    [{ enabled: true, daily_limit: 10, max_ai_messages: 101 }, "invalid_limit"],
  ])("rejects %j with %s", async (body, code) => {
    const res = await setSourceStart(source.id, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    const row = await env.DB.prepare("SELECT can_start_conversations FROM sources WHERE id = ?")
      .bind(source.id)
      .first<{ can_start_conversations: number }>();
    expect(row?.can_start_conversations).toBe(0);
  });

  it("returns 404 for an unknown, malformed, other user's or conversation source", async () => {
    const bobSource = await createSource({ workspaceId: (await personalWorkspaceOf(bob)).id, name: "bob" });
    const hidden = await env.DB.prepare(
      "INSERT INTO sources (id, workspace_id, name, enabled, kind, created_at, updated_at) VALUES (?, ?, 'Pinglune 会話', 1, 'conversation', 1, 1) RETURNING id",
    )
      .bind("src_01JC9Z7H2K4M6N8P0Q2R4S6T8X", workspace.id)
      .first<{ id: string }>();
    const body = { enabled: true, daily_limit: 10, max_ai_messages: 10 };
    for (const id of ["src_01JC9Z7H2K4M6N8P0Q2R4S6T8W", "nope", bobSource.id, hidden?.id ?? ""]) {
      const res = await setSourceStart(id, body);
      expect(res.status).toBe(404);
    }
    const res = await setSourceStart(source.id, body, bobCookies);
    expect(res.status).toBe(404);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM sources WHERE can_start_conversations = 1").first<{
      count: number;
    }>();
    expect(rows?.count).toBe(0);
  });
});

describe.each(entryPoints)("starting a conversation from a source (%s)", (kind, start) => {
  it("starts a conversation with the invited bots and the first message of the program", async () => {
    await allow();
    const outcome = await start(input({ participants: [" Grok ", "dot", "Muse"] }));
    expect(outcome.error).toBeNull();
    if (kind === "HTTP") expect(outcome.status).toBe(201);
    const body = outcome.body as { conversation_id: string };
    expect(body).toEqual({
      conversation_id: expect.stringMatching(/^cnv_/),
      title: "夜間ビルドの結果",
      status: "open",
      max_ai_messages: 10,
      ai_message_count: 0,
      participants: [
        { name: "Grok", notified: true },
        { name: "dot", notified: true },
        { name: "Muse", notified: false },
      ],
      duplicate: false,
    });

    expect(await conversationRow(body.conversation_id)).toEqual({
      workspace_id: workspace.id,
      status: "open",
      stop_reason: null,
      ai_message_count: 0,
      max_ai_messages: 10,
      started_by_bot_id: null,
      started_by_source_id: source.id,
      created_by_user_id: alice.id,
    });
    const message = await firstMessage(body.conversation_id);
    expect(message.labels).toEqual({
      conversation_id: body.conversation_id,
      sender: "nightly",
      sender_kind: "program",
      sender_id: source.id,
    });
    const deliveries = await listDeliveries("event_id = ?", message.id);
    expect(deliveries.map((d) => d.subscription_id).sort()).toEqual([dotHook.id, grokQueue.id].sort());

    // The management screen names the source by its current name and the message as the program's.
    await env.DB.prepare("UPDATE sources SET name = 'renamed' WHERE id = ?").bind(source.id).run();
    const list = (await (await send("/api/v1/conversations", { cookies: aliceCookies })).json()) as ConversationList;
    expect(list.conversations[0]?.started_by).toEqual({ kind: "source", source_id: source.id, name: "renamed" });
    const detail = (await (
      await send(`/api/v1/conversations/${body.conversation_id}`, { cookies: aliceCookies })
    ).json()) as ConversationDetail;
    expect(detail.started_by).toEqual({ kind: "source", source_id: source.id, name: "renamed" });
    const messages = (await (
      await send(`/api/v1/conversations/${body.conversation_id}/messages`, { cookies: aliceCookies })
    ).json()) as ConversationMessageList;
    expect(messages.messages).toMatchObject([
      { sender: "nightly", sender_kind: "program", is_user: false, text: "夜間ビルドが失敗しました" },
    ]);

    // A bot answers with post_message, and reads the message of the program with get_conversation.
    const posted = toolResult<{ conversation_status: string; remaining_ai_messages: number }>(
      await callTool(grokConnectionId, GROK, "post_message", { conversation_id: body.conversation_id, text: "見ます" }),
    );
    expect(posted).toMatchObject({ conversation_status: "open", remaining_ai_messages: 9 });
    const read = toolResult<{ messages: { sender: string; sender_kind: string }[] }>(
      await callTool(grokConnectionId, GROK, "get_conversation", { conversation_id: body.conversation_id }),
    );
    expect(read.messages.map((m) => [m.sender, m.sender_kind])).toEqual([
      ["nightly", "program"],
      ["Grok", "ai"],
    ]);
  });

  it("uses the limit of the source when max_ai_messages is left out or null", async () => {
    await allow(10, 7);
    const left = await start(input());
    expect(left.body).toMatchObject({ max_ai_messages: 7 });
    const nulled = await start(input({ idempotency_key: "nightly-2", max_ai_messages: null }));
    expect(nulled.body).toMatchObject({ max_ai_messages: 7 });
  });

  it("rejects max_ai_messages over the limit of the source", async () => {
    await allow(10, 7);
    for (const value of [8, 0]) {
      const outcome = await start(input({ max_ai_messages: value }));
      expect(outcome.error).toMatchObject({
        code: "invalid_limit",
        message: "max_ai_messages は 1〜7 の整数にしてください（送信元「nightly」の上限は 7 です）",
      });
      if (kind === "HTTP") expect(outcome.status).toBe(400);
    }
    expect(await countConversations()).toBe(0);
  });

  it("does not stop a conversation with max_ai_messages 1 when it is created", async () => {
    await allow();
    const outcome = await start(input({ max_ai_messages: 1 }));
    expect(outcome.body).toMatchObject({ status: "open", max_ai_messages: 1, ai_message_count: 0 });
  });

  it("returns start_not_allowed for a source that may not start conversations", async () => {
    const outcome = await start(input());
    expect(outcome.error).toMatchObject({
      code: "start_not_allowed",
      message:
        "送信元「nightly」は会話を始めることを許可されていません。Pinglune の送信元の画面（設定）で「会話の開始」を許可してください",
    });
    if (kind === "HTTP") expect(outcome.status).toBe(403);
    if (kind === "RPC") expect(outcome.error?.retryable).toBe(false);
    expect(await countConversations()).toBe(0);
  });

  it("returns source_disabled for a disabled source", async () => {
    await allow();
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(source.id).run();
    const outcome = await start(input());
    expect(outcome.error?.code).toBe("source_disabled");
    if (kind === "HTTP") expect(outcome.status).toBe(403);
  });

  it.each([
    ["no bot", []],
    ["six bots", ["Grok", "dot", "Muse", "a", "b", "c"]],
    ["the same name twice", ["Grok", " Grok"]],
    ["an empty name", ["Grok", "  "]],
    ["a name over 64 characters", ["x".repeat(65)]],
    ["a name that is not a string", [1]],
    ["not an array", "Grok"],
    ["null", null],
  ])("rejects %s as participants", async (_, participants) => {
    await allow();
    const outcome = await start(input({ participants }));
    expect(outcome.error).toMatchObject({ code: "invalid_participants" });
    expect(outcome.error?.fields).toBeUndefined();
    if (kind === "HTTP") expect(outcome.status).toBe(400);
  });

  it("names the bots that are not found, deleted ones and other users' included", async () => {
    await allow();
    await env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(Date.now(), museBotId).run();
    const outcome = await start(input({ participants: ["Grok", "Muse", "Other", "Nobody"] }));
    expect(outcome.error).toMatchObject({
      code: "invalid_participants",
      message: "Bot が見つかりません: 「Muse」、「Other」、「Nobody」。Pinglune の Bot の画面で確かめられます",
    });
    expect(await countConversations()).toBe(0);
  });

  it.each([
    [{ title: 1 }, "invalid_title"],
    [{ title: "" }, "invalid_title"],
    [{ title: null }, "invalid_title"],
    [{ title: "x".repeat(65) }, "invalid_title"],
    [{ message: 1 }, "invalid_text"],
    [{ message: "  " }, "invalid_text"],
    [{ message: null }, "invalid_text"],
    [{ max_ai_messages: "3" }, "invalid_limit"],
    [{ max_ai_messages: 1.5 }, "invalid_limit"],
    [{ idempotency_key: undefined }, "invalid_idempotency_key"],
    [{ idempotency_key: null }, "invalid_idempotency_key"],
    [{ idempotency_key: 1 }, "invalid_idempotency_key"],
    [{ idempotency_key: "has space" }, "invalid_idempotency_key"],
    [{ idempotency_key: "x".repeat(256) }, "invalid_idempotency_key"],
  ])("rejects %j with %s", async (overrides, code) => {
    await allow();
    const outcome = await start(input(overrides));
    expect(outcome.error?.code).toBe(code);
    expect(outcome.error?.fields).toBeUndefined();
    if (kind === "HTTP") expect(outcome.status).toBe(400);
  });

  it("rejects an unknown field first, with its name in fields", async () => {
    await allow();
    const outcome = await start(input({ extra: 1, title: 1 }));
    expect(outcome.error).toMatchObject({ code: "unknown_field", fields: { extra: "未知の項目です" } });
  });

  it("checks the fields in order: title, message, participants, max_ai_messages, idempotency_key", async () => {
    await allow();
    const all = { title: 1, message: 1, participants: [], max_ai_messages: "x", idempotency_key: 1 };
    expect((await start(all)).error?.code).toBe("invalid_title");
    expect((await start({ ...all, title: "t" })).error?.code).toBe("invalid_text");
    expect((await start({ ...all, title: "t", message: "m" })).error?.code).toBe("invalid_participants");
    expect((await start({ ...all, title: "t", message: "m", participants: ["Grok"] })).error?.code).toBe("invalid_limit");
    expect(
      (await start({ ...all, title: "t", message: "m", participants: ["Grok"], max_ai_messages: 2 })).error?.code,
    ).toBe("invalid_idempotency_key");
  });

  it("returns rate_limited at the daily limit, counting the last 24 hours only", async () => {
    await allow(2);
    await insertConversations(1, { sourceId: source.id }, Date.now() - DAY_MS - 60_000);
    await insertConversations(1, { sourceId: source.id }, Date.now() - 1000);
    expect((await start(input())).error).toBeNull();
    const outcome = await start(input({ idempotency_key: "nightly-2" }));
    expect(outcome.error).toMatchObject({
      code: "rate_limited",
      message: "送信元「nightly」が 24 時間に始められる会話は 2 件までです",
    });
    if (kind === "HTTP") expect(outcome.status).toBe(429);
    if (kind === "RPC") expect(outcome.error?.retryable).toBe(false);
  });

  it("does not count the conversations of bots, and bots do not count those of the source", async () => {
    await allow(1);
    await insertConversations(3, { botId: grokBotId }, Date.now() - 1000);
    expect((await start(input())).error).toBeNull();
    const bots = toolResult<{ you: { started_last_24h: number } }>(await callTool(grokConnectionId, GROK, "list_bots", {}));
    expect(bots.you.started_last_24h).toBe(3);
  });

  it("returns the conversation started first for a retry, even at the limit", async () => {
    await allow(1);
    const first = await start(input());
    const firstBody = first.body as { conversation_id: string };
    const again = await start(input({ title: "ちがう件名", participants: ["dot"] }));
    if (kind === "HTTP") expect(again.status).toBe(200);
    expect(again.body).toEqual({
      ...first.body,
      participants: [{ name: "Grok", notified: null }],
      duplicate: true,
    });
    expect(firstBody.conversation_id).toBe((again.body as { conversation_id: string }).conversation_id);
    expect(await countConversations()).toBe(1);
  });

  it("does not find the bots of another user's workspace", async () => {
    await allow();
    const outcome = await start(input({ participants: ["Other"] }));
    expect(outcome.error?.code).toBe("invalid_participants");
  });
});

describe("POST /ingest/v1/conversations", () => {
  it("accepts application/json with parameters", async () => {
    await allow();
    const outcome = await viaHttp(input(), { contentType: "application/json; charset=utf-8" });
    expect(outcome.status).toBe(201);
  });

  it.each([["text/plain"], ["multipart/form-data; boundary=x"], ["application/x-www-form-urlencoded"]])(
    "rejects %s with 415",
    async (contentType) => {
      await allow();
      const outcome = await viaHttp(input(), { contentType });
      expect(outcome.status).toBe(415);
      expect(outcome.error).toEqual({
        code: "unsupported_media_type",
        message: "Content-Type は application/json にしてください",
      });
    },
  );

  it("rejects a body over 256 KiB with 413", async () => {
    await allow();
    const body = JSON.stringify(input({ message: "x".repeat(256 * 1024) }));
    const outcome = await viaHttp(body);
    expect(outcome.status).toBe(413);
    expect(outcome.error).toEqual({
      code: "payload_too_large",
      message: "本文が大きすぎます（JSON 全体で 256 KiB まで）",
    });
  });

  it("accepts a message of 64 KiB escaped in JSON", async () => {
    await allow();
    // 16,384 emoji of 4 bytes: 65,536 bytes of UTF-8, 196,608 bytes once escaped as \uXXXX\uXXXX.
    const message = "😀".repeat(16_384);
    const body = JSON.stringify(input({ message })).replace(/😀/g, "\\ud83d\\ude00");
    const outcome = await viaHttp(body);
    expect(outcome.status).toBe(201);
  });

  it.each([["not json"], ["[]"], ['"text"'], ["null"]])("rejects %s with invalid_json", async (body) => {
    await allow();
    const outcome = await viaHttp(body);
    expect(outcome.status).toBe(400);
    expect(outcome.error?.code).toBe("invalid_json");
  });

  it("returns 401 for a revoked key and a wrong key", async () => {
    await allow();
    const revoked = (await createApiKey(source.id, { revokedAt: Date.now() })).key;
    for (const key of [revoked, "pl_0123456789abcdef_" + "a".repeat(43), "nope"]) {
      const outcome = await viaHttp(input(), { key });
      expect(outcome.status).toBe(401);
      expect(outcome.error?.code).toBe("unauthorized");
    }
    expect(await countConversations()).toBe(0);
  });

  it("checks the authentication before the Content-Type", async () => {
    const outcome = await viaHttp(input(), { key: "nope", contentType: "text/plain" });
    expect(outcome.status).toBe(401);
  });

  it("returns 503 when the owner of the workspace is not found", async () => {
    await allow();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The owner cannot be removed (a foreign key): the user is read as missing instead.
    const DB = d1With({
      prepare: (query: string) => env.DB.prepare(query.replace(/from "users" where/, 'from "users" where 0 and')),
    });
    const res = await send("/ingest/v1/conversations", {
      body: JSON.stringify(input()),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      env: { DB, DELIVERY_QUEUE: queue },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("temporarily_unavailable");
    expect(error).toHaveBeenCalledWith("owner of the workspace of a source not found", {
      sourceId: source.id,
      workspaceId: workspace.id,
    });
    expect(await countConversations()).toBe(0);
  });
});

describe("Intake.startConversation", () => {
  it("returns invalid_input for an input that is not an object", async () => {
    for (const value of [null, "text", [input()], 1]) {
      const outcome = await viaRpc(value);
      expect(outcome.error).toMatchObject({ code: "invalid_input", retryable: false });
    }
  });

  it("returns unauthorized for the conversation source in props", async () => {
    await resetDb();
    const user = await createUser({ email: "carol@example.com" });
    const ws = await personalWorkspaceOf(user);
    await env.DB.prepare(
      "INSERT INTO sources (id, workspace_id, name, enabled, kind, can_start_conversations, created_at, updated_at) VALUES (?, ?, 'Pinglune 会話', 1, 'conversation', 1, 1, 1)",
    )
      .bind(RPC_SOURCE_ID, ws.id)
      .run();
    const outcome = await viaRpc(input());
    expect(outcome.error).toMatchObject({ code: "unauthorized", retryable: false });
    expect(await countConversations()).toBe(0);
  });

  it("returns unauthorized for unknown or malformed props", async () => {
    for (const binding of [env.INTAKE_NO_PROPS, env.INTAKE_MALFORMED, env.INTAKE_UNKNOWN]) {
      const outcome = await viaRpc(input(), binding);
      expect(outcome.error).toMatchObject({ code: "unauthorized", retryable: false });
    }
  });
});
