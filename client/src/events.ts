import type { DeliverySummary, EventData } from "../../src/api/types";

// The event list and the event detail. No JSX, so that the tests can load it in Node.

export type SummaryBadge = { label: string; className: string };

// The deliveries of an event in a list: "配信なし" without any; otherwise the failed ones, then the pending ones, and
// "配信済み" only when every delivery is done.
export function deliverySummaryBadges(summary: DeliverySummary): SummaryBadge[] {
  const total = summary.delivered + summary.pending + summary.failed;
  if (total === 0) return [{ label: "配信なし", className: "muted" }];
  const badges: SummaryBadge[] = [];
  if (summary.failed > 0) badges.push({ label: `失敗 ${summary.failed}`, className: "badge badge-error" });
  if (summary.pending > 0) badges.push({ label: `未配信 ${summary.pending}`, className: "badge badge-warning" });
  if (badges.length === 0) badges.push({ label: `配信済み ${summary.delivered}`, className: "badge badge-ok" });
  return badges;
}

// The filters of the event list. Empty values are not filters.
export type EventFilterValues = { type: string; sourceId: string };

// The filters in the query of the event list. Missing values are empty; the server checks the rest.
export function eventFilterOf(params: URLSearchParams): EventFilterValues {
  return { type: (params.get("type") ?? "").trim(), sourceId: (params.get("source_id") ?? "").trim() };
}

export function isFiltered(filter: EventFilterValues): boolean {
  return filter.type !== "" || filter.sourceId !== "";
}

// The query of GET /api/v1/events: empty filters are left out.
export function eventsQuery(
  filter: EventFilterValues,
  cursor?: string,
): { type?: string; source_id?: string; cursor?: string } {
  const query: { type?: string; source_id?: string; cursor?: string } = {};
  const type = filter.type.trim();
  const sourceId = filter.sourceId.trim();
  if (type !== "") query.type = type;
  if (sourceId !== "") query.source_id = sourceId;
  if (cursor !== undefined) query.cursor = cursor;
  return query;
}

// The path of the event list with the filters; empty filters are left out.
export function eventsPath(filter: EventFilterValues): string {
  const query = new URLSearchParams(eventsQuery(filter)).toString();
  return query === "" ? "/events" : `/events?${query}`;
}

// The largest data shown on the event detail: text up to 256 KiB, images up to 2 MiB. Larger ones are downloaded only.
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type PreviewKind = "text" | "json" | "image";

// How a data item is shown on the event detail; null when it is downloaded only. Follows the Content-Types that the
// server serves as they are: text only in UTF-8 (or without a charset), never HTML or SVG.
export function previewKind(data: Pick<EventData, "content_type" | "size">): PreviewKind | null {
  const [essence = "", ...params] = data.content_type.split(";");
  const type = essence.trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) return data.size <= IMAGE_PREVIEW_MAX_BYTES ? "image" : null;
  if (type !== "application/json" && type !== "text/plain" && type !== "text/csv") return null;
  if (data.size > TEXT_PREVIEW_MAX_BYTES) return null;
  const charsets = params
    .map((param) => param.split("="))
    .filter(([name]) => name?.trim().toLowerCase() === "charset")
    .map(([, value = ""]) => value.trim().replace(/^"(.*)"$/, "$1").toLowerCase());
  if (charsets.some((charset) => charset !== "utf-8")) return null;
  return type === "application/json" ? "json" : "text";
}

// The text of a preview: JSON indented by 2 spaces, or as it is when it is not valid JSON.
export function previewText(kind: "text" | "json", text: string): string {
  if (kind === "text") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
