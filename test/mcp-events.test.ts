import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { Validator } from "@cfworker/json-schema";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import { clock } from "../src/clock";
import { subscriptions, type SubscriptionRow, type UserRow } from "../src/db/schema";
import { acceptEvent } from "../src/intake/service";
import { mcpHandler } from "../src/mcp/handler";
import { endSubscription } from "../src/subscriptions/queries";
import { decryptSecret, subscriptionSecretKey } from "../src/subscriptions/secret";
import {
  countTable,
  createSource,
  createUser,
  d1With,
  fakeQueue,
  db,
  login,
  ORIGIN,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
} from "./helpers";

const MCP_ACCEPT = "application/json, text/event-stream";
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CALLBACK = "https://hooks.example.com/pinglune?x=1";
const JWT_SECRET = "test-secret-test-secret-test-secret-0123";

type RpcBody = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: { reason?: string; detail?: string } };
};

type SubscribeResult = { id: string; refreshBefore: string; cursor: null; truncated: false };

type DnsAnswer = { A?: string[]; AAAA?: string[] } | Response | (() => never);

let alice: UserRow;
let bob: UserRow;
let now: number;
// DNS answers by host; hosts not listed resolve to one public IPv4 address.
let dns: Record<string, DnsAnswer>;
let dohQueries: string[];
let callbacks: { request: Request; body: string }[];
let respond: (request: Request, body: string) => Response | Promise<Response>;

function echoChallenge(_request: Request, body: string): Response {
  return Response.json({ challenge: (JSON.parse(body) as { challenge: string }).challenge });
}

beforeEach(async () => {
  await resetDb();
  alice = await createUser({ email: "alice@example.com" });
  bob = await createUser({ email: "bob@example.com" });
  now = T0;
  vi.spyOn(clock, "now").mockImplementation(() => now);
  dns = {};
  dohQueries = [];
  callbacks = [];
  respond = echoChallenge;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type") as "A" | "AAAA";
      dohQueries.push(`${name} ${type}`);
      const answer = dns[name] ?? { A: ["93.184.216.34"] };
      if (answer instanceof Response) return answer.clone();
      if (typeof answer === "function") answer();
      const records = ((answer as { A?: string[]; AAAA?: string[] })[type] ?? []).map((data) => ({
        name,
        type: type === "A" ? 1 : 28,
        TTL: 60,
        data,
      }));
      return Response.json({ Status: 0, Answer: records });
    }
    const body = await request.clone().text();
    callbacks.push({ request, body });
    return respond(request, body);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

async function call(user: UserRow, method: string, params?: unknown, sharedEnv: Cloudflare.Env = env): Promise<RpcBody> {
  const ctx = Object.assign(createExecutionContext(), {
    props: { userId: user.id, authMode: "password" },
    auth: { token: "t", audience: `${ORIGIN}/mcp`, scope: ["mcp"] },
  }) as unknown as OAuthResourceContext<unknown>;
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { Accept: MCP_ACCEPT, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  const res = await mcpHandler.fetch(request, sharedEnv, ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as RpcBody;
}

function secretOf(bytes: Uint8Array): string {
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

function randomSecret(length = 32): { bytes: Uint8Array; secret: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return { bytes, secret: secretOf(bytes) };
}

function subscribeParams(overrides: Record<string, unknown> = {}, delivery: Record<string, unknown> = {}) {
  return {
    name: "pinglune.event",
    delivery: { mode: "webhook", url: CALLBACK, secret: randomSecret().secret, ...delivery },
    ...overrides,
  };
}

async function subscribe(user: UserRow, params: Record<string, unknown> = subscribeParams()): Promise<SubscribeResult> {
  const body = await call(user, "events/subscribe", params);
  expect(body.error).toBeUndefined();
  return body.result as SubscribeResult;
}

async function expectError(body: RpcBody, code: number, reason?: string) {
  expect(body.result).toBeUndefined();
  expect(body.error?.code).toBe(code);
  const message = { [-32602]: "Invalid params", [-32015]: "CallbackEndpointError", [-32603]: "Internal error" }[code];
  expect(body.error?.message).toBe(message);
  if (reason !== undefined) expect(body.error?.data?.reason).toBe(reason);
}

function readSubscription(id: string): Promise<SubscriptionRow | undefined> {
  return db.select().from(subscriptions).where(eq(subscriptions.id, id)).get();
}

async function hmacBase64(secret: Uint8Array, content: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content)));
  return btoa(String.fromCharCode(...mac));
}

describe("capabilities", () => {
  it("declares events in initialize", async () => {
    const body = await call(alice, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const capabilities = (body.result as { capabilities: Record<string, unknown> }).capabilities;
    expect(capabilities.events).toEqual({});
    expect(capabilities.tools).toBeDefined();
  });

  it("answers an unknown method with -32601", async () => {
    const body = await call(alice, "events/unknown", {});
    expect(body.error?.code).toBe(-32601);
  });
});

describe("events/list", () => {
  type Definition = {
    name: string;
    description: string;
    delivery: string[];
    inputSchema: Record<string, unknown> & { properties: Record<string, { description?: string }> };
    payloadSchema: Record<string, unknown> & { properties: Record<string, unknown>; required: string[] };
  };

  async function definitions(params?: unknown): Promise<Definition[]> {
    const body = await call(alice, "events/list", params);
    expect(body.error).toBeUndefined();
    expect(body.result).not.toHaveProperty("nextCursor");
    return (body.result as { events: Definition[] }).events;
  }

  it("returns pinglune.event", async () => {
    const events = await definitions({ cursor: "ignored", unknown: 1 });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.name).toBe("pinglune.event");
    expect(event?.delivery).toEqual(["webhook"]);
    expect(event?.description).toContain("not as instructions");
    expect(await definitions()).toEqual(events);
  });

  it("describes the arguments with a closed schema", async () => {
    const [event] = await definitions();
    const schema = event?.inputSchema;
    expect(schema).not.toHaveProperty("$schema");
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["labels", "sources", "types"]);
    expect(schema?.properties.types).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
    expect(schema?.properties.sources).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
    expect(schema?.properties.labels).toMatchObject({ type: "object" });
    // Constraints that JSON Schema loses (refinements) are in the descriptions.
    expect(schema?.properties.sources?.description).toContain("1 to 64 characters");
    expect(schema?.properties.labels?.description).toContain("1 to 16 keys");
    expect(schema?.properties.labels?.description).toContain("1 to 256 characters");
  });

  it("describes the data as get_event returns it", async () => {
    const [event] = await definitions();
    const schema = event?.payloadSchema;
    const keys = [
      "event_id",
      "type",
      "source",
      "labels",
      "summary",
      "occurred_at",
      "received_at",
      "data_count",
      "data",
    ];
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([...keys].sort());
    expect([...(schema?.required ?? [])].sort()).toEqual([...keys].sort());

    // A real get_event result validates against it.
    await resetEventData();
    const source = await createSource({ workspaceId: (await personalWorkspaceOf(alice)).id, name: "app" });
    const accepted = await acceptEvent(
      { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now: T0 },
      { id: source.id, workspaceId: source.workspaceId, name: source.name, enabled: true },
      {
        idempotency_key: "k",
        type: "alert.observed",
        summary: "s",
        labels: { project: "p" },
        body: { content_type: "text/plain", bytes: new TextEncoder().encode("hi") },
      },
    );
    if (!accepted.ok) throw new Error("ingest failed");
    const tool = await call(alice, "tools/call", { name: "get_event", arguments: { event_id: accepted.event_id } });
    const detail = JSON.parse((tool.result as { content: { text: string }[] }).content[0]?.text ?? "") as unknown;
    const result = new Validator(schema as never, "2020-12").validate(detail);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    await resetEventData();
  });
});

describe("events/subscribe", () => {
  it("verifies the callback, then stores the subscription", async () => {
    const { bytes, secret } = randomSecret();
    const result = await subscribe(alice, subscribeParams({ arguments: { types: ["alert.observed"] } }, { secret }));
    expect(result).toEqual({
      id: expect.stringMatching(/^sub_[0-9a-f]{32}$/),
      refreshBefore: new Date(T0 + 24 * HOUR).toISOString(),
      cursor: null,
      truncated: false,
    });

    expect(callbacks).toHaveLength(1);
    const { request, body } = callbacks[0] ?? { request: new Request(CALLBACK), body: "" };
    expect(request.method).toBe("POST");
    expect(request.url).toBe(CALLBACK);
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("User-Agent")).toBe("Pinglune-Webhooks/1");
    expect(request.headers.get("X-MCP-Subscription-Id")).toBe(result.id);
    const msgId = request.headers.get("webhook-id") ?? "";
    expect(msgId).toMatch(/^msg_verification_[0-9a-f]{32}$/);
    const timestamp = request.headers.get("webhook-timestamp") ?? "";
    expect(timestamp).toBe(String(Math.floor(T0 / 1000)));
    const expected = await hmacBase64(bytes, `${msgId}.${timestamp}.${body}`);
    expect(request.headers.get("webhook-signature")).toBe(`v1,${expected}`);
    const payload = JSON.parse(body) as { type: string; challenge: string };
    expect(Object.keys(payload).sort()).toEqual(["challenge", "type"]);
    expect(payload.type).toBe("verification");
    expect(payload.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.redirect).toBe("manual");

    const row = await readSubscription(result.id);
    expect(row).toMatchObject({
      userId: alice.id,
      workspaceId: (await personalWorkspaceOf(alice)).id,
      eventName: "pinglune.event",
      arguments: '{"types":["alert.observed"]}',
      callbackUrl: CALLBACK,
      previousSecret: null,
      secretRotatedAt: null,
      expiresAt: T0 + 25 * HOUR,
      unsubscribedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    // Encrypted, not the plain secret.
    expect(row?.secret).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(row?.secret).not.toContain(secret.slice("whsec_".length));
    const key = await subscriptionSecretKey(JWT_SECRET);
    expect(await decryptSecret(key, result.id, row?.secret ?? "")).toEqual(bytes);
  });

  it("stores {} for no arguments, whether left out, null or empty", async () => {
    const ids = new Set<string>();
    for (const args of [undefined, null, {}]) {
      const result = await subscribe(alice, subscribeParams(args === undefined ? {} : { arguments: args }));
      ids.add(result.id);
      expect((await readSubscription(result.id))?.arguments).toBe("{}");
    }
    expect(ids.size).toBe(1);
  });

  it("updates an active subscription without verifying again", async () => {
    const { secret } = randomSecret();
    const first = await subscribe(alice, subscribeParams({}, { secret }));
    const stored = await readSubscription(first.id);
    now = T0 + 10 * MINUTE;
    const second = await subscribe(alice, subscribeParams({}, { secret }));
    expect(callbacks).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.refreshBefore).toBe(new Date(now + 24 * HOUR).toISOString());
    expect(await readSubscription(first.id)).toEqual({
      ...stored,
      expiresAt: now + 25 * HOUR,
      updatedAt: now,
    });
  });

  it("keeps the previous secret when the secret changes", async () => {
    const first = await subscribe(alice);
    const stored = await readSubscription(first.id);
    now = T0 + 10 * MINUTE;
    const { bytes, secret } = randomSecret(48);
    await subscribe(alice, subscribeParams({}, { secret }));
    expect(callbacks).toHaveLength(1);
    const row = await readSubscription(first.id);
    expect(row?.previousSecret).toBe(stored?.secret);
    expect(row?.secretRotatedAt).toBe(now);
    const key = await subscriptionSecretKey(JWT_SECRET);
    expect(await decryptSecret(key, first.id, row?.secret ?? "")).toEqual(bytes);
  });

  it("replaces an undecryptable secret without keeping it", async () => {
    const first = await subscribe(alice);
    await env.DB.prepare("UPDATE subscriptions SET secret = 'v1.AAAAAAAAAAAAAAAA.AAAA'").run();
    now = T0 + MINUTE;
    await subscribe(alice);
    const row = await readSubscription(first.id);
    expect(row?.previousSecret).toBeNull();
    expect(row?.secretRotatedAt).toBe(now);
  });

  it("verifies again after the subscription expired, and forgets the previous secret", async () => {
    const first = await subscribe(alice, subscribeParams({ ttlMs: 5 * MINUTE }));
    now = T0 + MINUTE;
    await subscribe(alice, subscribeParams({ ttlMs: 5 * MINUTE }));
    expect((await readSubscription(first.id))?.previousSecret).not.toBeNull();
    expect(callbacks).toHaveLength(1);

    // Still active within the hour of grace after refreshBefore.
    now = T0 + MINUTE + 5 * MINUTE + HOUR - 1;
    await subscribe(alice, subscribeParams({ ttlMs: 5 * MINUTE }));
    expect(callbacks).toHaveLength(1);

    now += 5 * MINUTE + HOUR;
    await subscribe(alice, subscribeParams({ ttlMs: 5 * MINUTE }));
    expect(callbacks).toHaveLength(2);
    const row = await readSubscription(first.id);
    expect(row).toMatchObject({ previousSecret: null, secretRotatedAt: null, createdAt: T0 });
  });

  it("verifies again after unsubscribe, and does not store when that fails", async () => {
    const first = await subscribe(alice);
    expect((await call(alice, "events/unsubscribe", { name: "pinglune.event", delivery: { url: CALLBACK } })).result).toEqual(
      {},
    );
    respond = () => new Response("nope", { status: 500 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expectError(await call(alice, "events/subscribe", subscribeParams()), -32015, "http_5xx");
    expect((await readSubscription(first.id))?.unsubscribedAt).toBe(T0);

    respond = echoChallenge;
    now = T0 + MINUTE;
    await subscribe(alice);
    expect(callbacks).toHaveLength(3);
    expect((await readSubscription(first.id))?.unsubscribedAt).toBeNull();
  });

  it("derives different IDs for other arguments, URLs and users", async () => {
    const base = await subscribe(alice);
    const ids = [
      base.id,
      (await subscribe(alice, subscribeParams({ arguments: { types: ["a.b"] } }))).id,
      (await subscribe(alice, subscribeParams({ arguments: { types: ["b.c", "a.b"] } }))).id,
      (await subscribe(alice, subscribeParams({ arguments: { types: ["a.b", "b.c"] } }))).id,
      (await subscribe(alice, subscribeParams({}, { url: "https://hooks.example.com/other" }))).id,
      (await subscribe(bob)).id,
    ];
    expect(new Set(ids).size).toBe(ids.length);
    // The same arguments in another key order are the same subscription.
    const reordered = await subscribe(
      alice,
      subscribeParams({ arguments: { labels: { b: "1", a: "2" }, types: ["x.y"] } }),
    );
    const again = await subscribe(
      alice,
      subscribeParams({ arguments: { types: ["x.y"], labels: { a: "2", b: "1" } } }),
    );
    expect(again.id).toBe(reordered.id);
  });

  it.each([
    ["omitted", undefined, 24 * HOUR],
    ["null", null, 24 * HOUR],
    ["0", 0, 5 * MINUTE],
    ["one minute", MINUTE, 5 * MINUTE],
    ["ten minutes", 10 * MINUTE, 10 * MINUTE],
    ["48 hours", 48 * HOUR, 24 * HOUR],
  ])("clamps ttlMs %s", async (_, ttlMs, ttl) => {
    const result = await subscribe(alice, subscribeParams(ttlMs === undefined ? {} : { ttlMs }));
    expect(result.refreshBefore).toBe(new Date(T0 + ttl).toISOString());
    expect((await readSubscription(result.id))?.expiresAt).toBe(T0 + ttl + HOUR);
  });

  it.each([-1, 1.5, "60000", {}, Number.MAX_SAFE_INTEGER + 1])("rejects ttlMs %s", async (ttlMs) => {
    await expectError(await call(alice, "events/subscribe", subscribeParams({ ttlMs })), -32602, "invalid_ttl");
  });

  it("ignores cursor and unknown params", async () => {
    const result = await subscribe(alice, subscribeParams({ cursor: "abc", future: { x: 1 } }, { extra: true }));
    expect(result.cursor).toBeNull();
  });
});

describe("events/subscribe callback verification failures", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each<[string, (request: Request, body: string) => Response | Promise<Response>]>([
    ["http_4xx", () => new Response("gone", { status: 410 })],
    ["http_5xx", () => new Response("down", { status: 503 })],
    ["redirect", () => new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/" } })],
    ["challenge_failed", () => Response.json({ challenge: "wrong" })],
    ["challenge_failed", () => new Response("not json")],
    ["challenge_failed", () => Response.json({ challenge: 42 })],
    ["challenge_failed", () => new Response(null, { status: 204 })],
    [
      "timeout",
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ],
    [
      "connection_failed",
      () => {
        throw new TypeError("Network connection lost.");
      },
    ],
  ])("answers %s with -32015 and stores nothing", async (reason, handler) => {
    respond = handler;
    const { secret } = randomSecret();
    const body = await call(alice, "events/subscribe", subscribeParams({}, { secret }));
    await expectError(body, -32015, reason);
    expect(await countTable("subscriptions")).toBe(0);
    expect(callbacks).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(secret.slice("whsec_".length));
    expect(warn).toHaveBeenCalledWith("callback verification failed", {
      subscriptionId: expect.stringMatching(/^sub_/),
      host: "hooks.example.com",
      reason,
    });
  });
});

describe("callback URLs", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    "http://hooks.example.com/cb",
    "https://user:pw@hooks.example.com/cb",
    "https://user@hooks.example.com/cb",
    "https://hooks.example.com:8443/cb",
    "https://hooks.example.com/cb#frag",
    "https://hooks.example.com/cb#",
    "not a url",
    `https://hooks.example.com/${"a".repeat(2048)}`,
    42,
    undefined,
  ])("rejects %s with invalid_url", async (url) => {
    await expectError(await call(alice, "events/subscribe", subscribeParams({}, { url })), -32602, "invalid_url");
    expect(callbacks).toHaveLength(0);
  });

  it("accepts an explicit :443 and stores the normalized URL", async () => {
    const result = await subscribe(alice, subscribeParams({}, { url: "https://Hooks.Example.com:443/a/../cb" }));
    expect((await readSubscription(result.id))?.callbackUrl).toBe("https://hooks.example.com/cb");
  });

  it.each([
    "https://127.0.0.1/cb",
    "https://8.8.8.8/cb",
    "https://2130706433/cb",
    "https://0x7f.1/cb",
    "https://[::1]/cb",
    "https://[::ffff:127.0.0.1]/cb",
    "https://[2606:4700::1111]/cb",
    "https://localhost/cb",
    "https://app.localhost/cb",
    "https://printer.local/cb",
    "https://foo.internal/cb",
    "https://router.home.arpa/cb",
    "https://nas.lan/cb",
    "https://intranet/cb",
    "https://intranet./cb",
    `${ORIGIN}/cb`,
    "https://PINGLUNE.test./cb",
  ])("blocks %s without resolving or sending", async (url) => {
    await expectError(
      await call(alice, "events/subscribe", subscribeParams({}, { url })),
      -32015,
      "blocked_destination",
    );
    expect(dohQueries).toEqual([]);
    expect(callbacks).toHaveLength(0);
    expect(await countTable("subscriptions")).toBe(0);
  });

  it("blocks the host of APP_ORIGIN", async () => {
    const sharedEnv = { ...env, APP_ORIGIN: "https://pinglune.example.com" } as Cloudflare.Env;
    const body = await call(
      alice,
      "events/subscribe",
      subscribeParams({}, { url: "https://pinglune.example.com/cb" }),
      sharedEnv,
    );
    await expectError(body, -32015, "blocked_destination");
    expect(dohQueries).toEqual([]);
  });

  it("does not block every workers.dev host", async () => {
    await subscribe(alice, subscribeParams({}, { url: "https://receiver.someone.workers.dev/cb" }));
    expect(callbacks).toHaveLength(1);
  });

  it.each([
    ["127.0.0.1", { A: ["127.0.0.1"] }],
    ["10.0.0.1", { A: ["10.0.0.1"] }],
    ["169.254.169.254", { A: ["169.254.169.254"] }],
    ["100.64.0.1", { A: ["100.64.0.1"] }],
    ["::1", { AAAA: ["::1"] }],
    ["fc00::1", { AAAA: ["fc00::1"] }],
    ["fe80::1", { AAAA: ["fe80::1"] }],
    ["::ffff:10.0.0.1", { AAAA: ["::ffff:10.0.0.1"] }],
    ["64:ff9b::a00:1", { AAAA: ["64:ff9b::a00:1"] }],
    ["a private address next to public ones", { A: ["93.184.216.34", "10.0.0.1"], AAAA: ["2606:4700::1111"] }],
    ["a private IPv6 next to a public IPv4", { A: ["93.184.216.34"], AAAA: ["fd12::1"] }],
  ])("blocks a host that resolves to %s", async (_, answer) => {
    dns["hooks.example.com"] = answer;
    await expectError(await call(alice, "events/subscribe", subscribeParams()), -32015, "blocked_destination");
    expect(dohQueries.sort()).toEqual(["hooks.example.com A", "hooks.example.com AAAA"]);
    expect(callbacks).toHaveLength(0);
  });

  it("accepts a host with IPv6 addresses only", async () => {
    dns["hooks.example.com"] = { AAAA: ["2606:4700::1111"] };
    await subscribe(alice);
    expect(callbacks).toHaveLength(1);
  });

  it.each<[string, DnsAnswer]>([
    ["no addresses", {}],
    ["a non-200 answer", new Response("error", { status: 500 })],
    ["NXDOMAIN", Response.json({ Status: 3 })],
    ["SERVFAIL", Response.json({ Status: 2 })],
    ["invalid JSON", new Response("not json", { status: 200 })],
    [
      "a network error",
      () => {
        throw new TypeError("Network connection lost.");
      },
    ],
    [
      "a timeout",
      () => {
        throw new DOMException("timeout", "TimeoutError");
      },
    ],
  ])("answers dns_failed for %s", async (_, answer) => {
    dns["hooks.example.com"] = answer;
    await expectError(await call(alice, "events/subscribe", subscribeParams()), -32015, "dns_failed");
    expect(callbacks).toHaveLength(0);
  });
});

describe("events/subscribe params", () => {
  it.each([
    ["an unknown event name", subscribeParams({ name: "other.event" }), "unknown_event"],
    ["a missing event name", { ...subscribeParams(), name: undefined }, "unknown_event"],
    ["a non-string event name", subscribeParams({ name: 1 }), "unknown_event"],
    ["mode push", subscribeParams({}, { mode: "push" }), "unsupported_delivery_mode"],
    ["a missing mode", subscribeParams({}, { mode: undefined }), "unsupported_delivery_mode"],
    ["a missing delivery", { ...subscribeParams(), delivery: undefined }, "invalid_delivery"],
    ["a string delivery", subscribeParams({ delivery: "webhook" }), "invalid_delivery"],
    ["an unknown argument", subscribeParams({ arguments: { project: "a" } }), "invalid_arguments"],
    ["an empty types array", subscribeParams({ arguments: { types: [] } }), "invalid_arguments"],
    ["an array of arguments", subscribeParams({ arguments: [] }), "invalid_arguments"],
    ["string arguments", subscribeParams({ arguments: "all" }), "invalid_arguments"],
    ["17 labels", subscribeParams({ arguments: { labels: Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]),
    ) } }), "invalid_arguments"],
  ])("rejects %s", async (_, params, reason) => {
    await expectError(await call(alice, "events/subscribe", params), -32602, reason);
    expect(callbacks).toHaveLength(0);
  });

  it("explains invalid arguments without echoing the values", async () => {
    const body = await call(alice, "events/subscribe", subscribeParams({ arguments: { types: ["NOT VALID SECRET-ISH"] } }));
    await expectError(body, -32602, "invalid_arguments");
    expect(body.error?.data?.detail).toContain("types.0");
    expect(JSON.stringify(body)).not.toContain("NOT VALID SECRET-ISH");
  });

  function secretOfLength(length: number, padding = true): string {
    const secret = secretOf(new Uint8Array(length).fill(7));
    return padding ? secret : secret.replace(/=+$/, "");
  }

  it.each([
    ["no prefix", btoa("x".repeat(32))],
    ["invalid base64", "whsec_!!!!"],
    ["whitespace", `whsec_${btoa("x".repeat(30))} `],
    ["an inner space", `whsec_${btoa("x".repeat(15))} ${btoa("y".repeat(15))}`],
    ["base64url", `whsec_${"_-".repeat(20)}`],
    ["23 bytes", secretOfLength(23)],
    ["65 bytes", secretOfLength(65)],
    ["empty", "whsec_"],
    ["not a string", 42],
    ["missing", undefined],
  ])("rejects a secret with %s", async (_, secret) => {
    await expectError(await call(alice, "events/subscribe", subscribeParams({}, { secret })), -32602, "invalid_secret");
    expect(callbacks).toHaveLength(0);
  });

  it.each([
    ["24 bytes", secretOfLength(24)],
    ["64 bytes", secretOfLength(64)],
    ["no padding", secretOfLength(25, false)],
  ])("accepts a secret of %s", async (_, secret) => {
    await subscribe(alice, subscribeParams({}, { secret }));
  });
});

describe("events/unsubscribe", () => {
  function unsubscribeParams(args?: unknown, delivery: Record<string, unknown> = {}) {
    return {
      name: "pinglune.event",
      ...(args === undefined ? {} : { arguments: args }),
      delivery: { mode: "webhook", url: CALLBACK, ...delivery },
    };
  }

  it("ends the subscription and answers {}", async () => {
    const { id } = await subscribe(alice, subscribeParams({ arguments: { types: ["a.b"] } }));
    now = T0 + MINUTE;
    const body = await call(alice, "events/unsubscribe", unsubscribeParams({ types: ["a.b"] }, { secret: "ignored" }));
    expect(body).toMatchObject({ result: {} });
    expect(body.result).toEqual({});
    expect(await readSubscription(id)).toMatchObject({ unsubscribedAt: now, updatedAt: now });

    // Again: still {}, and the end time stays.
    now = T0 + 2 * MINUTE;
    expect((await call(alice, "events/unsubscribe", unsubscribeParams({ types: ["a.b"] }))).result).toEqual({});
    expect((await readSubscription(id))?.unsubscribedAt).toBe(T0 + MINUTE);
  });

  it("answers {} for a subscription that does not exist", async () => {
    expect((await call(alice, "events/unsubscribe", unsubscribeParams())).result).toEqual({});
  });

  it("accepts a missing mode, null arguments and arguments the filter would reject", async () => {
    const { id } = await subscribe(alice);
    expect((await call(alice, "events/unsubscribe", unsubscribeParams(null, { mode: undefined }))).result).toEqual({});
    expect((await readSubscription(id))?.unsubscribedAt).toBe(T0);
    expect((await call(alice, "events/unsubscribe", unsubscribeParams({ retired: ["x"] }))).result).toEqual({});
  });

  it("matches arguments as canonical JSON, like subscribe", async () => {
    const args = { labels: { zone: "z", app: "a" }, types: ["x.y"], sources: ["s"] };
    const { id } = await subscribe(alice, subscribeParams({ arguments: args }));
    // zod does not change the values, so the stored arguments equal the raw ones.
    expect((await readSubscription(id))?.arguments).toBe(canonicalJson(args));
    const reordered = { sources: ["s"], types: ["x.y"], labels: { app: "a", zone: "z" } };
    expect((await call(alice, "events/unsubscribe", unsubscribeParams(reordered))).result).toEqual({});
    expect((await readSubscription(id))?.unsubscribedAt).toBe(T0);
  });

  it("does not resolve or send to the callback", async () => {
    await call(alice, "events/unsubscribe", unsubscribeParams(undefined, { url: "https://127.0.0.1/cb" }));
    expect(dohQueries).toEqual([]);
    expect(callbacks).toHaveLength(0);
  });

  it("does not end another user's subscription", async () => {
    const { id } = await subscribe(alice);
    expect((await call(bob, "events/unsubscribe", unsubscribeParams())).result).toEqual({});
    expect((await readSubscription(id))?.unsubscribedAt).toBeNull();
  });

  it("ends a row by ID only for its user", async () => {
    const { id } = await subscribe(alice);
    await endSubscription(db, id, bob.id, T0);
    expect((await readSubscription(id))?.unsubscribedAt).toBeNull();
    await endSubscription(db, id, alice.id, T0);
    expect((await readSubscription(id))?.unsubscribedAt).toBe(T0);
  });

  it.each([
    ["an unknown event name", { ...unsubscribeParams(), name: "x" }, "unknown_event"],
    ["mode push", unsubscribeParams(undefined, { mode: "push" }), "unsupported_delivery_mode"],
    ["a missing delivery", { name: "pinglune.event" }, "invalid_delivery"],
    ["an http URL", unsubscribeParams(undefined, { url: "http://hooks.example.com/" }), "invalid_url"],
    ["array arguments", unsubscribeParams([]), "invalid_arguments"],
    ["string arguments", unsubscribeParams("x"), "invalid_arguments"],
  ])("rejects %s", async (_, params, reason) => {
    await expectError(await call(alice, "events/unsubscribe", params), -32602, reason);
  });
});

describe("unexpected errors", () => {
  it("answers -32603 without the error message", async () => {
    const failing = d1With({
      prepare: (query: string) => {
        if (query.includes("subscriptions")) throw new Error("D1_ERROR: database is on fire");
        return env.DB.prepare(query);
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sharedEnv = { ...env, DB: failing } as Cloudflare.Env;
    for (const method of ["events/subscribe", "events/unsubscribe"]) {
      const body = await call(alice, method, subscribeParams(), sharedEnv);
      await expectError(body, -32603);
      expect(body.error?.data).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("on fire");
    }
    expect(error).toHaveBeenCalledWith(
      "mcp events method failed",
      expect.objectContaining({ method: "events/subscribe", userId: alice.id }),
    );
  });

  it("answers -32603 when the personal workspace is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("DELETE FROM workspaces WHERE owner_user_id = ?").bind(alice.id).run();
    await expectError(await call(alice, "events/subscribe", subscribeParams()), -32603);
    expect(callbacks).toHaveLength(0);
  });
});

describe("losing access", () => {
  const NEW_PASSWORD = "a brand new password";

  // Sessions and tokens use the real time.
  beforeEach(() => {
    vi.mocked(clock.now).mockRestore();
  });

  async function subscribed(user: UserRow): Promise<string> {
    const { id } = await subscribe(user);
    return id;
  }

  async function expectEnded(id: string) {
    expect((await readSubscription(id))?.unsubscribedAt).not.toBeNull();
  }

  it("ends the subscriptions when the user changes the password", async () => {
    const id = await subscribed(alice);
    const other = await subscribed(bob);
    const cookies = await login(alice.email);
    const res = await send("/api/v1/me/password", {
      cookies,
      json: { current_password: "correct horse battery", new_password: NEW_PASSWORD },
    });
    expect(res.status).toBe(204);
    await expectEnded(id);
    expect((await readSubscription(other))?.unsubscribedAt).toBeNull();
  });

  describe("by an admin", () => {
    let admin: UserRow;
    beforeEach(async () => {
      admin = await createUser({ email: "admin@example.com", role: "admin" });
    });

    it("ends the subscriptions when an admin resets the password", async () => {
      const id = await subscribed(alice);
      const cookies = await login(admin.email);
      const res = await send(`/api/v1/users/${alice.id}/password`, { cookies, json: { password: NEW_PASSWORD } });
      expect(res.status).toBe(204);
      await expectEnded(id);
    });

    it("ends the subscriptions when an admin revokes the sessions", async () => {
      const id = await subscribed(alice);
      const cookies = await login(admin.email);
      const res = await send(`/api/v1/users/${alice.id}/revoke-sessions`, { method: "POST", cookies });
      expect(res.status).toBe(204);
      await expectEnded(id);
    });

    it("ends the subscriptions without OAUTH_PROVIDER", async () => {
      const id = await subscribed(alice);
      // Plain http on a non-loopback host: OAuthProvider is bypassed (src/index.ts).
      const origin = "http://pinglune.internal.example";
      const cookies = await login(admin.email);
      const res = await send(`${origin}/api/v1/users/${alice.id}/revoke-sessions`, { method: "POST", cookies });
      expect(res.status).toBe(204);
      await expectEnded(id);
    });

    it("deletes the subscriptions when the user is deleted", async () => {
      const id = await subscribed(alice);
      const other = await subscribed(bob);
      const cookies = await login(admin.email);
      const res = await send(`/api/v1/users/${alice.id}`, { method: "DELETE", cookies });
      expect(res.status).toBe(204);
      expect(await readSubscription(id)).toBeUndefined();
      expect(await readSubscription(other)).toBeDefined();
    });
  });
});
