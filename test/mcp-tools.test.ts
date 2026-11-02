import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceRow, UserRow } from "../src/db/schema";
import { acceptEvent } from "../src/intake/service";
import type { IntakeInput } from "../src/intake/validation";
import { mcpHandler } from "../src/mcp/handler";
import { isReadableText } from "../src/mcp/text";
import {
  bucketWith,
  createSource,
  createUser,
  fakeQueue,
  ORIGIN,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
} from "./helpers";

const MCP_ACCEPT = "application/json, text/event-stream";
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const MISSING_EVENT_ID = "evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
const MISSING_DATA_REF = "dat_01JC9Z7H2K4M6N8P0Q2R4S6T8V";

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

type McpEvent = {
  event_id: string;
  type: string;
  source: { id: string; name: string };
  labels: Record<string, string>;
  summary: string;
  occurred_at: string;
  received_at: string;
  data_count: number;
};

type McpData = { data_ref: string; role: string; name: string; content_type: string; size: number; readable: boolean };

type ReadResult = {
  data_ref: string;
  event_id: string;
  name: string;
  content_type: string;
  size: number;
  readable: boolean;
  text: string | null;
  offset: number;
  next_offset: number | null;
};

let alice: UserRow;
let bob: UserRow;
let aliceSource: SourceRow;
let bobSource: SourceRow;
let sequence = 0;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  aliceSource = await createSource({ workspaceId: (await personalWorkspaceOf(alice)).id, name: "alice-app" });
  bobSource = await createSource({ workspaceId: (await personalWorkspaceOf(bob)).id, name: "bob-app" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

// Accepts an event through the shared intake, storing the data in R2.
async function ingest(
  source: SourceRow,
  input: Partial<IntakeInput> = {},
  receivedAt = T0 + sequence,
): Promise<string> {
  sequence++;
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now: receivedAt },
    { id: source.id, workspaceId: source.workspaceId, name: source.name, enabled: true },
    { idempotency_key: `k-${sequence}`, type: "alert.observed", summary: `s${sequence}`, ...input },
  );
  if (!result.ok) throw new Error(`ingest failed: ${result.error.code}`);
  return result.event_id;
}

function text(value: string, contentType = "text/plain; charset=utf-8") {
  return { content_type: contentType, bytes: new TextEncoder().encode(value) };
}

async function rpc(user: UserRow, method: string, params: unknown, sharedEnv: Cloudflare.Env = env): Promise<unknown> {
  const ctx = Object.assign(createExecutionContext(), {
    props: { userId: user.id, authMode: "password" },
    auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"] },
  }) as unknown as OAuthResourceContext<unknown>;
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await mcpHandler.fetch(request, sharedEnv, ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

function callTool(user: UserRow, name: string, args: Record<string, unknown>, sharedEnv?: Cloudflare.Env) {
  return rpc(user, "tools/call", { name, arguments: args }, sharedEnv) as Promise<ToolResult>;
}

function parse<T>(result: ToolResult): T {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

function expectToolError(result: ToolResult, code: string, message: string) {
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ error: { code, message } });
}

function expectInvalidArguments(result: ToolResult) {
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool /);
}

async function listEvents(user: UserRow, args: Record<string, unknown> = {}) {
  return parse<{ events: McpEvent[]; next_cursor: string | null }>(await callTool(user, "list_events", args));
}

async function getEvent(user: UserRow, eventId: string) {
  return parse<McpEvent & { data: McpData[] }>(await callTool(user, "get_event", { event_id: eventId }));
}

async function readData(user: UserRow, args: Record<string, unknown>) {
  return parse<ReadResult>(await callTool(user, "read_data", args));
}

async function bodyRef(user: UserRow, eventId: string): Promise<string> {
  const event = await getEvent(user, eventId);
  const ref = event.data[0]?.data_ref;
  if (ref === undefined) throw new Error("no data");
  return ref;
}

function spyBucket() {
  const get = vi.fn((...args: Parameters<R2Bucket["get"]>) => env.EVENT_DATA.get(...args));
  return { get, env: { ...env, EVENT_DATA: bucketWith({ get }) } as Cloudflare.Env };
}

describe("tools/list", () => {
  it("lists the three read-only tools and the two queue tools", async () => {
    const result = (await rpc(alice, "tools/list", {})) as {
      tools: {
        name: string;
        annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean };
        inputSchema: { additionalProperties?: unknown };
      }[];
    };
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "ack_events",
      "claim_events",
      "get_event",
      "list_events",
      "read_data",
    ]);
    const readOnly = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));
    expect(readOnly).toEqual({
      list_events: true,
      get_event: true,
      read_data: true,
      claim_events: false,
      ack_events: false,
    });
    const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
    expect(tools.get("claim_events")?.annotations).toMatchObject({ idempotentHint: false, destructiveHint: false });
    expect(tools.get("ack_events")?.annotations).toMatchObject({ idempotentHint: true, destructiveHint: false });
    for (const tool of result.tools) expect(tool.inputSchema.additionalProperties).toBe(false);
  });
});

describe("authorization", () => {
  it("answers another workspace's event as not found, like a missing one", async () => {
    const eventId = await ingest(aliceSource);
    const theirs = await callTool(bob, "get_event", { event_id: eventId });
    const missing = await callTool(bob, "get_event", { event_id: MISSING_EVENT_ID });
    expectToolError(theirs, "not_found", "イベントが見つかりません");
    expect(theirs).toEqual(missing);
    // Alice can read it.
    expect((await getEvent(alice, eventId)).event_id).toBe(eventId);
  });

  it("answers another workspace's data as not found, like a missing one, without reading R2", async () => {
    const eventId = await ingest(aliceSource, { body: text("secret") });
    const ref = await bodyRef(alice, eventId);
    const { get, env: spied } = spyBucket();
    const theirs = await callTool(bob, "read_data", { data_ref: ref }, spied);
    const missing = await callTool(bob, "read_data", { data_ref: MISSING_DATA_REF }, spied);
    expectToolError(theirs, "not_found", "データが見つかりません");
    expect(theirs).toEqual(missing);
    expect(get).not.toHaveBeenCalled();
    // Alice can read it.
    expect((await readData(alice, { data_ref: ref })).text).toBe("secret");
  });

  it("lists only the user's events", async () => {
    await ingest(aliceSource, { labels: { project: "p" } });
    const bobEvent = await ingest(bobSource, { labels: { project: "p" } });
    expect((await listEvents(bob)).events.map((e) => e.event_id)).toEqual([bobEvent]);
    expect(await listEvents(bob, { sources: ["alice-app"] })).toEqual({ events: [], next_cursor: null });
    expect((await listEvents(bob, { labels: { project: "p" } })).events.map((e) => e.event_id)).toEqual([bobEvent]);
  });

  it("does not match another workspace's source of the same name", async () => {
    const sameName = await createSource({ workspaceId: bobSource.workspaceId, name: "alice-app" });
    await ingest(aliceSource);
    const bobEvent = await ingest(sameName);
    await ingest(bobSource);
    const listed = await listEvents(bob, { sources: ["alice-app"] });
    expect(listed.events.map((e) => e.event_id)).toEqual([bobEvent]);
  });
});

describe("arguments", () => {
  it("answers a malformed event_id or data_ref as not found", async () => {
    expectToolError(await callTool(alice, "get_event", { event_id: "nope" }), "not_found", "イベントが見つかりません");
    expectToolError(await callTool(alice, "read_data", { data_ref: "../x" }), "not_found", "データが見つかりません");
  });

  it("answers an invalid cursor with invalid_cursor", async () => {
    expectToolError(await callTool(alice, "list_events", { cursor: "evt_x" }), "invalid_cursor", "cursor が正しくありません");
  });

  it.each([
    ["list_events", { since: "2026-11-01T00:00:00" }],
    ["list_events", { since: "2026-02-30T00:00:00Z" }],
    ["list_events", { types: [] }],
    ["list_events", { types: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
    ["list_events", { types: ["Alert"] }],
    ["list_events", { sources: [] }],
    ["list_events", { labels: {} }],
    ["list_events", { labels: { "Bad key": "v" } }],
    ["list_events", { labels: { k: "" } }],
    ["list_events", { limit: 0 }],
    ["list_events", { limit: 51 }],
    ["list_events", { type: "alert.observed" }],
    ["get_event", {}],
    ["read_data", { data_ref: MISSING_DATA_REF, limit: 0 }],
    ["read_data", { data_ref: MISSING_DATA_REF, limit: 262_145 }],
    ["read_data", { data_ref: MISSING_DATA_REF, offset: -1 }],
  ])("rejects %s %j as invalid arguments", async (name, args) => {
    expectInvalidArguments(await callTool(alice, name, args));
  });

  it("returns an empty list for unknown source names", async () => {
    await ingest(aliceSource);
    expect(await listEvents(alice, { sources: ["unknown"] })).toEqual({ events: [], next_cursor: null });
  });
});

describe("list_events", () => {
  it("returns the events newest first with ISO times", async () => {
    const eventId = await ingest(
      aliceSource,
      { labels: { project: "a" }, occurred_at: "2026-10-31T23:59:59.5Z", body: text("b") },
      T0 + 1000,
    );
    const listed = await listEvents(alice);
    expect(listed).toEqual({
      events: [
        {
          event_id: eventId,
          type: "alert.observed",
          source: { id: aliceSource.id, name: "alice-app" },
          labels: { project: "a" },
          summary: expect.any(String),
          occurred_at: "2026-10-31T23:59:59.500Z",
          received_at: "2026-11-01T00:00:01.000Z",
          data_count: 1,
        },
      ],
      next_cursor: null,
    });
  });

  it("pages with limit and next_cursor without gaps or duplicates", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await ingest(aliceSource));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listEvents(alice, cursor === undefined ? { limit: 3 } : { limit: 3, cursor });
      expect(page.events.length).toBeLessThanOrEqual(3);
      seen.push(...page.events.map((e) => e.event_id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(seen).toEqual([...ids].reverse());
  });

  it("defaults to 20 events a page", async () => {
    for (let i = 0; i < 21; i++) await ingest(aliceSource);
    const page = await listEvents(alice);
    expect(page.events).toHaveLength(20);
    expect(page.next_cursor).toBe(page.events[19]?.event_id);
  });

  it("matches any of the types, all of the labels, and all of the items", async () => {
    const other = await createSource({ workspaceId: aliceSource.workspaceId, name: "other-app" });
    const a = await ingest(aliceSource, { type: "a.x", labels: { env: "prod", team: "t1" } }, T0);
    const b = await ingest(aliceSource, { type: "b.x", labels: { env: "prod", team: "t2" } }, T0 + 10);
    const c = await ingest(other, { type: "a.x", labels: { env: "prod", team: "t1" } }, T0 + 20);
    const d = await ingest(aliceSource, { type: "c.x", labels: { env: "prod", team: "t1" } }, T0 + 30);
    const ids = async (args: Record<string, unknown>) => (await listEvents(alice, args)).events.map((e) => e.event_id);

    expect(await ids({ types: ["a.x", "b.x"] })).toEqual([c, b, a]);
    expect(await ids({ labels: { env: "prod", team: "t1" } })).toEqual([d, c, a]);
    expect(await ids({ labels: { env: "prod", team: "t3" } })).toEqual([]);
    expect(await ids({ sources: ["alice-app", "other-app"], types: ["a.x"] })).toEqual([c, a]);
    expect(await ids({ sources: ["alice-app"], types: ["a.x", "c.x"], labels: { team: "t1" } })).toEqual([d, a]);
    expect(
      await ids({ sources: ["alice-app"], types: ["a.x", "c.x"], labels: { team: "t1" }, since: "2026-11-01T00:00:00.010Z" }),
    ).toEqual([d]);
  });

  it("matches a label key with a dot", async () => {
    const dotted = await ingest(aliceSource, { labels: { "app.env": "prod" } });
    await ingest(aliceSource, { labels: { app: "x" } });
    expect((await listEvents(alice, { labels: { "app.env": "prod" } })).events.map((e) => e.event_id)).toEqual([dotted]);
  });

  it("includes the events received exactly at since", async () => {
    await ingest(aliceSource, {}, T0 - 1);
    const at = await ingest(aliceSource, {}, T0);
    const after = await ingest(aliceSource, {}, T0 + 1);
    // The same instant in +09:00.
    const listed = await listEvents(alice, { since: "2026-11-01T09:00:00+09:00" });
    expect(listed.events.map((e) => e.event_id)).toEqual([after, at]);
  });

  it("includes the events of disabled sources", async () => {
    const eventId = await ingest(aliceSource);
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(aliceSource.id).run();
    expect((await listEvents(alice, { sources: ["alice-app"] })).events.map((e) => e.event_id)).toEqual([eventId]);
  });
});

describe("get_event", () => {
  it("returns the event with its data in order and whether each is readable", async () => {
    const eventId = await ingest(aliceSource, {
      body: text("hello"),
      attachments: [
        { name: "report.pdf", content_type: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
        { name: "notes.txt", ...text("x", "text/plain; charset=iso-2022-jp") },
        { name: "data.json", ...text("{}", "application/json") },
      ],
    });
    const event = await getEvent(alice, eventId);
    expect(event.event_id).toBe(eventId);
    expect(event.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(event.data_count).toBe(4);
    expect(event.data.map((d) => [d.role, d.name, d.size, d.readable])).toEqual([
      ["body", "body", 5, true],
      ["attachment", "report.pdf", 3, false],
      ["attachment", "notes.txt", 1, false],
      ["attachment", "data.json", 2, true],
    ]);
    for (const data of event.data) expect(data.readable).toBe(isReadableText(data.content_type));
    expect(event.data[0]?.data_ref).toMatch(/^dat_/);
  });
});

describe("read_data", () => {
  it("reads a text in pieces that join to the original", async () => {
    const original = "ログ: 😀 alert\n日本語のテキストと emoji 🎉 を含む本文。".repeat(3);
    const eventId = await ingest(aliceSource, { body: text(original) });
    const ref = await bodyRef(alice, eventId);
    const size = new TextEncoder().encode(original).length;
    for (const limit of [1, 2, 3, 5, 7, 64]) {
      let joined = "";
      let offset = 0;
      for (;;) {
        const piece = await readData(alice, { data_ref: ref, offset, limit });
        expect(piece).toMatchObject({ data_ref: ref, event_id: eventId, name: "body", size, readable: true, offset });
        joined += piece.text;
        if (piece.next_offset === null) break;
        expect(piece.next_offset).toBeGreaterThan(offset);
        offset = piece.next_offset;
      }
      expect(joined).toBe(original);
    }
  });

  it("reads the whole text with the defaults", async () => {
    const eventId = await ingest(aliceSource, { body: text("hello") });
    const ref = await bodyRef(alice, eventId);
    expect(await readData(alice, { data_ref: ref })).toEqual({
      data_ref: ref,
      event_id: eventId,
      name: "body",
      content_type: "text/plain; charset=utf-8",
      size: 5,
      readable: true,
      text: "hello",
      offset: 0,
      next_offset: null,
    });
  });

  it("does not read binary data", async () => {
    const eventId = await ingest(aliceSource, {
      body: { content_type: "application/pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
    });
    const ref = await bodyRef(alice, eventId);
    const { get, env: spied } = spyBucket();
    const result = parse<ReadResult>(await callTool(alice, "read_data", { data_ref: ref, offset: 2 }, spied));
    expect(result).toEqual({
      data_ref: ref,
      event_id: eventId,
      name: "body",
      content_type: "application/pdf",
      size: 4,
      readable: false,
      text: null,
      offset: 2,
      next_offset: null,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("does not read a charset other than UTF-8", async () => {
    const eventId = await ingest(aliceSource, { body: text("abc", "text/plain; charset=iso-2022-jp") });
    const result = await readData(alice, { data_ref: await bodyRef(alice, eventId) });
    expect(result).toMatchObject({ readable: false, text: null, next_offset: null });
  });

  it("returns empty text for an empty attachment", async () => {
    const eventId = await ingest(aliceSource, { attachments: [{ name: "empty.txt", ...text("") }] });
    const { get, env: spied } = spyBucket();
    const ref = await bodyRef(alice, eventId);
    const result = parse<ReadResult>(await callTool(alice, "read_data", { data_ref: ref }, spied));
    expect(result).toMatchObject({ size: 0, readable: true, text: "", offset: 0, next_offset: null });
    expect(get).not.toHaveBeenCalled();
  });

  it("returns empty text from an offset at or after the end", async () => {
    const eventId = await ingest(aliceSource, { body: text("abc") });
    const ref = await bodyRef(alice, eventId);
    for (const offset of [3, 100]) {
      expect(await readData(alice, { data_ref: ref, offset })).toMatchObject({ text: "", offset, next_offset: null });
    }
  });

  it("answers a missing R2 object with internal_error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = await ingest(aliceSource, { body: text("abc") });
    const ref = await bodyRef(alice, eventId);
    await resetEventData();
    expectToolError(await callTool(alice, "read_data", { data_ref: ref }), "internal_error", "サーバーでエラーが発生しました");
    expect(errors).toHaveBeenCalledWith("event data object not found", { dataRef: ref });
  });

  it("answers an R2 exception with internal_error without its message", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = await ingest(aliceSource, { body: text("abc") });
    const ref = await bodyRef(alice, eventId);
    const failing = { ...env, EVENT_DATA: bucketWith({ get: () => Promise.reject(new Error("r2 down")) }) };
    const result = await callTool(alice, "read_data", { data_ref: ref }, failing as Cloudflare.Env);
    expectToolError(result, "internal_error", "サーバーでエラーが発生しました");
    expect(result.content[0]?.text).not.toContain("r2 down");
    expect(errors).toHaveBeenCalled();
  });
});

describe("workspace", () => {
  it("answers internal_error when the personal workspace is missing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("DELETE FROM sources WHERE workspace_id = ?").bind(aliceSource.workspaceId).run();
    await env.DB.prepare("DELETE FROM workspaces WHERE owner_user_id = ?").bind(alice.id).run();
    expectToolError(await callTool(alice, "list_events", {}), "internal_error", "サーバーでエラーが発生しました");
    expect(errors).toHaveBeenCalledWith("personal workspace not found", { userId: alice.id });
  });
});
