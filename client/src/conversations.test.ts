import { describe, expect, it } from "vitest";
import type { ConversationParticipant } from "../../src/api/types";
import {
  aiMessagesLabel,
  botOptionLabel,
  botWarning,
  conversationCurlExample,
  conversationRequest,
  conversationStatusLabel,
  participantDestinationLabel,
  participantDestinationStatus,
  participantStopReason,
  startedByLabel,
  subscriptionLabel,
} from "./conversations";
import { errorLabel } from "./deliveries";

describe("startedByLabel", () => {
  it("names the bot whose AI started the conversation", () => {
    expect(startedByLabel({ started_by: { kind: "bot", bot_id: "bot_1", name: "dot" } })).toBe("開始: dot（AI）");
    expect(startedByLabel({ started_by: { kind: "bot", bot_id: "bot_1", name: "" } })).toBe("開始: （名前なし）（AI）");
  });

  it("names the source that started the conversation", () => {
    expect(startedByLabel({ started_by: { kind: "source", source_id: "src_1", name: "nightly" } })).toBe(
      "開始: nightly（プログラム）",
    );
    expect(startedByLabel({ started_by: { kind: "source", source_id: "src_1", name: "" } })).toBe(
      "開始: （名前なし）（プログラム）",
    );
  });

  it("is null for a conversation started by the user", () => {
    expect(startedByLabel({ started_by: { kind: "user" } })).toBeNull();
  });
});

describe("conversationCurlExample", () => {
  it("posts to the origin of the screen with a placeholder key", () => {
    const example = conversationCurlExample("https://pinglune.example.com");
    expect(example.split("\n")).toEqual([
      "curl -X POST https://pinglune.example.com/ingest/v1/conversations \\",
      '  -H "Authorization: Bearer pl_<キーID>_<秘密>" \\',
      '  -H "Content-Type: application/json" \\',
      expect.stringMatching(/^  -d '\{.*\}'$/),
    ]);
  });

  it("sends the required fields as JSON", () => {
    const line = conversationCurlExample("https://pinglune.example.com").split("\n")[3] ?? "";
    expect(JSON.parse(line.slice("  -d '".length, -1))).toEqual({
      title: expect.any(String),
      participants: ["<Bot の名前>"],
      message: expect.any(String),
      idempotency_key: "nightly-2026-11-04",
    });
  });
});

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
      bot: { id: "bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V", name: "dot", deleted: false, delivery_kind: "webhook" },
      connection_client_name: "dot",
      destination: { kind: "webhook", name: "dot", callback_host: "hooks.example.com", status: "unsubscribed" },
    };
    expect(participantDestinationLabel(participant)).toBe("Webhook: dot");
    expect(participantDestinationStatus(participant)).toBe("終了済み");
    expect(participantDestinationLabel({ ...participant, destination: null })).toBe("配信先なし");
    expect(participantDestinationStatus({ ...participant, destination: null })).toBe("配信先なし");
  });

  it("shows a bot with its state and warns when it is not ready", () => {
    expect(botOptionLabel({ name: "Dot", status: "ready" })).toBe("Dot（準備完了）");
    expect(botOptionLabel({ name: "Grok Bot", status: "no_connection" })).toBe("Grok Bot（未接続）");
    expect(botOptionLabel({ name: "Muse", status: "no_delivery" })).toBe("Muse（配信先なし）");
    expect(botWarning({ status: "ready" })).toBeNull();
    expect(botWarning({ status: "no_connection" })).toMatch(/MCP 接続がありません/);
    expect(botWarning({ status: "no_delivery" })).toMatch(/配信先がありません/);
  });

  it("describes a delivery failed by a stop", () => {
    expect(errorLabel("conversation_stopped")).toBe("会話が停止された");
  });
});

describe("conversationRequest", () => {
  const form = {
    title: "相談",
    maxAiMessages: " 5 ",
    botIds: ["bot_1", "bot_2"],
    message: "hi",
  };

  it("builds the request with the key", () => {
    expect(conversationRequest(form, "k1")).toEqual({
      ok: true,
      value: {
        title: "相談",
        max_ai_messages: 5,
        participants: [{ bot_id: "bot_1" }, { bot_id: "bot_2" }],
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

  it("rejects a participant without a bot and a repeated bot", () => {
    expect(conversationRequest({ ...form, botIds: ["bot_1", ""] }, "k1")).toEqual({
      ok: false,
      message: "参加者の Bot を選んでください",
    });
    expect(conversationRequest({ ...form, botIds: ["bot_1", "bot_1"] }, "k1")).toEqual({
      ok: false,
      message: "同じ Bot は選べません",
    });
  });
});

describe("participantStopReason", () => {
  const base = { name: "a", connection_client_name: null };
  it("explains a missing destination by the kind of the bot", () => {
    const bot = { id: "bot_1", name: "a", deleted: false };
    expect(participantStopReason({ ...base, bot: { ...bot, delivery_kind: "mcp" }, destination: null })).toBe("未購読");
    expect(participantStopReason({ ...base, bot: { ...bot, delivery_kind: "webhook" }, destination: null })).toBe("配信先なし");
    const expired = { kind: "mcp" as const, name: null, callback_host: "ai.example.com", status: "expired" as const };
    expect(participantStopReason({ ...base, bot: { ...bot, delivery_kind: "mcp" }, destination: expired })).toBe("未購読（期限切れ）");
    expect(participantStopReason({ ...base, bot: null, destination: { ...expired, status: "active" } })).toBeNull();
  });
});
