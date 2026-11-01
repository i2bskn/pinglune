import { describe, expect, it, vi } from "vitest";
import type { ApiKey, DeliveryList, EmailAddressList, Source, Subscription, User } from "../../src/api/types";
import { createApiClient, createApiFetch } from "./api";
import { loadDeliveriesView, loadEvents, loadSourceDetail, loadUsersView } from "./load";

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
  };
  const WEBHOOK: Subscription = {
    ...MCP,
    id: "sub_00000000000000000000000000000002",
    kind: "webhook",
    name: "Grok Bot",
    refresh_before: null,
    expires_at: null,
  };
  const DELIVERIES: DeliveryList = { deliveries: [], next_cursor: null };

  it("passes the subscriptions of both kinds as they are", async () => {
    const { client } = setup({
      "/api/v1/subscriptions": [json(200, { subscriptions: [MCP, WEBHOOK] })],
      "/api/v1/deliveries": [json(200, DELIVERIES)],
    });
    expect(await loadDeliveriesView(client)).toEqual({
      kind: "ready",
      data: { subscriptions: [MCP, WEBHOOK], deliveries: DELIVERIES },
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
