import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode } from "@i2bskn/workers-app-core";
import { core } from "../src/core";
import { users, type UserRow } from "../src/db/schema";
import { newMcpConnectionId } from "../src/ids";
import { NO_EXPIRY } from "../src/subscriptions/queries";
import {
  createSubscription,
  createUser,
  db,
  login,
  ORIGIN,
  PASSWORD,
  personalWorkspaceOf,
  resetDb,
  send,
  sessionCookies,
  setCookies,
  type SessionCookies,
} from "./helpers";

// The login, user management and MCP OAuth of @i2bskn/workers-app-core, as wired into pinglune (src/core.ts). The
// package tests cover their behavior in detail.

const REDIRECT_URI = "https://client.example/cb";
const MCP_ACCEPT = "application/json, text/event-stream";
const NEW_PASSWORD = "a brand new password";

async function setup(): Promise<SessionCookies> {
  const res = await send("/auth/setup", {
    form: { email: "admin@example.com", name: "Admin", password: PASSWORD, password_confirm: PASSWORD },
  });
  expect(res.status).toBe(303);
  return sessionCookies(res);
}

async function openConsent(cookies: SessionCookies): Promise<string> {
  const registered = await send("/oauth/register", {
    json: { redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", client_name: "Test client" },
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "mcp",
    state: "state-123",
    code_challenge: base64UrlEncode(new Uint8Array(digest)),
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  });
  const res = await send(`/authorize?${params}`, { cookies });
  expect(res.status).toBe(200);
  expect(Object.keys(setCookies(res)).length).toBeGreaterThan(0);
  return res.text();
}

// An active MCP connection of the user, not assigned to a bot.
async function insertConnection(user: UserRow): Promise<string> {
  const now = Date.now();
  const id = newMcpConnectionId(now);
  await env.DB.prepare(
    `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name, redirect_uri,
      created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, 'test-client', 'Test client', 'https://client.example.com/callback', ?, ?)`,
  )
    .bind(id, user.id, (await personalWorkspaceOf(user)).id, now, now)
    .run();
  return id;
}

// Calls the /mcp handler of the package with the context OAuthProvider would pass, with these grant props next to
// userId and authMode.
function callMcp(user: UserRow, props: Record<string, unknown>, method = "tools/list"): Promise<Response> {
  const ctx = Object.assign(createExecutionContext(), {
    props: { userId: user.id, authMode: "password", ...props },
    auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"] },
  }) as unknown as OAuthResourceContext<unknown>;
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });
  return core.mcpHandler.fetch(request, env, ctx);
}

async function mcpRevokedAt(userId: string): Promise<number | null> {
  const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return row?.mcpRevokedAt ?? null;
}

beforeEach(resetDb);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core", () => {
  it("creates the first admin, signs in and serves /api/v1/me and /api/v1/users", async () => {
    const cookies = await setup();
    expect(Object.keys(cookies).sort()).toEqual(["__Host-pinglune_at", "__Host-pinglune_rt"]);

    const me = await send("/api/v1/me", { cookies });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "admin@example.com", name: "Admin", role: "admin" });

    const created = await send("/api/v1/users", {
      cookies,
      json: { email: "member@example.com", password: "a long enough password", role: "member" },
    });
    expect(created.status).toBe(201);
    const list = await send("/api/v1/users", { cookies });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      users: [{ email: "admin@example.com" }, { email: "member@example.com" }],
      auth_mode: "password",
    });

    const member = await login("member@example.com", "a long enough password");
    expect((await send("/api/v1/users", { cookies: member })).status).toBe(403);
  });

  it("uses the pinglune layout on the login page", async () => {
    await setup();
    const res = await send("/auth/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>ログイン - Pinglune</title>");
    expect(html).toContain('<picture class="brand-logo">');
    expect(html).toContain("イベントを受け取り、AIエージェントへ届ける。");
  });

  it("shows the consent page of pinglune with the choice of a bot", async () => {
    const cookies = await setup();
    const bot = await send("/api/v1/bots", { cookies, json: { name: "Dot", delivery_kind: "mcp" } });
    expect(bot.status).toBe(201);
    const html = await openConsent(cookies);
    expect(html).toContain("<title>接続の許可 - Pinglune</title>");
    expect(html).toContain(
      "許可すると、このアプリはあなたとして、Pingluneに保存されたイベント・データ・会話を読み取り、ポーリング用のキューからイベントを取り出して処理済みにできます。",
    );
    expect(html).toContain('<select name="bot_id">');
    expect(html).toContain("Dot");
  });

  it("lists the tools at /mcp for a grant with a connection", async () => {
    const user = await createUser({ email: "alice@example.com" });
    const connectionId = await insertConnection(user);
    const res = await callMcp(user, { authorizedAt: Date.now(), connectionId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
  });
});

describe("mcp_revoked_at", () => {
  it("rejects a token authorized before the user changed the password", async () => {
    const user = await createUser({ email: "alice@example.com" });
    const connectionId = await insertConnection(user);
    const authorizedAt = Date.now();
    expect((await callMcp(user, { authorizedAt, connectionId })).status).toBe(200);

    const res = await send("/api/v1/me/password", {
      cookies: await login(user.email),
      json: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(res.status).toBe(204);
    const revokedAt = await mcpRevokedAt(user.id);
    expect(revokedAt).not.toBeNull();

    // The connection is revoked too (credentialsRevokedStatements); with its row active again, mcp_revoked_at alone
    // still rejects the token.
    await env.DB.prepare("UPDATE mcp_connections SET revoked_at = NULL, revoke_reason = NULL WHERE id = ?")
      .bind(connectionId)
      .run();
    const rejected = await callMcp(user, { authorizedAt, connectionId });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("WWW-Authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    // A token authorized after it is accepted.
    expect((await callMcp(user, { authorizedAt: (revokedAt ?? 0) + 1, connectionId })).status).toBe(200);
  });

  it("rejects a grant without authorizedAt, made before it was recorded", async () => {
    const user = await createUser({ email: "alice@example.com" });
    const connectionId = await insertConnection(user);
    expect((await callMcp(user, { connectionId })).status).toBe(401);
  });
});

describe("credentialsRevokedStatements", () => {
  it("ends the subscriptions, revokes the connections and the sessions on revoke-sessions", async () => {
    const admin = await createUser({ email: "admin@example.com", role: "admin" });
    const user = await createUser({ email: "alice@example.com" });
    const subscription = await createSubscription({ user });
    const webhook = await createSubscription({
      user,
      kind: "webhook",
      name: "bot",
      secret: new TextEncoder().encode("crsr_key"),
      expiresAt: NO_EXPIRY,
    });
    const connectionId = await insertConnection(user);
    const userCookies = await login(user.email);

    const res = await send(`/api/v1/users/${user.id}/revoke-sessions`, {
      method: "POST",
      cookies: await login(admin.email),
    });
    expect(res.status).toBe(204);

    for (const id of [subscription.id, webhook.id]) {
      const row = await env.DB.prepare("SELECT unsubscribed_at FROM subscriptions WHERE id = ?")
        .bind(id)
        .first<{ unsubscribed_at: number | null }>();
      expect(row?.unsubscribed_at).not.toBeNull();
    }
    const connection = await env.DB.prepare("SELECT revoked_at, revoke_reason FROM mcp_connections WHERE id = ?")
      .bind(connectionId)
      .first<{ revoked_at: number | null; revoke_reason: string | null }>();
    expect(connection).toMatchObject({ revoked_at: expect.any(Number), revoke_reason: "sessions_revoked" });
    const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL")
      .bind(user.id)
      .first<{ count: number }>();
    expect(active?.count).toBe(0);
    expect((await send("/api/v1/me", { cookies: userCookies })).status).toBe(401);
    expect(await mcpRevokedAt(user.id)).not.toBeNull();
  });
});
