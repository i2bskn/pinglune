import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { subscriptions, type SubscriptionRow } from "../db/schema";

export function findSubscriptionById(db: Db, id: string): Promise<SubscriptionRow | undefined> {
  return db.select().from(subscriptions).where(eq(subscriptions.id, id)).get();
}

// The active subscriptions of a workspace: not ended and not expired.
export function findActiveWorkspaceSubscriptions(db: Db, workspaceId: string, now: number): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.workspaceId, workspaceId), isNull(subscriptions.unsubscribedAt), gt(subscriptions.expiresAt, now)),
    )
    .all();
}

// Every subscription of a workspace for the management screen, newest first.
export function listWorkspaceSubscriptions(db: Db, workspaceId: string, limit: number): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspaceId))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(limit)
    .all();
}

export function isActiveSubscription(row: SubscriptionRow, now: number): boolean {
  return row.unsubscribedAt === null && row.expiresAt > now;
}

// Inserts a subscription, or updates the one with the same ID. user_id, workspace_id, event_name, arguments and
// callback_url follow from the ID (or are kept), so an update leaves them as they are.
export async function upsertSubscription(db: Db, row: SubscriptionRow): Promise<void> {
  await db
    .insert(subscriptions)
    .values(row)
    .onConflictDoUpdate({
      target: subscriptions.id,
      set: {
        secret: row.secret,
        previousSecret: row.previousSecret,
        secretRotatedAt: row.secretRotatedAt,
        expiresAt: row.expiresAt,
        unsubscribedAt: null,
        updatedAt: row.updatedAt,
      },
    })
    .run();
}

// Ends the user's subscription with this ID. Rows of other users are never matched.
export async function endSubscription(db: Db, id: string, userId: string, now: number): Promise<void> {
  await db
    .update(subscriptions)
    .set({ unsubscribedAt: now, updatedAt: now })
    .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)))
    .run();
}

// Ends every subscription of the user, when their access is revoked. A query, so that it can join a batch.
export function endUserSubscriptionsQuery(db: Db, userId: string, now: number) {
  return db
    .update(subscriptions)
    .set({ unsubscribedAt: now, updatedAt: now })
    .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));
}
