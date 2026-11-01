import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAddress, EmailAddressList, Source } from "../src/api/types";
import type { UserRow } from "../src/db/schema";
import * as ids from "../src/ids";
import {
  createEmailAddress,
  createUser,
  login,
  resetDb,
  resetEventData,
  send,
  type SessionCookies,
} from "./helpers";

const DOMAIN = "example.com";
const withDomain = { env: { EMAIL_DOMAIN: DOMAIN } };

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  admin = await createUser({ email: "admin@example.com", role: "admin" });
  member = await createUser({ email: "member@example.com", role: "member" });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

async function errorBody(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

async function createSourceVia(cookies: SessionCookies, name: string): Promise<Source> {
  const res = await send("/api/v1/sources", { json: { name }, cookies });
  expect(res.status).toBe(201);
  return (await res.json()) as Source;
}

function list(cookies: SessionCookies, sourceId: string, options = withDomain): Promise<Response> {
  return send(`/api/v1/sources/${sourceId}/email-addresses`, { cookies, ...options });
}

function issue(cookies: SessionCookies, sourceId: string, options = withDomain): Promise<Response> {
  return send(`/api/v1/sources/${sourceId}/email-addresses`, { method: "POST", cookies, ...options });
}

function revoke(cookies: SessionCookies, sourceId: string, localPart: string, options = withDomain): Promise<Response> {
  return send(`/api/v1/sources/${sourceId}/email-addresses/${localPart}/revoke`, { method: "POST", cookies, ...options });
}

describe("email addresses", () => {
  it("issues, lists and revokes addresses", async () => {
    const source = await createSourceVia(memberCookies, "app");

    const empty = await list(memberCookies, source.id);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ email_domain: DOMAIN, email_addresses: [] });

    const res = await issue(memberCookies, source.id);
    expect(res.status).toBe(201);
    const created = (await res.json()) as EmailAddress;
    expect(created).toEqual({
      local_part: expect.stringMatching(/^[a-z0-9]{20}$/),
      address: `${created.local_part}@${DOMAIN}`,
      created_at: expect.any(Number),
      last_received_at: null,
      revoked_at: null,
    });
    const second = (await (await issue(memberCookies, source.id)).json()) as EmailAddress;

    const first = await revoke(memberCookies, source.id, created.local_part);
    expect(first.status).toBe(200);
    const revoked = (await first.json()) as EmailAddress;
    expect(revoked.revoked_at).toEqual(expect.any(Number));

    // Revoking again keeps the first revoked_at.
    const again = await revoke(memberCookies, source.id, created.local_part);
    expect(again.status).toBe(200);
    expect(((await again.json()) as EmailAddress).revoked_at).toBe(revoked.revoked_at);

    // Revoked ones included, in the order they were created.
    const listed = (await (await list(memberCookies, source.id)).json()) as EmailAddressList;
    expect(listed.email_addresses.map((a) => a.local_part)).toEqual([created.local_part, second.local_part]);
    expect(listed.email_addresses[0]).toEqual(revoked);
  });

  it("issues addresses for a disabled source", async () => {
    const source = await createSourceVia(memberCookies, "app");
    await send(`/api/v1/sources/${source.id}`, { method: "PATCH", json: { enabled: false }, cookies: memberCookies });
    expect((await issue(memberCookies, source.id)).status).toBe(201);
  });

  it("normalizes EMAIL_DOMAIN in the addresses", async () => {
    const source = await createSourceVia(memberCookies, "app");
    const res = await issue(memberCookies, source.id, { env: { EMAIL_DOMAIN: " Example.COM " } });
    const created = (await res.json()) as EmailAddress;
    expect(created.address).toBe(`${created.local_part}@example.com`);
  });

  it("lists addresses without the domain when EMAIL_DOMAIN is unset", async () => {
    const source = await createSourceVia(memberCookies, "app");
    const localPart = await createEmailAddress(source.id);
    const res = await list(memberCookies, source.id, { env: { EMAIL_DOMAIN: undefined } as never });
    expect(await res.json()).toEqual({
      email_domain: null,
      email_addresses: [
        { local_part: localPart, address: null, created_at: expect.any(Number), last_received_at: null, revoked_at: null },
      ],
    });
  });

  it("lists addresses without the domain when EMAIL_DOMAIN is invalid, and logs without the value", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = await createSourceVia(memberCookies, "app");
    await createEmailAddress(source.id);
    const res = await list(memberCookies, source.id, { env: { EMAIL_DOMAIN: "not a domain" } });
    const body = (await res.json()) as EmailAddressList;
    expect(body.email_domain).toBeNull();
    expect(body.email_addresses[0]?.address).toBeNull();
    expect(error).toHaveBeenCalledWith("invalid EMAIL_DOMAIN");
    expect(JSON.stringify(error.mock.calls)).not.toContain("not a domain");
  });

  it.each([
    ["unset", undefined],
    ["blank", "  "],
    ["invalid", "not a domain"],
  ])("answers 409 email_not_configured when EMAIL_DOMAIN is %s", async (_, value) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = await createSourceVia(memberCookies, "app");
    const res = await issue(memberCookies, source.id, { env: { EMAIL_DOMAIN: value } as never });
    expect(res.status).toBe(409);
    expect(await errorBody(res)).toEqual({
      code: "email_not_configured",
      message: "メールでの受付が設定されていません（EMAIL_DOMAIN）",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM email_addresses").first("count")).toBe(0);
  });

  it("limits a source to 10 active addresses", async () => {
    const source = await createSourceVia(memberCookies, "app");
    for (let i = 0; i < 10; i++) await createEmailAddress(source.id);
    await createEmailAddress(source.id, { revokedAt: Date.now() });
    const res = await issue(memberCookies, source.id);
    expect(res.status).toBe(409);
    expect(await errorBody(res)).toEqual({
      code: "limit_exceeded",
      message: "有効なメールアドレスは 1 つの送信元に 10 個までです",
    });
  });

  it("checks the configuration before the limit", async () => {
    const source = await createSourceVia(memberCookies, "app");
    for (let i = 0; i < 10; i++) await createEmailAddress(source.id);
    const res = await issue(memberCookies, source.id, { env: { EMAIL_DOMAIN: "" } });
    expect((await errorBody(res)).code).toBe("email_not_configured");
  });

  it("retries once on a collision and answers 503 after two", async () => {
    const source = await createSourceVia(memberCookies, "app");
    const taken = await createEmailAddress(source.id);
    const spy = vi.spyOn(ids, "newEmailLocalPart").mockReturnValue(taken);
    const res = await issue(memberCookies, source.id);
    expect(res.status).toBe(503);
    expect(await errorBody(res)).toEqual({
      code: "temporarily_unavailable",
      message: "メールアドレスを発行できませんでした。もう一度試してください",
    });
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockReset();
    spy.mockReturnValueOnce(taken).mockReturnValueOnce("abcdefghij0123456789");
    const retried = await issue(memberCookies, source.id);
    expect(retried.status).toBe(201);
    expect(((await retried.json()) as EmailAddress).local_part).toBe("abcdefghij0123456789");
  });

  it("hides the addresses of other users' sources, from admins too", async () => {
    const theirs = await createSourceVia(memberCookies, "mine");
    expect((await list(adminCookies, theirs.id)).status).toBe(404);
    const res = await issue(adminCookies, theirs.id);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("not_found");
  });

  it("answers 404 for a malformed source ID", async () => {
    expect((await list(memberCookies, "not-a-source")).status).toBe(404);
    expect((await issue(memberCookies, "not-a-source")).status).toBe(404);
  });

  it("does not revoke an address of another user's source", async () => {
    const mine = await createSourceVia(memberCookies, "mine");
    const theirs = await createSourceVia(adminCookies, "theirs");
    const theirAddress = await createEmailAddress(theirs.id);

    const res = await revoke(memberCookies, mine.id, theirAddress);
    expect(res.status).toBe(404);
    expect(await errorBody(res)).toEqual({ code: "not_found", message: "メールアドレスが見つかりません" });
    expect((await revoke(memberCookies, theirs.id, theirAddress)).status).toBe(404);

    const row = await env.DB.prepare("SELECT revoked_at FROM email_addresses WHERE id = ?").bind(theirAddress).first();
    expect(row).toEqual({ revoked_at: null });
  });

  it("does not revoke an address of another source of the same user", async () => {
    const a = await createSourceVia(memberCookies, "a");
    const b = await createSourceVia(memberCookies, "b");
    const ofB = await createEmailAddress(b.id);
    expect((await revoke(memberCookies, a.id, ofB)).status).toBe(404);
  });

  it("answers 404 for a malformed local part", async () => {
    const source = await createSourceVia(memberCookies, "app");
    const res = await revoke(memberCookies, source.id, "NOT_AN_ADDRESS");
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("not_found");
  });

  it("requires login", async () => {
    const source = await createSourceVia(memberCookies, "app");
    expect((await send(`/api/v1/sources/${source.id}/email-addresses`, withDomain)).status).toBe(401);
    expect((await send(`/api/v1/sources/${source.id}/email-addresses`, { method: "POST", ...withDomain })).status).toBe(
      401,
    );
  });
});
