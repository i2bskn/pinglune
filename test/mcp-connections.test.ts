import type { GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConnection, McpConnectionList } from "../src/api/types";
import { clock } from "../src/clock";
import type { UserRow } from "../src/db/schema";
import { newBotId, newMcpConnectionId } from "../src/ids";
import { MCP_CONNECTION_LISTING_GRACE_MS } from "../src/mcp/connections";
import {
  createSubscription,
  createUser,
  login,
  personalWorkspaceOf,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

const MINUTE = 60_000;
const REDIRECT = "https://chatgpt.com/connector/cb";

let alice: UserRow;
let bob: UserRow;
let aliceCookies: SessionCookies;
let now: number;
let grants: GrantSummary[];
let revokedGrants: string[];

// An OAUTH_PROVIDER over the grants array, in pages of two.
function fakeOAuth(): OAuthHelpers {
  const oauth = {
    async listUserGrants(userId: string, options?: { cursor?: string }) {
      const mine = grants.filter((grant) => grant.userId === userId);
      const start = options?.cursor === undefined ? 0 : Number(options.cursor);
      const items = mine.slice(start, start + 2);
      return start + 2 < mine.length ? { items, cursor: String(start + 2) } : { items };
    },
    async revokeGrant(grantId: string, userId: string) {
      revokedGrants.push(grantId);
      grants = grants.filter((grant) => !(grant.id === grantId && grant.userId === userId));
    },
    async lookupClient(clientId: string) {
      return { clientId, clientName: clientId === "client-chatgpt" ? "ChatGPT" : "Grok", redirectUris: [] };
    },
  };
  return oauth as unknown as OAuthHelpers;
}

function grant(params: {
  id: string;
  user?: UserRow;
  clientId?: string;
  connectionId?: string;
  createdAt?: number;
}): GrantSummary {
  const summary: GrantSummary = {
    id: params.id,
    clientId: params.clientId ?? "client-chatgpt",
    userId: (params.user ?? alice).id,
    scope: ["mcp"],
    metadata: params.connectionId === undefined ? {} : { connectionId: params.connectionId },
    createdAt: Math.floor((params.createdAt ?? now) / 1000),
    redirectUri: REDIRECT,
  };
  grants.push(summary);
  return summary;
}

async function insertBot(user: UserRow, name: string, kind: "mcp" | "webhook" = "mcp"): Promise<string> {
  const id = newBotId(now);
  let destination: string | null = null;
  if (kind === "webhook") {
    destination = (await createSubscription({ user, kind: "webhook", name, expiresAt: 253402300799999 })).id;
  }
  await env.DB.prepare(
    `INSERT INTO bots (id, workspace_id, created_by_user_id, name, delivery_kind, delivery_subscription_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, (await personalWorkspaceOf(user)).id, user.id, name, kind, destination, now, now)
    .run();
  return id;
}

async function insertConnection(params: {
  user?: UserRow;
  botId?: string | null;
  grantId?: string | null;
  clientId?: string;
  createdAt?: number;
  revoked?: boolean;
}): Promise<string> {
  const user = params.user ?? alice;
  const id = newMcpConnectionId(now);
  const createdAt = params.createdAt ?? now;
  await env.DB.prepare(
    `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name, redirect_uri,
      created_at, updated_at, revoked_at, revoke_reason)
    VALUES (?, ?, ?, ?, ?, ?, 'Recorded name', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      (await personalWorkspaceOf(user)).id,
      params.botId ?? null,
      params.grantId ?? null,
      params.clientId ?? "client-chatgpt",
      REDIRECT,
      createdAt,
      createdAt,
      params.revoked ? now : null,
      params.revoked ? "user" : null,
    )
    .run();
  return id;
}

async function connectionRow(id: string) {
  return env.DB.prepare("SELECT bot_id, grant_id, redirect_uri, revoked_at, revoke_reason FROM mcp_connections WHERE id = ?")
    .bind(id)
    .first<{
      bot_id: string | null;
      grant_id: string | null;
      redirect_uri: string;
      revoked_at: number | null;
      revoke_reason: string | null;
    }>();
}

async function subscriptionRow(id: string) {
  return env.DB.prepare("SELECT connection_id, unsubscribed_at, updated_at FROM subscriptions WHERE id = ?")
    .bind(id)
    .first<{ connection_id: string | null; unsubscribed_at: number | null; updated_at: number }>();
}

// An active MCP Events subscription of alice made by a connection (or a legacy one: null).
async function subscriptionOf(connectionId: string | null, updatedAt = now): Promise<string> {
  const row = await createSubscription({ user: alice, callbackUrl: `https://hooks.example.com/${crypto.randomUUID()}` });
  await env.DB.prepare("UPDATE subscriptions SET connection_id = ?, updated_at = ? WHERE id = ?")
    .bind(connectionId, updatedAt, row.id)
    .run();
  return row.id;
}

function listConnections(cookies = aliceCookies) {
  return send("/api/v1/mcp-connections", { cookies, env: { OAUTH_PROVIDER: fakeOAuth() } });
}

async function connections(): Promise<McpConnection[]> {
  const res = await listConnections();
  expect(res.status).toBe(200);
  return ((await res.json()) as McpConnectionList).connections;
}

function assign(body: unknown, cookies = aliceCookies) {
  return send("/api/v1/mcp-connections/assign", { cookies, json: body, env: { OAUTH_PROVIDER: fakeOAuth() } });
}

function revoke(body: unknown, cookies = aliceCookies) {
  return send("/api/v1/mcp-connections/revoke", { cookies, json: body, env: { OAUTH_PROVIDER: fakeOAuth() } });
}

async function expectApiError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
}

beforeEach(async () => {
  await resetDb();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  grants = [];
  revokedGrants = [];
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  aliceCookies = await login(alice.email);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

describe("GET /api/v1/mcp-connections", () => {
  it("matches the grants with the connections", async () => {
    const dot = await insertBot(alice, "Dot");
    const deleted = await insertBot(alice, "Old");
    await env.DB.prepare("UPDATE bots SET deleted_at = ? WHERE id = ?").bind(now, deleted).run();
    const active = await insertConnection({ botId: dot, createdAt: now - 10 * MINUTE });
    grant({ id: "g-active", connectionId: active, createdAt: now - 10 * MINUTE });
    grant({ id: "g-legacy", clientId: "client-grok", createdAt: now - 60 * MINUTE });
    const imported = await insertConnection({ grantId: "g-imported", botId: deleted, createdAt: now - 20 * MINUTE });
    grant({ id: "g-imported", createdAt: now - 90 * MINUTE });
    const expired = await insertConnection({ createdAt: now - MCP_CONNECTION_LISTING_GRACE_MS - 1 });
    const recent = await insertConnection({ createdAt: now - MINUTE });
    const revoked = await insertConnection({ revoked: true, createdAt: now - 30 * MINUTE });
    grant({ id: "g-revoked", connectionId: revoked, createdAt: now - 30 * MINUTE });
    grant({ id: "g-orphan", connectionId: newMcpConnectionId(now), createdAt: now - 40 * MINUTE });
    grant({ id: "g-bob", user: bob });

    const list = await connections();
    const second = (ms: number) => Math.floor(ms / 1000) * 1000;
    expect(list).toEqual([
      { kind: "active", id: recent, grant_id: null, client_name: "Recorded name", redirect_host: "chatgpt.com", bot: null, created_at: now - MINUTE },
      {
        kind: "expired",
        id: expired,
        grant_id: null,
        client_name: "Recorded name",
        redirect_host: "chatgpt.com",
        bot: null,
        created_at: now - MCP_CONNECTION_LISTING_GRACE_MS - 1,
      },
      {
        kind: "active",
        id: active,
        grant_id: null,
        client_name: "Recorded name",
        redirect_host: "chatgpt.com",
        bot: { id: dot, name: "Dot" },
        created_at: now - 10 * MINUTE,
      },
      { kind: "active", id: imported, grant_id: null, client_name: "Recorded name", redirect_host: "chatgpt.com", bot: null, created_at: now - 20 * MINUTE },
      {
        kind: "stale",
        id: null,
        grant_id: "g-revoked",
        client_name: "Recorded name",
        redirect_host: "chatgpt.com",
        bot: null,
        created_at: second(now - 30 * MINUTE),
      },
      { kind: "stale", id: null, grant_id: "g-orphan", client_name: "ChatGPT", redirect_host: "chatgpt.com", bot: null, created_at: second(now - 40 * MINUTE) },
      { kind: "legacy", id: null, grant_id: "g-legacy", client_name: "Grok", redirect_host: "chatgpt.com", bot: null, created_at: second(now - 60 * MINUTE) },
    ]);
  });

  it("answers 503 without OAUTH_PROVIDER", async () => {
    await expectApiError(
      await send("http://pinglune.internal.example/api/v1/mcp-connections", { cookies: aliceCookies }),
      503,
      "temporarily_unavailable",
    );
  });
});

describe("POST /api/v1/mcp-connections/assign", () => {
  it("assigns a connection to a bot and removes the assignment", async () => {
    const dot = await insertBot(alice, "Dot");
    const id = await insertConnection({});
    grant({ id: "g1", connectionId: id });
    const res = await assign({ connection_id: id, bot_id: dot });
    expect(res.status).toBe(200);
    expect((await res.json()) as McpConnection).toMatchObject({ kind: "active", id, bot: { id: dot, name: "Dot" } });
    expect((await connectionRow(id))?.bot_id).toBe(dot);
    const removed = await assign({ connection_id: id, bot_id: null });
    expect(((await removed.json()) as McpConnection).bot).toBeNull();
    expect((await connectionRow(id))?.bot_id).toBeNull();
    expect(revokedGrants).toEqual([]);
  });

  it("replaces the other connection of the bot, moving the subscriptions of the same app only", async () => {
    const dot = await insertBot(alice, "Dot");
    const old = await insertConnection({ botId: dot });
    grant({ id: "g-old", connectionId: old });
    const sameApp = await subscriptionOf(old, now - MINUTE);
    const fresh = await insertConnection({});
    grant({ id: "g-new", connectionId: fresh });

    expect((await assign({ connection_id: fresh, bot_id: dot })).status).toBe(200);
    expect(await connectionRow(old)).toMatchObject({ revoke_reason: "replaced", revoked_at: now });
    expect((await connectionRow(fresh))?.bot_id).toBe(dot);
    expect(await subscriptionRow(sameApp)).toEqual({ connection_id: fresh, unsubscribed_at: null, updated_at: now - MINUTE });
    expect(revokedGrants).toEqual(["g-old"]);

    // A connection of another app replaced: its subscription stays with it.
    const grok = await insertConnection({ clientId: "client-grok" });
    grant({ id: "g-grok", clientId: "client-grok", connectionId: grok });
    const other = await subscriptionOf(fresh);
    expect((await assign({ connection_id: grok, bot_id: dot })).status).toBe(200);
    expect(await subscriptionRow(other)).toMatchObject({ connection_id: fresh, unsubscribed_at: null });
  });

  it("takes in a legacy grant, and claims the only subscription without a connection made after it", async () => {
    const dot = await insertBot(alice, "Dot");
    grant({ id: "g-legacy", createdAt: now - 60 * MINUTE });
    const subscription = await subscriptionOf(null, now - 10 * MINUTE);
    const res = await assign({ grant_id: "g-legacy", bot_id: dot });
    expect(res.status).toBe(200);
    const body = (await res.json()) as McpConnection;
    expect(body).toMatchObject({ kind: "active", grant_id: null, client_name: "ChatGPT", bot: { id: dot, name: "Dot" } });
    expect(await connectionRow(body.id ?? "")).toMatchObject({ grant_id: "g-legacy", redirect_uri: REDIRECT, bot_id: dot });
    expect((await subscriptionRow(subscription))?.connection_id).toBe(body.id);
    // Taken in already: by its connection only.
    await expectApiError(await assign({ grant_id: "g-legacy", bot_id: null }), 400, "invalid_request");
  });

  it("does not claim a subscription when there are two legacy grants, or when it is older than the grant", async () => {
    const dot = await insertBot(alice, "Dot");
    grant({ id: "g-1", createdAt: now - 60 * MINUTE });
    grant({ id: "g-2", createdAt: now - 60 * MINUTE });
    const subscription = await subscriptionOf(null, now - 10 * MINUTE);
    expect((await assign({ grant_id: "g-1", bot_id: dot })).status).toBe(200);
    expect((await subscriptionRow(subscription))?.connection_id).toBeNull();

    const dot2 = await insertBot(alice, "Dot2");
    grant({ id: "g-3", createdAt: now });
    // g-2 and g-3 are legacy now; after g-2 is revoked, g-3 is the only one, but the subscription is older.
    await revoke({ grant_id: "g-2" });
    expect((await assign({ grant_id: "g-3", bot_id: dot2 })).status).toBe(200);
    expect((await subscriptionRow(subscription))?.connection_id).toBeNull();
  });

  it("does not claim a subscription for a bot that is not mcp", async () => {
    const grok = await insertBot(alice, "Grok", "webhook");
    grant({ id: "g-legacy", createdAt: now - 60 * MINUTE });
    const subscription = await subscriptionOf(null, now);
    expect((await assign({ grant_id: "g-legacy", bot_id: grok })).status).toBe(200);
    expect((await subscriptionRow(subscription))?.connection_id).toBeNull();
  });

  it("rejects expired and stale connections, but not one made within the grace", async () => {
    const dot = await insertBot(alice, "Dot");
    const expired = await insertConnection({ createdAt: now - MCP_CONNECTION_LISTING_GRACE_MS - 1 });
    await expectApiError(await assign({ connection_id: expired, bot_id: dot }), 400, "connection_expired");
    const revoked = await insertConnection({ revoked: true });
    grant({ id: "g-revoked", connectionId: revoked });
    await expectApiError(await assign({ grant_id: "g-revoked", bot_id: dot }), 400, "connection_stale");
    grant({ id: "g-orphan", connectionId: newMcpConnectionId(now) });
    await expectApiError(await assign({ grant_id: "g-orphan", bot_id: dot }), 400, "connection_stale");
    const recent = await insertConnection({ createdAt: now - MINUTE });
    expect((await assign({ connection_id: recent, bot_id: dot })).status).toBe(200);
  });

  it("answers connections, grants and bots of another user as not found, and changes nothing", async () => {
    const mine = await insertBot(alice, "Dot");
    const theirs = await insertBot(bob, "Bob's");
    const bobConnection = await insertConnection({ user: bob, botId: theirs });
    grant({ id: "g-bob", user: bob, connectionId: bobConnection });
    grant({ id: "g-bob-legacy", user: bob });
    const own = await insertConnection({});
    grant({ id: "g-own", connectionId: own });
    await expectApiError(await assign({ connection_id: bobConnection, bot_id: mine }), 404, "not_found");
    await expectApiError(await assign({ grant_id: "g-bob-legacy", bot_id: mine }), 404, "not_found");
    await expectApiError(await assign({ connection_id: own, bot_id: theirs }), 404, "not_found");
    expect(await connectionRow(bobConnection)).toMatchObject({ bot_id: theirs, revoked_at: null });
    expect((await connectionRow(own))?.bot_id).toBeNull();
    expect(revokedGrants).toEqual([]);
  });

  it("rejects a body without exactly one target", async () => {
    const dot = await insertBot(alice, "Dot");
    await expectApiError(await assign({ bot_id: dot }), 400, "invalid_request");
    await expectApiError(await assign({ connection_id: newMcpConnectionId(now), grant_id: "g", bot_id: dot }), 400, "invalid_request");
    await expectApiError(await assign({ connection_id: newMcpConnectionId(now), bot_id: 1 }), 400, "invalid_request");
    await expectApiError(await assign({ connection_id: "mcn_x", bot_id: dot }), 404, "not_found");
  });
});

describe("POST /api/v1/mcp-connections/revoke", () => {
  it("disconnects a connection, ends its subscriptions and revokes its grant", async () => {
    const dot = await insertBot(alice, "Dot");
    const id = await insertConnection({ botId: dot });
    grant({ id: "g1", connectionId: id });
    const subscription = await subscriptionOf(id);
    const legacySubscription = await subscriptionOf(null);
    expect((await revoke({ connection_id: id })).status).toBe(204);
    expect(await connectionRow(id)).toMatchObject({ revoked_at: now, revoke_reason: "user" });
    expect((await subscriptionRow(subscription))?.unsubscribed_at).toBe(now);
    expect((await subscriptionRow(legacySubscription))?.unsubscribed_at).toBeNull();
    expect(revokedGrants).toEqual(["g1"]);
    // Again: nothing changes.
    expect((await revoke({ connection_id: id })).status).toBe(204);
    expect(revokedGrants).toEqual(["g1"]);
  });

  it("disconnects an expired connection without KV, and revokes a legacy or stale grant in KV only", async () => {
    const expired = await insertConnection({ createdAt: now - MCP_CONNECTION_LISTING_GRACE_MS - 1 });
    expect((await revoke({ connection_id: expired })).status).toBe(204);
    expect((await connectionRow(expired))?.revoke_reason).toBe("user");
    expect(revokedGrants).toEqual([]);

    grant({ id: "g-legacy" });
    const subscription = await subscriptionOf(null);
    expect((await revoke({ grant_id: "g-legacy" })).status).toBe(204);
    expect(revokedGrants).toEqual(["g-legacy"]);
    expect((await subscriptionRow(subscription))?.unsubscribed_at).toBeNull();
    grant({ id: "g-orphan", connectionId: newMcpConnectionId(now) });
    expect((await revoke({ grant_id: "g-orphan" })).status).toBe(204);
    expect(revokedGrants).toEqual(["g-legacy", "g-orphan"]);
  });

  it("answers what is missing or of another user as not found", async () => {
    const bobConnection = await insertConnection({ user: bob });
    grant({ id: "g-bob", user: bob });
    await expectApiError(await revoke({ connection_id: bobConnection }), 404, "not_found");
    await expectApiError(await revoke({ grant_id: "g-bob" }), 404, "not_found");
    await expectApiError(await revoke({ connection_id: newMcpConnectionId(now) }), 404, "not_found");
    expect((await connectionRow(bobConnection))?.revoked_at).toBeNull();
    expect(revokedGrants).toEqual([]);
  });

  it("asks for the connection of a grant that a connection took in", async () => {
    const id = await insertConnection({ grantId: "g-imported" });
    grant({ id: "g-imported" });
    await expectApiError(await revoke({ grant_id: "g-imported" }), 400, "invalid_request");
    expect((await connectionRow(id))?.revoked_at).toBeNull();
  });
});
