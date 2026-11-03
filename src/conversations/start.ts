// Starting a conversation with bots, shared by the AI of a bot (start_conversation, MCP) and a source of programs
// (POST /ingest/v1/conversations, Intake.startConversation). The caller checks the shape of the input, a retry and
// whether the starter may start conversations, and builds the error messages; this checks the limits, matches the
// invited bots by name, and creates the conversation.

import type { BotRow, ConversationRow, SourceRow, UserRow } from "../db/schema";
import { listWorkspaceBots, MAX_BOTS_PER_WORKSPACE, resolveBotDeliveries } from "../bots/queries";
import { countConversationsStartedBy, countConversationsStartedBySource, findWorkspaceConversation } from "./queries";
import { createConversation, type MessageDeps, type ValidText } from "./service";

// The window of the daily limit of the conversations a bot or a source starts.
export const START_WINDOW_MS = 86_400_000;

// bot: the bot of the MCP connection, which takes part (first) and sends the first message as an AI message.
// source: a source of programs, which does not take part and sends the first message as a program.
// Both are the rows read again by the caller.
export type Starter = { kind: "bot"; bot: BotRow } | { kind: "source"; source: SourceRow };

export type StartParams = {
  // The workspace_id of the row of the starter.
  workspaceId: string;
  // created_by_user_id.
  user: UserRow;
  starter: Starter;
  // Checked by the caller.
  title: string;
  // The names of the invited bots: trimmed, none given twice, and as many as the starter may invite (the caller).
  names: string[];
  // An integer, or undefined for the limit of the starter.
  maxAiMessages: number | undefined;
  text: ValidText;
  // The complete key.
  idempotencyKey: string;
};

export type StartResult =
  | {
      ok: true;
      conversation: ConversationRow;
      eventId: string;
      duplicate: boolean;
      // By bot ID: whether the bot had a destination for the first message. null for a retry.
      notified: Map<string, boolean> | null;
    }
  | { ok: false; code: "invalid_limit"; max: number }
  | { ok: false; code: "invalid_participants"; reason: "self"; name: string }
  | { ok: false; code: "invalid_participants"; reason: "missing"; names: string[] }
  | { ok: false; code: "rate_limited"; limit: number }
  | { ok: false; code: "idempotency_conflict" | "temporarily_unavailable" };

function startLimits(starter: Starter): { dailyLimit: number; maxAiMessages: number } {
  const row = starter.kind === "bot" ? starter.bot : starter.source;
  return { dailyLimit: row.startDailyLimit, maxAiMessages: row.startMaxAiMessages };
}

// Checks the limit of AI messages, the invited bots and the daily limit, in this order, then creates the conversation
// and reads it again. deps.now is the time the caller took before checking a retry.
export async function startConversation(deps: MessageDeps, params: StartParams): Promise<StartResult> {
  const { db, now } = deps;
  const { workspaceId, starter, names } = params;
  const limits = startLimits(starter);

  // 1. The limit of AI messages.
  const maxAiMessages = params.maxAiMessages ?? limits.maxAiMessages;
  if (maxAiMessages < 1 || maxAiMessages > limits.maxAiMessages) {
    return { ok: false, code: "invalid_limit", max: limits.maxAiMessages };
  }

  // 2. A bot does not invite itself.
  if (starter.kind === "bot" && names.includes(starter.bot.name)) {
    return { ok: false, code: "invalid_participants", reason: "self", name: starter.bot.name };
  }

  // 3. The invited bots, by name among the bots of the workspace that are not deleted.
  const byName = new Map((await listWorkspaceBots(db, workspaceId, MAX_BOTS_PER_WORKSPACE)).map((row) => [row.name, row]));
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length > 0) return { ok: false, code: "invalid_participants", reason: "missing", names: missing };
  const invited = names.map((name) => byName.get(name) as BotRow);

  // 4. The daily limit. A loose limit: concurrent calls may go slightly over it.
  const since = now - START_WINDOW_MS;
  const started =
    starter.kind === "bot"
      ? await countConversationsStartedBy(db, workspaceId, starter.bot.id, since)
      : await countConversationsStartedBySource(db, workspaceId, starter.source.id, since);
  if (started >= limits.dailyLimit) return { ok: false, code: "rate_limited", limit: limits.dailyLimit };

  // 5. The first message goes to the destination of each invited bot now, never to the starting bot's.
  const deliveries = await resolveBotDeliveries(db, workspaceId, invited, now);
  const notified = new Map<string, boolean>();
  const recipients: string[] = [];
  for (const bot of invited) {
    const id = deliveries.get(bot.id)?.id;
    notified.set(bot.id, id !== undefined);
    if (id !== undefined && !recipients.includes(id)) recipients.push(id);
  }

  // 6. Create.
  const result = await createConversation(deps, {
    workspaceId,
    user: params.user,
    ...(starter.kind === "bot"
      ? { startedByBotId: starter.bot.id }
      : { startedBySource: { id: starter.source.id, name: starter.source.name } }),
    title: params.title,
    maxAiMessages,
    participants: (starter.kind === "bot" ? [starter.bot, ...invited] : invited).map((bot) => ({
      botId: bot.id,
      name: bot.name,
    })),
    recipients,
    text: params.text,
    idempotencyKey: params.idempotencyKey,
  });
  if (!result.ok) return { ok: false, code: result.code };

  // 7. Read it again.
  const conversation = await findWorkspaceConversation(db, workspaceId, result.conversationId);
  if (!conversation) throw new Error("started conversation not found");
  return {
    ok: true,
    conversation,
    eventId: result.eventId,
    duplicate: result.duplicate,
    notified: result.duplicate ? null : notified,
  };
}
