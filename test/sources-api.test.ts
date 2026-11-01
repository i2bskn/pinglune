import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKey, ApiKeyList, CreatedApiKey, Source, SourceList } from "../src/api/types";
import type { UserRow, WorkspaceRow } from "../src/db/schema";
import {
  createApiKey,
  createSource,
  createUser,
  login,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
  type SessionCookies,
} from "./helpers";

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;
let memberWorkspace: WorkspaceRow;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  admin = await createUser({ email: "admin@example.com", role: "admin" });
  member = await createUser({ email: "member@example.com", role: "member" });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
  memberWorkspace = await personalWorkspaceOf(member);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function createSourceVia(cookies: SessionCookies, name: string): Promise<Source> {
  const res = await send("/api/v1/sources", { json: { name }, cookies });
  expect(res.status).toBe(201);
  return (await res.json()) as Source;
}

async function issueKey(cookies: SessionCookies, sourceId: string): Promise<Response> {
  return send(`/api/v1/sources/${sourceId}/api-keys`, { method: "POST", cookies });
}

function ingest(key: string): Promise<Response> {
  return send("/ingest/v1/events", {
    json: { idempotency_key: crypto.randomUUID(), type: "t", summary: "s" },
    headers: { Authorization: `Bearer ${key}` },
  });
}

describe("sources", () => {
  it("creates, lists, renames and disables sources", async () => {
    const created = await createSourceVia(memberCookies, "  app one  ");
    expect(created).toMatchObject({ name: "app one", enabled: true, active_key_count: 0 });
    expect(created.id).toMatch(/^src_[0-9A-HJKMNP-TV-Z]{26}$/);
    const second = await createSourceVia(memberCookies, "App One");

    const list = (await (await send("/api/v1/sources", { cookies: memberCookies })).json()) as SourceList;
    expect(list.sources.map((s) => s.id)).toEqual([created.id, second.id]);

    const renamed = await send(`/api/v1/sources/${created.id}`, {
      method: "PATCH",
      json: { name: " renamed " },
      cookies: memberCookies,
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: created.id, name: "renamed", enabled: true });

    const disabled = await send(`/api/v1/sources/${created.id}`, {
      method: "PATCH",
      json: { enabled: false },
      cookies: memberCookies,
    });
    expect(await disabled.json()).toMatchObject({ name: "renamed", enabled: false });
  });

  it("rejects a duplicate name in the same workspace, but not in another", async () => {
    const first = await createSourceVia(memberCookies, "app");
    const duplicate = await send("/api/v1/sources", { json: { name: " app " }, cookies: memberCookies });
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe("source_name_taken");
    await createSourceVia(adminCookies, "app");

    await createSourceVia(memberCookies, "other");
    const renamed = await send(`/api/v1/sources/${first.id}`, {
      method: "PATCH",
      json: { name: "other" },
      cookies: memberCookies,
    });
    expect(renamed.status).toBe(409);
    expect(await errorCode(renamed)).toBe("source_name_taken");
  });

  it.each([
    [{ name: "" }, 400, "invalid_name"],
    [{ name: "   " }, 400, "invalid_name"],
    [{ name: "a".repeat(65) }, 400, "invalid_name"],
    [{ name: "a\tb" }, 400, "invalid_name"],
    [{ name: 1 }, 400, "invalid_name"],
    [{}, 400, "invalid_name"],
    [{ name: "a", extra: 1 }, 400, "unknown_field"],
  ])("rejects %j when creating", async (json, status, code) => {
    const res = await send("/api/v1/sources", { json, cookies: memberCookies });
    expect(res.status).toBe(status);
    expect(await errorCode(res)).toBe(code);
  });

  it("accepts a name of 64 characters", async () => {
    expect((await createSourceVia(memberCookies, "あ".repeat(64))).name).toBe("あ".repeat(64));
  });

  it.each([
    [{}, "invalid_request"],
    [{ enabled: "false" }, "invalid_enabled"],
    [{ name: "" }, "invalid_name"],
    [{ enabled: true, extra: 1 }, "unknown_field"],
  ])("rejects %j when updating", async (json, code) => {
    const source = await createSourceVia(memberCookies, "app");
    const res = await send(`/api/v1/sources/${source.id}`, { method: "PATCH", json, cookies: memberCookies });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe(code);
  });

  it("limits a workspace to 100 sources", async () => {
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      await createSource({ workspaceId: memberWorkspace.id, name: `s${i}`, createdAt: now + i });
    }
    const res = await send("/api/v1/sources", { json: { name: "one more" }, cookies: memberCookies });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("limit_exceeded");
  });

  it("hides the sources of other users, from admins too", async () => {
    const mine = await createSourceVia(memberCookies, "mine");
    const list = (await (await send("/api/v1/sources", { cookies: adminCookies })).json()) as SourceList;
    expect(list.sources).toEqual([]);

    const patch = await send(`/api/v1/sources/${mine.id}`, {
      method: "PATCH",
      json: { enabled: false },
      cookies: adminCookies,
    });
    expect(patch.status).toBe(404);
    expect((await send(`/api/v1/sources/${mine.id}/api-keys`, { cookies: adminCookies })).status).toBe(404);
    expect((await issueKey(adminCookies, mine.id)).status).toBe(404);

    const row = await env.DB.prepare("SELECT enabled FROM sources WHERE id = ?").bind(mine.id).first();
    expect(row).toEqual({ enabled: 1 });
  });

  it("answers 404 for a malformed source ID", async () => {
    const res = await send("/api/v1/sources/not-a-source/api-keys", { cookies: memberCookies });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });
});

describe("API keys", () => {
  it("returns the plain key only when issuing it", async () => {
    const source = await createSourceVia(memberCookies, "app");
    const res = await issueKey(memberCookies, source.id);
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreatedApiKey;
    expect(created.key).toMatch(new RegExp(`^pl_${created.api_key.key_id}_[A-Za-z0-9_-]{43}$`));
    expect(created.api_key).toEqual({
      key_id: created.api_key.key_id,
      created_at: expect.any(Number),
      last_used_at: null,
      revoked_at: null,
    });
    expect(created.api_key.key_id).toMatch(/^[a-z0-9]{16}$/);

    const listRes = await send(`/api/v1/sources/${source.id}/api-keys`, { cookies: memberCookies });
    const text = await listRes.text();
    const secret = created.key.slice(`pl_${created.api_key.key_id}_`.length);
    expect(text).not.toContain(secret);
    const row = await env.DB.prepare("SELECT secret_hash FROM api_keys WHERE id = ?")
      .bind(created.api_key.key_id)
      .first<{ secret_hash: string }>();
    expect(text).not.toContain(row?.secret_hash ?? "missing");
    expect(row?.secret_hash).not.toBe(secret);
    const list = JSON.parse(text) as ApiKeyList;
    expect(list.api_keys).toEqual([created.api_key]);
    expect(Object.keys(list.api_keys[0] ?? {}).sort()).toEqual(["created_at", "key_id", "last_used_at", "revoked_at"]);

    // The key works, and shows in the count of the source.
    expect((await ingest(created.key)).status).toBe(201);
    const sources = (await (await send("/api/v1/sources", { cookies: memberCookies })).json()) as SourceList;
    expect(sources.sources[0]?.active_key_count).toBe(1);
  });

  it("issues keys for a disabled source", async () => {
    const source = await createSourceVia(memberCookies, "app");
    await send(`/api/v1/sources/${source.id}`, { method: "PATCH", json: { enabled: false }, cookies: memberCookies });
    expect((await issueKey(memberCookies, source.id)).status).toBe(201);
  });

  it("revokes a key, idempotently, and the key stops working", async () => {
    const source = await createSourceVia(memberCookies, "app");
    const created = (await (await issueKey(memberCookies, source.id)).json()) as CreatedApiKey;
    const path = `/api/v1/sources/${source.id}/api-keys/${created.api_key.key_id}/revoke`;

    const first = await send(path, { method: "POST", cookies: memberCookies });
    expect(first.status).toBe(200);
    const revoked = (await first.json()) as ApiKey;
    expect(revoked.revoked_at).toEqual(expect.any(Number));

    const second = await send(path, { method: "POST", cookies: memberCookies });
    expect(second.status).toBe(200);
    expect(((await second.json()) as ApiKey).revoked_at).toBe(revoked.revoked_at);

    expect((await ingest(created.key)).status).toBe(401);
  });

  it("limits a source to 10 active keys", async () => {
    const source = await createSourceVia(memberCookies, "app");
    for (let i = 0; i < 10; i++) await createApiKey(source.id);
    await createApiKey(source.id, { revokedAt: Date.now() });
    const res = await issueKey(memberCookies, source.id);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("limit_exceeded");
  });

  it("does not revoke a key of another user's source through one's own source", async () => {
    const mine = await createSourceVia(memberCookies, "mine");
    const theirs = await createSourceVia(adminCookies, "theirs");
    const theirKey = (await (await issueKey(adminCookies, theirs.id)).json()) as CreatedApiKey;

    const res = await send(`/api/v1/sources/${mine.id}/api-keys/${theirKey.api_key.key_id}/revoke`, {
      method: "POST",
      cookies: memberCookies,
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");

    // Nor through their source.
    const direct = await send(`/api/v1/sources/${theirs.id}/api-keys/${theirKey.api_key.key_id}/revoke`, {
      method: "POST",
      cookies: memberCookies,
    });
    expect(direct.status).toBe(404);

    const row = await env.DB.prepare("SELECT revoked_at FROM api_keys WHERE id = ?")
      .bind(theirKey.api_key.key_id)
      .first();
    expect(row).toEqual({ revoked_at: null });
    expect((await ingest(theirKey.key)).status).toBe(201);
  });

  it("does not revoke a key of another source of the same user", async () => {
    const a = await createSourceVia(memberCookies, "a");
    const b = await createSourceVia(memberCookies, "b");
    const keyOfB = (await (await issueKey(memberCookies, b.id)).json()) as CreatedApiKey;
    const res = await send(`/api/v1/sources/${a.id}/api-keys/${keyOfB.api_key.key_id}/revoke`, {
      method: "POST",
      cookies: memberCookies,
    });
    expect(res.status).toBe(404);
  });

  it("answers 404 for a malformed key ID", async () => {
    const source = await createSourceVia(memberCookies, "app");
    const res = await send(`/api/v1/sources/${source.id}/api-keys/NOT_A_KEY/revoke`, {
      method: "POST",
      cookies: memberCookies,
    });
    expect(res.status).toBe(404);
  });
});

describe("authentication of the management API", () => {
  it("requires login", async () => {
    const source = await createSource({ workspaceId: memberWorkspace.id, name: "app" });
    expect((await send("/api/v1/sources")).status).toBe(401);
    expect((await send("/api/v1/sources", { json: { name: "x" } })).status).toBe(401);
    expect((await send(`/api/v1/sources/${source.id}/api-keys`)).status).toBe(401);
    expect((await send(`/api/v1/sources/${source.id}/api-keys`, { method: "POST" })).status).toBe(401);
    expect((await send("/api/v1/events")).status).toBe(401);
  });

  it("rejects POSTs from another origin", async () => {
    const res = await send("/api/v1/sources", {
      json: { name: "x" },
      cookies: memberCookies,
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
    const source = await createSource({ workspaceId: memberWorkspace.id, name: "app" });
    const issue = await send(`/api/v1/sources/${source.id}/api-keys`, {
      method: "POST",
      cookies: memberCookies,
      origin: "https://evil.example",
    });
    expect(issue.status).toBe(403);
  });

  it("answers 500 when the personal workspace is missing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("DELETE FROM workspaces WHERE owner_user_id = ?").bind(member.id).run();
    const res = await send("/api/v1/sources", { cookies: memberCookies });
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe("internal_error");
    expect(errors).toHaveBeenCalled();
  });
});
