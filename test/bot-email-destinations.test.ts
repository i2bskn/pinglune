import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotDetail, BotList, Subscription, SubscriptionList } from "../src/api/types";
import { clock } from "@i2bskn/workers-app-core";
import type { Bindings } from "../src/env";
import type { SourceRow, UserRow } from "../src/db/schema";
import { acceptEvent } from "../src/intake/service";
import { MAX_ACTIVE_EMAIL_DESTINATIONS_PER_WORKSPACE } from "../src/routes/subscriptions";
import {
  countTable,
  createEmailDestination,
  createSource,
  createUser,
  fakeQueue,
  listDeliveries,
  login,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
  type SessionCookies,
} from "./helpers";

const NO_EXPIRY = 253402300799999;
const HOOK_URL = "https://hooks.example.com/pinglune?x=1";
const TOKEN = "secret-token-1";
const TO = "Agent.Smith@Mail.Example.org";
const NORMALIZED_TO = "Agent.Smith@mail.example.org";

// Nothing is sent in these tests: the binding only has to be there.
const fakeSendEmail = {
  send: async () => {
    throw new Error("unexpected send");
  },
} as unknown as SendEmail;

// The bindings of an instance with email deliveries set up, and of one without (the test env has no EMAIL_FROM).
const configured: Partial<Bindings> = { SEND_EMAIL: fakeSendEmail, EMAIL_FROM: "pinglune@notify.example.com" };
const notConfigured: Partial<Bindings> = { SEND_EMAIL: fakeSendEmail, EMAIL_FROM: undefined };

let alice: UserRow;
let aliceCookies: SessionCookies;
let source: SourceRow;
let now: number;
let sequence = 0;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  now = Date.now();
  vi.spyOn(clock, "now").mockImplementation(() => now);
  alice = await createUser({ email: "alice@example.com" });
  aliceCookies = await login(alice.email);
  source = await createSource({ workspaceId: (await personalWorkspaceOf(alice)).id, name: "app" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

type SubscriptionRecord = {
  id: string;
  kind: string;
  name: string | null;
  arguments: string;
  callback_url: string;
  secret: string;
  previous_secret: string | null;
  expires_at: number;
  unsubscribed_at: number | null;
  connection_id: string | null;
  event_name: string;
};

async function errorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return { status: res.status, code: body.error.code, message: body.error.message };
}

async function expectApiError(res: Response, status: number, code: string): Promise<string> {
  const error = await errorOf(res);
  expect({ status: error.status, code: error.code }).toEqual({ status, code });
  return error.message;
}

function create(body: unknown, bindings: Partial<Bindings> = configured) {
  return send("/api/v1/bots", { cookies: aliceCookies, json: body, env: bindings });
}

async function created(body: Record<string, unknown>, bindings: Partial<Bindings> = configured): Promise<Bot> {
  const res = await create(body, bindings);
  expect(res.status).toBe(201);
  return (await res.json()) as Bot;
}

function update(id: string, body: unknown, bindings: Partial<Bindings> = configured) {
  return send(`/api/v1/bots/${id}/update`, { cookies: aliceCookies, json: body, env: bindings });
}

async function updated(id: string, body: unknown, bindings: Partial<Bindings> = configured): Promise<Bot> {
  const res = await update(id, body, bindings);
  expect(res.status).toBe(200);
  return (await res.json()) as Bot;
}

function remove(id: string, query = "") {
  return send(`/api/v1/bots/${id}/delete${query}`, { method: "POST", cookies: aliceCookies });
}

async function subscriptionRow(id: string): Promise<SubscriptionRecord> {
  const row = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first<SubscriptionRecord>();
  if (!row) throw new Error("subscription not found");
  return row;
}

async function detail(id: string, bindings: Partial<Bindings> = configured): Promise<BotDetail> {
  const res = await send(`/api/v1/bots/${id}`, { cookies: aliceCookies, env: bindings });
  expect(res.status).toBe(200);
  return (await res.json()) as BotDetail;
}

async function ingest(): Promise<string> {
  sequence++;
  const result = await acceptEvent(
    { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now },
    { id: source.id, workspaceId: source.workspaceId, name: source.name, enabled: true, screeningEnabled: false },
    { idempotency_key: `k-${sequence}`, type: "alert.observed", summary: `s${sequence}`, labels: {} },
  );
  if (!result.ok) throw new Error(`ingest failed: ${result.error.code}`);
  return result.event_id;
}

describe("POST /api/v1/bots with an email destination", () => {
  it("makes an email destination named after the bot, with the address as mailto:", async () => {
    const bot = await created({
      name: "Mail",
      delivery_kind: "email",
      email: { to: ` ${TO} ` },
      conditions: { types: ["alert.observed"] },
      source_ids: [source.id],
    });
    expect(bot).toMatchObject({
      name: "Mail",
      delivery_kind: "email",
      delivery: { name: "Mail", callback_host: null, status: "active" },
    });
    const id = bot.delivery?.subscription_id ?? "";
    expect(await subscriptionRow(id)).toMatchObject({
      kind: "email",
      name: "Mail",
      callback_url: `mailto:${NORMALIZED_TO}`,
      secret: "",
      previous_secret: null,
      expires_at: NO_EXPIRY,
      unsubscribed_at: null,
      connection_id: null,
      event_name: "pinglune.event",
      arguments: '{"types":["alert.observed"]}',
    });
    // Events of the linked source reach it.
    const eventId = await ingest();
    expect(await listDeliveries("event_id = ?", eventId)).toEqual([expect.objectContaining({ subscription_id: id })]);

    expect((await detail(bot.id)).destination).toEqual({
      subscription_id: id,
      kind: "email",
      name: "Mail",
      callback_host: null,
      email_to: NORMALIZED_TO,
      status: "active",
      arguments: { types: ["alert.observed"] },
    });
  });

  it.each([
    ["an empty address", ""],
    ["a display name", `AI <${TO}>`],
    ["two addresses", "a@example.com, b@example.com"],
    ["no @", "example.com"],
    ["an address over 254 characters", `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}.com`],
  ])("rejects %s with invalid_email", async (_, to) => {
    await expectApiError(await create({ name: "Mail", delivery_kind: "email", email: { to } }), 400, "invalid_email");
    expect(await countTable("bots")).toBe(0);
    expect(await countTable("subscriptions")).toBe(0);
  });

  it("rejects an address that is not a string", async () => {
    await expectApiError(await create({ name: "Mail", delivery_kind: "email", email: { to: 1 } }), 400, "invalid_email");
  });

  it("rejects an address at the domain of the email intake or its subdomains", async () => {
    const withIntake = { ...configured, EMAIL_DOMAIN: "Example.org" };
    for (const to of ["ai@example.org", "ai@mail.example.org"]) {
      const res = await create({ name: "Mail", delivery_kind: "email", email: { to } }, withIntake);
      expect(await expectApiError(res, 400, "invalid_email")).toBe("Pinglune の受付アドレスには送れません");
    }
    expect(await countTable("subscriptions")).toBe(0);
    // Another domain that ends the same way is not the intake's.
    await created({ name: "Mail", delivery_kind: "email", email: { to: "ai@notexample.org" } }, withIntake);
    // An invalid EMAIL_DOMAIN turns the intake off.
    await created({ name: "Mail 2", delivery_kind: "email", email: { to: "ai@example.org" } }, { ...configured, EMAIL_DOMAIN: "not a domain" });
  });

  it("answers 409 email_delivery_not_configured without EMAIL_FROM, after the checks of the input", async () => {
    const message = await expectApiError(
      await create({ name: "Mail", delivery_kind: "email", email: { to: TO } }, notConfigured),
      409,
      "email_delivery_not_configured",
    );
    expect(message).toBe("メールでの配信は設定されていません。EMAIL_FROM を設定してください");
    await expectApiError(
      await create({ name: "Mail", delivery_kind: "email", email: { to: TO } }, { EMAIL_FROM: "x@example.com", SEND_EMAIL: undefined }),
      409,
      "email_delivery_not_configured",
    );
    await expectApiError(await create({ name: "Mail", delivery_kind: "email", email: { to: "bad" } }, notConfigured), 400, "invalid_email");
    expect(await countTable("bots")).toBe(0);
    expect(await countTable("subscriptions")).toBe(0);
  });

  it("takes an existing email destination even without EMAIL_FROM", async () => {
    const mail = await createEmailDestination({ user: alice, name: "mail", to: NORMALIZED_TO });
    const bot = await created({ name: "Mail", delivery_kind: "email", delivery_subscription_id: mail.id }, notConfigured);
    expect(bot.delivery?.subscription_id).toBe(mail.id);
    expect(await countTable("subscriptions")).toBe(1);
    // The destination of another kind is not one.
    await expectApiError(
      await create({ name: "Hook", delivery_kind: "webhook", delivery_subscription_id: mail.id }),
      400,
      "invalid_delivery",
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["email for webhook", { delivery_kind: "webhook", email: { to: TO } }, "invalid_request"],
    ["email for a queue", { delivery_kind: "queue", email: { to: TO } }, "invalid_request"],
    ["email for mcp", { delivery_kind: "mcp", email: { to: TO } }, "invalid_request"],
    ["email with webhook", { delivery_kind: "email", email: { to: TO }, webhook: { url: HOOK_URL, token: TOKEN } }, "invalid_request"],
    ["email with delivery_subscription_id", { delivery_kind: "email", email: { to: TO }, delivery_subscription_id: `sub_${"a".repeat(32)}` }, "invalid_request"],
    ["no destination for email", { delivery_kind: "email" }, "invalid_delivery"],
    ["an email that is not an object", { delivery_kind: "email", email: TO }, "invalid_request"],
    ["an unknown field of email", { delivery_kind: "email", email: { to: TO, cc: TO } }, "unknown_field"],
  ])("rejects %s and makes nothing", async (_, body, code) => {
    await expectApiError(await create({ name: "x", ...body }), 400, code);
    expect(await countTable("bots")).toBe(0);
    expect(await countTable("subscriptions")).toBe(0);
  });

  it("keeps the limit of email destinations", async () => {
    for (let i = 0; i < MAX_ACTIVE_EMAIL_DESTINATIONS_PER_WORKSPACE; i++) {
      await createEmailDestination({ user: alice, name: `m${i}` });
    }
    const res = await create({ name: "Mail", delivery_kind: "email", email: { to: TO } });
    expect(await expectApiError(res, 409, "limit_exceeded")).toBe("メールの配信先は 100 件までです");
    expect(await countTable("bots")).toBe(0);
  });
});

describe("email_delivery_available", () => {
  it("tells whether a new email destination can be made", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot = await created({ name: "Dot", delivery_kind: "mcp" });
    const list = async (bindings: Partial<Bindings>) =>
      ((await (await send("/api/v1/bots", { cookies: aliceCookies, env: bindings })).json()) as BotList).email_delivery_available;
    expect(await list(configured)).toBe(true);
    expect(await list(notConfigured)).toBe(false);
    expect(await list({ ...configured, EMAIL_FROM: "Pinglune <p@example.com>" })).toBe(false);
    expect((await detail(bot.id, configured)).email_delivery_available).toBe(true);
    expect((await detail(bot.id, notConfigured)).email_delivery_available).toBe(false);
  });
});

describe("POST /api/v1/bots/:id/update with an email destination", () => {
  it("replaces the address with a new destination and ends the old one, with the conditions sent", async () => {
    const bot = await created({ name: "Mail", delivery_kind: "email", email: { to: TO }, conditions: { types: ["a.b"] } });
    const old = bot.delivery?.subscription_id ?? "";
    now += 1000;
    const next = await updated(bot.id, { email: { to: "other@example.com" }, conditions: { types: ["c.d"] } });
    const id = next.delivery?.subscription_id ?? "";
    expect(id).not.toBe(old);
    expect(await subscriptionRow(id)).toMatchObject({
      kind: "email",
      name: "Mail",
      callback_url: "mailto:other@example.com",
      arguments: '{"types":["c.d"]}',
    });
    expect((await subscriptionRow(old)).unsubscribed_at).toBe(now);
    // Without conditions, the new destination has none, as for a webhook.
    const again = await updated(bot.id, { email: { to: "third@example.com" } });
    expect((await subscriptionRow(again.delivery?.subscription_id ?? "")).arguments).toBe("{}");
  });

  it("changes between email and webhook, queue and mcp, ending the previous destination", async () => {
    const bot = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } });
    const hook = bot.delivery?.subscription_id ?? "";
    const toEmail = await updated(bot.id, { delivery_kind: "email", email: { to: TO } });
    expect(toEmail.delivery_kind).toBe("email");
    const mail = toEmail.delivery?.subscription_id ?? "";
    expect((await subscriptionRow(mail)).callback_url).toBe(`mailto:${NORMALIZED_TO}`);
    expect((await subscriptionRow(hook)).unsubscribed_at).toBe(now);

    const toQueue = await updated(bot.id, { delivery_kind: "queue" });
    expect(toQueue.delivery_kind).toBe("queue");
    expect((await subscriptionRow(mail)).unsubscribed_at).toBe(now);

    const toEmailAgain = await updated(bot.id, { delivery_kind: "email", email: { to: TO } });
    const mail2 = toEmailAgain.delivery?.subscription_id ?? "";
    const toMcp = await updated(bot.id, { delivery_kind: "mcp" });
    expect(toMcp).toMatchObject({ delivery_kind: "mcp", delivery: null });
    expect((await subscriptionRow(mail2)).unsubscribed_at).toBe(now);

    const toEmailFromMcp = await updated(bot.id, { delivery_kind: "email", email: { to: TO } });
    const mail3 = toEmailFromMcp.delivery?.subscription_id ?? "";
    const toWebhook = await updated(bot.id, { delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } });
    expect(toWebhook.delivery_kind).toBe("webhook");
    expect((await subscriptionRow(mail3)).unsubscribed_at).toBe(now);
  });

  it("takes an existing email destination by delivery_subscription_id, even without EMAIL_FROM", async () => {
    const bot = await created({ name: "Dot", delivery_kind: "mcp" });
    const mail = await createEmailDestination({ user: alice, name: "mail" });
    const next = await updated(bot.id, { delivery_kind: "email", delivery_subscription_id: mail.id }, notConfigured);
    expect(next).toMatchObject({ delivery_kind: "email", delivery: { subscription_id: mail.id } });
  });

  it("answers 409 only when a new email destination is made without EMAIL_FROM", async () => {
    const bot = await created({ name: "Mail", delivery_kind: "email", email: { to: TO } });
    const id = bot.delivery?.subscription_id ?? "";
    await expectApiError(await update(bot.id, { email: { to: "other@example.com" } }, notConfigured), 409, "email_delivery_not_configured");
    // The name and the conditions change without it.
    const renamed = await updated(bot.id, { name: "Mail 2", conditions: { types: ["a.b"] } }, notConfigured);
    expect(renamed.delivery?.subscription_id).toBe(id);
    expect(await subscriptionRow(id)).toMatchObject({ name: "Mail 2", arguments: '{"types":["a.b"]}', unsubscribed_at: null });
    // A missing bot is 404 before the 409.
    await expectApiError(
      await update(`bot_${"0".repeat(26)}`, { email: { to: "other@example.com" } }, notConfigured),
      404,
      "not_found",
    );
    // An invalid address is 400 before the 409.
    await expectApiError(await update(bot.id, { email: { to: "bad" } }, notConfigured), 400, "invalid_email");
  });

  it("rejects the combinations that do not make sense", async () => {
    const hook = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } });
    const mail = await created({ name: "Mail", delivery_kind: "email", email: { to: TO } });
    await expectApiError(await update(hook.id, { email: { to: TO } }), 400, "invalid_request");
    await expectApiError(await update(mail.id, { delivery_kind: "queue", email: { to: TO } }), 400, "invalid_request");
    await expectApiError(await update(mail.id, { email: { to: TO }, webhook: { url: HOOK_URL, token: TOKEN } }), 400, "invalid_request");
    await expectApiError(
      await update(mail.id, { email: { to: TO }, delivery_subscription_id: mail.delivery?.subscription_id ?? "" }),
      400,
      "invalid_request",
    );
    const message = await expectApiError(await update(hook.id, { delivery_kind: "email" }), 400, "invalid_request");
    expect(message).toBe("配信方式をメールに変えるときは email.to か delivery_subscription_id を指定してください");
    await expectApiError(
      await update(hook.id, { email: { to: "ai@example.org" } }, { ...configured, EMAIL_DOMAIN: "example.org" }),
      400,
      "invalid_email",
    );
  });

  it("does not count the destination it ends against the limit", async () => {
    for (let i = 0; i < MAX_ACTIVE_EMAIL_DESTINATIONS_PER_WORKSPACE - 1; i++) {
      await createEmailDestination({ user: alice, name: `m${i}` });
    }
    const bot = await created({ name: "Mail", delivery_kind: "email", email: { to: TO } });
    await updated(bot.id, { email: { to: "other@example.com" } });
    const hook = await created({ name: "Grok", delivery_kind: "webhook", webhook: { url: HOOK_URL, token: TOKEN } });
    await expectApiError(await update(hook.id, { delivery_kind: "email", email: { to: TO } }), 409, "limit_exceeded");
  });
});

describe("POST /api/v1/bots/:id/delete with an email destination", () => {
  it("ends the email destination with the bot", async () => {
    const bot = await created({ name: "Mail", delivery_kind: "email", email: { to: TO } });
    const id = bot.delivery?.subscription_id ?? "";
    now += 1000;
    expect((await remove(bot.id)).status).toBe(204);
    expect((await subscriptionRow(id)).unsubscribed_at).toBe(now);
  });

  it("keeps the email destination with keep_destination=true, for another bot", async () => {
    const bot = await created({ name: "Mail", delivery_kind: "email", email: { to: TO } });
    const id = bot.delivery?.subscription_id ?? "";
    expect((await remove(bot.id, "?keep_destination=true")).status).toBe(204);
    expect((await subscriptionRow(id)).unsubscribed_at).toBeNull();
    const next = await created({ name: "Next", delivery_kind: "email", delivery_subscription_id: id }, notConfigured);
    expect(next.delivery?.subscription_id).toBe(id);
  });
});

describe("the email destinations in /api/v1/subscriptions", () => {
  it("are listed with their address and without a callback host", async () => {
    const bot = await created({ name: "Mail", delivery_kind: "email", email: { to: TO } });
    const broken = await createEmailDestination({ user: alice, name: "broken", callbackUrl: "mailto:a@b@c" });
    const list = (await (await send("/api/v1/subscriptions", { cookies: aliceCookies })).json()) as SubscriptionList;
    const row = list.subscriptions.find((s) => s.id === bot.delivery?.subscription_id);
    expect(row).toEqual({
      id: bot.delivery?.subscription_id,
      kind: "email",
      name: "Mail",
      callback_host: null,
      email_to: NORMALIZED_TO,
      arguments: {},
      status: "active",
      refresh_before: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
      connection: null,
      bot: { id: bot.id, name: "Mail" },
    });
    expect(list.subscriptions.find((s) => s.id === broken.id)).toMatchObject({ kind: "email", email_to: null, bot: null });
  });

  it("are ended by POST /api/v1/subscriptions/:id/delete, leaving the pending deliveries to the consumer", async () => {
    const bot = await created({ name: "Mail", delivery_kind: "email", email: { to: TO }, source_ids: [source.id] });
    const id = bot.delivery?.subscription_id ?? "";
    await ingest();
    now += 1000;
    const res = await send(`/api/v1/subscriptions/${id}/delete`, { method: "POST", cookies: aliceCookies });
    expect(res.status).toBe(200);
    expect((await res.json()) as Subscription).toMatchObject({ id, kind: "email", status: "unsubscribed", email_to: NORMALIZED_TO });
    expect((await subscriptionRow(id)).unsubscribed_at).toBe(now);
    expect((await listDeliveries("subscription_id = ?", id)).map((d) => d.status)).toEqual(["pending"]);
  });
});
