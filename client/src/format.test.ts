import { describe, expect, it } from "vitest";
import { formatDateTime } from "./format";

describe("formatDateTime", () => {
  it("formats in the given time zone", () => {
    expect(formatDateTime(Date.UTC(2026, 9, 30, 3, 4), "Asia/Tokyo")).toBe("2026/10/30 12:04");
  });
});
