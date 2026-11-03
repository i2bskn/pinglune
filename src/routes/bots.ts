import type { Context } from "hono";
import { Hono } from "hono";
import type { Bot, BotDeliveryKind, BotList, CreateBotRequest, UpdateBotRequest } from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import { isUniqueViolation } from "../auth/users";
import {
  activeConnectionsByBot,
  countActiveBots,
  findActiveWorkspaceBot,
  findWorkspaceBot,
  linkedSourcesByBot,
  listWorkspaceBots,
  MAX_BOTS_PER_WORKSPACE,
  resolveBotDeliveries,
  type BotSourceSummary,
} from "../bots/queries";
import { clock } from "../clock";
import type { Db } from "../db/client";
import type { BotRow, McpConnectionRow, SubscriptionRow } from "../db/schema";
import { callbackHost } from "../deliveries/queries";
import type { AppEnv } from "../env";
import { BOT_ID_PATTERN, newBotId, SOURCE_ID_PATTERN, SUBSCRIPTION_ID_PATTERN } from "../ids";
import { redirectHost } from "../mcp/connections";
import { listWorkspaceSources } from "../sources/queries";
import { findWorkspaceDestination, isActiveSubscription } from "../subscriptions/queries";
import { jsonBody } from "./api";
import { invalidNameMessage, MAX_SOURCES_PER_WORKSPACE, normalizeDisplayName, unknownField } from "./sources";
import { statusOf } from "./subscriptions";
import { requirePersonalWorkspace } from "./workspace";

type AppContext = Context<AppEnv>;

const DELIVERY_KINDS: readonly BotDeliveryKind[] = ["mcp", "webhook", "queue"];

const botNotFound = "Bot が見つかりません";
const invalidDeliveryKindMessage = "配信方式は mcp・webhook・queue のどれかにしてください";
const invalidSourceIdsMessage = "受け取る送信元の指定が正しくありません";
const sourceNotFound = "送信元が見つかりません";
const BOT_FIELDS = ["name", "delivery_kind", "delivery_subscription_id", "source_ids"];
const invalidDeliveryMessage =
  "配信先が見つからないか、終了しているか、配信方式と合いません。MCP Event では配信先を指定せず、Webhook とキューでは配信先画面で作った配信先を選んでください";

function isDeliveryKind(value: unknown): value is BotDeliveryKind {
  return typeof value === "string" && (DELIVERY_KINDS as readonly string[]).includes(value);
}

export function toApiBot(
  bot: BotRow,
  connection: McpConnectionRow | undefined,
  delivery: SubscriptionRow | null | undefined,
  sources: BotSourceSummary[],
  now: number,
): Bot {
  const resolved = delivery ?? null;
  return {
    id: bot.id,
    name: bot.name,
    delivery_kind: bot.deliveryKind,
    delivery:
      resolved === null
        ? null
        : {
            subscription_id: resolved.id,
            name: resolved.name,
            callback_host: callbackHost(resolved.callbackUrl),
            status: statusOf(resolved, now),
          },
    connection:
      connection === undefined
        ? null
        : {
            id: connection.id,
            client_name: connection.clientName,
            redirect_host: redirectHost(connection.redirectUri),
            created_at: connection.createdAt,
          },
    status: connection === undefined ? "no_connection" : resolved === null ? "no_delivery" : "ready",
    sources: sources.map((source) => ({ id: source.id, name: source.name, enabled: source.enabled })),
    created_at: bot.createdAt,
    updated_at: bot.updatedAt,
  };
}

// The bots with their active connections, their destinations now and their linked sources.
async function botsToApi(db: Db, workspaceId: string, rows: BotRow[], now: number): Promise<Bot[]> {
  const ids = rows.map((row) => row.id);
  const [connections, linked] = await Promise.all([
    activeConnectionsByBot(db, workspaceId, ids),
    linkedSourcesByBot(db, workspaceId, ids),
  ]);
  const deliveries = await resolveBotDeliveries(db, workspaceId, rows, now, connections);
  return rows.map((row) =>
    toApiBot(row, connections.get(row.id), deliveries.get(row.id), linked.get(row.id) ?? [], now),
  );
}

// The form of source_ids: an array of strings, without duplicates (the first of each kept), up to
// MAX_SOURCES_PER_WORKSPACE. null if invalid. Whether they are sources of the workspace is checked later.
function parseSourceIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  const ids = [...new Set(value as string[])];
  return ids.length <= MAX_SOURCES_PER_WORKSPACE ? ids : null;
}

type CreateInput = {
  name: string;
  deliveryKind: BotDeliveryKind;
  deliverySubscriptionId: string | null;
  sourceIds: string[];
};

const createBotBody = jsonBody<CreateBotRequest, CreateInput>((body, c) => {
  const unknown = unknownField(body, BOT_FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const name = normalizeDisplayName(body.name);
  if (name === null) return apiError(c, 400, "invalid_request", invalidNameMessage);
  if (!isDeliveryKind(body.delivery_kind)) return apiError(c, 400, "invalid_request", invalidDeliveryKindMessage);
  const sourceIds = "source_ids" in body ? parseSourceIds(body.source_ids) : [];
  if (sourceIds === null) return apiError(c, 400, "invalid_request", invalidSourceIdsMessage);
  const deliverySubscriptionId = parseDeliverySubscriptionId(body.delivery_kind, body.delivery_subscription_id);
  if (deliverySubscriptionId === undefined) return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
  return { ok: true, value: { name, deliveryKind: body.delivery_kind, deliverySubscriptionId, sourceIds } };
});

// The destination given for a delivery kind: null for mcp (absent or null), a subscription ID of the right form for
// webhook and queue. undefined if invalid.
function parseDeliverySubscriptionId(kind: BotDeliveryKind, value: unknown): string | null | undefined {
  if (kind === "mcp") return value === undefined || value === null ? null : undefined;
  return typeof value === "string" && SUBSCRIPTION_ID_PATTERN.test(value) ? value : undefined;
}

type UpdateInput = {
  name?: string;
  deliveryKind?: BotDeliveryKind;
  deliverySubscriptionId?: string | null;
  sourceIds?: string[];
};

const updateBotBody = jsonBody<UpdateBotRequest, UpdateInput>((body, c) => {
  const unknown = unknownField(body, BOT_FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  if (!BOT_FIELDS.some((field) => field in body)) {
    return apiError(
      c,
      400,
      "invalid_request",
      "name・delivery_kind・delivery_subscription_id・source_ids のどれかを指定してください",
    );
  }
  const value: UpdateInput = {};
  if ("name" in body) {
    const name = normalizeDisplayName(body.name);
    if (name === null) return apiError(c, 400, "invalid_request", invalidNameMessage);
    value.name = name;
  }
  if ("delivery_kind" in body) {
    if (!isDeliveryKind(body.delivery_kind)) return apiError(c, 400, "invalid_request", invalidDeliveryKindMessage);
    value.deliveryKind = body.delivery_kind;
  }
  if ("source_ids" in body) {
    const sourceIds = parseSourceIds(body.source_ids);
    if (sourceIds === null) return apiError(c, 400, "invalid_request", invalidSourceIdsMessage);
    value.sourceIds = sourceIds;
  }
  if ("delivery_subscription_id" in body) {
    const id = body.delivery_subscription_id;
    if (id !== null && (typeof id !== "string" || !SUBSCRIPTION_ID_PATTERN.test(id))) {
      return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
    }
    value.deliverySubscriptionId = id;
  }
  return { ok: true, value };
});

// Whether the destination of a webhook or queue bot is an active subscription of that kind in the workspace.
async function validDestination(db: Db, workspaceId: string, kind: BotDeliveryKind, id: string | null): Promise<boolean> {
  if (kind === "mcp") return id === null;
  if (id === null) return false;
  const row = await findWorkspaceDestination(db, workspaceId, id);
  return row !== undefined && row.kind === kind && isActiveSubscription(row, clock.now());
}

// Whether every ID is a source of programs of the workspace (disabled ones included). The workspace's sources are
// read with one bound value and matched here, so that no IN list grows with the number of IDs.
async function validSources(db: Db, workspaceId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  if (!ids.every((id) => SOURCE_ID_PATTERN.test(id))) return false;
  const known = new Set((await listWorkspaceSources(db, workspaceId)).map((source) => source.id));
  return ids.every((id) => known.has(id));
}

// The statements that link a bot to its sources, for the batch that creates or updates the bot. Each statement is
// guarded by the bot not being deleted, so that a delete that runs first leaves no rows behind. Only sources of
// programs of the workspace are inserted (sources are never deleted, so the validated ones are still there).
function linkSourcesStatements(
  d1: D1Database,
  workspaceId: string,
  botId: string,
  sourceIds: string[],
  now: number,
): D1PreparedStatement[] {
  const liveBot = "EXISTS (SELECT 1 FROM bots WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL)";
  return [
    d1.prepare(`DELETE FROM bot_sources WHERE bot_id = ?1 AND workspace_id = ?2 AND ${liveBot}`).bind(botId, workspaceId),
    ...sourceIds.map((sourceId) =>
      d1
        .prepare(
          `INSERT INTO bot_sources (bot_id, source_id, workspace_id, created_at)
          SELECT ?1, id, workspace_id, ?4 FROM sources WHERE id = ?3 AND workspace_id = ?2 AND kind = 'program' AND ${liveBot}`,
        )
        .bind(botId, workspaceId, sourceId, now),
    ),
  ];
}

// The 409 of a UNIQUE violation on bots: the name, or else the destination, is taken by another bot that is not
// deleted.
async function conflict(c: AppContext, workspaceId: string, name: string, exceptId: string | null): Promise<Response> {
  const sameName = await c.env.DB.prepare(
    "SELECT id FROM bots WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL AND id != ?",
  )
    .bind(workspaceId, name, exceptId ?? "")
    .first<{ id: string }>();
  if (sameName !== null) return apiError(c, 409, "name_conflict", "同じ名前の Bot があります");
  return apiError(c, 409, "delivery_in_use", "この配信先は別の Bot が使っています");
}

async function findBot(c: AppContext, includeDeleted: boolean): Promise<BotRow | undefined> {
  const id = c.req.param("id") ?? "";
  if (!BOT_ID_PATTERN.test(id)) return undefined;
  const workspaceId = c.get("workspace").id;
  return includeDeleted
    ? findWorkspaceBot(c.get("db"), workspaceId, id)
    : findActiveWorkspaceBot(c.get("db"), workspaceId, id);
}

const botsApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", async (c) => {
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const rows = await listWorkspaceBots(db, workspaceId, MAX_BOTS_PER_WORKSPACE);
    const body: BotList = { bots: await botsToApi(db, workspaceId, rows, clock.now()) };
    return c.json(body, 200);
  })
  .post("/", createBotBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    // A loose limit: concurrent requests may go slightly over it.
    if ((await countActiveBots(db, workspaceId)) >= MAX_BOTS_PER_WORKSPACE) {
      return apiError(c, 409, "limit_exceeded", `Bot は ${MAX_BOTS_PER_WORKSPACE} 個までです`);
    }
    if (!(await validDestination(db, workspaceId, input.deliveryKind, input.deliverySubscriptionId))) {
      return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
    }
    if (!(await validSources(db, workspaceId, input.sourceIds))) {
      return apiError(c, 400, "invalid_source", sourceNotFound);
    }
    const now = clock.now();
    const id = newBotId(now);
    const d1 = c.env.DB;
    try {
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO bots (id, workspace_id, created_by_user_id, name, delivery_kind, delivery_subscription_id,
              created_at, updated_at, deleted_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL)`,
          )
          .bind(id, workspaceId, c.get("user").id, input.name, input.deliveryKind, input.deliverySubscriptionId, now),
        ...(input.sourceIds.length === 0 ? [] : linkSourcesStatements(d1, workspaceId, id, input.sourceIds, now)),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) return conflict(c, workspaceId, input.name, null);
      throw error;
    }
    const created = await findActiveWorkspaceBot(db, workspaceId, id);
    if (!created) throw new Error("created bot not found");
    const [bot] = await botsToApi(db, workspaceId, [created], now);
    return c.json(bot as Bot, 201);
  })
  .post("/:id/update", updateBotBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const bot = await findBot(c, false);
    if (!bot) return apiError(c, 404, "not_found", botNotFound);
    const kind = input.deliveryKind ?? bot.deliveryKind;
    if (kind !== bot.deliveryKind && input.deliverySubscriptionId === undefined) {
      return apiError(
        c,
        400,
        "invalid_request",
        "配信方式を変えるときは delivery_subscription_id も指定してください（MCP Event では null）",
      );
    }
    const destination = input.deliverySubscriptionId === undefined ? bot.deliverySubscriptionId : input.deliverySubscriptionId;
    // A destination that does not change is not checked again (a rename of a bot whose destination has ended).
    const changed = kind !== bot.deliveryKind || destination !== bot.deliverySubscriptionId;
    if (changed && !(await validDestination(db, workspaceId, kind, destination))) {
      return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
    }
    if (input.sourceIds !== undefined && !(await validSources(db, workspaceId, input.sourceIds))) {
      return apiError(c, 400, "invalid_source", sourceNotFound);
    }
    const name = input.name ?? bot.name;
    const now = clock.now();
    const d1 = c.env.DB;
    try {
      // The bot first: a bot deleted meanwhile changes nothing (404), and the guarded statements that follow change
      // nothing either.
      const [result] = await d1.batch([
        d1
          .prepare(
            `UPDATE bots SET name = ?1, delivery_kind = ?2, delivery_subscription_id = ?3, updated_at = ?4
            WHERE id = ?5 AND workspace_id = ?6 AND deleted_at IS NULL`,
          )
          .bind(name, kind, destination, now, bot.id, workspaceId),
        ...(input.sourceIds === undefined ? [] : linkSourcesStatements(d1, workspaceId, bot.id, input.sourceIds, now)),
      ]);
      if ((result?.meta.changes ?? 0) === 0) return apiError(c, 404, "not_found", botNotFound);
    } catch (error) {
      if (isUniqueViolation(error)) return conflict(c, workspaceId, name, bot.id);
      throw error;
    }
    const updated = await findActiveWorkspaceBot(db, workspaceId, bot.id);
    if (!updated) return apiError(c, 404, "not_found", botNotFound);
    const [body] = await botsToApi(db, workspaceId, [updated], now);
    return c.json(body as Bot, 200);
  })
  .post("/:id/delete", async (c) => {
    const bot = await findBot(c, true);
    if (!bot) return apiError(c, 404, "not_found", botNotFound);
    // Deleting a deleted bot changes nothing.
    if (bot.deletedAt !== null) return c.body(null, 204);
    const workspaceId = c.get("workspace").id;
    const now = clock.now();
    const d1 = c.env.DB;
    // The connection stays, not assigned to a bot. The destination (a webhook destination or a polling queue) is not
    // ended, but belonging to no bot it receives no events. The linked sources go with the bot.
    await d1.batch([
      d1
        .prepare("UPDATE bots SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3 AND deleted_at IS NULL")
        .bind(now, bot.id, workspaceId),
      d1
        .prepare(
          "UPDATE mcp_connections SET bot_id = NULL, updated_at = ?1 WHERE bot_id = ?2 AND workspace_id = ?3 AND revoked_at IS NULL",
        )
        .bind(now, bot.id, workspaceId),
      d1.prepare("DELETE FROM bot_sources WHERE bot_id = ?1 AND workspace_id = ?2").bind(bot.id, workspaceId),
    ]);
    return c.body(null, 204);
  });

export default botsApi;
