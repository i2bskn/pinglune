// Starting a conversation from a source (POST /ingest/v1/conversations, Intake.startConversation): the validation of
// the input and the steps after it, shared by the HTTP and RPC entry points. The source is the one of the API key or
// of props, never one named in the input. The checks of the limits and the creation are those of start_conversation
// (src/conversations/start.ts).

import type { IngestConversationResponse } from "../api/types";
import { findUserById } from "../auth/users";
import { findWorkspaceConversation, listConversationParticipants } from "../conversations/queries";
import {
  duplicateMessage,
  findExistingMessage,
  MAX_PARTICIPANTS,
  validateMessageText,
  type MessageDeps,
  type ValidText,
} from "../conversations/service";
import { startConversation } from "../conversations/start";
import type { ConversationRow } from "../db/schema";
import { normalizeDisplayName } from "../routes/sources";
import { findSourceById } from "../sources/queries";
import { findWorkspaceById } from "../workspaces/queries";
import { codePointLength, IDEMPOTENCY_KEY_PATTERN, intakeError, type IntakeError } from "./validation";

const CONVERSATION_FIELDS = new Set(["title", "participants", "message", "max_ai_messages", "idempotency_key"]);
// A source does not take part: every participant is an invited bot.
const MAX_INVITED_BOTS = MAX_PARTICIPANTS;
const PARTICIPANT_NAME_MAX_LENGTH = 64;

const idempotencyConflictMessage = "同じ idempotency_key で会話ではないイベントがすでにあります";

export type ConversationInput = {
  title: string;
  // Trimmed, 1 to 5, none given twice.
  names: string[];
  text: ValidText;
  // An integer, or undefined for the limit of the source.
  maxAiMessages: number | undefined;
  idempotencyKey: string;
};

type Parsed = { ok: true; value: ConversationInput } | { ok: false; error: IntakeError };

function fail(code: Parameters<typeof intakeError>[0], fields?: Record<string, string>): Parsed {
  return { ok: false, error: intakeError(code, fields) };
}

// The names of the bots to invite, trimmed, or null if invalid: an array of 1 to 5 strings, none empty after
// trimming, none over 64 characters, none given twice. Whether they are bots of the workspace is checked later.
function parseNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 1 || value.length > MAX_INVITED_BOTS) return null;
  const names: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string") return null;
    const name = item.trim();
    if (name === "" || codePointLength(name) > PARTICIPANT_NAME_MAX_LENGTH || names.includes(name)) return null;
    names.push(name);
  }
  return names;
}

// Checks an input object in this order and returns the first error: unknown fields, title, message, participants,
// max_ai_messages (an integer; its range is checked with the source), idempotency_key. null is the same as leaving
// out max_ai_messages, and an error for the other fields. Whether the input is an object is checked by the caller
// (invalid_json for HTTP, invalid_input for RPC).
export function parseConversationInput(input: Record<string, unknown>): Parsed {
  for (const key of Object.keys(input)) {
    if (!CONVERSATION_FIELDS.has(key)) return fail("unknown_field", { [key]: "未知の項目です" });
  }
  const title = normalizeDisplayName(input.title);
  if (title === null) return fail("invalid_title");
  const text = validateMessageText(input.message);
  if (text === null) return fail("invalid_text");
  const names = parseNames(input.participants);
  if (names === null) return fail("invalid_participants");
  const max = input.max_ai_messages;
  if (max !== undefined && max !== null && (typeof max !== "number" || !Number.isInteger(max))) {
    return fail("invalid_limit");
  }
  const key = input.idempotency_key;
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) return fail("invalid_idempotency_key");
  return {
    ok: true,
    value: { title, names, text, maxAiMessages: max ?? undefined, idempotencyKey: key },
  };
}

export type ConversationStartOutcome =
  | { ok: true; status: 200 | 201; body: IngestConversationResponse }
  | { ok: false; error: IntakeError };

function withMessage(error: IntakeError, message: string): IntakeError {
  return { ...error, message };
}

// The conversation as the entry points return it, read again from D1. notified is by bot ID (null: unknown, for a
// retry).
async function startedConversation(
  deps: MessageDeps,
  conversation: ConversationRow,
  duplicate: boolean,
  notified: Map<string, boolean> | null,
): Promise<ConversationStartOutcome> {
  const participants = await listConversationParticipants(deps.db, conversation.id);
  return {
    ok: true,
    status: duplicate ? 200 : 201,
    body: {
      conversation_id: conversation.id,
      title: conversation.title,
      status: conversation.status,
      max_ai_messages: conversation.maxAiMessages,
      ai_message_count: conversation.aiMessageCount,
      participants: participants.map((p) => ({
        name: p.name,
        notified: notified === null ? null : p.botId !== null && (notified.get(p.botId) ?? false),
      })),
      duplicate,
    },
  };
}

// The steps after the validation of the input: a retry, the source read again (allowed to start conversations), the
// limits and the invited bots, and the creation. deps.now is taken by the caller before this. A missing owner of
// the workspace throws: the caller answers temporarily_unavailable.
export async function startSourceConversation(
  deps: MessageDeps,
  source: { id: string; workspaceId: string },
  input: ConversationInput,
): Promise<ConversationStartOutcome> {
  const { d1, db } = deps;
  const workspaceId = source.workspaceId;

  // 4. A retry returns the conversation started first, whatever the contents and the limits.
  const idempotencyKey = `conv-src-create:${source.id}:${input.idempotencyKey}`;
  const existing = await findExistingMessage(d1, workspaceId, idempotencyKey);
  if (existing !== null) {
    const retried = await duplicateMessage(deps, existing, null);
    if (!retried.ok) {
      return retried.code === "idempotency_conflict"
        ? { ok: false, error: withMessage(intakeError("idempotency_conflict"), idempotencyConflictMessage) }
        : { ok: false, error: intakeError("temporarily_unavailable") };
    }
    const conversation = await findWorkspaceConversation(db, workspaceId, retried.conversationId);
    if (!conversation) throw new Error("conversation of a stored message not found");
    return startedConversation(deps, conversation, true, null);
  }

  // 5. The source, read again: it may start conversations.
  const row = await findSourceById(db, source.id);
  if (!row || row.workspaceId !== workspaceId) return { ok: false, error: intakeError("unauthorized") };
  if (!row.enabled) return { ok: false, error: intakeError("source_disabled") };
  if (row.canStartConversations !== 1) {
    return {
      ok: false,
      error: withMessage(
        intakeError("start_not_allowed"),
        `送信元「${row.name}」は会話を始めることを許可されていません。Pinglune の送信元の画面（設定）で「会話の開始」を許可してください`,
      ),
    };
  }

  // created_by_user_id: the owner of the (personal) workspace.
  const workspace = await findWorkspaceById(db, workspaceId);
  const owner =
    workspace?.ownerUserId === null || workspace?.ownerUserId === undefined
      ? undefined
      : await findUserById(db, workspace.ownerUserId);
  if (owner === undefined) {
    console.error("owner of the workspace of a source not found", { sourceId: row.id, workspaceId });
    throw new Error("owner of the workspace of a source not found");
  }

  // 6. The limit of AI messages, 7. the invited bots, 8. the daily limit, 9. create.
  const result = await startConversation(deps, {
    workspaceId,
    user: owner,
    starter: { kind: "source", source: row },
    title: input.title,
    names: input.names,
    maxAiMessages: input.maxAiMessages,
    text: input.text,
    idempotencyKey,
  });
  if (!result.ok) {
    switch (result.code) {
      case "invalid_limit":
        return {
          ok: false,
          error: withMessage(
            intakeError("invalid_limit"),
            `max_ai_messages は 1〜${result.max} の整数にしてください（送信元「${row.name}」の上限は ${result.max} です）`,
          ),
        };
      case "invalid_participants":
        // reason "self" is for bots only.
        return result.reason === "missing"
          ? {
              ok: false,
              error: withMessage(
                intakeError("invalid_participants"),
                `Bot が見つかりません: ${result.names.map((name) => `「${name}」`).join("、")}。Pinglune の Bot の画面で確かめられます`,
              ),
            }
          : { ok: false, error: intakeError("invalid_participants") };
      case "rate_limited":
        return {
          ok: false,
          error: withMessage(
            intakeError("rate_limited"),
            `送信元「${row.name}」が 24 時間に始められる会話は ${result.limit} 件までです`,
          ),
        };
      case "idempotency_conflict":
        return { ok: false, error: withMessage(intakeError("idempotency_conflict"), idempotencyConflictMessage) };
      case "temporarily_unavailable":
        return { ok: false, error: intakeError("temporarily_unavailable") };
    }
  }
  return startedConversation(deps, result.conversation, result.duplicate, result.notified);
}
