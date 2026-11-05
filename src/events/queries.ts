import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { EventData, EventDetail, EventScreening, EventSummary } from "../api/types";
import type { Db } from "@i2bskn/workers-app-core";
import { botSources, eventData, events, sources, type EventDataRow } from "../db/schema";
import { deliverableScreening, isRetryableScreeningError, parseScreeningStatus } from "../screening/state";
import { isHtmlBodyData } from "./email-view";
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
  screeningStatus: events.screeningStatus,
  screeningScore: events.screeningScore,
  screeningError: events.screeningError,
  screeningRequestedAt: events.screeningRequestedAt,
  screenedAt: events.screenedAt,
  screeningReleasedAt: events.screeningReleasedAt,
  screeningReleasedBy: events.screeningReleasedBy,
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
export async function sourceNames(db: Db, ids: string[]): Promise<Map<string, string>> {
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

type ScreeningColumns = Pick<
  typeof events.$inferSelect,
  "screeningStatus" | "screeningScore" | "screeningError" | "screeningRequestedAt" | "screenedAt" | "screeningReleasedAt"
>;

// The screening of an event for the management screen, or null if it was not screened. Never for MCP or webhooks.
export function toApiScreening(row: ScreeningColumns): EventScreening | null {
  const status = parseScreeningStatus(row.screeningStatus);
  if (status === null) return null;
  return {
    status,
    score: row.screeningScore,
    error: row.screeningError,
    retryable: status === "held" && isRetryableScreeningError(row.screeningError),
    requested_at: row.screeningRequestedAt,
    screened_at: row.screenedAt,
    released_at: row.screeningReleasedAt,
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
  // Only the events of the sources linked to this bot (bot_sources), by a subquery: a bot may be linked to more
  // sources than an IN list of bound values may hold. A bot without linked sources gives an empty list.
  botId?: string;
  // UNIX ms: only events received at or after it.
  receivedSince?: number;
  // Also the events that may not be read by AIs (held or waiting for the screening, src/screening/state.ts). Only the
  // management screen passes true; the default keeps them from MCP.
  includeScreened?: boolean;
  // Only the events in this screening state, for the management screen.
  screening?: "held" | "pending";
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
): Promise<{
  events: EventSummary[];
  // The screening of each listed event (event_id to the screening), for the management screen.
  screenings: Map<string, EventScreening | null>;
  nextCursor: string | null;
}> {
  const { cursor, filter, receivedSince, sourceIds, botId } = options;
  const limit = options.limit ?? EVENT_PAGE_SIZE;
  const empty = { events: [], screenings: new Map<string, EventScreening | null>(), nextCursor: null };
  const conditions: SQL[] = [eq(events.workspaceId, workspaceId), isNull(events.conversationId)];
  if (options.includeScreened !== true) conditions.push(deliverableScreening);
  if (options.screening !== undefined) conditions.push(eq(events.screeningStatus, options.screening));
  if (cursor !== undefined) conditions.push(lt(events.id, cursor));
  if (receivedSince !== undefined) conditions.push(gte(events.receivedAt, receivedSince));
  if (filter?.types !== undefined) conditions.push(inArray(events.type, [...new Set(filter.types)]));
  if (sourceIds !== undefined) {
    if (sourceIds.length === 0) return empty;
    conditions.push(inArray(events.sourceId, [...new Set(sourceIds)]));
  }
  if (botId !== undefined) {
    conditions.push(
      inArray(
        events.sourceId,
        db
          .select({ id: botSources.sourceId })
          .from(botSources)
          .where(and(eq(botSources.workspaceId, workspaceId), eq(botSources.botId, botId))),
      ),
    );
  }
  if (filter?.sources !== undefined) {
    const sourceIds = await workspaceSourceIds(db, workspaceId, filter.sources);
    if (sourceIds.length === 0) return empty;
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
    screenings: new Map(page.map((row) => [row.id, toApiScreening(row)])),
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

export type EventScope = { sourceId: string; conversationId: string | null; screeningStatus: string | null };

// The source, the conversation and the screening state of an event, only if it belongs to the workspace. For the
// checks of what an MCP connection may read, and of whether the event may be delivered.
export function findWorkspaceEventScope(db: Db, workspaceId: string, eventId: string): Promise<EventScope | undefined> {
  return db
    .select({
      sourceId: events.sourceId,
      conversationId: events.conversationId,
      screeningStatus: events.screeningStatus,
    })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.workspaceId, workspaceId)))
    .get();
}

// The screening of an event of the workspace, for the management screen: undefined if the event is not found, null
// if it was not screened.
export async function findWorkspaceEventScreening(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<EventScreening | null | undefined> {
  const row = await db
    .select({
      screeningStatus: events.screeningStatus,
      screeningScore: events.screeningScore,
      screeningError: events.screeningError,
      screeningRequestedAt: events.screeningRequestedAt,
      screenedAt: events.screenedAt,
      screeningReleasedAt: events.screeningReleasedAt,
    })
    .from(events)
    .where(and(eq(events.id, id), eq(events.workspaceId, workspaceId)))
    .get();
  return row === undefined ? undefined : toApiScreening(row);
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

export type EmailEventRecord = {
  id: string;
  type: string;
  summary: string;
  labels: Record<string, string>;
  sourceId: string;
  conversationId: string | null;
};

// An event of the workspace with only what the email view needs, or undefined. The caller checks the type and the
// conversation.
export async function findEmailEvent(db: Db, workspaceId: string, id: string): Promise<EmailEventRecord | undefined> {
  const row = await db
    .select({
      id: events.id,
      type: events.type,
      summary: events.summary,
      labels: events.labels,
      sourceId: events.sourceId,
      conversationId: events.conversationId,
    })
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.id, id)))
    .get();
  return row === undefined ? undefined : { ...row, labels: parseLabels(row.labels) };
}

export type EventDataListRow = Pick<EventDataRow, "id" | "role" | "name" | "contentType" | "size" | "r2Key" | "position">;

// The data rows of an event of the workspace, in position order.
export function listEventDataRows(db: Db, workspaceId: string, eventId: string): Promise<EventDataListRow[]> {
  return db
    .select({
      id: eventData.id,
      role: eventData.role,
      name: eventData.name,
      contentType: eventData.contentType,
      size: eventData.size,
      r2Key: eventData.r2Key,
      position: eventData.position,
    })
    .from(eventData)
    .where(and(eq(eventData.workspaceId, workspaceId), eq(eventData.eventId, eventId)))
    .orderBy(asc(eventData.position))
    .all();
}

// The number of attachments of each event (event_id to the count), without the HTML body of the email intake. For
// the email events of one page of the event list (up to EVENT_PAGE_SIZE IDs), in one query.
export async function countEmailAttachments(db: Db, workspaceId: string, eventIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (eventIds.length === 0) return counts;
  const rows = await db
    .select({
      eventId: eventData.eventId,
      role: eventData.role,
      name: eventData.name,
      contentType: eventData.contentType,
      position: eventData.position,
    })
    .from(eventData)
    .where(and(eq(eventData.workspaceId, workspaceId), inArray(eventData.eventId, [...new Set(eventIds)])))
    .all();
  for (const row of rows) {
    if (row.role !== "attachment" || isHtmlBodyData(row)) continue;
    counts.set(row.eventId, (counts.get(row.eventId) ?? 0) + 1);
  }
  return counts;
}
