import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type {
  CreateQueueRequest,
  CreateWebhookDestinationRequest,
  Subscription,
  SubscriptionList,
  SubscriptionStatus,
} from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import { isUniqueViolation } from "../auth/users";
import { workspaceBotsByIds } from "../bots/queries";
import { canonicalJson } from "../canonical-json";
import { clock } from "../clock";
import type { Db } from "../db/client";
import { mcpConnections, subscriptions, type SubscriptionRow } from "../db/schema";
import type { AppEnv } from "../env";
import { callbackHost } from "../deliveries/queries";
import { eventFilterShape, type EventFilter } from "../events/filter";
import { newRandomSubscriptionId, SUBSCRIPTION_ID_PATTERN } from "../ids";
import { EVENT_NAME, EXPIRY_GRACE_MS } from "../mcp/events";
import { selfHosts } from "../mcp/handler";
import { MAX_ACTIVE_QUEUES_PER_WORKSPACE } from "../queues/constants";
import { countActiveQueues, endQueue, listWorkspaceQueues } from "../queues/queries";
import { encryptSecret, subscriptionSecretKey } from "../subscriptions/secret";
import {
  countActiveWebhookDestinations,
  endWebhookDestination,
  endWorkspaceMcpSubscription,
  findWorkspaceDestination,
  findWorkspaceMcpSubscription,
  findWorkspaceWebhookDestination,
  listWorkspaceMcpSubscriptions,
  listWorkspaceWebhookDestinations,
  NO_EXPIRY,
} from "../subscriptions/queries";
import { normalizeHost, parseCallbackUrl } from "../webhooks/destination";
import { jsonBody } from "./api";
import { invalidNameMessage, normalizeDisplayName, unknownField } from "./sources";
import { requirePersonalWorkspace } from "./workspace";

// No paging: a workspace has few subscriptions. Each kind is listed up to this many, so that MCP subscriptions
// never push the webhook destinations or the polling queues out of the list.
const SUBSCRIPTION_LIST_LIMIT = 100;
const MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE = 20;
// Printable ASCII without spaces, as HTTP header values allow without quoting.
const TOKEN_PATTERN = /^[\x21-\x7E]{1,1024}$/;

const destinationNotFound = "配信先が見つかりません";
const invalidUrlMessage = "URL が正しくありません（https のみ）";

const webhookFilter = z.strictObject(eventFilterShape);

export function statusOf(row: SubscriptionRow, now: number): SubscriptionStatus {
  if (row.unsubscribedAt !== null) return "unsubscribed";
  // Webhook destinations and polling queues do not expire.
  if (row.kind === "webhook" || row.kind === "queue") return "active";
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

type SubscriptionConnection = NonNullable<Subscription["connection"]>;

// The MCP connections of these MCP Events subscriptions, by connection ID, with the name of the bot while the
// connection is active and its bot is not deleted. Only the user's connections are read.
async function subscriptionConnections(
  db: Db,
  userId: string,
  workspaceId: string,
  rows: SubscriptionRow[],
): Promise<Map<string, SubscriptionConnection>> {
  const ids = [
    ...new Set(rows.flatMap((row) => (row.kind === "mcp" && row.connectionId !== null ? [row.connectionId] : []))),
  ];
  if (ids.length === 0) return new Map();
  const connections = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.userId, userId), inArray(mcpConnections.id, ids)))
    .all();
  const botIds = connections.flatMap((c) => (c.revokedAt === null && c.botId !== null ? [c.botId] : []));
  const botRows = await workspaceBotsByIds(db, workspaceId, botIds);
  return new Map(
    connections.map((c) => {
      const bot = c.revokedAt === null && c.botId !== null ? botRows.get(c.botId) : undefined;
      const botName = bot !== undefined && bot.deletedAt === null ? bot.name : null;
      return [c.id, { client_name: c.clientName, bot_name: botName }] as const;
    }),
  );
}

// Neither the secrets (or keys), the whole callback URL nor the user is returned. Polling queues have no callback
// URL: callback_host is null.
function toApiSubscription(
  row: SubscriptionRow,
  now: number,
  connections: Map<string, SubscriptionConnection> = new Map(),
): Subscription {
  const isMcp = row.kind === "mcp";
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    callback_host: callbackHost(row.callbackUrl),
    arguments: parseArguments(row.arguments),
    status: statusOf(row, now),
    refresh_before: isMcp ? row.expiresAt - EXPIRY_GRACE_MS : null,
    expires_at: isMcp ? row.expiresAt : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    connection: isMcp && row.connectionId !== null ? (connections.get(row.connectionId) ?? null) : null,
  };
}

type WebhookDestinationInput = { name: string; url: URL; token: string; filter: EventFilter };

const FILTER_FIELDS = ["types", "sources", "labels"] as const;

const createWebhookDestinationBody = jsonBody<CreateWebhookDestinationRequest, WebhookDestinationInput>((body, c) => {
  const unknown = unknownField(body, ["name", "url", "token", ...FILTER_FIELDS]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const name = normalizeDisplayName(body.name);
  if (name === null) return apiError(c, 400, "invalid_name", invalidNameMessage);
  const parsedUrl = parseCallbackUrl(body.url);
  if (!parsedUrl.ok) return apiError(c, 400, "invalid_url", invalidUrlMessage);
  // Sends to this service are blocked at send time too, but the consumer knows only APP_ORIGIN, not the host
  // of this request.
  const host = normalizeHost(parsedUrl.url.hostname);
  if (selfHosts(c.req.raw, c.env).includes(host)) return apiError(c, 400, "invalid_url", invalidUrlMessage);
  // Not trimmed: a key with spaces around it is a mistake.
  if (typeof body.token !== "string" || !TOKEN_PATTERN.test(body.token)) {
    return apiError(
      c,
      400,
      "invalid_token",
      "キーは空白を含まない印字可能な ASCII（1〜1024 文字）にしてください",
    );
  }
  const given: Record<string, unknown> = {};
  for (const field of FILTER_FIELDS) if (field in body) given[field] = body[field];
  const filter = webhookFilter.safeParse(given);
  if (!filter.success) return apiError(c, 400, "invalid_filter", "条件が正しくありません");
  return { ok: true, value: { name, url: parsedUrl.url, token: body.token, filter: filter.data } };
});

type QueueInput = { name: string; filter: EventFilter };

const createQueueBody = jsonBody<CreateQueueRequest, QueueInput>((body, c) => {
  const unknown = unknownField(body, ["name", ...FILTER_FIELDS]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const name = normalizeDisplayName(body.name);
  if (name === null) return apiError(c, 400, "invalid_name", invalidNameMessage);
  const given: Record<string, unknown> = {};
  for (const field of FILTER_FIELDS) if (field in body) given[field] = body[field];
  const filter = webhookFilter.safeParse(given);
  if (!filter.success) return apiError(c, 400, "invalid_filter", "条件が正しくありません");
  return { ok: true, value: { name, filter: filter.data } };
});

const subscriptionsApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", async (c) => {
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const [mcp, webhooks, queues] = await Promise.all([
      listWorkspaceMcpSubscriptions(db, workspaceId, SUBSCRIPTION_LIST_LIMIT),
      listWorkspaceWebhookDestinations(db, workspaceId, SUBSCRIPTION_LIST_LIMIT),
      listWorkspaceQueues(db, workspaceId, SUBSCRIPTION_LIST_LIMIT),
    ]);
    const now = clock.now();
    const connections = await subscriptionConnections(db, c.get("user").id, workspaceId, mcp);
    const body: SubscriptionList = {
      subscriptions: [...mcp, ...webhooks, ...queues].map((row) => toApiSubscription(row, now, connections)),
    };
    return c.json(body, 200);
  })
  .post("/webhooks", createWebhookDestinationBody, async (c) => {
    const { name, url, token, filter } = c.req.valid("json");
    const db = c.get("db");
    const user = c.get("user");
    const workspaceId = c.get("workspace").id;
    // A loose limit: concurrent requests may go slightly over it.
    if ((await countActiveWebhookDestinations(db, workspaceId)) >= MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE) {
      return apiError(c, 409, "limit_exceeded", "Webhook 配信先は 20 件までです");
    }
    const now = clock.now();
    const key = await subscriptionSecretKey(c.get("config").jwtSecret);
    // Workers have no SharedArrayBuffer, so every view is backed by an ArrayBuffer.
    const tokenBytes = new TextEncoder().encode(token) as Uint8Array<ArrayBuffer>;
    // On an ID collision, one more try. Not an upsert: a collision must not overwrite the existing row.
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = newRandomSubscriptionId();
      try {
        await db
          .insert(subscriptions)
          .values({
            id,
            userId: user.id,
            workspaceId,
            kind: "webhook",
            name,
            eventName: EVENT_NAME,
            arguments: canonicalJson(filter),
            callbackUrl: url.href,
            // The ID is the additional authenticated data, so the key is encrypted again for each ID.
            secret: await encryptSecret(key, id, tokenBytes),
            previousSecret: null,
            secretRotatedAt: null,
            expiresAt: NO_EXPIRY,
            unsubscribedAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
      const created = await findWorkspaceWebhookDestination(db, workspaceId, id);
      if (!created) throw new Error("created webhook destination not found");
      return c.json(toApiSubscription(created, now), 201);
    }
    return apiError(
      c,
      503,
      "temporarily_unavailable",
      "Webhook 配信先を登録できませんでした。もう一度試してください",
    );
  })
  .post("/queues", createQueueBody, async (c) => {
    const { name, filter } = c.req.valid("json");
    const db = c.get("db");
    const user = c.get("user");
    const workspaceId = c.get("workspace").id;
    // A loose limit: concurrent requests may go slightly over it.
    if ((await countActiveQueues(db, workspaceId)) >= MAX_ACTIVE_QUEUES_PER_WORKSPACE) {
      return apiError(c, 409, "limit_exceeded", "ポーリング用キューは 10 件までです");
    }
    const now = clock.now();
    // On an ID collision, one more try. Not an upsert: a collision must not overwrite the existing row.
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = newRandomSubscriptionId();
      try {
        await db
          .insert(subscriptions)
          .values({
            id,
            userId: user.id,
            workspaceId,
            kind: "queue",
            name,
            eventName: EVENT_NAME,
            arguments: canonicalJson(filter),
            // Nothing is sent and there is no key; the columns are NOT NULL.
            callbackUrl: "",
            secret: "",
            previousSecret: null,
            secretRotatedAt: null,
            expiresAt: NO_EXPIRY,
            unsubscribedAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
      const created = await findWorkspaceDestination(db, workspaceId, id);
      if (!created) throw new Error("created queue not found");
      return c.json(toApiSubscription(created, now), 201);
    }
    return apiError(
      c,
      503,
      "temporarily_unavailable",
      "ポーリング用キューを登録できませんでした。もう一度試してください",
    );
  })
  .post("/:id/delete", async (c) => {
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const id = c.req.param("id");
    const now = clock.now();
    if (!SUBSCRIPTION_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", destinationNotFound);
    // An MCP Events subscription is ended (stopped) so that one left by an old installation stops receiving events.
    // An AI that still runs subscribes again; disconnecting its MCP connection stops it for good.
    const mcp = await findWorkspaceMcpSubscription(db, workspaceId, id);
    if (mcp) {
      await endWorkspaceMcpSubscription(db, workspaceId, id, now);
      const ended = await findWorkspaceMcpSubscription(db, workspaceId, id);
      if (!ended) return apiError(c, 404, "not_found", destinationNotFound);
      const connections = await subscriptionConnections(db, c.get("user").id, workspaceId, [ended]);
      return c.json(toApiSubscription(ended, now, connections), 200);
    }
    const destination = await findWorkspaceDestination(db, workspaceId, id);
    if (!destination) return apiError(c, 404, "not_found", destinationNotFound);
    if (destination.kind === "queue") {
      // The deliveries not taken yet would never be: they fail in the same batch.
      await endQueue(c.env.DB, workspaceId, id, now);
    } else {
      await endWebhookDestination(db, workspaceId, id, now);
    }
    const ended = await findWorkspaceDestination(db, workspaceId, id);
    if (!ended) return apiError(c, 404, "not_found", destinationNotFound);
    return c.json(toApiSubscription(ended, now), 200);
  });

export default subscriptionsApi;
