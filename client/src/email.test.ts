import { describe, expect, it } from "vitest";
import { attachmentPreview, defaultBodyMode, isEmailEvent, revealBidiControls } from "./email";

describe("revealBidiControls", () => {
  it("shows every bidirectional control as [U+XXXX]", () => {
    const controls = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const code of controls) {
      const hex = code.toString(16).toUpperCase().padStart(4, "0");
      expect(revealBidiControls(`a${String.fromCodePoint(code)}b`)).toBe(`a[U+${hex}]b`);
    }
  });

  it("makes a reversed file name read as it is stored", () => {
    expect(revealBidiControls(`invoice${String.fromCodePoint(0x202e)}fdp.exe`)).toBe("invoice[U+202E]fdp.exe");
  });

  it("leaves other text as it is", () => {
    expect(revealBidiControls("請求書 report.pdf <a@example.com> \u200b")).toBe("請求書 report.pdf <a@example.com> \u200b");
  });
});

describe("defaultBodyMode", () => {
  const html = { data_ref: "dat_x", size: 10 };

  it("shows the HTML first only for an HTML-only message", () => {
    expect(defaultBodyMode({ html, html_only: true })).toBe("html");
    expect(defaultBodyMode({ html, html_only: false })).toBe("text");
    expect(defaultBodyMode({ html: null, html_only: true })).toBe("text");
  });
});

describe("attachmentPreview", () => {
  it.each([
    ["image/png", 100, "image"],
    ["text/plain", 100, "text"],
    ["text/csv; charset=utf-8", 100, "text"],
    ["application/json", 100, "json"],
    ["text/html", 100, null],
    ["image/svg+xml", 100, null],
    ["application/pdf", 100, null],
    ["text/plain; charset=shift_jis", 100, null],
    ["text/plain", 300 * 1024, null],
    ["image/png", 3 * 1024 * 1024, null],
  ])("%s of %i bytes is %s", (contentType, size, kind) => {
    expect(attachmentPreview({ content_type: contentType, size })).toBe(kind);
  });
});

describe("isEmailEvent", () => {
  it("is an email.received event that is not a message of a conversation", () => {
    expect(isEmailEvent({ type: "email.received", conversation_id: null })).toBe(true);
    expect(isEmailEvent({ type: "email.received", conversation_id: "cnv_x" })).toBe(false);
    expect(isEmailEvent({ type: "alert.observed", conversation_id: null })).toBe(false);
  });
});
