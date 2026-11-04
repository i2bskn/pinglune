// The states of the screening of events (events.screening_status), and the one place that decides whether an event
// may be delivered and read by AIs.
//
// - NULL: not screened (a source without screening, an event received before it was turned on, a message of a
//   conversation). Delivered and readable.
// - pending: waiting for the screening. Neither delivered nor readable.
// - passed: scored below the threshold. Delivered and readable.
// - held: scored at or above the threshold, or could not be screened. Neither delivered nor readable.
// - released: the owner of the workspace released it. Delivered and readable.
//
// Transitions: pending -> passed | held, held -> released, and held -> pending (screen again). Every update is
// conditional on the previous state.

import { sql } from "drizzle-orm";

export const SCREENING_STATUSES = ["pending", "passed", "held", "released"] as const;

export type ScreeningStatus = (typeof SCREENING_STATUSES)[number];

// The reasons an event was held without a score.
export type ScreeningError =
  | "screening_unavailable"
  | "screening_auth_failed"
  | "screening_not_configured"
  | "screening_rejected"
  | "screening_invalid_response"
  | "screening_too_large"
  | "screening_data_missing";

// The reasons that may be fixed by a change of the settings or by time, so that the owner may screen the event again.
// An event held by its score is never screened again: the same input may score differently.
export const RETRYABLE_SCREENING_ERRORS: readonly string[] = [
  "screening_unavailable",
  "screening_auth_failed",
  "screening_not_configured",
  "screening_rejected",
  "screening_invalid_response",
];

export function isRetryableScreeningError(error: string | null): boolean {
  return error !== null && RETRYABLE_SCREENING_ERRORS.includes(error);
}

// The status of a column, or null for NULL. The column has no CHECK constraint: an unknown value is taken as held,
// so that it is neither delivered nor read.
export function parseScreeningStatus(value: string | null): ScreeningStatus | null {
  if (value === null) return null;
  return (SCREENING_STATUSES as readonly string[]).includes(value) ? (value as ScreeningStatus) : "held";
}

// Whether an event in this state may be delivered and read by AIs.
export function isDeliverableScreening(status: string | null): boolean {
  return status === null || status === "passed" || status === "released";
}

// The same condition for raw SQL on deliveries: the event of the delivery may be delivered. A subquery rather than a
// JOIN, for the queries that read deliveries only.
export const DELIVERABLE_EVENT_SQL =
  "EXISTS (SELECT 1 FROM events e WHERE e.id = deliveries.event_id AND (e.screening_status IS NULL OR e.screening_status IN ('passed', 'released')))";

// The same condition for drizzle queries on events (from(events), without an alias).
export const deliverableScreening = sql`(events.screening_status IS NULL OR events.screening_status IN ('passed', 'released'))`;
