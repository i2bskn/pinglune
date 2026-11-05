import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode } from "@i2bskn/workers-app-core";
import { users } from "../src/db/schema";
import type { Bindings } from "../src/env";
import {
  countPersonalWorkspaces,
  countWorkspaces,
  createUser,
  db,
  OIDC_ORIGIN,
  oidcEnv,
  resetDb,
  send,
  sessionCookies,
  setCookies,
} from "./helpers";

// The OIDC login of @i2bskn/workers-app-core, as wired into pinglune: the personal workspace of the
// userCreatedStatements hook (src/core.ts) on the just-in-time creation, and the host of src/app.ts. The package tests
// cover the rest.

const ISSUER = oidcEnv.OIDC_ISSUER ?? "";
const CLIENT_ID = oidcEnv.OIDC_CLIENT_ID ?? "";
beforeEach(resetDb);

describe("OIDC flow with a mocked IdP", () => {
  const KID = "test-key";
  let keyPair: CryptoKeyPair;
  let signingKey: CryptoKey;
  let publicJwk: JsonWebKey;
  let idTokenClaims: Record<string, unknown>;
  let tokenRequests: { authorization: string | null; body: URLSearchParams }[];

  beforeAll(async () => {
    const generate = async () =>
      (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
    keyPair = await generate();
    publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  });

  async function signIdToken(claims: Record<string, unknown>): Promise<string> {
    const encode = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
    const input = `${encode({ alg: "RS256", kid: KID, typ: "JWT" })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(input));
    return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  beforeEach(() => {
    tokenRequests = [];
    signingKey = keyPair.privateKey;
    idTokenClaims = { email: "alice@example.com", email_verified: true, name: "Alice" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        });
      }
      if (url.href === `${ISSUER}/jwks`) {
        return json({ keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] });
      }
      if (url.href === `${ISSUER}/token`) {
        const body = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
        tokenRequests.push({ authorization: request.headers.get("Authorization"), body });
        const now = Math.floor(Date.now() / 1000);
        const idToken = await signIdToken({
          iss: ISSUER,
          sub: "sub-1",
          aud: CLIENT_ID,
          iat: now,
          exp: now + 300,
          nonce: pendingNonce,
          ...idTokenClaims,
        });
        return json({ access_token: "access", token_type: "Bearer", expires_in: 300, id_token: idToken });
      }
      return new Response("not found", { status: 404 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  let pendingNonce = "";

  async function startLogin(next = "/wiki", env: Partial<Bindings> = oidcEnv) {
    const res = await send(`${OIDC_ORIGIN}/auth/login?next=${encodeURIComponent(next)}`, { env });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    pendingNonce = location.searchParams.get("nonce") ?? "";
    const oidcCookie = setCookies(res)["__Host-pinglune_oidc"];
    expect(oidcCookie?.maxAge).toBe(600);
    return { location, oidcCookie: oidcCookie?.value ?? "" };
  }

  function callback(query: string, oidcCookie?: string, env: Partial<Bindings> = oidcEnv) {
    return send(`${OIDC_ORIGIN}/auth/oidc/callback?${query}`, {
      env,
      cookies: oidcCookie ? { "__Host-pinglune_oidc": oidcCookie } : undefined,
    });
  }

  it("redirects to the IdP with PKCE and signs the user in on callback", async () => {
    const { location, oidcCookie } = await startLogin();
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(location.searchParams.get("redirect_uri")).toBe(`${OIDC_ORIGIN}/auth/oidc/callback`);
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);

    const state = location.searchParams.get("state") ?? "";
    const res = await callback(`code=abc&state=${state}`, oidcCookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/wiki");
    expect(setCookies(res)["__Host-pinglune_oidc"]?.maxAge).toBe(0);
    const cookies = sessionCookies(res);
    expect(setCookies(res)["__Host-pinglune_rt"]?.maxAge).toBe(24 * 60 * 60);

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.authorization).toMatch(/^Basic /);
    expect(tokenRequests[0]?.body.get("code")).toBe("abc");
    expect(tokenRequests[0]?.body.get("redirect_uri")).toBe(`${OIDC_ORIGIN}/auth/oidc/callback`);
    expect(tokenRequests[0]?.body.get("code_verifier")).toBeTruthy();

    const me = await send(`${OIDC_ORIGIN}/api/v1/me`, { env: oidcEnv, cookies });
    expect(await me.json()).toMatchObject({ email: "alice@example.com", name: "Alice", role: "admin" });
    const user = await db.query.users.findFirst({ where: eq(users.oidcSubject, "sub-1") });
    expect(await countPersonalWorkspaces(user?.id ?? "")).toBe(1);
    expect(await countWorkspaces()).toBe(1);
  });

  async function loginWith(env: Partial<Bindings>) {
    const { location, oidcCookie } = await startLogin("/wiki", env);
    return callback(`code=abc&state=${location.searchParams.get("state")}`, oidcCookie, env);
  }

  it("returns 403 and creates nothing when ALLOWED_EMAILS is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await loginWith({ ...oidcEnv, ALLOWED_EMAILS: "" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("このアカウントではログインできません");
    expect(await db.query.users.findMany()).toHaveLength(0);
    expect(await countWorkspaces()).toBe(0);
    expect(warn).toHaveBeenCalledWith("oidc login rejected", { reason: "allowlist_empty" });
  });

  it.each([["*"], ["*,example.com"]])("signs in any email with ALLOWED_EMAILS=%j", async (allowedEmails) => {
    idTokenClaims = { ...idTokenClaims, email: "alice@outside.test" };
    const res = await loginWith({ ...oidcEnv, ALLOWED_EMAILS: allowedEmails });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/wiki");
    const user = await db.query.users.findFirst({ where: eq(users.oidcSubject, "sub-1") });
    expect(user?.email).toBe("alice@outside.test");
    expect(await countPersonalWorkspaces(user?.id ?? "")).toBe(1);
    expect(await countWorkspaces()).toBe(1);
  });

  it("creates the first user as admin and later users as members (JIT)", async () => {
    expect((await loginWith(oidcEnv)).status).toBe(303);
    idTokenClaims = { ...idTokenClaims, sub: "sub-2", email: "bob@example.com", name: "Bob" };
    expect((await loginWith(oidcEnv)).status).toBe(303);
    const all = await db.query.users.findMany();
    expect(all.map((user) => [user.oidcSubject, user.role]).sort()).toEqual([
      ["sub-1", "admin"],
      ["sub-2", "member"],
    ]);
    for (const user of all) expect(await countPersonalWorkspaces(user.id)).toBe(1);
    expect(await countWorkspaces()).toBe(2);
  });

  it("links an existing user with the same email and no subject", async () => {
    const existing = await createUser({ email: "alice@example.com", role: "admin" });
    expect((await loginWith(oidcEnv)).status).toBe(303);
    const all = await db.query.users.findMany();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: existing.id, oidcIssuer: ISSUER, oidcSubject: "sub-1" });
    expect(await countWorkspaces()).toBe(1);
  });

  it("unifies the host for GET and returns 404 for other methods", async () => {
    const res = await send("https://pinglune.workers.dev/auth/login?next=/x", { env: oidcEnv });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${OIDC_ORIGIN}/auth/login?next=/x`);
    const setup = await send("https://pinglune.workers.dev/auth/setup", { env: oidcEnv });
    expect(setup.status).toBe(302);
    expect(setup.headers.get("Location")).toBe(`${OIDC_ORIGIN}/auth/setup`);
    const post = await send("https://pinglune.workers.dev/auth/logout", { method: "POST", env: oidcEnv });
    expect(post.status).toBe(404);
  });
});
