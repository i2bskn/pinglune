import { describe, expect, it } from "vitest";
import type { McpConnection, Subscription } from "../../src/api/types";
import { groupConnectionSubscriptions } from "./connections";

function connection(kind: McpConnection["kind"], id: string | null, grant: string | null = null): McpConnection {
  return { kind, id, grant_id: grant, client_name: "ChatGPT", redirect_host: "chatgpt.com", bot: null, created_at: 1 };
}

function subscription(id: string, connectionId: string | null, kind: Subscription["kind"] = "mcp"): Subscription {
  return {
    id,
    kind,
    name: null,
    callback_host: "connectors.example.com",
    arguments: {},
    status: "active",
    refresh_before: 1,
    expires_at: 2,
    created_at: 1,
    updated_at: 1,
    connection: connectionId === null ? null : { id: connectionId, client_name: "ChatGPT", bot_name: null },
    bot: null,
  };
}

const EXPIRED = connection("expired", "mcn_expired");
const ACTIVE = connection("active", "mcn_active");
const STALE = connection("stale", null, "grant_stale");
const LEGACY = connection("legacy", null, "grant_legacy");
const ACTIVE2 = connection("active", "mcn_active2");

describe("groupConnectionSubscriptions", () => {
  it("orders the connections active, legacy, stale, expired, keeping the order within a kind", () => {
    const { cards } = groupConnectionSubscriptions([EXPIRED, ACTIVE, STALE, LEGACY, ACTIVE2], []);
    expect(cards.map((card) => card.connection)).toEqual([ACTIVE, ACTIVE2, LEGACY, STALE, EXPIRED]);
  });

  it("gives each connection its MCP Events subscriptions, and the rest to the subscriptions of earlier connections", () => {
    const mine = subscription("sub_1", "mcn_active");
    const expired = subscription("sub_2", "mcn_expired");
    const legacy = subscription("sub_3", null);
    const unknown = subscription("sub_4", "mcn_gone");
    const webhook = subscription("sub_5", null, "webhook");
    const { cards, orphans } = groupConnectionSubscriptions([ACTIVE, EXPIRED, LEGACY], [mine, expired, legacy, unknown, webhook]);
    expect(cards.map((card) => [card.connection.id ?? card.connection.grant_id, card.subscriptions.map((s) => s.id)])).toEqual([
      ["mcn_active", ["sub_1"]],
      ["grant_legacy", []],
      ["mcn_expired", ["sub_2"]],
    ]);
    expect(orphans.map((s) => s.id)).toEqual(["sub_3", "sub_4"]);
  });

  it("puts every MCP Events subscription with the earlier connections when the connections could not be read", () => {
    const mine = subscription("sub_1", "mcn_active");
    const { cards, orphans } = groupConnectionSubscriptions([], [mine, subscription("sub_5", null, "queue")], false);
    expect(cards).toEqual([]);
    expect(orphans.map((s) => s.id)).toEqual(["sub_1"]);
  });
});
