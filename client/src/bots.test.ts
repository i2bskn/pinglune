import { describe, expect, it } from "vitest";
import type { Bot, McpConnection, Source, Subscription } from "../../src/api/types";
import {
  availableDestinations,
  botConnectionExpired,
  botDeliveryLabel,
  botForm,
  botSourcesLabel,
  createBotRequest,
  replacementWarning,
  sourceChoices,
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
  bot: null,
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
  sources: [],
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
    expect(createBotRequest({ name: "Dot", deliveryKind: "mcp", deliverySubscriptionId: "x", sourceIds: [] })).toEqual({
      ok: true,
      value: { name: "Dot", delivery_kind: "mcp" },
    });
    expect(createBotRequest({ name: "Grok", deliveryKind: "webhook", deliverySubscriptionId: HOOK.id, sourceIds: [] })).toEqual({
      ok: true,
      value: { name: "Grok", delivery_kind: "webhook", delivery_subscription_id: HOOK.id },
    });
    expect(createBotRequest({ name: "Muse", deliveryKind: "queue", deliverySubscriptionId: "", sourceIds: [] })).toEqual({
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

describe("the sources of a bot", () => {
  const APP = { id: "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V", name: "app", enabled: true };
  const BATCH = { id: "src_01JC9Z7H2K4M6N8P0Q2R4S6T8W", name: "batch", enabled: false };
  const LINKED: Bot = { ...GROK, sources: [APP, BATCH] };

  it("sends the chosen sources on create, and nothing when they could not be read", () => {
    expect(createBotRequest({ name: "Dot", deliveryKind: "mcp", deliverySubscriptionId: "", sourceIds: [APP.id] })).toEqual({
      ok: true,
      value: { name: "Dot", delivery_kind: "mcp", source_ids: [APP.id] },
    });
    expect(createBotRequest({ name: "Dot", deliveryKind: "mcp", deliverySubscriptionId: "", sourceIds: [] }, false)).toEqual({
      ok: false,
      message: "送信元を読み込めませんでした",
    });
  });

  it("sends the sources on update only when the chosen set changed and they were read", () => {
    expect(botForm(LINKED).sourceIds).toEqual([APP.id, BATCH.id]);
    expect(updateBotRequest(LINKED, { ...botForm(LINKED), sourceIds: [BATCH.id, APP.id] })).toBeNull();
    expect(updateBotRequest(LINKED, { ...botForm(LINKED), sourceIds: [BATCH.id] })).toEqual({
      ok: true,
      value: { source_ids: [BATCH.id] },
    });
    expect(updateBotRequest(LINKED, { ...botForm(LINKED), sourceIds: [] })).toEqual({ ok: true, value: { source_ids: [] } });
    // Not read: left out, so the server keeps them.
    expect(updateBotRequest(LINKED, { ...botForm(LINKED), name: "Grok 2", sourceIds: [] }, false)).toEqual({
      ok: true,
      value: { name: "Grok 2" },
    });
  });

  it("lists the sources of a bot, and tells that a bot without sources receives nothing", () => {
    expect(botSourcesLabel(LINKED)).toBe("受け取る送信元: app, batch（無効）");
    expect(botSourcesLabel(GROK)).toBe("受け取る送信元: なし（イベントは届きません）");
  });

  it("offers the sources by name", () => {
    const source = (id: string, name: string): Source => ({
      id,
      name,
      enabled: true,
      created_at: 1,
      updated_at: 1,
      active_key_count: 0,
    });
    const choices = sourceChoices([source("src_1", "worker"), source("src_2", "app"), source("src_3", "batch")]);
    expect(choices.map((s) => s.name)).toEqual(["app", "batch", "worker"]);
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
