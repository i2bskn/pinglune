import { describe, expect, it } from "vitest";
import type { BotDetail, Subscription } from "../../src/api/types";
import {
  EMPTY_NEW_BOT_FORM,
  conditionsFormOf,
  conditionsRequest,
  deliveryChangeKinds,
  deliveryChangeRequest,
  deliveryChangeWarning,
  destinationFromQuery,
  newBotRequest,
  sourceTabOf,
  sourceTabPath,
  unassignedBotDestinations,
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
const USED: Subscription = { ...HOOK, id: "sub_00000000000000000000000000000003", bot: { id: "bot_1", name: "Grok" } };
const ENDED: Subscription = { ...HOOK, id: "sub_00000000000000000000000000000004", status: "unsubscribed" };
const MCP: Subscription = { ...HOOK, id: "sub_00000000000000000000000000000005", kind: "mcp", name: null };

const QUEUE_DESTINATION: NonNullable<BotDetail["destination"]> = {
  subscription_id: QUEUE.id,
  kind: "queue",
  name: "Muse",
  callback_host: null,
  status: "active",
  arguments: {},
};

const MUSE: BotDetail = {
  id: "bot_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
  name: "Muse",
  delivery_kind: "queue",
  delivery: { subscription_id: QUEUE.id, name: "Muse", callback_host: null, status: "active" },
  connection: null,
  status: "no_connection",
  sources: [],
  created_at: 1,
  updated_at: 1,
  destination: QUEUE_DESTINATION,
};

describe("newBotRequest", () => {
  it("makes a webhook destination with the URL, the key and the conditions", () => {
    expect(
      newBotRequest({
        ...EMPTY_NEW_BOT_FORM,
        name: "Grok",
        deliveryKind: "webhook",
        url: "https://hooks.example.com/a",
        token: "t",
        conditions: { types: "a.b, c.d", labels: "env=prod" },
        sourceIds: ["src_1"],
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Grok",
        delivery_kind: "webhook",
        webhook: { url: "https://hooks.example.com/a", token: "t" },
        conditions: { types: ["a.b", "c.d"], labels: { env: "prod" } },
        source_ids: ["src_1"],
      },
    });
  });

  it("makes a queue without a destination ID, and leaves out empty conditions", () => {
    expect(newBotRequest({ ...EMPTY_NEW_BOT_FORM, name: "Muse", deliveryKind: "queue", url: "x", token: "y" })).toEqual({
      ok: true,
      value: { name: "Muse", delivery_kind: "queue" },
    });
  });

  it("sends nothing but the name and the kind for MCP Event", () => {
    expect(
      newBotRequest({ ...EMPTY_NEW_BOT_FORM, name: "Dot", url: "x", token: "y", conditions: { types: "a", labels: "" } }),
    ).toEqual({ ok: true, value: { name: "Dot", delivery_kind: "mcp" } });
  });

  it("uses an existing destination by ID, without the URL, the key or the conditions", () => {
    expect(
      newBotRequest({
        ...EMPTY_NEW_BOT_FORM,
        name: "Grok",
        deliveryKind: "webhook",
        url: "x",
        token: "y",
        conditions: { types: "a", labels: "" },
        destinationId: HOOK.id,
      }),
    ).toEqual({ ok: true, value: { name: "Grok", delivery_kind: "webhook", delivery_subscription_id: HOOK.id } });
  });

  it("rejects invalid labels and unreadable sources", () => {
    expect(
      newBotRequest({ ...EMPTY_NEW_BOT_FORM, name: "Muse", deliveryKind: "queue", conditions: { types: "", labels: "env" } }),
    ).toEqual({ ok: false, message: "ラベルは1行に キー=値 の形で、キーを重複させずに書いてください" });
    expect(newBotRequest({ ...EMPTY_NEW_BOT_FORM, name: "Dot" }, false)).toEqual({
      ok: false,
      message: "送信元を読み込めませんでした",
    });
  });
});

describe("the destinations a bot can be made with", () => {
  it("are the active webhook destinations and queues without a bot", () => {
    expect(unassignedBotDestinations([HOOK, QUEUE, USED, ENDED, MCP])).toEqual([HOOK, QUEUE]);
  });

  it("are taken from ?destination= only when they may be used", () => {
    const all = [HOOK, QUEUE, USED, ENDED, MCP];
    expect(destinationFromQuery(new URLSearchParams(`destination=${QUEUE.id}`), all)).toEqual(QUEUE);
    for (const id of [USED.id, ENDED.id, MCP.id, "sub_x", ""]) {
      expect(destinationFromQuery(new URLSearchParams(`destination=${id}`), all)).toBeNull();
    }
    expect(destinationFromQuery(new URLSearchParams(""), all)).toBeNull();
  });
});

describe("conditions", () => {
  it("are read from the form and back", () => {
    expect(conditionsRequest({ types: " a.b ,", labels: "" })).toEqual({ ok: true, value: { types: ["a.b"] } });
    expect(conditionsRequest({ types: "", labels: "" })).toEqual({ ok: true, value: {} });
    expect(conditionsFormOf({ types: ["a.b", "c"], labels: { env: "prod", team: "x" } })).toEqual({
      types: "a.b, c",
      labels: "env=prod\nteam=x",
    });
    expect(conditionsFormOf(null)).toEqual({ types: "", labels: "" });
  });
});

describe("the change of the delivery kind", () => {
  it("offers a new webhook destination again, but not a new queue or MCP Event again", () => {
    expect(deliveryChangeKinds({ delivery_kind: "webhook" })).toEqual(["mcp", "webhook", "queue"]);
    expect(deliveryChangeKinds({ delivery_kind: "queue" })).toEqual(["mcp", "webhook"]);
    expect(deliveryChangeKinds({ delivery_kind: "mcp" })).toEqual(["webhook", "queue"]);
  });

  it("builds the request of each kind", () => {
    const conditions = { types: "a.b", labels: "" };
    expect(deliveryChangeRequest({ kind: "mcp", url: "x", token: "y", conditions })).toEqual({
      ok: true,
      value: { delivery_kind: "mcp" },
    });
    expect(deliveryChangeRequest({ kind: "webhook", url: "https://h.example.com/", token: "t", conditions })).toEqual({
      ok: true,
      value: { delivery_kind: "webhook", webhook: { url: "https://h.example.com/", token: "t" }, conditions: { types: ["a.b"] } },
    });
    expect(deliveryChangeRequest({ kind: "queue", url: "", token: "", conditions: { types: "", labels: "" } })).toEqual({
      ok: true,
      value: { delivery_kind: "queue" },
    });
  });

  it("warns that the current destination ends", () => {
    expect(deliveryChangeWarning(MUSE)).toContain("今のキュー「Muse」は終了します");
    const hook: BotDetail = {
      ...MUSE,
      delivery_kind: "webhook",
      destination: { ...QUEUE_DESTINATION, kind: "webhook", name: "Grok" },
    };
    expect(deliveryChangeWarning(hook)).toBe("今の Webhook 配信先「Grok」は終了します。まだ送っていない配信は送られません。");
    expect(deliveryChangeWarning({ ...MUSE, destination: { ...QUEUE_DESTINATION, status: "unsubscribed" } })).toBeNull();
    expect(deliveryChangeWarning({ ...MUSE, delivery_kind: "mcp", destination: null })).toBeNull();
  });
});

describe("the tabs of a source", () => {
  it("reads the tab, overview for none or an unknown one", () => {
    expect(sourceTabOf(new URLSearchParams("tab=intake"))).toBe("intake");
    expect(sourceTabOf(new URLSearchParams("tab=settings"))).toBe("settings");
    expect(sourceTabOf(new URLSearchParams("tab=overview"))).toBe("overview");
    expect(sourceTabOf(new URLSearchParams("tab=other"))).toBe("overview");
    expect(sourceTabOf(new URLSearchParams(""))).toBe("overview");
  });

  it("links to each tab", () => {
    expect(sourceTabPath("src_1", "overview")).toBe("/sources/src_1");
    expect(sourceTabPath("src_1", "intake")).toBe("/sources/src_1?tab=intake");
    expect(sourceTabPath("src_1", "settings")).toBe("/sources/src_1?tab=settings");
  });
});
