// The conversations, their participants, the conversation source of a workspace, and the messages (events with a
// conversation_id) of a conversation.

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  conversationParticipants,
  conversations,
  eventData,
  events,
  subscriptions,
  type ConversationParticipantRow,
  type ConversationRow,
  type SubscriptionRow,
} from "../db/schema";
import { newSourceId } from "../ids";
import { isActiveSubscription } from "../subscriptions/queries";

export const CONVERSATION_PAGE_SIZE = 50;
export const CONVERSATION_SOURCE_NAME = "Pinglune 会話";

// The conversation source of a workspace, or null if it was never created.
export async function findConversationSourceId(d1: D1Database, workspaceId: string): Promise<string | null> {
  const row = await d1
    .prepare("SELECT id FROM sources WHERE workspace_id = ? AND kind = 'conversation'")
    .bind(workspaceId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// The conversation source of a workspace, created when it is missing. sources_workspace_conversation_unique keeps one
// per workspace when two requests create it at the same time, and its name does not conflict with the user's sources
// (sources_workspace_id_name_unique covers programs only).
export async function findOrCreateConversationSource(d1: D1Database, workspaceId: string, now: number): Promise<string> {
  const existing = await findConversationSourceId(d1, workspaceId);
  if (existing !== null) return existing;
  await d1
    .prepare(
      `INSERT INTO sources (id, workspace_id, name, enabled, kind, created_at, updated_at)
      VALUES (?1, ?2, ?3, 1, 'conversation', ?4, ?4) ON CONFLICT DO NOTHING`,
    )
    .bind(newSourceId(now), workspaceId, CONVERSATION_SOURCE_NAME, now)
    .run();
  const created = await findConversationSourceId(d1, workspaceId);
  if (created === null) throw new Error("conversation source not found after creating it");
  return created;
}

// The conversation only if it belongs to the workspace.
export function findWorkspaceConversation(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<ConversationRow | undefined> {
  return db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.workspaceId, workspaceId)))
    .get();
}

// The participants of a conversation, in the order they were given.
export function listConversationParticipants(db: Db, conversationId: string): Promise<ConversationParticipantRow[]> {
  return db
    .select()
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId))
    .orderBy(conversationParticipants.id)
    .all();
}

// The participants of several conversations, by conversation, in the order they were given.
export async function participantsByConversation(
  db: Db,
  conversationIds: string[],
): Promise<Map<string, ConversationParticipantRow[]>> {
  const result = new Map<string, ConversationParticipantRow[]>();
  if (conversationIds.length === 0) return result;
  const rows = await db
    .select()
    .from(conversationParticipants)
    .where(inArray(conversationParticipants.conversationId, [...new Set(conversationIds)]))
    .orderBy(conversationParticipants.id)
    .all();
  for (const row of rows) {
    const list = result.get(row.conversationId) ?? [];
    list.push(row);
    result.set(row.conversationId, list);
  }
  return result;
}

// The newest conversations of the workspace. cursor is a conversation ID: only conversations older than it.
export async function listWorkspaceConversations(
  db: Db,
  workspaceId: string,
  cursor?: string,
): Promise<{ conversations: ConversationRow[]; nextCursor: string | null }> {
  const limit = CONVERSATION_PAGE_SIZE;
  const conditions = [eq(conversations.workspaceId, workspaceId)];
  if (cursor !== undefined) conditions.push(lt(conversations.id, cursor));
  const rows = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { conversations: page, nextCursor: rows.length > limit && last ? last.id : null };
}

// The open conversations of the workspace, for the limit.
export async function countOpenConversations(db: Db, workspaceId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(conversations)
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.status, "open")))
    .get();
  return row?.count ?? 0;
}

// The subscriptions with these IDs in the workspace, by ID.
export async function workspaceSubscriptionsByIds(
  db: Db,
  workspaceId: string,
  ids: string[],
): Promise<Map<string, SubscriptionRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, workspaceId), inArray(subscriptions.id, [...new Set(ids)])))
    .all();
  return new Map(rows.map((row) => [row.id, row]));
}

// The destinations that a message is delivered to: the active subscriptions of the participants other than the
// sender, each once. Filters (types, sources, labels) are not looked at.
export async function messageRecipients(
  db: Db,
  workspaceId: string,
  participants: ConversationParticipantRow[],
  senderParticipantId: string | null,
  now: number,
): Promise<string[]> {
  const ids = [
    ...new Set(participants.filter((p) => p.id !== senderParticipantId).map((p) => p.subscriptionId)),
  ];
  const rows = await workspaceSubscriptionsByIds(db, workspaceId, ids);
  return ids.filter((id) => {
    const row = rows.get(id);
    return row !== undefined && isActiveSubscription(row, now);
  });
}

export type MessageRow = {
  eventId: string;
  labels: Record<string, string>;
  receivedAt: number;
  // The body, or null if it is missing.
  body: { dataRef: string; r2Key: string; size: number } | null;
};

function parseLabels(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

// The newest limit messages of a conversation (older than before, if given), oldest first. olderCursor is the oldest
// event ID of the page when there are older messages. The bodies are read in a separate query.
export async function listConversationMessages(
  db: Db,
  params: { workspaceId: string; conversationId: string; before?: string; limit: number },
): Promise<{ messages: MessageRow[]; olderCursor: string | null }> {
  const { workspaceId, conversationId, before, limit } = params;
  const conditions = [eq(events.conversationId, conversationId), eq(events.workspaceId, workspaceId)];
  if (before !== undefined) conditions.push(lt(events.id, before));
  const rows = await db
    .select({ id: events.id, labels: events.labels, receivedAt: events.receivedAt })
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit).reverse();
  const bodies = new Map<string, MessageRow["body"]>();
  if (page.length > 0) {
    const data = await db
      .select({ id: eventData.id, eventId: eventData.eventId, r2Key: eventData.r2Key, size: eventData.size })
      .from(eventData)
      .where(
        and(
          inArray(
            eventData.eventId,
            page.map((row) => row.id),
          ),
          eq(eventData.role, "body"),
        ),
      )
      .all();
    for (const row of data) bodies.set(row.eventId, { dataRef: row.id, r2Key: row.r2Key, size: row.size });
  }
  const oldest = page[0];
  return {
    messages: page.map((row) => ({
      eventId: row.id,
      labels: parseLabels(row.labels),
      receivedAt: row.receivedAt,
      body: bodies.get(row.id) ?? null,
    })),
    olderCursor: rows.length > limit && oldest ? oldest.id : null,
  };
}

// Stops a conversation on the user's request, and fails the pending deliveries of its messages so that the AIs are
// not notified anymore, in one batch. The deliveries are failed only if the user stopped it: a conversation that
// reached its limit first keeps the delivery of its last message. Stopping it again changes nothing.
export async function stopConversation(d1: D1Database, workspaceId: string, id: string, now: number): Promise<void> {
  await d1.batch([
    d1
      .prepare(
        `UPDATE conversations SET status = 'stopped', stop_reason = 'user', stopped_at = ?1, updated_at = ?1
        WHERE id = ?2 AND workspace_id = ?3 AND status = 'open'`,
      )
      .bind(now, id, workspaceId),
    // deliveries_event_subscription_unique finds the deliveries of each message.
    d1
      .prepare(
        `UPDATE deliveries SET status = 'failed', last_error = 'conversation_stopped', updated_at = ?1
        WHERE status = 'pending' AND event_id IN (SELECT id FROM events WHERE conversation_id = ?2 AND workspace_id = ?3)
          AND EXISTS (SELECT 1 FROM conversations WHERE id = ?2 AND stop_reason = 'user')`,
      )
      .bind(now, id, workspaceId),
  ]);
}
