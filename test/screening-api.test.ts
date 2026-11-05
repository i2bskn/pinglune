import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventList, ManagedEventDetail, ScreeningSettings, Source } from "../src/api/types";
import { clock, createDb } from "@i2bskn/workers-app-core";
import type { SourceRow, SubscriptionRow, UserRow, WorkspaceRow } from "../src/db/schema";
import { acceptEvent } from "../src/intake/service";
import type { IntakeInput } from "../src/intake/validation";
import { core } from "../src/core";
import { claimQueueDeliveries } from "../src/queues/queries";
import { decryptApiKey, encryptApiKey } from "../src/screening/api-key";
import {
  createApiKey,
  createQueue,
  createSource,
  createSubscription,
  createUser,
  fakeQueue,
  listDeliveries,
  login,
  ORIGIN,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  routeToBot,
  send,
  TEST_JWT_SECRET,
  type FakeQueue,
  type SessionCookies,
} from "./helpers";

const MINUTE = 60_000;
const API_KEY = "ts_live_secret_key_wxyz";

let owner: UserRow;
let other: UserRow;
let workspace: WorkspaceRow;
let source: SourceRow;
let otherSource: SourceRow;
let cookies: SessionCookies;
let otherCookies: SessionCookies;
let queue: FakeQueue;
let webhook: SubscriptionRow;
let modelsStatus: number;
let modelsCalls: (string | null)[];
let now: number;
let sequence = 0;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  owner = await createUser({ email: "owner@example.com" });
  other = await createUser({ email: "other@example.com" });
  workspace = await personalWorkspaceOf(owner);
  source = await createSource({ workspaceId: workspace.id, name: "mail" });
  otherSource = await createSource({ workspaceId: (await personalWorkspaceOf(other)).id, name: "theirs" });
  webhook = await createSubscription({ user: owner, kind: "webhook", name: "hook" });
  await routeToBot(webhook, [source.id]);
  cookies = await login(owner.email);
  otherCookies = await login(other.email);
  queue = fakeQueue();
  modelsStatus = 200;
  modelsCalls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://api.typesafe.ai/v1/models") {
      modelsCalls.push(request.headers.get("authorization"));
      return Response.json({ data: [] }, { status: modelsStatus });
    }
    throw new Error(`unexpected fetch: ${request.url}`);
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

async function storedKey(): Promise<{ screening_api_key: string | null; screening_api_key_hint: string | null } | null> {
  return env.DB.prepare("SELECT screening_api_key, screening_api_key_hint FROM workspaces WHERE id = ?")
    .bind(workspace.id)
    .first();
}

async function setStoredKey(): Promise<void> {
  await env.DB.prepare("UPDATE workspaces SET screening_api_key = ?, screening_api_key_hint = 'wxyz' WHERE id = ?")
    .bind(await encryptApiKey(TEST_JWT_SECRET, workspace.id, API_KEY), workspace.id)
    .run();
}

async function setSource(id: string, columns: string, ...values: unknown[]): Promise<void> {
  await env.DB.prepare(`UPDATE sources SET ${columns} WHERE id = ?`)
    .bind(...values, id)
    .run();
}

async function screeningEnabled(id: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT screening_enabled FROM sources WHERE id = ?").bind(id).first<{ screening_enabled: number }>();
  return row?.screening_enabled;
}

function postScreening(id: string, json: unknown, as = cookies): Promise<Response> {
  return send(`/api/v1/sources/${id}/screening`, { json, cookies: as });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

// An event of the source through the shared intake, then put in the given screening state.
async function ingest(status: string | null, input: Partial<IntakeInput> = {}, of: SourceRow = source): Promise<string> {
  sequence++;
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now },
    { id: of.id, workspaceId: of.workspaceId, name: of.name, enabled: true, screeningEnabled: status !== null },
    { idempotency_key: `k-${sequence}`, type: "email.received", summary: `s${sequence}`, ...input },
  );
  if (!result.ok) throw new Error(`ingest failed: ${result.error.code}`);
  if (status !== null) {
    await env.DB.prepare("UPDATE events SET screening_status = ? WHERE id = ?").bind(status, result.event_id).run();
  }
  return result.event_id;
}

async function eventScreening(eventId: string) {
  return env.DB.prepare(
    `SELECT screening_status, screening_score, screening_error, screening_requested_at, screened_at, screening_released_at,
      screening_released_by FROM events WHERE id = ?`,
  )
    .bind(eventId)
    .first<{
      screening_status: string | null;
      screening_score: number | null;
      screening_error: string | null;
      screening_requested_at: number | null;
      screened_at: number | null;
      screening_released_at: number | null;
      screening_released_by: string | null;
    }>();
}

describe("POST /api/v1/sources/:id/screening", () => {
  it("needs api_key to turn it on in a workspace without a key", async () => {
    const res = await postScreening(source.id, { enabled: true });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("api_key_required");
    expect(await screeningEnabled(source.id)).toBe(0);
    expect(modelsCalls).toEqual([]);
  });

  it("checks and saves the key, then turns it on", async () => {
    const res = await postScreening(source.id, { enabled: true, api_key: `  ${API_KEY}  ` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Source;
    expect(body.screening).toEqual({ enabled: true, available: true });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(modelsCalls).toEqual([`Bearer ${API_KEY}`]);
    expect(await screeningEnabled(source.id)).toBe(1);
    const stored = await storedKey();
    expect(stored?.screening_api_key_hint).toBe("wxyz");
    expect(stored?.screening_api_key).not.toContain(API_KEY);
    expect(await decryptApiKey(TEST_JWT_SECRET, workspace.id, stored?.screening_api_key ?? "")).toBe(API_KEY);
  });

  it("does not save a key that TypeSafe refuses", async () => {
    modelsStatus = 401;
    const res = await postScreening(source.id, { enabled: true, api_key: API_KEY });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("invalid_api_key");
    expect(await storedKey()).toEqual({ screening_api_key: null, screening_api_key_hint: null });
    expect(await screeningEnabled(source.id)).toBe(0);
  });

  it("does not save a key when TypeSafe cannot tell", async () => {
    modelsStatus = 500;
    const res = await postScreening(source.id, { enabled: true, api_key: API_KEY });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("screening_unavailable");
    expect((await storedKey())?.screening_api_key).toBeNull();
    expect(await screeningEnabled(source.id)).toBe(0);
  });

  it.each(["", "   ", "a".repeat(257), "キー", "a\u0001b"])("rejects the key %j without calling TypeSafe", async (apiKey) => {
    const res = await postScreening(source.id, { enabled: true, api_key: apiKey });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("invalid_api_key");
    expect(modelsCalls).toEqual([]);
  });

  it("turns it on with the key of the workspace, and rejects api_key then", async () => {
    await setStoredKey();
    const res = await postScreening(source.id, { enabled: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Source).screening).toEqual({ enabled: true, available: true });
    expect(modelsCalls).toEqual([]);

    const again = await postScreening(source.id, { enabled: true, api_key: "another-key" });
    expect(again.status).toBe(422);
    expect(await errorCode(again)).toBe("api_key_already_set");
  });

  it("turns it off whether or not there is a key", async () => {
    await setSource(source.id, "screening_enabled = 1");
    const res = await postScreening(source.id, { enabled: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Source).screening).toEqual({ enabled: false, available: false });
    expect(await screeningEnabled(source.id)).toBe(0);
  });

  it("is not turned on while the source may start conversations", async () => {
    await setStoredKey();
    await setSource(source.id, "can_start_conversations = 1");
    const res = await postScreening(source.id, { enabled: true });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("conversation_start_enabled");
    expect(await screeningEnabled(source.id)).toBe(0);
  });

  it("is 404 for a source of another workspace", async () => {
    const res = await postScreening(otherSource.id, { enabled: false });
    expect(res.status).toBe(404);
  });

  it("shows the screening in the list of sources without the key", async () => {
    await setStoredKey();
    await setSource(source.id, "screening_enabled = 1");
    const res = await send("/api/v1/sources", { cookies });
    const text = await res.text();
    expect(text).not.toContain(API_KEY);
    const body = JSON.parse(text) as { sources: Source[] };
    expect(body.sources[0]?.screening).toEqual({ enabled: true, available: true });
  });
});

describe("the conversation start and the screening", () => {
  it("refuses to allow the conversation start of a source with screening", async () => {
    await setSource(source.id, "screening_enabled = 1");
    const res = await send(`/api/v1/sources/${source.id}/conversation-start`, {
      json: { enabled: true, daily_limit: 10, max_ai_messages: 10 },
      cookies,
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("screening_enabled");
    const off = await send(`/api/v1/sources/${source.id}/conversation-start`, {
      json: { enabled: false, daily_limit: 10, max_ai_messages: 10 },
      cookies,
    });
    expect(off.status).toBe(200);
  });

  it("refuses a conversation started by a source with screening", async () => {
    await setSource(source.id, "screening_enabled = 1, can_start_conversations = 1");
    const { key } = await createApiKey(source.id);
    const res = await send("/ingest/v1/conversations", {
      json: { title: "t", participants: ["bot"], message: "hello", idempotency_key: "c-1" },
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("start_not_allowed");
  });
});

describe("/api/v1/screening", () => {
  it("returns the last 4 characters of the key only", async () => {
    expect(await (await send("/api/v1/screening", { cookies })).json()).toEqual({ api_key: null });
    await setStoredKey();
    const res = await send("/api/v1/screening", { cookies });
    const text = await res.text();
    expect(text).not.toContain(API_KEY);
    expect(JSON.parse(text) as ScreeningSettings).toEqual({ api_key: { hint: "wxyz" } });
    // Another workspace has its own.
    expect(await (await send("/api/v1/screening", { cookies: otherCookies })).json()).toEqual({ api_key: null });
  });

  it("checks the key before saving it", async () => {
    modelsStatus = 403;
    const refused = await send("/api/v1/screening/api-key", { method: "PUT", json: { api_key: API_KEY }, cookies });
    expect(refused.status).toBe(422);
    expect((await storedKey())?.screening_api_key).toBeNull();

    modelsStatus = 200;
    const res = await send("/api/v1/screening/api-key", { method: "PUT", json: { api_key: "new-key-1234" }, cookies });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ api_key: { hint: "1234" } });
    expect(await decryptApiKey(TEST_JWT_SECRET, workspace.id, (await storedKey())?.screening_api_key ?? "")).toBe("new-key-1234");
  });

  it("deletes the key; the source can still be turned off", async () => {
    await setStoredKey();
    await setSource(source.id, "screening_enabled = 1");
    const res = await send("/api/v1/screening/api-key", { method: "DELETE", cookies });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ api_key: null });
    expect(await storedKey()).toEqual({ screening_api_key: null, screening_api_key_hint: null });
    const list = (await (await send("/api/v1/sources", { cookies })).json()) as { sources: Source[] };
    expect(list.sources[0]?.screening).toEqual({ enabled: true, available: false });
    expect((await postScreening(source.id, { enabled: false })).status).toBe(200);
  });
});

describe("the events of the management screen", () => {
  it("lists held and pending events with their screening, and filters by it", async () => {
    const held = await ingest("held");
    const pending = await ingest("pending");
    const plain = await ingest(null);
    await env.DB.prepare("UPDATE events SET screening_score = 0.9, screened_at = ? WHERE id = ?").bind(now, held).run();

    const all = (await (await send("/api/v1/events", { cookies })).json()) as EventList;
    expect(all.events.map((event) => event.event_id)).toEqual([plain, pending, held]);
    expect(all.events.map((event) => event.screening?.status ?? null)).toEqual([null, "pending", "held"]);
    expect(all.events[2]?.screening).toEqual({
      status: "held",
      score: 0.9,
      error: null,
      retryable: false,
      requested_at: now,
      screened_at: now,
      released_at: null,
    });

    const onlyHeld = (await (await send("/api/v1/events?screening=held", { cookies })).json()) as EventList;
    expect(onlyHeld.events.map((event) => event.event_id)).toEqual([held]);
    const onlyPending = (await (await send("/api/v1/events?screening=pending", { cookies })).json()) as EventList;
    expect(onlyPending.events.map((event) => event.event_id)).toEqual([pending]);
  });

  it.each(["", "passed", "HELD", "held&screening=pending"])("rejects screening=%s", async (value) => {
    const res = await send(`/api/v1/events?screening=${value}`, { cookies });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_screening");
  });

  it("shows the screening on the detail", async () => {
    const held = await ingest("held");
    await env.DB.prepare("UPDATE events SET screening_error = 'screening_unavailable' WHERE id = ?").bind(held).run();
    const body = (await (await send(`/api/v1/events/${held}`, { cookies })).json()) as ManagedEventDetail;
    expect(body.screening).toMatchObject({ status: "held", error: "screening_unavailable", retryable: true });
    const plain = await ingest(null);
    expect(((await (await send(`/api/v1/events/${plain}`, { cookies })).json()) as ManagedEventDetail).screening).toBeNull();
  });
});

function release(eventId: string, as = cookies, sendEnv: Record<string, unknown> = { DELIVERY_QUEUE: queue }) {
  return send(`/api/v1/events/${eventId}/screening/release`, { method: "POST", cookies: as, env: sendEnv });
}

function retry(eventId: string, as = cookies, sendEnv: Record<string, unknown> = { DELIVERY_QUEUE: queue }) {
  return send(`/api/v1/events/${eventId}/screening/retry`, { method: "POST", cookies: as, env: sendEnv });
}

async function deliveryIdsOf(eventId: string): Promise<string[]> {
  return (await listDeliveries("event_id = ?", eventId)).map((row) => row.id);
}

describe("POST /api/v1/events/:id/screening/release", () => {
  it("releases a held event and queues its deliveries", async () => {
    const held = await ingest("held");
    const res = await release(held);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ManagedEventDetail).screening?.status).toBe("released");
    const row = await eventScreening(held);
    expect(row?.screening_status).toBe("released");
    expect(row?.screening_released_by).toBe(owner.id);
    expect(row?.screening_released_at).not.toBeNull();
    expect(queue.messages).toEqual((await deliveryIdsOf(held)).map((id) => ({ delivery_id: id })));
  });

  it("queues the deliveries of a released event again without changing the first release", async () => {
    const held = await ingest("held");
    await env.DB.prepare("UPDATE events SET screening_status = 'released', screening_released_at = 1, screening_released_by = 'first' WHERE id = ?")
      .bind(held)
      .run();
    const res = await release(held);
    expect(res.status).toBe(200);
    expect(await eventScreening(held)).toMatchObject({ screening_released_at: 1, screening_released_by: "first" });
    expect(queue.messages).toEqual((await deliveryIdsOf(held)).map((id) => ({ delivery_id: id })));
  });

  it.each(["pending", "passed", null])("is 409 for an event in %s", async (status) => {
    const eventId = await ingest(status);
    const res = await release(eventId);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("not_releasable");
    expect(queue.messages).toEqual([]);
  });

  it("is 404 for an event of another workspace", async () => {
    const held = await ingest("held");
    const res = await release(held, otherCookies);
    expect(res.status).toBe(404);
    expect((await eventScreening(held))?.screening_status).toBe("held");
  });

  it("answers 503 and stays released when the deliveries cannot be queued", async () => {
    const held = await ingest("held");
    queue.fail = true;
    const res = await release(held);
    expect(res.status).toBe(503);
    expect((await eventScreening(held))?.screening_status).toBe("released");
  });
});

describe("POST /api/v1/events/:id/screening/retry", () => {
  it.each([
    "screening_unavailable",
    "screening_auth_failed",
    "screening_not_configured",
    "screening_rejected",
    "screening_invalid_response",
  ])("screens an event held as %s again", async (error) => {
    const held = await ingest("held");
    await env.DB.prepare("UPDATE events SET screening_error = ?, screened_at = 1 WHERE id = ?").bind(error, held).run();
    const res = await retry(held);
    expect(res.status).toBe(200);
    expect(await eventScreening(held)).toMatchObject({
      screening_status: "pending",
      screening_error: null,
      screening_score: null,
      screened_at: null,
    });
    expect(queue.messages).toEqual([{ kind: "screen", event_id: held }]);
  });

  it.each([
    ["held by its score", "held", null],
    ["held as too large", "held", "screening_too_large"],
    ["held for missing data", "held", "screening_data_missing"],
    ["passed", "passed", null],
    ["released", "released", null],
  ])("is 409 for an event %s", async (_, status, error) => {
    const eventId = await ingest(status);
    await env.DB.prepare("UPDATE events SET screening_error = ?, screening_score = 0.9 WHERE id = ?").bind(error, eventId).run();
    const res = await retry(eventId);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("not_retryable");
    expect((await eventScreening(eventId))?.screening_status).toBe(status);
    expect(queue.messages).toEqual([]);
  });

  it("is 409 for an event not screened", async () => {
    const plain = await ingest(null);
    expect((await retry(plain)).status).toBe(409);
  });

  it("sends the screening of an event pending for 10 minutes again", async () => {
    const pending = await ingest("pending");
    await env.DB.prepare("UPDATE events SET screening_requested_at = ? WHERE id = ?").bind(Date.now() - 9 * MINUTE, pending).run();
    expect((await retry(pending)).status).toBe(409);
    await env.DB.prepare("UPDATE events SET screening_requested_at = ? WHERE id = ?").bind(Date.now() - 11 * MINUTE, pending).run();
    expect((await retry(pending)).status).toBe(200);
    expect(queue.messages).toEqual([{ kind: "screen", event_id: pending }]);
  });

  it("is 404 for an event of another workspace", async () => {
    const held = await ingest("held");
    await env.DB.prepare("UPDATE events SET screening_error = 'screening_unavailable' WHERE id = ?").bind(held).run();
    expect((await retry(held, otherCookies)).status).toBe(404);
    expect((await eventScreening(held))?.screening_status).toBe("held");
  });

  it("answers 503 when the screening cannot be queued, leaving the event pending", async () => {
    const held = await ingest("held");
    await env.DB.prepare("UPDATE events SET screening_error = 'screening_unavailable' WHERE id = ?").bind(held).run();
    queue.fail = true;
    expect((await retry(held)).status).toBe(503);
    expect((await eventScreening(held))?.screening_status).toBe("pending");
  });
});

describe("POST /api/v1/deliveries/:id/retry", () => {
  it.each([
    ["held", "screening_held"],
    ["pending", "screening_pending"],
  ])("is 409 for a failed delivery of an event %s", async (status, code) => {
    const eventId = await ingest(status);
    const [deliveryId] = await deliveryIdsOf(eventId);
    await env.DB.prepare("UPDATE deliveries SET status = 'failed', last_error = 'dead_lettered' WHERE id = ?").bind(deliveryId).run();
    const res = await send(`/api/v1/deliveries/${deliveryId}/retry`, { method: "POST", cookies, env: { DELIVERY_QUEUE: queue } });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe(code);
    expect((await listDeliveries("id = ?", deliveryId))[0]?.status).toBe("failed");
    expect(queue.messages).toEqual([]);
  });

  it("sends a failed delivery of a released event again", async () => {
    const eventId = await ingest("released");
    const [deliveryId] = await deliveryIdsOf(eventId);
    await env.DB.prepare("UPDATE deliveries SET status = 'failed' WHERE id = ?").bind(deliveryId).run();
    const res = await send(`/api/v1/deliveries/${deliveryId}/retry`, { method: "POST", cookies, env: { DELIVERY_QUEUE: queue } });
    expect(res.status).toBe(200);
  });
});

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function callTool(connectionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const ctx = Object.assign(createExecutionContext(), {
    props: { userId: owner.id, authMode: "password", authorizedAt: clock.now(), connectionId },
    auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"], clientId: "test-client" },
  }) as unknown as OAuthResourceContext<unknown>;
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await core.mcpHandler.fetch(request, env, ctx);
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: ToolResult }).result;
}

function parse<T>(result: ToolResult): T {
  return JSON.parse(result.content[0]?.text ?? "null") as T;
}

describe("MCP and the screening", () => {
  let connectionId: string;
  let queueId: string;

  beforeEach(async () => {
    const pollingQueue = await createQueue({ user: owner });
    queueId = pollingQueue.id;
    const routed = await routeToBot(pollingQueue, [source.id], { connect: true });
    if (routed.connectionId === null) throw new Error("no connection");
    connectionId = routed.connectionId;
  });

  it.each(["held", "pending"])("does not list an event %s, or let it be read", async (status) => {
    const hidden = await ingest(status, { body: { content_type: "text/plain", bytes: new TextEncoder().encode("secret") } });
    const visible = await ingest(null);
    const list = parse<{ events: { event_id: string }[] }>(await callTool(connectionId, "list_events", {}));
    expect(list.events.map((event) => event.event_id)).toEqual([visible]);

    const event = await callTool(connectionId, "get_event", { event_id: hidden });
    expect(event.isError).toBe(true);
    expect(parse<{ error: { code: string } }>(event).error.code).toBe("not_found");

    const row = await env.DB.prepare("SELECT id FROM event_data WHERE event_id = ?").bind(hidden).first<{ id: string }>();
    const data = await callTool(connectionId, "read_data", { data_ref: row?.id });
    expect(data.isError).toBe(true);
    expect(parse<{ error: { code: string } }>(data).error.code).toBe("not_found");
  });

  it.each(["passed", "released"])("lists and reads an event %s", async (status) => {
    const shown = await ingest(status, { body: { content_type: "text/plain", bytes: new TextEncoder().encode("ok") } });
    const list = parse<{ events: { event_id: string }[] }>(await callTool(connectionId, "list_events", {}));
    expect(list.events.map((event) => event.event_id)).toEqual([shown]);
    expect((await callTool(connectionId, "get_event", { event_id: shown })).isError).toBeUndefined();
  });

  it("does not claim the deliveries of held or pending events", async () => {
    await ingest("held");
    await ingest("pending");
    const shown = await ingest("passed");
    const claimed = await claimQueueDeliveries(env.DB, createDb(env.DB), {
      workspaceId: workspace.id,
      queueId,
      now: Date.now(),
      limit: 10,
    });
    expect(claimed.items.map((item) => item.event.event_id)).toEqual([shown]);
  });
});
