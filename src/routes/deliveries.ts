import { Hono } from "hono";
import { validator } from "hono/validator";
import type { DeliveryList } from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import { listWorkspaceDeliveries } from "../deliveries/queries";
import type { AppEnv } from "../env";
import { DELIVERY_ID_PATTERN, EVENT_ID_PATTERN } from "../ids";
import { requirePersonalWorkspace } from "./workspace";

type ListQuery = { cursor?: string; event_id?: string };

// cursor: the last delivery id of the previous page. event_id: only the deliveries of that event. Any other
// value, including "", is 400.
const listQuery = validator("query", (value: Record<string, string | string[]>, c) => {
  const query: ListQuery = {};
  const { cursor, event_id: eventId } = value;
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || !DELIVERY_ID_PATTERN.test(cursor)) {
      return apiError(c, 400, "invalid_cursor", "cursor が正しくありません");
    }
    query.cursor = cursor;
  }
  if (eventId !== undefined) {
    if (typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId)) {
      return apiError(c, 400, "invalid_event_id", "event_id が正しくありません");
    }
    query.event_id = eventId;
  }
  return query;
});

const deliveriesApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", listQuery, async (c) => {
    const { cursor, event_id: eventId } = c.req.valid("query");
    // Scoped to the workspace: an event of another workspace gives an empty list.
    const { deliveries, nextCursor } = await listWorkspaceDeliveries(c.get("db"), c.get("workspace").id, {
      cursor,
      eventId,
    });
    const body: DeliveryList = { deliveries, next_cursor: nextCursor };
    return c.json(body, 200);
  });

export default deliveriesApi;
