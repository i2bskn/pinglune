import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig, parseEmailDomain } from "../src/env";

describe("parseEmailDomain", () => {
  it.each([undefined, "", "   "])("turns the email intake off for %j", (value) => {
    expect(parseEmailDomain(value)).toEqual({ ok: true, domain: null });
  });

  it.each([
    ["example.com", "example.com"],
    [" Example.COM\n", "example.com"],
    ["mail-1.example.co.jp", "mail-1.example.co.jp"],
    ["xn--r8jz45g.xn--zckzah", "xn--r8jz45g.xn--zckzah"],
  ])("normalizes %j", (value, domain) => {
    expect(parseEmailDomain(value)).toEqual({ ok: true, domain });
  });

  it.each([
    "localhost",
    "example",
    "-example.com",
    "example-.com",
    "example..com",
    "example.com.",
    "user@example.com",
    "https://example.com",
    "example.com/path",
    "exa mple.com",
    "example.1com",
    `${"a".repeat(64)}.com`,
    `${Array.from({ length: 64 }, () => "abc").join(".")}.com`,
  ])("rejects %j", (value) => {
    expect(parseEmailDomain(value)).toEqual({ ok: false });
  });

  it.each([42, null, true, { domain: "example.com" }, ["example.com"]])("rejects the non-string %j", (value) => {
    expect(parseEmailDomain(value)).toEqual({ ok: false });
  });

  it("does not stop loadConfig when invalid", () => {
    const result = loadConfig({ ...env, EMAIL_DOMAIN: "not a domain" });
    expect(result.ok).toBe(true);
  });
});
