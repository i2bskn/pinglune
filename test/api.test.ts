import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { core } from "../src/core";
import type { UserRow } from "../src/db/schema";
import { env } from "cloudflare:workers";
import {
  appDb,
  countPersonalWorkspaces,
  countWorkspaces,
  createUser,
  login,
  OIDC_ORIGIN,
  oidcEnv,
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
});

describe("middleware order", () => {
  async function oidcCookiesFor(user: UserRow): Promise<SessionCookies> {
    const now = Date.now();
    const session = await core.issueSession(appDb, user.id, "oidc", now);
    const at = await core.signAccessToken({ sub: user.id, sid: session.sessionId }, env.JWT_SECRET ?? "", now);
    return { "__Host-pinglune_at": at, "__Host-pinglune_rt": session.refreshToken };
  }

  it("returns 404 before 403 for a member calling a password-only admin API in oidc mode", async () => {
    const cookies = await oidcCookiesFor(member);
    const res = await send(`${OIDC_ORIGIN}/api/v1/users`, {
      env: oidcEnv,
      cookies,
      json: { email: "x@example.com", password: NEW_PASSWORD, role: "member" },
    });
    expect(res.status).toBe(404);
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
