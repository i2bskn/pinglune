import { Hono } from "hono";
import { validator } from "hono/validator";
import type { EventList } from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import type { AppEnv } from "../env";
import { findWorkspaceEvent, listWorkspaceEvents } from "../events/queries";
import { EVENT_ID_PATTERN } from "../ids";
import { requirePersonalWorkspace } from "./workspace";

const eventNotFound = "イベントが見つかりません";

type ListQuery = { cursor?: string };

// cursor: the last event_id of the previous page. Any other value, including "", is 400.
const listQuery = validator("query", (value: Record<string, string | string[]>, c) => {
  const cursor = value.cursor;
  if (cursor === undefined) return {} as ListQuery;
  if (typeof cursor !== "string" || !EVENT_ID_PATTERN.test(cursor)) {
    return apiError(c, 400, "invalid_cursor", "cursor が正しくありません");
  }
  return { cursor } as ListQuery;
});

const eventsApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", listQuery, async (c) => {
    const { cursor } = c.req.valid("query");
    const { events, nextCursor } = await listWorkspaceEvents(c.get("db"), c.get("workspace").id, { cursor });
    const body: EventList = { events, next_cursor: nextCursor };
    return c.json(body, 200);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!EVENT_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", eventNotFound);
    const event = await findWorkspaceEvent(c.get("db"), c.get("workspace").id, id);
    if (!event) return apiError(c, 404, "not_found", eventNotFound);
    return c.json(event, 200);
  });

export default eventsApi;
