import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { EventData, EventDetail, EventSummary } from "../api/types";
import type { Db } from "../db/client";
import { eventData, events, sources, type EventDataRow } from "../db/schema";
import type { EventFilter } from "./filter";

export const EVENT_PAGE_SIZE = 50;

type EventWithCount = typeof events.$inferSelect & { dataCount: number };

const eventColumns = {
  id: events.id,
  workspaceId: events.workspaceId,
  sourceId: events.sourceId,
  idempotencyKey: events.idempotencyKey,
  requestHash: events.requestHash,
  type: events.type,
  summary: events.summary,
  labels: events.labels,
  occurredAt: events.occurredAt,
  receivedAt: events.receivedAt,
  conversationId: events.conversationId,
  // Qualified by hand: drizzle renders ${events.id} without the table name, which would bind to event_data.
  dataCount: sql<number>`(SELECT COUNT(*) FROM event_data WHERE event_data.event_id = events.id)`,
};

function parseLabels(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, string>)
    : {};
}

// The names of the sources, read in a separate query.
async function sourceNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: sources.id, name: sources.name })
    .from(sources)
    .where(inArray(sources.id, [...new Set(ids)]))
    .all();
  return new Map(rows.map((row) => [row.id, row.name]));
}

function toSummary(row: EventWithCount, names: Map<string, string>): EventSummary {
  return {
    event_id: row.id,
    type: row.type,
    source: { id: row.sourceId, name: names.get(row.sourceId) ?? "" },
    labels: parseLabels(row.labels),
    summary: row.summary,
    occurred_at: row.occurredAt,
    received_at: row.receivedAt,
    data_count: row.dataCount,
  };
}

function toApiEventData(row: EventDataRow): EventData {
  return {
    data_ref: row.id,
    role: row.role,
    name: row.name,
    content_type: row.contentType,
    size: row.size,
  };
}

export type ListEventsOptions = {
  // An event ID: only events older than it.
  cursor?: string;
  // Defaults to EVENT_PAGE_SIZE.
  limit?: number;
  filter?: EventFilter;
  // Only the events of these sources, by ID. The caller makes sure they are sources of the workspace; events of other
  // workspaces are never listed anyway. An empty array gives an empty list.
  sourceIds?: string[];
  // UNIX ms: only events received at or after it.
  receivedSince?: number;
};

// The IDs of the sources of the workspace with one of the names. Other workspaces' sources of the same name
// are not included; disabled sources are. The conversation source is not: its events are never listed anyway.
async function workspaceSourceIds(db: Db, workspaceId: string, names: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(eq(sources.workspaceId, workspaceId), eq(sources.kind, "program"), inArray(sources.name, [...new Set(names)])),
    )
    .all();
  return rows.map((row) => row.id);
}

// The newest events of the workspace that match the options. The messages of conversations are not listed.
export async function listWorkspaceEvents(
  db: Db,
  workspaceId: string,
  options: ListEventsOptions = {},
): Promise<{ events: EventSummary[]; nextCursor: string | null }> {
  const { cursor, filter, receivedSince, sourceIds } = options;
  const limit = options.limit ?? EVENT_PAGE_SIZE;
  const conditions: SQL[] = [eq(events.workspaceId, workspaceId), isNull(events.conversationId)];
  if (cursor !== undefined) conditions.push(lt(events.id, cursor));
  if (receivedSince !== undefined) conditions.push(gte(events.receivedAt, receivedSince));
  if (filter?.types !== undefined) conditions.push(inArray(events.type, [...new Set(filter.types)]));
  if (sourceIds !== undefined) {
    if (sourceIds.length === 0) return { events: [], nextCursor: null };
    conditions.push(inArray(events.sourceId, [...new Set(sourceIds)]));
  }
  if (filter?.sources !== undefined) {
    const sourceIds = await workspaceSourceIds(db, workspaceId, filter.sources);
    if (sourceIds.length === 0) return { events: [], nextCursor: null };
    conditions.push(inArray(events.sourceId, sourceIds));
  }
  for (const [key, value] of Object.entries(filter?.labels ?? {})) {
    // The key is quoted so that a dot in it is not a path separator. Keys are checked against
    // LABEL_KEY_PATTERN and contain no double quote; the path is bound, not concatenated into the SQL.
    conditions.push(sql`json_extract(${events.labels}, ${`$."${key}"`}) = ${value}`);
  }

  const rows = await db
    .select(eventColumns)
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const names = await sourceNames(
    db,
    page.map((row) => row.sourceId),
  );
  const last = page[page.length - 1];
  return {
    events: page.map((row) => toSummary(row, names)),
    nextCursor: rows.length > limit && last ? last.id : null,
  };
}

// The event only if it belongs to the workspace. The messages of conversations are found too: the AIs read their
// bodies, and the deliveries link to them.
export async function findWorkspaceEvent(db: Db, workspaceId: string, id: string): Promise<EventDetail | null> {
  const row = await db
    .select(eventColumns)
    .from(events)
    .where(and(eq(events.id, id), eq(events.workspaceId, workspaceId)))
    .get();
  if (!row) return null;
  const names = await sourceNames(db, [row.sourceId]);
  const data = await db
    .select()
    .from(eventData)
    .where(eq(eventData.eventId, row.id))
    .orderBy(asc(eventData.position))
    .all();
  return { ...toSummary(row, names), conversation_id: row.conversationId, data: data.map(toApiEventData) };
}

// The events of the workspace with these IDs, in no particular order. IDs of other workspaces are not found.
export async function findWorkspaceEventsByIds(db: Db, workspaceId: string, ids: string[]): Promise<EventSummary[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(eventColumns)
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), inArray(events.id, [...new Set(ids)])))
    .all();
  const names = await sourceNames(
    db,
    rows.map((row) => row.sourceId),
  );
  return rows.map((row) => toSummary(row, names));
}

// One data item only if it belongs to the workspace.
export function findWorkspaceEventData(db: Db, workspaceId: string, dataRef: string): Promise<EventDataRow | undefined> {
  return db
    .select()
    .from(eventData)
    .where(and(eq(eventData.id, dataRef), eq(eventData.workspaceId, workspaceId)))
    .get();
}

// One data item only if it belongs to the event and the event to the workspace (the data rows carry the workspace of
// their event). Used by the download of the management screen.
export function findEventDataOfEvent(
  db: Db,
  workspaceId: string,
  eventId: string,
  dataRef: string,
): Promise<EventDataRow | undefined> {
  return db
    .select()
    .from(eventData)
    .where(and(eq(eventData.id, dataRef), eq(eventData.eventId, eventId), eq(eventData.workspaceId, workspaceId)))
    .get();
}

// Whether the source is a source of programs in the workspace.
export async function isWorkspaceProgramSource(db: Db, workspaceId: string, sourceId: string): Promise<boolean> {
  const row = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId), eq(sources.kind, "program")))
    .get();
  return row !== undefined;
}
