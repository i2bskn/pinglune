import app from "./app";
import { clock } from "./clock";
import { handleQueue } from "./deliveries/consumer";
import { loadConfig, type Bindings, type Config } from "./env";
import { handleEmail } from "./intake/email";
import { runDailyMaintenance } from "./maintenance/daily";
import { getOAuthProvider } from "./mcp/provider";

export type { AppType } from "./app";
// The Service Bindings entry point of the intake (entrypoint: "Intake").
export { Intake } from "./intake/rpc";

// Paths served by OAuthProvider or the authorization page. They are never forwarded to another host.
// When adding a top-level path here, add it to run_worker_first in wrangler.jsonc as well.
function isOAuthPath(path: string): boolean {
  return (
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/") ||
    path === "/authorize"
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

// The origin that hosts OAuth and MCP for this request, or null if the request cannot use them.
function resolveOrigin(config: Config, url: URL): string | null {
  if (config.oidc) return url.origin === config.oidc.appOrigin ? url.origin : null;
  // OAuth requires https, except on loopback hosts for local development.
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    return url.origin;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const result = loadConfig(env);
    // The app answers with the same 500 as for any other path (loadConfigMiddleware).
    if (!result.ok) return app.fetch(request, env, ctx);

    const url = new URL(request.url);
    const origin = resolveOrigin(result.config, url);
    if (origin === null) {
      if (isOAuthPath(url.pathname)) return new Response(null, { status: 404 });
      // In oidc mode, unifyHost redirects pages to APP_ORIGIN.
      return app.fetch(request, env, ctx);
    }
    // A shallow copy per request: OAuthProvider sets env.OAUTH_PROVIDER only when it is missing,
    // so a shared env would keep the helpers of the first origin.
    return getOAuthProvider(origin).fetch(request, { ...env }, ctx);
  },

  // The delivery queue and its dead letter queue (src/deliveries/consumer.ts).
  async queue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
    await handleQueue(batch, env);
  },

  // The email intake (src/intake/email.ts), from the catch-all rule of Email Routing.
  async email(message: ForwardableEmailMessage, env: Bindings): Promise<void> {
    await handleEmail(message, env);
  },

  // The daily cron (src/maintenance/daily.ts).
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const result = loadConfig(env);
    if (!result.ok) {
      console.error("invalid configuration", { invalid: result.invalid });
      return;
    }
    ctx.waitUntil(
      runDailyMaintenance({ db: env.DB, bucket: env.EVENT_DATA, queue: env.DELIVERY_QUEUE, now: clock.now() }),
    );
  },
} satisfies ExportedHandler<Bindings>;
