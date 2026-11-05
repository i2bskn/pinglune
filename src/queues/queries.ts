// The polling queues (subscriptions of kind "queue") and their deliveries: the management screen, the claims and
// acks of the MCP tools, and the cleanups.
//
// Deliveries are never deleted (only with the workspace), so the queries over deliveries never read the whole
// history of a queue: they all use deliveries_status_created_at_idx with status = 'pending', and pending rows are
// few (they move on to delivered or failed). INDEXED BY keeps the plan the same when D1 gathers statistics.

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { EventSummary } from "../api/types";
import type { Db } from "@i2bskn/workers-app-core";
import { subscriptions, type SubscriptionRow } from "../db/schema";
import { failPendingDelivery } from "../deliveries/queries";
import { findWorkspaceEventsByIds } from "../events/queries";
import { DELIVERY_ID_PATTERN } from "../ids";
import { DELIVERABLE_EVENT_SQL } from "../screening/state";
import type { StatementGuard } from "../subscriptions/queries";
import { QUEUE_LEASE_MS, QUEUE_MAX_CLAIMS, QUEUE_RETENTION_MS } from "./constants";

// The polling queues of a workspace for the management screen: the active ones first, then newest first, so that
// ended ones never push an active one out of the limit.
export function listWorkspaceQueues(db: Db, workspaceId: string, limit: number): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, workspaceId), eq(subscriptions.kind, "queue")))
    .orderBy(
      asc(sql`${subscriptions.unsubscribedAt} IS NOT NULL`),
      desc(subscriptions.createdAt),
      desc(subscriptions.id),
    )
    .limit(limit)
    .all();
}

// The polling queues of a workspace that are not ended, for the limit.
export async function countActiveQueues(db: Db, workspaceId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        eq(subscriptions.kind, "queue"),
        isNull(subscriptions.unsubscribedAt),
      ),
    )
    .get();
  return row?.count ?? 0;
}

// The polling queue of a workspace with this ID that is not ended. Other kinds are never matched.
export function findActiveWorkspaceQueue(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<SubscriptionRow | undefined> {
  return db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, id),
        eq(subscriptions.workspaceId, workspaceId),
        eq(subscriptions.kind, "queue"),
        isNull(subscriptions.unsubscribedAt),
      ),
    )
    .get();
}

// Ends a polling queue of a workspace and fails its pending deliveries, in one batch. Ending it again keeps the
// first unsubscribed_at; failing the pending deliveries again does no harm.
export async function endQueue(d1: D1Database, workspaceId: string, id: string, now: number): Promise<void> {
  await d1.batch(endQueueStatements(d1, workspaceId, id, now));
}

// The statements of endQueue, so that they can join another batch. A guard (an EXISTS condition with its values)
// is added to both, so that they change nothing when it does not hold. Deliveries claimed and not acknowledged fail
// too: a later ack counts them as not found.
export function endQueueStatements(
  d1: D1Database,
  workspaceId: string,
  id: string,
  now: number,
  guard?: StatementGuard,
): D1PreparedStatement[] {
  const condition = guard === undefined ? "" : ` AND ${guard.sql}`;
  const values = guard === undefined ? [] : guard.values;
  return [
    d1
      .prepare(
        `UPDATE subscriptions SET unsubscribed_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND kind = 'queue' AND unsubscribed_at IS NULL${condition}`,
      )
      .bind(now, now, id, workspaceId, ...values),
    d1
      .prepare(
        `UPDATE deliveries INDEXED BY deliveries_status_created_at_idx
        SET status = 'failed', last_error = 'subscription_inactive', updated_at = ?
        WHERE status = 'pending' AND subscription_id = ? AND workspace_id = ?${condition}`,
      )
      .bind(now, id, workspaceId, ...values),
  ];
}

// The deliveries of a queue that may be claimed now, oldest first. The deliveries of events that may not be
// delivered (held or waiting for the screening, src/screening/state.ts) are not claimed. A query of its own so that
// a test can check its plan.
export function claimableDeliveriesStatement(
  d1: D1Database,
  params: { workspaceId: string; queueId: string; now: number; limit: number },
): D1PreparedStatement {
  return d1
    .prepare(
      `SELECT id, event_id, attempts FROM deliveries INDEXED BY deliveries_status_created_at_idx
      WHERE status = 'pending' AND created_at > ?1 AND subscription_id = ?2 AND workspace_id = ?3 AND attempts < ?4
        AND (attempts = 0 OR last_attempt_at <= ?5) AND ${DELIVERABLE_EVENT_SQL}
      ORDER BY created_at, id LIMIT ?6`,
    )
    .bind(
      params.now - QUEUE_RETENTION_MS,
      params.queueId,
      params.workspaceId,
      QUEUE_MAX_CLAIMS,
      params.now - QUEUE_LEASE_MS,
      params.limit,
    );
}

export type ClaimedDelivery = { deliveryId: string; claimCount: number; event: EventSummary };

type ClaimableRow = { id: string; event_id: string; attempts: number };

// Claims up to limit deliveries of a queue, oldest first. Deliveries claimed QUEUE_MAX_CLAIMS times whose last
// lease has run out fail first as not_acknowledged. hasMore tells whether more deliveries could be claimed when
// they were read; it may be true with fewer than limit items when another claim took some at the same time.
export async function claimQueueDeliveries(
  d1: D1Database,
  db: Db,
  params: { workspaceId: string; queueId: string; now: number; limit: number },
): Promise<{ items: ClaimedDelivery[]; hasMore: boolean }> {
  const { workspaceId, queueId, now, limit } = params;
  const [, candidates] = await d1.batch<ClaimableRow>([
    d1
      .prepare(
        `UPDATE deliveries INDEXED BY deliveries_status_created_at_idx
        SET status = 'failed', last_error = 'not_acknowledged', updated_at = ?1
        WHERE status = 'pending' AND created_at > ?2 AND subscription_id = ?3 AND workspace_id = ?4 AND attempts >= ?5
          AND last_attempt_at <= ?6`,
      )
      .bind(now, now - QUEUE_RETENTION_MS, queueId, workspaceId, QUEUE_MAX_CLAIMS, now - QUEUE_LEASE_MS),
    claimableDeliveriesStatement(d1, { workspaceId, queueId, now, limit: limit + 1 }),
  ]);
  const rows = candidates?.results ?? [];
  const page = rows.slice(0, limit);
  if (page.length === 0) return { items: [], hasMore: false };

  // Every claim adds 1 to attempts, so matching it alone lets only one of the claims at the same time win.
  const results = await d1.batch(
    page.map((row) =>
      d1
        .prepare(
          `UPDATE deliveries SET attempts = attempts + 1, last_attempt_at = ?1, updated_at = ?1
          WHERE id = ?2 AND status = 'pending' AND attempts = ?3`,
        )
        .bind(now, row.id, row.attempts),
    ),
  );
  const claimed = page.filter((_, index) => results[index]?.meta.changes === 1);

  const events = new Map(
    (await findWorkspaceEventsByIds(
      db,
      workspaceId,
      claimed.map((row) => row.event_id),
    )).map((event) => [event.event_id, event]),
  );
  const items: ClaimedDelivery[] = [];
  for (const row of claimed) {
    const event = events.get(row.event_id);
    if (event === undefined) {
      await failPendingDelivery(d1, row.id, "event_not_found", now);
      continue;
    }
    items.push({ deliveryId: row.id, claimCount: row.attempts + 1, event });
  }
  return { items, hasMore: rows.length > limit };
}

export type AckResult = { acknowledged: number; alreadyAcknowledged: number; notFound: number };

// Marks pending deliveries of a queue as delivered. Duplicate IDs count once; IDs that are malformed, not found,
// of another queue or workspace, or failed count as not found. Counts may be off when acks run at the same time.
export async function ackQueueDeliveries(
  d1: D1Database,
  params: { workspaceId: string; queueId: string; deliveryIds: string[]; now: number },
): Promise<AckResult> {
  const { workspaceId, queueId, now } = params;
  const unique = [...new Set(params.deliveryIds)];
  const ids = unique.filter((id) => DELIVERY_ID_PATTERN.test(id));
  if (ids.length === 0) return { acknowledged: 0, alreadyAcknowledged: 0, notFound: unique.length };

  const placeholders = ids.map((_, index) => `?${index + 4}`).join(", ");
  const [updated, delivered] = await d1.batch<{ count: number }>([
    d1
      .prepare(
        `UPDATE deliveries SET status = 'delivered', delivered_at = ?1, updated_at = ?1
        WHERE id IN (${placeholders}) AND subscription_id = ?2 AND workspace_id = ?3 AND status = 'pending'`,
      )
      .bind(now, queueId, workspaceId, ...ids),
    d1
      .prepare(
        `SELECT COUNT(*) AS count FROM deliveries
        WHERE id IN (${placeholders}) AND subscription_id = ?2 AND workspace_id = ?3 AND status = 'delivered'`,
      )
      .bind(null, queueId, workspaceId, ...ids),
  ]);
  const acknowledged = updated?.meta.changes ?? 0;
  const alreadyAcknowledged = Math.max(0, (delivered?.results[0]?.count ?? 0) - acknowledged);
  return { acknowledged, alreadyAcknowledged, notFound: unique.length - acknowledged - alreadyAcknowledged };
}

// Fails the pending deliveries of every queue created at or before a time as expired, including those of ended
// queues. Returns their number.
export async function expireQueueDeliveries(d1: D1Database, createdAtOrBefore: number, now: number): Promise<number> {
  const result = await d1
    .prepare(
      `UPDATE deliveries INDEXED BY deliveries_status_created_at_idx
      SET status = 'failed', last_error = 'expired', updated_at = ?1
      WHERE status = 'pending' AND created_at <= ?2
        AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = deliveries.subscription_id AND s.kind = 'queue')`,
    )
    .bind(now, createdAtOrBefore)
    .run();
  return result.meta.changes;
}
