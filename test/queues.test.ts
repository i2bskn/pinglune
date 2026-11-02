import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Subscription, SubscriptionList } from "../src/api/types";
import { clock } from "../src/clock";
import type { SourceRow, SubscriptionRow, UserRow } from "../src/db/schema";
import worker from "../src/index";
import { acceptEvent } from "../src/intake/service";
import { runDailyMaintenance } from "../src/maintenance/daily";
import { mcpHandler } from "../src/mcp/handler";
import { claimableDeliveriesStatement } from "../src/queues/queries";
import { findSubscriptionById, NO_EXPIRY } from "../src/subscriptions/queries";
import {
  createQueue,
  createSource,
  createSubscription,
  createUser,
  db,
  fakeQueue,
  listDeliveries,
  login,
  ORIGIN,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
  type DeliveryRecord,
  type FakeQueue,
  type SessionCookies,
} from "./helpers";

const MCP_ACCEPT = "application/json, text/event-stream";
const MINUTE = 60_000;
const LEASE = 10 * MINUTE;
const DAY = 24 * 60 * MINUTE;
const MISSING_QUEUE = "sub_0123456789abcdef0123456789abcdef";
const MISSING_DELIVERY = "dlv_01JC9Z7H2K4M6N8P0Q2R4S6T8V";

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
type ClaimResult = {
  items: { delivery_id: string; claim_count: number; event: { event_id: string; type: string; summary: string } }[];
  lease_seconds: number;
  has_more: boolean;
};
type AckResult = { acknowledged: number; already_acknowledged: number; not_found: number };

let alice: UserRow;
let bob: UserRow;
let aliceCookies: SessionCookies;
let aliceSource: SourceRow;
let bobSource: SourceRow;
let now: number;
let sequence = 0;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  aliceCookies = await login(alice.email);
  aliceSource = await createSource({ workspaceId: (await personalWorkspaceOf(alice)).id, name: "app" });
  bobSource = await createSource({ workspaceId: (await personalWorkspaceOf(bob)).id, name: "app" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

async function ingest(
  source: SourceRow = aliceSource,
  input: Record<string, unknown> = {},
  queue: FakeQueue = fakeQueue(),
): Promise<string> {
  sequence++;
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue, now },
    { id: source.id, workspaceId: source.workspaceId, name: source.name, enabled: true },
    { idempotency_key: `k-${sequence}`, type: "alert.observed", summary: `s${sequence}`, ...input },
  );
  if (!result.ok) throw new Error(`ingest failed: ${result.error.code}`);
  return result.event_id;
}

async function deliveriesOf(queue: SubscriptionRow): Promise<DeliveryRecord[]> {
  return listDeliveries("subscription_id = ?", queue.id);
}

async function errorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return { status: res.status, code: body.error.code, message: body.error.message };
}

async function rpc(user: UserRow, method: string, params: unknown): Promise<unknown> {
  const ctx = Object.assign(createExecutionContext(), {
    props: { userId: user.id, authMode: "password" },
    auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"] },
  }) as unknown as OAuthResourceContext<unknown>;
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await mcpHandler.fetch(request, env, ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

function callTool(user: UserRow, name: string, args: Record<string, unknown>) {
  return rpc(user, "tools/call", { name, arguments: args }) as Promise<ToolResult>;
}

function parse<T>(result: ToolResult): T {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

async function claim(queue: SubscriptionRow, args: Record<string, unknown> = {}, user = alice) {
  return parse<ClaimResult>(await callTool(user, "claim_events", { queue: queue.id, ...args }));
}

async function ack(queue: SubscriptionRow, deliveryIds: string[], user = alice) {
  return parse<AckResult>(await callTool(user, "ack_events", { queue: queue.id, delivery_ids: deliveryIds }));
}

function expectQueueNotFound(result: ToolResult) {
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
    error: { code: "not_found", message: "キューが見つかりません" },
  });
}

function expectInvalidArguments(result: ToolResult) {
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool /);
}

describe("POST /api/v1/subscriptions/queues", () => {
  function create(body: Record<string, unknown>, cookies: SessionCookies = aliceCookies) {
    return send("/api/v1/subscriptions/queues", { cookies, json: body });
  }

  it("creates a polling queue without a callback URL or a key", async () => {
    const res = await create({ name: "  Muse  ", types: ["alert.observed"], labels: { project: "a" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Subscription;
    expect(body).toEqual({
      id: expect.stringMatching(/^sub_[0-9a-f]{32}$/),
      kind: "queue",
      name: "Muse",
      callback_host: null,
      arguments: { labels: { project: "a" }, types: ["alert.observed"] },
      status: "active",
      refresh_before: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
    });
    expect(await findSubscriptionById(db, body.id)).toMatchObject({
      userId: alice.id,
      workspaceId: (await personalWorkspaceOf(alice)).id,
      kind: "queue",
      eventName: "pinglune.event",
      arguments: '{"labels":{"project":"a"},"types":["alert.observed"]}',
      callbackUrl: "",
      secret: "",
      previousSecret: null,
      secretRotatedAt: null,
      expiresAt: NO_EXPIRY,
      unsubscribedAt: null,
    });
  });

  it("rejects an invalid name", async () => {
    expect(await errorOf(await create({ name: "  " }))).toEqual({
      status: 400,
      code: "invalid_name",
      message: "名前は制御文字を含まない 1〜64 文字にしてください",
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["empty types", { types: [] }],
    ["an invalid type", { types: ["Not A Type!"] }],
    ["a label value that is not a string", { labels: { project: 1 } }],
  ])("rejects %s", async (_label, filter) => {
    expect(await errorOf(await create({ name: "x", ...filter }))).toEqual({
      status: 400,
      code: "invalid_filter",
      message: "条件が正しくありません",
    });
  });

  it.each(["url", "token", "ttlMs"])("rejects the unknown field %s", async (field) => {
    expect(await errorOf(await create({ name: "x", [field]: "x" }))).toMatchObject({
      status: 400,
      code: "unknown_field",
    });
  });

  it("allows 10 active queues per workspace, not counting deleted ones or webhook destinations", async () => {
    for (let i = 0; i < 20; i++) {
      await createSubscription({ user: alice, kind: "webhook", name: "w", expiresAt: NO_EXPIRY });
    }
    const first = (await (await create({ name: "q" })).json()) as Subscription;
    for (let i = 1; i < 10; i++) expect((await create({ name: "q" })).status).toBe(201);
    expect(await errorOf(await create({ name: "q" }))).toEqual({
      status: 409,
      code: "limit_exceeded",
      message: "ポーリング用キューは 10 件までです",
    });
    expect((await send(`/api/v1/subscriptions/${first.id}/delete`, { method: "POST", cookies: aliceCookies })).status).toBe(
      200,
    );
    expect((await create({ name: "q" })).status).toBe(201);
  });

  it("requires a signed-in user", async () => {
    expect((await send("/api/v1/subscriptions/queues", { json: { name: "x" } })).status).toBe(401);
  });
});

describe("GET /api/v1/subscriptions with polling queues", () => {
  it("lists the queues after the webhook destinations, the active ones first", async () => {
    const webhook = await createSubscription({ user: alice, kind: "webhook", name: "w", expiresAt: NO_EXPIRY });
    const ended = await createQueue({ user: alice, name: "ended", unsubscribedAt: now, createdAt: now + 1 });
    const active = await createQueue({ user: alice, name: "active", createdAt: now });
    await createQueue({ user: bob });

    const res = await send("/api/v1/subscriptions", { cookies: aliceCookies });
    const { subscriptions } = (await res.json()) as SubscriptionList;
    expect(subscriptions.map((s) => [s.id, s.kind, s.status])).toEqual([
      [webhook.id, "webhook", "active"],
      [active.id, "queue", "active"],
      [ended.id, "queue", "unsubscribed"],
    ]);
    expect(subscriptions[1]).toMatchObject({ name: "active", callback_host: null, refresh_before: null, expires_at: null });
  });
});

describe("deleting a polling queue", () => {
  function remove(id: string) {
    return send(`/api/v1/subscriptions/${id}/delete`, { method: "POST", cookies: aliceCookies });
  }

  it("ends the queue and fails its pending deliveries only", async () => {
    const queue = await createQueue({ user: alice });
    const other = await createQueue({ user: alice });
    const first = await ingest();
    const second = await ingest();
    const [acked] = (await deliveriesOf(queue)).filter((row) => row.event_id === first);
    expect((await ack(queue, [acked?.id ?? ""])).acknowledged).toBe(1);
    now += 1000;

    const res = await remove(queue.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: queue.id, kind: "queue", status: "unsubscribed", updated_at: now });
    expect((await deliveriesOf(queue)).map((row) => [row.event_id, row.status, row.last_error, row.updated_at])).toEqual([
      [first, "delivered", null, now - 1000],
      [second, "failed", "subscription_inactive", now],
    ]);
    expect((await deliveriesOf(other)).map((row) => row.status)).toEqual(["pending", "pending"]);
    expectQueueNotFound(await callTool(alice, "claim_events", { queue: queue.id }));

    // Deleting again answers the ended queue.
    now += 1000;
    const again = await remove(queue.id);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "unsubscribed", updated_at: now - 1000 });
  });

  it("returns 404 for another workspace's queue", async () => {
    const theirs = await createQueue({ user: bob });
    expect(await errorOf(await remove(theirs.id))).toEqual({
      status: 404,
      code: "not_found",
      message: "配信先が見つかりません",
    });
    expect((await findSubscriptionById(db, theirs.id))?.unsubscribedAt).toBeNull();
  });
});

describe("intake", () => {
  it("creates deliveries for matching queues without sending them to the delivery queue", async () => {
    const all = await createQueue({ user: alice });
    const byType = await createQueue({ user: alice, arguments: '{"types":["alert.observed"]}' });
    const otherType = await createQueue({ user: alice, arguments: '{"types":["job.finished"]}' });
    const ended = await createQueue({ user: alice, unsubscribedAt: now });
    const webhook = await createSubscription({ user: alice, kind: "webhook", name: "w", expiresAt: NO_EXPIRY });
    const queue = fakeQueue();

    const eventId = await ingest(aliceSource, {}, queue);
    const rows = await listDeliveries("event_id = ?", eventId);
    expect(rows.map((row) => row.subscription_id).sort()).toEqual([all.id, byType.id, webhook.id].sort());
    expect(rows.map((row) => row.subscription_id)).not.toContain(otherType.id);
    expect(rows.map((row) => row.subscription_id)).not.toContain(ended.id);
    const webhookDelivery = rows.find((row) => row.subscription_id === webhook.id);
    expect(queue.messages).toEqual([{ delivery_id: webhookDelivery?.id }]);
  });

  it("does not send them on a duplicate either", async () => {
    await createQueue({ user: alice });
    const webhook = await createSubscription({ user: alice, kind: "webhook", name: "w", expiresAt: NO_EXPIRY });
    const first = fakeQueue();
    first.fail = true;
    const input = { idempotency_key: "dup", type: "alert.observed", summary: "s" };
    const source = { id: aliceSource.id, workspaceId: aliceSource.workspaceId, name: "app", enabled: true };
    const failed = await acceptEvent({ db: env.DB, bucket: env.EVENT_DATA, queue: first, now }, source, input);
    expect(failed.ok).toBe(false);

    const retry = fakeQueue();
    const result = await acceptEvent({ db: env.DB, bucket: env.EVENT_DATA, queue: retry, now }, source, input);
    expect(result).toMatchObject({ ok: true, duplicate: true });
    const [webhookDelivery] = await listDeliveries("subscription_id = ?", webhook.id);
    expect(retry.messages).toEqual([{ delivery_id: webhookDelivery?.id }]);
  });
});

describe("the delivery consumer", () => {
  it("acknowledges a message of a queue delivery without changing it", async () => {
    const queue = await createQueue({ user: alice });
    await ingest();
    const [before] = await deliveriesOf(queue);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch");
    now += 1000;

    const batch = createMessageBatch("pinglune-deliveries", [
      { id: "msg-1", timestamp: new Date(now), attempts: 1, body: { delivery_id: before?.id } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["msg-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(await deliveriesOf(queue)).toEqual([before]);
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("delivery: queue delivery in the delivery queue", { deliveryId: before?.id });
  });
});

describe("claim_events", () => {
  it("claims the oldest deliveries up to limit, and tells whether more are waiting", async () => {
    const queue = await createQueue({ user: alice });
    const events: string[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(await ingest(aliceSource, { type: "alert.observed", labels: { n: String(i) } }));
      now += 1;
    }

    const first = await claim(queue, { limit: 2 });
    expect(first.lease_seconds).toBe(600);
    expect(first.has_more).toBe(true);
    expect(first.items.map((item) => [item.event.event_id, item.claim_count])).toEqual([
      [events[0], 1],
      [events[1], 1],
    ]);
    expect(first.items[0]?.event).toEqual({
      event_id: events[0],
      type: "alert.observed",
      source: { id: aliceSource.id, name: "app" },
      labels: { n: "0" },
      summary: expect.any(String),
      occurred_at: expect.any(String),
      received_at: expect.any(String),
      data_count: 0,
    });
    const rows = await deliveriesOf(queue);
    const claimed = rows.filter((row) => first.items.some((item) => item.delivery_id === row.id));
    for (const row of claimed) expect(row).toMatchObject({ status: "pending", attempts: 1, last_attempt_at: now });

    const second = await claim(queue);
    expect(second.has_more).toBe(false);
    expect(second.items.map((item) => item.event.event_id)).toEqual([events[2]]);
    expect(await claim(queue)).toEqual({ items: [], lease_seconds: 600, has_more: false });
  });

  it("returns a claimed delivery again after the lease, until it is acknowledged", async () => {
    const queue = await createQueue({ user: alice });
    const eventId = await ingest();
    const [item] = (await claim(queue)).items;
    expect(item?.claim_count).toBe(1);

    now += LEASE - 1;
    expect((await claim(queue)).items).toEqual([]);
    now += 1;
    const again = (await claim(queue)).items;
    expect(again.map((i) => [i.delivery_id, i.event.event_id, i.claim_count])).toEqual([[item?.delivery_id, eventId, 2]]);

    expect(await ack(queue, [item?.delivery_id ?? ""])).toEqual({ acknowledged: 1, already_acknowledged: 0, not_found: 0 });
    now += LEASE;
    expect((await claim(queue)).items).toEqual([]);
    expect((await deliveriesOf(queue))[0]).toMatchObject({ status: "delivered", attempts: 2, delivered_at: now - LEASE });
  });

  it("fails a delivery claimed 5 times without an ack as not_acknowledged", async () => {
    const queue = await createQueue({ user: alice });
    await ingest();
    for (let i = 1; i <= 5; i++) {
      expect((await claim(queue)).items.map((item) => item.claim_count)).toEqual([i]);
      now += LEASE;
    }
    expect((await claim(queue)).items).toEqual([]);
    expect((await deliveriesOf(queue))[0]).toMatchObject({
      status: "failed",
      attempts: 5,
      last_error: "not_acknowledged",
      updated_at: now,
    });
  });

  it("does not claim deliveries older than 7 days, which the daily cron expires instead", async () => {
    const queue = await createQueue({ user: alice });
    await ingest();
    for (let i = 0; i < 5; i++) {
      await claim(queue);
      now += LEASE;
    }
    // Claimed 5 times, then not claimed for 7 days.
    const createdAt = (await deliveriesOf(queue))[0]?.created_at ?? 0;
    now = createdAt + 7 * DAY;
    expect((await claim(queue)).items).toEqual([]);
    expect((await deliveriesOf(queue))[0]).toMatchObject({ status: "pending", attempts: 5 });

    vi.spyOn(console, "info").mockImplementation(() => {});
    await runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, now });
    expect((await deliveriesOf(queue))[0]).toMatchObject({ status: "failed", last_error: "expired", updated_at: now });
  });

  it("answers other workspaces', deleted, missing and malformed queues as not found", async () => {
    const theirs = await createQueue({ user: bob });
    await ingest(bobSource);
    const ended = await createQueue({ user: alice, unsubscribedAt: now });
    const webhook = await createSubscription({ user: alice, kind: "webhook", name: "w", expiresAt: NO_EXPIRY });
    for (const queue of [theirs.id, ended.id, webhook.id, MISSING_QUEUE, "sub_123", "x"]) {
      expectQueueNotFound(await callTool(alice, "claim_events", { queue }));
      expectQueueNotFound(await callTool(alice, "ack_events", { queue, delivery_ids: [MISSING_DELIVERY] }));
    }
    expect((await deliveriesOf(theirs))[0]).toMatchObject({ attempts: 0 });
  });

  it.each<[string, Record<string, unknown>]>([
    ["limit 0", { limit: 0 }],
    ["limit 51", { limit: 51 }],
    ["an unknown argument", { cursor: "x" }],
  ])("rejects %s", async (_label, args) => {
    const queue = await createQueue({ user: alice });
    expectInvalidArguments(await callTool(alice, "claim_events", { queue: queue.id, ...args }));
  });

  it("never returns the same delivery to two claims at the same time", async () => {
    const queue = await createQueue({ user: alice });
    for (let i = 0; i < 6; i++) await ingest();
    const results = await Promise.all([claim(queue, { limit: 6 }), claim(queue, { limit: 6 })]);
    const ids = results.flatMap((result) => result.items.map((item) => item.delivery_id));
    expect(new Set(ids).size).toBe(ids.length);
    const rows = await deliveriesOf(queue);
    // Every delivery claimed is counted once.
    expect(rows.filter((row) => row.attempts === 1).map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(rows.every((row) => row.attempts <= 1)).toBe(true);
  });

  it("fails a delivery whose event is gone as event_not_found", async () => {
    const queue = await createQueue({ user: alice });
    const eventId = await ingest();
    await env.DB.prepare("UPDATE events SET workspace_id = ? WHERE id = ?")
      .bind((await personalWorkspaceOf(bob)).id, eventId)
      .run();
    expect((await claim(queue)).items).toEqual([]);
    expect((await deliveriesOf(queue))[0]).toMatchObject({ status: "failed", last_error: "event_not_found" });
  });

  it("reads the candidates with deliveries_status_created_at_idx", async () => {
    const queue = await createQueue({ user: alice });
    const statement = claimableDeliveriesStatement(env.DB, {
      workspaceId: queue.workspaceId,
      queueId: queue.id,
      now,
      limit: 11,
    });
    // EXPLAIN QUERY PLAN with the same SQL and bindings.
    const sql = (statement as unknown as { statement: string }).statement;
    const params = (statement as unknown as { params: unknown[] }).params;
    expect(typeof sql).toBe("string");
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    expect(results.map((row) => row.detail).join("\n")).toContain("deliveries_status_created_at_idx");
  });
});

describe("ack_events", () => {
  it("counts acknowledged, already acknowledged and not found deliveries", async () => {
    const queue = await createQueue({ user: alice });
    const other = await createQueue({ user: alice });
    const theirs = await createQueue({ user: bob });
    await ingest();
    await ingest();
    await ingest(bobSource);
    const [first, second] = await deliveriesOf(queue);
    const [ofOther] = await deliveriesOf(other);
    const [ofTheirs] = await deliveriesOf(theirs);
    // Acknowledged without a claim too.
    expect(await ack(queue, [first?.id ?? ""])).toEqual({ acknowledged: 1, already_acknowledged: 0, not_found: 0 });
    await env.DB.prepare("UPDATE deliveries SET status = 'failed', last_error = 'not_acknowledged' WHERE id = ?")
      .bind(second?.id)
      .run();

    now += 1000;
    const result = await ack(queue, [
      first?.id ?? "",
      first?.id ?? "",
      second?.id ?? "",
      ofOther?.id ?? "",
      ofTheirs?.id ?? "",
      MISSING_DELIVERY,
      "not-an-id",
    ]);
    expect(result).toEqual({ acknowledged: 0, already_acknowledged: 1, not_found: 5 });
    // Nothing changed: the failed one stays failed, and other queues' deliveries stay pending.
    expect((await deliveriesOf(queue)).map((row) => [row.status, row.delivered_at])).toEqual([
      ["delivered", now - 1000],
      ["failed", null],
    ]);
    expect((await deliveriesOf(other))[0]?.status).toBe("pending");
    expect((await deliveriesOf(theirs))[0]?.status).toBe("pending");
  });

  it("counts only malformed IDs as not found without querying them", async () => {
    const queue = await createQueue({ user: alice });
    expect(await ack(queue, ["x", "x", "dlv_1"])).toEqual({ acknowledged: 0, already_acknowledged: 0, not_found: 2 });
  });

  it.each<[string, Record<string, unknown>]>([
    ["no delivery_ids", { delivery_ids: [] }],
    ["51 delivery_ids", { delivery_ids: Array.from({ length: 51 }, () => MISSING_DELIVERY) }],
    ["an unknown argument", { delivery_ids: [MISSING_DELIVERY], limit: 1 }],
  ])("rejects %s", async (_label, args) => {
    const queue = await createQueue({ user: alice });
    expectInvalidArguments(await callTool(alice, "ack_events", { queue: queue.id, ...args }));
  });
});

describe("daily maintenance of queues", () => {
  it("expires pending queue deliveries older than 7 days, including those of ended queues", async () => {
    const queue = await createQueue({ user: alice });
    const ended = await createQueue({ user: alice });
    const webhook = await createSubscription({ user: alice, kind: "webhook", name: "w", expiresAt: NO_EXPIRY });
    await ingest();
    const createdAt = now;
    await env.DB.prepare("UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?").bind(now, ended.id).run();
    now += 1;
    await ingest();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const at = createdAt + 7 * DAY;
    await runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, now: at });
    expect(info).toHaveBeenCalledWith("expired queue deliveries", { count: 2 });
    expect((await deliveriesOf(queue)).map((row) => [row.status, row.last_error])).toEqual([
      ["failed", "expired"],
      ["pending", null],
    ]);
    expect((await deliveriesOf(ended)).map((row) => [row.status, row.last_error])).toEqual([["failed", "expired"]]);
    // Webhook deliveries are left to the consumer.
    expect((await listDeliveries("subscription_id = ?", webhook.id)).map((row) => row.status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("leaves queue deliveries out of the stale pending check", async () => {
    await createQueue({ user: alice });
    await ingest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    await runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, now: now + 2 * 60 * MINUTE });
    expect(warn).not.toHaveBeenCalledWith("stale pending deliveries", expect.anything());

    await createSubscription({ user: alice });
    await ingest();
    await runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, now: now + 2 * 60 * MINUTE });
    expect(warn).toHaveBeenCalledWith("stale pending deliveries", expect.objectContaining({ count: 1 }));
  });
});
