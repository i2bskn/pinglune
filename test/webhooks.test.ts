import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  parseWebhookSecret,
  subscriptionSecretKey,
} from "../src/subscriptions/secret";
import { checkDestination, isPublicAddress, resolveWithDoh } from "../src/webhooks/destination";
import { sendWebhook, type WebhookMessage } from "../src/webhooks/send";
import { signWebhook } from "../src/webhooks/sign";

const JWT_SECRET = "test-secret-test-secret-test-secret-0123";
const OTHER_JWT_SECRET = "another-secret-another-secret-another-01";
const SUBSCRIPTION_ID = "sub_0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPublicAddress", () => {
  it.each([
    // Boundaries of the blocked IPv4 ranges.
    ["0.255.255.255", false],
    ["1.0.0.0", true],
    ["9.255.255.255", true],
    ["10.0.0.0", false],
    ["10.255.255.255", false],
    ["11.0.0.0", true],
    ["100.63.255.255", true],
    ["100.64.0.0", false],
    ["100.127.255.255", false],
    ["100.128.0.0", true],
    ["126.255.255.255", true],
    ["127.0.0.1", false],
    ["128.0.0.0", true],
    ["169.253.255.255", true],
    ["169.254.169.254", false],
    ["169.255.0.0", true],
    ["172.15.255.255", true],
    ["172.16.0.0", false],
    ["172.31.255.255", false],
    ["172.32.0.0", true],
    ["192.0.0.255", false],
    ["192.0.1.0", true],
    ["192.0.2.1", false],
    ["192.88.99.1", false],
    ["192.167.255.255", true],
    ["192.168.0.0", false],
    ["192.168.255.255", false],
    ["192.169.0.0", true],
    ["198.17.255.255", true],
    ["198.18.0.0", false],
    ["198.19.255.255", false],
    ["198.20.0.0", true],
    ["198.51.100.7", false],
    ["203.0.113.9", false],
    ["223.255.255.255", true],
    ["224.0.0.0", false],
    ["239.255.255.255", false],
    ["240.0.0.0", false],
    ["255.255.255.255", false],
    ["8.8.8.8", true],
    ["93.184.216.34", true],
    // IPv6: global unicast only.
    ["2606:4700:4700::1111", true],
    ["2a00:1450:4001:80b::200e", true],
    ["2000::", true],
    ["3ffe:ffff::1", true],
    ["3fff::1", false],
    ["3fff:0fff::1", false],
    ["3fff:1000::1", true],
    ["2001::1", false],
    ["2001:1ff:ffff::1", false],
    ["2001:200::1", true],
    ["2001:db8::1", false],
    ["2001:db9::1", true],
    ["2002::1", false],
    ["2002:c000:0204::1", false],
    ["2003::1", true],
    ["::", false],
    ["::1", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:8.8.8.8", false],
    ["::ffff:0808:0808", false],
    ["64:ff9b::a00:1", false],
    ["64:ff9b::808:808", false],
    ["fc00::1", false],
    ["fd12:3456::1", false],
    ["fe80::1", false],
    ["ff02::1", false],
    ["1fff:ffff::1", false],
    ["4000::1", false],
    ["2606:4700::1.2.3.4", true],
    // Unparsable.
    ["", false],
    ["256.0.0.1", false],
    ["1.2.3", false],
    ["01.2.3.4", false],
    ["1.2.3.4.5", false],
    ["2606:4700::1::2", false],
    ["2606:4700:4700:0:0:0:0:1111:1", false],
    ["2606:4700:4700:0:0:0:1111", false],
    ["2606:4700::12345", false],
    ["2606:4700::1%eth0", false],
    ["example.com", false],
  ])("%s is public: %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("checkDestination", () => {
  const resolvePublic = vi.fn(async () => ({ ok: true as const, addresses: ["93.184.216.34"] }));

  it("resolves names that pass the host checks", async () => {
    expect(await checkDestination(new URL("https://hooks.example.com/"), { selfHosts: [], resolve: resolvePublic })).toEqual({
      ok: true,
    });
    expect(resolvePublic).toHaveBeenCalledWith("hooks.example.com");
  });

  it("compares self hosts without case or the trailing dot", async () => {
    const result = await checkDestination(new URL("https://Pinglune.Example.com./cb"), {
      selfHosts: ["pinglune.example.com"],
      resolve: resolvePublic,
    });
    expect(result).toEqual({ ok: false, reason: "blocked_destination" });
  });

  it("fails when nothing resolves", async () => {
    const result = await checkDestination(new URL("https://hooks.example.com/"), {
      selfHosts: [],
      resolve: async () => ({ ok: true, addresses: [] }),
    });
    expect(result).toEqual({ ok: false, reason: "dns_failed" });
  });
});

describe("resolveWithDoh", () => {
  it("asks for A and AAAA as JSON, without following redirects, and collects both", async () => {
    const requests: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const type = new URL(request.url).searchParams.get("type");
      const Answer =
        type === "A"
          ? [
              { name: "hooks.example.com", type: 5, data: "target.example.net." },
              { name: "target.example.net", type: 1, data: "93.184.216.34" },
            ]
          : [{ name: "target.example.net", type: 28, data: "2606:4700::1111" }];
      return Response.json({ Status: 0, Answer });
    });
    expect(await resolveWithDoh("hooks.example.com")).toEqual({
      ok: true,
      addresses: ["93.184.216.34", "2606:4700::1111"],
    });
    expect(requests.map((r) => r.url).sort()).toEqual([
      "https://cloudflare-dns.com/dns-query?name=hooks.example.com&type=A",
      "https://cloudflare-dns.com/dns-query?name=hooks.example.com&type=AAAA",
    ]);
    for (const request of requests) {
      expect(request.headers.get("Accept")).toBe("application/dns-json");
      expect(request.redirect).toBe("manual");
      expect(request.signal).toBeDefined();
    }
  });

  it("fails when either query fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const type = new URL(new Request(input, init).url).searchParams.get("type");
      if (type === "AAAA") return new Response(null, { status: 302, headers: { Location: "https://x.example/" } });
      return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
    });
    expect(await resolveWithDoh("hooks.example.com")).toEqual({ ok: false });
  });
});

describe("sendWebhook", () => {
  const secret = new Uint8Array(32).fill(1);

  function message(overrides: Partial<WebhookMessage> = {}): WebhookMessage {
    return {
      url: new URL("https://hooks.example.com/cb"),
      subscriptionId: SUBSCRIPTION_ID,
      msgId: "msg_1",
      timestampSec: 1_700_000_000,
      body: new TextEncoder().encode('{"a":1}'),
      secrets: [secret],
      ...overrides,
    };
  }

  const deps = { selfHosts: [], resolve: async () => ({ ok: true as const, addresses: ["93.184.216.34"] }) };

  it("checks the destination before fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await sendWebhook(message(), {
      selfHosts: [],
      resolve: async () => ({ ok: true, addresses: ["10.0.0.1"] }),
    });
    expect(result).toEqual({ ok: false, reason: "blocked_destination" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the signed body and reads at most 4 KiB of the answer", async () => {
    let sent: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent = new Request(input, init);
      return new Response("x".repeat(10_000));
    });
    const result = await sendWebhook(message(), deps);
    expect(result).toEqual({ ok: true, status: 200, body: "x".repeat(4096) });
    expect(sent?.method).toBe("POST");
    expect(sent?.redirect).toBe("manual");
    expect(await sent?.text()).toBe('{"a":1}');
    expect(Object.fromEntries(sent?.headers ?? [])).toMatchObject({
      "content-type": "application/json",
      "webhook-id": "msg_1",
      "webhook-timestamp": "1700000000",
      "webhook-signature": await signWebhook([secret], "msg_1", 1_700_000_000, new TextEncoder().encode('{"a":1}')),
      "x-mcp-subscription-id": SUBSCRIPTION_ID,
      "user-agent": "Pinglune-Webhooks/1",
    });
  });

  it.each([
    [301, "redirect"],
    [308, "redirect"],
    [400, "http_4xx"],
    [410, "http_4xx"],
    [413, "http_4xx"],
    [500, "http_5xx"],
    [599, "http_5xx"],
  ])("fails with the status %s", async (status, reason) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    expect(await sendWebhook(message(), deps)).toEqual({ ok: false, reason, status });
  });
});

describe("signWebhook", () => {
  it("matches the Standard Webhooks test vector", async () => {
    const secret = parseWebhookSecret("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw");
    if (secret === null) throw new Error("invalid secret");
    const body = new TextEncoder().encode('{"test": 2432232314}');
    expect(await signWebhook([secret], "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, body)).toBe(
      "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    );
  });

  it("signs with every secret, separated by spaces", async () => {
    const first = new Uint8Array(32).fill(7);
    const second = parseWebhookSecret("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw");
    if (second === null) throw new Error("invalid secret");
    const signature = await signWebhook([first, second], "msg_x", 1700000000, new TextEncoder().encode("hello"));
    // Computed independently with Node's crypto.createHmac.
    const firstExpected = "v1,iqhKZ5mIZmcKVl4ZOYVfURy0InorQsjLJE7jp1NbYE8=";
    const secondExpected = await signWebhook([second], "msg_x", 1700000000, new TextEncoder().encode("hello"));
    expect(signature).toBe(`${firstExpected} ${secondExpected}`);
  });
});

describe("subscription secrets", () => {
  const plain = crypto.getRandomValues(new Uint8Array(32));

  it("parses padded and unpadded whsec_ secrets", () => {
    expect(parseWebhookSecret("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")?.length).toBe(24);
    const unpadded = `whsec_${btoa("y".repeat(25)).replace(/=+$/, "")}`;
    expect(parseWebhookSecret(unpadded)).toEqual(new TextEncoder().encode("y".repeat(25)));
  });

  it("round-trips with a new IV every time", async () => {
    const key = await subscriptionSecretKey(JWT_SECRET);
    const first = await encryptSecret(key, SUBSCRIPTION_ID, plain);
    const second = await encryptSecret(key, SUBSCRIPTION_ID, plain);
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(first.split(".")[1]).not.toBe(second.split(".")[1]);
    expect(first).not.toBe(second);
    expect(await decryptSecret(key, SUBSCRIPTION_ID, first)).toEqual(plain);
    expect(await decryptSecret(key, SUBSCRIPTION_ID, second)).toEqual(plain);
    // A key derived again from the same JWT_SECRET decrypts it.
    expect(await decryptSecret(await subscriptionSecretKey(JWT_SECRET), SUBSCRIPTION_ID, first)).toEqual(plain);
  });

  it("fails for tampered values", async () => {
    const key = await subscriptionSecretKey(JWT_SECRET);
    const sealed = await encryptSecret(key, SUBSCRIPTION_ID, plain);
    const [version, iv, data] = sealed.split(".") as [string, string, string];
    const flip = (text: string) => (text[0] === "A" ? "B" : "A") + text.slice(1);
    for (const value of [
      `${version}.${iv}.${flip(data)}`,
      `${version}.${flip(iv)}.${data}`,
      `v2.${iv}.${data}`,
      `${version}.${iv}`,
      `${version}.${iv}.${data.slice(0, -4)}`,
      "",
      "v1.!!.!!",
    ]) {
      expect(await decryptSecret(key, SUBSCRIPTION_ID, value)).toBeNull();
    }
  });

  it("fails with a key from another JWT_SECRET", async () => {
    const sealed = await encryptSecret(await subscriptionSecretKey(JWT_SECRET), SUBSCRIPTION_ID, plain);
    expect(await decryptSecret(await subscriptionSecretKey(OTHER_JWT_SECRET), SUBSCRIPTION_ID, sealed)).toBeNull();
  });

  it("is bound to the subscription ID", async () => {
    const key = await subscriptionSecretKey(JWT_SECRET);
    const sealed = await encryptSecret(key, SUBSCRIPTION_ID, plain);
    expect(await decryptSecret(key, "sub_ffffffffffffffffffffffffffffffff", sealed)).toBeNull();
  });
});
