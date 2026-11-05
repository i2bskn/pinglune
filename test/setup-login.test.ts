import { beforeEach, describe, expect, it } from "vitest";
import {
  countPersonalWorkspaces,
  countWorkspaces,
  createUser,
  db,
  PASSWORD,
  resetDb,
  send,
  sessionCookies,
} from "./helpers";

// The initial setup and the login of @i2bskn/workers-app-core, as wired into pinglune: the personal workspace of the
// userCreatedStatements hook (src/core.ts) and the middleware of src/app.ts. The package tests cover the rest.

beforeEach(resetDb);

const setupForm = {
  email: "Admin@Example.com",
  name: "Admin",
  password: PASSWORD,
  password_confirm: PASSWORD,
};

describe("initial setup", () => {
  it("creates the first admin and signs in", async () => {
    expect((await send("/auth/setup")).status).toBe(200);
    const res = await send("/auth/setup", { form: setupForm });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    sessionCookies(res);

    const all = await db.query.users.findMany();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ email: "admin@example.com", name: "Admin", role: "admin" });
    expect(all[0]?.lastLoginAt).not.toBeNull();
    expect(await countPersonalWorkspaces(all[0]?.id ?? "")).toBe(1);
    expect(await countWorkspaces()).toBe(1);
  });

  it("creates only one admin for concurrent requests", async () => {
    const results = await Promise.all([
      send("/auth/setup", { form: setupForm }),
      send("/auth/setup", { form: { ...setupForm, email: "second@example.com" } }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(303);
    expect([404, 409]).toContain(statuses[1]);
    const admins = await db.query.users.findMany();
    expect(admins).toHaveLength(1);
    expect(admins[0]?.role).toBe("admin");
    expect(await countPersonalWorkspaces(admins[0]?.id ?? "")).toBe(1);
    expect(await countWorkspaces()).toBe(1);
  });

  it("creates the admin in one statement only when there are no users", async () => {
    expect((await send("/auth/setup", { form: setupForm })).status).toBe(303);
    const [created] = await db.query.users.findMany();
    expect(created).toMatchObject({ role: "admin" });
    expect(await countPersonalWorkspaces(created?.id ?? "")).toBe(1);
    expect((await send("/auth/setup", { form: { ...setupForm, email: "b@example.com" } })).status).toBe(404);
    expect(await countWorkspaces()).toBe(1);
  });
});

describe("password login", () => {
  beforeEach(async () => {
    await createUser({ email: "alice@example.com", role: "admin" });
  });

  it("sets security headers on pages and API", async () => {
    const page = await send("/auth/login");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const api = await send("/api/v1/me");
    expect(api.status).toBe(401);
    expect(api.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 500 for every request when the configuration is invalid", async () => {
    const res = await send("/auth/login", { env: { JWT_SECRET: "short" } });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("short");
    expect((await send("/api/v1/me", { env: { AUTH_MODE: "ldap" } })).status).toBe(500);
    expect((await send("/", { env: { AUTH_MODE: "oidc" } })).status).toBe(500);
  });
});

describe("home", () => {
  // The static assets serve / (the SPA) in front of the Worker, so the Worker has no route for it.
  it("returns 404 for / in the Worker", async () => {
    expect((await send("/")).status).toBe(404);
  });
});
