// The deliveries table: creation with the event, the state changes of the consumer, and the lists of the
// management screen.

import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import type { Delivery, DeliverySummary } from "../api/types";
import type { Db } from "../db/client";
import { deliveries, mcpConnections, subscriptions, type DeliveryRow } from "../db/schema";

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
  // Only the deliveries in this status. There is no index on the status: the scan of deliveries_workspace_id_id_idx
  // goes on until a page (and one more) is found, so it reads the whole workspace when few match.
  status?: DeliveryStatus;
};

// The newest deliveries of the workspace.
export async function listWorkspaceDeliveries(
  db: Db,
  workspaceId: string,
  options: ListDeliveriesOptions = {},
): Promise<{ deliveries: Delivery[]; nextCursor: string | null }> {
  const limit = DELIVERY_PAGE_SIZE;
  const conditions: SQL[] = [eq(deliveries.workspaceId, workspaceId)];
  if (options.cursor !== undefined) conditions.push(lt(deliveries.id, options.cursor));
  if (options.eventId !== undefined) conditions.push(eq(deliveries.eventId, options.eventId));
  if (options.status !== undefined) conditions.push(eq(deliveries.status, options.status));
  const rows = await db
    .select()
    .from(deliveries)
    .where(and(...conditions))
    .orderBy(desc(deliveries.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    deliveries: await toApiDeliveries(db, page),
    nextCursor: rows.length > limit && last ? last.id : null,
  };
}

// One delivery only if it belongs to the workspace.
export function findWorkspaceDelivery(db: Db, workspaceId: string, id: string): Promise<DeliveryRow | undefined> {
  return db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.id, id), eq(deliveries.workspaceId, workspaceId)))
    .get();
}

// The deliveries as the API returns them. The destinations (callback host, kind and name) are read from the
// subscriptions in a separate query. At most DELIVERY_PAGE_SIZE rows, so that the IDs stay within the bound
// variables of D1.
export async function toApiDeliveries(db: Db, rows: DeliveryRow[]): Promise<Delivery[]> {
  const destinations = new Map<
    string,
    { host: string | null; kind: Delivery["destination_kind"]; name: string | null }
  >();
  const subscriptionIds = [...new Set(rows.map((row) => row.subscriptionId))];
  if (subscriptionIds.length > 0) {
    const subscriptionRows = await db
      .select({
        id: subscriptions.id,
        kind: subscriptions.kind,
        name: subscriptions.name,
        callbackUrl: subscriptions.callbackUrl,
        connectionId: subscriptions.connectionId,
      })
      .from(subscriptions)
      .where(inArray(subscriptions.id, subscriptionIds))
      .all();
    // MCP Events subscriptions have no name: they are named by the app of their connection, as the screens show them.
    const connectionIds = [
      ...new Set(subscriptionRows.flatMap((row) => (row.kind === "mcp" && row.connectionId !== null ? [row.connectionId] : []))),
    ];
    const appNames = new Map<string, string>();
    if (connectionIds.length > 0) {
      const connectionRows = await db
        .select({ id: mcpConnections.id, clientName: mcpConnections.clientName })
        .from(mcpConnections)
        .where(inArray(mcpConnections.id, connectionIds))
        .all();
      for (const row of connectionRows) appNames.set(row.id, row.clientName);
    }
    for (const row of subscriptionRows) {
      const name = row.kind === "mcp" && row.connectionId !== null ? (appNames.get(row.connectionId) ?? null) : row.name;
      destinations.set(row.id, { host: callbackHost(row.callbackUrl), kind: row.kind, name });
    }
  }
  return rows.map((row) => ({
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
  }));
}

// The number of deliveries of each event by status, in one query. Events without deliveries are counted as zeros. At
// most DELIVERY_PAGE_SIZE events (plus the workspace ID), within the bound variables of D1.
export async function deliverySummaries(
  d1: D1Database,
  workspaceId: string,
  eventIds: string[],
): Promise<Map<string, DeliverySummary>> {
  const ids = [...new Set(eventIds)];
  const summaries = new Map<string, DeliverySummary>(ids.map((id) => [id, { delivered: 0, pending: 0, failed: 0 }]));
  if (ids.length === 0) return summaries;
  const { results } = await d1
    .prepare(
      `SELECT event_id, status, COUNT(*) AS count FROM deliveries
      WHERE workspace_id = ? AND event_id IN (${ids.map(() => "?").join(", ")}) GROUP BY event_id, status`,
    )
    .bind(workspaceId, ...ids)
    .all<{ event_id: string; status: string; count: number }>();
  for (const row of results) {
    const summary = summaries.get(row.event_id);
    if (summary === undefined) continue;
    if (row.status === "delivered" || row.status === "pending" || row.status === "failed") summary[row.status] = row.count;
  }
  return summaries;
}

// Makes a failed delivery pending again, as if it had never been tried, for a retry from the management screen. Only
// a failed delivery of the workspace is updated, so that two retries at the same time enqueue it once. Returns
// whether the row was updated.
export async function resetFailedDelivery(d1: D1Database, workspaceId: string, id: string, now: number): Promise<boolean> {
  const result = await d1
    .prepare(
      `UPDATE deliveries SET status = 'pending', attempts = 0, last_error = NULL, last_http_status = NULL,
        last_attempt_at = NULL, delivered_at = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status = 'failed'`,
    )
    .bind(now, id, workspaceId)
    .run();
  return result.meta.changes === 1;
}

// Ends a delivery reset by resetFailedDelivery as failed again when its message could not be enqueued. Only a
// delivery still untried is updated: the consumer may have taken it already. The failure before the retry is not
// restored.
export async function revertRetry(d1: D1Database, id: string, now: number): Promise<boolean> {
  const result = await d1
    .prepare(
      `UPDATE deliveries SET status = 'failed', last_error = 'retry_enqueue_failed', updated_at = ?
      WHERE id = ? AND status = 'pending' AND attempts = 0`,
    )
    .bind(now, id)
    .run();
  return result.meta.changes === 1;
}
