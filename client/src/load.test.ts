import { describe, expect, it, vi } from "vitest";
import type {
  ApiKey,
  Bot,
  McpConnection,
  ConversationDetail,
  ConversationMessageList,
  DeliveryList,
  EmailAddressList,
  Source,
  Subscription,
  User,
} from "../../src/api/types";
import { createApiClient, createApiFetch } from "./api";
import {
  loadBotsView,
  loadConversationDetail,
  loadConversationForm,
  loadConversationMessages,
  loadConversations,
  loadDeliveriesView,
  loadEvents,
  loadSourceDetail,
  loadUsersView,
} from "./load";

type Reply = () => Response;

function json(code: number, body: unknown): Reply {
  return () => Response.json(body, { status: code });
}

function apiError(code: number, message: string): Reply {
  return json(code, { error: { code: "error", message } });
}

// fetch that answers each URL from its own queue, in order. /auth/refresh answers 204 unless given.
function setup(routes: Record<string, Reply[]>) {
  const queues = new Map(Object.entries(routes).map(([url, replies]) => [url, [...replies]]));
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    const reply = queues.get(url)?.shift() ?? (url === "/auth/refresh" ? () => new Response(null, { status: 204 }) : null);
    if (!reply) throw new Error(`unexpected fetch: ${url}`);
    return reply();
  });
  const redirectToLogin = vi.fn<(url: string) => void>();
  const client = createApiClient(createApiFetch({ fetch, redirectToLogin, currentPath: () => "/" }));
  const calls = (url: string) => fetch.mock.calls.filter(([input]) => String(input) === url).length;
  return { client, fetch, redirectToLogin, calls };
}

const unauthorized = apiError(401, "ログインしてください");

const BOT: Bot = {
  id: "bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
  name: "Dot",
  delivery_kind: "mcp",
  delivery: null,
  connection: null,
  status: "no_connection",
  created_at: 1,
  updated_at: 1,
};

describe("loadBotsView", () => {
  const CONNECTION: McpConnection = {
    kind: "legacy",
    id: null,
    grant_id: "g1",
    client_name: "ChatGPT",
    redirect_host: "chatgpt.com",
    bot: null,
    created_at: 1,
  };

  it("loads the bots, the MCP connections and the subscriptions", async () => {
    const { client } = setup({
      "/api/v1/bots": [json(200, { bots: [BOT] })],
      "/api/v1/mcp-connections": [json(200, { connections: [CONNECTION] })],
      "/api/v1/subscriptions": [json(200, { subscriptions: [] })],
    });
    expect(await loadBotsView(client)).toEqual({
      kind: "ready",
      data: { bots: [BOT], connections: [CONNECTION], connectionsError: null, subscriptions: [] },
    });
  });

  it("shows the bots without connections when they cannot be read", async () => {
    const { client } = setup({
      "/api/v1/bots": [json(200, { bots: [BOT] })],
      "/api/v1/mcp-connections": [apiError(503, "この接続先では MCP 接続を確認できません")],
      "/api/v1/subscriptions": [json(200, { subscriptions: [] })],
    });
    expect(await loadBotsView(client)).toEqual({
      kind: "ready",
      data: { bots: [BOT], connections: [], connectionsError: "この接続先では MCP 接続を確認できません", subscriptions: [] },
    });
  });

  it("is an error when the bots cannot be read", async () => {
    const { client } = setup({
      "/api/v1/bots": [apiError(500, "サーバーでエラーが発生しました")],
      "/api/v1/mcp-connections": [json(200, { connections: [] })],
      "/api/v1/subscriptions": [json(200, { subscriptions: [] })],
    });
    expect(await loadBotsView(client)).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });
});

describe("loadUsersView", () => {
  const USER: User = {
    id: "u1",
    email: "a@example.com",
    name: null,
    role: "admin",
    created_at: 1,
    last_login_at: null,
  };

  it("shows the users and the auth mode", async () => {
    const { client } = setup({ "/api/v1/users": [json(200, { users: [USER], auth_mode: "oidc" })] });
    expect(await loadUsersView(client)).toEqual({ kind: "ready", data: { users: [USER], authMode: "oidc" } });
  });

  it("is an error with the API message on 403", async () => {
    const { client } = setup({ "/api/v1/users": [apiError(403, "管理者の権限が必要です")] });
    expect(await loadUsersView(client)).toEqual({ kind: "error", message: "管理者の権限が必要です" });
  });

  it("is an error on 404", async () => {
    const { client } = setup({ "/api/v1/users": [apiError(404, "見つかりません")] });
    expect(await loadUsersView(client)).toEqual({ kind: "error", message: "見つかりません" });
  });

  it("moves to the login page when the list stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/users": [unauthorized, unauthorized],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadUsersView(client)).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("loadEvents", () => {
  it("sends the cursor of the next page", async () => {
    const page = { events: [], next_cursor: null };
    const { client, calls } = setup({
      "/api/v1/events": [json(200, page)],
      "/api/v1/events?cursor=evt_1": [json(200, page)],
    });
    expect(await loadEvents(client)).toEqual({ kind: "ready", data: page });
    expect(await loadEvents(client, "evt_1")).toEqual({ kind: "ready", data: page });
    expect(calls("/api/v1/events?cursor=evt_1")).toBe(1);
  });
});

describe("loadSourceDetail", () => {
  const SOURCE: Source = { id: "src_1", name: "app", enabled: true, created_at: 1, updated_at: 1, active_key_count: 1 };
  const KEY: ApiKey = { key_id: "abcdefghij012345", created_at: 1, last_used_at: null, revoked_at: null };

  const ADDRESSES: EmailAddressList = {
    email_domain: "example.com",
    email_addresses: [
      {
        local_part: "abcdefghij0123456789",
        address: "abcdefghij0123456789@example.com",
        created_at: 1,
        last_received_at: null,
        revoked_at: null,
      },
    ],
  };

  it("takes the source from the list, with its keys and its email addresses", async () => {
    const { client } = setup({
      "/api/v1/sources": [json(200, { sources: [SOURCE] })],
      "/api/v1/sources/src_1/api-keys": [json(200, { api_keys: [KEY] })],
      "/api/v1/sources/src_1/email-addresses": [json(200, ADDRESSES)],
    });
    expect(await loadSourceDetail(client, "src_1")).toEqual({
      kind: "ready",
      data: { source: SOURCE, apiKeys: [KEY], emailAddresses: ADDRESSES },
    });
  });

  it("is not found when the keys are not found", async () => {
    const { client } = setup({
      "/api/v1/sources": [json(200, { sources: [] })],
      "/api/v1/sources/src_2/api-keys": [apiError(404, "送信元が見つかりません")],
      "/api/v1/sources/src_2/email-addresses": [apiError(404, "送信元が見つかりません")],
    });
    expect(await loadSourceDetail(client, "src_2")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message when the email addresses fail, like the keys", async () => {
    const { client } = setup({
      "/api/v1/sources": [json(200, { sources: [SOURCE] })],
      "/api/v1/sources/src_1/api-keys": [json(200, { api_keys: [KEY] })],
      "/api/v1/sources/src_1/email-addresses": [apiError(500, "サーバーでエラーが発生しました")],
    });
    expect(await loadSourceDetail(client, "src_1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("is not found for an invalid ID without sending", async () => {
    const { client, fetch } = setup({});
    expect(await loadSourceDetail(client, "a/b")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadDeliveriesView", () => {
  const MCP: Subscription = {
    id: "sub_00000000000000000000000000000001",
    kind: "mcp",
    name: null,
    callback_host: "hooks.example.com",
    arguments: {},
    status: "active",
    refresh_before: 1,
    expires_at: 2,
    created_at: 1,
    updated_at: 1,
    connection: null,
  };
  const WEBHOOK: Subscription = {
    ...MCP,
    id: "sub_00000000000000000000000000000002",
    kind: "webhook",
    name: "Grok Bot",
    refresh_before: null,
    expires_at: null,
  };
  const QUEUE: Subscription = {
    ...WEBHOOK,
    id: "sub_00000000000000000000000000000003",
    kind: "queue",
    name: "Muse",
    callback_host: null,
  };
  const DELIVERIES: DeliveryList = {
    deliveries: [
      {
        id: "dlv_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
        event_id: "evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
        subscription_id: QUEUE.id,
        callback_host: null,
        destination_kind: "queue",
        destination_name: "Muse",
        status: "pending",
        attempts: 0,
        last_attempt_at: null,
        last_http_status: null,
        last_error: null,
        delivered_at: null,
        created_at: 1,
      },
    ],
    next_cursor: null,
  };

  it("passes the subscriptions of every kind and the deliveries as they are", async () => {
    const { client } = setup({
      "/api/v1/subscriptions": [json(200, { subscriptions: [MCP, WEBHOOK, QUEUE] })],
      "/api/v1/deliveries": [json(200, DELIVERIES)],
    });
    expect(await loadDeliveriesView(client)).toEqual({
      kind: "ready",
      data: { subscriptions: [MCP, WEBHOOK, QUEUE], deliveries: DELIVERIES },
    });
  });

  it("is an error with the API message when the subscriptions fail", async () => {
    const { client } = setup({
      "/api/v1/subscriptions": [apiError(500, "サーバーでエラーが発生しました")],
      "/api/v1/deliveries": [json(200, DELIVERIES)],
    });
    expect(await loadDeliveriesView(client)).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });
});

describe("conversations", () => {
  const ID = "cnv_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
  const DETAIL: ConversationDetail = {
    id: ID,
    title: "相談",
    status: "open",
    stop_reason: null,
    max_ai_messages: 20,
    ai_message_count: 1,
    participants: [
      {
        name: "dot",
        bot: { id: "bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V", name: "dot", deleted: false },
        connection_client_name: "dot",
        destination: { kind: "webhook", name: "dot", callback_host: "hooks.example.com", status: "active" },
      },
    ],
    created_at: 1,
    updated_at: 2,
  };
  const MESSAGES: ConversationMessageList = {
    messages: [
      { event_id: "evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V", sender: "a", sender_kind: "user", is_user: true, text: "hi", created_at: 1 },
    ],
    older_cursor: "evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
  };
  const ACTIVE: Subscription = {
    id: "sub_00000000000000000000000000000002",
    kind: "webhook",
    name: "dot",
    callback_host: "hooks.example.com",
    arguments: {},
    status: "active",
    refresh_before: null,
    expires_at: null,
    created_at: 1,
    updated_at: 1,
    connection: null,
  };

  it("sends the cursor of the next page of the list", async () => {
    const page = { conversations: [], next_cursor: null };
    const { client, calls } = setup({
      "/api/v1/conversations": [json(200, page)],
      [`/api/v1/conversations?cursor=${ID}`]: [json(200, page)],
    });
    expect(await loadConversations(client)).toEqual({ kind: "ready", data: page });
    expect(await loadConversations(client, ID)).toEqual({ kind: "ready", data: page });
    expect(calls(`/api/v1/conversations?cursor=${ID}`)).toBe(1);
  });

  it("loads a conversation with its newest messages", async () => {
    const { client } = setup({
      [`/api/v1/conversations/${ID}`]: [json(200, DETAIL)],
      [`/api/v1/conversations/${ID}/messages`]: [json(200, MESSAGES)],
    });
    expect(await loadConversationDetail(client, ID)).toEqual({
      kind: "ready",
      data: { conversation: DETAIL, messages: MESSAGES },
    });
  });

  it("is not found when the conversation is not found", async () => {
    const { client } = setup({
      [`/api/v1/conversations/${ID}`]: [apiError(404, "会話が見つかりません")],
      [`/api/v1/conversations/${ID}/messages`]: [apiError(404, "会話が見つかりません")],
    });
    expect(await loadConversationDetail(client, ID)).toEqual({ kind: "notFound" });
  });

  it("is not found for an invalid ID without sending", async () => {
    const { client, fetch } = setup({});
    expect(await loadConversationDetail(client, "a/b")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the cursor of the older messages", async () => {
    const cursor = "evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
    const { client } = setup({ [`/api/v1/conversations/${ID}/messages?cursor=${cursor}`]: [json(200, MESSAGES)] });
    expect(await loadConversationMessages(client, ID, cursor)).toEqual({ kind: "ready", data: MESSAGES });
  });

  it("loads the bots for the form", async () => {
    const { client, calls } = setup({ "/api/v1/bots": [json(200, { bots: [BOT] })] });
    expect(await loadConversationForm(client)).toEqual({ kind: "ready", data: { bots: [BOT] } });
    expect(calls("/api/v1/mcp-connections")).toBe(0);
    expect(calls("/api/v1/subscriptions")).toBe(0);
  });

  it("is an error when the bots cannot be read", async () => {
    const { client } = setup({ "/api/v1/bots": [apiError(500, "サーバーでエラーが発生しました")] });
    expect(await loadConversationForm(client)).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });
});
