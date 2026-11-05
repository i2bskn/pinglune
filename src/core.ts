import type { Context, Next } from "hono";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { createCore, type CoreHooks } from "@i2bskn/workers-app-core";
import { BRAND_NAME } from "./brand";
import type { WorkspaceRow } from "./db/schema";
import type { AppEnv, Bindings } from "./env";
import { deleteWorkspaceObjects } from "./intake/storage";
import { revokeUserConnectionsQuery } from "./mcp/connections";
import { checkRequest, parseProps, register, type McpExtra, type PingluneMcpProps } from "./mcp/handler";
import { endUserSubscriptionsQuery } from "./subscriptions/queries";
import { Layout } from "./views/layout";
import { findPersonalWorkspaceByUserId, insertPersonalWorkspaceStatement } from "./workspaces/queries";

// What userDeleteStatements passes to afterUserDeleted: the deleted personal workspace (null if the user had none).
type DeleteData = { workspaceId: string | null };

const hooks: CoreHooks<Bindings, DeleteData> = {
  // Every new user gets a personal workspace, in the same batch as the INSERT of the user, so that email_taken leaves
  // no workspace behind. The statement inserts nothing unless the user exists, so it also holds when the INSERT of
  // the setup inserts nothing.
  userCreatedStatements: (d1, userId, now) => [insertPersonalWorkspaceStatement(d1, userId, now)],

  // Deletes the user's personal workspace and everything in it. The package appends the DELETE of the sessions and
  // of the user, whose result decides success. When adding tables that belong to a workspace, add their DELETE
  // statements here before the workspace statement.
  // TODO: one batch deletes every event of the workspace. With a very large number of events this may hit the
  // D1 limits; the deletion would then have to be split. Not expected at personal scale.
  async userDeleteStatements({ db, d1, userId, guard }) {
    const workspace = await findPersonalWorkspaceByUserId(db, userId);
    const workspaceId = workspace?.id ?? null;
    // Every statement carries the guard (it binds the user ID as ?1), so that nothing is deleted if the user is gone
    // or is the last admin when the batch runs. The batch is one transaction.
    // Children first: the deliveries (of the workspace's events and of the user's subscriptions), the data of the
    // workspace (the events before the conversations they belong to, the participants before the bots and the
    // subscriptions they refer to, the MCP connections and the bot sources before the bots, the bot sources before
    // the sources), the subscriptions, the workspace; then the package's sessions and user. ?2 is the workspace ID;
    // NULL matches nothing.
    return {
      statements: [
        d1
          .prepare(
            `DELETE FROM deliveries WHERE (workspace_id = ?2 OR subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ?1)) AND ${guard}`,
          )
          .bind(userId, workspaceId),
        d1.prepare(`DELETE FROM event_data WHERE workspace_id = ?2 AND ${guard}`).bind(userId, workspaceId),
        d1.prepare(`DELETE FROM events WHERE workspace_id = ?2 AND ${guard}`).bind(userId, workspaceId),
        d1
          .prepare(`DELETE FROM conversation_participants WHERE workspace_id = ?2 AND ${guard}`)
          .bind(userId, workspaceId),
        d1.prepare(`DELETE FROM conversations WHERE workspace_id = ?2 AND ${guard}`).bind(userId, workspaceId),
        // The MCP connections and the bot sources before the bots (and the sources) they refer to, the bots before the
        // subscriptions they refer to.
        d1.prepare(`DELETE FROM mcp_connections WHERE user_id = ?1 AND ${guard}`).bind(userId),
        d1.prepare(`DELETE FROM bot_sources WHERE workspace_id = ?2 AND ${guard}`).bind(userId, workspaceId),
        d1.prepare(`DELETE FROM bots WHERE workspace_id = ?2 AND ${guard}`).bind(userId, workspaceId),
        d1
          .prepare(`DELETE FROM api_keys WHERE source_id IN (SELECT id FROM sources WHERE workspace_id = ?2) AND ${guard}`)
          .bind(userId, workspaceId),
        d1
          .prepare(
            `DELETE FROM email_addresses WHERE source_id IN (SELECT id FROM sources WHERE workspace_id = ?2) AND ${guard}`,
          )
          .bind(userId, workspaceId),
        d1.prepare(`DELETE FROM sources WHERE workspace_id = ?2 AND ${guard}`).bind(userId, workspaceId),
        d1.prepare(`DELETE FROM subscriptions WHERE user_id = ?1 AND ${guard}`).bind(userId),
        d1.prepare(`DELETE FROM workspaces WHERE owner_user_id = ?1 AND kind = 'personal' AND ${guard}`).bind(userId),
      ],
      read: () => ({ workspaceId }),
    };
  },

  // After D1, best effort. By prefix rather than from the D1 rows, so that orphans left by failed intakes go too.
  // Failures are logged by deleteWorkspaceObjects.
  async afterUserDeleted({ env, data }) {
    if (data.workspaceId !== null) await deleteWorkspaceObjects(env.EVENT_DATA, data.workspaceId);
  },

  // In the batch that revokes the sessions. The MCP Events subscriptions end and the MCP connections are revoked with
  // the grants. On a password change by the user (self_change), webhook destinations stay: their keys belong to the
  // receivers, not to the user's login, so a routine password change does not stop them silently. Polling queues
  // stay too: they are read through MCP, which needs a new authorization anyway. An admin's reset or revocation may
  // answer a compromise, and an attacker's destination never expires, so the webhook destinations end too.
  credentialsRevokedStatements: ({ db, userId, now, reason }) => [
    endUserSubscriptionsQuery(db, userId, now, { includeWebhooks: reason !== "self_change" }),
    revokeUserConnectionsQuery(db, userId, now),
  ],
};

// Login, sessions, user management and the MCP OAuth authorization server. /authorize is pinglune's own
// (src/routes/authorize.tsx), which lets the user choose a bot.
export const core = createCore<Bindings, { workspace: WorkspaceRow }, PingluneMcpProps, McpExtra, DeleteData>({
  brand: { id: "pinglune", name: BRAND_NAME, layout: Layout },
  hooks,
  mcp: {
    serverInfo: { name: "pinglune", version: "0.0.0" },
    // The SDK's ServerCapabilities type has no "events" (MCP Events is an extension); the value is sent as is.
    capabilities: { events: {} } as ServerCapabilities,
    parseProps,
    checkRequest,
    register,
  },
  // Required by createCore, but not shown: core.routes.authorize is not used (src/views/consent.tsx has the same text).
  consent: {
    description:
      "許可すると、このアプリはあなたとして、Pingluneに保存されたイベント・データ・会話を読み取り、ポーリング用のキューからイベントを取り出して処理済みにできます。",
  },
});

// The signed-in user, for the app's API routes. A function declaration rather than a constant rather than constants: the routes use them while this
// module may still be loading (core.ts -> mcp/handler.ts -> mcp/tools.ts -> routes/sources.ts -> core.ts), and
// function declarations are available before the module runs.
export function requireUser(c: Context<AppEnv>, next: Next) {
  return core.middleware.requireUser(c, next);
}
