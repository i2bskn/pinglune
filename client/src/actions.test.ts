import { describe, expect, it, vi } from "vitest";
import type {
  ApiKey,
  Bot,
  ConversationDetail,
  DeliveryListItem,
  EmailAddress,
  Source,
  Subscription,
  User,
} from "../../src/api/types";
import {
  assignMcpConnection,
  changeUserRole,
  createBot,
  createConversation,
  createSource,
  createQueue,
  createUser,
  createWebhookDestination,
  deleteBot,
  deleteQueue,
  deleteUser,
  deleteWebhookDestination,
  issueApiKey,
  issueEmailAddress,
  postConversationMessage,
  resetUserPassword,
  retryDelivery,
  revokeApiKey,
  revokeEmailAddress,
  revokeMcpConnection,
  revokeUserSessions,
  stopConversation,
  stopMcpSubscription,
  updateBot,
  updateConversationStart,
  updateSource,
  updateSourceConversationStart,
} from "./actions";
import { createApiClient, createApiFetch } from "./api";

// fetch that answers expectedUrl with reply. /auth/refresh answers 401 unless given, so a 401 ends at the login
// page.
function setup(reply: () => Response | Promise<Response>, refreshStatus: number, expectedUrl: string) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url === "/auth/refresh") return new Response(null, { status: refreshStatus });
    if (url !== expectedUrl) throw new Error(`unexpected fetch: ${url}`);
    return reply();
  });
  const redirectToLogin = vi.fn<(url: string) => void>();
  const client = createApiClient(createApiFetch({ fetch, redirectToLogin, currentPath: () => "/" }));
  return { client, fetch, redirectToLogin };
}

function apiError(code: number, message: string): () => Response {
  return () => Response.json({ error: { code: "error", message } }, { status: code });
}

describe("createUser", () => {
  const url = "/api/v1/users";
  const input = { email: "new@example.com", name: null, password: "correct horse battery", role: "member" } as const;
  const USER: User = {
    id: "u2",
    email: "new@example.com",
    name: null,
    role: "member",
    created_at: 1,
    last_login_at: null,
  };

  it("sends the input and is ok with the user on 201", async () => {
    const { client, fetch } = setup(() => Response.json(USER, { status: 201 }), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "ok", user: USER });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("is an error when the created user is not JSON", async () => {
    const { client } = setup(() => new Response("created", { status: 201 }), 401, url);
    expect(await createUser(client, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 201）",
    });
  });

  it.each([
    [400, "パスワードは 12 文字以上 256 文字以下にしてください"],
    [404, "見つかりません"],
    [409, "このメールアドレスはすでに使われています"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "error", message });
  });

  it("is an error with a fixed message when the error is not JSON", async () => {
    const { client } = setup(() => new Response("Bad Gateway", { status: 502 }), 401, url);
    expect(await createUser(client, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 502）",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "redirecting" });
  });
});

describe.each([
  {
    name: "changeUserRole",
    url: "/api/v1/users/u1",
    method: "PATCH",
    body: { role: "member" },
    call: (client: Parameters<typeof deleteUser>[0], id: string) => changeUserRole(client, id, "member"),
    okStatus: 200,
  },
  {
    name: "resetUserPassword",
    url: "/api/v1/users/u1/password",
    method: "POST",
    body: { password: "a brand new password" },
    call: (client: Parameters<typeof deleteUser>[0], id: string) => resetUserPassword(client, id, "a brand new password"),
    okStatus: 204,
  },
  {
    name: "revokeUserSessions",
    url: "/api/v1/users/u1/revoke-sessions",
    method: "POST",
    body: undefined,
    call: (client: Parameters<typeof deleteUser>[0], id: string) => revokeUserSessions(client, id),
    okStatus: 204,
  },
  {
    name: "deleteUser",
    url: "/api/v1/users/u1",
    method: "DELETE",
    body: undefined,
    call: (client: Parameters<typeof deleteUser>[0], id: string) => deleteUser(client, id),
    okStatus: 204,
  },
])("$name", ({ url, method, body, call, okStatus }) => {
  it("sends the request and is ok", async () => {
    const { client, fetch } = setup(
      () => (okStatus === 204 ? new Response(null, { status: 204 }) : Response.json({})),
      401,
      url,
    );
    expect(await call(client, "u1")).toEqual({ kind: "ok" });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe(method);
    if (body !== undefined) expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "ユーザーが見つかりません"), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "自分自身は削除できません"],
    [403, "管理者の権限が必要です"],
    [409, "最後の管理者は削除できません"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "redirecting" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await call(client, "../spaces/s1")).toEqual({ kind: "error", message: "ユーザーが見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

const SOURCE_ID = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
const KEY_ID = "abcdefghij012345";
const LOCAL_PART = "abcdefghij0123456789";

describe("createSource", () => {
  const url = "/api/v1/sources";
  const SOURCE: Source = {
    id: SOURCE_ID,
    name: "app",
    enabled: true,
    created_at: 1,
    updated_at: 1,
    active_key_count: 0,
    conversation_start: { enabled: false, daily_limit: 10, max_ai_messages: 10 },
    screening: { enabled: false, available: false },
  };

  it("sends the name and is ok with the source on 201", async () => {
    const { client, fetch } = setup(() => Response.json(SOURCE, { status: 201 }), 401, url);
    expect(await createSource(client, "app")).toEqual({ kind: "ok", source: SOURCE });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "app" });
  });

  it.each([
    [400, "名前は制御文字を含まない 1〜64 文字にしてください"],
    [409, "この名前の送信元はすでにあります"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await createSource(client, "app")).toEqual({ kind: "error", message });
  });

  it("is an error when the created source is not JSON", async () => {
    const { client } = setup(() => new Response("created", { status: 201 }), 401, url);
    expect(await createSource(client, "app")).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 201）",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createSource(client, "app")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await createSource(client, "app")).toEqual({ kind: "redirecting" });
  });
});

describe("issueApiKey", () => {
  const url = `/api/v1/sources/${SOURCE_ID}/api-keys`;
  const API_KEY: ApiKey = { key_id: KEY_ID, created_at: 1, last_used_at: null, revoked_at: null };
  const KEY = `pl_${KEY_ID}_${"a".repeat(43)}`;

  it("is ok with the key and the plain key on 201", async () => {
    const { client, fetch } = setup(() => Response.json({ api_key: API_KEY, key: KEY }, { status: 201 }), 401, url);
    expect(await issueApiKey(client, SOURCE_ID)).toEqual({ kind: "ok", apiKey: API_KEY, key: KEY });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "送信元が見つかりません"), 401, url);
    expect(await issueApiKey(client, SOURCE_ID)).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 409", async () => {
    const { client } = setup(apiError(409, "有効なAPIキーは 1 つの送信元に 10 個までです"), 401, url);
    expect(await issueApiKey(client, SOURCE_ID)).toEqual({
      kind: "error",
      message: "有効なAPIキーは 1 つの送信元に 10 個までです",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await issueApiKey(client, SOURCE_ID)).toEqual({ kind: "unknown" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 201 }), 401, url);
    expect(await issueApiKey(client, "../users/u1")).toEqual({ kind: "error", message: "送信元が見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("issueEmailAddress", () => {
  const url = `/api/v1/sources/${SOURCE_ID}/email-addresses`;
  const ADDRESS: EmailAddress = {
    local_part: LOCAL_PART,
    address: `${LOCAL_PART}@example.com`,
    created_at: 1,
    last_received_at: null,
    revoked_at: null,
  };

  it("is ok with the address on 201", async () => {
    const { client, fetch } = setup(() => Response.json(ADDRESS, { status: 201 }), 401, url);
    expect(await issueEmailAddress(client, SOURCE_ID)).toEqual({ kind: "ok", emailAddress: ADDRESS });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "送信元が見つかりません"), 401, url);
    expect(await issueEmailAddress(client, SOURCE_ID)).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 409", async () => {
    const { client } = setup(apiError(409, "メールでの受付が設定されていません（EMAIL_DOMAIN）"), 401, url);
    expect(await issueEmailAddress(client, SOURCE_ID)).toEqual({
      kind: "error",
      message: "メールでの受付が設定されていません（EMAIL_DOMAIN）",
    });
  });

  it("is an error when the created address is not JSON", async () => {
    const { client } = setup(() => new Response("oops", { status: 201 }), 401, url);
    expect(await issueEmailAddress(client, SOURCE_ID)).toMatchObject({ kind: "error" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await issueEmailAddress(client, SOURCE_ID)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await issueEmailAddress(client, SOURCE_ID)).toEqual({ kind: "redirecting" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 201 }), 401, url);
    expect(await issueEmailAddress(client, "../users/u1")).toEqual({ kind: "error", message: "送信元が見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.each([
  {
    name: "revokeEmailAddress",
    url: `/api/v1/sources/${SOURCE_ID}/email-addresses/${LOCAL_PART}/revoke`,
    method: "POST",
    body: undefined,
    call: (client: Parameters<typeof revokeApiKey>[0], id: string) => revokeEmailAddress(client, id, LOCAL_PART),
  },
  {
    name: "revokeApiKey",
    url: `/api/v1/sources/${SOURCE_ID}/api-keys/${KEY_ID}/revoke`,
    method: "POST",
    body: undefined,
    call: (client: Parameters<typeof revokeApiKey>[0], id: string) => revokeApiKey(client, id, KEY_ID),
  },
  {
    name: "updateSource",
    url: `/api/v1/sources/${SOURCE_ID}`,
    method: "PATCH",
    body: { enabled: false },
    call: (client: Parameters<typeof revokeApiKey>[0], id: string) => updateSource(client, id, { enabled: false }),
  },
  {
    name: "updateSourceConversationStart",
    url: `/api/v1/sources/${SOURCE_ID}/conversation-start`,
    method: "POST",
    body: { enabled: true, daily_limit: 5, max_ai_messages: 8 },
    call: (client: Parameters<typeof revokeApiKey>[0], id: string) =>
      updateSourceConversationStart(client, id, { enabled: true, dailyLimit: 5, maxAiMessages: 8 }),
  },
])("$name", ({ url, method, body, call }) => {
  it("sends the request and is ok", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, url);
    expect(await call(client, SOURCE_ID)).toEqual({ kind: "ok" });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe(method);
    if (body !== undefined) expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "APIキーが見つかりません"), 401, url);
    expect(await call(client, SOURCE_ID)).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 400", async () => {
    const { client } = setup(apiError(400, "リクエストの形式が正しくありません"), 401, url);
    expect(await call(client, SOURCE_ID)).toEqual({ kind: "error", message: "リクエストの形式が正しくありません" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await call(client, SOURCE_ID)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await call(client, SOURCE_ID)).toEqual({ kind: "redirecting" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, url);
    expect(await call(client, "a/b")).toEqual({ kind: "error", message: "送信元が見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("revokeApiKey does not send an invalid key ID", async () => {
  const { client, fetch } = setup(() => Response.json({}), 401, "/unused");
  expect(await revokeApiKey(client, SOURCE_ID, "../x")).toEqual({ kind: "error", message: "送信元が見つかりません" });
  expect(fetch).not.toHaveBeenCalled();
});

it("revokeEmailAddress does not send an invalid local part", async () => {
  const { client, fetch } = setup(() => Response.json({}), 401, "/unused");
  expect(await revokeEmailAddress(client, SOURCE_ID, "../x")).toEqual({ kind: "error", message: "送信元が見つかりません" });
  expect(fetch).not.toHaveBeenCalled();
});

const DESTINATION: Subscription = {
  id: "sub_0123456789abcdef0123456789abcdef",
  kind: "webhook",
  name: "Grok Bot",
  callback_host: "api2.example.com",
  arguments: {},
  status: "active",
  refresh_before: null,
  expires_at: null,
  created_at: 1,
  updated_at: 1,
  connection: null,
  bot: null,
};

describe("createWebhookDestination", () => {
  const url = "/api/v1/subscriptions/webhooks";
  const input = { name: "Grok Bot", url: "https://api2.example.com/hook", token: "crsr_x", types: ["alert.observed"] };

  it("sends the input and is ok with the destination on 201", async () => {
    const { client, fetch } = setup(() => Response.json(DESTINATION, { status: 201 }), 401, url);
    expect(await createWebhookDestination(client, input)).toEqual({ kind: "ok", subscription: DESTINATION });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it.each([
    [400, "URL が正しくありません（https のみ）"],
    [409, "Webhook 配信先は 100 件までです"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await createWebhookDestination(client, input)).toEqual({ kind: "error", message });
  });

  it("is an error when the created destination is not JSON", async () => {
    const { client } = setup(() => new Response("created", { status: 201 }), 401, url);
    expect(await createWebhookDestination(client, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 201）",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createWebhookDestination(client, input)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await createWebhookDestination(client, input)).toEqual({ kind: "redirecting" });
  });
});

describe("deleteWebhookDestination", () => {
  const url = `/api/v1/subscriptions/${DESTINATION.id}/delete`;

  it("sends the request and is ok", async () => {
    const { client, fetch } = setup(() => Response.json({ ...DESTINATION, status: "unsubscribed" }), 401, url);
    expect(await deleteWebhookDestination(client, DESTINATION.id)).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "Webhook 配信先が見つかりません"), 401, url);
    expect(await deleteWebhookDestination(client, DESTINATION.id)).toEqual({ kind: "notFound" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await deleteWebhookDestination(client, DESTINATION.id)).toEqual({ kind: "unknown" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => Response.json(DESTINATION), 401, url);
    expect(await deleteWebhookDestination(client, "../sources")).toEqual({
      kind: "error",
      message: "Webhook 配信先が見つかりません",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

const QUEUE: Subscription = { ...DESTINATION, kind: "queue", name: "Muse", callback_host: null };

describe("createQueue", () => {
  const url = "/api/v1/subscriptions/queues";
  const input = { name: "Muse", types: ["alert.observed"] };

  it("sends the input and is ok with the queue on 201", async () => {
    const { client, fetch } = setup(() => Response.json(QUEUE, { status: 201 }), 401, url);
    expect(await createQueue(client, input)).toEqual({ kind: "ok", subscription: QUEUE });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("is an error with the API message on 409", async () => {
    const { client } = setup(apiError(409, "ポーリング用キューは 100 件までです"), 401, url);
    expect(await createQueue(client, input)).toEqual({ kind: "error", message: "ポーリング用キューは 100 件までです" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createQueue(client, input)).toEqual({ kind: "unknown" });
  });
});

describe("deleteQueue", () => {
  const url = `/api/v1/subscriptions/${QUEUE.id}/delete`;

  it("sends the request and is ok", async () => {
    const { client, fetch } = setup(() => Response.json({ ...QUEUE, status: "unsubscribed" }), 401, url);
    expect(await deleteQueue(client, QUEUE.id)).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "配信先が見つかりません"), 401, url);
    expect(await deleteQueue(client, QUEUE.id)).toEqual({ kind: "notFound" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => Response.json(QUEUE), 401, url);
    expect(await deleteQueue(client, "../sources")).toEqual({
      kind: "error",
      message: "ポーリング用キューが見つかりません",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

const CONVERSATION: ConversationDetail = {
  id: "cnv_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
  title: "相談",
  status: "open",
  stop_reason: null,
  max_ai_messages: 20,
  ai_message_count: 0,
  participants: [],
  started_by: { kind: "user" },
  created_at: 1,
  updated_at: 1,
};

describe("createConversation", () => {
  const url = "/api/v1/conversations";
  const input = {
    title: "相談",
    max_ai_messages: 5,
    participants: [{ bot_id: "bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V" }],
    message: "hi",
    idempotency_key: "k1",
  };

  it("sends the input and is ok with the conversation on 201", async () => {
    const { client, fetch } = setup(() => Response.json(CONVERSATION, { status: 201 }), 401, url);
    expect(await createConversation(client, input)).toEqual({ kind: "ok", conversation: CONVERSATION });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("is ok with the existing conversation on a retry (200)", async () => {
    const { client } = setup(() => Response.json(CONVERSATION), 401, url);
    expect(await createConversation(client, input)).toEqual({ kind: "ok", conversation: CONVERSATION });
  });

  it("is an error with the API message on 409", async () => {
    const { client } = setup(apiError(409, "同じ idempotency_key で別の内容が送られました"), 401, url);
    expect(await createConversation(client, input)).toEqual({
      kind: "error",
      message: "同じ idempotency_key で別の内容が送られました",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createConversation(client, input)).toEqual({ kind: "unknown" });
  });
});

describe("postConversationMessage", () => {
  const url = `/api/v1/conversations/${CONVERSATION.id}/messages`;
  const input = { text: "hi", idempotency_key: "k1" };

  it("sends the text and the key and is ok", async () => {
    const { client, fetch } = setup(
      () => Response.json({ event_id: "evt_1", conversation: CONVERSATION }, { status: 201 }),
      401,
      url,
    );
    expect(await postConversationMessage(client, CONVERSATION.id, input)).toEqual({ kind: "ok" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
  });

  it("is an error with the API message when the conversation is stopped", async () => {
    const { client } = setup(apiError(409, "会話は停止しています"), 401, url);
    expect(await postConversationMessage(client, CONVERSATION.id, input)).toEqual({
      kind: "error",
      message: "会話は停止しています",
    });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "会話が見つかりません"), 401, url);
    expect(await postConversationMessage(client, CONVERSATION.id, input)).toEqual({ kind: "notFound" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, url);
    expect(await postConversationMessage(client, "../sources", input)).toEqual({
      kind: "error",
      message: "会話が見つかりません",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("stopConversation", () => {
  const url = `/api/v1/conversations/${CONVERSATION.id}/stop`;

  it("sends the request and is ok", async () => {
    const { client, fetch } = setup(() => Response.json({ ...CONVERSATION, status: "stopped" }), 401, url);
    expect(await stopConversation(client, CONVERSATION.id)).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await stopConversation(client, CONVERSATION.id)).toEqual({ kind: "unknown" });
  });
});

const BOT: Bot = {
  id: "bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
  name: "Dot",
  delivery_kind: "mcp",
  delivery: null,
  connection: null,
  status: "no_connection",
  sources: [],
  conversation_start: { enabled: false, daily_limit: 10, max_ai_messages: 10 },
  created_at: 1,
  updated_at: 1,
};

describe("createBot", () => {
  const url = "/api/v1/bots";
  const input = { name: "Dot", delivery_kind: "mcp" } as const;

  it("sends the input and is ok with the bot on 201", async () => {
    const { client, fetch } = setup(() => Response.json(BOT, { status: 201 }), 401, url);
    expect(await createBot(client, input)).toEqual({ kind: "ok", bot: BOT });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("is an error with the API message on 409", async () => {
    const { client } = setup(apiError(409, "同じ名前の Bot があります"), 401, url);
    expect(await createBot(client, input)).toEqual({ kind: "error", message: "同じ名前の Bot があります" });
  });
});

describe("updateConversationStart", () => {
  const url = `/api/v1/bots/${BOT.id}/conversation-start`;
  const input = { enabled: true, dailyLimit: 5, maxAiMessages: 8 };

  it("sends the settings and is ok with the bot", async () => {
    const saved = { ...BOT, conversation_start: { enabled: true, daily_limit: 5, max_ai_messages: 8 } };
    const { client, fetch } = setup(() => Response.json(saved), 401, url);
    expect(await updateConversationStart(client, BOT.id, input)).toEqual({ kind: "ok", bot: saved });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ enabled: true, daily_limit: 5, max_ai_messages: 8 });
  });

  it("is an error with the API message on 400 and not found on 404", async () => {
    const message = "1日に始められる会話の数は 1〜1000 の整数にしてください";
    expect(await updateConversationStart(setup(apiError(400, message), 401, url).client, BOT.id, input)).toEqual({
      kind: "error",
      message,
    });
    expect(
      await updateConversationStart(setup(apiError(404, "Bot が見つかりません"), 401, url).client, BOT.id, input),
    ).toEqual({ kind: "notFound" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => Response.json(BOT), 401, url);
    expect(await updateConversationStart(client, "../sources", input)).toEqual({
      kind: "error",
      message: "Bot が見つかりません",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("updateBot and deleteBot", () => {
  it("sends the changes and is ok with the bot", async () => {
    const url = `/api/v1/bots/${BOT.id}/update`;
    const { client, fetch } = setup(() => Response.json({ ...BOT, name: "Dot2" }), 401, url);
    expect(await updateBot(client, BOT.id, { name: "Dot2" })).toEqual({ kind: "ok", bot: { ...BOT, name: "Dot2" } });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ name: "Dot2" });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "Bot が見つかりません"), 401, `/api/v1/bots/${BOT.id}/update`);
    expect(await updateBot(client, BOT.id, { name: "x" })).toEqual({ kind: "notFound" });
  });

  it("deletes a bot", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, `/api/v1/bots/${BOT.id}/delete`);
    expect(await deleteBot(client, BOT.id)).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("sends keep_destination=true only when the destination is kept", async () => {
    const url = `/api/v1/bots/${BOT.id}/delete`;
    const kept = setup(() => new Response(null, { status: 204 }), 401, `${url}?keep_destination=true`);
    expect(await deleteBot(kept.client, BOT.id, { keepDestination: true })).toEqual({ kind: "ok" });
    expect(kept.fetch.mock.calls[0]?.[1]?.method).toBe("POST");
    const ended = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await deleteBot(ended.client, BOT.id, { keepDestination: false })).toEqual({ kind: "ok" });
    expect(ended.fetch).toHaveBeenCalledTimes(1);
  });

  it("tells a bot changed by another operation from other errors", async () => {
    const message = "Bot がほかの操作で変わりました。読み込み直してください";
    const { client } = setup(apiError(409, message), 401, `/api/v1/bots/${BOT.id}/delete`);
    expect(await deleteBot(client, BOT.id)).toEqual({ kind: "conflict", message });
  });

  it("does not send an invalid ID", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, "/unused");
    expect(await deleteBot(client, "../x")).toEqual({ kind: "error", message: "Bot が見つかりません" });
    expect(await updateBot(client, "../x", { name: "x" })).toEqual({ kind: "error", message: "Bot が見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("MCP connections", () => {
  it("assigns a connection to a bot", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, "/api/v1/mcp-connections/assign");
    const input = { connection_id: "mcn_01JC9Z7H2K4M6N8P0Q2R4S6T8V", bot_id: BOT.id };
    expect(await assignMcpConnection(client, input)).toEqual({ kind: "ok" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
  });

  it("shows the error of an assignment", async () => {
    const { client } = setup(apiError(400, "期限切れの接続は Bot に割り当てられません"), 401, "/api/v1/mcp-connections/assign");
    expect(await assignMcpConnection(client, { grant_id: "g1", bot_id: null })).toEqual({
      kind: "error",
      message: "期限切れの接続は Bot に割り当てられません",
    });
  });

  it("disconnects a connection or a legacy grant", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, "/api/v1/mcp-connections/revoke");
    expect(await revokeMcpConnection(client, { grant_id: "g1" })).toEqual({ kind: "ok" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ grant_id: "g1" });
  });
});

describe("stopMcpSubscription", () => {
  const ID = "sub_00000000000000000000000000000001";

  it("sends the request and is ok", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, `/api/v1/subscriptions/${ID}/delete`);
    expect(await stopMcpSubscription(client, ID)).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "配信先が見つかりません"), 401, `/api/v1/subscriptions/${ID}/delete`);
    expect(await stopMcpSubscription(client, ID)).toEqual({ kind: "notFound" });
  });
});

describe("retryDelivery", () => {
  const id = "dlv_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
  const url = `/api/v1/deliveries/${id}/retry`;
  const DELIVERY: DeliveryListItem = {
    id,
    event_id: "evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
    subscription_id: "sub_00000000000000000000000000000001",
    callback_host: "hooks.example.com",
    destination_kind: "webhook",
    destination_name: "hook",
    status: "pending",
    attempts: 0,
    last_attempt_at: null,
    last_http_status: null,
    last_error: null,
    delivered_at: null,
    created_at: 1,
    event: { type: "alert.observed", summary: "s", source_name: "app" },
  };

  it("returns the delivery the server returned", async () => {
    const { client, fetch } = setup(() => Response.json(DELIVERY), 204, url);
    expect(await retryDelivery(client, id)).toEqual({ kind: "ok", delivery: DELIVERY });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it.each([
    [409, "失敗した配信だけを再送できます"],
    [503, "再送を受け付けられませんでした。しばらくしてからもう一度お試しください"],
    [404, "配信が見つかりません"],
  ])("shows the message of %i", async (status, message) => {
    const { client } = setup(apiError(status, message), 204, url);
    expect(await retryDelivery(client, id)).toEqual({ kind: "error", message });
  });

  it("is redirecting when login is required", async () => {
    const { client, redirectToLogin } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await retryDelivery(client, id)).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("does not send an invalid ID", async () => {
    const { client, fetch } = setup(() => Response.json(DELIVERY), 204, url);
    expect(await retryDelivery(client, "a/b")).toEqual({ kind: "error", message: "配信が見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
