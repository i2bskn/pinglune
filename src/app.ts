import { Hono } from "hono";
import { apiError, describeError } from "@i2bskn/workers-app-core";
import { core } from "./core";
import type { AppEnv } from "./env";
import intake from "./intake/http";
import { ingestConfig, ingestNoStore, isJsonPath } from "./paths";
import authorize from "./routes/authorize";
import botsApi from "./routes/bots";
import conversationsApi from "./routes/conversations";
import deliveriesApi from "./routes/deliveries";
import eventsApi from "./routes/events";
import { mcpConnectionsApi } from "./routes/mcp-connections";
import screeningApi from "./routes/screening";
import sourcesApi from "./routes/sources";
import subscriptionsApi from "./routes/subscriptions";

const { loadConfigMiddleware, sameOrigin, securityHeaders, unifyHost } = core.middleware;

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
// The intake (/ingest, /ingest/*): no-store, and a JSON 500 for an invalid configuration (src/paths.ts).
app.use("*", ingestNoStore);
app.use("*", ingestConfig);
app.use("*", loadConfigMiddleware);
app.use("*", unifyHost);
// Cookie-authenticated routes only. /mcp, /ingest (API keys) and the OAuth endpoints served by OAuthProvider
// must not use sameOrigin.
app.use("/auth/*", sameOrigin);
app.use("/api/v1/*", sameOrigin);
app.use("/authorize", sameOrigin);

// "/" and other paths not listed in run_worker_first in wrangler.jsonc are served by the static
// assets (the SPA) and never reach the Worker. When adding a top-level path here, add it to
// run_worker_first as well.
app.route("/auth", core.routes.auth);
// pinglune's own authorization page, which lets the user choose a bot (core.routes.authorize is not used).
app.route("/authorize", authorize);
// The HTTP intake for programs, authenticated with API keys.
app.route("/ingest", intake);
const apiRoutes = app
  .route("/api/v1/me", core.routes.me)
  .route("/api/v1/users", core.routes.users)
  .route("/api/v1/sources", sourcesApi)
  .route("/api/v1/events", eventsApi)
  .route("/api/v1/subscriptions", subscriptionsApi)
  .route("/api/v1/deliveries", deliveriesApi)
  .route("/api/v1/bots", botsApi)
  .route("/api/v1/conversations", conversationsApi)
  .route("/api/v1/mcp-connections", mcpConnectionsApi)
  .route("/api/v1/screening", screeningApi);

// Types for hc<AppType>(). Only /api/v1/* is included.
export type AppType = typeof apiRoutes;

app.notFound((c) => {
  if (isJsonPath(c.req.path)) return apiError(c, 404, "not_found", "見つかりません");
  return c.html(core.ErrorPage({ message: "ページが見つかりません" }), 404);
});

app.onError((error, c) => {
  console.error("unhandled error", describeError(error));
  if (isJsonPath(c.req.path)) return apiError(c, 500, "internal_error", "サーバーでエラーが発生しました");
  return c.html(core.ErrorPage({ message: "サーバーでエラーが発生しました" }), 500);
});

export default app;
