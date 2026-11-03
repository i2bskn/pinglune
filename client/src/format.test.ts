import { describe, expect, it } from "vitest";
import { formatDateTime, keepNumbersWithUnits } from "./format";

describe("formatDateTime", () => {
  it("formats in the given time zone", () => {
    expect(formatDateTime(Date.UTC(2026, 9, 30, 3, 4), "Asia/Tokyo")).toBe("2026/10/30 12:04");
  });
});

describe("keepNumbersWithUnits", () => {
  it("joins a number to the word after it with a no-break space", () => {
    expect(keepNumbersWithUnits("遅延が 30 秒を超えました（所要 4 分 48 秒）")).toBe(
      "遅延が 30\u00a0秒を超えました（所要 4\u00a0分 48\u00a0秒）",
    );
    expect(keepNumbersWithUnits("1 2 3")).toBe("1 2 3");
  });
});
