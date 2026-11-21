import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { core } from "../src/core";
import type { UserRow } from "../src/db/schema";
import { loadConfig } from "../src/env";
import { env } from "cloudflare:workers";
import {
  appDb,
  countPersonalWorkspaces,
  countWorkspaces,
  createUser,
  login,
  OIDC_ORIGIN,
  oidcEnv,
  ORIGIN,
  PASSWORD,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

const NEW_PASSWORD = "another long passphrase";

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: 1000 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: 2000 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The personal workspace of the userCreatedStatements hook (src/core.ts). The package tests cover the user API.
describe("admin user API", () => {
  it("POST /api/v1/users creates exactly one personal workspace", async () => {
    const res = await send("/api/v1/users", {
      cookies: adminCookies,
      json: { email: "new@example.com", password: NEW_PASSWORD, role: "member" },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await countPersonalWorkspaces(id)).toBe(1);
    expect(await countWorkspaces()).toBe(3);
  });

  it("returns 409 email_taken for duplicate emails", async () => {
    const res = await send("/api/v1/users", {
      cookies: adminCookies,
      json: { email: "MEMBER@example.com", password: NEW_PASSWORD, role: "member" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("email_taken");
    // The personal workspace is rolled back with the user in the same batch.
    expect(await countWorkspaces()).toBe(2);
  });

  it("POST /api/v1/users without a password invites the user, with a personal workspace", async () => {
    const res = await send("/api/v1/users", {
      cookies: adminCookies,
      json: { email: "invited@example.com", role: "member" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string; invitation: { url: string; expires_at: number } | null };
    expect(body.status).toBe("invited");
    expect(body.invitation?.url.startsWith(`${ORIGIN}/auth/invite?token=`)).toBe(true);
    expect(body.invitation?.expires_at).toBeGreaterThan(Date.now());
    expect(await countPersonalWorkspaces(body.id)).toBe(1);
    expect(await countWorkspaces()).toBe(3);
  });

  it("POST /api/v1/users/:id/invitation issues a new invitation link", async () => {
    const created = await send("/api/v1/users", {
      cookies: adminCookies,
      json: { email: "invited@example.com", role: "member" },
    });
    expect(created.status).toBe(201);
    const { id, invitation } = (await created.json()) as { id: string; invitation: { url: string } | null };

    const res = await send(`/api/v1/users/${id}/invitation`, { method: "POST", cookies: adminCookies });
    expect(res.status).toBe(200);
    const reissued = (await res.json()) as { url: string; expires_at: number };
    expect(reissued.url.startsWith(`${ORIGIN}/auth/invite?token=`)).toBe(true);
    expect(reissued.url).not.toBe(invitation?.url);
    expect(await countWorkspaces()).toBe(3);

    // A user with a password has no invitation to replace.
    const active = await send(`/api/v1/users/${member.id}/invitation`, { method: "POST", cookies: adminCookies });
    expect(active.status).toBe(409);
    expect(((await active.json()) as { error: { code: string } }).error.code).toBe("already_active");
  });
});

describe("middleware order", () => {
  async function oidcCookiesFor(user: UserRow): Promise<SessionCookies> {
    const now = Date.now();
    const loaded = loadConfig({ ...env, ...oidcEnv });
    if (!loaded.ok) throw new Error(`invalid oidc config: ${loaded.invalid.join(", ")}`);
    const session = await core.issueSession(appDb, user.id, loaded.config, now);
    const at = await core.signAccessToken({ sub: user.id, sid: session.sessionId }, env.JWT_SECRET ?? "", now);
    return { "__Host-pinglune_at": at, "__Host-pinglune_rt": session.refreshToken };
  }

  it("returns 404 before 403 for a member calling a password-only admin API in oidc mode", async () => {
    const cookies = await oidcCookiesFor(member);
    // Still for password mode only (POST /api/v1/users is open to oidc mode too).
    const res = await send(`${OIDC_ORIGIN}/api/v1/users/${admin.id}/password`, {
      env: oidcEnv,
      cookies,
      json: { password: NEW_PASSWORD },
    });
    expect(res.status).toBe(404);
    // An API of both modes answers the member 403.
    const list = await send(`${OIDC_ORIGIN}/api/v1/users`, { env: oidcEnv, cookies });
    expect(list.status).toBe(403);
  });

  it("returns 404 for password-only endpoints in oidc mode", async () => {
    const cookies = await oidcCookiesFor(admin);
    const me = await send(`${OIDC_ORIGIN}/api/v1/me`, { env: oidcEnv, cookies });
    expect(me.status).toBe(200);
    const change = await send(`${OIDC_ORIGIN}/api/v1/me/password`, {
      env: oidcEnv,
      cookies,
      json: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(change.status).toBe(404);
    expect((await send(`${OIDC_ORIGIN}/auth/setup`, { env: oidcEnv })).status).toBe(404);
    const loginRes = await send(`${OIDC_ORIGIN}/auth/login`, {
      env: oidcEnv,
      form: { email: admin.email, password: PASSWORD },
    });
    expect(loginRes.status).toBe(404);
  });

  it("returns 401 before 400 for invalid input without a session", async () => {
    expect((await send("/api/v1/users", { json: "not json" })).status).toBe(401);
  });
});

describe("sameOrigin", () => {
  it("rejects cross-origin POST with 403", async () => {
    const res = await send("/api/v1/me/password", {
      cookies: memberCookies,
      origin: "https://evil.example",
      json: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(res.status).toBe(403);
    expect((await send("/auth/logout", { method: "POST", cookies: memberCookies, origin: "https://evil.example" })).status).toBe(403);
    expect((await send("/auth/login", { origin: "null", form: { email: member.email, password: PASSWORD } })).status).toBe(403);
    // The session is untouched.
    expect((await send("/api/v1/me", { cookies: memberCookies })).status).toBe(200);
  });

  it("rejects POST without Origin and Sec-Fetch-Site", async () => {
    const res = await send("/auth/refresh", { method: "POST", cookies: memberCookies, origin: null });
    expect(res.status).toBe(403);
    const cross = await send("/auth/refresh", {
      method: "POST",
      cookies: memberCookies,
      origin: null,
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(cross.status).toBe(403);
  });

  it("accepts POST without Origin when Sec-Fetch-Site is same-origin", async () => {
    const res = await send("/auth/refresh", {
      method: "POST",
      cookies: memberCookies,
      origin: null,
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(204);
  });
});
