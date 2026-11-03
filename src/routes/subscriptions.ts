import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
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
import { listWorkspaceBots, MAX_BOTS_PER_WORKSPACE } from "../bots/queries";
import { canonicalJson } from "../canonical-json";
import { clock } from "../clock";
import type { Db } from "../db/client";
import { mcpConnections, subscriptions, type McpConnectionRow, type SubscriptionRow } from "../db/schema";
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
export const MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE = 100;
// The connections are read with IN lists of at most this many IDs, within the 100 bound variables of D1.
const CONNECTION_ID_CHUNK = 90;

export const webhookLimitMessage = `Webhook 配信先は ${MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE} 件までです`;
export const queueLimitMessage = `ポーリング用キューは ${MAX_ACTIVE_QUEUES_PER_WORKSPACE} 件までです`;
// Printable ASCII without spaces, as HTTP header values allow without quoting.
const TOKEN_PATTERN = /^[\x21-\x7E]{1,1024}$/;

const destinationNotFound = "配信先が見つかりません";
const invalidUrlMessage = "URL が正しくありません（https のみ）";

// The conditions of webhook destinations and polling queues: types and labels. sources is rejected (invalid_filter):
// the sources of the events are those linked to the bot that uses the destination.
const webhookFilter = z.strictObject({ types: eventFilterShape.types, labels: eventFilterShape.labels });

export function statusOf(row: SubscriptionRow, now: number): SubscriptionStatus {
  if (row.unsubscribedAt !== null) return "unsubscribed";
  // Webhook destinations and polling queues do not expire.
  if (row.kind === "webhook" || row.kind === "queue") return "active";
  return row.expiresAt <= now ? "expired" : "active";
}

// The stored arguments without sources, which delivery ignores (an MCP Events subscription may still carry it).
// null if they are broken. The stored value is not changed.
export function parseArguments(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { sources: _, ...rest } = parsed as Record<string, unknown>;
    return rest;
  } catch {
    return null;
  }
}

type SubscriptionConnection = NonNullable<Subscription["connection"]>;
type SubscriptionBot = NonNullable<Subscription["bot"]>;

// The subscriptions as the API returns them, with their MCP connections and their bots. Every API that returns
// subscriptions uses this, so that they agree. Only the user's connections are read, and the bots of the workspace
// that are not deleted (a few, so they are all read: the subscriptions could be more than an IN list may hold).
// - connection (mcp): the connection with the name of its bot while the connection is active and its bot is not
//   deleted.
// - bot: for webhook and queue the bot whose destination it is; for mcp the bot of its active connection when the
//   bot's delivery kind is mcp.
async function subscriptionsToApi(
  db: Db,
  userId: string,
  workspaceId: string,
  rows: SubscriptionRow[],
  now: number,
): Promise<Subscription[]> {
  if (rows.length === 0) return [];
  const connectionIds = [
    ...new Set(rows.flatMap((row) => (row.kind === "mcp" && row.connectionId !== null ? [row.connectionId] : []))),
  ];
  const chunks: string[][] = [];
  for (let i = 0; i < connectionIds.length; i += CONNECTION_ID_CHUNK) chunks.push(connectionIds.slice(i, i + CONNECTION_ID_CHUNK));
  const [connectionChunks, liveBots] = await Promise.all([
    Promise.all(
      chunks.map((ids) =>
        db
          .select()
          .from(mcpConnections)
          .where(and(eq(mcpConnections.userId, userId), inArray(mcpConnections.id, ids)))
          .all(),
      ),
    ),
    listWorkspaceBots(db, workspaceId, MAX_BOTS_PER_WORKSPACE),
  ]);
  const connectionRows: McpConnectionRow[] = connectionChunks.flat();
  const botById = new Map(liveBots.map((bot) => [bot.id, bot]));
  const botByDestination = new Map(
    liveBots.flatMap((bot) =>
      bot.deliveryKind !== "mcp" && bot.deliverySubscriptionId !== null ? [[bot.deliverySubscriptionId, bot] as const] : [],
    ),
  );
  const connections = new Map<string, { connection: SubscriptionConnection; bot: SubscriptionBot | null }>();
  for (const row of connectionRows) {
    const bot = row.revokedAt === null && row.botId !== null ? botById.get(row.botId) : undefined;
    connections.set(row.id, {
      connection: { id: row.id, client_name: row.clientName, bot_name: bot === undefined ? null : bot.name },
      bot: bot !== undefined && bot.deliveryKind === "mcp" ? { id: bot.id, name: bot.name } : null,
    });
  }
  return rows.map((row) => {
    if (row.kind === "mcp") {
      const found = row.connectionId === null ? undefined : connections.get(row.connectionId);
      return toApiSubscription(row, now, found?.connection ?? null, found?.bot ?? null);
    }
    const bot = botByDestination.get(row.id);
    return toApiSubscription(row, now, null, bot === undefined ? null : { id: bot.id, name: bot.name });
  });
}

// Neither the secrets (or keys), the whole callback URL nor the user is returned. Polling queues have no callback
// URL: callback_host is null.
function toApiSubscription(
  row: SubscriptionRow,
  now: number,
  connection: SubscriptionConnection | null,
  bot: SubscriptionBot | null,
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
    connection: isMcp ? connection : null,
    bot,
  };
}

type WebhookDestinationInput = { name: string; url: URL; token: string; filter: EventFilter };

// sources is a known field, so that it is answered with invalid_filter rather than unknown_field.
export const FILTER_FIELDS = ["types", "sources", "labels"] as const;

type AppContext = Context<AppEnv>;

export const invalidFilterMessage = "条件が正しくありません";

// Checks the callback URL and the key of a webhook destination. Returns the error response if either is invalid.
export function checkWebhookTarget(
  c: AppContext,
  url: unknown,
  token: unknown,
): { ok: true; url: URL; token: string } | Response {
  const parsedUrl = parseCallbackUrl(url);
  if (!parsedUrl.ok) return apiError(c, 400, "invalid_url", invalidUrlMessage);
  // Sends to this service are blocked at send time too, but the consumer knows only APP_ORIGIN, not the host
  // of this request.
  const host = normalizeHost(parsedUrl.url.hostname);
  if (selfHosts(c.req.raw, c.env).includes(host)) return apiError(c, 400, "invalid_url", invalidUrlMessage);
  // Not trimmed: a key with spaces around it is a mistake.
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    return apiError(
      c,
      400,
      "invalid_token",
      "キーは空白を含まない印字可能な ASCII（1〜1024 文字）にしてください",
    );
  }
  return { ok: true, url: parsedUrl.url, token };
}

// The conditions of a webhook destination or a polling queue, from the fields of FILTER_FIELDS that are given.
// null if they are invalid (invalid_filter), including sources.
export function parseDestinationFilter(given: Record<string, unknown>): EventFilter | null {
  const picked: Record<string, unknown> = {};
  for (const field of FILTER_FIELDS) if (field in given) picked[field] = given[field];
  const filter = webhookFilter.safeParse(picked);
  return filter.success ? filter.data : null;
}

// The row of a new webhook destination (with webhook) or polling queue (without), as both the screen's own
// registration and the creation of a bot store it. The key is encrypted with the ID as the additional authenticated
// data.
export async function newDestinationRow(params: {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  filter: EventFilter;
  webhook: { url: URL; token: string } | null;
  jwtSecret: string;
  now: number;
}): Promise<SubscriptionRow> {
  const { id, webhook, now } = params;
  let secret = "";
  if (webhook !== null) {
    const key = await subscriptionSecretKey(params.jwtSecret);
    // Workers have no SharedArrayBuffer, so every view is backed by an ArrayBuffer.
    const tokenBytes = new TextEncoder().encode(webhook.token) as Uint8Array<ArrayBuffer>;
    secret = await encryptSecret(key, id, tokenBytes);
  }
  return {
    id,
    userId: params.userId,
    workspaceId: params.workspaceId,
    kind: webhook === null ? "queue" : "webhook",
    name: params.name,
    eventName: EVENT_NAME,
    arguments: canonicalJson(params.filter),
    // A polling queue sends nothing and has no key; the columns are NOT NULL.
    callbackUrl: webhook === null ? "" : webhook.url.href,
    secret,
    previousSecret: null,
    secretRotatedAt: null,
    expiresAt: NO_EXPIRY,
    unsubscribedAt: null,
    createdAt: now,
    updatedAt: now,
    connectionId: null,
  };
}

// Whether one more active destination of this kind may be made. A loose limit: concurrent requests may go slightly
// over it. ending is the number of active destinations of this kind that the same request ends.
export async function destinationLimitResponse(
  c: AppContext,
  kind: "webhook" | "queue",
  ending = 0,
) {
  const db = c.get("db");
  const workspaceId = c.get("workspace").id;
  if (kind === "webhook") {
    const count = (await countActiveWebhookDestinations(db, workspaceId)) - ending;
    return count >= MAX_ACTIVE_WEBHOOK_DESTINATIONS_PER_WORKSPACE ? apiError(c, 409, "limit_exceeded", webhookLimitMessage) : null;
  }
  const count = (await countActiveQueues(db, workspaceId)) - ending;
  return count >= MAX_ACTIVE_QUEUES_PER_WORKSPACE ? apiError(c, 409, "limit_exceeded", queueLimitMessage) : null;
}

const createWebhookDestinationBody = jsonBody<CreateWebhookDestinationRequest, WebhookDestinationInput>((body, c) => {
  const unknown = unknownField(body, ["name", "url", "token", ...FILTER_FIELDS]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const name = normalizeDisplayName(body.name);
  if (name === null) return apiError(c, 400, "invalid_name", invalidNameMessage);
  const target = checkWebhookTarget(c, body.url, body.token);
  if (target instanceof Response) return target;
  const filter = parseDestinationFilter(body);
  if (filter === null) return apiError(c, 400, "invalid_filter", invalidFilterMessage);
  return { ok: true, value: { name, url: target.url, token: target.token, filter } };
});

type QueueInput = { name: string; filter: EventFilter };

const createQueueBody = jsonBody<CreateQueueRequest, QueueInput>((body, c) => {
  const unknown = unknownField(body, ["name", ...FILTER_FIELDS]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const name = normalizeDisplayName(body.name);
  if (name === null) return apiError(c, 400, "invalid_name", invalidNameMessage);
  const filter = parseDestinationFilter(body);
  if (filter === null) return apiError(c, 400, "invalid_filter", invalidFilterMessage);
  return { ok: true, value: { name, filter } };
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
    const body: SubscriptionList = {
      subscriptions: await subscriptionsToApi(db, c.get("user").id, workspaceId, [...mcp, ...webhooks, ...queues], now),
    };
    return c.json(body, 200);
  })
  .post("/webhooks", createWebhookDestinationBody, async (c) => {
    const { name, url, token, filter } = c.req.valid("json");
    const db = c.get("db");
    const user = c.get("user");
    const workspaceId = c.get("workspace").id;
    const limited = await destinationLimitResponse(c, "webhook");
    if (limited !== null) return limited;
    const now = clock.now();
    // On an ID collision, one more try. Not an upsert: a collision must not overwrite the existing row.
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = newRandomSubscriptionId();
      const row = await newDestinationRow({
        id,
        userId: user.id,
        workspaceId,
        name,
        filter,
        webhook: { url, token },
        jwtSecret: c.get("config").jwtSecret,
        now,
      });
      try {
        await db.insert(subscriptions).values(row).run();
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
      const created = await findWorkspaceWebhookDestination(db, workspaceId, id);
      if (!created) throw new Error("created webhook destination not found");
      const [body] = await subscriptionsToApi(db, user.id, workspaceId, [created], now);
      return c.json(body as Subscription, 201);
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
    const limited = await destinationLimitResponse(c, "queue");
    if (limited !== null) return limited;
    const now = clock.now();
    // On an ID collision, one more try. Not an upsert: a collision must not overwrite the existing row.
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = newRandomSubscriptionId();
      const row = await newDestinationRow({
        id,
        userId: user.id,
        workspaceId,
        name,
        filter,
        webhook: null,
        jwtSecret: c.get("config").jwtSecret,
        now,
      });
      try {
        await db.insert(subscriptions).values(row).run();
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
      const created = await findWorkspaceDestination(db, workspaceId, id);
      if (!created) throw new Error("created queue not found");
      const [body] = await subscriptionsToApi(db, user.id, workspaceId, [created], now);
      return c.json(body as Subscription, 201);
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
      const [body] = await subscriptionsToApi(db, c.get("user").id, workspaceId, [ended], now);
      return c.json(body as Subscription, 200);
    }
    const destination = await findWorkspaceDestination(db, workspaceId, id);
    if (!destination) return apiError(c, 404, "not_found", destinationNotFound);
    if (destination.kind === "queue") {
      // The deliveries not taken yet would never be: they fail in the same batch.
      await endQueue(c.env.DB, workspaceId, id, now);
    } else {
      await endWebhookDestination(c.env.DB, workspaceId, id, now);
    }
    const ended = await findWorkspaceDestination(db, workspaceId, id);
    if (!ended) return apiError(c, 404, "not_found", destinationNotFound);
    const [body] = await subscriptionsToApi(db, c.get("user").id, workspaceId, [ended], now);
    return c.json(body as Subscription, 200);
  });

export default subscriptionsApi;
