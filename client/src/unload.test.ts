import { describe, expect, it } from "vitest";
import { isLeaving, markLeaving } from "./unload";

describe("markLeaving", () => {
  it("is remembered by isLeaving", () => {
    expect(isLeaving()).toBe(false);
    markLeaving();
    expect(isLeaving()).toBe(true);
  });
});
