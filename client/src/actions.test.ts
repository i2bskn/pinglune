import { describe, expect, it, vi } from "vitest";
import type { ApiKey, EmailAddress, Source, User } from "../../src/api/types";
import {
  changeUserRole,
  createSource,
  createUser,
  deleteUser,
  issueApiKey,
  issueEmailAddress,
  resetUserPassword,
  revokeApiKey,
  revokeEmailAddress,
  revokeUserSessions,
  updateSource,
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
