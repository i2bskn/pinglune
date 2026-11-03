import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { findUserById } from "../auth/users";
import { findActiveWorkspaceBot } from "../bots/queries";
import { createDb, type Db } from "../db/client";
import type { McpConnectionRow } from "../db/schema";
import { loadConfig, type AuthMode, type Bindings } from "../env";
import { MCP_CONNECTION_ID_PATTERN } from "../ids";
import { findUserConnection, findUserConnectionByGrant } from "./connections";
import { appOriginHost, normalizeHost } from "../webhooks/destination";
import { registerEventMethods } from "./events";
import { registerTools } from "./tools";

export const MCP_SCOPE = "mcp";

// Stored in the grant by POST /authorize and passed to the handler as ctx.props. connectionId is the MCP connection
// of the grant (src/mcp/connections.ts); grants made before connections were recorded have none.
export type McpProps = { userId: string; authMode: AuthMode; connectionId?: string };

export function isMcpProps(value: unknown): value is McpProps {
  if (typeof value !== "object" || value === null) return false;
  const { userId, authMode, connectionId } = value as Record<string, unknown>;
  return (
    typeof userId === "string" &&
    (authMode === "oidc" || authMode === "password") &&
    (connectionId === undefined || (typeof connectionId === "string" && MCP_CONNECTION_ID_PATTERN.test(connectionId)))
  );
}

type ConnectionResult = { ok: true; connection: McpConnectionRow | null } | { ok: false };

// The MCP connection of the request. A grant with connectionId must have its row, not revoked. A legacy grant is
// looked up by its grant ID (one more KV read), and has no connection until the user assigns it to a bot; a revoked
// row that took it in rejects it. A failure to read the token leaves the request without a connection.
async function resolveConnection(
  db: Db,
  env: Bindings,
  userId: string,
  props: McpProps,
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

// The same resource_metadata as the library's 401 for a missing token.
function invalidToken(audience: string): Response {
  const metadataUrl = `${new URL(audience).origin}/.well-known/oauth-protected-resource/mcp`;
  return new Response(null, {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`,
    },
  });
}

// The hosts that callbacks must not point at: the request's, and APP_ORIGIN's when it is a URL.
export function selfHosts(request: Request, env: Bindings): string[] {
  const hosts = [normalizeHost(new URL(request.url).hostname)];
  const appHost = appOriginHost(env.APP_ORIGIN);
  if (appHost !== null) hosts.push(appHost);
  return hosts;
}

// The SDK's ServerCapabilities type has no "events" (MCP Events is an extension); the value is sent as is.
const capabilities = { events: {} } as ServerCapabilities;

// Called by OAuthProvider for /mcp after the access token has been validated.
export const mcpHandler = {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    // Stateless: a GET would open an SSE stream that never carries anything, and there is no session to DELETE.
    if (request.method === "GET" || request.method === "DELETE") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    const { auth, props } = ctx as OAuthResourceContext<unknown>;
    if (!auth.scope.includes(MCP_SCOPE)) return insufficientScope(auth, [MCP_SCOPE]);

    const result = loadConfig(env);
    if (!result.ok) {
      console.error("invalid configuration", { invalid: result.invalid });
      return new Response(null, { status: 500 });
    }
    const config = result.config;
    const db = createDb(env.DB);

    // The user is read on every request so that role changes and deletions apply immediately.
    // The grant is kept: a refreshed token also gets 401, and the client then authorizes again.
    if (!isMcpProps(props) || props.authMode !== config.authMode) return invalidToken(auth.audience);
    const user = await findUserById(db, props.userId);
    if (!user) return invalidToken(auth.audience);
    const resolved = await resolveConnection(db, env, user.id, props, auth.token);
    if (!resolved.ok) return invalidToken(auth.audience);
    const connection = resolved.connection;
    // The bot of the connection, when it is assigned to one that is not deleted.
    const bot =
      connection === null || connection.botId === null
        ? undefined
        : await findActiveWorkspaceBot(db, connection.workspaceId, connection.botId);
    const connectionBot = bot === undefined ? null : { id: bot.id, name: bot.name };

    // A new server and transport per request (stateless).
    const server = new McpServer(
      { name: "pinglune", version: "0.0.0" },
      // Avoids compiling Ajv on every request.
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator(), capabilities },
    );
    registerTools(server, {
      db,
      d1: env.DB,
      user,
      bucket: env.EVENT_DATA,
      clientId: auth.clientId ?? null,
      connection,
      connectionBot,
      queue: env.DELIVERY_QUEUE,
    });
    registerEventMethods(server, {
      db,
      user,
      jwtSecret: config.jwtSecret,
      selfHosts: selfHosts(request, env),
      connection,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
