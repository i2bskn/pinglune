import { describe, expect, it } from "vitest";
import { setFlash, takeFlash } from "./flash";

describe("setFlash and takeFlash", () => {
  it("passes one message to the first reader only", () => {
    expect(takeFlash()).toBeNull();
    setFlash("Bot を作成しました");
    expect(takeFlash()).toBe("Bot を作成しました");
    expect(takeFlash()).toBeNull();
  });

  it("keeps the last message only", () => {
    setFlash("a");
    setFlash("b");
    expect(takeFlash()).toBe("b");
    expect(takeFlash()).toBeNull();
  });
});
