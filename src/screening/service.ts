// The screening of the events of the sources with screening turned on: the consumer of the screening messages
// ({ kind: "screen", event_id }) of the delivery queue.
//
// The event is pending until it is screened. Its input (src/screening/input.ts) is sent to Jev with the TypeSafe API
// key of its workspace; a score at or above the threshold holds the event, a lower one passes it and queues its
// deliveries. An event that cannot be screened is held rather than passed. The score is taken once: retries of the
// sender, releases and redeliveries never screen again. Every change of the state is conditional on the event being
// pending, so that two consumers of the same event at the same time write one result.

import { clock, describeError } from "@i2bskn/workers-app-core";
import { enqueuePendingDeliveries, type DeliveryMessage } from "../deliveries/enqueue";
import { decryptApiKey } from "./api-key";
import { callJev, type JevResult, type JevState } from "./jev";
import { buildScreeningInput, type ScreeningData } from "./input";
import { parseScreeningStatus, type ScreeningError } from "./state";

export const DEFAULT_SCREENING_THRESHOLD = 0.5;
const RETRY_BASE_SECONDS = 30;
const MAX_RETRY_SECONDS = 43_200;
// Requests sent to Jev at the same time for one event.
const CONCURRENCY = 2;
// Reads of the event after a conditional update that changed nothing.
const MAX_ROUNDS = 3;

export type ScreeningDeps = {
  d1: D1Database;
  bucket: R2Bucket;
  queue: Queue<DeliveryMessage>;
  jwtSecret: string;
  threshold: number;
};

// SCREENING_THRESHOLD: a number greater than 0 and at most 1. Unset is 0.5; anything else is 0.5 with a warning, so
// that a mistake in this optional setting does not stop the rest (it is not checked by loadConfig).
export function screeningThreshold(value: unknown): number {
  if (value === undefined || value === "") return DEFAULT_SCREENING_THRESHOLD;
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    console.warn("invalid SCREENING_THRESHOLD; using the default", { default: DEFAULT_SCREENING_THRESHOLD });
    return DEFAULT_SCREENING_THRESHOLD;
  }
  return parsed;
}

// 30 seconds doubling with the tries of the message, as the deliveries; at least retry-after, at most 12 hours.
export function screeningRetryDelay(attempts: number, retryAfterSeconds: number | null): number {
  const backoff = RETRY_BASE_SECONDS * 2 ** (Math.max(1, attempts) - 1);
  return Math.min(MAX_RETRY_SECONDS, Math.max(backoff, retryAfterSeconds ?? 0));
}

type EventRecord = {
  id: string;
  workspace_id: string;
  type: string;
  summary: string;
  labels: string;
  screening_status: string | null;
};

function findEvent(d1: D1Database, eventId: string): Promise<EventRecord | null> {
  return d1
    .prepare("SELECT id, workspace_id, type, summary, labels, screening_status FROM events WHERE id = ?")
    .bind(eventId)
    .first<EventRecord>();
}

function parseLabels(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, string>)
    : {};
}

async function findData(d1: D1Database, eventId: string): Promise<ScreeningData[]> {
  const { results } = await d1
    .prepare("SELECT name, content_type, size, r2_key FROM event_data WHERE event_id = ? ORDER BY position")
    .bind(eventId)
    .all<{ name: string; content_type: string; size: number; r2_key: string }>();
  return results.map((row) => ({ name: row.name, contentType: row.content_type, size: row.size, r2Key: row.r2_key }));
}

// The TypeSafe API key of the workspace, or null if it has none or it cannot be decrypted.
async function workspaceApiKey(deps: ScreeningDeps, workspaceId: string): Promise<string | null> {
  const row = await deps.d1
    .prepare("SELECT screening_api_key FROM workspaces WHERE id = ?")
    .bind(workspaceId)
    .first<{ screening_api_key: string | null }>();
  if (!row || row.screening_api_key === null) return null;
  return decryptApiKey(deps.jwtSecret, workspaceId, row.screening_api_key);
}

type Verdict =
  | { status: "passed"; score: number }
  | { status: "held"; score: number | null; error: ScreeningError | null };

// Records the verdict of a pending event. Returns whether the row was updated.
async function recordVerdict(d1: D1Database, event: EventRecord, verdict: Verdict, now: number): Promise<boolean> {
  const result = await d1
    .prepare(
      `UPDATE events SET screening_status = ?, screening_score = ?, screening_error = ?, screened_at = ?
      WHERE id = ? AND workspace_id = ? AND screening_status = 'pending'`,
    )
    .bind(
      verdict.status,
      verdict.score,
      verdict.status === "held" ? verdict.error : null,
      now,
      event.id,
      event.workspace_id,
    )
    .run();
  return result.meta.changes === 1;
}

// Holds a pending event that could not be screened. Returns whether the row was updated.
export async function holdPendingEvent(d1: D1Database, eventId: string, error: ScreeningError, now: number): Promise<boolean> {
  const result = await d1
    .prepare(
      `UPDATE events SET screening_status = 'held', screening_score = NULL, screening_error = ?, screened_at = ?
      WHERE id = ? AND screening_status = 'pending'`,
    )
    .bind(error, now, eventId)
    .run();
  return result.meta.changes === 1;
}

// The order of the reasons when requests failed in different ways: the first one is taken.
const FAILURE_ORDER: ScreeningError[] = ["screening_auth_failed", "screening_rejected", "screening_invalid_response"];

type Outcome = { kind: "verdict"; verdict: Verdict } | { kind: "retry"; retryAfterSeconds: number | null };

// Sends the states, up to CONCURRENCY at a time, and puts the results together: a score at or above the threshold
// holds (the rest is not sent), then any retryable failure retries the whole event, then any other failure holds,
// and otherwise the highest score passes.
async function screenStates(deps: ScreeningDeps, apiKey: string, states: JevState[], eventId: string): Promise<Outcome> {
  const results: JevResult[] = [];
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && next < states.length) {
      const state = states[next++];
      if (state === undefined) return;
      const result = await callJev(apiKey, state, clock.now());
      results.push(result);
      if (result.kind === "score" && result.score >= deps.threshold) stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, states.length) }, worker));

  let inputTokens = 0;
  let maxScore: number | null = null;
  let retryAfterSeconds: number | null = null;
  let retry = false;
  const failures = new Set<ScreeningError>();
  for (const result of results) {
    if (result.kind === "score") {
      inputTokens += result.inputTokens ?? 0;
      maxScore = maxScore === null ? result.score : Math.max(maxScore, result.score);
    } else if (result.kind === "retry") {
      retry = true;
      if (result.retryAfterSeconds !== null) {
        retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, result.retryAfterSeconds);
      }
    } else {
      failures.add(result.error);
    }
  }
  console.log("screening: Jev usage", { eventId, requests: results.length, inputTokens });

  if (maxScore !== null && maxScore >= deps.threshold) {
    return { kind: "verdict", verdict: { status: "held", score: maxScore, error: null } };
  }
  if (retry) return { kind: "retry", retryAfterSeconds };
  const failure = FAILURE_ORDER.find((error) => failures.has(error));
  if (failure !== undefined) return { kind: "verdict", verdict: { status: "held", score: null, error: failure } };
  return { kind: "verdict", verdict: { status: "passed", score: maxScore ?? 0 } };
}

// Queues the deliveries of an event that may be delivered; throws if that fails, so that the message is retried.
async function enqueueOrThrow(deps: ScreeningDeps, eventId: string): Promise<void> {
  if (!(await enqueuePendingDeliveries({ db: deps.d1, queue: deps.queue }, eventId))) {
    throw new Error("enqueueing the deliveries of a screened event failed");
  }
}

// The steps of one screening message. Throws on unexpected errors (D1, R2, the enqueue); the caller retries.
async function screen(deps: ScreeningDeps, message: Message<unknown>, eventId: string): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 1. The event, and what to do in its state.
    const event = await findEvent(deps.d1, eventId);
    if (event === null) {
      message.ack();
      return;
    }
    const status = parseScreeningStatus(event.screening_status);
    if (status === "passed" || status === "released") {
      // A previous try may have stopped before its deliveries were queued.
      await enqueueOrThrow(deps, eventId);
      message.ack();
      return;
    }
    if (status !== "pending") {
      message.ack();
      return;
    }

    // 2. The key of the workspace. 3. The input. 4. Jev.
    let verdict: Verdict;
    const apiKey = await workspaceApiKey(deps, event.workspace_id);
    if (apiKey === null) {
      verdict = { status: "held", score: null, error: "screening_not_configured" };
    } else {
      const input = await buildScreeningInput(deps.bucket, {
        type: event.type,
        summary: event.summary,
        labels: parseLabels(event.labels),
        data: await findData(deps.d1, eventId),
      });
      if (!input.ok) {
        verdict = { status: "held", score: null, error: input.error };
      } else {
        const outcome = await screenStates(deps, apiKey, input.states, eventId);
        if (outcome.kind === "retry") {
          message.retry({ delaySeconds: screeningRetryDelay(message.attempts, outcome.retryAfterSeconds) });
          return;
        }
        verdict = outcome.verdict;
      }
    }

    // 5. The verdict, if the event is still pending. 6. Otherwise another consumer wrote first: read it again.
    if (!(await recordVerdict(deps.d1, event, verdict, clock.now()))) continue;
    if (verdict.status === "held") {
      console.warn("screening: event held", { eventId, score: verdict.score, error: verdict.error });
      message.ack();
      return;
    }
    // 7. The deliveries of a passed event.
    await enqueueOrThrow(deps, eventId);
    message.ack();
    return;
  }
  throw new Error("the screening state of an event kept changing");
}

// One screening message. Never throws: an exception of one message would retry the whole batch, and send the
// deliveries in it twice.
export async function processScreening(deps: ScreeningDeps, message: Message<unknown>, eventId: string): Promise<void> {
  try {
    await screen(deps, message, eventId);
  } catch (error) {
    console.error("screening failed unexpectedly", { eventId, ...describeError(error) });
    message.retry({ delaySeconds: screeningRetryDelay(message.attempts, null) });
  }
}

// A screening message that the consumer could not finish (retries beyond max_retries). A pending event is held as
// screening_unavailable; the deliveries of a passed or released event are queued again (a lost enqueue).
export async function processScreeningDeadLetter(
  deps: ScreeningDeps,
  message: Message<unknown>,
  eventId: string,
): Promise<boolean> {
  const event = await findEvent(deps.d1, eventId);
  const status = event === null ? null : parseScreeningStatus(event.screening_status);
  if (status === "pending") {
    // Changed by another consumer in the meantime: nothing to do here.
    await holdPendingEvent(deps.d1, eventId, "screening_unavailable", clock.now());
    return true;
  }
  if (status === "passed" || status === "released") {
    return enqueuePendingDeliveries({ db: deps.d1, queue: deps.queue }, eventId);
  }
  return true;
}
