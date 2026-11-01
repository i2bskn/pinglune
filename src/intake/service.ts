// The shared intake (spec 4.2-4.4): validate, store the data in R2, write the event to D1, deduplicate.

import { describeError } from "../auth/middleware";
import { canonicalJson } from "../canonical-json";
import { createDb } from "../db/client";
import type { SubscriptionRow } from "../db/schema";
import { enqueuePendingDeliveries, type DeliveryMessage } from "../deliveries/enqueue";
import { insertDeliveryStatement } from "../deliveries/queries";
import { matchesFilter, type EventFilter } from "../events/filter";
import { newDataRef, newDeliveryId, newEventId, sha256Hex } from "../ids";
import { EVENT_NAME } from "../mcp/events";
import { findActiveWorkspaceSubscriptions } from "../subscriptions/queries";
import { eventDataKey } from "./storage";
import {
  intakeError,
  isPlainObject,
  validateIntakeInput,
  type IntakeError,
  type IntakeInput,
  type NormalizedInput,
} from "./validation";

export type IntakeDeps = {
  db: D1Database;
  bucket: R2Bucket;
  // The deliveries of a new event are queued before success is answered.
  queue: Queue<DeliveryMessage>;
  // UNIX ms: the received_at of a new event.
  now: number;
};

// An authenticated source. name is used to match subscriptions by source.
export type IntakeSource = { id: string; workspaceId: string; name: string; enabled: boolean };

export type AcceptResult = { ok: true; event_id: string; duplicate: boolean } | { ok: false; error: IntakeError };

type PreparedData = {
  dataRef: string;
  role: "body" | "attachment";
  name: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
  position: number;
};

type ExistingEvent = { id: string; request_hash: string };

function findEvent(db: D1Database, sourceId: string, idempotencyKey: string): Promise<ExistingEvent | null> {
  return db
    .prepare("SELECT id, request_hash FROM events WHERE source_id = ? AND idempotency_key = ?")
    .bind(sourceId, idempotencyKey)
    .first<ExistingEvent>();
}

// The hash that tells a retry of the same event from a different event with the same key (spec 4.3).
export function requestHash(
  input: NormalizedInput,
  bodySha256: string | null,
  attachmentSha256: string[],
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      type: input.type,
      summary: input.summary,
      occurred_at: input.occurredAt,
      labels: input.labels,
      body: input.body === null || bodySha256 === null ? null : { content_type: input.body.contentType, sha256: bodySha256 },
      attachments: input.attachments.map((a, i) => ({
        name: a.name,
        content_type: a.contentType,
        sha256: attachmentSha256[i] ?? "",
      })),
    }),
  );
}

// A retry of an existing event (spec 4.4). The deliveries that may have missed the queue (a previous enqueue
// failed) are queued again before success is answered.
async function duplicateResult(deps: IntakeDeps, existing: ExistingEvent, hash: string): Promise<AcceptResult> {
  if (existing.request_hash !== hash) return { ok: false, error: intakeError("idempotency_conflict") };
  if (!(await enqueuePendingDeliveries(deps, existing.id))) return unavailable();
  return { ok: true, event_id: existing.id, duplicate: true };
}

// The filter of a pinglune.event subscription, or null if the stored arguments are broken.
function parseFilter(value: string): EventFilter | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const { types, sources, labels } = parsed;
  if (types !== undefined && !Array.isArray(types)) return null;
  if (sources !== undefined && !Array.isArray(sources)) return null;
  if (labels !== undefined && !isPlainObject(labels)) return null;
  return parsed as EventFilter;
}

// The subscriptions that the event is delivered to.
function matchingSubscriptions(
  subscriptions: SubscriptionRow[],
  event: { type: string; sourceName: string; labels: Record<string, string> },
): SubscriptionRow[] {
  return subscriptions.filter((subscription) => {
    if (subscription.eventName !== EVENT_NAME) return false;
    const filter = parseFilter(subscription.arguments);
    if (filter === null) {
      console.error("intake: the arguments of a subscription are broken", { subscriptionId: subscription.id });
      return false;
    }
    return matchesFilter(event, filter);
  });
}

async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket.delete(keys);
  } catch (error) {
    console.error("intake: deleting stored objects failed", { count: keys.length, ...describeError(error) });
  }
}

function unavailable(): AcceptResult {
  return { ok: false, error: intakeError("temporarily_unavailable") };
}

export async function acceptEvent(deps: IntakeDeps, source: IntakeSource, input: IntakeInput): Promise<AcceptResult> {
  if (!source.enabled) return { ok: false, error: intakeError("source_disabled") };
  try {
    return await accept(deps, source, input);
  } catch (error) {
    console.error("intake: unexpected error", { sourceId: source.id, ...describeError(error) });
    return unavailable();
  }
}

async function accept(deps: IntakeDeps, source: IntakeSource, input: IntakeInput): Promise<AcceptResult> {
  const { db, bucket, now } = deps;

  // 1. Validate and normalize.
  const validated = validateIntakeInput(input);
  if (!validated.ok) return validated;
  const event = validated.value;

  // 2. request_hash.
  const bodySha256 = event.body === null ? null : await sha256Hex(event.body.bytes);
  const attachmentSha256 = await Promise.all(event.attachments.map((a) => sha256Hex(a.bytes)));
  const hash = await requestHash(event, bodySha256, attachmentSha256);

  // 3. Deduplicate.
  const existing = await findEvent(db, source.id, event.idempotencyKey);
  if (existing) return duplicateResult(deps, existing, hash);

  // The active subscriptions that the event matches, read before anything is stored.
  const subscriptions = matchingSubscriptions(
    await findActiveWorkspaceSubscriptions(createDb(db), source.workspaceId, now),
    { type: event.type, sourceName: source.name, labels: event.labels },
  );

  // 4. IDs.
  const eventId = newEventId(now);
  const data: PreparedData[] = [];
  if (event.body !== null && bodySha256 !== null) {
    data.push({
      dataRef: newDataRef(now),
      role: "body",
      name: "body",
      contentType: event.body.contentType,
      bytes: event.body.bytes,
      sha256: bodySha256,
      position: 0,
    });
  }
  event.attachments.forEach((attachment, index) => {
    data.push({
      dataRef: newDataRef(now),
      role: "attachment",
      name: attachment.name,
      contentType: attachment.contentType,
      bytes: attachment.bytes,
      sha256: attachmentSha256[index] ?? "",
      position: index + 1,
    });
  });

  // 5. Store the data in R2.
  // Objects stored here are orphaned if the Worker stops before D1 is written, or if the D1 write fails without
  // telling whether it committed. The daily cron (src/maintenance/daily.ts) deletes objects no row refers to.
  const stored: string[] = [];
  try {
    for (const item of data) {
      const key = eventDataKey(source.workspaceId, eventId, item.dataRef);
      await bucket.put(key, item.bytes, { httpMetadata: { contentType: item.contentType } });
      stored.push(key);
    }
  } catch (error) {
    console.error("intake: storing data in R2 failed", { sourceId: source.id, ...describeError(error) });
    // Nothing is written to D1 yet, so the stored objects can go.
    await deleteObjects(bucket, stored);
    return unavailable();
  }

  // 6. Write the event and its data to D1 in one batch.
  const statements = [
    db
      .prepare(
        `INSERT INTO events (id, workspace_id, source_id, idempotency_key, request_hash, type, summary, labels, occurred_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        eventId,
        source.workspaceId,
        source.id,
        event.idempotencyKey,
        hash,
        event.type,
        event.summary,
        JSON.stringify(event.labels),
        event.occurredAt ?? now,
        now,
      ),
    ...data.map((item) =>
      db
        .prepare(
          `INSERT INTO event_data (id, event_id, workspace_id, role, name, content_type, size, sha256, r2_key, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.dataRef,
          eventId,
          source.workspaceId,
          item.role,
          item.name,
          item.contentType,
          item.bytes.byteLength,
          item.sha256,
          eventDataKey(source.workspaceId, eventId, item.dataRef),
          item.position,
        ),
    ),
    // One statement per delivery: the batch is one transaction, so the event is never stored without them.
    ...subscriptions.map((subscription) =>
      insertDeliveryStatement(db, {
        id: newDeliveryId(now),
        eventId,
        subscriptionId: subscription.id,
        workspaceId: source.workspaceId,
        now,
      }),
    ),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    console.error("intake: writing the event to D1 failed", { sourceId: source.id, ...describeError(error) });
    // D1 may have committed even though it threw, so check before touching R2. The kind of the error
    // (e.g. a UNIQUE violation) is not relied on.
    let found: ExistingEvent | null;
    try {
      found = await findEvent(db, source.id, event.idempotencyKey);
    } catch (lookupError) {
      console.error("intake: looking up the event after a failed write failed", {
        sourceId: source.id,
        ...describeError(lookupError),
      });
      // Unknown outcome: keep R2.
      return unavailable();
    }
    if (found === null) {
      // The write may still commit later, so R2 is kept; an orphan is deleted by the daily cron.
      return unavailable();
    }
    if (found.id !== eventId) {
      // Another request with the same key wrote first; this request's objects are not referenced.
      await deleteObjects(bucket, stored);
      return duplicateResult(deps, found, hash);
    }
    // Our write committed.
  }

  // 7. Queue the deliveries before answering success. If this fails the event is stored; the sender retries
  // with the same idempotency_key and the duplicate path queues them again.
  if (!(await enqueuePendingDeliveries(deps, eventId))) return unavailable();
  return { ok: true, event_id: eventId, duplicate: false };
}
