import { Hono } from "hono";
import { validator } from "hono/validator";
import type { EventList } from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import { deliverySummaries } from "../deliveries/queries";
import type { AppEnv } from "../env";
import {
  findEventDataOfEvent,
  findWorkspaceEvent,
  isWorkspaceProgramSource,
  listWorkspaceEvents,
} from "../events/queries";
import { DATA_REF_PATTERN, EVENT_ID_PATTERN, SOURCE_ID_PATTERN } from "../ids";
import { TYPE_MAX_LENGTH, TYPE_PATTERN } from "../intake/validation";
import { requirePersonalWorkspace } from "./workspace";

const eventNotFound = "イベントが見つかりません";
const dataNotFound = "データが見つかりません";

type ListQuery = { cursor?: string; type?: string; source_id?: string };

// cursor: the last event_id of the previous page. type: only the events of that type. source_id: only the events of
// that source. Any other value, including "" and a repeated parameter, is 400.
const listQuery = validator("query", (value: Record<string, string | string[]>, c) => {
  const query: ListQuery = {};
  const { cursor, type, source_id: sourceId } = value;
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
  return query;
});

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
    const { cursor, type, source_id: sourceId } = c.req.valid("query");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    // A source of another workspace (or the source of the conversations) gives an empty list, not 404.
    if (sourceId !== undefined && !(await isWorkspaceProgramSource(db, workspaceId, sourceId))) {
      const empty: EventList = { events: [], next_cursor: null };
      return c.json(empty, 200);
    }
    const { events, nextCursor } = await listWorkspaceEvents(db, workspaceId, {
      cursor,
      filter: type === undefined ? undefined : { types: [type] },
      sourceIds: sourceId === undefined ? undefined : [sourceId],
    });
    // Counted here rather than in listWorkspaceEvents, so that list_events of MCP runs no extra query.
    const summaries = await deliverySummaries(
      c.env.DB,
      workspaceId,
      events.map((event) => event.event_id),
    );
    const body: EventList = {
      events: events.map((event) => ({
        ...event,
        delivery_summary: summaries.get(event.event_id) ?? { delivered: 0, pending: 0, failed: 0 },
      })),
      next_cursor: nextCursor,
    };
    return c.json(body, 200);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!EVENT_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", eventNotFound);
    const event = await findWorkspaceEvent(c.get("db"), c.get("workspace").id, id);
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
