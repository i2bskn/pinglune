import type { DeliveryListItem, EventScreening, ScreeningStatus } from "../../src/api/types";

// The screening of events for instructions to AIs, as the screens show it. No JSX, so that the tests can load it in
// Node.

export const SCREENING_STATUS_LABELS: Record<ScreeningStatus, string> = {
  pending: "判定待ち",
  held: "保留",
  passed: "通過",
  released: "解除済み",
};

export const SCREENING_BADGE_CLASSES: Record<ScreeningStatus, string> = {
  pending: "badge badge-warning",
  held: "badge badge-error",
  passed: "badge badge-ok",
  released: "badge badge-off",
};

// Short descriptions of the reasons an event could not be screened. Unknown values are shown as they are.
const ERROR_LABELS: Record<string, string> = {
  screening_unavailable: "TypeSafe に接続できませんでした",
  screening_auth_failed: "TypeSafe の API キーが受け付けられませんでした",
  screening_not_configured: "TypeSafe の API キーが設定されていないか、読めませんでした",
  screening_rejected: "TypeSafe がリクエストを受け付けませんでした",
  screening_invalid_response: "TypeSafe の応答を読めませんでした",
  screening_too_large: "判定するには大きすぎます",
  screening_data_missing: "本文か添付が見つかりませんでした",
};

export function screeningErrorLabel(error: string): string {
  return ERROR_LABELS[error] ?? error;
}

// Why the event is in its state, e.g. "スコア 0.82" or the reason it could not be screened. null when there is
// nothing to say.
export function screeningReason(screening: EventScreening): string | null {
  if (screening.error !== null) return screeningErrorLabel(screening.error);
  if (screening.score !== null) return `スコア ${screening.score.toFixed(2)}`;
  return null;
}

// An event pending for this long may be screened again from the screen (as the server allows it).
export const SCREENING_RESEND_AFTER_MS = 10 * 60 * 1000;

// Whether "判定し直す" is offered: a held event with a reason that may be fixed, or one pending for 10 minutes.
export function canRetryScreening(screening: EventScreening, now: number): boolean {
  if (screening.status === "held") return screening.retryable;
  if (screening.status === "pending") {
    return screening.requested_at !== null && now - screening.requested_at >= SCREENING_RESEND_AFTER_MS;
  }
  return false;
}

// Whether a released event still has deliveries never sent (pending and never tried), so that "配信をやり直す" is
// offered. Deliveries to polling queues wait for an AI to take them and are not counted.
export function hasUnsentDeliveries(deliveries: DeliveryListItem[]): boolean {
  return deliveries.some(
    (delivery) => delivery.destination_kind !== "queue" && delivery.status === "pending" && delivery.attempts === 0,
  );
}

export type ScreeningFilter = "held" | "pending";

export function parseScreeningFilter(value: string | null): ScreeningFilter | undefined {
  return value === "held" || value === "pending" ? value : undefined;
}
