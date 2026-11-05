import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailView, EventDetail, EventList } from "../src/api/types";
import { env } from "cloudflare:workers";
import type { SourceRow, UserRow } from "../src/db/schema";
import {
  createApiKey,
  createSource,
  createSubscription,
  createUser,
  insertOpenConversations,
  login,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  routeToBot,
  send,
  type SessionCookies,
} from "./helpers";

let member: UserRow;
let other: UserRow;
let memberCookies: SessionCookies;
let memberKey: string;
let otherKey: string;
let source: SourceRow;
let otherSource: SourceRow;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  member = await createUser({ email: "member@example.com", role: "admin" });
  other = await createUser({ email: "other@example.com" });
  memberCookies = await login(member.email);
  source = await createSource({ workspaceId: (await personalWorkspaceOf(member)).id, name: "app" });
  memberKey = (await createApiKey(source.id)).key;
  otherSource = await createSource({ workspaceId: (await personalWorkspaceOf(other)).id, name: "theirs" });
  otherKey = (await createApiKey(otherSource.id)).key;
});

afterEach(async () => {
  await resetDb();
  await resetEventData();
});

async function ingest(key: string, json: Record<string, unknown>): Promise<string> {
  const res = await send("/ingest/v1/events", { json, headers: { Authorization: `Bearer ${key}` } });
  if (res.status !== 201) throw new Error(`ingest failed: ${res.status}`);
  return ((await res.json()) as { event_id: string }).event_id;
}

async function ingestForm(key: string, form: FormData): Promise<string> {
  const res = await send("/ingest/v1/events", {
    method: "POST",
    body: form,
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status !== 201) throw new Error(`ingest failed: ${res.status}`);
  return ((await res.json()) as { event_id: string }).event_id;
}

async function list(cursor?: string): Promise<Response> {
  return send(cursor === undefined ? "/api/v1/events" : `/api/v1/events?cursor=${encodeURIComponent(cursor)}`, {
    cookies: memberCookies,
  });
}

describe("GET /api/v1/events", () => {
  it("lists the newest first, 50 at a time, with a cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push(await ingest(memberKey, { idempotency_key: `k${i}`, type: "t", summary: `s${i}` }));
    await ingest(otherKey, { idempotency_key: "theirs", type: "t", summary: "theirs" });

    const first = (await (await list()).json()) as EventList;
    expect(first.events).toHaveLength(50);
    expect(first.events.map((e) => e.event_id)).toEqual([...ids].reverse().slice(0, 50));
    expect(first.next_cursor).toBe(first.events[49]?.event_id);

    const second = (await (await list(first.next_cursor ?? "")).json()) as EventList;
    expect(second.events.map((e) => e.event_id)).toEqual([ids[1], ids[0]]);
    expect(second.next_cursor).toBeNull();
  });

  it("returns the summary of each event", async () => {
    const form = new FormData();
    form.append(
      "metadata",
      JSON.stringify({ idempotency_key: "k", type: "alert.observed", summary: "s", labels: { env: "prod" } }),
    );
    form.append("body", new File(["b"], "b"));
    form.append("attachments", new File(["a"], "a.txt"));
    const id = await ingestForm(memberKey, form);
    const body = (await (await list()).json()) as EventList;
    expect(body).toEqual({
      events: [
        {
          event_id: id,
          type: "alert.observed",
          source: { id: expect.stringMatching(/^src_/), name: "app" },
          labels: { env: "prod" },
          summary: "s",
          occurred_at: expect.any(Number),
          received_at: expect.any(Number),
          data_count: 2,
          delivery_summary: { delivered: 0, pending: 0, failed: 0 },
          screening: null,
          email: null,
        },
      ],
      next_cursor: null,
    });
  });

  it.each(["", "evt_x", "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V", "evt_01jc9z7h2k4m6n8p0q2r4s6t8v"])(
    "rejects the cursor %j",
    async (cursor) => {
      const res = await list(cursor);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_cursor");
    },
  );
});

describe("GET /api/v1/events filters", () => {
  async function listWith(query: string): Promise<{ status: number; body: EventList }> {
    const res = await send(`/api/v1/events?${query}`, { cookies: memberCookies });
    return { status: res.status, body: (await res.json()) as EventList };
  }

  it("filters by type and by source, with the cursor", async () => {
    const second = await createSource({ workspaceId: source.workspaceId, name: "second" });
    const secondKey = (await createApiKey(second.id)).key;
    const a1 = await ingest(memberKey, { idempotency_key: "a1", type: "alert.observed", summary: "s" });
    const b1 = await ingest(memberKey, { idempotency_key: "b1", type: "build.done", summary: "s" });
    const a2 = await ingest(secondKey, { idempotency_key: "a2", type: "alert.observed", summary: "s" });
    const a3 = await ingest(memberKey, { idempotency_key: "a3", type: "alert.observed", summary: "s" });

    const byType = await listWith("type=alert.observed");
    expect(byType.status).toBe(200);
    expect(byType.body.events.map((e) => e.event_id)).toEqual([a3, a2, a1]);

    const bySource = await listWith(`source_id=${source.id}`);
    expect(bySource.body.events.map((e) => e.event_id)).toEqual([a3, b1, a1]);

    const both = await listWith(`type=alert.observed&source_id=${source.id}&cursor=${a3}`);
    expect(both.body.events.map((e) => e.event_id)).toEqual([a1]);
    expect(both.body.next_cursor).toBeNull();
  });

  it("gives an empty list for a source of another workspace or one that does not exist", async () => {
    await ingest(memberKey, { idempotency_key: "k", type: "t", summary: "s" });
    await ingest(otherKey, { idempotency_key: "k", type: "t", summary: "s" });
    for (const id of [otherSource.id, "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V"]) {
      const { status, body } = await listWith(`source_id=${id}`);
      expect(status).toBe(200);
      expect(body).toEqual({ events: [], next_cursor: null });
    }
  });

  it.each([
    ["type=", "invalid_type"],
    ["type=Alert", "invalid_type"],
    ["type=a..b", "invalid_type"],
    [`type=${"a".repeat(101)}`, "invalid_type"],
    ["type=a&type=b", "invalid_type"],
    ["source_id=", "invalid_source_id"],
    ["source_id=src_x", "invalid_source_id"],
    ["source_id=evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V", "invalid_source_id"],
    ["source_id=src_01JC9Z7H2K4M6N8P0Q2R4S6T8V&source_id=src_01JC9Z7H2K4M6N8P0Q2R4S6T8W", "invalid_source_id"],
  ])("rejects %s", async (query, code) => {
    const res = await send(`/api/v1/events?${query}`, { cookies: memberCookies });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it("counts the deliveries of each event by status", async () => {
    const one = await createSubscription({ user: member, callbackUrl: "https://hooks.example.com/1" });
    const two = await createSubscription({ user: member, callbackUrl: "https://hooks.example.com/2" });
    const three = await createSubscription({ user: member, callbackUrl: "https://hooks.example.com/3" });
    await routeToBot([one, two, three], [source.id]);
    const first = await ingest(memberKey, { idempotency_key: "k1", type: "t", summary: "s" });
    const second = await ingest(memberKey, { idempotency_key: "k2", type: "t", summary: "s" });
    await env.DB.prepare("UPDATE deliveries SET status = 'failed' WHERE event_id = ? AND subscription_id = ?")
      .bind(first, one.id)
      .run();
    await env.DB.prepare("UPDATE deliveries SET status = 'delivered' WHERE event_id = ? AND subscription_id = ?")
      .bind(first, two.id)
      .run();
    await env.DB.prepare("UPDATE deliveries SET status = 'delivered' WHERE event_id = ?").bind(second).run();
    await ingest(otherKey, { idempotency_key: "k3", type: "t", summary: "s" });

    const body = (await (await list()).json()) as EventList;
    expect(body.events.map((e) => [e.event_id, e.delivery_summary])).toEqual([
      [second, { delivered: 3, pending: 0, failed: 0 }],
      [first, { delivered: 1, pending: 1, failed: 1 }],
    ]);
  });
});

describe("GET /api/v1/events/:id/data/:dataRef", () => {
  type Item = { name: string; content: string; type?: string };

  let otherCookies: SessionCookies;

  beforeEach(async () => {
    otherCookies = await login(other.email);
  });

  // Ingests an event with "the body" as its body and the items as its attachments, and returns its detail.
  async function ingestData(key: string, items: Item[]): Promise<EventDetail> {
    const form = new FormData();
    form.append("metadata", JSON.stringify({ idempotency_key: crypto.randomUUID(), type: "t", summary: "s" }));
    form.append("body", new File(["the body"], "body", { type: "text/plain" }));
    for (const item of items) form.append("attachments", new File([item.content], item.name, { type: item.type }));
    const id = await ingestForm(key, form);
    const res = await send(`/api/v1/events/${id}`, { cookies: key === memberKey ? memberCookies : otherCookies });
    return (await res.json()) as EventDetail;
  }

  function dataUrl(event: EventDetail, index: number): string {
    const data = event.data[index];
    if (!data) throw new Error(`no data ${index}`);
    return `/api/v1/events/${event.event_id}/data/${data.data_ref}`;
  }

  it("returns the contents with safe headers", async () => {
    const event = await ingestData(memberKey, [{ name: "report.json", content: '{"a":1}', type: "application/json" }]);
    const res = await send(dataUrl(event, 1), { cookies: memberCookies });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"a":1}');
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''report.json");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Length")).toBe("7");

    const body = await send(dataUrl(event, 0), { cookies: memberCookies });
    expect(await body.text()).toBe("the body");
    expect(body.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(body.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''body");
  });

  it.each([
    ["image/png", "image/png"],
    ["IMAGE/JPEG", "image/jpeg"],
    ["image/gif", "image/gif"],
    ["image/webp", "image/webp"],
    ["text/csv", "text/csv; charset=utf-8"],
    ["text/plain; charset=UTF-8", "text/plain; charset=utf-8"],
    ['text/plain; charset="utf-8"', "text/plain; charset=utf-8"],
    ["text/plain; charset=shift_jis", "application/octet-stream"],
    ["text/html", "application/octet-stream"],
    ["image/svg+xml", "application/octet-stream"],
    ["application/xhtml+xml", "application/octet-stream"],
    ["application/pdf", "application/octet-stream"],
    ["text/markdown", "application/octet-stream"],
  ])("serves %s as %s", async (stored, served) => {
    const event = await ingestData(memberKey, [{ name: "x", content: "<svg onload=alert(1)>", type: stored }]);
    expect(event.data[1]?.content_type.toLowerCase()).toBe(stored.toLowerCase());
    const res = await send(dataUrl(event, 1), { cookies: memberCookies });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(served);
    expect(res.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''x");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
  });

  it("encodes the name in filename*", async () => {
    const event = await ingestData(memberKey, [{ name: "報告 (1)'s*.txt", content: "x", type: "text/plain" }]);
    const res = await send(dataUrl(event, 1), { cookies: memberCookies });
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename*=UTF-8''%E5%A0%B1%E5%91%8A%20%281%29%27s%2A.txt",
    );
  });

  it("answers 404 for data of another workspace, of another event, missing in R2, or malformed IDs", async () => {
    const mine = await ingestData(memberKey, [{ name: "a.txt", content: "a" }]);
    const another = await ingestData(memberKey, [{ name: "b.txt", content: "b" }]);
    const theirs = await ingestData(otherKey, [{ name: "c.txt", content: "c" }]);
    const mineRef = mine.data[1]?.data_ref ?? "";
    const anotherRef = another.data[1]?.data_ref ?? "";
    const theirRef = theirs.data[1]?.data_ref ?? "";
    const paths = [
      `/api/v1/events/${theirs.event_id}/data/${theirRef}`,
      `/api/v1/events/${mine.event_id}/data/${theirRef}`,
      `/api/v1/events/${mine.event_id}/data/${anotherRef}`,
      `/api/v1/events/${another.event_id}/data/${mineRef}`,
      `/api/v1/events/evt_x/data/${mineRef}`,
      `/api/v1/events/${mine.event_id}/data/dat_x`,
      `/api/v1/events/${mine.event_id}/data/${mine.event_id}`,
    ];
    for (const path of paths) {
      const res = await send(path, { cookies: memberCookies });
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({
        code: "not_found",
        message: "データが見つかりません",
      });
    }
    // The owner reads it.
    expect((await send(`/api/v1/events/${theirs.event_id}/data/${theirRef}`, { cookies: otherCookies })).status).toBe(200);

    const row = await env.DB.prepare("SELECT r2_key FROM event_data WHERE id = ?").bind(mineRef).first<{ r2_key: string }>();
    await env.EVENT_DATA.delete(row?.r2_key ?? "");
    const missing = await send(`/api/v1/events/${mine.event_id}/data/${mineRef}`, { cookies: memberCookies });
    expect(missing.status).toBe(404);
  });

  it("requires a signed-in user", async () => {
    const event = await ingestData(memberKey, [{ name: "a.txt", content: "a" }]);
    expect((await send(dataUrl(event, 1))).status).toBe(401);
  });
});

describe("GET /api/v1/events/:id", () => {
  it("returns the event with its data in position order", async () => {
    const form = new FormData();
    form.append("metadata", JSON.stringify({ idempotency_key: "k", type: "t", summary: "s" }));
    form.append("attachments", new File(["first"], "1.txt", { type: "text/plain" }));
    form.append("body", new File(["body"], "x", { type: "text/markdown" }));
    form.append("attachments", new File(["second!"], "2.txt"));
    const id = await ingestForm(memberKey, form);

    const res = await send(`/api/v1/events/${id}`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    const event = (await res.json()) as EventDetail;
    expect(event.event_id).toBe(id);
    expect(event.data_count).toBe(3);
    expect(event.data).toEqual([
      { data_ref: expect.stringMatching(/^dat_/), role: "body", name: "body", content_type: "text/markdown", size: 4 },
      { data_ref: expect.stringMatching(/^dat_/), role: "attachment", name: "1.txt", content_type: "text/plain", size: 5 },
      {
        data_ref: expect.stringMatching(/^dat_/),
        role: "attachment",
        name: "2.txt",
        content_type: "application/octet-stream",
        size: 7,
      },
    ]);
  });

  it("answers 404 for an event of another user and for a malformed ID", async () => {
    const theirs = await ingest(otherKey, { idempotency_key: "k", type: "t", summary: "s" });
    for (const id of [theirs, "evt_x", "nope"]) {
      const res = await send(`/api/v1/events/${id}`, { cookies: memberCookies });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
  });
});

describe("GET /api/v1/events/:id/email", () => {
  async function emailEvent(key: string, extra: Record<string, unknown> = {}): Promise<string> {
    return ingest(key, { idempotency_key: crypto.randomUUID(), type: "email.received", summary: "Hello", ...extra });
  }

  it("shows an email.received event that a source sent over HTTP, with the source", async () => {
    const id = await emailEvent(memberKey, {
      labels: { from: "a@example.com" },
      body: "From: A <a@example.com>\nSubject: Hello\n\nhi",
    });
    const res = await send(`/api/v1/events/${id}/email`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    const view = (await res.json()) as EmailView;
    expect(view.source).toEqual({ id: source.id, name: "app" });
    expect(view.from_address).toBe("a@example.com");
    expect(view.headers.from).toBe("A <a@example.com>");
    expect(view.text).toBe("hi");
    expect(view.html).toBeNull();
  });

  it("shows no header lines for a body of another Content-Type", async () => {
    const id = await emailEvent(memberKey, {
      labels: { from: "a@example.com" },
      body: "From: A <a@example.com>\nSubject: Hello\n\nhi",
      body_content_type: "text/plain",
    });
    const view = (await (await send(`/api/v1/events/${id}/email`, { cookies: memberCookies })).json()) as EmailView;
    expect(view.headers.from).toBeNull();
    expect(view.text).toBeNull();
  });

  it("answers 404 for another type, another workspace, a message of a conversation and a malformed ID", async () => {
    const otherType = await ingest(memberKey, { idempotency_key: "t", type: "alert.observed", summary: "s" });
    const theirs = await emailEvent(otherKey);
    const message = await emailEvent(memberKey);
    await insertOpenConversations(member, 1, null);
    const conversation = await env.DB.prepare("SELECT id FROM conversations").first<{ id: string }>();
    await env.DB.prepare("UPDATE events SET conversation_id = ? WHERE id = ?").bind(conversation?.id, message).run();
    for (const id of [otherType, theirs, message, "evt_x"]) {
      for (const path of ["email", "email/html"]) {
        const res = await send(`/api/v1/events/${id}/${path}`, { cookies: memberCookies });
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
      }
    }
  });

  it("answers 404 for the HTML of an event without an HTML body", async () => {
    const id = await emailEvent(memberKey, { body: "hi" });
    expect((await send(`/api/v1/events/${id}/email/html`, { cookies: memberCookies })).status).toBe(404);
  });

  it("counts the attachments of the email events in the list, without the HTML body", async () => {
    const form = new FormData();
    form.append(
      "metadata",
      JSON.stringify({ idempotency_key: "m", type: "email.received", summary: "s", labels: { from: "a@example.com" } }),
    );
    form.append("body", new File(["b"], "b", { type: "text/plain; charset=utf-8" }));
    form.append("attachments", new File(["<p>x</p>"], "body.html", { type: "text/html; charset=utf-8" }));
    form.append("attachments", new File(["<p>y</p>"], "body.html", { type: "text/html" }));
    form.append("attachments", new File(["a"], "a.txt", { type: "text/plain" }));
    const mailId = await ingestForm(memberKey, form);
    const bare = await emailEvent(memberKey);
    const other = await ingest(memberKey, { idempotency_key: "o", type: "alert.observed", summary: "s" });

    const body = (await (await list()).json()) as EventList;
    expect(body.events.map((e) => [e.event_id, e.email])).toEqual([
      [other, null],
      [bare, { from: null, attachment_count: 0 }],
      [mailId, { from: "a@example.com", attachment_count: 2 }],
    ]);
  });
});
