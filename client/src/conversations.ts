import type {
  Conversation,
  ConversationParticipant,
  CreateConversationRequest,
  Subscription,
} from "../../src/api/types";

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

// The destination of a participant, in the same form. "不明な配信先" when it is not found.
export function participantDestinationLabel(participant: ConversationParticipant): string {
  if (participant.destination_kind === null) return "不明な配信先";
  return subscriptionLabel({
    kind: participant.destination_kind,
    name: participant.destination_name,
    callback_host: participant.callback_host,
  });
}

// Whether the participant is still notified: the destination is active.
export function participantDestinationStatus(participant: ConversationParticipant): string {
  switch (participant.destination_status) {
    case "active":
      return "有効";
    case "expired":
      return "期限切れ";
    case "unsubscribed":
      return "終了済み";
    case null:
      return "見つかりません";
  }
}

export type ParticipantForm = { name: string; clientId: string; subscriptionId: string };

export type ConversationForm = {
  title: string;
  maxAiMessages: string;
  participants: ParticipantForm[];
  message: string;
};

export const MIN_PARTICIPANT_ROWS = 1;
export const MAX_PARTICIPANT_ROWS = 5;

// The request of the creation form. The limit must be a whole number; the server checks the rest.
export function conversationRequest(
  form: ConversationForm,
  idempotencyKey: string,
): { ok: true; value: CreateConversationRequest } | { ok: false; message: string } {
  const trimmed = form.maxAiMessages.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return { ok: false, message: "AI の発言の上限は 1〜100 の整数にしてください" };
  return {
    ok: true,
    value: {
      title: form.title,
      max_ai_messages: Number(trimmed),
      participants: form.participants.map((p) => ({
        name: p.name,
        oauth_client_id: p.clientId,
        subscription_id: p.subscriptionId,
      })),
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
