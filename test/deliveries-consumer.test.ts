import { createExecutionContext, createMessageBatch, getQueueResult, type QueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import { users, type SourceRow, type SubscriptionRow, type UserRow, type WorkspaceRow } from "../src/db/schema";
import type { Bindings } from "../src/env";
import worker from "../src/index";
import { acceptEvent } from "../src/intake/service";
import { eventPayloadSchema } from "../src/mcp/event-payload";
import { NO_EXPIRY } from "../src/subscriptions/queries";
import { signWebhook } from "../src/webhooks/sign";
import {
  createSource,
  createSubscription,
  createUser,
  d1With,
  db,
  fakeQueue,
  listDeliveries,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  type DeliveryRecord,
} from "./helpers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CALLBACK_HOST = "hooks.example.com";
const CALLBACK = `https://${CALLBACK_HOST}/pinglune?x=1`;
const DELIVERY_QUEUE = "pinglune-deliveries";
const DEAD_LETTER_QUEUE = "pinglune-deliveries-dlq";

type DnsAnswer = { A?: string[]; AAAA?: string[] } | Response;

let owner: UserRow;
let other: UserRow;
let workspace: WorkspaceRow;
let source: SourceRow;
let subscription: SubscriptionRow;
let secret: Uint8Array<ArrayBuffer>;
let eventId: string;
let deliveryId: string;
let now: number;
// DNS answers by host; hosts not listed resolve to one public IPv4 address.
let dns: Record<string, DnsAnswer>;
let dohQueries: string[];
let callbacks: { request: Request; body: string }[];
let respond: (request: Request, body: string) => Response | Promise<Response>;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  owner = await createUser({ email: "owner@example.com" });
  other = await createUser({ email: "other@example.com" });
  workspace = await personalWorkspaceOf(owner);
  source = await createSource({ workspaceId: workspace.id, name: "app" });
  secret = crypto.getRandomValues(new Uint8Array(32));
  subscription = await createSubscription({ user: owner, callbackUrl: CALLBACK, secret, createdAt: now });
  ({ eventId, deliveryId } = await ingest("k-1"));

  dns = {};
  dohQueries = [];
  callbacks = [];
  respond = () => new Response("ok");
  // Every outgoing request is answered here: DNS over HTTPS and the callback host. Anything else fails the test
  // instead of reaching the network.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type") as "A" | "AAAA";
      dohQueries.push(`${name} ${type}`);
      const answer = dns[name] ?? { A: ["93.184.216.34"] };
      if (answer instanceof Response) return answer.clone();
      const records = (answer[type] ?? []).map((data) => ({ name, type: type === "A" ? 1 : 28, TTL: 60, data }));
      return Response.json({ Status: 0, Answer: records });
    }
    if (url.hostname === CALLBACK_HOST) {
      const body = await request.clone().text();
      callbacks.push({ request, body });
      return respond(request, body);
    }
    throw new Error(`unexpected fetch: ${request.url}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

// Accepts an event through the shared intake; the subscription in beforeEach gets one delivery.
async function ingest(key: string, input: Record<string, unknown> = {}): Promise<{ eventId: string; deliveryId: string }> {
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now },
    { id: source.id, workspaceId: workspace.id, name: source.name, enabled: true },
    {
      idempotency_key: key,
      type: "alert.observed",
      summary: "疎通確認",
      labels: { project: "a" },
      body: { content_type: "text/plain", bytes: new TextEncoder().encode("hello") },
      ...input,
    },
  );
  if (!result.ok) throw new Error(`ingest failed: ${result.error.code}`);
  const [row] = await listDeliveries("event_id = ?", result.event_id);
  if (!row) throw new Error("no delivery");
  return { eventId: result.event_id, deliveryId: row.id };
}

async function delivery(id = deliveryId): Promise<DeliveryRecord | undefined> {
  return (await listDeliveries("id = ?", id))[0];
}

async function setDelivery(columns: string, ...values: unknown[]): Promise<void> {
  await env.DB.prepare(`UPDATE deliveries SET ${columns} WHERE id = ?`)
    .bind(...values, deliveryId)
    .run();
}

async function setSubscription(columns: string, ...values: unknown[]): Promise<void> {
  await env.DB.prepare(`UPDATE subscriptions SET ${columns} WHERE id = ?`)
    .bind(...values, subscription.id)
    .run();
}

type RunOptions = { queue?: string; attempts?: number; body?: unknown; env?: Partial<Bindings> };

type RunResult = QueueResult & { retryOptions: (QueueRetryOptions | undefined)[] };

// Runs the queue handler on one message and returns its ack and retry state. getQueueResult does not report the
// delay of a retry, so the options passed to retry() are recorded as well.
async function run(options: RunOptions = {}): Promise<RunResult> {
  const batch = createMessageBatch(options.queue ?? DELIVERY_QUEUE, [
    {
      id: "msg-1",
      timestamp: new Date(now),
      attempts: options.attempts ?? 1,
      body: "body" in options ? options.body : { delivery_id: deliveryId },
    },
  ]);
  const retryOptions: (QueueRetryOptions | undefined)[] = [];
  for (const message of batch.messages) {
    const retry = message.retry.bind(message);
    vi.spyOn(message, "retry").mockImplementation((retryOptionsArg?: QueueRetryOptions) => {
      retryOptions.push(retryOptionsArg);
      retry(retryOptionsArg);
    });
  }
  const ctx = createExecutionContext();
  await worker.queue(batch, { ...env, ...options.env });
  return { ...(await getQueueResult(batch, ctx)), retryOptions };
}

function expectAck(result: RunResult): void {
  expect(result.explicitAcks).toEqual(["msg-1"]);
  expect(result.retryMessages).toEqual([]);
  expect(result.retryOptions).toEqual([]);
}

function expectRetry(result: RunResult, delaySeconds: number): void {
  expect(result.explicitAcks).toEqual([]);
  expect(result.retryMessages.map((message) => message.msgId)).toEqual(["msg-1"]);
  expect(result.retryOptions).toEqual([{ delaySeconds }]);
}

describe("a successful delivery", () => {
  it("sends the signed envelope and records the delivery", async () => {
    respond = () => new Response(null, { status: 204 });
    const result = await run();
    expectAck(result);

    expect(callbacks).toHaveLength(1);
    const [{ request, body } = { request: new Request(CALLBACK), body: "" }] = callbacks;
    expect(request.url).toBe(CALLBACK);
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("webhook-id")).toBe(eventId);
    expect(request.headers.get("x-mcp-subscription-id")).toBe(subscription.id);
    const timestamp = Number(request.headers.get("webhook-timestamp"));
    expect(timestamp).toBe(Math.floor(now / 1000));
    expect(request.headers.get("webhook-signature")).toBe(
      await signWebhook([secret], eventId, timestamp, new TextEncoder().encode(body)),
    );

    const envelope = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["cursor", "data", "eventId", "name", "timestamp"]);
    expect(envelope).toMatchObject({ eventId, name: "pinglune.event", timestamp: new Date(now).toISOString(), cursor: null });
    const data = eventPayloadSchema.parse(envelope.data);
    expect(data).toMatchObject({
      event_id: eventId,
      type: "alert.observed",
      source: { id: source.id, name: "app" },
      labels: { project: "a" },
      summary: "疎通確認",
      data_count: 1,
      data: [{ role: "body", content_type: "text/plain", size: 5, readable: true }],
    });

    expect(await delivery()).toMatchObject({
      status: "delivered",
      attempts: 1,
      last_attempt_at: now,
      last_http_status: 204,
      last_error: null,
      delivered_at: now,
      updated_at: now,
    });
    expect(dohQueries.sort()).toEqual([`${CALLBACK_HOST} A`, `${CALLBACK_HOST} AAAA`]);
  });

  it("clears the error of a previous try", async () => {
    await setDelivery("attempts = 2, last_error = 'http_5xx', last_http_status = 503");
    expectAck(await run({ attempts: 3 }));
    expect(await delivery()).toMatchObject({ status: "delivered", attempts: 3, last_http_status: 200, last_error: null });
  });

  it("delivers several messages of one batch", async () => {
    const second = await ingest("k-2");
    const batch = createMessageBatch(DELIVERY_QUEUE, [
      { id: "a", timestamp: new Date(now), attempts: 1, body: { delivery_id: deliveryId } },
      { id: "b", timestamp: new Date(now), attempts: 1, body: { delivery_id: second.deliveryId } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["a", "b"]);
    expect((await listDeliveries()).map((row) => row.status)).toEqual(["delivered", "delivered"]);
  });
});

describe("signing while a secret is rotated", () => {
  const previous = crypto.getRandomValues(new Uint8Array(32));

  async function signatures(): Promise<string[]> {
    expectAck(await run());
    const [{ request, body } = { request: new Request(CALLBACK), body: "" }] = callbacks;
    const header = request.headers.get("webhook-signature") ?? "";
    const timestamp = Number(request.headers.get("webhook-timestamp"));
    const bytes = new TextEncoder().encode(body);
    expect(header).toBe(
      await signWebhook(
        header.split(" ").length === 2 ? [secret, previous] : [secret],
        eventId,
        timestamp,
        bytes,
      ),
    );
    return header.split(" ");
  }

  it("signs with both secrets within an hour of the rotation", async () => {
    subscription = await recreateSubscription({ previousSecret: previous, secretRotatedAt: now - HOUR + 1 });
    expect(await signatures()).toHaveLength(2);
  });

  it("signs with the current secret only from an hour after the rotation", async () => {
    subscription = await recreateSubscription({ previousSecret: previous, secretRotatedAt: now - HOUR });
    expect(await signatures()).toHaveLength(1);
  });

  it("signs with the current secret only when the previous one cannot be decrypted", async () => {
    subscription = await recreateSubscription({ previousSecret: previous, secretRotatedAt: now - MINUTE });
    await setSubscription("previous_secret = 'v1.broken.value'");
    expect(await signatures()).toHaveLength(1);
  });
});

// Replaces the subscription of the delivery with a new one that has the given secrets, keeping the delivery.
async function recreateSubscription(params: { previousSecret: Uint8Array<ArrayBuffer>; secretRotatedAt: number }) {
  const row = await createSubscription({ user: owner, callbackUrl: CALLBACK, secret, ...params });
  await setDelivery("subscription_id = ?", row.id);
  return row;
}

describe("failures that are not retried", () => {
  it.each([410, 413])("records %i as failed without a retry and keeps the subscription", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respond = () => new Response("gone", { status });
    expectAck(await run());
    expect(await delivery()).toMatchObject({
      status: "failed",
      attempts: 1,
      last_attempt_at: now,
      last_http_status: status,
      last_error: "http_4xx",
      delivered_at: null,
    });
    const row = await env.DB.prepare("SELECT unsubscribed_at FROM subscriptions WHERE id = ?")
      .bind(subscription.id)
      .first<{ unsubscribed_at: number | null }>();
    expect(row?.unsubscribed_at).toBeNull();
  });

  it("records a blocked destination as failed without sending to it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    dns[CALLBACK_HOST] = { A: ["93.184.216.34"], AAAA: ["::1"] };
    expectAck(await run());
    expect(callbacks).toEqual([]);
    expect(await delivery()).toMatchObject({
      status: "failed",
      attempts: 1,
      last_attempt_at: now,
      last_http_status: null,
      last_error: "blocked_destination",
    });
  });

  it("blocks callbacks to APP_ORIGIN", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expectAck(await run({ env: { APP_ORIGIN: `https://${CALLBACK_HOST}` } }));
    expect(callbacks).toEqual([]);
    expect(dohQueries).toEqual([]);
    expect(await delivery()).toMatchObject({ status: "failed", last_error: "blocked_destination" });
  });
});

describe("failures that are retried", () => {
  it.each<[string, () => void, string, number | null]>([
    ["5xx", () => (respond = () => new Response(null, { status: 503 })), "http_5xx", 503],
    ["another 4xx", () => (respond = () => new Response(null, { status: 404 })), "http_4xx", 404],
    ["a redirect", () => (respond = () => new Response(null, { status: 302, headers: { Location: "https://a.example/" } })), "redirect", 302],
    [
      "a timeout",
      () =>
        (respond = () => {
          throw new DOMException("timed out", "TimeoutError");
        }),
      "timeout",
      null,
    ],
    [
      "a connection failure",
      () =>
        (respond = () => {
          throw new TypeError("connection refused");
        }),
      "connection_failed",
      null,
    ],
    ["a DNS failure", () => (dns[CALLBACK_HOST] = Response.json({ Status: 3 })), "dns_failed", null],
  ])("keeps the delivery pending after %s", async (_name, arrange, reason, status) => {
    arrange();
    expectRetry(await run(), 30);
    expect(await delivery()).toMatchObject({
      status: "pending",
      attempts: 1,
      last_attempt_at: now,
      last_http_status: status,
      last_error: reason,
      delivered_at: null,
    });
  });

  it("doubles the delay from D1's attempts and fails at the 6th try", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respond = () => new Response(null, { status: 500 });
    // The queue's attempts stays 1: the limit follows D1.
    for (const delay of [30, 60, 120, 240, 480]) {
      expectRetry(await run({ attempts: 1 }), delay);
      expect(await delivery()).toMatchObject({ status: "pending" });
    }
    expect(await delivery()).toMatchObject({ attempts: 5 });
    expectAck(await run({ attempts: 1 }));
    expect(await delivery()).toMatchObject({ status: "failed", attempts: 6, last_error: "http_5xx", last_http_status: 500 });
    expect(callbacks).toHaveLength(6);
  });

  it("overwrites the status of the previous try with null when there is no response", async () => {
    await setDelivery("attempts = 1, last_http_status = 503, last_error = 'http_5xx'");
    respond = () => {
      throw new TypeError("connection refused");
    };
    expectRetry(await run({ attempts: 2 }), 60);
    expect(await delivery()).toMatchObject({ attempts: 2, last_http_status: null, last_error: "connection_failed" });
  });
});

describe("deliveries that are not sent", () => {
  async function expectFailedWithoutSend(reason: string) {
    expectAck(await run());
    expect(callbacks).toEqual([]);
    expect(await delivery()).toMatchObject({
      status: "failed",
      attempts: 0,
      last_attempt_at: null,
      last_http_status: null,
      last_error: reason,
      updated_at: now,
    });
  }

  it("fails when the subscription is unsubscribed", async () => {
    await setSubscription("unsubscribed_at = ?", now - 1);
    await expectFailedWithoutSend("subscription_inactive");
  });

  it("fails when the subscription has expired", async () => {
    await setSubscription("expires_at = ?", now);
    await expectFailedWithoutSend("subscription_inactive");
  });

  it("fails when the subscription's user has no personal workspace (deleted)", async () => {
    // A user without a personal workspace, as after a deletion: the access check finds no workspace.
    const [ghost] = await db
      .insert(users)
      .values({ id: crypto.randomUUID(), email: "ghost@example.com", role: "member", createdAt: now, updatedAt: now })
      .returning();
    await setSubscription("user_id = ?", ghost?.id);
    await expectFailedWithoutSend("subscription_inactive");
  });

  it("fails when the subscription's user does not own the subscription's workspace", async () => {
    await setSubscription("user_id = ?", other.id);
    await expectFailedWithoutSend("subscription_inactive");
  });

  it("fails when the subscription is in another workspace than the delivery", async () => {
    await setSubscription("user_id = ?, workspace_id = ?", other.id, (await personalWorkspaceOf(other)).id);
    await expectFailedWithoutSend("subscription_inactive");
  });

  it("fails when the event is not in the delivery's workspace", async () => {
    await env.DB.prepare("UPDATE events SET workspace_id = ? WHERE id = ?")
      .bind((await personalWorkspaceOf(other)).id, eventId)
      .run();
    await expectFailedWithoutSend("event_not_found");
  });

  it("fails when the envelope is larger than 256 KiB", async () => {
    await env.DB.prepare("UPDATE events SET summary = ? WHERE id = ?").bind("x".repeat(262_144), eventId).run();
    await expectFailedWithoutSend("payload_too_large");
  });

  it("fails when the secret cannot be decrypted", async () => {
    await setSubscription("secret = 'v1.broken.value'");
    await expectFailedWithoutSend("secret_unavailable");
  });

  it.each(["delivered", "failed"])("acks a %s delivery without sending", async (status) => {
    await setDelivery("status = ?", status);
    expectAck(await run());
    expect(callbacks).toEqual([]);
    expect(dohQueries).toEqual([]);
    expect(await delivery()).toMatchObject({ status, attempts: 0 });
  });

  it("acks a missing delivery without sending", async () => {
    expectAck(await run({ body: { delivery_id: "dlv_01JC9Z7H2K4M6N8P0Q2R4S6T8V" } }));
    expect(callbacks).toEqual([]);
  });

  it.each([null, "dlv_x", { delivery_id: "evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V" }, { delivery_id: 1 }])(
    "acks a malformed message %j",
    async (body) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      expectAck(await run({ body }));
      expect(error).toHaveBeenCalled();
      expect(callbacks).toEqual([]);
      expect(await delivery()).toMatchObject({ status: "pending", attempts: 0 });
    },
  );
});

describe("webhook destinations", () => {
  const TOKEN = "crsr_0123456789abcdefghijklmnopqrstuvwxyz";

  beforeEach(async () => {
    subscription = await createSubscription({
      user: owner,
      kind: "webhook",
      name: "bot",
      callbackUrl: CALLBACK,
      secret: new TextEncoder().encode(TOKEN),
      expiresAt: NO_EXPIRY,
    });
    await setDelivery("subscription_id = ?", subscription.id);
  });

  it("sends the envelope with the Bearer key and webhook-id, without signature headers", async () => {
    const result = await run();
    expectAck(result);
    expect(callbacks).toHaveLength(1);
    const [{ request, body } = { request: new Request(CALLBACK), body: "" }] = callbacks;
    expect(request.url).toBe(CALLBACK);
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get("webhook-id")).toBe(eventId);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("user-agent")).toBe("Pinglune-Webhooks/1");
    expect(request.headers.has("webhook-signature")).toBe(false);
    expect(request.headers.has("webhook-timestamp")).toBe(false);
    expect(request.headers.has("x-mcp-subscription-id")).toBe(false);
    expect(JSON.parse(body)).toMatchObject({ eventId, name: "pinglune.event", cursor: null });
    expect(await delivery()).toMatchObject({ status: "delivered", attempts: 1, last_http_status: 200 });
  });

  it("retries a 401 like other 4xx", async () => {
    respond = () => new Response(null, { status: 401 });
    expectRetry(await run(), 30);
    expect(await delivery()).toMatchObject({ status: "pending", attempts: 1, last_http_status: 401, last_error: "http_4xx" });
  });

  it("fails when the key cannot be decrypted", async () => {
    await setSubscription("secret = 'v1.broken.value'");
    expectAck(await run());
    expect(callbacks).toEqual([]);
    expect(await delivery()).toMatchObject({ status: "failed", attempts: 0, last_error: "secret_unavailable" });
  });

  it("fails when the destination is deleted", async () => {
    await setSubscription("unsubscribed_at = ?", now - 1);
    expectAck(await run());
    expect(callbacks).toEqual([]);
    expect(await delivery()).toMatchObject({ status: "failed", last_error: "subscription_inactive" });
  });

  it("never logs the key or the whole URL", async () => {
    const logs = [vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "log")].map((spy) =>
      spy.mockImplementation(() => {}),
    );
    respond = () => new Response(null, { status: 410 });
    expectAck(await run());
    expect(await delivery()).toMatchObject({ status: "failed", last_error: "http_4xx" });
    const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
    expect(logged).toContain(CALLBACK_HOST);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("/pinglune?x=1");
  });
});

describe("a subscription of an unknown kind", () => {
  it("fails with subscription_inactive and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await setSubscription("kind = 'other'");
    expectAck(await run());
    expect(callbacks).toEqual([]);
    expect(await delivery()).toMatchObject({ status: "failed", attempts: 0, last_error: "subscription_inactive" });
    expect(error).toHaveBeenCalledWith("delivery: unknown subscription kind", { deliveryId });
  });
});

describe("unexpected errors", () => {
  // A D1 whose queries on the given table throw.
  function failingDb(pattern: RegExp): D1Database {
    return d1With({
      prepare: (query: string) => {
        if (pattern.test(query)) throw new Error("D1 is down");
        return env.DB.prepare(query);
      },
    });
  }

  it.each<[number, number]>([
    [1, 30],
    [3, 120],
    [6, 960],
    [9, 960],
  ])("retries with the queue's attempts %i (%i seconds) and leaves the row", async (attempts, delay) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await delivery();
    expectRetry(await run({ attempts, env: { DB: failingDb(/from "events"/) } }), delay);
    expect(callbacks).toEqual([]);
    expect(await delivery()).toEqual(before);
  });

  it("retries without changing the row when recording the try fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await delivery();
    expectRetry(await run({ env: { DB: failingDb(/^UPDATE deliveries/) } }), 30);
    expect(callbacks).toHaveLength(1);
    expect(await delivery()).toEqual(before);
  });

  it("retries every message after 300 seconds when the configuration is invalid", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expectRetry(await run({ env: { JWT_SECRET: "short" } }), 300);
    expectRetry(await run({ queue: DEAD_LETTER_QUEUE, env: { JWT_SECRET: "short" } }), 300);
    expect(callbacks).toEqual([]);
    expect(await delivery()).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("deliveries processed at the same time", () => {
  it("does not overwrite a delivery that another consumer delivered during the send", async () => {
    respond = async () => {
      await setDelivery("status = 'delivered', attempts = 1, delivered_at = 1");
      return new Response(null, { status: 503 });
    };
    expectAck(await run());
    expect(await delivery()).toMatchObject({ status: "delivered", attempts: 1, delivered_at: 1, last_error: null });
  });

  it("does not record a try over another consumer's try of the same attempt", async () => {
    respond = async () => {
      await setDelivery("attempts = 1, last_error = 'timeout'");
      return new Response(null, { status: 200 });
    };
    expectAck(await run());
    expect(await delivery()).toMatchObject({ status: "pending", attempts: 1, last_error: "timeout", delivered_at: null });
  });
});

describe("the dead letter queue", () => {
  it("records a pending delivery as failed, keeping attempts", async () => {
    await setDelivery("attempts = 2");
    expectAck(await run({ queue: DEAD_LETTER_QUEUE }));
    expect(await delivery()).toMatchObject({ status: "failed", attempts: 2, last_error: "dead_lettered", updated_at: now });
    expect(callbacks).toEqual([]);
  });

  it.each(["delivered", "failed"])("leaves a %s delivery as it is", async (status) => {
    await setDelivery("status = ?", status);
    const before = await delivery();
    expectAck(await run({ queue: DEAD_LETTER_QUEUE }));
    expect(await delivery()).toEqual(before);
  });

  it("acks a malformed message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expectAck(await run({ queue: DEAD_LETTER_QUEUE, body: { delivery_id: "nope" } }));
  });

  it("retries after 60 seconds when D1 fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = d1With({
      prepare: () => {
        throw new Error("D1 is down");
      },
    });
    expectRetry(await run({ queue: DEAD_LETTER_QUEUE, env: { DB: failing } }), 60);
    expect(await delivery()).toMatchObject({ status: "pending" });
  });
});
