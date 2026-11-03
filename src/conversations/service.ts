// The messages of conversations: validating the text, storing a message as an event (R2, then one D1 batch), and
// delivering it to the destinations of the other participants.
//
// A message is stored the way the shared intake stores an event (src/intake/service.ts), with the same handling of
// a failed batch, but with its own statements: the deliveries go to the participants instead of the matching
// subscriptions, and each one is created only while the conversation may still notify (open, or stopped by its limit
// so that the last message is delivered).

import { describeError } from "../auth/middleware";
import { canonicalJson } from "../canonical-json";
import type { Db } from "../db/client";
import type { ConversationParticipantRow, ConversationRow, UserRow } from "../db/schema";
import { enqueuePendingDeliveries, type DeliveryMessage } from "../deliveries/enqueue";
import {
  newConversationId,
  newDataRef,
  newDeliveryId,
  newEventId,
  newParticipantId,
  newUlid,
  sha256Hex,
} from "../ids";
import { eventDataKey } from "../intake/storage";
import { codePointLength } from "../intake/validation";
import { sliceUtf8 } from "../mcp/text";
import {
  findConversationSourceId,
  findOrCreateConversationSource,
  findWorkspaceConversation,
  messageRecipients,
} from "./queries";

export const MESSAGE_TYPE = "conversation.message";
export const MESSAGE_MAX_BYTES = 65_536;
const MESSAGE_NAME = "message.txt";
const MESSAGE_CONTENT_TYPE = "text/plain; charset=utf-8";
const SUMMARY_MAX_LENGTH = 2000;
const SENDER_MAX_LENGTH = 64;
const UTF8_BOUNDARY_MARGIN = 6;
export const DEFAULT_MAX_AI_MESSAGES = 20;
export const MAX_AI_MESSAGES_LIMIT = 100;
export const MAX_PARTICIPANTS = 5;
export const MAX_OPEN_CONVERSATIONS_PER_WORKSPACE = 20;
// The idempotency keys given by the AIs and the screen.
export const MESSAGE_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

// Cc except \n, \r and \t.
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
// A surrogate that is not part of a pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type SenderKind = "user" | "ai";

export type Sender = { kind: SenderKind; id: string; name: string };

export type ValidText = { text: string; bytes: Uint8Array };

// The text of a message, stored as it is (not trimmed), or null if invalid: 1 to 65,536 bytes of UTF-8, not only
// white space, without control characters other than newlines and tabs, and without lone surrogates.
export function validateMessageText(value: unknown): ValidText | null {
  if (typeof value !== "string") return null;
  if (value.trim() === "" || CONTROL_EXCEPT_NEWLINE_TAB.test(value) || LONE_SURROGATE.test(value)) return null;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < 1 || bytes.byteLength > MESSAGE_MAX_BYTES) return null;
  return { text: value, bytes };
}

// The sender name of the user: the name, or the email address, without control characters and cut to 64 characters.
export function userSenderName(user: Pick<UserRow, "name" | "email">): string {
  const clean = (value: string) => Array.from(value.replace(CONTROL, "").trim()).slice(0, SENDER_MAX_LENGTH).join("");
  const name = user.name === null ? "" : clean(user.name);
  return name === "" ? clean(user.email) : name;
}

// "<sender>: <text>" with every run of white space as one space, cut to 2,000 characters with "…".
export function messageSummary(sender: string, text: string): string {
  const summary = `${sender}: ${text.replace(/\s+/g, " ").trim()}`;
  if (codePointLength(summary) <= SUMMARY_MAX_LENGTH) return summary;
  return `${Array.from(summary)
    .slice(0, SUMMARY_MAX_LENGTH - 1)
    .join("")}…`;
}

export function messageLabels(conversationId: string, sender: Sender): Record<string, string> {
  return { conversation_id: conversationId, sender: sender.name, sender_kind: sender.kind, sender_id: sender.id };
}

// Tells a retry of the same message from a different message with the same idempotency key.
export function messageRequestHash(conversationId: string, sender: Sender, textSha256: string): Promise<string> {
  return sha256Hex(
    canonicalJson({
      conversation_id: conversationId,
      sender_kind: sender.kind,
      sender_id: sender.id,
      text_sha256: textSha256,
    }),
  );
}

export function remainingAiMessages(conversation: Pick<ConversationRow, "maxAiMessages" | "aiMessageCount">): number {
  return Math.max(0, conversation.maxAiMessages - conversation.aiMessageCount);
}

export type MessageDeps = {
  d1: D1Database;
  db: Db;
  bucket: R2Bucket;
  queue: Queue<DeliveryMessage>;
  now: number;
};

export type StoreErrorCode = "idempotency_conflict" | "temporarily_unavailable";

export type StoreResult =
  | { ok: true; eventId: string; conversationId: string; duplicate: boolean }
  | { ok: false; code: StoreErrorCode };

type ExistingEvent = { id: string; request_hash: string; conversation_id: string | null };

function findEvent(d1: D1Database, sourceId: string, idempotencyKey: string): Promise<ExistingEvent | null> {
  return d1
    .prepare("SELECT id, request_hash, conversation_id FROM events WHERE source_id = ? AND idempotency_key = ?")
    .bind(sourceId, idempotencyKey)
    .first<ExistingEvent>();
}

// The existing message with this key in the workspace, or null.
export async function findExistingMessage(
  d1: D1Database,
  workspaceId: string,
  idempotencyKey: string,
): Promise<ExistingEvent | null> {
  const sourceId = await findConversationSourceId(d1, workspaceId);
  if (sourceId === null) return null;
  return findEvent(d1, sourceId, idempotencyKey);
}

// A retry of an existing message. compare is false for the creation of a conversation, whose retries return the
// conversation without comparing the contents. The deliveries that may have missed the queue are queued again.
export async function duplicateMessage(
  deps: Pick<MessageDeps, "d1" | "queue">,
  existing: ExistingEvent,
  expected: { conversationId: string | null; hash: string } | null,
): Promise<StoreResult> {
  if (existing.conversation_id === null) return { ok: false, code: "idempotency_conflict" };
  if (
    expected !== null &&
    (existing.conversation_id !== expected.conversationId || existing.request_hash !== expected.hash)
  ) {
    return { ok: false, code: "idempotency_conflict" };
  }
  if (!(await enqueuePendingDeliveries({ db: deps.d1, queue: deps.queue }, existing.id))) {
    return { ok: false, code: "temporarily_unavailable" };
  }
  return { ok: true, eventId: existing.id, conversationId: existing.conversation_id, duplicate: true };
}

async function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch (error) {
    console.error("conversations: deleting a stored object failed", describeError(error));
  }
}

export type StoreParams = {
  workspaceId: string;
  conversationId: string;
  sender: Sender;
  text: ValidText;
  idempotencyKey: string;
  // The subscriptions to deliver to, each once.
  recipients: string[];
  // Run in the same batch before the event (the creation of the conversation) and after it (updated_at).
  before?: D1PreparedStatement[];
  after?: D1PreparedStatement[];
  // false for the creation of a conversation: a retry returns the existing one without comparing the contents.
  compareOnRetry: boolean;
};

// Stores a message and queues its deliveries: R2, then the event, its body and the deliveries in one D1 batch, then
// the queue. The steps and the handling of a failed batch are those of the shared intake.
export async function storeMessage(deps: MessageDeps, params: StoreParams): Promise<StoreResult> {
  const { d1, bucket, now } = deps;
  const { workspaceId, conversationId, sender, text, idempotencyKey, recipients } = params;
  const sourceId = await findOrCreateConversationSource(d1, workspaceId, now);
  const textSha256 = await sha256Hex(text.bytes);
  const hash = await messageRequestHash(conversationId, sender, textSha256);
  const expected = params.compareOnRetry ? { conversationId, hash } : null;

  const eventId = newEventId(now);
  const dataRef = newDataRef(now);
  const key = eventDataKey(workspaceId, eventId, dataRef);

  // Objects stored here are orphaned if the Worker stops before D1 is written; the daily cron deletes them.
  try {
    await bucket.put(key, text.bytes, { httpMetadata: { contentType: MESSAGE_CONTENT_TYPE } });
  } catch (error) {
    console.error("conversations: storing a message in R2 failed", { conversationId, ...describeError(error) });
    return { ok: false, code: "temporarily_unavailable" };
  }

  const statements = [
    ...(params.before ?? []),
    d1
      .prepare(
        `INSERT INTO events (id, workspace_id, source_id, idempotency_key, request_hash, type, summary, labels, occurred_at, received_at, conversation_id)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)`,
      )
      .bind(
        eventId,
        workspaceId,
        sourceId,
        idempotencyKey,
        hash,
        MESSAGE_TYPE,
        messageSummary(sender.name, text.text),
        JSON.stringify(messageLabels(conversationId, sender)),
        now,
        conversationId,
      ),
    d1
      .prepare(
        `INSERT INTO event_data (id, event_id, workspace_id, role, name, content_type, size, sha256, r2_key, position)
        VALUES (?, ?, ?, 'body', ?, ?, ?, ?, ?, 0)`,
      )
      .bind(dataRef, eventId, workspaceId, MESSAGE_NAME, MESSAGE_CONTENT_TYPE, text.bytes.byteLength, textSha256, key),
    // Created only while the conversation may notify: a stop that commits first leaves the message without them.
    ...[...new Set(recipients)].map((subscriptionId) =>
      d1
        .prepare(
          `INSERT INTO deliveries (id, event_id, subscription_id, workspace_id, status, attempts, created_at, updated_at)
          SELECT ?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5
          WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?6 AND (status = 'open' OR stop_reason = 'limit'))`,
        )
        .bind(newDeliveryId(now), eventId, subscriptionId, workspaceId, now, conversationId),
    ),
    ...(params.after ?? []),
  ];
  try {
    await d1.batch(statements);
  } catch (error) {
    console.error("conversations: writing a message to D1 failed", { conversationId, ...describeError(error) });
    // D1 may have committed even though it threw, so check before touching R2.
    let found: ExistingEvent | null;
    try {
      found = await findEvent(d1, sourceId, idempotencyKey);
    } catch (lookupError) {
      console.error("conversations: looking up a message after a failed write failed", {
        conversationId,
        ...describeError(lookupError),
      });
      // Unknown outcome: keep R2.
      return { ok: false, code: "temporarily_unavailable" };
    }
    // The write may still commit later, so R2 is kept; an orphan is deleted by the daily cron.
    if (found === null) return { ok: false, code: "temporarily_unavailable" };
    if (found.id !== eventId) {
      // Another request with the same key wrote first; this request's object is not referenced.
      await deleteObject(bucket, key);
      return duplicateMessage(deps, found, expected);
    }
    // Our write committed.
  }

  // Queued before success is answered. If this fails the message is stored; a retry with the same key queues them.
  if (!(await enqueuePendingDeliveries({ db: d1, queue: deps.queue }, eventId))) {
    return { ok: false, code: "temporarily_unavailable" };
  }
  return { ok: true, eventId, conversationId, duplicate: false };
}

export type PostErrorCode =
  | "invalid_text"
  | "not_participant"
  | "conversation_stopped"
  | "idempotency_conflict"
  | "temporarily_unavailable";

// unassigned: the MCP connection is not assigned to a bot (or a legacy connection, or its bot is deleted).
// not_in_conversation: the bot of the connection is not a participant.
export type NotParticipantReason = "unassigned" | "not_in_conversation";

export type PostResult =
  | { ok: true; eventId: string; duplicate: boolean; conversation: ConversationRow }
  | { ok: false; code: Exclude<PostErrorCode, "not_participant"> }
  | { ok: false; code: "not_participant"; reason: NotParticipantReason; botName: string | null };

// The bot that an MCP connection is assigned to, when it is not deleted.
export type ConnectionBot = { id: string; name: string };

// Whether a participant is the AI of an MCP request: a bot by the bot of the connection, a participant created before
// bots by its OAuth client. Never by a name in the text or the arguments.
export function isRequestParticipant(
  participant: ConversationParticipantRow,
  connectionBot: ConnectionBot | null,
  clientId: string | null,
): boolean {
  if (participant.botId !== null) return connectionBot !== null && participant.botId === connectionBot.id;
  return clientId !== null && participant.oauthClientId === clientId;
}

type ReservedCounts = { status: ConversationRow["status"]; ai_message_count: number; max_ai_messages: number };

// Takes one AI message out of the limit of an open conversation. The message that reaches the limit stops the
// conversation in the same statement, and is still stored and delivered. null if the conversation is not open or
// has no room left (two AIs sending the last message at the same time: one of them wins).
async function reserveAiMessage(
  d1: D1Database,
  workspaceId: string,
  conversationId: string,
  now: number,
): Promise<ReservedCounts | null> {
  return d1
    .prepare(
      `UPDATE conversations SET ai_message_count = ai_message_count + 1,
        status = CASE WHEN ai_message_count + 1 >= max_ai_messages THEN 'stopped' ELSE status END,
        stop_reason = CASE WHEN ai_message_count + 1 >= max_ai_messages THEN 'limit' ELSE stop_reason END,
        stopped_at = CASE WHEN ai_message_count + 1 >= max_ai_messages THEN ?1 ELSE stopped_at END,
        updated_at = ?1
      WHERE id = ?2 AND workspace_id = ?3 AND status = 'open' AND ai_message_count < max_ai_messages
      RETURNING status, ai_message_count, max_ai_messages`,
    )
    .bind(now, conversationId, workspaceId)
    .first<ReservedCounts>();
}

// The conversation as it is now, or the given one if it is gone.
async function reload(deps: MessageDeps, conversation: ConversationRow): Promise<ConversationRow> {
  return (await findWorkspaceConversation(deps.db, conversation.workspaceId, conversation.id)) ?? conversation;
}

// A message of an AI, matched with the participants by the MCP connection of the request (isRequestParticipant). A retry with the same idempotency key returns the stored message whatever the state of
// the conversation, without taking another message out of the limit. A failure after the reservation (R2 or D1)
// does not give the message back: the conversation only gets one message less, which is the safe side.
export async function postAiMessage(
  deps: MessageDeps,
  params: {
    conversation: ConversationRow;
    participants: ConversationParticipantRow[];
    connectionBot: ConnectionBot | null;
    clientId: string | null;
    text: unknown;
    idempotencyKey?: string;
  },
): Promise<PostResult> {
  const { conversation, participants, connectionBot, clientId } = params;
  // 1. The text.
  const text = validateMessageText(params.text);
  if (text === null) return { ok: false, code: "invalid_text" };
  // 2. The participant.
  const participant = participants.find((p) => isRequestParticipant(p, connectionBot, clientId));
  if (participant === undefined) {
    return {
      ok: false,
      code: "not_participant",
      reason: connectionBot === null ? "unassigned" : "not_in_conversation",
      botName: connectionBot?.name ?? null,
    };
  }
  const sender: Sender = { kind: "ai", id: participant.id, name: participant.name };

  // 3. A retry.
  let idempotencyKey: string;
  if (params.idempotencyKey !== undefined) {
    idempotencyKey = `conv:${conversation.id}:${participant.id}:${params.idempotencyKey}`;
    const existing = await findExistingMessage(deps.d1, conversation.workspaceId, idempotencyKey);
    if (existing !== null) {
      const hash = await messageRequestHash(conversation.id, sender, await sha256Hex(text.bytes));
      const result = await duplicateMessage(deps, existing, { conversationId: conversation.id, hash });
      if (!result.ok) return result;
      return { ok: true, eventId: result.eventId, duplicate: true, conversation: await reload(deps, conversation) };
    }
  } else {
    idempotencyKey = `conv:${newUlid(deps.now)}`;
  }

  // 4. Open. 5. The limit.
  if (conversation.status !== "open") return { ok: false, code: "conversation_stopped" };
  const reserved = await reserveAiMessage(deps.d1, conversation.workspaceId, conversation.id, deps.now);
  if (reserved === null) return { ok: false, code: "conversation_stopped" };

  // 6. Store and deliver.
  const recipients = await messageRecipients(deps.db, conversation.workspaceId, participants, participant.id, deps.now);
  const result = await storeMessage(deps, {
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    sender,
    text,
    idempotencyKey,
    recipients,
    compareOnRetry: true,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    eventId: result.eventId,
    duplicate: result.duplicate,
    conversation: {
      ...conversation,
      status: reserved.status,
      aiMessageCount: reserved.ai_message_count,
      maxAiMessages: reserved.max_ai_messages,
    },
  };
}

// A message of the user from the management screen, delivered to every AI. Not counted in the limit. idempotencyKey
// is generated by the screen for each message and is required.
export async function postUserMessage(
  deps: MessageDeps,
  params: {
    conversation: ConversationRow;
    participants: ConversationParticipantRow[];
    user: UserRow;
    text: ValidText;
    idempotencyKey: string;
  },
): Promise<PostResult> {
  const { conversation, participants, user, text } = params;
  const sender: Sender = { kind: "user", id: user.id, name: userSenderName(user) };
  const idempotencyKey = `conv-user:${conversation.id}:${user.id}:${params.idempotencyKey}`;

  const existing = await findExistingMessage(deps.d1, conversation.workspaceId, idempotencyKey);
  if (existing !== null) {
    const hash = await messageRequestHash(conversation.id, sender, await sha256Hex(text.bytes));
    const result = await duplicateMessage(deps, existing, { conversationId: conversation.id, hash });
    if (!result.ok) return result;
    return { ok: true, eventId: result.eventId, duplicate: true, conversation: await reload(deps, conversation) };
  }

  if (conversation.status !== "open") return { ok: false, code: "conversation_stopped" };
  const recipients = await messageRecipients(deps.db, conversation.workspaceId, participants, null, deps.now);
  const result = await storeMessage(deps, {
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    sender,
    text,
    idempotencyKey,
    recipients,
    after: [
      deps.d1
        .prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3")
        .bind(deps.now, conversation.id, conversation.workspaceId),
    ],
    compareOnRetry: true,
  });
  if (!result.ok) return result;
  return { ok: true, eventId: result.eventId, duplicate: result.duplicate, conversation: await reload(deps, conversation) };
}

// A bot as a participant: its name is copied when the conversation is created.
export type NewParticipant = { botId: string; name: string };

// Creates a conversation with its participants and stores the first message of the user, delivered to every AI, in
// one D1 batch. The caller checks the input, the limit and a retry first. A retry that races with this one returns
// the conversation of the message stored first (conversationId of the result).
export async function createConversation(
  deps: MessageDeps,
  params: {
    workspaceId: string;
    user: UserRow;
    title: string;
    maxAiMessages: number;
    participants: NewParticipant[];
    // The destinations of the bots now (resolveBotDeliveries), each once. May be empty: the message is stored anyway.
    recipients: string[];
    text: ValidText;
    idempotencyKey: string;
  },
): Promise<StoreResult> {
  const { d1, now } = deps;
  const { workspaceId, user } = params;
  const conversationId = newConversationId(now);
  return storeMessage(deps, {
    workspaceId,
    conversationId,
    sender: { kind: "user", id: user.id, name: userSenderName(user) },
    text: params.text,
    idempotencyKey: createIdempotencyKey(user.id, params.idempotencyKey),
    recipients: params.recipients,
    before: [
      d1
        .prepare(
          `INSERT INTO conversations (id, workspace_id, title, status, stop_reason, max_ai_messages, ai_message_count,
            created_by_user_id, created_at, updated_at, stopped_at)
          VALUES (?1, ?2, ?3, 'open', NULL, ?4, 0, ?5, ?6, ?6, NULL)`,
        )
        .bind(conversationId, workspaceId, params.title, params.maxAiMessages, user.id, now),
      ...params.participants.map((p) =>
        d1
          .prepare(
            `INSERT INTO conversation_participants (id, conversation_id, workspace_id, name, oauth_client_id, subscription_id, bot_id, created_at)
            VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
          )
          .bind(newParticipantId(now), conversationId, workspaceId, p.name, p.botId, now),
      ),
    ],
    compareOnRetry: false,
  });
}

// The idempotency key of the first message of a conversation created by the user.
export function createIdempotencyKey(userId: string, key: string): string {
  return `conv-create:${userId}:${key}`;
}

// Reads the body of a message as UTF-8 text, up to maxBytes moved back to a character boundary (null: all of it).
// A missing object is logged and read as empty text.
export async function readMessageText(
  bucket: R2Bucket,
  body: { r2Key: string; size: number } | null,
  maxBytes: number | null,
): Promise<{ text: string; truncated: boolean }> {
  if (body === null || body.size === 0) return { text: "", truncated: false };
  const limit = maxBytes ?? body.size;
  // Up to 6 bytes more, as read_data reads, for sliceUtf8 to find the end of the last character.
  const object = await bucket.get(body.r2Key, {
    range: { offset: 0, length: Math.min(limit + UTF8_BOUNDARY_MARGIN, body.size) },
  });
  if (object === null) {
    console.error("conversations: a message body was not found", { r2Key: body.r2Key });
    return { text: "", truncated: false };
  }
  const slice = sliceUtf8(new Uint8Array(await object.arrayBuffer()), 0, limit, body.size);
  return { text: slice.text, truncated: slice.nextOffset !== null };
}
