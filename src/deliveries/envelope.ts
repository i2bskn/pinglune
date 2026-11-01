// The body of a pinglune.event webhook (MCP Events). data is the get_event result (eventPayloadSchema).

import type { EventDetail } from "../api/types";
import { iso, toMcpEventDetail } from "../mcp/event-payload";
import { EVENT_NAME } from "../mcp/events";

// There is no replay, so cursor is always null. No top-level "type": that key marks control messages such as
// the callback verification.
export function deliveryEnvelope(event: EventDetail) {
  return {
    eventId: event.event_id,
    name: EVENT_NAME,
    timestamp: iso(event.occurred_at),
    data: toMcpEventDetail(event),
    cursor: null,
  };
}
