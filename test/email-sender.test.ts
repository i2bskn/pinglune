import { describe, expect, it } from "vitest";
import {
  matchesAllowedSender,
  normalizeAllowedSender,
  parseAllowedSenders,
  parseCloudflareAuthResults,
  parseFromLine,
} from "../src/intake/email-sender";

// The value Workers gives for several Authentication-Results lines: joined with ", ".
function joined(...lines: string[]): string | null {
  const headers = new Headers();
  for (const line of lines) headers.append("Authentication-Results", line);
  return headers.get("authentication-results");
}

describe("parseCloudflareAuthResults", () => {
  it("reads a pass with header.from", () => {
    expect(parseCloudflareAuthResults("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass header.from=example.com")).toEqual({
      result: "pass",
      reason: null,
      headerFrom: "example.com",
    });
  });

  it("reads the published example, without header.from, as a pass without it", () => {
    expect(parseCloudflareAuthResults("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass")).toEqual({
      result: "pass",
      reason: "header_from_missing",
      headerFrom: null,
    });
  });

  it("reads a value close to the real one", () => {
    const value =
      "mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1 header.b=abc; dmarc=pass header.from=example.com policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain of bounce@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@example.com";
    expect(parseCloudflareAuthResults(value)).toEqual({ result: "pass", reason: null, headerFrom: "example.com" });
  });

  it("replaces a comment with a space", () => {
    expect(parseCloudflareAuthResults("mx.cloudflare.net; dmarc=pass(x)header.from=example.com")).toEqual({
      result: "pass",
      reason: null,
      headerFrom: "example.com",
    });
  });

  it("lowercases header.from", () => {
    expect(parseCloudflareAuthResults("mx.cloudflare.net; dmarc=pass header.from=Example.COM").headerFrom).toBe(
      "example.com",
    );
  });

  describe("does not read past the first line", () => {
    it("a pass in a second line after a fail", () => {
      const value = joined("mx.cloudflare.net; dmarc=fail", "evil; dmarc=pass");
      expect(value).toBe("mx.cloudflare.net; dmarc=fail, evil; dmarc=pass");
      expect(parseCloudflareAuthResults(value)).toEqual({ result: "fail", reason: "dmarc_fail", headerFrom: null });
    });

    it("a pass in a second line of mx.cloudflare.net", () => {
      const value = joined("mx.cloudflare.net; spf=pass", "mx.cloudflare.net; dmarc=pass header.from=example.com");
      expect(parseCloudflareAuthResults(value)).toEqual({ result: "invalid", reason: "dmarc_missing", headerFrom: null });
    });

    it("a comment left open into the second line", () => {
      const value = joined(
        "mx.cloudflare.net; dkim=pass header.d=evil(.com; dmarc=none",
        "x); dmarc=pass header.from=example.com",
      );
      expect(parseCloudflareAuthResults(value)).toEqual({ result: "invalid", reason: "ar_syntax", headerFrom: null });
    });

    it("a comment left open to the end", () => {
      expect(parseCloudflareAuthResults("mx.cloudflare.net; dmarc=pass (x header.from=example.com").reason).toBe(
        "ar_syntax",
      );
    });
  });

  it.each([
    ["a quote", 'mx.cloudflare.net; spf=pass smtp.mailfrom="a); dmarc=pass ("@evil.com; dmarc=fail'],
    ["a quote in a comment", 'mx.cloudflare.net; dmarc=pass (") header.from=example.com'],
    ["a backslash", "mx.cloudflare.net; spf=pass smtp.mailfrom=a\\@evil.com; dmarc=pass header.from=example.com"],
    ["a nested comment", "mx.cloudflare.net; dmarc=pass (a (b) c) header.from=example.com"],
    ["a nested comment closed once", "mx.cloudflare.net; dmarc=pass (a (b) header.from=example.com"],
    ["an unmatched )", "mx.cloudflare.net; dmarc=pass a) header.from=example.com"],
    ["a comma in a comment", "mx.cloudflare.net; dmarc=pass (a, b) header.from=example.com"],
  ])("rejects %s as ar_syntax", (_name, value) => {
    expect(parseCloudflareAuthResults(value)).toEqual({ result: "invalid", reason: "ar_syntax", headerFrom: null });
  });

  it.each([
    [null, "invalid", "ar_missing", null],
    ["", "invalid", "ar_authserv", null],
    ["evil.example; dmarc=pass header.from=example.com", "invalid", "ar_authserv", null],
    ["mx.cloudflare.net.evil.com; dmarc=pass header.from=example.com", "invalid", "ar_authserv", null],
    ["mx.cloudflare.net; dmarc=none", "none", "dmarc_none", null],
    ["mx.cloudflare.net; dmarc=temperror", "temperror", "dmarc_temperror", null],
    ["mx.cloudflare.net; dmarc=permerror header.from=example.com", "fail", "dmarc_fail", "example.com"],
    ["mx.cloudflare.net; dmarc=fail header.from=example.com", "fail", "dmarc_fail", "example.com"],
    ["mx.cloudflare.net; dmarc= pass header.from=example.com", "fail", "dmarc_fail", "example.com"],
    ["mx.cloudflare.net; spf=pass; dkim=pass", "invalid", "dmarc_missing", null],
    ["mx.cloudflare.net; dmarc=pass header.from=example.com; dmarc=pass", "invalid", "dmarc_multiple", null],
    [
      "mx.cloudflare.net; dmarc=pass header.from=evil.com header.from=example.com",
      "invalid",
      "dmarc_multiple",
      null,
    ],
    ["mx.cloudflare.net; dmarc=pass header.from=evil", "invalid", "header_from_invalid", null],
    ["mx.cloudflare.net; dmarc=pass header.from=", "invalid", "header_from_invalid", null],
    ["mx.cloudflare.net; dmarc=pass header.from=a@example.com", "invalid", "header_from_invalid", null],
  ] as const)("reads %j as %s (%s)", (value, result, reason, headerFrom) => {
    expect(parseCloudflareAuthResults(value)).toEqual({ result, reason, headerFrom });
  });

  it.each([
    ["uppercase", "MX.CLOUDFLARE.NET; DMARC=PASS HEADER.FROM=EXAMPLE.COM"],
    ["a version", "mx.cloudflare.net 1; dmarc=pass header.from=example.com"],
    ["a comment first", "(c) mx.cloudflare.net; dmarc=pass header.from=example.com"],
    ["tabs", "\tmx.cloudflare.net\t;\tdmarc=pass\theader.from=example.com\t"],
  ])("accepts %s", (_name, value) => {
    expect(parseCloudflareAuthResults(value)).toEqual({ result: "pass", reason: null, headerFrom: "example.com" });
  });

  it("rejects a dmarc= put in a token by the sender, next to the one of Cloudflare", () => {
    const value =
      "mx.cloudflare.net; spf=pass smtp.helo=x;dmarc=pass(c)header.from=example.com; dmarc=fail header.from=evil.com";
    expect(parseCloudflareAuthResults(value)).toEqual({ result: "invalid", reason: "dmarc_multiple", headerFrom: null });
  });
});

describe("parseFromLine", () => {
  it.each([
    ["alerts@example.com", "alerts@example.com"],
    ["Alerts <Alerts@Example.COM>", "alerts@example.com"],
    ['"Alerts, Inc." <alerts@example.com>', "alerts@example.com"],
    ["=?UTF-8?B?44Ki44Op44O844OI?= <alerts@example.com>", "alerts@example.com"],
    ["Alerts (x) <a@example.com>", "a@example.com"],
    ["root@example.com (Cron Daemon)", "root@example.com"],
    ['"quoted local"@example.com', '"quoted local"@example.com'],
  ])("reads %j", (value, address) => {
    expect(parseFromLine(value)).toBe(address);
  });

  it.each([
    ["two addresses", "a@example.com, b@evil.com"],
    ["a group", "group: a@example.com;"],
    ["no address", "Alerts"],
    ["empty", ""],
    ["no domain", "alerts@"],
    ["a single label domain", "alerts@localhost"],
    ["a non-ASCII domain", "alerts@例え.jp"],
    ["an IP literal", "alerts@[192.0.2.1]"],
    ["999 characters", `${"x".repeat(999 - " <a@example.com>".length)} <a@example.com>`],
  ])("rejects %s", (_name, value) => {
    expect(parseFromLine(value)).toBeNull();
  });

  it("reads a value of 998 characters", () => {
    const value = `${"x".repeat(998 - " <a@example.com>".length)} <a@example.com>`;
    expect(value).toHaveLength(998);
    expect(parseFromLine(value)).toBe("a@example.com");
    expect(parseFromLine(`x${value}`)).toBeNull();
  });
});

describe("normalizeAllowedSender", () => {
  it.each([
    ["alerts@example.com", "alerts@example.com"],
    ["  Alerts@Example.COM ", "alerts@example.com"],
    ["example.com", "example.com"],
    ["Mail.Example.COM", "mail.example.com"],
    ["xn--r8jz45g.jp", "xn--r8jz45g.jp"],
    ["a+b.c_d@example.com", "a+b.c_d@example.com"],
    [`${"a".repeat(63)}.com`, `${"a".repeat(63)}.com`],
    [`${"a".repeat(64)}@example.com`, `${"a".repeat(64)}@example.com`],
  ])("normalizes %j", (value, sender) => {
    expect(normalizeAllowedSender(value)).toBe(sender);
  });

  it.each([
    "",
    "localhost",
    "@example.com",
    "a@",
    "a@b@example.com",
    "a b@example.com",
    '"a"@example.com',
    "a<b@example.com",
    "a,b@example.com",
    "a;b@example.com",
    "a:b@example.com",
    "a\\b@example.com",
    "a(b)@example.com",
    "a[b]@example.com",
    `${"a".repeat(65)}@example.com`,
    `${"a".repeat(64)}.com`,
    "-a.com",
    "a-.com",
    "a..com",
    "例え.jp",
    "a@例え.jp",
    "*.example.com",
    "example.com.",
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
  ])("rejects %j", (value) => {
    expect(normalizeAllowedSender(value)).toBeNull();
  });
});

describe("matchesAllowedSender", () => {
  it("matches an address and a domain, not a subdomain", () => {
    expect(matchesAllowedSender("alerts@example.com", ["alerts@example.com"])).toBe(true);
    expect(matchesAllowedSender("other@example.com", ["alerts@example.com"])).toBe(false);
    expect(matchesAllowedSender("other@example.com", ["example.com"])).toBe(true);
    expect(matchesAllowedSender("a@mail.example.com", ["example.com"])).toBe(false);
    expect(matchesAllowedSender("a@example.com", ["mail.example.com"])).toBe(false);
    expect(matchesAllowedSender("a@evilexample.com", ["example.com"])).toBe(false);
    expect(matchesAllowedSender("a@example.com", [])).toBe(false);
  });
});

describe("parseAllowedSenders", () => {
  it("reads NULL and [] as none", () => {
    expect(parseAllowedSenders(null)).toEqual([]);
    expect(parseAllowedSenders("[]")).toEqual([]);
  });

  it("reads the stored senders", () => {
    expect(parseAllowedSenders('["alerts@example.com","example.org"]')).toEqual(["alerts@example.com", "example.org"]);
  });

  it.each(["not json", "{}", '"example.com"', "[1]", '["example.com", 1]', '["localhost"]', "null"])(
    "returns null for %j",
    (stored) => {
      expect(parseAllowedSenders(stored)).toBeNull();
    },
  );
});
