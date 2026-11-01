import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventDetail, EventList } from "../src/api/types";
import type { UserRow } from "../src/db/schema";
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

let member: UserRow;
let other: UserRow;
let memberCookies: SessionCookies;
let memberKey: string;
let otherKey: string;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  member = await createUser({ email: "member@example.com", role: "admin" });
  other = await createUser({ email: "other@example.com" });
  memberCookies = await login(member.email);
  const source = await createSource({ workspaceId: (await personalWorkspaceOf(member)).id, name: "app" });
  memberKey = (await createApiKey(source.id)).key;
  const otherSource = await createSource({ workspaceId: (await personalWorkspaceOf(other)).id, name: "theirs" });
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
