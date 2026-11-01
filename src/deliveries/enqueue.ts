// Puts the deliveries of an event into the delivery queue (src/deliveries/consumer.ts).

import { describeError } from "../auth/middleware";
import { findUnsentDeliveryIds } from "./queries";

// The message carries the delivery ID only; the consumer reads the rest from D1.
export type DeliveryMessage = { delivery_id: string };

// Queues accept up to 100 messages per sendBatch.
const SEND_BATCH_SIZE = 100;

export type EnqueueDeps = { db: D1Database; queue: Queue<DeliveryMessage> };

// Sends a message for every pending delivery of the event that was never tried. Returns false if sending
// failed; the intake then answers temporarily_unavailable, and the sender's retry (a duplicate) enqueues again.
// A delivery whose message is still waiting in the queue may be sent twice; receivers deduplicate with
// webhook-id.
export async function enqueuePendingDeliveries(deps: EnqueueDeps, eventId: string): Promise<boolean> {
  try {
    const ids = await findUnsentDeliveryIds(deps.db, eventId);
    for (let i = 0; i < ids.length; i += SEND_BATCH_SIZE) {
      await deps.queue.sendBatch(ids.slice(i, i + SEND_BATCH_SIZE).map((id) => ({ body: { delivery_id: id } })));
    }
    return true;
  } catch (error) {
    console.error("enqueueing deliveries failed", { eventId, ...describeError(error) });
    return false;
  }
}
