/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "../env";
import { getCurrentUser } from "../auth/middleware";
import { MCP_SCOPE, type McpProps } from "../mcp/handler";
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
  const consent = await oauth.beginConsent(authRequest);
  applyHeaders(c, consent.headers);
  return c.html(<ConsentPage details={details} handle={consent.handle} email={current.user.email} />);
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
  let approved;
  try {
    if (body.decision !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
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

  const props: McpProps = { userId: current.user.id, authMode: c.get("config").authMode };
  // Revokes the user's earlier grants for the same client (the library default).
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: current.user.id,
    metadata: {},
    scope: [MCP_SCOPE],
    props,
  });
  return redirectWith(approved.headers, redirectTo);
});

export default authorize;
