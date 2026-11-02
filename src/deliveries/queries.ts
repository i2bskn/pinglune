// The deliveries table: creation with the event, the state changes of the consumer, and the lists of the
// management screen.

import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import type { Delivery } from "../api/types";
import type { Db } from "../db/client";
import { deliveries, subscriptions, type DeliveryRow } from "../db/schema";

export const DELIVERY_PAGE_SIZE = 50;

// The first send and 5 retries.
export const MAX_ATTEMPTS = 6;

export type DeliveryStatus = DeliveryRow["status"];

// A pending delivery, for the batch that writes the event.
export function insertDeliveryStatement(
  d1: D1Database,
  params: { id: string; eventId: string; subscriptionId: string; workspaceId: string; now: number },
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO deliveries (id, event_id, subscription_id, workspace_id, status, attempts, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5)`,
    )
    .bind(params.id, params.eventId, params.subscriptionId, params.workspaceId, params.now);
}

// The pending deliveries of an event that were never tried: their messages may not be in the queue. Deliveries
// waiting for a retry are in the queue already. Deliveries to polling queues are never queued: they wait for
// claim_events.
export async function findUnsentDeliveryIds(d1: D1Database, eventId: string): Promise<string[]> {
  const { results } = await d1
    .prepare(
      `SELECT id FROM deliveries WHERE event_id = ? AND status = 'pending' AND attempts = 0
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = deliveries.subscription_id AND s.kind = 'queue')`,
    )
    .bind(eventId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

export function findDeliveryById(db: Db, id: string): Promise<DeliveryRow | undefined> {
  return db.select().from(deliveries).where(eq(deliveries.id, id)).get();
}

export type AttemptRecord = {
  status: DeliveryStatus;
  // The status of the response; null when there was none.
  httpStatus: number | null;
  // The reason of the failure; null on success.
  error: string | null;
  now: number;
};

// Records a send tried on a delivery that had `attempts` tries. Only a pending delivery with the same number of
// tries is updated, so that a delivery processed at the same time elsewhere is never overwritten. Returns
// whether the row was updated.
export async function recordAttempt(
  d1: D1Database,
  id: string,
  attempts: number,
  record: AttemptRecord,
): Promise<boolean> {
  const result = await d1
    .prepare(
      `UPDATE deliveries SET status = ?1, attempts = ?2, last_attempt_at = ?3, last_http_status = ?4, last_error = ?5,
        delivered_at = CASE WHEN ?1 = 'delivered' THEN ?3 ELSE delivered_at END, updated_at = ?3
      WHERE id = ?6 AND status = 'pending' AND attempts = ?7`,
    )
    .bind(record.status, attempts + 1, record.now, record.httpStatus, record.error, id, attempts)
    .run();
  return result.meta.changes === 1;
}

// Ends a pending delivery as failed without a send (attempts is unchanged). Returns whether the row was updated.
export async function failPendingDelivery(d1: D1Database, id: string, reason: string, now: number): Promise<boolean> {
  const result = await d1
    .prepare("UPDATE deliveries SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .bind(reason, now, id)
    .run();
  return result.meta.changes === 1;
}

// The pending deliveries created before a time: their number and the oldest created_at. Deliveries to polling
// queues are not counted: they stay pending until an AI takes them.
export async function stalePendingDeliveries(
  d1: D1Database,
  createdBefore: number,
): Promise<{ count: number; oldestCreatedAt: number | null }> {
  const row = await d1
    .prepare(
      `SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM deliveries WHERE status = 'pending' AND created_at < ?
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = deliveries.subscription_id AND s.kind = 'queue')`,
    )
    .bind(createdBefore)
    .first<{ count: number; oldest: number | null }>();
  return { count: row?.count ?? 0, oldestCreatedAt: row?.oldest ?? null };
}

// The host of a callback URL, or null if it is not a URL.
export function callbackHost(callbackUrl: string): string | null {
  try {
    return new URL(callbackUrl).hostname;
  } catch {
    return null;
  }
}

export type ListDeliveriesOptions = {
  // A delivery ID: only deliveries older than it.
  cursor?: string;
  // Only the deliveries of this event.
  eventId?: string;
};

// The newest deliveries of the workspace. The destinations (callback host, kind and name) are read from the
// subscriptions in a separate query.
export async function listWorkspaceDeliveries(
  db: Db,
  workspaceId: string,
  options: ListDeliveriesOptions = {},
): Promise<{ deliveries: Delivery[]; nextCursor: string | null }> {
  const limit = DELIVERY_PAGE_SIZE;
  const conditions: SQL[] = [eq(deliveries.workspaceId, workspaceId)];
  if (options.cursor !== undefined) conditions.push(lt(deliveries.id, options.cursor));
  if (options.eventId !== undefined) conditions.push(eq(deliveries.eventId, options.eventId));
  const rows = await db
    .select()
    .from(deliveries)
    .where(and(...conditions))
    .orderBy(desc(deliveries.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);

  const destinations = new Map<
    string,
    { host: string | null; kind: Delivery["destination_kind"]; name: string | null }
  >();
  const subscriptionIds = [...new Set(page.map((row) => row.subscriptionId))];
  if (subscriptionIds.length > 0) {
    const subscriptionRows = await db
      .select({
        id: subscriptions.id,
        kind: subscriptions.kind,
        name: subscriptions.name,
        callbackUrl: subscriptions.callbackUrl,
      })
      .from(subscriptions)
      .where(inArray(subscriptions.id, subscriptionIds))
      .all();
    for (const row of subscriptionRows) {
      destinations.set(row.id, { host: callbackHost(row.callbackUrl), kind: row.kind, name: row.name });
    }
  }

  const last = page[page.length - 1];
  return {
    deliveries: page.map((row) => ({
      id: row.id,
      event_id: row.eventId,
      subscription_id: row.subscriptionId,
      callback_host: destinations.get(row.subscriptionId)?.host ?? null,
      destination_kind: destinations.get(row.subscriptionId)?.kind ?? null,
      destination_name: destinations.get(row.subscriptionId)?.name ?? null,
      status: row.status,
      attempts: row.attempts,
      last_attempt_at: row.lastAttemptAt,
      last_http_status: row.lastHttpStatus,
      last_error: row.lastError,
      delivered_at: row.deliveredAt,
      created_at: row.createdAt,
    })),
    nextCursor: rows.length > limit && last ? last.id : null,
  };
}
