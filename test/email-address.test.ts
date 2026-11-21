import { afterEach, describe, expect, it, vi } from "vitest";
import { emailAddressOf, emailCallbackUrl, isIntakeAddress, normalizeEmailAddress } from "../src/email/address";
import { emailDeliveryConfig } from "../src/env";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeEmailAddress", () => {
  it("trims, lowercases the domain and keeps the case of the local part", () => {
    expect(normalizeEmailAddress("  Agent.Smith+ai@Mail.Example.COM ")).toBe("Agent.Smith+ai@mail.example.com");
    expect(normalizeEmailAddress("a@b.co")).toBe("a@b.co");
    expect(normalizeEmailAddress(`${"a".repeat(64)}@example.com`)).toBe(`${"a".repeat(64)}@example.com`);
  });

  it.each([
    ["an empty value", ""],
    ["spaces only", "   "],
    ["no @", "example.com"],
    ["two @", "a@b@example.com"],
    ["an empty local part", "@example.com"],
    ["a local part over 64 characters", `${"a".repeat(65)}@example.com`],
    ["an address over 254 characters", `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}.com`],
    ["a display name", "AI <ai@example.com>"],
    ["angle brackets", "<ai@example.com>"],
    ["a list", "a@example.com,b@example.com"],
    ["a quoted local part", '"a b"@example.com'],
    ["a space inside", "a b@example.com"],
    ["a line break", "a@example.com\r\nBcc: x@example.com"],
    ["a control character", "a\u0000@example.com"],
    ["a leading dot", ".a@example.com"],
    ["a trailing dot", "a.@example.com"],
    ["two dots", "a..b@example.com"],
    ["a domain without a dot", "a@localhost"],
    ["a domain with an underscore", "a@ex_ample.com"],
    ["a non-ASCII domain", "a@例え.jp"],
    ["a non-ASCII local part", "あ@example.com"],
  ])("rejects %s", (_, value) => {
    expect(normalizeEmailAddress(value)).toBeNull();
  });
});

describe("isIntakeAddress", () => {
  it("matches the domain of the email intake and its subdomains only", () => {
    expect(isIntakeAddress("a@example.com", "example.com")).toBe(true);
    expect(isIntakeAddress("a@in.example.com", "example.com")).toBe(true);
    expect(isIntakeAddress("a@notexample.com", "example.com")).toBe(false);
    expect(isIntakeAddress("a@example.com.evil.test", "example.com")).toBe(false);
  });
});

describe("the callback URL of an email destination", () => {
  it("is mailto: and the address, read back without parsing it as a URL", () => {
    expect(emailCallbackUrl("Ai@example.com")).toBe("mailto:Ai@example.com");
    expect(emailAddressOf("mailto:Ai@Example.com")).toBe("Ai@example.com");
    expect(emailAddressOf("mailto:a@b@c")).toBeNull();
    expect(emailAddressOf("https://hooks.example.com/")).toBeNull();
    expect(emailAddressOf("")).toBeNull();
  });
});

describe("emailDeliveryConfig", () => {
  const send = { send: async () => ({ messageId: "m" }) } as unknown as SendEmail;

  it("needs both the binding and a valid EMAIL_FROM", () => {
    expect(emailDeliveryConfig({ SEND_EMAIL: send, EMAIL_FROM: " pinglune@Notify.Example.com " })).toEqual({
      send,
      from: "pinglune@notify.example.com",
    });
    expect(emailDeliveryConfig({ SEND_EMAIL: send })).toBeNull();
    expect(emailDeliveryConfig({ SEND_EMAIL: send, EMAIL_FROM: "  " })).toBeNull();
    expect(emailDeliveryConfig({ EMAIL_FROM: "pinglune@example.com" })).toBeNull();
  });

  it("is off for an invalid EMAIL_FROM, and logs it once per isolate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(emailDeliveryConfig({ SEND_EMAIL: send, EMAIL_FROM: "Pinglune <p@example.com>" })).toBeNull();
    expect(emailDeliveryConfig({ SEND_EMAIL: send, EMAIL_FROM: "not an address" })).toBeNull();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
