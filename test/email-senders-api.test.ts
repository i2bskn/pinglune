import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Source, SourceList } from "../src/api/types";
import { clock } from "@i2bskn/workers-app-core";
import type { SourceRow, UserRow, WorkspaceRow } from "../src/db/schema";
import {
  createSource,
  createUser,
  login,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
  type SessionCookies,
} from "./helpers";

const NOW = Date.UTC(2026, 10, 3, 0, 0, 0);
const HIDDEN_ID = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8X";

let alice: UserRow;
let aliceCookies: SessionCookies;
let bobCookies: SessionCookies;
let workspace: WorkspaceRow;
// Made directly, as a source made before the check of the sender.
let source: SourceRow;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  alice = await createUser({ email: "alice@example.com" });
  const bob = await createUser({ email: "bob@example.com" });
  aliceCookies = await login(alice.email);
  bobCookies = await login(bob.email);
  workspace = await personalWorkspaceOf(alice);
  source = await createSource({ workspaceId: workspace.id, name: "mail", createdAt: NOW - 1000 });
  vi.spyOn(clock, "now").mockReturnValue(NOW);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

type ErrorBody = { error: { code: string; message: string } };

function setVerification(id: string, body: unknown, cookies = aliceCookies): Promise<Response> {
  return send(`/api/v1/sources/${id}/email-sender-verification`, { json: body, cookies });
}

function setSenders(id: string, body: unknown, cookies = aliceCookies): Promise<Response> {
  return send(`/api/v1/sources/${id}/email-senders`, { json: body, cookies });
}

async function storedRow(id = source.id) {
  return env.DB.prepare(
    "SELECT email_sender_verification, email_allowed_senders, updated_at FROM sources WHERE id = ?",
  )
    .bind(id)
    .first<{ email_sender_verification: number; email_allowed_senders: string | null; updated_at: number }>();
}

async function insertHiddenSource() {
  await env.DB.prepare(
    "INSERT INTO sources (id, workspace_id, name, enabled, kind, created_at, updated_at) VALUES (?, ?, 'Pinglune 会話', 1, 'conversation', 1, 1)",
  )
    .bind(HIDDEN_ID, workspace.id)
    .run();
}

describe("the check of the sender of a source", () => {
  it("is on for a new source and off for a source made before it", async () => {
    const res = await send("/api/v1/sources", { json: { name: "new" }, cookies: aliceCookies });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Source;
    expect(created.email_sender_verification).toBe(true);
    expect(created.email_senders).toEqual([]);

    const list = (await (await send("/api/v1/sources", { cookies: aliceCookies })).json()) as SourceList;
    expect(list.sources.map((s) => [s.name, s.email_sender_verification])).toEqual([
      ["mail", false],
      ["new", true],
    ]);
    expect((await storedRow())?.email_sender_verification).toBe(0);
  });

  it("is turned on and off without changing the allowed senders", async () => {
    await env.DB.prepare("UPDATE sources SET email_allowed_senders = ? WHERE id = ?")
      .bind('["alerts@example.org"]', source.id)
      .run();
    const on = await setVerification(source.id, { enabled: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      id: source.id,
      email_sender_verification: true,
      email_senders: ["alerts@example.org"],
      updated_at: NOW,
    });
    expect(await storedRow()).toEqual({
      email_sender_verification: 1,
      email_allowed_senders: '["alerts@example.org"]',
      updated_at: NOW,
    });

    const off = await setVerification(source.id, { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ email_sender_verification: false, email_senders: ["alerts@example.org"] });
    expect((await storedRow())?.email_allowed_senders).toBe('["alerts@example.org"]');
  });

  it("is saved for a disabled source", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(source.id).run();
    expect((await setVerification(source.id, { enabled: true })).status).toBe(200);
    expect((await storedRow())?.email_sender_verification).toBe(1);
  });

  it.each([
    [{}, "invalid_request"],
    [{ enabled: "true" }, "invalid_request"],
    [{ enabled: 1 }, "invalid_request"],
    [{ enabled: null }, "invalid_request"],
    [{ enabled: true, confirm: true }, "unknown_field"],
    ["not json", "invalid_body"],
    [[true], "invalid_body"],
  ])("rejects %j with 400 %s", async (body, code) => {
    const res = await setVerification(source.id, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe(code);
    expect((await storedRow())?.email_sender_verification).toBe(0);
  });

  it("returns 404 for an unknown, malformed, other user's or conversation source", async () => {
    await insertHiddenSource();
    for (const id of ["src_01JC9Z7H2K4M6N8P0Q2R4S6T8W", "nope", HIDDEN_ID]) {
      expect((await setVerification(id, { enabled: true })).status).toBe(404);
    }
    expect((await setVerification(source.id, { enabled: true }, bobCookies)).status).toBe(404);
    expect((await storedRow())?.email_sender_verification).toBe(0);
    expect((await storedRow(HIDDEN_ID))?.email_sender_verification).toBe(0);
  });
});

describe("the allowed senders of a source", () => {
  it("saves them normalized, without duplicates, in the order given", async () => {
    const res = await setSenders(source.id, {
      senders: [" Alerts@Example.ORG ", "example.net", "alerts@example.org", "EXAMPLE.NET"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: source.id,
      email_senders: ["alerts@example.org", "example.net"],
      email_sender_verification: false,
      updated_at: NOW,
    });
    expect(await storedRow()).toEqual({
      email_sender_verification: 0,
      email_allowed_senders: '["alerts@example.org","example.net"]',
      updated_at: NOW,
    });
  });

  it("stores an empty list as NULL", async () => {
    await setSenders(source.id, { senders: ["example.org"] });
    const res = await setSenders(source.id, { senders: [] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Source).email_senders).toEqual([]);
    expect((await storedRow())?.email_allowed_senders).toBeNull();
  });

  it("accepts 20 senders, duplicates counted, and rejects 21", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `a${i}@example.org`);
    expect((await setSenders(source.id, { senders: twenty })).status).toBe(200);

    const res = await setSenders(source.id, { senders: Array.from({ length: 21 }, () => "example.org") });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("too_many_senders");
    expect(JSON.parse((await storedRow())?.email_allowed_senders ?? "[]")).toEqual(twenty);
  });

  it("rejects an invalid sender with the position of the first one", async () => {
    const res = await setSenders(source.id, { senders: ["example.org", "localhost", "a b@example.org"] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error).toEqual({
      code: "invalid_sender",
      message: "2行目の送信者の書き方が正しくありません",
    });
    expect((await storedRow())?.email_allowed_senders).toBeNull();
  });

  it.each([
    [{}, "invalid_request"],
    [{ senders: "example.org" }, "invalid_request"],
    [{ senders: ["example.org", 1] }, "invalid_request"],
    [{ senders: null }, "invalid_request"],
    [{ senders: [], enabled: true }, "unknown_field"],
    ["not json", "invalid_body"],
  ])("rejects %j with 400 %s", async (body, code) => {
    const res = await setSenders(source.id, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe(code);
  });

  it("saves them for a disabled source", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(source.id).run();
    expect((await setSenders(source.id, { senders: ["example.org"] })).status).toBe(200);
  });

  it("returns 404 for an unknown, malformed, other user's or conversation source", async () => {
    await insertHiddenSource();
    for (const id of ["src_01JC9Z7H2K4M6N8P0Q2R4S6T8W", "nope", HIDDEN_ID]) {
      expect((await setSenders(id, { senders: ["example.org"] })).status).toBe(404);
    }
    expect((await setSenders(source.id, { senders: ["example.org"] }, bobCookies)).status).toBe(404);
    expect((await storedRow())?.email_allowed_senders).toBeNull();
    expect((await storedRow(HIDDEN_ID))?.email_allowed_senders).toBeNull();
  });

  it("shows a broken stored value as none", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("UPDATE sources SET email_allowed_senders = 'not json' WHERE id = ?").bind(source.id).run();
    const list = (await (await send("/api/v1/sources", { cookies: aliceCookies })).json()) as SourceList;
    expect(list.sources[0]?.email_senders).toEqual([]);
    expect(error).toHaveBeenCalledWith("invalid email_allowed_senders", { sourceId: source.id });
  });
});
