import type {
  Bot,
  Conversation,
  ConversationParticipant,
  CreateConversationRequest,
  Subscription,
} from "../../src/api/types";
import { BOT_STATUS_LABELS } from "./bots";

export function conversationStatusLabel(conversation: Pick<Conversation, "status" | "stop_reason">): string {
  if (conversation.status === "open") return "進行中";
  return conversation.stop_reason === "limit" ? "停止（上限）" : "停止（手動）";
}

export function aiMessagesLabel(conversation: Pick<Conversation, "ai_message_count" | "max_ai_messages">): string {
  return `AI の発言 ${conversation.ai_message_count} / 上限 ${conversation.max_ai_messages}`;
}

// A destination to notify, as the select of the form shows it: "Webhook: name", "キュー: name" or "MCP: host".
export function subscriptionLabel(subscription: Pick<Subscription, "kind" | "name" | "callback_host">): string {
  switch (subscription.kind) {
    case "webhook":
      return `Webhook: ${subscription.name ?? subscription.callback_host ?? "（名前なし）"}`;
    case "queue":
      return `キュー: ${subscription.name ?? "（名前なし）"}`;
    case "mcp":
      return `MCP: ${subscription.callback_host ?? "不明な宛先"}`;
  }
}

// The destination of a participant, in the same form. "通知先なし" when it has none.
export function participantDestinationLabel(participant: ConversationParticipant): string {
  if (participant.destination === null) return "通知先なし";
  return subscriptionLabel(participant.destination);
}

// Whether the participant is still notified: the destination is active.
export function participantDestinationStatus(participant: ConversationParticipant): string {
  switch (participant.destination?.status) {
    case "active":
      return "有効";
    case "expired":
      return "期限切れ";
    case "unsubscribed":
      return "終了済み";
    case undefined:
      return "なし";
  }
}

// A bot as the select of the form shows it: "Dot（準備OK）".
export function botOptionLabel(bot: Pick<Bot, "name" | "status">): string {
  return `${bot.name}（${BOT_STATUS_LABELS[bot.status]}）`;
}

// The warning under a bot that is not ready; null when it is.
export function botWarning(bot: Pick<Bot, "status">): string | null {
  switch (bot.status) {
    case "ready":
      return null;
    case "no_connection":
      return "この Bot には MCP 接続がありません。発言できるのは、AI から接続して Bot を選んだあとです";
    case "no_delivery":
      return "この Bot には通知先がありません。通知先ができるまで、発言は届きません";
  }
}

export type ConversationForm = {
  title: string;
  maxAiMessages: string;
  // The bot of each participant; "" until one is chosen.
  botIds: string[];
  message: string;
};

export const MIN_PARTICIPANT_ROWS = 1;
export const MAX_PARTICIPANT_ROWS = 5;

// The request of the creation form. The limit must be a whole number, and every participant needs a bot, each once;
// the server checks the rest.
export function conversationRequest(
  form: ConversationForm,
  idempotencyKey: string,
): { ok: true; value: CreateConversationRequest } | { ok: false; message: string } {
  const trimmed = form.maxAiMessages.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return { ok: false, message: "AI の発言の上限は 1〜100 の整数にしてください" };
  if (form.botIds.some((id) => id === "")) return { ok: false, message: "参加者の Bot を選んでください" };
  if (new Set(form.botIds).size !== form.botIds.length) return { ok: false, message: "同じ Bot は選べません" };
  return {
    ok: true,
    value: {
      title: form.title,
      max_ai_messages: Number(trimmed),
      participants: form.botIds.map((id) => ({ bot_id: id })),
      message: form.message,
      idempotency_key: idempotencyKey,
    },
  };
}

// A new idempotency key for a message or a new conversation. Kept while the input stays the same, so that sending
// again after a failure does not add a second message.
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
