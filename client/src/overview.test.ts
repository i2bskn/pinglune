import { describe, expect, it } from "vitest";
import type { Bot, Delivery, Source, Subscription } from "../../src/api/types";
import { buildFlow } from "./flow";
import { deliveryHistoryLink, overviewStats, recentFailures, unassignedDestinations } from "./overview";

const source = (id: string, name: string, enabled = true): Source => ({
  id,
  name,
  enabled,
  created_at: 0,
  updated_at: 0,
  active_key_count: 0,
  conversation_start: { enabled: false, daily_limit: 10, max_ai_messages: 10 },
  screening: { enabled: false, available: false },
  email_sender_verification: true,
  email_senders: [],
});

function bot(id: string, overrides: Partial<Bot> = {}): Bot {
  return {
    id,
    name: id,
    delivery_kind: "webhook",
    delivery: { subscription_id: `sub_${id}`, name: "hook", callback_host: "example.com", status: "active" },
    connection: null,
    status: "no_connection",
    sources: [],
    conversation_start: { enabled: false, daily_limit: 10, max_ai_messages: 10 },
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function delivery(id: string, status: Delivery["status"]): Delivery {
  return {
    id,
    event_id: "evt_1",
    subscription_id: "sub_1",
    callback_host: "example.com",
    destination_kind: "webhook",
    destination_name: "hook",
    status,
    attempts: 1,
    last_attempt_at: 0,
    last_http_status: null,
    last_error: status === "failed" ? "http_5xx" : null,
    delivered_at: null,
    created_at: 0,
  };
}

describe("overviewStats", () => {
  it("counts the sources, the bots that events reach and the deliveries by status", () => {
    const sources = [source("src_a", "a"), source("src_b", "b", false), source("src_c", "c")];
    const linked = { id: "src_a", name: "a", enabled: true };
    const bots = [
      bot("bot_ok", { sources: [linked] }),
      // No sources: stopped.
      bot("bot_nosrc"),
      // No destination: stopped.
      bot("bot_nodest", { sources: [linked], delivery: null }),
    ];
    const stats = overviewStats(buildFlow(sources, bots), [
      delivery("d1", "delivered"),
      delivery("d2", "failed"),
      delivery("d3", "pending"),
      delivery("d4", "failed"),
    ]);
    expect(stats.sources).toEqual({ total: 3, disabled: 1, unlinked: 2 });
    expect(stats.bots).toEqual({ total: 3, reaching: 1, stopped: 2 });
    expect(stats.deliveries).toEqual({ total: 4, delivered: 1, pending: 1, failed: 2 });
  });

  it("is all zero with no data", () => {
    const stats = overviewStats(buildFlow([], []), []);
    expect(stats.sources).toEqual({ total: 0, disabled: 0, unlinked: 0 });
    expect(stats.bots).toEqual({ total: 0, reaching: 0, stopped: 0 });
    expect(stats.deliveries).toEqual({ total: 0, delivered: 0, pending: 0, failed: 0 });
  });
});

describe("recentFailures", () => {
  it("keeps the failed deliveries in order, up to the limit", () => {
    const list = [delivery("d1", "failed"), delivery("d2", "delivered"), delivery("d3", "failed"), delivery("d4", "failed")];
    expect(recentFailures(list, 2).map((d) => d.id)).toEqual(["d1", "d3"]);
  });
});

describe("deliveryHistoryLink", () => {
  it("links to the failures when the newest page has one, otherwise to every delivery", () => {
    expect(deliveryHistoryLink([delivery("d1", "delivered"), delivery("d2", "failed")])).toBe(
      "/deliveries/history?status=failed",
    );
    expect(deliveryHistoryLink([delivery("d1", "delivered"), delivery("d2", "pending")])).toBe("/deliveries/history");
    expect(deliveryHistoryLink([])).toBe("/deliveries/history");
  });
});

describe("unassignedDestinations", () => {
  it("keeps the active destinations that belong to no bot", () => {
    const sub = (id: string, status: Subscription["status"], bot: Subscription["bot"]) =>
      ({ id, status, bot }) as Subscription;
    const list = [
      sub("a", "active", null),
      sub("b", "active", { id: "bot_1", name: "x" }),
      sub("c", "expired", null),
      sub("d", "unsubscribed", null),
    ];
    expect(unassignedDestinations(list).map((s) => s.id)).toEqual(["a"]);
  });
});
