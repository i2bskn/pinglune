import { getOAuthApi, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeNext } from "../src/auth/redirect";
import { issueSession } from "../src/auth/sessions";
import { base64UrlEncode, signAccessToken } from "../src/auth/tokens";
import type { UserRow } from "../src/db/schema";
import type { Bindings } from "../src/env";
import { mcpHandler } from "../src/mcp/handler";
import { buildOAuthProviderOptions } from "../src/mcp/provider";
import {
  createSubscription,
  createUser,
  db,
  login,
  OIDC_ORIGIN,
  oidcEnv,
  ORIGIN,
  PASSWORD,
  resetDb,
  send,
  setCookies,
  type RequestOptions,
} from "./helpers";

const REDIRECT_URI = "https://client.example/cb";
const MCP_ACCEPT = "application/json, text/event-stream";

type Cookies = Record<string, string>;

type FlowOptions = {
  origin?: string;
  env?: Partial<Bindings>;
  sharedEnv?: Cloudflare.Env;
  redirectUri?: string;
  clientName?: string;
  // An existing client, instead of registering a new one.
  clientId?: string;
  // The bot_id sent with the approval.
  botId?: string;
};

type TokenResponse = { access_token: string; refresh_token?: string; resource?: string; expires_in: number };

function withDefaults(options: FlowOptions): RequestOptions {
  return { env: options.env, sharedEnv: options.sharedEnv };
}

async function registerClient(options: FlowOptions = {}): Promise<string> {
  const origin = options.origin ?? ORIGIN;
  const res = await send(`${origin}/oauth/register`, {
    ...withDefaults(options),
    json: {
      redirect_uris: [options.redirectUri ?? REDIRECT_URI],
      token_endpoint_auth_method: "none",
      client_name: options.clientName ?? "Test client",
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

function authorizeUrl(origin: string, clientId: string, challenge: string, redirectUri = REDIRECT_URI): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "mcp",
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  return `${origin}/authorize?${params}`;
}

type Consent = { html: string; handle: string; cookies: Cookies };

async function openConsent(
  sessionCookies: Cookies,
  options: FlowOptions = {},
): Promise<Consent & { clientId: string; verifier: string }> {
  const origin = options.origin ?? ORIGIN;
  const clientId = options.clientId ?? (await registerClient(options));
  const { verifier, challenge } = await pkce();
  const res = await send(authorizeUrl(origin, clientId, challenge, options.redirectUri), {
    ...withDefaults(options),
    cookies: sessionCookies,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) throw new Error(`handle not found: ${html}`);
  const cookies: Cookies = { ...sessionCookies };
  for (const [name, cookie] of Object.entries(setCookies(res))) cookies[name] = cookie.value;
  return { html, handle, cookies, clientId, verifier };
}

// Runs DCR, PKCE, the consent page and the token request, and returns the token response.
async function authorizeClient(sessionCookies: Cookies, options: FlowOptions = {}): Promise<TokenResponse> {
  const origin = options.origin ?? ORIGIN;
  const consent = await openConsent(sessionCookies, options);
  const approved = await send(`${origin}/authorize`, {
    ...withDefaults(options),
    cookies: consent.cookies,
    form: { handle: consent.handle, decision: "approve", ...(options.botId === undefined ? {} : { bot_id: options.botId }) },
  });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("Location") ?? "");
  const code = location.searchParams.get("code");
  if (!code) throw new Error(`code not found: ${location.href}`);

  const res = await send(`${origin}/oauth/token`, {
    ...withDefaults(options),
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: options.redirectUri ?? REDIRECT_URI,
      client_id: consent.clientId,
      code_verifier: consent.verifier,
    },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as TokenResponse;
}

async function mcpRequest(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { origin?: string; env?: Partial<Bindings>; sharedEnv?: Cloudflare.Env } = {},
): Promise<Response> {
  return send(`${options.origin ?? ORIGIN}/mcp`, {
    env: options.env,
    sharedEnv: options.sharedEnv,
    headers: { Authorization: `Bearer ${token}`, Accept: MCP_ACCEPT },
    json: { jsonrpc: "2.0", id: 1, method, params },
  });
}

// The params of initialize, which needs no tools. Used to check whether a token is accepted.
const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
};

function mcpInitialize(
  token: string,
  options: { origin?: string; env?: Partial<Bindings>; sharedEnv?: Cloudflare.Env } = {},
): Promise<Response> {
  return mcpRequest(token, "initialize", INITIALIZE_PARAMS, options);
}

// The token was accepted: HTTP 200 with the result of initialize from this server.
async function expectMcpOk(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
  expect(body.result?.serverInfo?.name).toBe("pinglune");
}

async function oidcSessionCookies(user: UserRow): Promise<Cookies> {
  const now = Date.now();
  const session = await issueSession(db, user.id, "oidc", now);
  const at = await signAccessToken({ sub: user.id, sid: session.sessionId }, env.JWT_SECRET ?? "", now);
  return { "__Host-pinglune_at": at, "__Host-pinglune_rt": session.refreshToken };
}

function oauthApi(origin: string, overrides: Partial<Bindings> = {}) {
  return getOAuthApi(buildOAuthProviderOptions(origin), { ...env, ...overrides });
}

let admin: UserRow;
let member: UserRow;
let adminCookies: Cookies;
let memberCookies: Cookies;

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ email: "admin@example.com", role: "admin" });
  member = await createUser({ email: "member@example.com" });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discovery", () => {
  it("answers /mcp without a token with 401 and a challenge", async () => {
    const res = await send("/mcp", { json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("publishes the protected resource metadata", async () => {
    const res = await send("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
    expect(body.authorization_servers).toEqual([ORIGIN]);
    expect(body.scopes_supported).toEqual(["mcp"]);
  });

  it("publishes the authorization server metadata", async () => {
    const res = await send("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ORIGIN);
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(body.scopes_supported).toEqual(["mcp"]);
    expect(body.protected_resources).toEqual([`${ORIGIN}/mcp`]);
    expect(body.resource).toBeUndefined();
  });
});

describe("GET /authorize", () => {
  it("sends a signed-out user to the login page and back", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const url = new URL(authorizeUrl(ORIGIN, clientId, challenge));
    const res = await send(url.href);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/auth/login");
    const next = location.searchParams.get("next");
    expect(next).toBe(`${url.pathname}${url.search}`);
    expect(safeNext(next, ORIGIN)).toBe(`${url.pathname}${url.search}`);

    // With a refresh token, GET /auth/login renews the session and returns to the same URL.
    const back = await send(`${location.pathname}${location.search}`, {
      cookies: { "__Host-pinglune_rt": memberCookies["__Host-pinglune_rt"] ?? "" },
    });
    expect(back.status).toBe(302);
    expect(back.headers.get("Location")).toBe(`${url.pathname}${url.search}`);
  });

  it("renders an invalid request locally without a redirect", async () => {
    const res = await send("/authorize?response_type=code&client_id=missing", { cookies: memberCookies });
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("answers HEAD and prefetches with 204 before reading the request", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const url = authorizeUrl(ORIGIN, clientId, challenge);
    const head = await send(url, { method: "HEAD", cookies: memberCookies });
    expect(head.status).toBe(204);
    expect(head.headers.getSetCookie()).toEqual([]);
    const prefetch = await send(url, { cookies: memberCookies, headers: { "Sec-Purpose": "prefetch" } });
    expect(prefetch.status).toBe(204);
  });

  it("shows the client, the redirect host and the user, escaped and not frameable", async () => {
    const consent = await openConsent(memberCookies, { clientName: "<script>alert(1)</script>" });
    expect(consent.html).not.toContain("<script>alert(1)</script>");
    expect(consent.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(consent.html).toContain("このアプリの名前は確認されていません");
    expect(consent.html).toContain("client.example");
    expect(consent.html).toContain(member.email);
    expect(consent.html).not.toContain("このパソコン上のアプリ");
    const res = await send(authorizeUrl(ORIGIN, consent.clientId, (await pkce()).challenge), {
      cookies: memberCookies,
    });
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("warns when the redirect goes to a loopback address", async () => {
    const consent = await openConsent(memberCookies, { redirectUri: "http://127.0.0.1:33418/callback" });
    expect(consent.html).toContain("127.0.0.1");
    expect(consent.html).toContain("このパソコン上のアプリに接続を渡します");
  });
});

describe("POST /authorize", () => {
  it("redirects with access_denied when the user declines", async () => {
    const consent = await openConsent(memberCookies);
    const res = await send("/authorize", {
      cookies: consent.cookies,
      form: { handle: consent.handle, decision: "deny" },
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(await oauthApi(ORIGIN).listUserGrants(member.id)).toMatchObject({ items: [] });
  });

  it("rejects a handle without the consent cookie", async () => {
    const consent = await openConsent(memberCookies);
    const res = await send("/authorize", {
      cookies: memberCookies,
      form: { handle: consent.handle, decision: "approve" },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("画面の有効期限が切れたか");
  });

  it("requires the web session", async () => {
    const consent = await openConsent(memberCookies);
    const { "__Host-pinglune_at": _at, ...withoutSession } = consent.cookies;
    const res = await send("/authorize", { cookies: withoutSession, form: { handle: consent.handle, decision: "approve" } });
    expect(res.status).toBe(401);
  });

  it("rejects a cross-site form post", async () => {
    const consent = await openConsent(memberCookies);
    const res = await send("/authorize", {
      cookies: consent.cookies,
      form: { handle: consent.handle, decision: "approve" },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });
});

describe("MCP", () => {
  it("initializes with a token from the OAuth flow", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    await expectMcpOk(await mcpInitialize(access_token));
  });

  it("returns 401 once the user is deleted", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    await expectMcpOk(await mcpInitialize(access_token));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM mcp_connections WHERE user_id = ?").bind(member.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(member.id),
      env.DB.prepare("DELETE FROM workspaces WHERE owner_user_id = ?").bind(member.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(member.id),
    ]);
    const res = await mcpInitialize(access_token);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(res.headers.get("WWW-Authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("answers GET and DELETE with 405", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    for (const method of ["GET", "DELETE"]) {
      const res = await send("/mcp", {
        method,
        headers: { Authorization: `Bearer ${access_token}`, Accept: MCP_ACCEPT },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  it("answers a token without the mcp scope with 403", async () => {
    // Clients cannot get such a token from this server (consent always grants mcp), so the
    // handler is called directly with the context OAuthProvider would pass.
    const ctx = Object.assign(createExecutionContext(), {
      props: { userId: member.id, authMode: "password" },
      auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: [] },
    }) as unknown as OAuthResourceContext<unknown>;
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const res = await mcpHandler.fetch(request, env, ctx);
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
  });
});

describe("revoking sessions", () => {
  async function expectRevoked(token: string, userId: string) {
    expect((await mcpInitialize(token)).status).toBe(401);
    expect((await oauthApi(ORIGIN).listUserGrants(userId)).items).toEqual([]);
  }

  it("revokes MCP grants with POST /api/v1/users/:id/revoke-sessions", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    await expectMcpOk(await mcpInitialize(access_token));
    const res = await send(`/api/v1/users/${member.id}/revoke-sessions`, { method: "POST", cookies: adminCookies });
    expect(res.status).toBe(204);
    await expectRevoked(access_token, member.id);
  });

  it("revokes MCP grants when an admin resets the password", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    const res = await send(`/api/v1/users/${member.id}/password`, {
      cookies: adminCookies,
      json: { password: "a brand new password" },
    });
    expect(res.status).toBe(204);
    await expectRevoked(access_token, member.id);
  });

  it("revokes MCP grants when the user changes the password", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    const res = await send("/api/v1/me/password", {
      cookies: memberCookies,
      json: { current_password: PASSWORD, new_password: "a brand new password" },
    });
    expect(res.status).toBe(204);
    await expectRevoked(access_token, member.id);
  });

  it("revokes MCP grants when an admin deletes the user", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    expect((await oauthApi(ORIGIN).listUserGrants(member.id)).items).toHaveLength(1);
    const res = await send(`/api/v1/users/${member.id}`, { method: "DELETE", cookies: adminCookies });
    expect(res.status).toBe(204);
    await expectRevoked(access_token, member.id);
  });

  it("keeps MCP grants when the web session logs out", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    expect((await send("/auth/logout", { method: "POST", cookies: memberCookies })).status).toBe(200);
    await expectMcpOk(await mcpInitialize(access_token));
  });
});

describe("grant lifetime", () => {
  it("is 30 days in password mode", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await authorizeClient(memberCookies);
    const after = Math.floor(Date.now() / 1000);
    expect(token.refresh_token).toBeDefined();
    const { items } = await oauthApi(ORIGIN).listUserGrants(member.id);
    expect(items).toHaveLength(1);
    const expiresAt = items[0]?.expiresAt ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 2_592_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 2_592_000);
  });

  it("is 24 hours in oidc mode", async () => {
    const cookies = await oidcSessionCookies(member);
    const before = Math.floor(Date.now() / 1000);
    await authorizeClient(cookies, { origin: OIDC_ORIGIN, env: oidcEnv });
    const after = Math.floor(Date.now() / 1000);
    const { items } = await oauthApi(OIDC_ORIGIN, oidcEnv).listUserGrants(member.id);
    expect(items).toHaveLength(1);
    const expiresAt = items[0]?.expiresAt ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 86_400);
    expect(expiresAt).toBeLessThanOrEqual(after + 86_400);
  });
});

describe("origins and configuration", () => {
  it("returns 401 for a token issued in another AUTH_MODE", async () => {
    // Password mode on the host that later becomes APP_ORIGIN.
    const { access_token } = await authorizeClient(memberCookies, { origin: OIDC_ORIGIN });
    await expectMcpOk(await mcpInitialize(access_token, { origin: OIDC_ORIGIN }));
    const res = await mcpInitialize(access_token, { origin: OIDC_ORIGIN, env: oidcEnv });
    expect(res.status).toBe(401);
  });

  it("returns 404 for OAuth paths on hosts other than APP_ORIGIN in oidc mode", async () => {
    for (const path of ["/mcp", "/authorize", "/oauth/token", "/.well-known/oauth-authorization-server"]) {
      const res = await send(`https://other.example.com${path}`, { env: oidcEnv });
      expect(res.status).toBe(404);
    }
    const metadata = await send(`${OIDC_ORIGIN}/.well-known/oauth-authorization-server`, { env: oidcEnv });
    expect(metadata.status).toBe(200);
    // Pages still go through unifyHost.
    const page = await send("https://other.example.com/auth/setup", { env: oidcEnv });
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe(`${OIDC_ORIGIN}/auth/setup`);
  });

  it("serves pages but not OAuth on a plain http host that is not loopback", async () => {
    const me = await send("http://wiki.example.com/api/v1/me", { cookies: memberCookies });
    expect(me.status).toBe(200);
    expect(await me.text()).toContain(member.email);
    expect((await send("http://wiki.example.com/mcp", { json: {} })).status).toBe(404);
    expect((await send("http://wiki.example.com/authorize")).status).toBe(404);
  });

  it("serves OAuth on loopback http", async () => {
    const res = await send("http://localhost:8787/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resource: string }).resource).toBe("http://localhost:8787/mcp");
  });

  it("returns 500 for every path when the configuration is invalid", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const path of ["/mcp", "/.well-known/oauth-authorization-server", "/oauth/token", "/authorize"]) {
      const res = await send(path, { env: { JWT_SECRET: "short" } });
      expect(res.status).toBe(500);
    }
    expect(errorLog).toHaveBeenCalledWith("invalid configuration", { invalid: ["JWT_SECRET"] });
  });

  it("uses the helpers of the request's origin when the env object is reused", async () => {
    const shared: Cloudflare.Env = { ...env };
    const other = "https://second.pinglune.test";
    const first = await authorizeClient(memberCookies, { sharedEnv: shared });
    const second = await authorizeClient(memberCookies, { origin: other, sharedEnv: shared });
    expect(first.resource).toBe(`${ORIGIN}/mcp`);
    expect(second.resource).toBe(`${other}/mcp`);
    expect(shared.OAUTH_PROVIDER).toBeUndefined();
    await expectMcpOk(await mcpInitialize(second.access_token, { origin: other, sharedEnv: shared }));
    // Tokens are bound to their origin's resource.
    expect((await mcpInitialize(first.access_token, { origin: other, sharedEnv: shared })).status).toBe(401);
  });
});

describe("bots and MCP connections", () => {
  type ConnectionRecord = {
    id: string;
    bot_id: string | null;
    grant_id: string | null;
    oauth_client_id: string;
    client_name: string;
    redirect_uri: string;
    revoked_at: number | null;
    revoke_reason: string | null;
  };

  async function createBot(name: string, cookies: Cookies = memberCookies): Promise<string> {
    const res = await send("/api/v1/bots", { cookies, json: { name, delivery_kind: "mcp" } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function connectionsOf(userId: string): Promise<ConnectionRecord[]> {
    const { results } = await env.DB.prepare("SELECT * FROM mcp_connections WHERE user_id = ? ORDER BY id")
      .bind(userId)
      .all<ConnectionRecord>();
    return results;
  }

  async function subscriptionOf(id: string) {
    return env.DB.prepare("SELECT connection_id, unsubscribed_at FROM subscriptions WHERE id = ?")
      .bind(id)
      .first<{ connection_id: string | null; unsubscribed_at: number | null }>();
  }

  // A subscription made by a connection.
  async function subscriptionOfConnection(connectionId: string, callbackUrl: string): Promise<string> {
    const subscription = await createSubscription({ user: member, callbackUrl });
    await env.DB.prepare("UPDATE subscriptions SET connection_id = ? WHERE id = ?").bind(connectionId, subscription.id).run();
    return subscription.id;
  }

  async function callTool(token: string, name: string, args: Record<string, unknown>) {
    const res = await mcpRequest(token, "tools/call", { name, arguments: args });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    return JSON.parse(body.result.content[0]?.text ?? "") as Record<string, unknown>;
  }

  // A grant made before connections were recorded: no connectionId in its metadata or props.
  async function legacyToken(clientId: string, origin = ORIGIN): Promise<TokenResponse> {
    const api = oauthApi(origin);
    const { verifier, challenge } = await pkce();
    const request = await api.parseAuthRequest(new Request(authorizeUrl(origin, clientId, challenge)));
    const { redirectTo } = await api.completeAuthorization({
      request,
      userId: member.id,
      metadata: {},
      scope: ["mcp"],
      props: { userId: member.id, authMode: "password" },
    });
    const code = new URL(redirectTo).searchParams.get("code") ?? "";
    const res = await send(`${origin}/oauth/token`, {
      form: { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as TokenResponse;
  }

  it("records the connection of the chosen bot, and its token carries the connection", async () => {
    const bot = await createBot("Dot");
    const token = await authorizeClient(memberCookies, { botId: bot });
    await expectMcpOk(await mcpInitialize(token.access_token));
    const rows = await connectionsOf(member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bot_id: bot,
      grant_id: null,
      client_name: "Test client",
      redirect_uri: REDIRECT_URI,
      revoked_at: null,
    });
    const { items } = await oauthApi(ORIGIN).listUserGrants(member.id);
    expect(items.map((grant) => grant.metadata)).toEqual([{ connectionId: rows[0]?.id }]);
  });

  it("replaces the connection of the same bot, and moves the subscriptions of the same app to the new one", async () => {
    const bot = await createBot("Dot");
    const clientId = await registerClient();
    const first = await authorizeClient(memberCookies, { clientId, botId: bot });
    const old = (await connectionsOf(member.id))[0]?.id ?? "";
    const subscription = await subscriptionOfConnection(old, "https://hooks.example.com/old");

    const second = await authorizeClient(memberCookies, { clientId, botId: bot });
    expect((await mcpInitialize(first.access_token)).status).toBe(401);
    await expectMcpOk(await mcpInitialize(second.access_token));
    const rows = await connectionsOf(member.id);
    const fresh = rows.find((row) => row.id !== old);
    expect(rows.find((row) => row.id === old)).toMatchObject({ revoked_at: expect.any(Number), revoke_reason: "replaced" });
    expect(fresh).toMatchObject({ bot_id: bot, revoked_at: null });
    // Not ended: it moves to the new connection.
    expect(await subscriptionOf(subscription)).toEqual({ connection_id: fresh?.id, unsubscribed_at: null });
    expect((await oauthApi(ORIGIN).listUserGrants(member.id)).items).toHaveLength(1);
  });

  it("keeps the subscriptions of another app with their connection when the connection of the bot is replaced", async () => {
    const bot = await createBot("Dot");
    const first = await authorizeClient(memberCookies, { botId: bot, clientName: "Cursor" });
    const old = (await connectionsOf(member.id))[0]?.id ?? "";
    const subscription = await subscriptionOfConnection(old, "https://hooks.example.com/cursor");
    await authorizeClient(memberCookies, { botId: bot, clientName: "Grok" });
    expect((await mcpInitialize(first.access_token)).status).toBe(401);
    expect(await subscriptionOf(subscription)).toEqual({ connection_id: old, unsubscribed_at: null });
  });

  it("keeps both connections of one app used as two bots", async () => {
    const dot = await createBot("Dot");
    const dot2 = await createBot("Dot2");
    const clientId = await registerClient();
    const first = await authorizeClient(memberCookies, { clientId, botId: dot });
    const second = await authorizeClient(memberCookies, { clientId, botId: dot2 });
    await expectMcpOk(await mcpInitialize(first.access_token));
    await expectMcpOk(await mcpInitialize(second.access_token));
    expect((await connectionsOf(member.id)).map((row) => [row.bot_id, row.revoked_at])).toEqual(
      expect.arrayContaining([
        [dot, null],
        [dot2, null],
      ]),
    );
    expect((await oauthApi(ORIGIN).listUserGrants(member.id)).items).toHaveLength(2);
  });

  it("replaces the connection of the same app that is not assigned to a bot", async () => {
    const clientId = await registerClient();
    const first = await authorizeClient(memberCookies, { clientId });
    const second = await authorizeClient(memberCookies, { clientId });
    expect((await mcpInitialize(first.access_token)).status).toBe(401);
    await expectMcpOk(await mcpInitialize(second.access_token));
    expect((await connectionsOf(member.id)).map((row) => row.revoke_reason).sort()).toEqual([null, "replaced"].sort());
  });

  it("rejects a bot that is missing or of another user, and keeps the handle usable", async () => {
    const theirs = await createBot("Admin bot", adminCookies);
    const consent = await openConsent(memberCookies);
    for (const botId of [theirs, "bot_x", "bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V"]) {
      const res = await send("/authorize", {
        cookies: consent.cookies,
        form: { handle: consent.handle, decision: "approve", bot_id: botId },
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("選んだ Bot が見つかりません");
    }
    const approved = await send("/authorize", {
      cookies: consent.cookies,
      form: { handle: consent.handle, decision: "approve", bot_id: "" },
    });
    expect(approved.status).toBe(302);
    expect(await connectionsOf(member.id)).toHaveLength(1);
  });

  it("asks which bot to connect as, preselecting the bot of the same app when there is one", async () => {
    const noBots = await openConsent(memberCookies);
    expect(noBots.html).not.toContain("<select");
    expect(noBots.html).toContain('name="bot_id" value=""');

    const dot = await createBot("Dot");
    const clientId = await registerClient();
    // Another user's connection of the same client is not a candidate.
    await authorizeClient(adminCookies, { clientId, botId: await createBot("Admin bot", adminCookies) });
    const before = await openConsent(memberCookies, { clientId });
    expect(before.html).toMatch(/<option value="" selected/);
    expect(before.html).not.toMatch(new RegExp(`value="${dot}" selected`));

    await authorizeClient(memberCookies, { clientId, botId: dot });
    const one = await openConsent(memberCookies, { clientId });
    expect(one.html).toMatch(new RegExp(`value="${dot}" selected`));
    expect(one.html).toContain("Bot を選ぶと、この接続がその Bot として会話に参加します");

    const dot2 = await createBot("Dot2");
    await authorizeClient(memberCookies, { clientId, botId: dot2 });
    const two = await openConsent(memberCookies, { clientId });
    expect(two.html).toMatch(/<option value="" selected/);
    expect(two.html).toContain("このアプリは複数の Bot（Dot、Dot2）で使われています");
  });

  it("serves a legacy connection, speaks as a bot once it is assigned, and rejects it once disconnected", async () => {
    const clientId = await registerClient();
    const legacy = await legacyToken(clientId);
    await expectMcpOk(await mcpInitialize(legacy.access_token));
    expect(await connectionsOf(member.id)).toEqual([]);

    const bot = await createBot("Dot");
    const listed = await send("/api/v1/mcp-connections", { cookies: memberCookies });
    const grantId = ((await listed.json()) as { connections: { kind: string; grant_id: string | null }[] }).connections.find(
      (c) => c.kind === "legacy",
    )?.grant_id;
    const assigned = await send("/api/v1/mcp-connections/assign", {
      cookies: memberCookies,
      json: { grant_id: grantId, bot_id: bot },
    });
    expect(assigned.status).toBe(200);
    const created = await send("/api/v1/conversations", {
      cookies: memberCookies,
      json: { title: "相談", participants: [{ bot_id: bot }], message: "こんにちは", idempotency_key: "k1" },
    });
    expect(created.status).toBe(201);
    const conversationId = ((await created.json()) as { id: string }).id;
    // Found through the grant of the token (unwrapToken).
    const read = await callTool(legacy.access_token, "get_conversation", { conversation_id: conversationId });
    expect(read.participants).toEqual([{ name: "Dot", is_you: true }]);
    expect(read.you).toEqual({ bot_name: "Dot" });

    const [row] = await connectionsOf(member.id);
    const revoked = await send("/api/v1/mcp-connections/revoke", { cookies: memberCookies, json: { connection_id: row?.id } });
    expect(revoked.status).toBe(204);
    expect((await mcpInitialize(legacy.access_token)).status).toBe(401);
  });

  it("replaces the legacy grants of the same client for this origin only", async () => {
    const clientId = await registerClient();
    const here = await legacyToken(clientId);
    const other = "https://second.pinglune.test";
    const there = await legacyToken(clientId, other);
    await authorizeClient(memberCookies, { clientId });
    expect((await mcpInitialize(here.access_token)).status).toBe(401);
    await expectMcpOk(await mcpInitialize(there.access_token, { origin: other }));
  });

  it("marks the connections revoked when the user changes the password", async () => {
    await authorizeClient(memberCookies, { botId: await createBot("Dot") });
    const res = await send("/api/v1/me/password", {
      cookies: memberCookies,
      json: { current_password: PASSWORD, new_password: "a brand new password" },
    });
    expect(res.status).toBe(204);
    expect((await connectionsOf(member.id)).map((row) => row.revoke_reason)).toEqual(["sessions_revoked"]);
  });
});
