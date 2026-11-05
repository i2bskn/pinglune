import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
  Conversation,
  ConversationDetail,
  ConversationList,
  ConversationMessageList,
  ConversationParticipant,
  ConversationStartedBy,
  CreateConversationRequest,
  PostConversationMessageRequest,
  PostedConversationMessage,
} from "../api/types";
import { apiError, clock, type Db, isJsonObject } from "@i2bskn/workers-app-core";
import { requireUser } from "../core";
import { activeConnectionsByBot, resolveBotDeliveries, workspaceBotsByIds } from "../bots/queries";
import {
  CONVERSATION_PAGE_SIZE,
  findWorkspaceConversation,
  listConversationMessages,
  listConversationParticipants,
  listWorkspaceConversations,
  participantsByConversation,
  stopConversation,
  workspaceSubscriptionsByIds,
} from "../conversations/queries";
import {
  createConversation,
  createIdempotencyKey,
  DEFAULT_MAX_AI_MESSAGES,
  duplicateMessage,
  findExistingMessage,
  MAX_AI_MESSAGES_LIMIT,
  MAX_PARTICIPANTS,
  MESSAGE_IDEMPOTENCY_KEY_PATTERN,
  postUserMessage,
  readMessageText,
  senderKind,
  validateMessageText,
  type MessageDeps,
  type ValidText,
} from "../conversations/service";
import type { ConversationParticipantRow, ConversationRow, SubscriptionRow } from "../db/schema";
import { callbackHost } from "../deliveries/queries";
import type { AppEnv } from "../env";
import { sourceNames } from "../events/queries";
import { BOT_ID_PATTERN, CONVERSATION_ID_PATTERN, EVENT_ID_PATTERN } from "../ids";
import { jsonBody } from "./api";
import { normalizeDisplayName, unknownField } from "./sources";
import { statusOf } from "./subscriptions";
import { requirePersonalWorkspace } from "./workspace";

const conversationNotFound = "会話が見つかりません";
const invalidTitleMessage = "件名は制御文字を含まない 1〜64 文字にしてください";
const invalidLimitMessage = "AI の発言の上限は 1〜100 の整数にしてください";
const invalidParticipantsMessage = "参加者は 1〜5 個の Bot にしてください。同じ Bot は選べません";
const invalidTextMessage =
  "本文は空白だけでない 1〜65,536 バイトのテキストにしてください（改行とタブ以外の制御文字は使えません）";
const invalidIdempotencyKeyMessage = "idempotency_key が正しくありません";
const unavailableMessage = "一時的に受け付けられません。もう一度送ってください";

type AppContext = Context<AppEnv>;

// cursor: an ID of the previous page. Any other value, including "", is 400.
function cursorQuery(pattern: RegExp) {
  return validator("query", (value: Record<string, string | string[]>, c) => {
    const cursor = value.cursor;
    if (cursor === undefined) return {} as { cursor?: string };
    if (typeof cursor !== "string" || !pattern.test(cursor)) {
      return apiError(c, 400, "invalid_cursor", "cursor が正しくありません");
    }
    return { cursor } as { cursor?: string };
  });
}

// The bots of the participants of a new conversation, or null if invalid: 1 to 5 bot IDs, none of them given twice.
// Whether the bots are the user's is checked later.
function parseParticipants(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTICIPANTS) return null;
  const botIds: string[] = [];
  for (const item of value) {
    if (!isJsonObject(item) || unknownField(item, ["bot_id"]) !== null) return null;
    const botId = item.bot_id;
    if (typeof botId !== "string" || !BOT_ID_PATTERN.test(botId) || botIds.includes(botId)) return null;
    botIds.push(botId);
  }
  return botIds;
}

type CreateInput = {
  title: string;
  maxAiMessages: number;
  botIds: string[];
  text: ValidText;
  idempotencyKey: string;
};

const createConversationBody = jsonBody<CreateConversationRequest, CreateInput, AppEnv>((body, c) => {
  const unknown = unknownField(body, ["title", "max_ai_messages", "participants", "message", "idempotency_key"]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const title = normalizeDisplayName(body.title);
  if (title === null) return apiError(c, 400, "invalid_name", invalidTitleMessage);
  const maxAiMessages = body.max_ai_messages ?? DEFAULT_MAX_AI_MESSAGES;
  if (
    typeof maxAiMessages !== "number" ||
    !Number.isInteger(maxAiMessages) ||
    maxAiMessages < 1 ||
    maxAiMessages > MAX_AI_MESSAGES_LIMIT
  ) {
    return apiError(c, 400, "invalid_limit", invalidLimitMessage);
  }
  const botIds = parseParticipants(body.participants);
  if (botIds === null) return apiError(c, 400, "invalid_participants", invalidParticipantsMessage);
  const text = validateMessageText(body.message);
  if (text === null) return apiError(c, 400, "invalid_text", invalidTextMessage);
  const key = body.idempotency_key;
  if (typeof key !== "string" || !MESSAGE_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return apiError(c, 400, "invalid_idempotency_key", invalidIdempotencyKeyMessage);
  }
  return { ok: true, value: { title, maxAiMessages, botIds, text, idempotencyKey: key } };
});

const postMessageBody = jsonBody<PostConversationMessageRequest, { text: ValidText; idempotencyKey: string }, AppEnv>(
  (body, c) => {
    const unknown = unknownField(body, ["text", "idempotency_key"]);
    if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
    const text = validateMessageText(body.text);
    if (text === null) return apiError(c, 400, "invalid_text", invalidTextMessage);
    const key = body.idempotency_key;
    if (typeof key !== "string" || !MESSAGE_IDEMPOTENCY_KEY_PATTERN.test(key)) {
      return apiError(c, 400, "invalid_idempotency_key", invalidIdempotencyKeyMessage);
    }
    return { ok: true, value: { text, idempotencyKey: key } };
  },
);

function messageDeps(c: AppContext): MessageDeps {
  return { d1: c.env.DB, db: c.get("db"), bucket: c.env.EVENT_DATA, queue: c.env.DELIVERY_QUEUE, now: clock.now() };
}

// A source that started the conversation is named by its current name ("" when it is not found). The
// bot that started it (start_conversation, MCP) is named by its participant: the bot is not read again.
function startedBy(
  row: ConversationRow,
  participants: ConversationParticipantRow[],
  startingSources: Map<string, string>,
): ConversationStartedBy {
  if (row.startedBySourceId !== null) {
    return { kind: "source", source_id: row.startedBySourceId, name: startingSources.get(row.startedBySourceId) ?? "" };
  }
  if (row.startedByBotId === null) return { kind: "user" };
  const name = participants.find((p) => p.botId === row.startedByBotId)?.name ?? "";
  return { kind: "bot", bot_id: row.startedByBotId, name };
}

// The names of the sources that started these conversations, read only when there are any.
function startingSourceNames(db: Db, rows: ConversationRow[]): Promise<Map<string, string>> {
  const ids = rows.flatMap((row) => (row.startedBySourceId === null ? [] : [row.startedBySourceId]));
  return ids.length === 0 ? Promise.resolve(new Map()) : sourceNames(db, ids);
}

function conversationFields(
  row: ConversationRow,
  participants: ConversationParticipantRow[],
  startingSources: Map<string, string>,
): Omit<Conversation, "participants"> {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    stop_reason: row.stopReason,
    max_ai_messages: row.maxAiMessages,
    ai_message_count: row.aiMessageCount,
    started_by: startedBy(row, participants, startingSources),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toApiConversation(
  row: ConversationRow,
  participants: ConversationParticipantRow[],
  startingSources: Map<string, string>,
): Conversation {
  return {
    ...conversationFields(row, participants, startingSources),
    participants: participants.map((p) => ({ name: p.name })),
  };
}

type ParticipantDestination = ConversationParticipant["destination"];

function toDestination(row: SubscriptionRow | null | undefined, now: number): ParticipantDestination {
  if (row === null || row === undefined) return null;
  return { kind: row.kind, name: row.name, callback_host: callbackHost(row.callbackUrl), status: statusOf(row, now) };
}

// The conversation with its participants: for a bot, its current name, MCP connection and destination; for a
// participant created before bots, its OAuth client ID and its subscription. OAUTH_PROVIDER is not used.
async function conversationDetail(c: AppContext, row: ConversationRow): Promise<ConversationDetail> {
  const db = c.get("db");
  const now = clock.now();
  const participants = await listConversationParticipants(db, row.id);
  const botIds = participants.flatMap((p) => (p.botId === null ? [] : [p.botId]));
  const [botRows, connections, subscriptions, names] = await Promise.all([
    workspaceBotsByIds(db, row.workspaceId, botIds),
    activeConnectionsByBot(db, row.workspaceId, botIds),
    workspaceSubscriptionsByIds(
      db,
      row.workspaceId,
      participants.flatMap((p) => (p.botId === null && p.subscriptionId !== null ? [p.subscriptionId] : [])),
    ),
    startingSourceNames(db, [row]),
  ]);
  const deliveries = await resolveBotDeliveries(db, row.workspaceId, [...botRows.values()], now, connections);
  return {
    ...conversationFields(row, participants, names),
    participants: participants.map((p): ConversationParticipant => {
      if (p.botId === null) {
        return {
          name: p.name,
          bot: null,
          connection_client_name: p.oauthClientId,
          destination: toDestination(p.subscriptionId === null ? null : subscriptions.get(p.subscriptionId), now),
        };
      }
      const bot = botRows.get(p.botId);
      const deleted = bot === undefined || bot.deletedAt !== null;
      return {
        name: p.name,
        bot: { id: p.botId, name: bot?.name ?? p.name, deleted, delivery_kind: bot?.deliveryKind ?? null },
        connection_client_name: deleted ? null : (connections.get(p.botId)?.clientName ?? null),
        destination: toDestination(deliveries.get(p.botId), now),
      };
    }),
  };
}

// The conversation of the workspace with this ID, read after a change.
async function detailById(c: AppContext, id: string): Promise<ConversationDetail | null> {
  const row = await findWorkspaceConversation(c.get("db"), c.get("workspace").id, id);
  return row ? conversationDetail(c, row) : null;
}

async function findConversation(c: AppContext): Promise<ConversationRow | null> {
  const id = c.req.param("id") ?? "";
  if (!CONVERSATION_ID_PATTERN.test(id)) return null;
  return (await findWorkspaceConversation(c.get("db"), c.get("workspace").id, id)) ?? null;
}

const conversationsApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", cursorQuery(CONVERSATION_ID_PATTERN), async (c) => {
    const { cursor } = c.req.valid("query");
    const db = c.get("db");
    const page = await listWorkspaceConversations(db, c.get("workspace").id, cursor);
    const [participants, names] = await Promise.all([
      participantsByConversation(
        db,
        page.conversations.map((row) => row.id),
      ),
      startingSourceNames(db, page.conversations),
    ]);
    const body: ConversationList = {
      conversations: page.conversations.map((row) => toApiConversation(row, participants.get(row.id) ?? [], names)),
      next_cursor: page.nextCursor,
    };
    return c.json(body, 200);
  })
  .post("/", createConversationBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const user = c.get("user");
    const workspaceId = c.get("workspace").id;
    const deps = messageDeps(c);

    // A retry returns the conversation created first, whatever the contents.
    const existing = await findExistingMessage(deps.d1, workspaceId, createIdempotencyKey(user.id, input.idempotencyKey));
    if (existing !== null) {
      const retried = await duplicateMessage(deps, existing, null);
      if (!retried.ok) return apiError(c, 503, "temporarily_unavailable", unavailableMessage);
      const detail = await detailById(c, retried.conversationId);
      if (!detail) throw new Error("conversation of a stored message not found");
      return c.json(detail, 200);
    }

    // The participants are bots of the workspace that are not deleted. A bot without a connection or a destination
    // may take part: it can be connected later.
    const botRows = await workspaceBotsByIds(db, workspaceId, input.botIds);
    const participants = input.botIds.flatMap((id) => {
      const bot = botRows.get(id);
      return bot === undefined || bot.deletedAt !== null ? [] : [bot];
    });
    if (participants.length !== input.botIds.length) {
      return apiError(c, 400, "invalid_participants", "Bot が見つからないか、削除されています。選び直してください");
    }
    // The first message goes to the destination of each bot now; a bot without one gets nothing.
    const deliveries = await resolveBotDeliveries(db, workspaceId, participants, deps.now);
    const recipients = [
      ...new Set(participants.flatMap((bot) => {
        const id = deliveries.get(bot.id)?.id;
        return id === undefined ? [] : [id];
      })),
    ];
    const result = await createConversation(deps, {
      workspaceId,
      user,
      title: input.title,
      maxAiMessages: input.maxAiMessages,
      participants: participants.map((bot) => ({ botId: bot.id, name: bot.name })),
      recipients,
      text: input.text,
      idempotencyKey: createIdempotencyKey(user.id, input.idempotencyKey),
    });
    if (!result.ok) return apiError(c, 503, "temporarily_unavailable", unavailableMessage);
    const detail = await detailById(c, result.conversationId);
    if (!detail) throw new Error("created conversation not found");
    return c.json(detail, result.duplicate ? 200 : 201);
  })
  .get("/:id", async (c) => {
    const conversation = await findConversation(c);
    if (!conversation) return apiError(c, 404, "not_found", conversationNotFound);
    return c.json(await conversationDetail(c, conversation), 200);
  })
  .get("/:id/messages", cursorQuery(EVENT_ID_PATTERN), async (c) => {
    const { cursor } = c.req.valid("query");
    const conversation = await findConversation(c);
    if (!conversation) return apiError(c, 404, "not_found", conversationNotFound);
    const page = await listConversationMessages(c.get("db"), {
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      before: cursor,
      limit: CONVERSATION_PAGE_SIZE,
    });
    // Messages are at most 64 KiB, so the whole text is returned.
    const texts = await Promise.all(page.messages.map((message) => readMessageText(c.env.EVENT_DATA, message.body, null)));
    const body: ConversationMessageList = {
      messages: page.messages.map((message, index) => {
        const kind = senderKind(message.labels.sender_kind);
        return {
          event_id: message.eventId,
          sender: message.labels.sender ?? "",
          sender_kind: kind,
          is_user: kind === "user",
          text: texts[index]?.text ?? "",
          created_at: message.receivedAt,
        };
      }),
      older_cursor: page.olderCursor,
    };
    return c.json(body, 200);
  })
  .post("/:id/messages", postMessageBody, async (c) => {
    const input = c.req.valid("json");
    const conversation = await findConversation(c);
    if (!conversation) return apiError(c, 404, "not_found", conversationNotFound);
    const participants = await listConversationParticipants(c.get("db"), conversation.id);
    const result = await postUserMessage(messageDeps(c), {
      conversation,
      participants,
      user: c.get("user"),
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      switch (result.code) {
        case "conversation_stopped":
          return apiError(c, 409, "conversation_stopped", "会話は停止しています");
        case "idempotency_conflict":
          return apiError(c, 409, "idempotency_conflict", "同じ idempotency_key で別の内容が送られました");
        case "invalid_text":
          return apiError(c, 400, "invalid_text", invalidTextMessage);
        case "not_participant":
        case "temporarily_unavailable":
          return apiError(c, 503, "temporarily_unavailable", unavailableMessage);
      }
    }
    const body: PostedConversationMessage = {
      event_id: result.eventId,
      conversation: await conversationDetail(c, result.conversation),
    };
    return c.json(body, result.duplicate ? 200 : 201);
  })
  .post("/:id/stop", async (c) => {
    const conversation = await findConversation(c);
    if (!conversation) return apiError(c, 404, "not_found", conversationNotFound);
    // Stopping a stopped conversation changes nothing.
    if (conversation.status === "open") {
      await stopConversation(c.env.DB, conversation.workspaceId, conversation.id, clock.now());
    }
    const detail = await detailById(c, conversation.id);
    if (!detail) return apiError(c, 404, "not_found", conversationNotFound);
    return c.json(detail, 200);
  });

export default conversationsApi;
