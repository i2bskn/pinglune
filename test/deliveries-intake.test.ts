import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceRow, UserRow, WorkspaceRow } from "../src/db/schema";
import { matchesFilter, type EventFilter } from "../src/events/filter";
import { listWorkspaceEvents } from "../src/events/queries";
import { DELIVERY_ID_PATTERN } from "../src/ids";
import { acceptEvent, type IntakeSource } from "../src/intake/service";
import type { IntakeInput } from "../src/intake/validation";
import {
  countTable,
  createApiKey,
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
  send,
  type FakeQueue,
} from "./helpers";

const RPC_SOURCE_ID = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
const HOUR = 60 * 60 * 1000;

const INPUT: IntakeInput = {
  idempotency_key: "k-1",
  type: "alert.observed",
  summary: "s",
  labels: { project: "a", env: "prod" },
};

let owner: UserRow;
let other: UserRow;
let workspace: WorkspaceRow;
let source: SourceRow;
let intakeSource: IntakeSource;
let queue: FakeQueue;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  owner = await createUser({ email: "owner@example.com" });
  other = await createUser({ email: "other@example.com" });
  workspace = await personalWorkspaceOf(owner);
  source = await createSource({ workspaceId: workspace.id, name: "app" });
  intakeSource = { id: source.id, workspaceId: workspace.id, name: source.name, enabled: true };
  queue = fakeQueue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

function accept(input: IntakeInput = INPUT, options: { d1?: D1Database; now?: number } = {}) {
  return acceptEvent({ db: options.d1 ?? env.DB, bucket: env.EVENT_DATA, queue, now: options.now ?? Date.now() }, intakeSource, input);
}

function queuedIds(): string[] {
  return queue.messages.map((message) => message.delivery_id).sort();
}

describe("deliveries created by the intake", () => {
  it("creates a pending delivery for each matching active subscription and queues it", async () => {
    const now = Date.now();
    const all = await createSubscription({ user: owner });
    const byType = await createSubscription({ user: owner, arguments: '{"types":["alert.observed"]}' });
    const bySource = await createSubscription({ user: owner, arguments: '{"sources":["app"]}' });
    const byLabels = await createSubscription({ user: owner, arguments: '{"labels":{"env":"prod","project":"a"}}' });
    // Not delivered.
    await createSubscription({ user: owner, arguments: '{"types":["job.finished"]}' });
    await createSubscription({ user: owner, arguments: '{"sources":["worker"]}' });
    await createSubscription({ user: owner, arguments: '{"labels":{"project":"b"}}' });
    await createSubscription({ user: owner, expiresAt: now - 1 });
    await createSubscription({ user: owner, expiresAt: now });
    await createSubscription({ user: owner, unsubscribedAt: now - HOUR });
    await createSubscription({ user: owner, eventName: "other.event" });
    await createSubscription({ user: other });

    const result = await accept(INPUT, { now });
    expect(result).toMatchObject({ ok: true, duplicate: false });
    if (!result.ok) return;

    const rows = await listDeliveries();
    expect(rows.map((row) => row.subscription_id).sort()).toEqual([all.id, byType.id, bySource.id, byLabels.id].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        event_id: result.event_id,
        workspace_id: workspace.id,
        status: "pending",
        attempts: 0,
        last_attempt_at: null,
        last_http_status: null,
        last_error: null,
        delivered_at: null,
        created_at: now,
        updated_at: now,
      });
      expect(row.id).toMatch(DELIVERY_ID_PATTERN);
    }
    expect(queuedIds()).toEqual(rows.map((row) => row.id).sort());
  });

  it("creates nothing and queues nothing without matching subscriptions", async () => {
    await createSubscription({ user: owner, arguments: '{"types":["job.finished"]}' });
    expect(await accept()).toMatchObject({ ok: true });
    expect(await countTable("deliveries")).toBe(0);
    expect(queue.messages).toEqual([]);
  });

  it("skips a subscription with broken arguments and still succeeds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await createSubscription({ user: owner, arguments: "{not json" });
    const notObject = await createSubscription({ user: owner, arguments: "[]" });
    const good = await createSubscription({ user: owner });

    expect(await accept()).toMatchObject({ ok: true, duplicate: false });
    expect((await listDeliveries()).map((row) => row.subscription_id)).toEqual([good.id]);
    expect(error).toHaveBeenCalledWith("intake: the arguments of a subscription are broken", { subscriptionId: broken.id });
    expect(error).toHaveBeenCalledWith("intake: the arguments of a subscription are broken", {
      subscriptionId: notObject.id,
    });
  });

  it("queues more than 100 deliveries in batches of 100", async () => {
    const sendBatch = vi.spyOn(queue, "sendBatch");
    for (let i = 0; i < 101; i++) await createSubscription({ user: owner });
    expect(await accept()).toMatchObject({ ok: true });
    expect(await countTable("deliveries")).toBe(101);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(queue.messages).toHaveLength(101);
  });
});

describe("queueing before success", () => {
  it("answers temporarily_unavailable when queueing fails, keeping the event and the deliveries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const subscription = await createSubscription({ user: owner });
    queue.fail = true;

    const result = await accept();
    expect(result).toMatchObject({ ok: false, error: { status: 503, code: "temporarily_unavailable" } });
    expect(await countTable("events")).toBe(1);
    const [row] = await listDeliveries();
    expect(row).toMatchObject({ subscription_id: subscription.id, status: "pending", attempts: 0 });

    // The sender retries with the same key: a duplicate that queues the delivery again.
    queue.fail = false;
    const retried = await accept();
    expect(retried).toMatchObject({ ok: true, duplicate: true });
    expect(queuedIds()).toEqual([row?.id]);
  });

  it("queues again only the pending deliveries that were never tried", async () => {
    const [unsent, retrying, delivered, failed] = await Promise.all(
      [0, 1, 2, 3].map(() => createSubscription({ user: owner })),
    );
    expect(await accept()).toMatchObject({ ok: true });
    const rows = await listDeliveries();
    const idOf = (subscriptionId: string | undefined) => rows.find((row) => row.subscription_id === subscriptionId)?.id;
    await env.DB.batch([
      env.DB.prepare("UPDATE deliveries SET attempts = 1 WHERE id = ?").bind(idOf(retrying?.id)),
      env.DB.prepare("UPDATE deliveries SET status = 'delivered', attempts = 1 WHERE id = ?").bind(idOf(delivered?.id)),
      env.DB.prepare("UPDATE deliveries SET status = 'failed' WHERE id = ?").bind(idOf(failed?.id)),
    ]);
    queue.messages.length = 0;

    expect(await accept()).toMatchObject({ ok: true, duplicate: true });
    expect(queuedIds()).toEqual([idOf(unsent?.id)]);
  });

  it("answers temporarily_unavailable for a duplicate when queueing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await createSubscription({ user: owner });
    expect(await accept()).toMatchObject({ ok: true });
    queue.fail = true;
    expect(await accept()).toMatchObject({ ok: false, error: { status: 503, code: "temporarily_unavailable" } });
  });

  it("does not queue for a conflicting duplicate", async () => {
    await createSubscription({ user: owner });
    expect(await accept()).toMatchObject({ ok: true });
    queue.messages.length = 0;
    expect(await accept({ ...INPUT, summary: "different" })).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    expect(queue.messages).toEqual([]);
  });

  it("queues the deliveries when the D1 write committed but threw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await createSubscription({ user: owner });
    const d1 = d1With({
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.batch(statements);
        throw new Error("network error after commit");
      },
    });
    expect(await accept(INPUT, { d1 })).toMatchObject({ ok: true, duplicate: false });
    const rows = await listDeliveries();
    expect(rows).toHaveLength(1);
    expect(queuedIds()).toEqual([rows[0]?.id]);
  });

  it("queues the other request's deliveries when it wrote the same event first", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const subscription = await createSubscription({ user: owner });
    let competing = "";
    const d1 = d1With({
      batch: async (statements: D1PreparedStatement[]) => {
        // The other request stores the same event with its delivery; its messages went to another queue.
        const first = await acceptEvent(
          { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now: Date.now() },
          intakeSource,
          INPUT,
        );
        if (!first.ok) throw new Error("the competing intake failed");
        competing = first.event_id;
        return env.DB.batch(statements);
      },
    });
    const result = await accept(INPUT, { d1 });
    expect(result).toEqual({ ok: true, event_id: competing, duplicate: true });
    const rows = await listDeliveries();
    expect(rows).toMatchObject([{ event_id: competing, subscription_id: subscription.id }]);
    expect(queuedIds()).toEqual([rows[0]?.id]);
  });
});

describe("the HTTP intake", () => {
  let key: string;

  beforeEach(async () => {
    ({ key } = await createApiKey(source.id));
  });

  function post(json: unknown, deliveryQueue: Queue<unknown>) {
    return send("/ingest/v1/events", {
      json,
      headers: { Authorization: `Bearer ${key}` },
      env: { DELIVERY_QUEUE: deliveryQueue as never },
    });
  }

  it("queues the deliveries before answering 201, and 503 then 200 when queueing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await createSubscription({ user: owner, arguments: '{"sources":["app"]}' });

    const created = await post(INPUT, queue);
    expect(created.status).toBe(201);
    expect(queue.messages).toHaveLength(1);

    queue.messages.length = 0;
    queue.fail = true;
    const second = { ...INPUT, idempotency_key: "k-2" };
    const failed = await post(second, queue);
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe("temporarily_unavailable");
    expect(await countTable("events")).toBe(2);
    expect(await listDeliveries("status = 'pending'")).toHaveLength(2);

    queue.fail = false;
    const retried = await post(second, queue);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ duplicate: true });
    expect(queue.messages).toHaveLength(1);
  });
});

describe("the RPC intake", () => {
  it("creates the deliveries, matching by the source name", async () => {
    await createSource({ id: RPC_SOURCE_ID, workspaceId: workspace.id, name: "worker" });
    const matching = await createSubscription({ user: owner, arguments: '{"sources":["worker"]}' });
    await createSubscription({ user: owner, arguments: '{"sources":["app"]}' });
    const result = await env.INTAKE.submit({ idempotency_key: "k", type: "t", summary: "s" });
    expect(result).toMatchObject({ ok: true, duplicate: false });
    expect(await listDeliveries()).toMatchObject([{ subscription_id: matching.id, status: "pending", attempts: 0 }]);
  });
});

describe("the queue consumer in tests", () => {
  // The producer is pointed at a queue without a consumer (vitest.config.ts), so that messages sent by the
  // intake are never consumed in the background.
  it("does not consume the messages sent by the intake", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      throw new Error(`unexpected fetch: ${String(input instanceof Request ? input.url : input)}`);
    });
    const { key } = await createApiKey(source.id);
    await createSubscription({ user: owner });
    const res = await send("/ingest/v1/events", { json: INPUT, headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await listDeliveries()).toMatchObject([{ status: "pending", attempts: 0, last_error: null }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("matchesFilter", () => {
  const event = { type: "alert.observed", sourceName: "app", labels: { project: "a", env: "prod" } };

  it.each<[string, EventFilter, boolean]>([
    ["no conditions", {}, true],
    ["a matching type", { types: ["job.finished", "alert.observed"] }, true],
    ["no matching type", { types: ["job.finished"] }, false],
    ["a matching source", { sources: ["worker", "app"] }, true],
    ["no matching source", { sources: ["App"] }, false],
    ["matching labels", { labels: { project: "a", env: "prod" } }, true],
    ["a label with another value", { labels: { project: "b" } }, false],
    ["a missing label", { labels: { team: "x" } }, false],
    ["a label inherited from Object", { labels: { constructor: "x" } }, false],
    ["all items matching", { types: ["alert.observed"], sources: ["app"], labels: { env: "prod" } }, true],
    ["one item not matching", { types: ["alert.observed"], sources: ["worker"], labels: { env: "prod" } }, false],
  ])("%s", (_name, filter, expected) => {
    expect(matchesFilter(event, filter)).toBe(expected);
  });

  it("selects the same events as list_events", async () => {
    const worker = await createSource({ workspaceId: workspace.id, name: "worker" });
    const sources = [source, worker];
    const inputs: { source: SourceRow; type: string; labels: Record<string, string> }[] = [];
    for (const s of sources) {
      for (const type of ["alert.observed", "job.finished"]) {
        const labelSets: Record<string, string>[] = [{}, { project: "a" }, { project: "b", env: "prod" }, { project: "a", env: "prod" }];
        for (const labels of labelSets) {
          inputs.push({ source: s, type, labels });
        }
      }
    }
    const events = new Map<string, (typeof inputs)[number]>();
    for (const [i, item] of inputs.entries()) {
      const result = await acceptEvent(
        { db: env.DB, bucket: env.EVENT_DATA, queue, now: Date.now() },
        { id: item.source.id, workspaceId: workspace.id, name: item.source.name, enabled: true },
        { idempotency_key: `k-${i}`, type: item.type, summary: "s", labels: item.labels },
      );
      if (!result.ok) throw new Error("ingest failed");
      events.set(result.event_id, item);
    }

    const filters: EventFilter[] = [
      {},
      { types: ["alert.observed"] },
      { types: ["alert.observed", "job.finished"] },
      { sources: ["worker"] },
      { sources: ["missing"] },
      { labels: { project: "a" } },
      { labels: { project: "a", env: "prod" } },
      { labels: { env: "dev" } },
      { types: ["job.finished"], sources: ["app"], labels: { project: "b" } },
    ];
    for (const filter of filters) {
      const listed = await listWorkspaceEvents(db, workspace.id, { filter, limit: 100 });
      const expected = [...events.entries()]
        .filter(([, item]) => matchesFilter({ type: item.type, sourceName: item.source.name, labels: item.labels }, filter))
        .map(([id]) => id)
        .sort();
      expect(listed.events.map((e) => e.event_id).sort(), JSON.stringify(filter)).toEqual(expected);
    }
  });
});
