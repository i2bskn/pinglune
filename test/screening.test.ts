import { createExecutionContext, createMessageBatch, getQueueResult, type QueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import type { SourceRow, UserRow, WorkspaceRow } from "../src/db/schema";
import { enqueuePendingDeliveries } from "../src/deliveries/enqueue";
import type { Bindings } from "../src/env";
import worker from "../src/index";
import { handleEmail } from "../src/intake/email";
import { acceptEvent } from "../src/intake/service";
import type { IntakeInput } from "../src/intake/validation";
import { runDailyMaintenance } from "../src/maintenance/daily";
import { encryptApiKey } from "../src/screening/api-key";
import {
  bucketWith,
  createApiKey,
  createEmailAddress,
  createSource,
  createSubscription,
  createUser,
  fakeQueue,
  listDeliveries,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  routeToBot,
  send,
  TEST_JWT_SECRET,
  type FakeQueue,
} from "./helpers";

const MINUTE = 60_000;
const KIB = 1024;
const DELIVERY_QUEUE = "pinglune-deliveries";
const DEAD_LETTER_QUEUE = "pinglune-deliveries-dlq";
const CALLBACK_HOST = "hooks.example.com";
const API_KEY = "ts_live_secret_key_abcd";
// The props of the INTAKE binding in vitest.config.ts.
const RPC_SOURCE_ID = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
const EMAIL_DOMAIN = "example.com";
const LOCAL_PART = "abcdefghij0123456789";

type JevState = {
  type: string;
  summary: string;
  labels: Record<string, string>;
  data: { name: string; content_type: string }[];
  part?: { index: number; total: number; text: string };
};
type JevCall = { authorization: string | null; model: unknown; state: JevState; questions: unknown };

let owner: UserRow;
let workspace: WorkspaceRow;
let source: SourceRow;
let now: number;
let queue: FakeQueue;
let jevCalls: JevCall[];
let jevRespond: (state: JevState, call: number) => Response | Promise<Response>;
let callbacks: string[];
let sequence = 0;

function score(value: unknown): Response {
  return Response.json({ answers: { ai_directed: { noul: value } }, usage: { input_tokens: 7 } });
}

async function setApiKey(stored: string | null): Promise<void> {
  await env.DB.prepare("UPDATE workspaces SET screening_api_key = ?, screening_api_key_hint = ? WHERE id = ?")
    .bind(stored, stored === null ? null : "abcd", workspace.id)
    .run();
}

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  owner = await createUser({ email: "owner@example.com" });
  workspace = await personalWorkspaceOf(owner);
  source = await createSource({ workspaceId: workspace.id, name: "mail" });
  await env.DB.prepare("UPDATE sources SET screening_enabled = 1 WHERE id = ?").bind(source.id).run();
  const subscription = await createSubscription({ user: owner, callbackUrl: `https://${CALLBACK_HOST}/hook` });
  await routeToBot(subscription, [source.id]);
  await setApiKey(await encryptApiKey(TEST_JWT_SECRET, workspace.id, API_KEY));
  queue = fakeQueue();
  jevCalls = [];
  callbacks = [];
  jevRespond = () => score(0.1);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://api.typesafe.ai" && url.pathname === "/v1/systemone") {
      const body = (await request.json()) as { model: unknown; state: JevState; questions: unknown };
      jevCalls.push({
        authorization: request.headers.get("authorization"),
        model: body.model,
        state: body.state,
        questions: body.questions,
      });
      return jevRespond(body.state, jevCalls.length - 1);
    }
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type");
      const records = type === "A" ? [{ name, type: 1, TTL: 60, data: "93.184.216.34" }] : [];
      return Response.json({ Status: 0, Answer: records });
    }
    if (url.hostname === CALLBACK_HOST) {
      callbacks.push(request.url);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${request.url}`);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

function text(value: string, contentType = "text/plain; charset=utf-8") {
  return { content_type: contentType, bytes: new TextEncoder().encode(value) };
}

// Accepts an event of the source through the shared intake, with the screening of the source as given.
async function ingest(
  input: Partial<IntakeInput> = {},
  options: { screening?: boolean; queue?: FakeQueue; key?: string } = {},
): Promise<string> {
  sequence++;
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue: options.queue ?? fakeQueue(), now },
    { id: source.id, workspaceId: workspace.id, name: source.name, enabled: true, screeningEnabled: options.screening ?? true },
    { idempotency_key: options.key ?? `k-${sequence}`, type: "email.received", summary: `s${sequence}`, ...input },
  );
  if (!result.ok) throw new Error(`ingest failed: ${result.error.code}`);
  return result.event_id;
}

type EventScreeningRecord = {
  screening_status: string | null;
  screening_score: number | null;
  screening_error: string | null;
  screening_requested_at: number | null;
  screened_at: number | null;
};

async function screeningOf(eventId: string): Promise<EventScreeningRecord | null> {
  return env.DB.prepare(
    "SELECT screening_status, screening_score, screening_error, screening_requested_at, screened_at FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first<EventScreeningRecord>();
}

async function setScreening(eventId: string, columns: string, ...values: unknown[]): Promise<void> {
  await env.DB.prepare(`UPDATE events SET ${columns} WHERE id = ?`)
    .bind(...values, eventId)
    .run();
}

type RunResult = QueueResult & { retryOptions: (QueueRetryOptions | undefined)[] };

type Message = { id?: string; body: unknown; attempts?: number };

// Runs the queue handler on the messages, with the fake queue as DELIVERY_QUEUE.
async function run(
  messages: Message[],
  options: { queue?: string; env?: Partial<Bindings> } = {},
): Promise<RunResult> {
  const batch = createMessageBatch(
    options.queue ?? DELIVERY_QUEUE,
    messages.map((message, index) => ({
      id: message.id ?? `msg-${index + 1}`,
      timestamp: new Date(now),
      attempts: message.attempts ?? 1,
      body: message.body,
    })),
  );
  const retryOptions: (QueueRetryOptions | undefined)[] = [];
  for (const message of batch.messages) {
    const retry = message.retry.bind(message);
    vi.spyOn(message, "retry").mockImplementation((retryOptionsArg?: QueueRetryOptions) => {
      retryOptions.push(retryOptionsArg);
      retry(retryOptionsArg);
    });
  }
  const ctx = createExecutionContext();
  await worker.queue(batch, { ...env, DELIVERY_QUEUE: queue, ...options.env });
  return { ...(await getQueueResult(batch, ctx)), retryOptions };
}

function screen(eventId: string, options: { attempts?: number; queue?: string; env?: Partial<Bindings> } = {}) {
  return run([{ body: { kind: "screen", event_id: eventId }, attempts: options.attempts }], options);
}

function expectAck(result: RunResult): void {
  expect(result.explicitAcks).toEqual(["msg-1"]);
  expect(result.retryMessages).toEqual([]);
}

function expectRetry(result: RunResult, delaySeconds: number): void {
  expect(result.explicitAcks).toEqual([]);
  expect(result.retryMessages.map((message) => message.msgId)).toEqual(["msg-1"]);
  expect(result.retryOptions).toEqual([{ delaySeconds }]);
}

async function deliveryIdsOf(eventId: string): Promise<string[]> {
  return (await listDeliveries("event_id = ?", eventId)).map((row) => row.id);
}

describe("the intake of a source with screening", () => {
  it("stores the event pending and queues only its screening", async () => {
    const eventId = await ingest({}, { queue });
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "pending", screening_requested_at: now });
    expect(queue.messages).toEqual([{ kind: "screen", event_id: eventId }]);
    // The deliveries are created with the event, and wait.
    expect(await listDeliveries("event_id = ?", eventId)).toMatchObject([{ status: "pending", attempts: 0 }]);
  });

  it("screens an event without destinations too", async () => {
    await env.DB.prepare("DELETE FROM bot_sources").run();
    const eventId = await ingest({}, { queue });
    expect(await listDeliveries("event_id = ?", eventId)).toEqual([]);
    expect(queue.messages).toEqual([{ kind: "screen", event_id: eventId }]);
  });

  it("queues the deliveries of a source without screening as before", async () => {
    const eventId = await ingest({}, { queue, screening: false });
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: null, screening_requested_at: null });
    expect(queue.messages).toEqual((await deliveryIdsOf(eventId)).map((id) => ({ delivery_id: id })));
  });

  it("reads the setting of the source on the HTTP intake", async () => {
    const { key } = await createApiKey(source.id);
    const res = await send("/ingest/v1/events", {
      json: { idempotency_key: "http-1", type: "alert.observed", summary: "s" },
      headers: { Authorization: `Bearer ${key}` },
      env: { DELIVERY_QUEUE: queue },
    });
    expect(res.status).toBe(201);
    const { event_id: eventId } = (await res.json()) as { event_id: string };
    expect((await screeningOf(eventId))?.screening_status).toBe("pending");
    expect(queue.messages).toEqual([{ kind: "screen", event_id: eventId }]);

    await env.DB.prepare("UPDATE sources SET screening_enabled = 0 WHERE id = ?").bind(source.id).run();
    const plain = await send("/ingest/v1/events", {
      json: { idempotency_key: "http-2", type: "alert.observed", summary: "s" },
      headers: { Authorization: `Bearer ${key}` },
      env: { DELIVERY_QUEUE: queue },
    });
    const { event_id: plainId } = (await plain.json()) as { event_id: string };
    expect((await screeningOf(plainId))?.screening_status).toBeNull();
    expect(queue.messages.slice(1)).toEqual((await deliveryIdsOf(plainId)).map((id) => ({ delivery_id: id })));
  });

  it("reads the setting of the source on the email intake", async () => {
    await createEmailAddress(source.id, { localPart: LOCAL_PART });
    const raw = ["From: a@example.net", "Subject: hello", "Message-ID: <m1@example.net>", "", "body", ""].join("\r\n");
    const bytes = new TextEncoder().encode(raw);
    const rejects: string[] = [];
    const message = {
      from: "a@example.net",
      to: `${LOCAL_PART}@${EMAIL_DOMAIN}`,
      headers: new Headers(),
      raw: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      rawSize: bytes.byteLength,
      setReject(reason: string) {
        rejects.push(reason);
      },
    } as unknown as ForwardableEmailMessage;
    await handleEmail(message, { ...env, EMAIL_DOMAIN, DELIVERY_QUEUE: queue });
    expect(rejects).toEqual([]);
    const row = await env.DB.prepare("SELECT id, screening_status FROM events").first<{ id: string; screening_status: string }>();
    expect(row?.screening_status).toBe("pending");
    expect(queue.messages).toEqual([{ kind: "screen", event_id: row?.id }]);
  });

  it("reads the setting of the source on Service Bindings", async () => {
    await createSource({ id: RPC_SOURCE_ID, workspaceId: workspace.id, name: "worker" });
    await env.DB.prepare("UPDATE sources SET screening_enabled = 1 WHERE id = ?").bind(RPC_SOURCE_ID).run();
    const result = await env.INTAKE.submit({ idempotency_key: "rpc-1", type: "alert.observed", summary: "s" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect((await screeningOf(result.event_id))?.screening_status).toBe("pending");
  });

  it("queues the screening again on a duplicate of a pending event, and nothing for a held one", async () => {
    const eventId = await ingest({ summary: "dup" }, { key: "dup" });
    await ingest({ summary: "dup" }, { key: "dup", queue });
    expect(queue.messages).toEqual([{ kind: "screen", event_id: eventId }]);

    await setScreening(eventId, "screening_status = 'held'");
    const again = fakeQueue();
    await ingest({ summary: "dup" }, { key: "dup", queue: again });
    expect(again.messages).toEqual([]);

    await setScreening(eventId, "screening_status = 'passed'");
    const passed = fakeQueue();
    await ingest({ summary: "dup" }, { key: "dup", queue: passed });
    expect(passed.messages).toEqual((await deliveryIdsOf(eventId)).map((id) => ({ delivery_id: id })));
  });
});

describe("the screening of an event", () => {
  it("passes a score below the threshold and queues the deliveries", async () => {
    const eventId = await ingest({ body: text("hello") });
    jevRespond = () => score(0.49);
    expectAck(await screen(eventId));
    expect(await screeningOf(eventId)).toMatchObject({
      screening_status: "passed",
      screening_score: 0.49,
      screening_error: null,
      screened_at: now,
    });
    expect(queue.messages).toEqual((await deliveryIdsOf(eventId)).map((id) => ({ delivery_id: id })));
    // The key of the workspace, the fixed model and the question.
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]).toMatchObject({
      authorization: `Bearer ${API_KEY}`,
      model: "jev-1.14.0",
      questions: { ai_directed: { type: "noul" } },
    });
  });

  it("holds a score at the threshold and queues nothing", async () => {
    const eventId = await ingest({ body: text("hello") });
    jevRespond = () => score(0.5);
    expectAck(await screen(eventId));
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "held", screening_score: 0.5, screening_error: null });
    expect(queue.messages).toEqual([]);
  });

  it("uses SCREENING_THRESHOLD, and 0.5 for an invalid value", async () => {
    jevRespond = () => score(0.6);
    const passed = await ingest();
    await screen(passed, { env: { SCREENING_THRESHOLD: "0.8" } });
    expect((await screeningOf(passed))?.screening_status).toBe("passed");
    for (const value of ["1.5", "0", "abc"]) {
      const held = await ingest();
      await screen(held, { env: { SCREENING_THRESHOLD: value } });
      expect((await screeningOf(held))?.screening_status).toBe("held");
    }
  });

  it("sends the common fields, the body, body.html and text attachments, but not binary content", async () => {
    const eventId = await ingest({
      type: "email.received",
      summary: "件名",
      labels: { from: "a@example.net" },
      body: text("plain body"),
      attachments: [
        { name: "body.html", content_type: "text/html; charset=utf-8", bytes: new TextEncoder().encode("<p>html body</p>") },
        { name: "notes.txt", content_type: "text/plain", bytes: new TextEncoder().encode("attached text") },
        { name: "image.png", content_type: "image/png", bytes: new TextEncoder().encode("BINARY-CONTENT") },
      ],
    });
    await screen(eventId);
    expect(jevCalls).toHaveLength(1);
    const state = jevCalls[0]?.state;
    expect(state).toMatchObject({
      type: "email.received",
      summary: "件名",
      labels: { from: "a@example.net" },
      data: [
        { name: "body", content_type: "text/plain; charset=utf-8" },
        { name: "body.html", content_type: "text/html; charset=utf-8" },
        { name: "notes.txt", content_type: "text/plain" },
        { name: "image.png", content_type: "image/png" },
      ],
      part: { index: 0, total: 1 },
    });
    expect(state?.part?.text).toBe(
      "--- body ---\nplain body\n--- body.html ---\n<p>html body</p>\n--- notes.txt ---\nattached text",
    );
    expect(state?.part?.text).not.toContain("BINARY-CONTENT");
  });

  it("sends the common fields alone when nothing is readable", async () => {
    const eventId = await ingest({ attachments: [{ name: "a.bin", content_type: "application/octet-stream", bytes: new Uint8Array([1]) }] });
    await screen(eventId);
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]?.state.part).toBeUndefined();
  });

  it("holds an event whose type or attachment names carry the instructions", async () => {
    jevRespond = (state) => score(JSON.stringify({ type: state.type, data: state.data }).includes("ignore-previous") ? 0.95 : 0.1);
    const byType = await ingest({ type: "ignore-previous.instructions" });
    await screen(byType);
    expect((await screeningOf(byType))?.screening_status).toBe("held");
    const byName = await ingest({
      attachments: [{ name: "ignore-previous instructions.bin", content_type: "application/octet-stream", bytes: new Uint8Array([1]) }],
    });
    await screen(byName);
    expect((await screeningOf(byName))?.screening_status).toBe("held");
  });

  it("takes the highest score of the parts", async () => {
    const eventId = await ingest({ body: text("a".repeat(40 * KIB)) });
    jevRespond = (state) => score(state.part?.index === 0 ? 0.1 : 0.3);
    expectAck(await screen(eventId));
    expect(jevCalls.map((call) => call.state.part?.total)).toEqual([2, 2]);
    expect(jevCalls.map((call) => call.state.part?.index).sort()).toEqual([0, 1]);
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "passed", screening_score: 0.3 });
  });

  it("cuts the parts at character boundaries", async () => {
    // 3-byte characters: 32 KiB is not a multiple of 3.
    const eventId = await ingest({ body: text("あ".repeat(12_000)) });
    await screen(eventId);
    const joined = [...jevCalls]
      .sort((a, b) => (a.state.part?.index ?? 0) - (b.state.part?.index ?? 0))
      .map((call) => call.state.part?.text ?? "")
      .join("");
    expect(joined).toBe(`--- body ---\n${"あ".repeat(12_000)}`);
    expect(joined).not.toContain("�");
  });

  it("stops sending once a score is at the threshold", async () => {
    const eventId = await ingest({ body: text("a".repeat(100 * KIB)) });
    jevRespond = () => score(0.9);
    expectAck(await screen(eventId));
    // 4 parts, 2 at a time: the first two answer at the threshold, so the rest is not sent.
    expect(jevCalls[0]?.state.part?.total).toBe(4);
    expect(jevCalls).toHaveLength(2);
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "held", screening_score: 0.9 });
  });

  it("holds an event of more than 256 KiB of text without calling Jev", async () => {
    const eventId = await ingest({ body: text("a".repeat(256 * KIB)) });
    expectAck(await screen(eventId));
    expect(jevCalls).toEqual([]);
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "held", screening_error: "screening_too_large" });
  });

  it("holds an event whose common fields are more than 16 KiB without calling Jev", async () => {
    const labels: Record<string, string> = {};
    for (let i = 0; i < 16; i++) labels[`k${i}`] = "あ".repeat(256);
    const eventId = await ingest({ summary: "あ".repeat(2000), labels });
    expectAck(await screen(eventId));
    expect(jevCalls).toEqual([]);
    expect((await screeningOf(eventId))?.screening_error).toBe("screening_too_large");
  });

  it("prefers a score at the threshold to a failure to retry", async () => {
    const eventId = await ingest({ body: text("a".repeat(40 * KIB)) });
    jevRespond = (state) => (state.part?.index === 0 ? score(0.9) : new Response(null, { status: 429 }));
    expectAck(await screen(eventId));
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "held", screening_score: 0.9 });
  });

  it("retries rather than holding when a request may succeed later", async () => {
    const eventId = await ingest({ body: text("a".repeat(40 * KIB)) });
    jevRespond = (state) => new Response(null, { status: state.part?.index === 0 ? 400 : 429 });
    expectRetry(await screen(eventId), 30);
    // Nothing is saved.
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "pending", screening_score: null, screening_error: null });
  });

  it("takes the reason higher in the table when requests fail in different ways", async () => {
    const eventId = await ingest({ body: text("a".repeat(40 * KIB)) });
    jevRespond = (state) => new Response(null, { status: state.part?.index === 0 ? 400 : 401 });
    expectAck(await screen(eventId));
    expect((await screeningOf(eventId))?.screening_error).toBe("screening_auth_failed");
  });

  it.each([
    [401, "screening_auth_failed"],
    [403, "screening_auth_failed"],
    [400, "screening_rejected"],
    [413, "screening_rejected"],
    [415, "screening_rejected"],
    [422, "screening_rejected"],
  ])("holds an event on %i without retrying", async (status, error) => {
    const eventId = await ingest();
    jevRespond = () => new Response("{}", { status });
    expectAck(await screen(eventId));
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "held", screening_score: null, screening_error: error });
  });

  it.each([
    ["no answer", () => Response.json({ answers: {} })],
    ["a score above 1", () => score(1.5)],
    ["a score below 0", () => score(-0.1)],
    ["a string", () => score("0.1")],
    ["a body that is not JSON", () => new Response("not json", { status: 200 })],
  ])("holds an event on a 2xx with %s", async (_, response) => {
    const eventId = await ingest();
    jevRespond = response;
    expectAck(await screen(eventId));
    expect((await screeningOf(eventId))?.screening_error).toBe("screening_invalid_response");
  });

  it.each([429, 500, 503, 520, 529, 302, 404])("retries on %i with the backoff of the deliveries", async (status) => {
    const eventId = await ingest();
    jevRespond = () => new Response(null, { status, headers: status === 302 ? { Location: "https://example.com/" } : {} });
    expectRetry(await screen(eventId, { attempts: 3 }), 120);
    expect((await screeningOf(eventId))?.screening_status).toBe("pending");
  });

  it("retries on a network error", async () => {
    const eventId = await ingest();
    jevRespond = () => {
      throw new TypeError("network down");
    };
    expectRetry(await screen(eventId), 30);
  });

  it("waits for retry-after in seconds or as an HTTP-date, up to 12 hours", async () => {
    const eventId = await ingest();
    jevRespond = () => new Response(null, { status: 429, headers: { "retry-after": "600" } });
    expectRetry(await screen(eventId), 600);
    jevRespond = () => new Response(null, { status: 503, headers: { "retry-after": new Date(now + 900_000).toUTCString() } });
    const dated = await screen(eventId);
    // An HTTP-date has a resolution of a second.
    expect(dated.retryOptions[0]?.delaySeconds).toBeGreaterThanOrEqual(899);
    expect(dated.retryOptions[0]?.delaySeconds).toBeLessThanOrEqual(900);
    jevRespond = () => new Response(null, { status: 429, headers: { "retry-after": "100000" } });
    expectRetry(await screen(eventId), 43_200);
    // The backoff when it is longer.
    jevRespond = () => new Response(null, { status: 429, headers: { "retry-after": "1" } });
    expectRetry(await screen(eventId, { attempts: 4 }), 240);
  });

  it("holds an event when the workspace has no API key", async () => {
    await setApiKey(null);
    const eventId = await ingest();
    expectAck(await screen(eventId));
    expect(jevCalls).toEqual([]);
    expect((await screeningOf(eventId))?.screening_error).toBe("screening_not_configured");
  });

  it("holds an event when the stored key belongs to another workspace or another JWT_SECRET", async () => {
    await setApiKey(await encryptApiKey(TEST_JWT_SECRET, "another-workspace", API_KEY));
    const other = await ingest();
    await screen(other);
    expect((await screeningOf(other))?.screening_error).toBe("screening_not_configured");

    await setApiKey(await encryptApiKey("another-secret-another-secret-0123456", workspace.id, API_KEY));
    const rotated = await ingest();
    await screen(rotated);
    expect((await screeningOf(rotated))?.screening_error).toBe("screening_not_configured");
    expect(jevCalls).toEqual([]);
  });

  it("holds an event whose data is missing from R2", async () => {
    const eventId = await ingest({ body: text("hello") });
    const row = await env.DB.prepare("SELECT r2_key FROM event_data WHERE event_id = ?").bind(eventId).first<{ r2_key: string }>();
    await env.EVENT_DATA.delete(row?.r2_key ?? "");
    expectAck(await screen(eventId));
    expect(jevCalls).toEqual([]);
    expect((await screeningOf(eventId))?.screening_error).toBe("screening_data_missing");
  });

  it("never calls Jev for an event that is not pending", async () => {
    const held = await ingest();
    await setScreening(held, "screening_status = 'held'");
    expectAck(await screen(held));
    const plain = await ingest({}, { screening: false });
    expectAck(await screen(plain));
    expectAck(await screen("evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V"));
    expect(jevCalls).toEqual([]);
    expect(queue.messages).toEqual([]);

    // A passed or released event gets its deliveries queued, without screening again.
    const passed = await ingest();
    await setScreening(passed, "screening_status = 'passed'");
    expectAck(await screen(passed));
    expect(jevCalls).toEqual([]);
    expect(queue.messages).toEqual((await deliveryIdsOf(passed)).map((id) => ({ delivery_id: id })));
  });

  it("retries when the deliveries of a passed event cannot be queued, and queues them on the next try", async () => {
    const eventId = await ingest();
    queue.fail = true;
    expectRetry(await screen(eventId), 30);
    expect((await screeningOf(eventId))?.screening_status).toBe("passed");
    expect(jevCalls).toHaveLength(1);

    queue.fail = false;
    expectAck(await screen(eventId, { attempts: 2 }));
    expect(jevCalls).toHaveLength(1);
    expect(queue.messages).toEqual((await deliveryIdsOf(eventId)).map((id) => ({ delivery_id: id })));
  });

  it("reads the event again when another consumer wrote first", async () => {
    const eventId = await ingest();
    jevRespond = async () => {
      // Another consumer held it while Jev was answering.
      await setScreening(eventId, "screening_status = 'held', screening_score = 0.7");
      return score(0.1);
    };
    expectAck(await screen(eventId));
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "held", screening_score: 0.7 });
    expect(queue.messages).toEqual([]);
  });

  it("keeps an exception from the other messages of the batch", async () => {
    const pending = await ingest({ body: text("hello") });
    const plain = await ingest({}, { screening: false });
    const [deliveryId] = await deliveryIdsOf(plain);
    const failing = bucketWith({
      get: () => {
        throw new Error("R2 is down");
      },
    });
    const result = await run([{ body: { kind: "screen", event_id: pending } }, { body: { delivery_id: deliveryId } }], {
      env: { EVENT_DATA: failing },
    });
    expect(result.explicitAcks).toEqual(["msg-2"]);
    expect(result.retryMessages.map((message) => message.msgId)).toEqual(["msg-1"]);
    expect(result.retryOptions).toEqual([{ delaySeconds: 30 }]);
    expect(callbacks).toHaveLength(1);
    expect((await listDeliveries("id = ?", deliveryId))[0]?.status).toBe("delivered");
  });

  it.each([
    ["an unknown kind", { kind: "other", event_id: "evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V" }],
    ["an event_id that is not a string", { kind: "screen", event_id: 1 }],
    ["a malformed event_id", { kind: "screen", event_id: "evt_x" }],
  ])("acknowledges a message with %s", async (_, body) => {
    expectAck(await run([{ body }]));
    expect(jevCalls).toEqual([]);
  });
});

describe("the dead letter queue of the screening", () => {
  it("holds a pending event as screening_unavailable", async () => {
    const eventId = await ingest();
    expectAck(await screen(eventId, { queue: DEAD_LETTER_QUEUE }));
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "held", screening_error: "screening_unavailable" });
    expect(jevCalls).toEqual([]);
  });

  it("queues the deliveries of a passed event", async () => {
    const eventId = await ingest();
    await setScreening(eventId, "screening_status = 'passed'");
    expectAck(await screen(eventId, { queue: DEAD_LETTER_QUEUE }));
    expect(queue.messages).toEqual((await deliveryIdsOf(eventId)).map((id) => ({ delivery_id: id })));
    expect((await screeningOf(eventId))?.screening_status).toBe("passed");
  });

  it("acknowledges a held event without changing it", async () => {
    const eventId = await ingest();
    await setScreening(eventId, "screening_status = 'held', screening_score = 0.9");
    expectAck(await screen(eventId, { queue: DEAD_LETTER_QUEUE }));
    expect(await screeningOf(eventId)).toMatchObject({ screening_status: "held", screening_score: 0.9, screening_error: null });
  });
});

describe("the deliveries of an event held or pending", () => {
  it.each(["held", "pending"])("are not sent while the event is %s", async (status) => {
    const eventId = await ingest();
    await setScreening(eventId, "screening_status = ?", status);
    const [deliveryId] = await deliveryIdsOf(eventId);
    expectAck(await run([{ body: { delivery_id: deliveryId } }]));
    expect(callbacks).toEqual([]);
    expect((await listDeliveries("id = ?", deliveryId))[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it.each(["held", "pending"])("are not queued while the event is %s", async (status) => {
    const eventId = await ingest();
    await setScreening(eventId, "screening_status = ?", status);
    expect(await enqueuePendingDeliveries({ db: env.DB, queue }, eventId)).toBe(true);
    expect(queue.messages).toEqual([]);
  });

  it.each(["passed", "released"])("are sent once the event is %s", async (status) => {
    const eventId = await ingest();
    await setScreening(eventId, "screening_status = ?", status);
    const [deliveryId] = await deliveryIdsOf(eventId);
    expectAck(await run([{ body: { delivery_id: deliveryId } }]));
    expect(callbacks).toHaveLength(1);
  });
});

describe("the daily maintenance of the screening", () => {
  it("queues the screening of events pending for 30 minutes or more", async () => {
    const old = await ingest();
    await setScreening(old, "screening_requested_at = ?", now - 31 * MINUTE);
    const recent = await ingest();
    await setScreening(recent, "screening_requested_at = ?", now - 29 * MINUTE);
    await runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, queue, now });
    expect(queue.messages).toEqual([{ kind: "screen", event_id: old }]);
  });

  it("queues the unsent deliveries of passed and released events again after 30 minutes", async () => {
    const passed = await ingest();
    const released = await ingest();
    const held = await ingest();
    const recent = await ingest();
    await setScreening(passed, "screening_status = 'passed'");
    await setScreening(released, "screening_status = 'released'");
    await setScreening(held, "screening_status = 'held'");
    await setScreening(recent, "screening_status = 'passed'");
    for (const eventId of [passed, released, held]) {
      await env.DB.prepare("UPDATE deliveries SET created_at = ? WHERE event_id = ?").bind(now - 31 * MINUTE, eventId).run();
    }
    await runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, queue, now });
    const expected = [...(await deliveryIdsOf(passed)), ...(await deliveryIdsOf(released))];
    expect(queue.messages.map((message) => ("delivery_id" in message ? message.delivery_id : null)).sort()).toEqual(
      expected.sort(),
    );
  });

  it("leaves the deliveries of held and pending events out of the stale pending log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const held = await ingest();
    await setScreening(held, "screening_status = 'held'");
    await env.DB.prepare("UPDATE deliveries SET created_at = ?").bind(now - 2 * 60 * MINUTE).run();
    await runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, queue, now });
    expect(warn.mock.calls.filter(([message]) => message === "stale pending deliveries")).toEqual([]);

    await setScreening(held, "screening_status = 'passed'");
    await runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, queue, now });
    expect(warn.mock.calls.filter(([message]) => message === "stale pending deliveries")).toHaveLength(1);
  });

  it("reads the pending events with events_screening_pending_idx", async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM events INDEXED BY events_screening_pending_idx
      WHERE screening_status = 'pending' AND screening_requested_at < ? ORDER BY screening_requested_at LIMIT ?`,
    )
      .bind(now, 100)
      .all<{ detail: string }>();
    expect(results.map((row) => row.detail).join("\n")).toContain("events_screening_pending_idx");
  });
});
