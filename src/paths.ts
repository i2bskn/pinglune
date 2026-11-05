import type { MiddlewareHandler } from "hono";
import { apiError, isJsonPath as isCoreJsonPath, loadConfig } from "@i2bskn/workers-app-core";
import type { AppEnv } from "./env";

// The HTTP intake for programs (src/intake/http.ts). @i2bskn/workers-app-core does not know these paths, so the
// middleware below gives them what it gives /api/v1: JSON errors and Cache-Control: no-store.
export function isIngestPath(path: string): boolean {
  return path === "/ingest" || path.startsWith("/ingest/");
}

// The paths whose errors are JSON: those of @i2bskn/workers-app-core, and the intake.
export function isJsonPath(path: string): boolean {
  return isCoreJsonPath(path) || isIngestPath(path);
}

// Cache-Control: no-store on the intake, like securityHeaders on /api/v1. A route that sets its own keeps it.
// Registered outside ingestConfig, so that its 500 gets it too.
export const ingestNoStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (isIngestPath(c.req.path) && !c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
};

// An invalid configuration answered with JSON on the intake. Registered before loadConfigMiddleware, which would
// answer it with an HTML page.
export const ingestConfig: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isIngestPath(c.req.path)) return next();
  const result = loadConfig(c.env);
  if (!result.ok) {
    console.error("invalid configuration", { invalid: result.invalid });
    return apiError(c, 500, "internal_error", "サーバーの設定に誤りがあります");
  }
  return next();
};
