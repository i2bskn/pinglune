import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
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

// expires_at of webhook destinations, which do not expire: 9999-12-31T23:59:59.999Z. Being a time, it keeps the
// active check (unsubscribed_at IS NULL AND expires_at > now) the same for every kind.
export const NO_EXPIRY = 253402300799999;

// The MCP Events subscriptions of a workspace for the management screen, newest first.
export function listWorkspaceMcpSubscriptions(db: Db, workspaceId: string, limit: number): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, workspaceId), eq(subscriptions.kind, "mcp")))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(limit)
    .all();
}

// The webhook destinations of a workspace for the management screen: the active ones first, then newest first, so
// that ended ones never push an active one out of the limit.
export function listWorkspaceWebhookDestinations(
  db: Db,
  workspaceId: string,
  limit: number,
): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, workspaceId), eq(subscriptions.kind, "webhook")))
    .orderBy(
      asc(sql`${subscriptions.unsubscribedAt} IS NOT NULL`),
      desc(subscriptions.createdAt),
      desc(subscriptions.id),
    )
    .limit(limit)
    .all();
}

// The webhook destination of a workspace with this ID. MCP subscriptions are never matched.
export function findWorkspaceWebhookDestination(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<SubscriptionRow | undefined> {
  return db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.id, id), eq(subscriptions.workspaceId, workspaceId), eq(subscriptions.kind, "webhook")),
    )
    .get();
}

// The webhook destination or polling queue of a workspace with this ID: the subscriptions that the management
// screen registers and deletes. MCP subscriptions are never matched.
export function findWorkspaceDestination(
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
        inArray(subscriptions.kind, ["webhook", "queue"]),
      ),
    )
    .get();
}

// The webhook destinations of a workspace that are not ended, for the limit.
export async function countActiveWebhookDestinations(db: Db, workspaceId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        eq(subscriptions.kind, "webhook"),
        isNull(subscriptions.unsubscribedAt),
      ),
    )
    .get();
  return row?.count ?? 0;
}

// Ends a webhook destination of a workspace. Ending it again keeps the first unsubscribed_at.
export async function endWebhookDestination(db: Db, workspaceId: string, id: string, now: number): Promise<void> {
  await db
    .update(subscriptions)
    .set({ unsubscribedAt: now, updatedAt: now })
    .where(
      and(
        eq(subscriptions.id, id),
        eq(subscriptions.workspaceId, workspaceId),
        eq(subscriptions.kind, "webhook"),
        isNull(subscriptions.unsubscribedAt),
      ),
    )
    .run();
}

export function isActiveSubscription(row: SubscriptionRow, now: number): boolean {
  return row.unsubscribedAt === null && row.expiresAt > now;
}

// Inserts an MCP Events subscription, or updates the one with the same ID. user_id, workspace_id, event_name,
// arguments and callback_url follow from the ID (or are kept), and kind and name are kept, so an update leaves them
// as they are. Webhook destinations are inserted without this: an ID collision must not overwrite a row.
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

// Ends the user's MCP Events subscriptions when their access is revoked, and when includeWebhooks is set also their
// webhook destinations and polling queues (every kind other than mcp). Webhook destinations deliver with a key of
// the receiver, not with the user's login, and polling queues are passive buffers read through MCP (which needs
// the user to authorize again), so the user's own password change leaves them; an admin's intervention (which may
// answer a compromise) ends them.
// A query, so that it can join a batch.
export function endUserSubscriptionsQuery(
  db: Db,
  userId: string,
  now: number,
  options: { includeWebhooks: boolean },
) {
  const conditions = [eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)];
  if (!options.includeWebhooks) conditions.push(eq(subscriptions.kind, "mcp"));
  return db
    .update(subscriptions)
    .set({ unsubscribedAt: now, updatedAt: now })
    .where(and(...conditions));
}
