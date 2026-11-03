import { describe, expect, it } from "vitest";
import {
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  deliverySummaryBadges,
  eventFilterOf,
  eventsPath,
  eventsQuery,
  isFiltered,
  previewKind,
  previewText,
} from "./events";

describe("deliverySummaryBadges", () => {
  it("is 配信なし without deliveries", () => {
    expect(deliverySummaryBadges({ delivered: 0, pending: 0, failed: 0 })).toEqual([
      { label: "配信なし", className: "muted" },
    ]);
  });

  it("is 配信済み when every delivery is done", () => {
    expect(deliverySummaryBadges({ delivered: 3, pending: 0, failed: 0 })).toEqual([
      { label: "配信済み 3", className: "badge badge-ok" },
    ]);
  });

  it("shows the failed ones, then the pending ones, without the delivered ones", () => {
    expect(deliverySummaryBadges({ delivered: 2, pending: 1, failed: 4 })).toEqual([
      { label: "失敗 4", className: "badge badge-error" },
      { label: "未配信 1", className: "badge badge-warning" },
    ]);
    expect(deliverySummaryBadges({ delivered: 2, pending: 0, failed: 1 })).toEqual([
      { label: "失敗 1", className: "badge badge-error" },
    ]);
    expect(deliverySummaryBadges({ delivered: 0, pending: 2, failed: 0 })).toEqual([
      { label: "未配信 2", className: "badge badge-warning" },
    ]);
  });
});

describe("event filters", () => {
  it("reads the type and the source from the query", () => {
    expect(eventFilterOf(new URLSearchParams("type=alert.observed&source_id=src_1"))).toEqual({
      type: "alert.observed",
      sourceId: "src_1",
    });
    expect(eventFilterOf(new URLSearchParams(""))).toEqual({ type: "", sourceId: "" });
    expect(eventFilterOf(new URLSearchParams("type=%20"))).toEqual({ type: "", sourceId: "" });
  });

  it("tells whether a filter is set", () => {
    expect(isFiltered({ type: "", sourceId: "" })).toBe(false);
    expect(isFiltered({ type: "t", sourceId: "" })).toBe(true);
    expect(isFiltered({ type: "", sourceId: "src_1" })).toBe(true);
  });

  it("leaves empty values out of the query and the path", () => {
    expect(eventsQuery({ type: " t ", sourceId: "" })).toEqual({ type: "t" });
    expect(eventsQuery({ type: "", sourceId: "src_1" }, "evt_1")).toEqual({ source_id: "src_1", cursor: "evt_1" });
    expect(eventsQuery({ type: "", sourceId: "" })).toEqual({});
    expect(eventsPath({ type: "", sourceId: "" })).toBe("/events");
    expect(eventsPath({ type: "a.b", sourceId: "src_1" })).toBe("/events?type=a.b&source_id=src_1");
    expect(eventsPath({ type: "a b&c", sourceId: " " })).toBe("/events?type=a+b%26c");
  });
});

describe("previewKind", () => {
  it.each([
    ["application/json", "json"],
    ["application/json; charset=utf-8", "json"],
    ["text/plain", "text"],
    ["text/plain; charset=UTF-8", "text"],
    ['text/csv; charset="utf-8"', "text"],
    ["TEXT/CSV", "text"],
    ["image/png", "image"],
    ["image/jpeg", "image"],
    ["image/gif", "image"],
    ["image/webp", "image"],
    ["text/plain; charset=shift_jis", null],
    ["application/json; charset=iso-8859-1", null],
    ["text/html", null],
    ["image/svg+xml", null],
    ["application/pdf", null],
    ["application/octet-stream", null],
    ["text/markdown", null],
  ])("is %s -> %s", (contentType, kind) => {
    expect(previewKind({ content_type: contentType, size: 10 })).toBe(kind);
  });

  it("downloads large data only", () => {
    expect(previewKind({ content_type: "text/plain", size: TEXT_PREVIEW_MAX_BYTES })).toBe("text");
    expect(previewKind({ content_type: "text/plain", size: TEXT_PREVIEW_MAX_BYTES + 1 })).toBeNull();
    expect(previewKind({ content_type: "image/png", size: IMAGE_PREVIEW_MAX_BYTES })).toBe("image");
    expect(previewKind({ content_type: "image/png", size: IMAGE_PREVIEW_MAX_BYTES + 1 })).toBeNull();
  });
});

describe("previewText", () => {
  it("indents JSON, and keeps text and invalid JSON as they are", () => {
    expect(previewText("json", '{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(previewText("json", "{broken")).toBe("{broken");
    expect(previewText("text", '{"a":1}')).toBe('{"a":1}');
  });
});
