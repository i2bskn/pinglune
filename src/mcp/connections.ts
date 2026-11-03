// MCP connections (mcp_connections): one per authorization of an MCP client. They tie the OAuth grants in KV to bots.
//
// A grant made by POST /authorize carries the ID of its connection in its metadata and props (connectionId). A grant
// made before connections were recorded (a legacy connection) has neither; it gets a row with grant_id when the user
// assigns it to a bot on the screen.

import type { GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { and, eq, isNull } from "drizzle-orm";
import { describeError } from "../auth/middleware";
import type { Db } from "../db/client";
import { mcpConnections, type McpConnectionRow } from "../db/schema";

// KV lists grants up to about 60 seconds late, so a connection made within this time is not called expired when its
// grant is not listed yet.
export const MCP_CONNECTION_LISTING_GRACE_MS = 5 * 60 * 1000;

export type RevokeReason = "user" | "replaced" | "sessions_revoked";

// Every grant of the user, all pages.
export async function listAllUserGrants(oauth: OAuthHelpers, userId: string): Promise<GrantSummary[]> {
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, cursor === undefined ? undefined : { cursor });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return grants;
}

// The connection ID in the metadata of a grant, or null for a legacy grant.
export function grantConnectionId(grant: Pick<GrantSummary, "metadata">): string | null {
  const metadata: unknown = grant.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const id = (metadata as { connectionId?: unknown }).connectionId;
  return typeof id === "string" ? id : null;
}

// The host of a redirect URI, or "" if it is not a URL.
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}

// The user's connection with this ID, revoked or not. Rows of other users are never matched.
export function findUserConnection(db: Db, userId: string, id: string): Promise<McpConnectionRow | undefined> {
  return db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.userId, userId)))
    .get();
}

// The user's connection that took in this legacy grant, revoked or not.
export function findUserConnectionByGrant(
  db: Db,
  userId: string,
  grantId: string,
): Promise<McpConnectionRow | undefined> {
  return db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.grantId, grantId), eq(mcpConnections.userId, userId)))
    .get();
}

// Every connection of the user, revoked or not.
export function listUserConnections(db: Db, userId: string): Promise<McpConnectionRow[]> {
  return db.select().from(mcpConnections).where(eq(mcpConnections.userId, userId)).all();
}

// A connection as the screen lists it (see McpConnectionKind in src/api/types.ts):
// - active: a recorded connection with its grant (or made within the grace, before KV lists it).
// - expired: a recorded connection whose grant is not in KV anymore.
// - legacy: a grant without connectionId that no row took in.
// - stale: a grant whose row is revoked, or a grant with a connectionId that has no row (a failed authorization).
export type ClassifiedConnection =
  | { kind: "active"; row: McpConnectionRow; grant: GrantSummary | null }
  | { kind: "expired"; row: McpConnectionRow }
  | { kind: "legacy"; grant: GrantSummary }
  | { kind: "stale"; grant: GrantSummary; row: McpConnectionRow | null };

// Matches the grants of the user with the rows of the user (revoked included).
export function classifyConnections(
  grants: GrantSummary[],
  rows: McpConnectionRow[],
  now: number,
): ClassifiedConnection[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const rowsByGrant = new Map(rows.flatMap((row) => (row.grantId === null ? [] : [[row.grantId, row] as const])));
  const matched = new Set<string>();
  const result: ClassifiedConnection[] = [];
  for (const grant of grants) {
    const connectionId = grantConnectionId(grant);
    const row = connectionId !== null ? rowsById.get(connectionId) : rowsByGrant.get(grant.id);
    if (row === undefined) {
      result.push(connectionId !== null ? { kind: "stale", grant, row: null } : { kind: "legacy", grant });
      continue;
    }
    matched.add(row.id);
    result.push(row.revokedAt === null ? { kind: "active", row, grant } : { kind: "stale", grant, row });
  }
  for (const row of rows) {
    if (row.revokedAt !== null || matched.has(row.id)) continue;
    result.push(
      now - row.createdAt < MCP_CONNECTION_LISTING_GRACE_MS ? { kind: "active", row, grant: null } : { kind: "expired", row },
    );
  }
  return result;
}

export type Replacement = {
  userId: string;
  workspaceId: string;
  // The connection that takes the place of the others (inserted or updated in the same batch, after these statements).
  connectionId: string;
  // Its OAuth client: the subscriptions of replaced connections of the same client move to it.
  oauthClientId: string;
  // Replaces the active connection of this bot. Nothing is replaced if the bot is deleted by then.
  botId: string | null;
  // Also replaces the active connections of the same app (client and redirect URI) not assigned to a bot.
  sameApp: { oauthClientId: string; redirectUri: string } | null;
  now: number;
};

// The connections that a replacement revokes, as a SQL condition on mcp_connections with numbered parameters:
// ?1 user, ?2 the new connection, ?3 the bot (or NULL), ?4 1 to include the same app, ?5 its client, ?6 its redirect
// URI, ?7 the workspace.
const REPLACED = `user_id = ?1 AND revoked_at IS NULL AND id != ?2
  AND ((?3 IS NOT NULL AND bot_id = ?3) OR (?4 = 1 AND oauth_client_id = ?5 AND redirect_uri = ?6 AND bot_id IS NULL))
  AND (?3 IS NULL OR EXISTS (SELECT 1 FROM bots WHERE id = ?3 AND workspace_id = ?7 AND deleted_at IS NULL))`;

// The SQL condition that the bot (?3) is not deleted, for the insert or the update that follows a replacement.
export const BOT_ALIVE = "(?3 IS NULL OR EXISTS (SELECT 1 FROM bots WHERE id = ?3 AND workspace_id = ?7 AND deleted_at IS NULL))";

function replacementBindings(r: Replacement): unknown[] {
  return [
    r.userId,
    r.connectionId,
    r.botId,
    r.sameApp === null ? 0 : 1,
    r.sameApp?.oauthClientId ?? "",
    r.sameApp?.redirectUri ?? "",
    r.workspaceId,
    r.now,
    r.oauthClientId,
  ];
}

// The statements of a replacement, to run in one batch before the insert or the update of the new connection
// (mcp_connections_active_bot_unique allows one active connection per bot):
// 1. The active MCP Events subscriptions of the replaced connections of the same client move to the new connection;
//    updated_at is kept, so that the newest subscription is still the one the AI refreshed last. Those of other
//    clients stay with their connection: they are still delivered by their filters until they expire, but are no
//    destination of a bot anymore.
// 2. The replaced connections are revoked with "replaced", returning their id and grant_id (revokeReplacedGrants).
export function replacementStatements(d1: D1Database, r: Replacement): [D1PreparedStatement, D1PreparedStatement] {
  const values = replacementBindings(r);
  return [
    d1
      .prepare(
        `UPDATE subscriptions SET connection_id = ?2
        WHERE kind = 'mcp' AND unsubscribed_at IS NULL AND user_id = ?1
          AND connection_id IN (SELECT id FROM mcp_connections WHERE ${REPLACED} AND oauth_client_id = ?9)`,
      )
      .bind(...values),
    d1
      .prepare(
        `UPDATE mcp_connections SET revoked_at = ?8, revoke_reason = 'replaced', updated_at = ?8
        WHERE ${REPLACED} RETURNING id, grant_id`,
      )
      // D1 wants exactly as many values as the highest parameter number (?8).
      .bind(...values.slice(0, 8)),
  ];
}

// The values ?1 to ?9 of replacementStatements, for a statement that uses BOT_ALIVE and the same numbering. D1 wants
// exactly as many values as the highest parameter number: count cuts them for a statement that ends at ?8.
export function replacementValues(r: Replacement, count = 9): unknown[] {
  return replacementBindings(r).slice(0, count);
}

export type RevokedRow = { id: string; grant_id: string | null };

// Whether a grant is for this resource. Grants made before resources were recorded have none.
function grantForResource(grant: GrantSummary, resource: string): boolean {
  if (grant.resource === undefined) return true;
  return typeof grant.resource === "string" ? grant.resource === resource : grant.resource.includes(resource);
}

function isCimdClientId(clientId: string): boolean {
  try {
    return new URL(clientId).protocol === "https:";
  } catch {
    return false;
  }
}

// Revokes the grants of revoked connections in KV, best effort: a failure is logged only. A connection revoked in D1
// cannot be used anyway (src/mcp/handler.ts), except a legacy grant that no row took in.
// legacy: also the legacy grants of the same client (and, for a CIMD client, the same redirect URI) for this resource,
// as the library replaced grants before.
export async function revokeConnectionGrants(
  oauth: OAuthHelpers,
  userId: string,
  revoked: RevokedRow[],
  legacy: { oauthClientId: string; redirectUri: string; resource: string; importedGrantIds: Set<string> } | null,
): Promise<void> {
  if (revoked.length === 0 && legacy === null) return;
  try {
    const ids = new Set(revoked.map((row) => row.id));
    const grantIds = new Set(revoked.flatMap((row) => (row.grant_id === null ? [] : [row.grant_id])));
    const grants = await listAllUserGrants(oauth, userId);
    const targets = grants.filter((grant) => {
      const connectionId = grantConnectionId(grant);
      if (connectionId !== null) return ids.has(connectionId);
      if (grantIds.has(grant.id)) return true;
      if (legacy === null || legacy.importedGrantIds.has(grant.id)) return false;
      return (
        grant.clientId === legacy.oauthClientId &&
        (!isCimdClientId(grant.clientId) || grant.redirectUri === legacy.redirectUri) &&
        grantForResource(grant, legacy.resource)
      );
    });
    await Promise.all(targets.map((grant) => oauth.revokeGrant(grant.id, userId)));
  } catch (error) {
    console.warn("revoking the grants of replaced mcp connections failed", { userId, ...describeError(error) });
  }
}

// Revokes connections of the user in one batch: ends their active MCP Events subscriptions when reason is "user", and
// marks them revoked. Rows already revoked are left as they are. Returns the rows revoked now.
export async function revokeConnections(
  d1: D1Database,
  userId: string,
  ids: string[],
  reason: RevokeReason,
  now: number,
): Promise<RevokedRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `?${i + 4}`).join(", ");
  const statements: D1PreparedStatement[] = [];
  if (reason === "user") {
    statements.push(
      d1
        .prepare(
          `UPDATE subscriptions SET unsubscribed_at = ?1, updated_at = ?1
          WHERE kind = 'mcp' AND unsubscribed_at IS NULL AND user_id = ?2 AND connection_id IN (
            SELECT id FROM mcp_connections WHERE user_id = ?2 AND revoked_at IS NULL AND id IN (${placeholders}))`,
        )
        .bind(now, userId, reason, ...ids),
    );
  }
  statements.push(
    d1
      .prepare(
        `UPDATE mcp_connections SET revoked_at = ?1, revoke_reason = ?3, updated_at = ?1
        WHERE user_id = ?2 AND revoked_at IS NULL AND id IN (${placeholders}) RETURNING id, grant_id`,
      )
      .bind(now, userId, reason, ...ids),
  );
  const results = await d1.batch<RevokedRow>(statements);
  return results.at(-1)?.results ?? [];
}

// Revokes every active connection of the user (a password change or the revocation of every session). A query, so
// that it can join the batch of the caller; the MCP Events subscriptions are ended by endUserSubscriptionsQuery.
export function revokeUserConnectionsQuery(db: Db, userId: string, now: number) {
  return db
    .update(mcpConnections)
    .set({ revokedAt: now, revokeReason: "sessions_revoked", updatedAt: now })
    .where(and(eq(mcpConnections.userId, userId), isNull(mcpConnections.revokedAt)));
}
