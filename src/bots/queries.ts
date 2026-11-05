// The bots of a workspace, their MCP connections and their destinations.

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { canonicalJson } from "../canonical-json";
import { chunks } from "../db/chunks";
import type { Db } from "@i2bskn/workers-app-core";
import {
  botSources,
  bots,
  mcpConnections,
  sources,
  subscriptions,
  type BotRow,
  type McpConnectionRow,
  type SubscriptionRow,
} from "../db/schema";
import { parseStoredFilter } from "../events/filter";
import { isActiveSubscription } from "../subscriptions/queries";

export const MAX_BOTS_PER_WORKSPACE = 100;

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

// The bots of the workspace with these IDs, deleted or not, by ID. Read in chunks: the callers may pass any number of
// IDs.
export async function workspaceBotsByIds(db: Db, workspaceId: string, ids: string[]): Promise<Map<string, BotRow>> {
  if (ids.length === 0) return new Map();
  const rows = await Promise.all(
    chunks([...new Set(ids)]).map((chunk) =>
      db
        .select()
        .from(bots)
        .where(and(eq(bots.workspaceId, workspaceId), inArray(bots.id, chunk)))
        .all(),
    ),
  );
  return new Map(rows.flat().map((row) => [row.id, row]));
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
  const rows = await Promise.all(
    chunks([...new Set(botIds)]).map((chunk) =>
      db
        .select()
        .from(mcpConnections)
        .where(
          and(
            eq(mcpConnections.workspaceId, workspaceId),
            inArray(mcpConnections.botId, chunk),
            isNull(mcpConnections.revokedAt),
          ),
        )
        .all(),
    ),
  );
  for (const row of rows.flat()) if (row.botId !== null) result.set(row.botId, row);
  return result;
}

// The subscriptions of the workspace with these IDs, in chunks. Empty for no IDs.
async function subscriptionsByIds(db: Db, workspaceId: string, ids: string[]): Promise<SubscriptionRow[]> {
  if (ids.length === 0) return [];
  const rows = await Promise.all(
    chunks([...new Set(ids)]).map((chunk) =>
      db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.workspaceId, workspaceId), inArray(subscriptions.id, chunk)))
        .all(),
    ),
  );
  return rows.flat();
}

// The active MCP Events subscriptions of these connections, newest first within each connection, in chunks. All the
// subscriptions of a connection are in one chunk, so the chunks are joined without sorting them again. Empty for no
// connections.
async function activeMcpSubscriptionsOfConnections(
  db: Db,
  workspaceId: string,
  connectionIds: string[],
  now: number,
): Promise<SubscriptionRow[]> {
  if (connectionIds.length === 0) return [];
  const rows = await Promise.all(
    chunks([...new Set(connectionIds)]).map((chunk) =>
      db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.workspaceId, workspaceId),
            eq(subscriptions.kind, "mcp"),
            isNotNull(subscriptions.connectionId),
            inArray(subscriptions.connectionId, chunk),
            isNull(subscriptions.unsubscribedAt),
            gt(subscriptions.expiresAt, now),
          ),
        )
        .orderBy(desc(subscriptions.updatedAt), desc(subscriptions.id))
        .all(),
    ),
  );
  return rows.flat();
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
    subscriptionsByIds(db, workspaceId, destinationIds),
    activeMcpSubscriptionsOfConnections(db, workspaceId, connectionIds, now),
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

// The bots of the workspace that are not deleted and are linked to this source. Two queries, no JOIN.
export async function activeBotsOfSource(db: Db, workspaceId: string, sourceId: string): Promise<BotRow[]> {
  const links = await db
    .select({ botId: botSources.botId })
    .from(botSources)
    .where(and(eq(botSources.sourceId, sourceId), eq(botSources.workspaceId, workspaceId)))
    .all();
  if (links.length === 0) return [];
  // Deleted bots never keep links, so there are about as many as the bots that are not deleted (at most
  // MAX_BOTS_PER_WORKSPACE, more by concurrent creations): read in chunks.
  const rows = await Promise.all(
    chunks([...new Set(links.map((link) => link.botId))]).map((chunk) =>
      db
        .select()
        .from(bots)
        .where(and(eq(bots.workspaceId, workspaceId), inArray(bots.id, chunk), isNull(bots.deletedAt)))
        .all(),
    ),
  );
  return rows.flat();
}

// Whether the source is linked to the bot in the workspace (a row of bot_sources).
export async function isSourceLinkedToBot(
  db: Db,
  workspaceId: string,
  botId: string,
  sourceId: string,
): Promise<boolean> {
  const row = await db
    .select({ botId: botSources.botId })
    .from(botSources)
    .where(and(eq(botSources.botId, botId), eq(botSources.sourceId, sourceId), eq(botSources.workspaceId, workspaceId)))
    .get();
  return row !== undefined;
}

// The key under which MCP Events subscriptions of one connection deliver the same events: the callback, the event
// name and the conditions that delivery uses (types and labels; sources is ignored). Broken arguments get a key of
// their own, so that the caller logs and skips them.
function mcpDestinationKey(row: SubscriptionRow): string {
  const filter = parseStoredFilter(row.arguments);
  if (filter === null) return `broken:${row.id}`;
  return canonicalJson([row.connectionId, row.callbackUrl, row.eventName, { types: filter.types, labels: filter.labels }]);
}

// The destinations that the events of a linked source are delivered to, for these bots, without duplicates:
// - a deleted bot: none.
// - webhook / queue: delivery_subscription_id, if it is active and of the bot's kind. An MCP connection is not
//   needed.
// - mcp: every active MCP Events subscription of the bot's active connection (an AI may subscribe with different
//   conditions), except that subscriptions with the same callback and the same types and labels (they differ in
//   sources only) are one destination: the one updated last. None without a connection.
// The conditions of the destinations are not applied here.
export async function resolveBotEventDestinations(
  db: Db,
  workspaceId: string,
  botRows: BotRow[],
  now: number,
): Promise<SubscriptionRow[]> {
  const live = botRows.filter((bot) => bot.deletedAt === null);
  if (live.length === 0) return [];

  const destinationBots = live.filter((bot) => bot.deliveryKind !== "mcp" && bot.deliverySubscriptionId !== null);
  const destinationIds = destinationBots.map((bot) => bot.deliverySubscriptionId as string);
  const mcpBots = live.filter((bot) => bot.deliveryKind === "mcp");
  const byBot = await activeConnectionsByBot(
    db,
    workspaceId,
    mcpBots.map((bot) => bot.id),
  );
  const connectionIds = mcpBots.flatMap((bot) => {
    const connection = byBot.get(bot.id);
    return connection === undefined ? [] : [connection.id];
  });

  const [destinations, mcpRows] = await Promise.all([
    subscriptionsByIds(db, workspaceId, destinationIds),
    activeMcpSubscriptionsOfConnections(db, workspaceId, connectionIds, now),
  ]);

  const result = new Map<string, SubscriptionRow>();
  const destinationById = new Map(destinations.map((row) => [row.id, row]));
  for (const bot of destinationBots) {
    const row = destinationById.get(bot.deliverySubscriptionId as string);
    if (row !== undefined && row.kind === bot.deliveryKind && isActiveSubscription(row, now)) result.set(row.id, row);
  }
  // Newest first, so the first one seen for a key is the one used.
  const seenKeys = new Set<string>();
  for (const row of mcpRows) {
    const key = mcpDestinationKey(row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    result.set(row.id, row);
  }
  return [...result.values()];
}

export type BotSourceSummary = { id: string; name: string; enabled: boolean };

// The linked sources of each of these bots, by bot ID, by name. The sources are read with the workspace's program
// sources (one bound value) and matched here, so that no IN list grows with the number of sources.
export async function linkedSourcesByBot(
  db: Db,
  workspaceId: string,
  botIds: string[],
): Promise<Map<string, BotSourceSummary[]>> {
  const result = new Map<string, BotSourceSummary[]>();
  for (const id of botIds) result.set(id, []);
  if (botIds.length === 0) return result;
  const [linkChunks, sourceRows] = await Promise.all([
    Promise.all(
      chunks([...new Set(botIds)]).map((chunk) =>
        db
          .select({ botId: botSources.botId, sourceId: botSources.sourceId })
          .from(botSources)
          .where(and(eq(botSources.workspaceId, workspaceId), inArray(botSources.botId, chunk)))
          .all(),
      ),
    ),
    db
      .select({ id: sources.id, name: sources.name, enabled: sources.enabled })
      .from(sources)
      .where(and(eq(sources.workspaceId, workspaceId), eq(sources.kind, "program")))
      .all(),
  ]);
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  for (const link of linkChunks.flat()) {
    const source = sourceById.get(link.sourceId);
    if (source === undefined) continue;
    result.get(link.botId)?.push({ id: source.id, name: source.name, enabled: source.enabled });
  }
  for (const list of result.values()) {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return result;
}
