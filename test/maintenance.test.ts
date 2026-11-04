import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import type { WorkspaceRow } from "../src/db/schema";
import worker from "../src/index";
import { acceptEvent } from "../src/intake/service";
import { runDailyMaintenance, SCAN_POSITION_KEY } from "../src/maintenance/daily";
import {
  bucketWith,
  createSource,
  createSubscription,
  createUser,
  d1With,
  fakeQueue,
  listEventDataKeys,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
} from "./helpers";

const HOUR = 60 * 60 * 1000;

let workspace: WorkspaceRow;
// The key of the body of a stored event: referenced by its event_data row.
let referencedKey: string;
let referencedDataRef: string;
let eventId: string;
let start: number;

// IDs that sort in the given order.
function eventIdOf(n: number): string {
  return `evt_${String(n).padStart(26, "0")}`;
}

function dataRefOf(n: number): string {
  return `dat_${String(n).padStart(26, "0")}`;
}

function orphanKey(n: number): string {
  return `workspaces/${workspace.id}/events/${eventIdOf(n)}/${dataRefOf(n)}`;
}

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  start = Date.now();
  const user = await createUser({ email: "owner@example.com" });
  workspace = await personalWorkspaceOf(user);
  const source = await createSource({ workspaceId: workspace.id, name: "app" });
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now: start },
    { id: source.id, workspaceId: workspace.id, name: source.name, enabled: true, screeningEnabled: false },
    { idempotency_key: "k", type: "t", summary: "s", body: { content_type: "text/plain", bytes: new Uint8Array([1]) } },
  );
  if (!result.ok) throw new Error("ingest failed");
  eventId = result.event_id;
  const row = await env.DB.prepare("SELECT id, r2_key FROM event_data WHERE event_id = ?")
    .bind(eventId)
    .first<{ id: string; r2_key: string }>();
  if (!row) throw new Error("no event data");
  referencedKey = row.r2_key;
  referencedDataRef = row.id;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

// A day and an hour later: every object stored by the test is past the grace period.
function later(): number {
  return Date.now() + 25 * HOUR;
}

// The bucket with list() returning at most pageSize objects, and the objects in recent uploaded now.
function listingBucket(options: { pageSize?: number; recent?: Set<string>; now?: number } = {}): R2Bucket {
  return bucketWith({
    list: async (listOptions: R2ListOptions) => {
      const listed = await env.EVENT_DATA.list({ ...listOptions, limit: options.pageSize ?? listOptions.limit });
      return {
        ...listed,
        objects: listed.objects.map((object) => ({
          key: object.key,
          uploaded: options.recent?.has(object.key) ? new Date(options.now ?? Date.now()) : object.uploaded,
        })),
      };
    },
  });
}

async function scanPosition(): Promise<string | null> {
  const object = await env.EVENT_DATA.get(SCAN_POSITION_KEY);
  return object === null ? null : object.text();
}

describe("deleting orphan objects", () => {
  it("deletes only old objects that no event_data row refers to", async () => {
    const otherWorkspaceKey = `workspaces/other/events/${eventId}/${referencedDataRef}`;
    const malformed = [
      `workspaces/${workspace.id}/events/evt_bad/${dataRefOf(1)}`,
      `workspaces/${workspace.id}/events/${eventIdOf(1)}/dat_bad`,
      `workspaces/${workspace.id}/other/${eventIdOf(1)}/${dataRefOf(1)}`,
      `workspaces/${workspace.id}/events/${eventIdOf(1)}/${dataRefOf(1)}/extra`,
    ];
    for (const key of [orphanKey(1), orphanKey(2), otherWorkspaceKey, ...malformed]) {
      await env.EVENT_DATA.put(key, "x");
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const now = later();

    // orphanKey(2) was uploaded within the last 24 hours.
    await runDailyMaintenance({
      db: env.DB,
      queue: fakeQueue(),
      bucket: listingBucket({ recent: new Set([orphanKey(2)]), now }),
      now,
    });

    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey, orphanKey(2), ...malformed].sort());
    expect(log).toHaveBeenCalledWith("orphan objects deleted", { count: 2 });
    expect(warn).toHaveBeenCalledWith("objects with an unexpected key kept", { count: malformed.length });
    // One page that was not truncated: the next run starts from the beginning.
    expect(await scanPosition()).toBeNull();
  });

  it("keeps every object within 24 hours of its upload", async () => {
    await env.EVENT_DATA.put(orphanKey(1), "x");
    await runDailyMaintenance({ db: env.DB, queue: fakeQueue(), bucket: env.EVENT_DATA, now: Date.now() + 23 * HOUR });
    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey, orphanKey(1)].sort());
  });

  it("scans one page per run, continuing from the saved position", async () => {
    // Sorted: orphanKey(1..4) come before the referenced key (its IDs are newer ULIDs).
    for (const n of [1, 2, 3, 4]) await env.EVENT_DATA.put(orphanKey(n), "x");
    const bucket = listingBucket({ pageSize: 2 });

    await runDailyMaintenance({ db: env.DB, queue: fakeQueue(), bucket, now: later() });
    expect(await listEventDataKeys("workspaces/")).toEqual([orphanKey(3), orphanKey(4), referencedKey].sort());
    expect(await scanPosition()).toBe(orphanKey(2));

    await runDailyMaintenance({ db: env.DB, queue: fakeQueue(), bucket, now: later() });
    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey]);
    expect(await scanPosition()).toBe(orphanKey(4));

    // The last page is not truncated: the position is removed.
    await env.EVENT_DATA.put(orphanKey(5), "x");
    await runDailyMaintenance({ db: env.DB, queue: fakeQueue(), bucket, now: later() });
    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey]);
    expect(await scanPosition()).toBeNull();
  });

  it("starts from the beginning when the saved position is not a key", async () => {
    await env.EVENT_DATA.put(orphanKey(1), "x");
    await env.EVENT_DATA.put(SCAN_POSITION_KEY, "garbage");
    await runDailyMaintenance({ db: env.DB, queue: fakeQueue(), bucket: env.EVENT_DATA, now: later() });
    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey]);
    expect(await scanPosition()).toBeNull();
  });

  it("stops when the saved position cannot be read", async () => {
    await env.EVENT_DATA.put(orphanKey(1), "x");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bucket = bucketWith({
      get: async () => {
        throw new Error("R2 is down");
      },
    });
    await runDailyMaintenance({ db: env.DB, queue: fakeQueue(), bucket, now: later() });
    expect(error).toHaveBeenCalledWith("deleting orphan objects failed", expect.anything());
    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey, orphanKey(1)].sort());
  });

  it("deletes nothing when the lookup in D1 fails", async () => {
    await env.EVENT_DATA.put(orphanKey(1), "x");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = d1With({
      batch: async () => {
        throw new Error("D1 is down");
      },
    });
    await runDailyMaintenance({ db, queue: fakeQueue(), bucket: env.EVENT_DATA, now: later() });
    expect(error).toHaveBeenCalledWith("deleting orphan objects failed", expect.anything());
    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey, orphanKey(1)].sort());
  });
});

describe("checking stale pending deliveries", () => {
  async function insertDelivery(id: string, status: string, createdAt: number) {
    const user = await createUser({ email: `${id}@example.com` });
    const subscription = await createSubscription({ user, workspaceId: workspace.id });
    await env.DB.prepare(
      `INSERT INTO deliveries (id, event_id, subscription_id, workspace_id, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(`dlv_${id.padStart(26, "0")}`, eventId, subscription.id, workspace.id, status, createdAt, createdAt)
      .run();
  }

  it("warns about deliveries pending for more than an hour, without changing them", async () => {
    const now = start;
    await insertDelivery("1", "pending", now - 3 * HOUR);
    await insertDelivery("2", "pending", now - 2 * HOUR);
    await insertDelivery("3", "pending", now - HOUR);
    await insertDelivery("4", "delivered", now - 5 * HOUR);
    await insertDelivery("5", "failed", now - 5 * HOUR);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runDailyMaintenance({ db: env.DB, queue: fakeQueue(), bucket: env.EVENT_DATA, now });

    expect(warn).toHaveBeenCalledWith("stale pending deliveries", { count: 2, oldestCreatedAt: now - 3 * HOUR });
    const { results } = await env.DB.prepare("SELECT status FROM deliveries ORDER BY id").all<{ status: string }>();
    expect(results.map((row) => row.status)).toEqual(["pending", "pending", "pending", "delivered", "failed"]);
  });

  it("does not warn when nothing is stale", async () => {
    await insertDelivery("1", "pending", start - HOUR + 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runDailyMaintenance({ db: env.DB, queue: fakeQueue(), bucket: env.EVENT_DATA, now: start });
    expect(warn).not.toHaveBeenCalledWith("stale pending deliveries", expect.anything());
  });

  it("runs independently of the orphan deletion", async () => {
    await insertDelivery("1", "pending", start - 2 * HOUR);
    await env.EVENT_DATA.put(orphanKey(1), "x");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // R2 fails: the check still warns.
    const failingBucket = bucketWith({
      list: async () => {
        throw new Error("R2 is down");
      },
    });
    await runDailyMaintenance({ db: env.DB, queue: fakeQueue(), bucket: failingBucket, now: start });
    expect(warn).toHaveBeenCalledWith("stale pending deliveries", expect.objectContaining({ count: 1 }));

    // The check fails: orphans are still deleted.
    const failingDb = d1With({
      prepare: (query: string) => {
        if (query.includes("FROM deliveries")) throw new Error("D1 is down");
        return env.DB.prepare(query);
      },
    });
    await runDailyMaintenance({ db: failingDb, queue: fakeQueue(), bucket: env.EVENT_DATA, now: later() });
    expect(error).toHaveBeenCalledWith("checking stale pending deliveries failed", expect.anything());
    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey]);
  });
});

describe("the scheduled handler", () => {
  it("runs the daily maintenance", async () => {
    await env.EVENT_DATA.put(orphanKey(1), "x");
    const now = later();
    vi.spyOn(clock, "now").mockImplementation(() => now);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "0 18 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey]);
  });

  it("does nothing when the configuration is invalid", async () => {
    await env.EVENT_DATA.put(orphanKey(1), "x");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const now = later();
    vi.spyOn(clock, "now").mockImplementation(() => now);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), { ...env, JWT_SECRET: "short" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(await listEventDataKeys("workspaces/")).toEqual([referencedKey, orphanKey(1)].sort());
  });
});
