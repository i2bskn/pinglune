import { describe, expect, it } from "vitest";
import { chunks, IN_CHUNK_SIZE } from "../src/db/chunks";

describe("chunks", () => {
  it("is empty for no items", () => {
    expect(chunks([])).toEqual([]);
  });

  it("keeps fewer items than the size in one chunk", () => {
    expect(chunks([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
  });

  it("splits items into chunks of the size, in order, the last one shorter", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("uses chunks of IN_CHUNK_SIZE by default", () => {
    const items = Array.from({ length: 2 * IN_CHUNK_SIZE + 1 }, (_, i) => i);
    const result = chunks(items);
    expect(result.map((chunk) => chunk.length)).toEqual([IN_CHUNK_SIZE, IN_CHUNK_SIZE, 1]);
    expect(result.flat()).toEqual(items);
    expect(IN_CHUNK_SIZE).toBeLessThanOrEqual(90);
  });

  it("rejects a size that is not a positive integer", () => {
    expect(() => chunks([1], 0)).toThrow(RangeError);
    expect(() => chunks([1], 1.5)).toThrow(RangeError);
  });
});
