import type { McpConnection, Subscription } from "../../src/api/types";

// The order of the connections on the screen: the ones in use first, then the ones that only wait to be connected
// again, so that expired and disconnected connections gather at the end.
const KIND_ORDER: Record<McpConnection["kind"], number> = { active: 0, legacy: 1, stale: 2, expired: 3 };

export type ConnectionCard = { connection: McpConnection; subscriptions: Subscription[] };

export type ConnectionGroups = {
  // Each connection with the MCP Events subscriptions it made last, in the order above (the API order within a kind).
  cards: ConnectionCard[];
  // The MCP Events subscriptions of no listed connection: made before connections were recorded (connection null),
  // or by a connection that is not in the list. All of them when the connections could not be read.
  orphans: Subscription[];
};

// Sorts the connections and gives each its MCP Events subscriptions (Subscription.connection.id). Webhook
// destinations and polling queues are left out: they belong to bots. connectionsLoaded is false when the list of
// connections could not be read.
export function groupConnectionSubscriptions(
  connections: McpConnection[],
  subscriptions: Subscription[],
  connectionsLoaded = true,
): ConnectionGroups {
  const mcp = subscriptions.filter((subscription) => subscription.kind === "mcp");
  if (!connectionsLoaded) return { cards: [], orphans: mcp };
  const sorted = connections
    .map((connection, index) => ({ connection, index }))
    .sort((a, b) => KIND_ORDER[a.connection.kind] - KIND_ORDER[b.connection.kind] || a.index - b.index)
    .map(({ connection }) => connection);
  const byId = new Map<string, Subscription[]>();
  for (const connection of sorted) if (connection.id !== null) byId.set(connection.id, []);
  const orphans: Subscription[] = [];
  for (const subscription of mcp) {
    const list = subscription.connection === null ? undefined : byId.get(subscription.connection.id);
    if (list === undefined) orphans.push(subscription);
    else list.push(subscription);
  }
  return {
    cards: sorted.map((connection) => ({
      connection,
      subscriptions: connection.id === null ? [] : (byId.get(connection.id) ?? []),
    })),
    orphans,
  };
}
