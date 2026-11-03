// The bots of a workspace, their MCP connections and their destinations.

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { bots, mcpConnections, subscriptions, type BotRow, type McpConnectionRow, type SubscriptionRow } from "../db/schema";
import { isActiveSubscription } from "../subscriptions/queries";

export const MAX_BOTS_PER_WORKSPACE = 20;

// The bots of the workspace that are not deleted, by name.
export function listWorkspaceBots(db: Db, workspaceId: string, limit: number): Promise<BotRow[]> {
  return db
    .select()
    .from(bots)
    .where(and(eq(bots.workspaceId, workspaceId), isNull(bots.deletedAt)))
    .orderBy(asc(bots.name), asc(bots.id))
    .limit(limit)
    .all();
}

// The bot of the workspace with this ID, only if it is not deleted.
export function findActiveWorkspaceBot(db: Db, workspaceId: string, id: string): Promise<BotRow | undefined> {
  return db
    .select()
    .from(bots)
    .where(and(eq(bots.id, id), eq(bots.workspaceId, workspaceId), isNull(bots.deletedAt)))
    .get();
}

// The bot of the workspace with this ID, deleted or not.
export function findWorkspaceBot(db: Db, workspaceId: string, id: string): Promise<BotRow | undefined> {
  return db
    .select()
    .from(bots)
    .where(and(eq(bots.id, id), eq(bots.workspaceId, workspaceId)))
    .get();
}

// The bots of the workspace with these IDs, deleted or not, by ID.
export async function workspaceBotsByIds(db: Db, workspaceId: string, ids: string[]): Promise<Map<string, BotRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(bots)
    .where(and(eq(bots.workspaceId, workspaceId), inArray(bots.id, [...new Set(ids)])))
    .all();
  return new Map(rows.map((row) => [row.id, row]));
}

// The bots of the workspace that are not deleted, for the limit.
export async function countActiveBots(db: Db, workspaceId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(bots)
    .where(and(eq(bots.workspaceId, workspaceId), isNull(bots.deletedAt)))
    .get();
  return row?.count ?? 0;
}

// The active MCP connection of each of these bots (at most one: mcp_connections_active_bot_unique), by bot ID.
export async function activeConnectionsByBot(
  db: Db,
  workspaceId: string,
  botIds: string[],
): Promise<Map<string, McpConnectionRow>> {
  const result = new Map<string, McpConnectionRow>();
  if (botIds.length === 0) return result;
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(
      and(
        eq(mcpConnections.workspaceId, workspaceId),
        inArray(mcpConnections.botId, [...new Set(botIds)]),
        isNull(mcpConnections.revokedAt),
      ),
    )
    .all();
  for (const row of rows) if (row.botId !== null) result.set(row.botId, row);
  return result;
}

// The destination of each bot now, by bot ID; null when there is none:
// - a deleted bot: null.
// - webhook / queue: delivery_subscription_id, if it is active.
// - mcp: the active MCP Events subscription of the bot's active connection updated last (an AI that was installed
//   again may leave an old subscription behind until it expires).
// connections may be passed when the caller has read them already.
export async function resolveBotDeliveries(
  db: Db,
  workspaceId: string,
  botRows: BotRow[],
  now: number,
  connections?: Map<string, McpConnectionRow>,
): Promise<Map<string, SubscriptionRow | null>> {
  const result = new Map<string, SubscriptionRow | null>();
  const live = botRows.filter((bot) => bot.deletedAt === null);
  for (const bot of botRows) result.set(bot.id, null);

  const destinationIds = live
    .filter((bot) => bot.deliveryKind !== "mcp" && bot.deliverySubscriptionId !== null)
    .map((bot) => bot.deliverySubscriptionId as string);
  const mcpBots = live.filter((bot) => bot.deliveryKind === "mcp");
  const byBot = connections ?? (await activeConnectionsByBot(db, workspaceId, mcpBots.map((bot) => bot.id)));
  const connectionIds = mcpBots.flatMap((bot) => {
    const connection = byBot.get(bot.id);
    return connection === undefined ? [] : [connection.id];
  });

  const [destinations, mcpRows] = await Promise.all([
    destinationIds.length === 0
      ? Promise.resolve([] as SubscriptionRow[])
      : db
          .select()
          .from(subscriptions)
          .where(and(eq(subscriptions.workspaceId, workspaceId), inArray(subscriptions.id, [...new Set(destinationIds)])))
          .all(),
    connectionIds.length === 0
      ? Promise.resolve([] as SubscriptionRow[])
      : db
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.workspaceId, workspaceId),
              eq(subscriptions.kind, "mcp"),
              isNotNull(subscriptions.connectionId),
              inArray(subscriptions.connectionId, connectionIds),
              isNull(subscriptions.unsubscribedAt),
              gt(subscriptions.expiresAt, now),
            ),
          )
          .orderBy(desc(subscriptions.updatedAt), desc(subscriptions.id))
          .all(),
  ]);
  const destinationById = new Map(destinations.map((row) => [row.id, row]));
  // Newest first, so the first one seen for a connection is the one used.
  const newestByConnection = new Map<string, SubscriptionRow>();
  for (const row of mcpRows) {
    if (row.connectionId !== null && !newestByConnection.has(row.connectionId)) newestByConnection.set(row.connectionId, row);
  }

  for (const bot of live) {
    if (bot.deliveryKind === "mcp") {
      const connection = byBot.get(bot.id);
      result.set(bot.id, connection === undefined ? null : (newestByConnection.get(connection.id) ?? null));
    } else {
      const row = bot.deliverySubscriptionId === null ? undefined : destinationById.get(bot.deliverySubscriptionId);
      result.set(bot.id, row !== undefined && row.kind === bot.deliveryKind && isActiveSubscription(row, now) ? row : null);
    }
  }
  return result;
}
