import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
  Conversation,
  ConversationDetail,
  ConversationList,
  ConversationMessageList,
  ConversationParticipant,
  CreateConversationRequest,
  McpConnectionList,
  PostConversationMessageRequest,
  PostedConversationMessage,
} from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import { isJsonObject } from "../auth/validate";
import { clock } from "../clock";
import {
  CONVERSATION_PAGE_SIZE,
  countOpenConversations,
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
  MAX_OPEN_CONVERSATIONS_PER_WORKSPACE,
  MAX_PARTICIPANTS,
  MESSAGE_IDEMPOTENCY_KEY_PATTERN,
  postUserMessage,
  readMessageText,
  validateMessageText,
  type MessageDeps,
  type NewParticipant,
  type ValidText,
} from "../conversations/service";
import type { ConversationParticipantRow, ConversationRow } from "../db/schema";
import { callbackHost } from "../deliveries/queries";
import type { AppEnv } from "../env";
import { CONVERSATION_ID_PATTERN, EVENT_ID_PATTERN, SUBSCRIPTION_ID_PATTERN } from "../ids";
import { codePointLength } from "../intake/validation";
import { clientName, listUserClients } from "../mcp/grants";
import { isActiveSubscription } from "../subscriptions/queries";
import { jsonBody } from "./api";
import { normalizeDisplayName, unknownField } from "./sources";
import { statusOf } from "./subscriptions";
import { requirePersonalWorkspace } from "./workspace";

const OAUTH_CLIENT_ID_MAX_LENGTH = 2048;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

const conversationNotFound = "会話が見つかりません";
const invalidTitleMessage = "件名は制御文字を含まない 1〜64 文字にしてください";
const invalidLimitMessage = "AI の発言の上限は 1〜100 の整数にしてください";
const invalidParticipantsMessage =
  "参加者は 1〜5 人にしてください。表示名（制御文字を含まない 1〜64 文字）・MCP 接続・通知先は重複できません";
const invalidTextMessage =
  "本文は空白だけでない 1〜65,536 バイトのテキストにしてください（改行とタブ以外の制御文字は使えません）";
const invalidIdempotencyKeyMessage = "idempotency_key が正しくありません";
const unavailableMessage = "一時的に受け付けられません。もう一度送ってください";
const oauthUnavailableMessage = "この接続先では MCP 接続を確認できません";

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

// The participants of a new conversation, or null if invalid: 1 to 5, with valid names, OAuth client IDs and
// subscription IDs, none of them given twice. Whether the clients and the subscriptions are the user's is checked
// later.
function parseParticipants(value: unknown): NewParticipant[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTICIPANTS) return null;
  const participants: NewParticipant[] = [];
  const names = new Set<string>();
  const clients = new Set<string>();
  const subscriptionIds = new Set<string>();
  for (const item of value) {
    if (!isJsonObject(item) || unknownField(item, ["name", "oauth_client_id", "subscription_id"]) !== null) return null;
    const name = normalizeDisplayName(item.name);
    const { oauth_client_id: oauthClientId, subscription_id: subscriptionId } = item;
    if (name === null) return null;
    if (
      typeof oauthClientId !== "string" ||
      oauthClientId === "" ||
      codePointLength(oauthClientId) > OAUTH_CLIENT_ID_MAX_LENGTH ||
      CONTROL.test(oauthClientId)
    ) {
      return null;
    }
    if (typeof subscriptionId !== "string" || !SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) return null;
    if (names.has(name) || clients.has(oauthClientId) || subscriptionIds.has(subscriptionId)) return null;
    names.add(name);
    clients.add(oauthClientId);
    subscriptionIds.add(subscriptionId);
    participants.push({ name, oauthClientId, subscriptionId });
  }
  return participants;
}

type CreateInput = {
  title: string;
  maxAiMessages: number;
  participants: NewParticipant[];
  text: ValidText;
  idempotencyKey: string;
};

const createConversationBody = jsonBody<CreateConversationRequest, CreateInput>((body, c) => {
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
  const participants = parseParticipants(body.participants);
  if (participants === null) return apiError(c, 400, "invalid_participants", invalidParticipantsMessage);
  const text = validateMessageText(body.message);
  if (text === null) return apiError(c, 400, "invalid_text", invalidTextMessage);
  const key = body.idempotency_key;
  if (typeof key !== "string" || !MESSAGE_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return apiError(c, 400, "invalid_idempotency_key", invalidIdempotencyKeyMessage);
  }
  return { ok: true, value: { title, maxAiMessages, participants, text, idempotencyKey: key } };
});

const postMessageBody = jsonBody<PostConversationMessageRequest, { text: ValidText; idempotencyKey: string }>(
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

function conversationFields(row: ConversationRow): Omit<Conversation, "participants"> {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    stop_reason: row.stopReason,
    max_ai_messages: row.maxAiMessages,
    ai_message_count: row.aiMessageCount,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toApiConversation(row: ConversationRow, participants: ConversationParticipantRow[]): Conversation {
  return { ...conversationFields(row), participants: participants.map((p) => ({ name: p.name })) };
}

// The conversation with its participants, their destinations and the names of their MCP connections. Without
// OAUTH_PROVIDER (src/index.ts), the connections are named by their client IDs.
async function conversationDetail(c: AppContext, row: ConversationRow): Promise<ConversationDetail> {
  const db = c.get("db");
  const participants = await listConversationParticipants(db, row.id);
  const subscriptions = await workspaceSubscriptionsByIds(
    db,
    row.workspaceId,
    participants.map((p) => p.subscriptionId),
  );
  const oauth = c.env.OAUTH_PROVIDER;
  const clientIds = [...new Set(participants.map((p) => p.oauthClientId))];
  const names = new Map(
    await Promise.all(
      clientIds.map(async (id) => [id, oauth ? await clientName(oauth, id) : id] as const),
    ),
  );
  const now = clock.now();
  return {
    ...conversationFields(row),
    participants: participants.map((p): ConversationParticipant => {
      const subscription = subscriptions.get(p.subscriptionId);
      return {
        name: p.name,
        oauth_client_id: p.oauthClientId,
        oauth_client_name: names.get(p.oauthClientId) ?? p.oauthClientId,
        destination_kind: subscription?.kind ?? null,
        destination_name: subscription?.name ?? null,
        callback_host: subscription === undefined ? null : callbackHost(subscription.callbackUrl),
        destination_status: subscription === undefined ? null : statusOf(subscription, now),
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
    const participants = await participantsByConversation(
      db,
      page.conversations.map((row) => row.id),
    );
    const body: ConversationList = {
      conversations: page.conversations.map((row) => toApiConversation(row, participants.get(row.id) ?? [])),
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

    // The MCP connections are the OAuth clients of the user's grants.
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) return apiError(c, 503, "temporarily_unavailable", oauthUnavailableMessage);
    const clients = new Set((await listUserClients(oauth, user.id)).map((client) => client.clientId));
    if (!input.participants.every((p) => clients.has(p.oauthClientId))) {
      return apiError(c, 400, "invalid_participants", "MCP 接続が見つかりません。選び直してください");
    }
    // The destinations must be active subscriptions of the workspace now.
    const subscriptions = await workspaceSubscriptionsByIds(
      db,
      workspaceId,
      input.participants.map((p) => p.subscriptionId),
    );
    const now = deps.now;
    if (
      !input.participants.every((p) => {
        const subscription = subscriptions.get(p.subscriptionId);
        return subscription !== undefined && isActiveSubscription(subscription, now);
      })
    ) {
      return apiError(c, 400, "invalid_participants", "通知先が見つからないか、終了しています。選び直してください");
    }
    // A loose limit: concurrent requests may go slightly over it.
    if ((await countOpenConversations(db, workspaceId)) >= MAX_OPEN_CONVERSATIONS_PER_WORKSPACE) {
      return apiError(c, 409, "limit_exceeded", "進行中の会話は 20 件までです");
    }

    const result = await createConversation(deps, {
      workspaceId,
      user,
      title: input.title,
      maxAiMessages: input.maxAiMessages,
      participants: input.participants,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
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
        const isUser = message.labels.sender_kind === "user";
        return {
          event_id: message.eventId,
          sender: message.labels.sender ?? "",
          sender_kind: isUser ? "user" : "ai",
          is_user: isUser,
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

// The MCP connections of the signed-in user, for the participants of a new conversation.
export const mcpConnectionsApi = new Hono<AppEnv>().use("*", requireUser).get("/", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) return apiError(c, 503, "temporarily_unavailable", oauthUnavailableMessage);
  const clients = await listUserClients(oauth, c.get("user").id);
  const body: McpConnectionList = {
    connections: clients.map((client) => ({ client_id: client.clientId, client_name: client.clientName })),
  };
  return c.json(body, 200);
});

export default conversationsApi;
