import { Hono } from "hono";
import type { Subscription, SubscriptionList, SubscriptionStatus } from "../api/types";
import { requireUser } from "../auth/middleware";
import { clock } from "../clock";
import type { SubscriptionRow } from "../db/schema";
import type { AppEnv } from "../env";
import { callbackHost } from "../deliveries/queries";
import { EXPIRY_GRACE_MS } from "../mcp/events";
import { listWorkspaceSubscriptions } from "../subscriptions/queries";
import { requirePersonalWorkspace } from "./workspace";

// No paging: a workspace has few subscriptions.
const SUBSCRIPTION_LIST_LIMIT = 100;

function statusOf(row: SubscriptionRow, now: number): SubscriptionStatus {
  if (row.unsubscribedAt !== null) return "unsubscribed";
  return row.expiresAt <= now ? "expired" : "active";
}

function parseArguments(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Neither the secrets, the whole callback URL nor the user is returned.
function toApiSubscription(row: SubscriptionRow, now: number): Subscription {
  return {
    id: row.id,
    callback_host: callbackHost(row.callbackUrl),
    arguments: parseArguments(row.arguments),
    status: statusOf(row, now),
    refresh_before: row.expiresAt - EXPIRY_GRACE_MS,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

const subscriptionsApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", async (c) => {
    const rows = await listWorkspaceSubscriptions(c.get("db"), c.get("workspace").id, SUBSCRIPTION_LIST_LIMIT);
    const now = clock.now();
    const body: SubscriptionList = { subscriptions: rows.map((row) => toApiSubscription(row, now)) };
    return c.json(body, 200);
  });

export default subscriptionsApi;
