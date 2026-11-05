import { Hono } from "hono";
import { validator } from "hono/validator";
import type { Delivery, DeliveryList, DeliveryListItem, DeliveryStatus } from "../api/types";
import { apiError, clock, type Db, describeError } from "@i2bskn/workers-app-core";
import { requireUser } from "../core";
import {
  findWorkspaceDelivery,
  listSubscriptionDeliveries,
  listWorkspaceDeliveries,
  resetFailedDelivery,
  revertRetry,
  toApiDeliveries,
} from "../deliveries/queries";
import type { AppEnv } from "../env";
import { findWorkspaceEventScope, findWorkspaceEventsByIds } from "../events/queries";
import { DELIVERY_ID_PATTERN, EVENT_ID_PATTERN, SUBSCRIPTION_ID_PATTERN } from "../ids";
import { findSubscriptionById, isActiveSubscription } from "../subscriptions/queries";
import { requirePersonalWorkspace } from "./workspace";

const deliveryNotFound = "配信が見つかりません";

const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["pending", "delivered", "failed"];

function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(value);
}

type ListQuery = { cursor?: string; event_id?: string; status?: DeliveryStatus; subscription_id?: string };

// cursor: the last delivery id of the previous page. event_id: only the deliveries of that event. status: only the
// deliveries in that status. subscription_id: only the deliveries to that subscription. Any other value, including ""
// and a repeated parameter, is 400.
const listQuery = validator("query", (value: Record<string, string | string[]>, c) => {
  const query: ListQuery = {};
  const { cursor, event_id: eventId, status, subscription_id: subscriptionId } = value;
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
  if (status !== undefined) {
    if (typeof status !== "string" || !isDeliveryStatus(status)) {
      return apiError(c, 400, "invalid_status", "状態が正しくありません");
    }
    query.status = status;
  }
  if (subscriptionId !== undefined) {
    if (typeof subscriptionId !== "string" || !SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) {
      return apiError(c, 400, "invalid_subscription_id", "subscription_id が正しくありません");
    }
    query.subscription_id = subscriptionId;
  }
  return query;
});

// Adds the type, the summary and the source name of the event of each delivery, in one query for the events (and
// one for the names of their sources). The messages of conversations are found too.
async function withEvents(db: Db, workspaceId: string, deliveries: Delivery[]): Promise<DeliveryListItem[]> {
  const events = await findWorkspaceEventsByIds(
    db,
    workspaceId,
    deliveries.map((delivery) => delivery.event_id),
  );
  const byId = new Map(events.map((event) => [event.event_id, event]));
  return deliveries.map((delivery) => {
    const event = byId.get(delivery.event_id);
    return {
      ...delivery,
      event: event === undefined ? null : { type: event.type, summary: event.summary, source_name: event.source.name },
    };
  });
}

const deliveriesApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", listQuery, async (c) => {
    const { cursor, event_id: eventId, status, subscription_id: subscriptionId } = c.req.valid("query");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    // Scoped to the workspace: an event or a subscription of another workspace gives an empty list.
    const { deliveries, nextCursor } =
      subscriptionId === undefined
        ? await listWorkspaceDeliveries(db, workspaceId, { cursor, eventId, status })
        : await listSubscriptionDeliveries(c.env.DB, db, workspaceId, subscriptionId, { cursor, eventId, status });
    const body: DeliveryList = { deliveries: await withEvents(db, workspaceId, deliveries), next_cursor: nextCursor };
    return c.json(body, 200);
  })
  // Sends a failed delivery to a webhook destination or an MCP Events subscription again, from the first try. Allowed
  // whatever the bots link now and whether the conversation is stopped: the same delivery goes to the same
  // destination again. The consumer still checks that the destination is active when it sends.
  .post("/:id/retry", async (c) => {
    const id = c.req.param("id");
    if (!DELIVERY_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", deliveryNotFound);
    const db = c.get("db");
    const d1 = c.env.DB;
    const workspaceId = c.get("workspace").id;
    const row = await findWorkspaceDelivery(db, workspaceId, id);
    if (!row) return apiError(c, 404, "not_found", deliveryNotFound);
    const subscription = await findSubscriptionById(db, row.subscriptionId);
    if (!subscription) {
      return apiError(c, 409, "not_retryable", "配信先が見つからないため再送できません");
    }
    if (subscription.kind === "queue") {
      return apiError(c, 409, "not_retryable", "ポーリング用キューの配信は再送できません");
    }
    // A held event, or one waiting for the screening, is not sent: it is released (or screened) first.
    const scope = await findWorkspaceEventScope(db, workspaceId, row.eventId);
    if (scope?.screeningStatus === "held") {
      return apiError(c, 409, "screening_held", "イベントが保留中のため再送できません。先に保留を解除してください");
    }
    if (scope?.screeningStatus === "pending") {
      return apiError(c, 409, "screening_pending", "イベントの判定が終わっていないため再送できません");
    }
    if (row.status !== "failed") return apiError(c, 409, "not_retryable", "失敗した配信だけを再送できます");
    const now = clock.now();
    if (!isActiveSubscription(subscription, now)) {
      return apiError(c, 409, "not_retryable", "配信先が終了しているため再送できません");
    }
    // A retry at the same time (or a change of the status since the read above) updates nothing.
    if (!(await resetFailedDelivery(d1, workspaceId, id, now))) {
      return apiError(c, 409, "not_retryable", "失敗した配信だけを再送できます");
    }
    try {
      await c.env.DELIVERY_QUEUE.send({ delivery_id: id });
    } catch (error) {
      console.error("enqueueing a retried delivery failed", { deliveryId: id, ...describeError(error) });
      try {
        await revertRetry(d1, id, clock.now());
      } catch (revertError) {
        // Left pending without a message; see "配信の再送" in docs/api.md. The error goes to onError (500).
        console.error("reverting a retried delivery failed", { deliveryId: id, ...describeError(revertError) });
        throw revertError;
      }
      return apiError(
        c,
        503,
        "temporarily_unavailable",
        "再送を受け付けられませんでした。しばらくしてからもう一度お試しください",
      );
    }
    const updated = await findWorkspaceDelivery(db, workspaceId, id);
    if (!updated) return apiError(c, 404, "not_found", deliveryNotFound);
    const [delivery] = await withEvents(db, workspaceId, await toApiDeliveries(db, [updated]));
    if (!delivery) return apiError(c, 404, "not_found", deliveryNotFound);
    return c.json(delivery, 200);
  });

export default deliveriesApi;
