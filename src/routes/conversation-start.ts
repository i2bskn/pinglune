// The body of the conversation start settings of a bot (POST /api/v1/bots/:id/conversation-start) and of a source
// (POST /api/v1/sources/:id/conversation-start): the same fields, ranges and messages.

import type { ConversationStartSettings } from "../api/types";
import { apiError } from "@i2bskn/workers-app-core";
import { MAX_AI_MESSAGES_LIMIT } from "../conversations/service";
import type { AppEnv } from "../env";
import { jsonBody, unknownField } from "./api";

const CONVERSATION_START_FIELDS = ["enabled", "daily_limit", "max_ai_messages"];
// The ranges of the conversation start settings (start_daily_limit, start_max_ai_messages of bots and sources).
const START_DAILY_LIMIT_MAX = 1000;
const START_MAX_AI_MESSAGES_MAX = MAX_AI_MESSAGES_LIMIT;
const invalidDailyLimitMessage = `1日に始められる会話の数は 1〜${START_DAILY_LIMIT_MAX} の整数にしてください`;
const invalidStartMaxAiMessagesMessage = `AI の発言の上限は 1〜${START_MAX_AI_MESSAGES_MAX} の整数にしてください`;

export type ConversationStartInput = { enabled: boolean; dailyLimit: number; maxAiMessages: number };

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

// All three fields are required.
export const conversationStartBody = jsonBody<ConversationStartSettings, ConversationStartInput, AppEnv>((body, c) => {
  const unknown = unknownField(body, CONVERSATION_START_FIELDS);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  if (typeof body.enabled !== "boolean") {
    return apiError(c, 400, "invalid_request", "enabled は true か false で指定してください");
  }
  if (!isIntegerIn(body.daily_limit, 1, START_DAILY_LIMIT_MAX)) {
    return apiError(c, 400, "invalid_limit", invalidDailyLimitMessage);
  }
  if (!isIntegerIn(body.max_ai_messages, 1, START_MAX_AI_MESSAGES_MAX)) {
    return apiError(c, 400, "invalid_limit", invalidStartMaxAiMessagesMessage);
  }
  return {
    ok: true,
    value: { enabled: body.enabled, dailyLimit: body.daily_limit, maxAiMessages: body.max_ai_messages },
  };
});
