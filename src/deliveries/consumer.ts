// The consumers of the delivery queue and of its dead letter queue (wrangler.jsonc).
//
// A message is one delivery, or the screening of one event ({ kind: "screen" }, src/screening/service.ts). Each
// delivery message is one delivery. The consumer reads the delivery, checks that the subscription is still active and
// that its user still has access to the workspace, builds the envelope from D1 and sends a webhook: signed for MCP
// Events subscriptions, with the Bearer key for webhook destinations. Sends
// that may succeed later are retried with a delay of 30 seconds doubling up to 5 times (about 15 minutes in
// total); the number of tries is counted in D1. Every state change is conditional on the delivery being pending,
// so that a delivery processed twice at the same time is never overwritten.

import { describeError } from "../auth/middleware";
import { clock } from "../clock";
import { createDb, type Db } from "../db/client";
import type { DeliveryRow, SubscriptionRow } from "../db/schema";
import { loadConfig, type Bindings } from "../env";
import { findWorkspaceEvent, findWorkspaceEventScope } from "../events/queries";
import { DELIVERY_ID_PATTERN, EVENT_ID_PATTERN } from "../ids";
import {
  processScreening,
  processScreeningDeadLetter,
  screeningThreshold,
  type ScreeningDeps,
} from "../screening/service";
import { isDeliverableScreening } from "../screening/state";
import { decryptSecret, subscriptionSecretKey } from "../subscriptions/secret";
import { findSubscriptionById } from "../subscriptions/queries";
import { appOriginHost } from "../webhooks/destination";
import { sendWebhook, type SendResult, type WebhookAuth } from "../webhooks/send";
import { findPersonalWorkspaceByUserId } from "../workspaces/queries";
import { deliveryEnvelope } from "./envelope";
import { failPendingDelivery, findDeliveryById, MAX_ATTEMPTS, recordAttempt, type DeliveryStatus } from "./queries";

export const DEAD_LETTER_QUEUE = "pinglune-deliveries-dlq";

// The largest body sent; larger events fail without a send.
export const MAX_PAYLOAD_BYTES = 262_144;
// The previous secret also signs for this long after a rotation.
const PREVIOUS_SECRET_MS = 60 * 60 * 1000;
const RETRY_BASE_SECONDS = 30;
// When the configuration is invalid, messages wait for it to be fixed.
const CONFIG_RETRY_SECONDS = 300;
const DEAD_LETTER_RETRY_SECONDS = 60;

const encoder = new TextEncoder();

type ConsumerDeps = { d1: D1Database; db: Db; jwtSecret: string; selfHosts: string[]; screening: ScreeningDeps };

// 30, 60, 120, 240, 480 seconds after the 1st to 5th try.
function retryDelaySeconds(attempts: number): number {
  return RETRY_BASE_SECONDS * 2 ** (attempts - 1);
}

type ParsedMessage = { kind: "delivery"; id: string } | { kind: "screen"; eventId: string };

// What the message asks for, or null if it is malformed (an unknown kind, or an ID that is not a string of the
// right form).
function parseMessage(message: Message<unknown>): ParsedMessage | null {
  const body = message.body;
  if (typeof body !== "object" || body === null) return null;
  if ("kind" in body) {
    const { kind, event_id: eventId } = body as { kind?: unknown; event_id?: unknown };
    if (kind !== "screen" || typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId)) return null;
    return { kind: "screen", eventId };
  }
  const id = (body as { delivery_id?: unknown }).delivery_id;
  return typeof id === "string" && DELIVERY_ID_PATTERN.test(id) ? { kind: "delivery", id } : null;
}

// Whether the subscription may still receive the delivery: active, in the delivery's workspace, and its user
// still owns that workspace. The personal workspace is deleted with the user, so finding it also shows that the
// user exists.
async function hasAccess(db: Db, delivery: DeliveryRow, subscription: SubscriptionRow, now: number) {
  if (subscription.unsubscribedAt !== null || subscription.expiresAt <= now) return false;
  if (subscription.workspaceId !== delivery.workspaceId) return false;
  const workspace = await findPersonalWorkspaceByUserId(db, subscription.userId);
  return workspace !== undefined && workspace.id === subscription.workspaceId;
}

// The secrets that sign the webhook, or null if the current one cannot be decrypted.
async function signingSecrets(
  jwtSecret: string,
  subscription: SubscriptionRow,
  now: number,
): Promise<Uint8Array<ArrayBuffer>[] | null> {
  const key = await subscriptionSecretKey(jwtSecret);
  const current = await decryptSecret(key, subscription.id, subscription.secret);
  if (current === null) return null;
  const secrets = [current];
  if (
    subscription.previousSecret !== null &&
    subscription.secretRotatedAt !== null &&
    now - subscription.secretRotatedAt < PREVIOUS_SECRET_MS
  ) {
    const previous = await decryptSecret(key, subscription.id, subscription.previousSecret);
    if (previous !== null) secrets.push(previous);
  }
  return secrets;
}

// The Bearer key of a webhook destination, or null if it cannot be decrypted.
async function bearerToken(jwtSecret: string, subscription: SubscriptionRow): Promise<string | null> {
  const key = await subscriptionSecretKey(jwtSecret);
  const token = await decryptSecret(key, subscription.id, subscription.secret);
  return token === null ? null : new TextDecoder().decode(token);
}

// The kind of a subscription, or null for a value that this code does not know. The column has no CHECK
// constraint, so a row may hold any value.
function kindOf(subscription: SubscriptionRow): SubscriptionRow["kind"] | null {
  const kind: string = subscription.kind;
  return kind === "mcp" || kind === "webhook" || kind === "queue" ? kind : null;
}

// The kinds that are sent as webhooks.
type SentKind = Exclude<SubscriptionRow["kind"], "queue">;

// How the webhook is authenticated, or null if its secret cannot be decrypted. Only MCP Events subscriptions
// rotate secrets, so only they also sign with the previous one.
async function authOf(
  jwtSecret: string,
  subscription: SubscriptionRow,
  kind: SentKind,
  now: number,
): Promise<WebhookAuth | null> {
  if (kind === "webhook") {
    const token = await bearerToken(jwtSecret, subscription);
    return token === null ? null : { kind: "bearer", token };
  }
  const secrets = await signingSecrets(jwtSecret, subscription, now);
  return secrets === null ? null : { kind: "signature", secrets };
}

// The new status after a send, given the number of tries including it.
function statusAfter(result: SendResult, attempts: number): DeliveryStatus {
  if (result.ok) return "delivered";
  // The receiver does not want the event (410) or cannot take it (413): retrying does not help.
  if (result.reason === "http_4xx" && (result.status === 410 || result.status === 413)) return "failed";
  // The destination may become allowed when DNS changes, but it is not retried to stay on the safe side.
  if (result.reason === "blocked_destination") return "failed";
  return attempts >= MAX_ATTEMPTS ? "failed" : "pending";
}

// Steps 2 to 8 of one message. Throws on unexpected errors (D1, for example); the caller retries.
async function deliver(deps: ConsumerDeps, message: Message<unknown>, id: string): Promise<void> {
  const { d1, db } = deps;
  const delivery = await findDeliveryById(db, id);
  // Deleted with the user, or processed already.
  if (!delivery || delivery.status !== "pending") {
    message.ack();
    return;
  }
  // The event is held or waiting for the screening: the delivery stays pending, and is queued again when the event
  // passes or is released.
  const scope = await findWorkspaceEventScope(db, delivery.workspaceId, delivery.eventId);
  if (scope && !isDeliverableScreening(scope.screeningStatus)) {
    message.ack();
    return;
  }
  const now = clock.now();
  const fail = async (reason: string) => {
    await failPendingDelivery(d1, id, reason, now);
    message.ack();
  };

  const subscription = await findSubscriptionById(db, delivery.subscriptionId);
  if (!subscription || !(await hasAccess(db, delivery, subscription, now))) {
    await fail("subscription_inactive");
    return;
  }
  const kind = kindOf(subscription);
  if (kind === null) {
    console.error("delivery: unknown subscription kind", { deliveryId: id });
    await fail("subscription_inactive");
    return;
  }
  // Deliveries to polling queues are never queued (findUnsentDeliveryIds), but a message may come from an older
  // Worker. The delivery is left pending for claim_events.
  if (kind === "queue") {
    console.warn("delivery: queue delivery in the delivery queue", { deliveryId: id });
    message.ack();
    return;
  }

  const event = await findWorkspaceEvent(db, delivery.workspaceId, delivery.eventId);
  if (!event) {
    await fail("event_not_found");
    return;
  }

  // Serialized once: the signature (of MCP Events subscriptions) covers these exact bytes.
  const body = encoder.encode(JSON.stringify(deliveryEnvelope(event)));
  if (body.byteLength > MAX_PAYLOAD_BYTES) {
    await fail("payload_too_large");
    return;
  }

  const auth = await authOf(deps.jwtSecret, subscription, kind, now);
  if (auth === null) {
    await fail("secret_unavailable");
    return;
  }

  const url = new URL(subscription.callbackUrl);
  const result = await sendWebhook(
    {
      url,
      subscriptionId: subscription.id,
      // webhook-id is the event ID, the same on every retry, so that receivers can deduplicate.
      msgId: event.event_id,
      timestampSec: Math.floor(now / 1000),
      body,
      auth,
    },
    { selfHosts: deps.selfHosts },
  );

  const attempts = delivery.attempts + 1;
  const status = statusAfter(result, attempts);
  const updated = await recordAttempt(d1, id, delivery.attempts, {
    status,
    httpStatus: result.status ?? null,
    error: result.ok ? null : result.reason,
    now,
  });
  // Another consumer recorded this try first; it decides what happens next.
  if (!updated) {
    message.ack();
    return;
  }
  if (status === "pending") {
    message.retry({ delaySeconds: retryDelaySeconds(attempts) });
    return;
  }
  if (status === "failed") {
    // Never the whole URL or the body.
    console.warn("delivery failed", {
      deliveryId: id,
      host: url.hostname,
      reason: result.ok ? null : result.reason,
      status: result.status ?? null,
      attempts,
    });
  }
  message.ack();
}

async function processDelivery(deps: ConsumerDeps, message: Message<unknown>): Promise<void> {
  const parsed = parseMessage(message);
  if (parsed === null) {
    console.error("delivery message is malformed", { messageId: message.id });
    message.ack();
    return;
  }
  if (parsed.kind === "screen") {
    await processScreening(deps.screening, message, parsed.eventId);
    return;
  }
  const id = parsed.id;
  try {
    await deliver(deps, message, id);
  } catch (error) {
    console.error("delivery failed unexpectedly", { deliveryId: id, ...describeError(error) });
    // D1 is not updated: it may be the cause. The number of tries in D1 is unknown here, so the delay follows
    // the queue's count; after max_retries the message goes to the dead letter queue.
    message.retry({ delaySeconds: retryDelaySeconds(Math.min(message.attempts, MAX_ATTEMPTS)) });
  }
}

// A message that the delivery consumer could not finish (exceptions beyond max_retries). The delivery is recorded
// as failed if it is still pending. If this keeps failing too, the message is dropped and the delivery stays
// pending; the daily check logs it.
// A screening message holds its event if it is still pending (screening_unavailable), and queues the deliveries of a
// passed or released event again.
async function processDeadLetter(deps: ConsumerDeps, message: Message<unknown>): Promise<void> {
  const parsed = parseMessage(message);
  if (parsed === null) {
    console.error("dead-lettered delivery message is malformed", { messageId: message.id });
    message.ack();
    return;
  }
  if (parsed.kind === "screen") {
    try {
      if (await processScreeningDeadLetter(deps.screening, message, parsed.eventId)) {
        message.ack();
      } else {
        message.retry({ delaySeconds: DEAD_LETTER_RETRY_SECONDS });
      }
    } catch (error) {
      console.error("recording a dead-lettered screening failed", { eventId: parsed.eventId, ...describeError(error) });
      message.retry({ delaySeconds: DEAD_LETTER_RETRY_SECONDS });
    }
    return;
  }
  const id = parsed.id;
  try {
    await failPendingDelivery(deps.d1, id, "dead_lettered", clock.now());
    message.ack();
  } catch (error) {
    console.error("recording a dead-lettered delivery failed", { deliveryId: id, ...describeError(error) });
    message.retry({ delaySeconds: DEAD_LETTER_RETRY_SECONDS });
  }
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  const config = loadConfig(env);
  if (!config.ok) {
    console.error("invalid configuration", { invalid: config.invalid });
    // Processed again once the configuration is fixed.
    for (const message of batch.messages) message.retry({ delaySeconds: CONFIG_RETRY_SECONDS });
    return;
  }
  const appHost = appOriginHost(env.APP_ORIGIN);
  const deps: ConsumerDeps = {
    d1: env.DB,
    db: createDb(env.DB),
    jwtSecret: config.config.jwtSecret,
    // There is no request host here; callbacks to APP_ORIGIN are blocked.
    selfHosts: appHost === null ? [] : [appHost],
    screening: {
      d1: env.DB,
      bucket: env.EVENT_DATA,
      queue: env.DELIVERY_QUEUE,
      jwtSecret: config.config.jwtSecret,
      threshold: screeningThreshold(env.SCREENING_THRESHOLD),
    },
  };
  // Concurrently: one send takes up to about 20 seconds.
  const process = batch.queue === DEAD_LETTER_QUEUE ? processDeadLetter : processDelivery;
  await Promise.all(batch.messages.map((message) => process(deps, message)));
}
