import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db, McpCheckResult, McpRequestContext } from "@i2bskn/workers-app-core";
import { findActiveWorkspaceBot } from "../bots/queries";
import type { McpConnectionRow } from "../db/schema";
import type { Bindings } from "../env";
import { MCP_CONNECTION_ID_PATTERN } from "../ids";
import { findUserConnection, findUserConnectionByGrant } from "./connections";
import { appOriginHost, normalizeHost } from "../webhooks/destination";
import { registerEventMethods } from "./events";
import { registerTools } from "./tools";

// The MCP options of src/core.ts: the /mcp handler of @i2bskn/workers-app-core runs its checks (method, scope,
// configuration, the base props, the user and users.mcp_revoked_at), then these.
//
// Only function declarations here, no constants that createCore reads: this module may be evaluated before
// src/core.ts finishes loading (core.ts -> mcp/handler.ts -> mcp/tools.ts -> routes/sources.ts -> core.ts).

// The app fields of the grant props, stored by POST /authorize next to the package's userId, authMode and
// authorizedAt. connectionId is the MCP connection of the grant (src/mcp/connections.ts); grants made before
// connections were recorded have none.
export type PingluneMcpProps = { connectionId?: string };

// The result of checkRequest, passed to register.
export type McpExtra = { connection: McpConnectionRow | null; connectionBot: { id: string; name: string } | null };

type Ctx = McpRequestContext<Bindings, PingluneMcpProps>;

// connectionId is optional; when present it must be a connection ID. Anything else rejects the token with 401.
export function parseProps(raw: Record<string, unknown>): PingluneMcpProps | null {
  const { connectionId } = raw;
  if (connectionId === undefined) return {};
  if (typeof connectionId === "string" && MCP_CONNECTION_ID_PATTERN.test(connectionId)) return { connectionId };
  return null;
}

type ConnectionResult = { ok: true; connection: McpConnectionRow | null } | { ok: false };

// The MCP connection of the request. A grant with connectionId must have its row, not revoked. A legacy grant is
// looked up by its grant ID (one more KV read), and has no connection until the user assigns it to a bot; a revoked
// row that took it in rejects it. A failure to read the token leaves the request without a connection.
async function resolveConnection(
  db: Db,
  env: Bindings,
  userId: string,
  props: PingluneMcpProps,
  token: string,
): Promise<ConnectionResult> {
  if (props.connectionId !== undefined) {
    const row = await findUserConnection(db, userId, props.connectionId);
    return row === undefined || row.revokedAt !== null ? { ok: false } : { ok: true, connection: row };
  }
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return { ok: true, connection: null };
  let grantId: string | null = null;
  try {
    grantId = (await oauth.unwrapToken(token))?.grantId ?? null;
  } catch (error) {
    // The kind only: never the token.
    console.warn("unwrapping an mcp token failed", { name: error instanceof Error ? error.name : "unknown" });
  }
  if (grantId === null) return { ok: true, connection: null };
  const row = await findUserConnectionByGrant(db, userId, grantId);
  if (row === undefined) return { ok: true, connection: null };
  return row.revokedAt !== null ? { ok: false } : { ok: true, connection: row };
}

// The connection of the request and its bot. A connection that is missing or revoked rejects the token with 401.
export async function checkRequest({ db, env, user, props, auth, invalidToken }: Ctx): Promise<McpCheckResult<McpExtra>> {
  const resolved = await resolveConnection(db, env, user.id, props, auth.token);
  if (!resolved.ok) return invalidToken();
  const connection = resolved.connection;
  // The bot of the connection, when it is assigned to one that is not deleted.
  const bot =
    connection === null || connection.botId === null
      ? undefined
      : await findActiveWorkspaceBot(db, connection.workspaceId, connection.botId);
  const connectionBot = bot === undefined ? null : { id: bot.id, name: bot.name };
  return { ok: true, extra: { connection, connectionBot } };
}

// Registers the tools and the MCP Events methods on the server of this request.
export function register(server: McpServer, { db, env, user, auth, request, config, extra }: Ctx & { extra: McpExtra }) {
  registerTools(server, {
    db,
    d1: env.DB,
    user,
    bucket: env.EVENT_DATA,
    clientId: auth.clientId ?? null,
    connection: extra.connection,
    connectionBot: extra.connectionBot,
    queue: env.DELIVERY_QUEUE,
  });
  registerEventMethods(server, {
    db,
    user,
    jwtSecret: config.jwtSecret,
    selfHosts: selfHosts(request, env),
    connection: extra.connection,
  });
}

// The hosts that callbacks must not point at: the request's, and APP_ORIGIN's when it is a URL.
export function selfHosts(request: Request, env: Bindings): string[] {
  const hosts = [normalizeHost(new URL(request.url).hostname)];
  const appHost = appOriginHost(env.APP_ORIGIN);
  if (appHost !== null) hosts.push(appHost);
  return hosts;
}
