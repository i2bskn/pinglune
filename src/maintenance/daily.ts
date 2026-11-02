// The daily cron (wrangler.jsonc triggers): logs deliveries that stay pending, fails the deliveries of polling
// queues that nobody took for 7 days, and deletes R2 objects that no event_data row refers to (left by intakes that
// stopped or failed between R2 and D1).
//
// Each run scans one page of R2 (up to 1,000 objects) and saves where it stopped, so that the Free plan's
// per-invocation limits hold. With many objects a full pass takes days (100,000 objects: about 100 days).

import { describeError } from "../auth/middleware";
import { stalePendingDeliveries } from "../deliveries/queries";
import { DATA_REF_PATTERN, EVENT_ID_PATTERN } from "../ids";
import { QUEUE_RETENTION_MS } from "../queues/constants";
import { expireQueueDeliveries } from "../queues/queries";

export type MaintenanceDeps = { db: D1Database; bucket: R2Bucket; now: number };

const HOUR_MS = 60 * 60 * 1000;
// Pending for longer than this is logged.
const STALE_PENDING_MS = HOUR_MS;
// Newer objects are kept: their intake may not have written D1 yet.
const ORPHAN_GRACE_MS = 24 * HOUR_MS;
const SCAN_PREFIX = "workspaces/";
const SCAN_LIMIT = 1000;
// The key of the object that holds the last scanned key. Outside SCAN_PREFIX, so it is never scanned.
export const SCAN_POSITION_KEY = "maintenance/orphan-scan-position";
// Bound parameters per query stay under D1's limit of 100.
const LOOKUP_CHUNK = 90;

// workspaces/<workspace>/events/<eventId>/<dataRef> (eventDataKey), or null for any other shape.
function parseDataKey(key: string): { dataRef: string } | null {
  const parts = key.split("/");
  if (parts.length !== 5) return null;
  const [root, workspaceId, events, eventId = "", dataRef = ""] = parts;
  if (root !== "workspaces" || workspaceId === "" || events !== "events") return null;
  if (!EVENT_ID_PATTERN.test(eventId) || !DATA_REF_PATTERN.test(dataRef)) return null;
  return { dataRef };
}

async function checkStalePending(deps: MaintenanceDeps): Promise<void> {
  try {
    const { count, oldestCreatedAt } = await stalePendingDeliveries(deps.db, deps.now - STALE_PENDING_MS);
    if (count > 0) console.warn("stale pending deliveries", { count, oldestCreatedAt });
  } catch (error) {
    console.error("checking stale pending deliveries failed", describeError(error));
  }
}

// Includes the deliveries of ended queues, and of queues ended by an admin's intervention.
async function expireQueues(deps: MaintenanceDeps): Promise<void> {
  try {
    const count = await expireQueueDeliveries(deps.db, deps.now - QUEUE_RETENTION_MS, deps.now);
    console.info("expired queue deliveries", { count });
  } catch (error) {
    console.error("expiring queue deliveries failed", describeError(error));
  }
}

// The key to continue after, or undefined to start from the beginning. Throws if the position cannot be read.
async function readScanPosition(bucket: R2Bucket): Promise<string | undefined> {
  const object = await bucket.get(SCAN_POSITION_KEY);
  if (object === null) return undefined;
  const position = await object.text();
  // Anything that is not a scanned key starts over.
  return position.startsWith(SCAN_PREFIX) ? position : undefined;
}

// The keys whose event_data row is missing or refers to another key.
async function findOrphans(db: D1Database, candidates: { key: string; dataRef: string }[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < candidates.length; i += LOOKUP_CHUNK) {
    const chunk = candidates.slice(i, i + LOOKUP_CHUNK);
    statements.push(
      db
        .prepare(`SELECT id, r2_key FROM event_data WHERE id IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk.map((candidate) => candidate.dataRef)),
    );
  }
  // One batch counts as one D1 query.
  const results = await db.batch<{ id: string; r2_key: string }>(statements);
  const keys = new Map<string, string>();
  for (const result of results) for (const row of result.results) keys.set(row.id, row.r2_key);
  return candidates.filter((candidate) => keys.get(candidate.dataRef) !== candidate.key).map((c) => c.key);
}

async function deleteOrphanObjects(deps: MaintenanceDeps): Promise<void> {
  const { db, bucket, now } = deps;
  try {
    const startAfter = await readScanPosition(bucket);
    const listed = await bucket.list({ prefix: SCAN_PREFIX, startAfter, limit: SCAN_LIMIT });

    const candidates: { key: string; dataRef: string }[] = [];
    let malformed = 0;
    for (const object of listed.objects) {
      if (object.uploaded.getTime() > now - ORPHAN_GRACE_MS) continue;
      const parsed = parseDataKey(object.key);
      if (parsed === null) {
        malformed++;
        continue;
      }
      candidates.push({ key: object.key, dataRef: parsed.dataRef });
    }
    if (malformed > 0) console.warn("objects with an unexpected key kept", { count: malformed });

    const orphans = await findOrphans(db, candidates);
    if (orphans.length > 0) await bucket.delete(orphans);
    console.log("orphan objects deleted", { count: orphans.length });

    const last = listed.objects.at(-1);
    if (listed.truncated && last !== undefined) {
      await bucket.put(SCAN_POSITION_KEY, last.key);
    } else {
      // The end: the next run starts from the beginning.
      await bucket.delete(SCAN_POSITION_KEY);
    }
  } catch (error) {
    // Runs again tomorrow.
    console.error("deleting orphan objects failed", describeError(error));
  }
}

// The tasks are independent: a failure of one does not stop the others.
export async function runDailyMaintenance(deps: MaintenanceDeps): Promise<void> {
  await Promise.all([checkStalePending(deps), expireQueues(deps), deleteOrphanObjects(deps)]);
}
