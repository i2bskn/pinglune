import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
  Bot,
  BotDeliveryKind,
  BotDetail,
  BotList,
  CreateBotRequest,
  UpdateBotRequest,
} from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import { isUniqueViolation } from "../auth/users";
import { isJsonObject } from "../auth/validate";
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
import { canonicalJson } from "../canonical-json";
import { callbackHost } from "../deliveries/queries";
import type { AppEnv } from "../env";
import type { EventFilter } from "../events/filter";
import { BOT_ID_PATTERN, newBotId, newRandomSubscriptionId, SOURCE_ID_PATTERN, SUBSCRIPTION_ID_PATTERN } from "../ids";
import { redirectHost } from "../mcp/connections";
import { listWorkspaceSources } from "../sources/queries";
import {
  endDestinationStatements,
  findWorkspaceDestination,
  insertSubscriptionStatement,
  isActiveSubscription,
  type StatementGuard,
} from "../subscriptions/queries";
import { jsonBody } from "./api";
import { conversationStartBody } from "./conversation-start";
import { invalidNameMessage, MAX_SOURCES_PER_WORKSPACE, normalizeDisplayName, unknownField } from "./sources";
import {
  checkWebhookTarget,
  destinationLimitResponse,
  FILTER_FIELDS,
  invalidFilterMessage,
  newDestinationRow,
  parseArguments,
  parseDestinationFilter,
  statusOf,
} from "./subscriptions";
import { requirePersonalWorkspace } from "./workspace";

type AppContext = Context<AppEnv>;

const DELIVERY_KINDS: readonly BotDeliveryKind[] = ["mcp", "webhook", "queue"];

const botNotFound = "Bot が見つかりません";
const invalidDeliveryKindMessage = "配信方式は mcp・webhook・queue のどれかにしてください";
const invalidSourceIdsMessage = "受け取る送信元の指定が正しくありません";
const sourceNotFound = "送信元が見つかりません";
const BOT_FIELDS = ["name", "delivery_kind", "delivery_subscription_id", "webhook", "conditions", "source_ids"];
const WEBHOOK_FIELDS = ["url", "token"];
const invalidDeliveryMessage =
  "配信先が見つからないか、終了しているか、配信方式と合いません。MCP Event では配信先を指定せず、Webhook とキューでは Bot に割り当てられていない有効な配信先を選ぶか、新しく作ってください";
const mcpConditionsMessage = "MCP Event の条件は AI 側で決まります";
const mcpDestinationFieldsMessage = "MCP Event では webhook・conditions を指定できません";
const webhookWithIdMessage = "webhook と delivery_subscription_id は同時に指定できません";
const webhookKindMessage = "webhook は配信方式が Webhook のときだけ指定できます";
const conditionsWithIdMessage = "conditions は新しく作る配信先にだけ指定できます";
const destinationEndedMessage = "配信先が終了しています";
const botChangedMessage = "Bot がほかの操作で変わりました。読み込み直してください";

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
    conversation_start: {
      enabled: bot.canStartConversations === 1,
      daily_limit: bot.startDailyLimit,
      max_ai_messages: bot.startMaxAiMessages,
    },
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

type WebhookTarget = { url: URL; token: string };

// The webhook field: { url, token }, checked as the registration of a webhook destination checks them.
function parseWebhookField(c: AppContext, value: unknown): WebhookTarget | Response {
  if (!isJsonObject(value)) return apiError(c, 400, "invalid_request", "webhook の形式が正しくありません");
  const unknown = unknownField(value, WEBHOOK_FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: webhook.${unknown}`);
  const target = checkWebhookTarget(c, value.url, value.token);
  if (target instanceof Response) return target;
  return { url: target.url, token: target.token };
}

// The conditions field: { types?, labels? }, checked as the registration of a destination checks them. {} is no
// condition (every event).
function parseConditionsField(c: AppContext, value: unknown): EventFilter | Response {
  if (!isJsonObject(value)) return apiError(c, 400, "invalid_filter", invalidFilterMessage);
  const unknown = unknownField(value, [...FILTER_FIELDS]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: conditions.${unknown}`);
  const filter = parseDestinationFilter(value);
  if (filter === null) return apiError(c, 400, "invalid_filter", invalidFilterMessage);
  return filter;
}

// The destination of a new bot: none (mcp), an existing destination, or a new webhook destination (webhook set) or
// polling queue (webhook null) with its conditions.
type CreateDestination =
  | { type: "none" }
  | { type: "existing"; id: string }
  | { type: "new"; webhook: WebhookTarget | null; filter: EventFilter };

type CreateInput = {
  name: string;
  deliveryKind: BotDeliveryKind;
  destination: CreateDestination;
  sourceIds: string[];
};

const createBotBody = jsonBody<CreateBotRequest, CreateInput>((body, c) => {
  const unknown = unknownField(body, BOT_FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const name = normalizeDisplayName(body.name);
  if (name === null) return apiError(c, 400, "invalid_request", invalidNameMessage);
  if (!isDeliveryKind(body.delivery_kind)) return apiError(c, 400, "invalid_request", invalidDeliveryKindMessage);
  const kind = body.delivery_kind;
  const sourceIds = "source_ids" in body ? parseSourceIds(body.source_ids) : [];
  if (sourceIds === null) return apiError(c, 400, "invalid_request", invalidSourceIdsMessage);
  const hasWebhook = "webhook" in body;
  const hasConditions = "conditions" in body;
  const id = body.delivery_subscription_id;
  const value = (destination: CreateDestination) =>
    ({ ok: true, value: { name, deliveryKind: kind, destination, sourceIds } }) as const;

  if (kind === "mcp") {
    if (hasWebhook || hasConditions) return apiError(c, 400, "invalid_request", mcpDestinationFieldsMessage);
    if (id !== undefined && id !== null) return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
    return value({ type: "none" });
  }
  if (hasWebhook && kind !== "webhook") return apiError(c, 400, "invalid_request", webhookKindMessage);
  // null is taken as left out: a new destination is made.
  if (id !== undefined && id !== null) {
    if (hasWebhook) return apiError(c, 400, "invalid_request", webhookWithIdMessage);
    if (hasConditions) return apiError(c, 400, "invalid_request", conditionsWithIdMessage);
    if (typeof id !== "string" || !SUBSCRIPTION_ID_PATTERN.test(id)) {
      return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
    }
    return value({ type: "existing", id });
  }
  if (kind === "webhook" && !hasWebhook) return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
  const webhook = hasWebhook ? parseWebhookField(c, body.webhook) : null;
  if (webhook instanceof Response) return webhook;
  const filter = hasConditions ? parseConditionsField(c, body.conditions) : {};
  if (filter instanceof Response) return filter;
  return value({ type: "new", webhook, filter });
});

type UpdateInput = {
  name?: string;
  deliveryKind?: BotDeliveryKind;
  deliverySubscriptionId?: string | null;
  webhook?: WebhookTarget;
  conditions?: EventFilter;
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
      "name・delivery_kind・delivery_subscription_id・webhook・conditions・source_ids のどれかを指定してください",
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
  if ("webhook" in body) {
    if ("delivery_subscription_id" in body) return apiError(c, 400, "invalid_request", webhookWithIdMessage);
    if (value.deliveryKind !== undefined && value.deliveryKind !== "webhook") {
      return apiError(c, 400, "invalid_request", webhookKindMessage);
    }
  }
  if ("conditions" in body && value.deliveryKind === "mcp") {
    return apiError(c, 400, "invalid_request", mcpConditionsMessage);
  }
  if ("delivery_subscription_id" in body) {
    const id = body.delivery_subscription_id;
    if (id !== null && (typeof id !== "string" || !SUBSCRIPTION_ID_PATTERN.test(id))) {
      return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
    }
    value.deliverySubscriptionId = id;
  }
  if ("webhook" in body) {
    const webhook = parseWebhookField(c, body.webhook);
    if (webhook instanceof Response) return webhook;
    value.webhook = webhook;
  }
  if ("conditions" in body) {
    const conditions = parseConditionsField(c, body.conditions);
    if (conditions instanceof Response) return conditions;
    value.conditions = conditions;
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

// The state of a bot that the statements of a batch rely on: its delivery kind and its destination.
type BotDelivery = { kind: BotDeliveryKind; subscriptionId: string | null };

// The condition that the bot is not deleted and still has this delivery kind and destination (IS: NULL for mcp).
// Every statement of the batches that change a bot carries it, so that a bot changed by another request since it was
// read changes nothing.
function liveBotGuard(botId: string, workspaceId: string, delivery: BotDelivery): StatementGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM bots WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND delivery_kind = ?
      AND delivery_subscription_id IS ?)`,
    values: [botId, workspaceId, delivery.kind, delivery.subscriptionId],
  };
}

// The statements that link a bot to its sources, for the batch that creates or updates the bot. Each statement is
// guarded (liveBotGuard with the bot's state after the batch), so that a delete or another change that runs first
// leaves no rows behind. Only sources of programs of the workspace are inserted (sources are never deleted, so the
// validated ones are still there).
function linkSourcesStatements(
  d1: D1Database,
  workspaceId: string,
  botId: string,
  sourceIds: string[],
  now: number,
  guard: StatementGuard,
): D1PreparedStatement[] {
  return [
    d1
      .prepare(`DELETE FROM bot_sources WHERE bot_id = ? AND workspace_id = ? AND ${guard.sql}`)
      .bind(botId, workspaceId, ...guard.values),
    ...sourceIds.map((sourceId) =>
      d1
        .prepare(
          `INSERT INTO bot_sources (bot_id, source_id, workspace_id, created_at)
          SELECT ?, id, workspace_id, ? FROM sources WHERE id = ? AND workspace_id = ? AND kind = 'program' AND ${guard.sql}`,
        )
        .bind(botId, now, sourceId, workspaceId, ...guard.values),
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

// The destination a bot refers to, ended or not, as BotDetail returns it.
async function botDestination(db: Db, workspaceId: string, bot: BotRow, now: number): Promise<BotDetail["destination"]> {
  if (bot.deliveryKind === "mcp" || bot.deliverySubscriptionId === null) return null;
  const row = await findWorkspaceDestination(db, workspaceId, bot.deliverySubscriptionId);
  if (row === undefined || row.kind === "mcp") return null;
  return {
    subscription_id: row.id,
    kind: row.kind,
    name: row.name,
    callback_host: callbackHost(row.callbackUrl),
    status: statusOf(row, now),
    arguments: parseArguments(row.arguments),
  };
}

// The new destination of an update: what the bot will deliver to after it.
// - keep: the destination does not change.
// - existing: delivery_subscription_id, another destination that exists.
// - new: a new webhook destination (webhook set) or polling queue (webhook null).
// - none: mcp.
type DeliveryChange =
  | { type: "keep" }
  | { type: "existing"; kind: "webhook" | "queue"; id: string }
  | { type: "new"; kind: "webhook" | "queue"; webhook: WebhookTarget | null }
  | { type: "none" };

// Decides the change of the destination of an update, or the error to answer.
async function deliveryChange(c: AppContext, bot: BotRow, input: UpdateInput): Promise<DeliveryChange | Response> {
  const db = c.get("db");
  const workspaceId = c.get("workspace").id;
  const kind = input.deliveryKind ?? bot.deliveryKind;
  if (input.webhook !== undefined) {
    if (kind !== "webhook") return apiError(c, 400, "invalid_request", webhookKindMessage);
    return { type: "new", kind: "webhook", webhook: input.webhook };
  }
  if (input.deliverySubscriptionId !== undefined) {
    const id = input.deliverySubscriptionId;
    // The same destination (or none for mcp) is no change.
    if (kind === bot.deliveryKind && id === bot.deliverySubscriptionId) return { type: "keep" };
    if (!(await validDestination(db, workspaceId, kind, id))) {
      return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
    }
    if (kind === "mcp" || id === null) return { type: "none" };
    return { type: "existing", kind, id };
  }
  if (kind === bot.deliveryKind) return { type: "keep" };
  if (kind === "mcp") return { type: "none" };
  if (kind === "queue") return { type: "new", kind: "queue", webhook: null };
  return apiError(
    c,
    400,
    "invalid_request",
    "配信方式を Webhook に変えるときは webhook か delivery_subscription_id を指定してください",
  );
}

// keep_destination: "true" keeps the bot's webhook destination or polling queue (it stays, not assigned to a bot),
// "false" or omitted ends it. Any other value, including "" and a repeated parameter, is 400. Other parameters are
// ignored.
type DeleteQuery = { keep_destination?: "true" | "false" };

const deleteQuery = validator("query", (value: Record<string, string | string[]>, c) => {
  const query: DeleteQuery = {};
  const { keep_destination: keep } = value;
  if (keep !== undefined) {
    if (keep !== "true" && keep !== "false") {
      return apiError(c, 400, "invalid_request", "keep_destination は true か false で指定してください");
    }
    query.keep_destination = keep;
  }
  return query;
});

const botsApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", async (c) => {
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const rows = await listWorkspaceBots(db, workspaceId, MAX_BOTS_PER_WORKSPACE);
    const body: BotList = { bots: await botsToApi(db, workspaceId, rows, clock.now()) };
    return c.json(body, 200);
  })
  .get("/:id", async (c) => {
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const bot = await findBot(c, false);
    if (!bot) return apiError(c, 404, "not_found", botNotFound);
    const now = clock.now();
    const [[api], destination] = await Promise.all([
      botsToApi(db, workspaceId, [bot], now),
      botDestination(db, workspaceId, bot, now),
    ]);
    if (api === undefined) return apiError(c, 404, "not_found", botNotFound);
    const body: BotDetail = { ...api, destination };
    return c.json(body, 200);
  })
  .post("/", createBotBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const user = c.get("user");
    // A loose limit: concurrent requests may go slightly over it.
    if ((await countActiveBots(db, workspaceId)) >= MAX_BOTS_PER_WORKSPACE) {
      return apiError(c, 409, "limit_exceeded", `Bot は ${MAX_BOTS_PER_WORKSPACE} 個までです`);
    }
    const destination = input.destination;
    if (destination.type === "existing" && !(await validDestination(db, workspaceId, input.deliveryKind, destination.id))) {
      return apiError(c, 400, "invalid_delivery", invalidDeliveryMessage);
    }
    if (destination.type === "new") {
      const limited = await destinationLimitResponse(c, destination.webhook === null ? "queue" : "webhook");
      if (limited !== null) return limited;
    }
    if (!(await validSources(db, workspaceId, input.sourceIds))) {
      return apiError(c, 400, "invalid_source", sourceNotFound);
    }
    const now = clock.now();
    const id = newBotId(now);
    const d1 = c.env.DB;
    // The destination made with the bot, named after it. Its ID is random: a collision fails the batch (409).
    const row =
      destination.type === "new"
        ? await newDestinationRow({
            id: newRandomSubscriptionId(),
            userId: user.id,
            workspaceId,
            name: input.name,
            filter: destination.filter,
            webhook: destination.webhook,
            jwtSecret: c.get("config").jwtSecret,
            now,
          })
        : null;
    const subscriptionId = row !== null ? row.id : destination.type === "existing" ? destination.id : null;
    // One batch: the destination, the bot, then its sources. A failure (a name taken, for example) leaves none of
    // them.
    try {
      await d1.batch([
        ...(row === null ? [] : [insertSubscriptionStatement(d1, row)]),
        d1
          .prepare(
            `INSERT INTO bots (id, workspace_id, created_by_user_id, name, delivery_kind, delivery_subscription_id,
              created_at, updated_at, deleted_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL)`,
          )
          .bind(id, workspaceId, user.id, input.name, input.deliveryKind, subscriptionId, now),
        ...(input.sourceIds.length === 0
          ? []
          : linkSourcesStatements(
              d1,
              workspaceId,
              id,
              input.sourceIds,
              now,
              liveBotGuard(id, workspaceId, { kind: input.deliveryKind, subscriptionId }),
            )),
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
    const change = await deliveryChange(c, bot, input);
    if (change instanceof Response) return change;
    // The destination before the update: ended when the bot changes to another one.
    const previous: BotDelivery = { kind: bot.deliveryKind, subscriptionId: bot.deliverySubscriptionId };
    const ending = change.type !== "keep" && previous.kind !== "mcp" ? previous.subscriptionId : null;
    if (input.conditions !== undefined) {
      if (change.type === "existing") return apiError(c, 400, "invalid_request", conditionsWithIdMessage);
      if (change.type === "none") return apiError(c, 400, "invalid_request", mcpConditionsMessage);
      if (change.type === "keep") {
        if (bot.deliveryKind === "mcp") return apiError(c, 400, "invalid_request", mcpConditionsMessage);
        const current =
          bot.deliverySubscriptionId === null ? undefined : await findWorkspaceDestination(db, workspaceId, bot.deliverySubscriptionId);
        if (current === undefined || current.kind !== bot.deliveryKind || current.unsubscribedAt !== null) {
          return apiError(c, 400, "invalid_request", destinationEndedMessage);
        }
      }
    }
    if (change.type === "new") {
      // The destination that this update ends is not counted (when it is active and of the same kind).
      let endingActive = 0;
      if (ending !== null && previous.kind === change.kind) {
        const row = await findWorkspaceDestination(db, workspaceId, ending);
        if (row !== undefined && row.kind === change.kind && row.unsubscribedAt === null) endingActive = 1;
      }
      const limited = await destinationLimitResponse(c, change.kind, endingActive);
      if (limited !== null) return limited;
    }
    if (input.sourceIds !== undefined && !(await validSources(db, workspaceId, input.sourceIds))) {
      return apiError(c, 400, "invalid_source", sourceNotFound);
    }
    const name = input.name ?? bot.name;
    const now = clock.now();
    const d1 = c.env.DB;
    const row =
      change.type === "new"
        ? await newDestinationRow({
            id: newRandomSubscriptionId(),
            userId: c.get("user").id,
            workspaceId,
            name,
            filter: input.conditions ?? {},
            webhook: change.webhook,
            jwtSecret: c.get("config").jwtSecret,
            now,
          })
        : null;
    const next: BotDelivery =
      change.type === "keep"
        ? previous
        : change.type === "none"
          ? { kind: "mcp", subscriptionId: null }
          : { kind: change.kind, subscriptionId: change.type === "new" ? (row as { id: string }).id : change.id };
    const before = liveBotGuard(bot.id, workspaceId, previous);
    const after = liveBotGuard(bot.id, workspaceId, next);

    // The order of the batch: (1) the end of the previous destination and (2) the new destination, both while the
    // bot is as it was read; (3) the bot, under the same condition; (4) the statements on the bot's new state, while
    // the bot is as (3) left it. When (3) changes nothing, nothing else changes either.
    const statements: D1PreparedStatement[] = [];
    if (ending !== null && previous.kind !== "mcp") {
      statements.push(...endDestinationStatements(d1, previous.kind, workspaceId, ending, now, before));
    }
    if (row !== null) statements.push(insertSubscriptionStatement(d1, row, before));
    const botIndex = statements.length;
    statements.push(
      d1
        .prepare(
          `UPDATE bots SET name = ?, delivery_kind = ?, delivery_subscription_id = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND delivery_kind = ? AND delivery_subscription_id IS ?`,
        )
        .bind(name, next.kind, next.subscriptionId, now, bot.id, workspaceId, previous.kind, previous.subscriptionId),
    );
    if (input.sourceIds !== undefined) {
      statements.push(...linkSourcesStatements(d1, workspaceId, bot.id, input.sourceIds, now, after));
    }
    // A destination kept is renamed with the bot, unless it has ended. A destination given by
    // delivery_subscription_id keeps its name until the bot is renamed.
    if (change.type === "keep" && name !== bot.name && next.kind !== "mcp" && next.subscriptionId !== null) {
      statements.push(
        d1
          .prepare(
            `UPDATE subscriptions SET name = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ? AND kind = ? AND unsubscribed_at IS NULL AND ${after.sql}`,
          )
          .bind(name, now, next.subscriptionId, workspaceId, next.kind, ...after.values),
      );
    }
    if (change.type === "keep" && input.conditions !== undefined && next.subscriptionId !== null) {
      statements.push(
        d1
          .prepare(
            `UPDATE subscriptions SET arguments = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ? AND kind = ? AND unsubscribed_at IS NULL AND ${after.sql}`,
          )
          .bind(canonicalJson(input.conditions), now, next.subscriptionId, workspaceId, next.kind, ...after.values),
      );
    }
    try {
      const results = await d1.batch(statements);
      if ((results[botIndex]?.meta.changes ?? 0) === 0) {
        const latest = await findWorkspaceBot(db, workspaceId, bot.id);
        if (!latest || latest.deletedAt !== null) return apiError(c, 404, "not_found", botNotFound);
        return apiError(c, 409, "conflict", botChangedMessage);
      }
    } catch (error) {
      if (isUniqueViolation(error)) return conflict(c, workspaceId, name, bot.id);
      throw error;
    }
    const updated = await findActiveWorkspaceBot(db, workspaceId, bot.id);
    if (!updated) return apiError(c, 404, "not_found", botNotFound);
    const [body] = await botsToApi(db, workspaceId, [updated], now);
    return c.json(body as Bot, 200);
  })
  // The conversation start settings, apart from update: they do not touch the destination. Turning them off does not
  // stop the conversations the bot has started.
  .post("/:id/conversation-start", conversationStartBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const id = c.req.param("id") ?? "";
    if (!BOT_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", botNotFound);
    const now = clock.now();
    const result = await c.env.DB.prepare(
      `UPDATE bots SET can_start_conversations = ?, start_daily_limit = ?, start_max_ai_messages = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    )
      .bind(input.enabled ? 1 : 0, input.dailyLimit, input.maxAiMessages, now, id, workspaceId)
      .run();
    if ((result.meta.changes ?? 0) === 0) return apiError(c, 404, "not_found", botNotFound);
    const updated = await findActiveWorkspaceBot(db, workspaceId, id);
    if (!updated) return apiError(c, 404, "not_found", botNotFound);
    const [body] = await botsToApi(db, workspaceId, [updated], now);
    return c.json(body as Bot, 200);
  })
  .post("/:id/delete", deleteQuery, async (c) => {
    const keepDestination = c.req.valid("query").keep_destination === "true";
    const bot = await findBot(c, true);
    if (!bot) return apiError(c, 404, "not_found", botNotFound);
    // Deleting a deleted bot changes nothing.
    if (bot.deletedAt !== null) return c.body(null, 204);
    const workspaceId = c.get("workspace").id;
    const now = clock.now();
    const d1 = c.env.DB;
    const previous: BotDelivery = { kind: bot.deliveryKind, subscriptionId: bot.deliverySubscriptionId };
    const before = liveBotGuard(bot.id, workspaceId, previous);
    // The bot's own destination (a webhook destination or a polling queue) ends with it, first, while the bot is as it
    // was read, unless keep_destination keeps it (it stays, not assigned to a bot; what is already pending on it is
    // still delivered or polled). The connection stays, not assigned to a bot (an MCP Events subscription belongs to
    // the connection and is not ended). The linked sources go with the bot. Those two run only once the bot is deleted.
    const deleted = {
      sql: "EXISTS (SELECT 1 FROM bots WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL)",
      values: [bot.id, workspaceId],
    };
    const statements: D1PreparedStatement[] = [];
    if (!keepDestination && previous.kind !== "mcp" && previous.subscriptionId !== null) {
      statements.push(...endDestinationStatements(d1, previous.kind, workspaceId, previous.subscriptionId, now, before));
    }
    const botIndex = statements.length;
    statements.push(
      d1
        .prepare(
          `UPDATE bots SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND delivery_kind = ? AND delivery_subscription_id IS ?`,
        )
        .bind(now, now, bot.id, workspaceId, previous.kind, previous.subscriptionId),
      d1
        .prepare(
          `UPDATE mcp_connections SET bot_id = NULL, updated_at = ?
          WHERE bot_id = ? AND workspace_id = ? AND revoked_at IS NULL AND ${deleted.sql}`,
        )
        .bind(now, bot.id, workspaceId, ...deleted.values),
      d1
        .prepare(`DELETE FROM bot_sources WHERE bot_id = ? AND workspace_id = ? AND ${deleted.sql}`)
        .bind(bot.id, workspaceId, ...deleted.values),
    );
    const results = await d1.batch(statements);
    if ((results[botIndex]?.meta.changes ?? 0) === 0) {
      const latest = await findWorkspaceBot(c.get("db"), workspaceId, bot.id);
      if (!latest) return apiError(c, 404, "not_found", botNotFound);
      // Deleted by another request meanwhile.
      if (latest.deletedAt !== null) return c.body(null, 204);
      return apiError(c, 409, "conflict", botChangedMessage);
    }
    return c.body(null, 204);
  });

export default botsApi;
