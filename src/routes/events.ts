import { Hono, type Context } from "hono";
import { validator } from "hono/validator";
import type { EmailHtmlView, EmailView, EventList, ManagedEventDetail } from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import { clock } from "../clock";
import { enqueuePendingDeliveries, enqueueScreening } from "../deliveries/enqueue";
import { deliverySummaries } from "../deliveries/queries";
import type { AppEnv } from "../env";
import {
  emptyHeaders,
  htmlToText,
  isEmailBodyData,
  isHtmlBodyData,
  isHtmlOnlyText,
  parseEmailBody,
  readTextPrefix,
} from "../events/email-view";
import {
  countEmailAttachments,
  findEmailEvent,
  findEventDataOfEvent,
  findWorkspaceEvent,
  findWorkspaceEventScreening,
  isWorkspaceProgramSource,
  listEventDataRows,
  listWorkspaceEvents,
  sourceNames,
  type EmailEventRecord,
  type EventDataListRow,
} from "../events/queries";
import { EMAIL_EVENT_TYPE } from "../intake/email";
import { isRetryableScreeningError } from "../screening/state";
import { DATA_REF_PATTERN, EVENT_ID_PATTERN, SOURCE_ID_PATTERN } from "../ids";
import { TYPE_MAX_LENGTH, TYPE_PATTERN } from "../intake/validation";
import { requirePersonalWorkspace } from "./workspace";

const eventNotFound = "イベントが見つかりません";
const dataNotFound = "データが見つかりません";

type ListQuery = { cursor?: string; type?: string; source_id?: string; screening?: "held" | "pending" };

// cursor: the last event_id of the previous page. type: only the events of that type. source_id: only the events of
// that source. screening: only the events held or waiting for the screening. Any other value, including "" and a
// repeated parameter, is 400.
const listQuery = validator("query", (value: Record<string, string | string[]>, c) => {
  const query: ListQuery = {};
  const { cursor, type, source_id: sourceId, screening } = value;
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || !EVENT_ID_PATTERN.test(cursor)) {
      return apiError(c, 400, "invalid_cursor", "cursor が正しくありません");
    }
    query.cursor = cursor;
  }
  if (type !== undefined) {
    if (typeof type !== "string" || type.length > TYPE_MAX_LENGTH || !TYPE_PATTERN.test(type)) {
      return apiError(c, 400, "invalid_type", "種類が正しくありません");
    }
    query.type = type;
  }
  if (sourceId !== undefined) {
    if (typeof sourceId !== "string" || !SOURCE_ID_PATTERN.test(sourceId)) {
      return apiError(c, 400, "invalid_source_id", "送信元が正しくありません");
    }
    query.source_id = sourceId;
  }
  if (screening !== undefined) {
    if (screening !== "held" && screening !== "pending") {
      return apiError(c, 400, "invalid_screening", "判定の状態が正しくありません");
    }
    query.screening = screening;
  }
  return query;
});

// A screening message sent again for an event pending for this long may be asked for from the screen.
const SCREENING_RESEND_AFTER_MS = 10 * 60 * 1000;

type ScreeningRecord = {
  screening_status: string | null;
  screening_error: string | null;
  screening_requested_at: number | null;
  conversation_id: string | null;
};

// The screening of an event of programs in the workspace; null for an event of another workspace and for a message of
// a conversation.
async function findScreeningRecord(d1: D1Database, workspaceId: string, id: string): Promise<ScreeningRecord | null> {
  const row = await d1
    .prepare(
      "SELECT screening_status, screening_error, screening_requested_at, conversation_id FROM events WHERE id = ? AND workspace_id = ?",
    )
    .bind(id, workspaceId)
    .first<ScreeningRecord>();
  return row === null || row.conversation_id !== null ? null : row;
}

// The event as GET /api/v1/events/:id returns it, with its screening.
async function managedEvent(c: Context<AppEnv>, id: string): Promise<ManagedEventDetail | null> {
  const db = c.get("db");
  const workspaceId = c.get("workspace").id;
  const event = await findWorkspaceEvent(db, workspaceId, id);
  if (!event) return null;
  const screening = await findWorkspaceEventScreening(db, workspaceId, id);
  return { ...event, screening: screening ?? null };
}

// An email.received event of programs in the workspace with its data rows, or null (404): another workspace's
// event, a message of a conversation and an event of another type are not found.
async function findEmailEventWithData(
  c: Context<AppEnv>,
  id: string,
): Promise<{ event: EmailEventRecord; rows: EventDataListRow[] } | null> {
  const db = c.get("db");
  const workspaceId = c.get("workspace").id;
  const event = await findEmailEvent(db, workspaceId, id);
  if (!event || event.type !== EMAIL_EVENT_TYPE || event.conversationId !== null) return null;
  const rows = await listEventDataRows(db, workspaceId, id);
  return { event, rows };
}

const enqueueFailedMessage = "配信を受け付けられませんでした。しばらくしてからもう一度お試しください";
const screeningEnqueueFailedMessage = "判定を受け付けられませんでした。しばらくしてからもう一度お試しください";

// The Content-Types served as they are. Anything else, including HTML and SVG, is served as
// application/octet-stream, so that what a source wrote never runs on this origin.
const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SAFE_TEXT_TYPES = new Set(["text/plain", "text/csv"]);

// The charset parameter of a Content-Type, lowercased and unquoted; null without one. "" when it is given more than
// once with different values, so that it is never taken as UTF-8.
function charsetOf(params: string[]): string | null {
  let charset: string | null = null;
  for (const param of params) {
    const index = param.indexOf("=");
    if (index < 0 || param.slice(0, index).trim().toLowerCase() !== "charset") continue;
    const value = param
      .slice(index + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .toLowerCase();
    if (charset !== null && charset !== value) return "";
    charset = value;
  }
  return charset;
}

// The Content-Type to serve a stored data item with.
export function servedContentType(stored: string): string {
  const [essence = "", ...params] = stored.split(";");
  const type = essence.trim().toLowerCase();
  if (SAFE_IMAGE_TYPES.has(type)) return type;
  // JSON is UTF-8 (RFC 8259).
  if (type === "application/json") return "application/json; charset=utf-8";
  if (SAFE_TEXT_TYPES.has(type)) {
    const charset = charsetOf(params);
    if (charset === null || charset === "utf-8") return `${type}; charset=utf-8`;
  }
  return "application/octet-stream";
}

// Content-Disposition with the name in the filename* parameter (RFC 5987, RFC 6266). Always an attachment: the
// response is never shown as a page.
export function attachmentDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

const eventsApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", listQuery, async (c) => {
    const { cursor, type, source_id: sourceId, screening } = c.req.valid("query");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    // A source of another workspace (or the source of the conversations) gives an empty list, not 404.
    if (sourceId !== undefined && !(await isWorkspaceProgramSource(db, workspaceId, sourceId))) {
      const empty: EventList = { events: [], next_cursor: null };
      return c.json(empty, 200);
    }
    // The management screen lists the events held or waiting for the screening too.
    const { events, screenings, nextCursor } = await listWorkspaceEvents(db, workspaceId, {
      cursor,
      filter: type === undefined ? undefined : { types: [type] },
      sourceIds: sourceId === undefined ? undefined : [sourceId],
      includeScreened: true,
      screening,
    });
    // Counted here rather than in listWorkspaceEvents, so that list_events of MCP runs no extra query.
    const summaries = await deliverySummaries(
      c.env.DB,
      workspaceId,
      events.map((event) => event.event_id),
    );
    // The list has no messages of conversations, so every email.received event here gets the email item.
    const emailIds = events.filter((event) => event.type === EMAIL_EVENT_TYPE).map((event) => event.event_id);
    const attachmentCounts = await countEmailAttachments(db, workspaceId, emailIds);
    const body: EventList = {
      events: events.map((event) => ({
        ...event,
        delivery_summary: summaries.get(event.event_id) ?? { delivered: 0, pending: 0, failed: 0 },
        screening: screenings.get(event.event_id) ?? null,
        email:
          event.type === EMAIL_EVENT_TYPE
            ? { from: event.labels.from ?? null, attachment_count: attachmentCounts.get(event.event_id) ?? 0 }
            : null,
      })),
      next_cursor: nextCursor,
    };
    return c.json(body, 200);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!EVENT_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", eventNotFound);
    const event = await managedEvent(c, id);
    if (!event) return apiError(c, 404, "not_found", eventNotFound);
    return c.json(event, 200);
  })
  // An email.received event read as a message: the header lines and the text of the body, the HTML body (converted
  // by /email/html, so that a failure there leaves this one working) and the attachments. Held and pending events are
  // shown too: this is the management screen only.
  .get("/:id/email", async (c) => {
    const id = c.req.param("id");
    if (!EVENT_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", eventNotFound);
    const found = await findEmailEventWithData(c, id);
    if (!found) return apiError(c, 404, "not_found", eventNotFound);
    const { event, rows } = found;
    const names = await sourceNames(c.get("db"), [event.sourceId]);
    const from = event.labels.from ?? null;

    let headers = emptyHeaders();
    let text: string | null = null;
    let textTruncated = false;
    const bodyRow = rows.find((row) => row.role === "body");
    if (bodyRow !== undefined && isEmailBodyData(bodyRow)) {
      const read = await readTextPrefix(c.env.EVENT_DATA, bodyRow);
      if (read === null) {
        console.error("email view: body object not found", { eventId: id, dataRef: bodyRow.id });
      } else {
        const parsed = parseEmailBody(read.text, { summary: event.summary, from });
        headers = parsed.headers;
        text = parsed.text;
        textTruncated = read.truncated;
      }
    }
    const htmlRow = rows.find(isHtmlBodyData);
    const body: EmailView = {
      event_id: event.id,
      source: { id: event.sourceId, name: names.get(event.sourceId) ?? "" },
      from_address: from,
      headers,
      text,
      text_truncated: textTruncated,
      html_only: text !== null && isHtmlOnlyText(text),
      html: htmlRow === undefined ? null : { data_ref: htmlRow.id, size: htmlRow.size },
      attachments: rows
        .filter((row) => row.role === "attachment" && !isHtmlBodyData(row))
        .map((row) => ({ data_ref: row.id, name: row.name, content_type: row.contentType, size: row.size })),
    };
    return c.json(body, 200);
  })
  // The HTML body of an email.received event converted to text, and its source, both from its first 256 KiB. 404
  // when the event has no HTML body.
  .get("/:id/email/html", async (c) => {
    const id = c.req.param("id");
    if (!EVENT_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", eventNotFound);
    const found = await findEmailEventWithData(c, id);
    const htmlRow = found?.rows.find(isHtmlBodyData);
    if (!found || htmlRow === undefined) return apiError(c, 404, "not_found", eventNotFound);
    const read = await readTextPrefix(c.env.EVENT_DATA, htmlRow);
    if (read === null) {
      console.error("email view: HTML body object not found", { eventId: id, dataRef: htmlRow.id });
      const missing: EmailHtmlView = { text: null, source: null, truncated: false };
      return c.json(missing, 200);
    }
    let text: string | null = null;
    try {
      text = await htmlToText(read.text);
    } catch {
      // Only the event: the error may carry what the sender wrote.
      console.error("email view: converting the HTML body failed", { eventId: id });
    }
    const body: EmailHtmlView = { text, source: read.text, truncated: read.truncated };
    return c.json(body, 200);
  })
  // Releases a held event and queues its deliveries. For a released event, only queues them again (a previous enqueue
  // may have failed). The first release is recorded; a later one does not overwrite it.
  .post("/:id/screening/release", async (c) => {
    const id = c.req.param("id");
    if (!EVENT_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", eventNotFound);
    const d1 = c.env.DB;
    const workspaceId = c.get("workspace").id;
    const record = await findScreeningRecord(d1, workspaceId, id);
    if (!record) return apiError(c, 404, "not_found", eventNotFound);
    if (record.screening_status === "held") {
      const now = clock.now();
      const result = await d1
        .prepare(
          `UPDATE events SET screening_status = 'released', screening_released_at = COALESCE(screening_released_at, ?),
            screening_released_by = COALESCE(screening_released_by, ?)
          WHERE id = ? AND workspace_id = ? AND screening_status = 'held'`,
        )
        .bind(now, c.get("user").id, id, workspaceId)
        .run();
      // Released at the same time by another request: the deliveries are queued again all the same.
      if ((result.meta.changes ?? 0) === 0) {
        const current = await findScreeningRecord(d1, workspaceId, id);
        if (current?.screening_status !== "released") {
          return apiError(c, 409, "not_releasable", "保留中のイベントだけを解除できます");
        }
      }
    } else if (record.screening_status !== "released") {
      return apiError(c, 409, "not_releasable", "保留中のイベントだけを解除できます");
    }
    if (!(await enqueuePendingDeliveries({ db: d1, queue: c.env.DELIVERY_QUEUE }, id))) {
      // Left released: the same operation queues the deliveries again.
      return apiError(c, 503, "temporarily_unavailable", enqueueFailedMessage);
    }
    const event = await managedEvent(c, id);
    if (!event) return apiError(c, 404, "not_found", eventNotFound);
    return c.json(event, 200);
  })
  // Screens an event again: one held for a reason that a change of the settings or time may fix (made pending again),
  // or one pending for 10 minutes or more (its message sent again). An event held by its score is never screened again.
  .post("/:id/screening/retry", async (c) => {
    const id = c.req.param("id");
    if (!EVENT_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", eventNotFound);
    const d1 = c.env.DB;
    const workspaceId = c.get("workspace").id;
    const record = await findScreeningRecord(d1, workspaceId, id);
    if (!record) return apiError(c, 404, "not_found", eventNotFound);
    const now = clock.now();
    if (record.screening_status === "held" && isRetryableScreeningError(record.screening_error)) {
      const result = await d1
        .prepare(
          `UPDATE events SET screening_status = 'pending', screening_score = NULL, screening_error = NULL, screened_at = NULL,
            screening_requested_at = ?
          WHERE id = ? AND workspace_id = ? AND screening_status = 'held' AND screening_error = ?`,
        )
        .bind(now, id, workspaceId, record.screening_error)
        .run();
      if ((result.meta.changes ?? 0) === 0) {
        return apiError(c, 409, "not_retryable", "この状態のイベントは判定し直せません");
      }
    } else if (
      record.screening_status !== "pending" ||
      record.screening_requested_at === null ||
      now - record.screening_requested_at < SCREENING_RESEND_AFTER_MS
    ) {
      return apiError(c, 409, "not_retryable", "この状態のイベントは判定し直せません");
    }
    // Left pending if this fails: the daily maintenance sends the message again.
    if (!(await enqueueScreening({ queue: c.env.DELIVERY_QUEUE }, id))) {
      return apiError(c, 503, "temporarily_unavailable", screeningEnqueueFailedMessage);
    }
    const event = await managedEvent(c, id);
    if (!event) return apiError(c, 404, "not_found", eventNotFound);
    return c.json(event, 200);
  })
  // The contents of the body or an attachment of an event of the workspace, including the messages of
  // conversations. What a source sent is served on this origin, so the headers are built by hand (never from the
  // metadata stored in R2): a safe Content-Type or application/octet-stream, always an attachment, no sniffing and
  // a sandbox.
  .get("/:id/data/:dataRef", async (c) => {
    const id = c.req.param("id");
    const dataRef = c.req.param("dataRef");
    if (!EVENT_ID_PATTERN.test(id) || !DATA_REF_PATTERN.test(dataRef)) {
      return apiError(c, 404, "not_found", dataNotFound);
    }
    const row = await findEventDataOfEvent(c.get("db"), c.get("workspace").id, id, dataRef);
    if (!row) return apiError(c, 404, "not_found", dataNotFound);
    const object = await c.env.EVENT_DATA.get(row.r2Key);
    if (object === null) {
      console.error("event data object not found", { eventId: id, dataRef });
      return apiError(c, 404, "not_found", dataNotFound);
    }
    return c.body(object.body, 200, {
      "Content-Type": servedContentType(row.contentType),
      "Content-Disposition": attachmentDisposition(row.name),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
      "Content-Length": String(object.size),
    });
  });

export default eventsApi;
