import { describe, expect, it } from "vitest";
import type { ConversationParticipant } from "../../src/api/types";
import {
  aiMessagesLabel,
  conversationRequest,
  conversationStatusLabel,
  participantDestinationLabel,
  participantDestinationStatus,
  subscriptionLabel,
} from "./conversations";
import { errorLabel } from "./deliveries";

describe("conversation labels", () => {
  it("tells the state and the number of AI messages", () => {
    expect(conversationStatusLabel({ status: "open", stop_reason: null })).toBe("進行中");
    expect(conversationStatusLabel({ status: "stopped", stop_reason: "user" })).toBe("停止（手動）");
    expect(conversationStatusLabel({ status: "stopped", stop_reason: "limit" })).toBe("停止（上限）");
    expect(aiMessagesLabel({ ai_message_count: 3, max_ai_messages: 20 })).toBe("AI の発言 3 / 上限 20");
  });

  it("names the destinations by kind", () => {
    expect(subscriptionLabel({ kind: "webhook", name: "Grok", callback_host: "x.example.com" })).toBe("Webhook: Grok");
    expect(subscriptionLabel({ kind: "queue", name: "Muse", callback_host: null })).toBe("キュー: Muse");
    expect(subscriptionLabel({ kind: "mcp", name: null, callback_host: "dot.example.com" })).toBe("MCP: dot.example.com");
  });

  it("shows the destination of a participant and its state", () => {
    const participant: ConversationParticipant = {
      name: "dot",
      oauth_client_id: "c1",
      oauth_client_name: "dot",
      destination_kind: "webhook",
      destination_name: "dot",
      callback_host: "hooks.example.com",
      destination_status: "unsubscribed",
    };
    expect(participantDestinationLabel(participant)).toBe("Webhook: dot");
    expect(participantDestinationStatus(participant)).toBe("終了済み");
    expect(participantDestinationLabel({ ...participant, destination_kind: null })).toBe("不明な配信先");
    expect(participantDestinationStatus({ ...participant, destination_status: null })).toBe("見つかりません");
  });

  it("describes a delivery failed by a stop", () => {
    expect(errorLabel("conversation_stopped")).toBe("会話が停止された");
  });
});

describe("conversationRequest", () => {
  const form = {
    title: "相談",
    maxAiMessages: " 5 ",
    participants: [{ name: "dot", clientId: "c1", subscriptionId: "sub_1" }],
    message: "hi",
  };

  it("builds the request with the key", () => {
    expect(conversationRequest(form, "k1")).toEqual({
      ok: true,
      value: {
        title: "相談",
        max_ai_messages: 5,
        participants: [{ name: "dot", oauth_client_id: "c1", subscription_id: "sub_1" }],
        message: "hi",
        idempotency_key: "k1",
      },
    });
  });

  it.each(["", "1.5", "-1", "abc", "1000"])("rejects the limit %j", (maxAiMessages) => {
    expect(conversationRequest({ ...form, maxAiMessages }, "k1")).toEqual({
      ok: false,
      message: "AI の発言の上限は 1〜100 の整数にしてください",
    });
  });
});
