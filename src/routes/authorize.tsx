/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { AppEnv } from "../env";
import { describeError, getCurrentUser } from "../auth/middleware";
import { findActiveWorkspaceBot, listWorkspaceBots, MAX_BOTS_PER_WORKSPACE } from "../bots/queries";
import { clock } from "../clock";
import type { Db } from "../db/client";
import { bots, mcpConnections } from "../db/schema";
import { BOT_ID_PATTERN, newMcpConnectionId } from "../ids";
import {
  BOT_ALIVE,
  listUserConnections,
  replacementStatements,
  replacementValues,
  revokeConnectionGrants,
  type Replacement,
  type RevokedRow,
} from "../mcp/connections";
import { clientName } from "../mcp/grants";
import { MCP_SCOPE, type McpProps } from "../mcp/handler";
import { findPersonalWorkspaceByUserId } from "../workspaces/queries";
import { ConsentPage } from "../views/consent";
import { ErrorPage } from "../views/error";
import { isPrefetch } from "./auth";

type AppContext = Context<AppEnv>;

// The OAuth authorization endpoint for MCP clients. OAuthProvider validates the request, and this
// page signs the user in with the web session and asks for consent every time.
const authorize = new Hono<AppEnv>();

// Copies headers from the consent helpers (cookies, no-store, no framing) to the response.
function applyHeaders(c: AppContext, headers: Headers): void {
  headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") c.header(name, value);
  });
  for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
}

// The bots of the user's personal workspace that are not deleted, by name.
async function workspaceAndBots(db: Db, userId: string) {
  const workspace = await findPersonalWorkspaceByUserId(db, userId);
  if (!workspace) throw new Error("personal workspace not found");
  return { workspace, bots: await listWorkspaceBots(db, workspace.id, MAX_BOTS_PER_WORKSPACE) };
}

// The bots (not deleted) that active connections of the same app (client and redirect URI) are assigned to.
async function botsOfSameApp(db: Db, userId: string, clientId: string, redirectUri: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ botId: mcpConnections.botId })
    .from(mcpConnections)
    .innerJoin(bots, eq(bots.id, mcpConnections.botId))
    .where(
      and(
        eq(mcpConnections.userId, userId),
        eq(mcpConnections.oauthClientId, clientId),
        eq(mcpConnections.redirectUri, redirectUri),
        isNotNull(mcpConnections.botId),
        isNull(mcpConnections.revokedAt),
        isNull(bots.deletedAt),
      ),
    )
    .all();
  return rows.flatMap((row) => (row.botId === null ? [] : [row.botId]));
}

function redirectWith(headers: Headers, location: string): Response {
  const result = new Headers(headers);
  result.set("Location", location);
  return new Response(null, { status: 302, headers: result });
}

// HEAD is routed here too; like prefetches, it must not write a consent transaction to KV.
authorize.get("/", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return c.notFound();
  if (c.req.method === "HEAD" || isPrefetch(c)) return c.body(null, 204);

  // Validated before the sign-in, so that an invalid request does not lead to the login page.
  let authRequest;
  try {
    authRequest = await oauth.parseAuthRequest(c.req.raw);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return c.redirect(error.redirectTo, 302);
      console.warn("oauth authorization request rejected", { code: error.code, description: error.description });
      return c.html(<ErrorPage message="接続の要求が正しくありません" />, 400);
    }
    if (error instanceof CimdFetchError) {
      console.warn("oauth client metadata unavailable", { reason: error.reason, detail: error.detail });
      return c.html(<ErrorPage message="アプリの情報を確認できませんでした" />, 400);
    }
    throw error;
  }

  const current = await getCurrentUser(c);
  if (!current) {
    const url = new URL(c.req.url);
    // GET /auth/login returns here after the sign-in (or after refreshing the session).
    return c.redirect(`/auth/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 302);
  }

  let details;
  try {
    // Before beginConsent, so that a failed lookup leaves nothing in KV.
    details = await oauth.describeConsent(authRequest);
  } catch (error) {
    if (error instanceof CimdFetchError) {
      console.warn("oauth client metadata unavailable", { reason: error.reason, detail: error.detail });
      return c.html(<ErrorPage message="アプリの情報を確認できませんでした" />, 400);
    }
    throw error;
  }
  // Also before beginConsent. The bot preselected is the one that the same app is connected as, when there is exactly
  // one: an app used as two bots must be chosen, so that the connection of the other bot is not replaced by mistake.
  const db = c.get("db");
  const { bots: botRows } = await workspaceAndBots(db, current.user.id);
  const candidates = await botsOfSameApp(db, current.user.id, authRequest.clientId, authRequest.redirectUri);
  const sameApp = botRows.filter((bot) => candidates.includes(bot.id));
  const consent = await oauth.beginConsent(authRequest);
  applyHeaders(c, consent.headers);
  return c.html(
    <ConsentPage
      details={details}
      handle={consent.handle}
      email={current.user.email}
      bots={botRows.map((bot) => ({ id: bot.id, name: bot.name }))}
      selectedBotId={sameApp.length === 1 ? (sameApp[0]?.id ?? null) : null}
      sharedBotNames={sameApp.length >= 2 ? sameApp.map((bot) => bot.name) : []}
    />,
  );
});

authorize.post("/", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return c.notFound();

  const current = await getCurrentUser(c);
  if (!current) {
    return c.html(<ErrorPage message="ログインが切れました。接続をやり直してください" />, 401);
  }

  const body = await c.req.parseBody();
  const handle = typeof body.handle === "string" ? body.handle : "";
  const db = c.get("db");
  let approved;
  let botId: string | null = null;
  let workspaceId: string;
  try {
    if (body.decision !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // Before approveConsent, so that a wrong bot leaves the handle usable.
    const workspace = await findPersonalWorkspaceByUserId(db, current.user.id);
    if (!workspace) throw new Error("personal workspace not found");
    workspaceId = workspace.id;
    const requested = body.bot_id === undefined ? "" : body.bot_id;
    if (requested !== "") {
      const bot =
        typeof requested === "string" && BOT_ID_PATTERN.test(requested)
          ? await findActiveWorkspaceBot(db, workspace.id, requested)
          : undefined;
      if (!bot) return c.html(<ErrorPage message="選んだ Bot が見つかりません。接続をやり直してください" />, 400);
      botId = bot.id;
    }
    approved = await oauth.approveConsent(c.req.raw, handle, { scope: [MCP_SCOPE] });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      console.warn("oauth consent rejected", { code: error.code, description: error.description });
      return c.html(
        <ErrorPage message="画面の有効期限が切れたか、別のブラウザで開かれました。接続をやり直してください" />,
        400,
      );
    }
    throw error;
  }

  const now = clock.now();
  const userId = current.user.id;
  const request = approved.request;
  const connectionId = newMcpConnectionId(now);
  const props: McpProps = { userId, authMode: c.get("config").authMode, connectionId };
  // Earlier grants of the same client are kept: one app may be connected as two bots. Pinglune replaces the
  // connection of the same bot, and those of the same app not assigned to a bot, below.
  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId,
    metadata: { connectionId },
    scope: [MCP_SCOPE],
    props,
    revokeExistingGrants: false,
  });

  const replacement: Replacement = {
    userId,
    workspaceId,
    connectionId,
    oauthClientId: request.clientId,
    botId,
    sameApp: { oauthClientId: request.clientId, redirectUri: request.redirectUri },
    now,
  };
  const name = await clientName(oauth, request.clientId);
  let revoked: RevokedRow[];
  try {
    const d1 = c.env.DB;
    const results = await d1.batch<RevokedRow>([
      ...replacementStatements(d1, replacement),
      // Only while the bot is not deleted; the statements above replace nothing either then.
      d1
        .prepare(
          `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name,
            redirect_uri, created_at, updated_at, revoked_at, revoke_reason)
          SELECT ?2, ?1, ?7, ?3, NULL, ?9, ?10, ?11, ?8, ?8, NULL, NULL WHERE ${BOT_ALIVE}`,
        )
        .bind(...replacementValues(replacement), name, request.redirectUri),
    ]);
    if ((results[2]?.meta.changes ?? 0) === 0) {
      // The grant has no row, so its tokens are rejected (src/mcp/handler.ts).
      return c.html(<ErrorPage message="選んだ Bot が削除されました。接続をやり直してください" />, 400);
    }
    revoked = results[1]?.results ?? [];
  } catch (error) {
    // D1 may have committed even though it threw; the user connects again either way. Without a row, the tokens of
    // the new grant are rejected.
    console.error("recording an mcp connection failed", { userId, ...describeError(error) });
    return c.html(<ErrorPage message="接続を記録できませんでした。接続をやり直してください" />, 500);
  }

  // Best effort. The legacy grants of the same app are replaced too, as the library did before.
  let importedGrantIds: Set<string> | null = null;
  try {
    importedGrantIds = new Set(
      (await listUserConnections(db, userId)).flatMap((row) => (row.grantId === null ? [] : [row.grantId])),
    );
  } catch (error) {
    console.warn("reading the mcp connections to replace failed", { userId, ...describeError(error) });
  }
  await revokeConnectionGrants(
    oauth,
    userId,
    revoked,
    importedGrantIds === null
      ? null
      : {
          oauthClientId: request.clientId,
          redirectUri: request.redirectUri,
          resource: request.resource ?? `${new URL(c.req.url).origin}/mcp`,
          importedGrantIds,
        },
  );
  return redirectWith(approved.headers, redirectTo);
});

export default authorize;
