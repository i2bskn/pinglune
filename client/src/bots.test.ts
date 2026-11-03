import { describe, expect, it } from "vitest";
import type { Bot, McpConnection, Subscription } from "../../src/api/types";
import {
  availableDestinations,
  botConnectionExpired,
  botDeliveryLabel,
  botForm,
  createBotRequest,
  replacementWarning,
  updateBotRequest,
} from "./bots";

const HOOK: Subscription = {
  id: "sub_00000000000000000000000000000001",
  kind: "webhook",
  name: "grok",
  callback_host: "api.example.com",
  arguments: {},
  status: "active",
  refresh_before: null,
  expires_at: null,
  created_at: 1,
  updated_at: 1,
  connection: null,
};
const QUEUE: Subscription = { ...HOOK, id: "sub_00000000000000000000000000000002", kind: "queue", name: "muse", callback_host: null };
const ENDED: Subscription = { ...HOOK, id: "sub_00000000000000000000000000000003", status: "unsubscribed" };

const DOT: Bot = {
  id: "bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
  name: "Dot",
  delivery_kind: "mcp",
  delivery: null,
  connection: { id: "mcn_01JC9Z7H2K4M6N8P0Q2R4S6T8V", client_name: "ChatGPT", redirect_host: "chatgpt.com", created_at: 1 },
  status: "no_delivery",
  created_at: 1,
  updated_at: 1,
};
const GROK: Bot = {
  ...DOT,
  id: "bot_01JC9Z7H2K4M6N8P0Q2R4S6T8W",
  name: "Grok Bot",
  delivery_kind: "webhook",
  delivery: { subscription_id: HOOK.id, name: "grok", callback_host: "api.example.com", status: "active" },
  connection: null,
  status: "no_connection",
};

const CONNECTION: McpConnection = {
  kind: "active",
  id: "mcn_01JC9Z7H2K4M6N8P0Q2R4S6T8X",
  grant_id: null,
  client_name: "ChatGPT",
  redirect_host: "chatgpt.com",
  bot: null,
  created_at: 2,
};

describe("bot requests", () => {
  it("builds the creation request of each delivery kind", () => {
    expect(createBotRequest({ name: "Dot", deliveryKind: "mcp", deliverySubscriptionId: "x" })).toEqual({
      ok: true,
      value: { name: "Dot", delivery_kind: "mcp" },
    });
    expect(createBotRequest({ name: "Grok", deliveryKind: "webhook", deliverySubscriptionId: HOOK.id })).toEqual({
      ok: true,
      value: { name: "Grok", delivery_kind: "webhook", delivery_subscription_id: HOOK.id },
    });
    expect(createBotRequest({ name: "Muse", deliveryKind: "queue", deliverySubscriptionId: "" })).toEqual({
      ok: false,
      message: "通知先を選んでください",
    });
  });

  it("sends only the changes of an update", () => {
    expect(updateBotRequest(GROK, botForm(GROK))).toBeNull();
    expect(updateBotRequest(GROK, { ...botForm(GROK), name: "Grok 2" })).toEqual({ ok: true, value: { name: "Grok 2" } });
    expect(updateBotRequest(GROK, { ...botForm(GROK), deliveryKind: "mcp", deliverySubscriptionId: "" })).toEqual({
      ok: true,
      value: { delivery_kind: "mcp", delivery_subscription_id: null },
    });
    expect(updateBotRequest(DOT, { ...botForm(DOT), deliveryKind: "queue", deliverySubscriptionId: QUEUE.id })).toEqual({
      ok: true,
      value: { delivery_kind: "queue", delivery_subscription_id: QUEUE.id },
    });
    expect(updateBotRequest(GROK, { ...botForm(GROK), deliverySubscriptionId: ENDED.id })).toEqual({
      ok: true,
      value: { delivery_subscription_id: ENDED.id },
    });
  });
});

describe("bot choices and labels", () => {
  it("offers the active destinations of the kind that no other bot uses", () => {
    const subscriptions = [HOOK, QUEUE, ENDED];
    expect(availableDestinations(subscriptions, [DOT, GROK], "webhook", null)).toEqual([]);
    expect(availableDestinations(subscriptions, [DOT, GROK], "webhook", GROK.id)).toEqual([HOOK]);
    expect(availableDestinations(subscriptions, [DOT, GROK], "queue", null)).toEqual([QUEUE]);
    expect(availableDestinations(subscriptions, [DOT, GROK], "mcp", null)).toEqual([]);
  });

  it("describes the destination of a bot", () => {
    expect(botDeliveryLabel(DOT)).toBe("MCP Event: なし");
    expect(botDeliveryLabel(GROK)).toBe("Webhook: grok（api.example.com）");
  });

  it("warns before replacing the connection of a bot", () => {
    expect(replacementWarning(DOT, CONNECTION)).toBe("Dot の今の接続（ChatGPT, chatgpt.com）は切断されます");
    expect(replacementWarning(GROK, CONNECTION)).toBeNull();
    expect(replacementWarning(DOT, { ...CONNECTION, id: DOT.connection?.id ?? null })).toBeNull();
    expect(replacementWarning(undefined, CONNECTION)).toBeNull();
  });

  it("tells when the connection of a bot has expired", () => {
    const expired: McpConnection = { ...CONNECTION, kind: "expired", id: DOT.connection?.id ?? null };
    expect(botConnectionExpired(DOT, [expired])).toBe(true);
    expect(botConnectionExpired(DOT, [CONNECTION])).toBe(false);
    expect(botConnectionExpired(GROK, [expired])).toBe(false);
  });
});
