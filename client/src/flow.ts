import type { Bot, BotDeliveryKind, Source } from "../../src/api/types";
import { DELIVERY_KIND_LABELS } from "./bots";

// The model of the flow map of the home screen: the sources, the bots and their destinations, and the lines between
// them. Node IDs are "source:{sourceId}", "bot:{botId}" and "delivery:{botId}"; edge IDs are "{from}->{to}".

export type FlowBadge = { label: string; tone: "error" | "off" };

export type FlowSourceNode = {
  id: string;
  sourceId: string;
  name: string;
  enabled: boolean;
  // Whether any bot receives its events.
  linked: boolean;
  badges: FlowBadge[];
};

export type FlowDelivery = {
  id: string;
  kind: BotDeliveryKind;
  kindLabel: string;
  // The destination's name or the app of the connection. null for an mcp bot without a connection.
  primary: string | null;
  note: string | null;
  // Set when events do not reach a destination.
  badge: string | null;
};

// A source of a bot that is in the list of sources.
export type FlowBotSource = { id: string; sourceId: string; name: string; enabled: boolean };

export type FlowBotNode = {
  id: string;
  botId: string;
  name: string;
  sources: FlowBotSource[];
  badges: FlowBadge[];
  delivery: FlowDelivery;
  // The relations as text, for screen readers: "受け取る送信元: a, b。配信先: MCP Event ChatGPT".
  description: string;
};

export type FlowEdge = {
  id: string;
  from: string;
  to: string;
  // From a disabled source, or to a destination events do not reach.
  dashed: boolean;
};

export type FlowModel = {
  // Sources linked to a bot first, in the order of their top bot; the others last.
  sources: FlowSourceNode[];
  // In the order of the API (by name). The destination of each bot is on its row.
  bots: FlowBotNode[];
  edges: FlowEdge[];
};

export type Rect = { left: number; top: number; width: number; height: number };

export function sourceNodeId(sourceId: string): string {
  return `source:${sourceId}`;
}

export function botNodeId(botId: string): string {
  return `bot:${botId}`;
}

export function deliveryNodeId(botId: string): string {
  return `delivery:${botId}`;
}

export function edgeId(from: string, to: string): string {
  return `${from}->${to}`;
}

// The name of a source as the lists of names show it, e.g. "batch（無効）".
export function flowSourceName(source: { name: string; enabled: boolean }): string {
  return source.enabled ? source.name : `${source.name}（無効）`;
}

// By name, then by ID, compared by code unit like sourceChoices.
function compareByName(a: { name: string; id: string }, b: { name: string; id: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function flowDelivery(bot: Bot): FlowDelivery {
  const base = { id: deliveryNodeId(bot.id), kind: bot.delivery_kind, kindLabel: DELIVERY_KIND_LABELS[bot.delivery_kind] };
  const active = bot.delivery !== null && bot.delivery.status === "active";
  switch (bot.delivery_kind) {
    case "mcp":
      if (bot.connection === null) {
        return { ...base, primary: null, note: "AI から接続するとき、この Bot を選んでください", badge: "接続なし" };
      }
      // Only the newest subscription of the connection is shown, though the server delivers to all of them.
      if (!active) return { ...base, primary: bot.connection.client_name, note: "AI が購読すると届きます", badge: "購読なし" };
      return { ...base, primary: bot.connection.client_name, note: null, badge: null };
    case "webhook":
    case "queue":
      if (!active || bot.delivery === null) return { ...base, primary: "なし", note: null, badge: "配信先なし" };
      return {
        ...base,
        primary: bot.delivery.name ?? "（名前なし）",
        note: bot.delivery_kind === "webhook" ? bot.delivery.callback_host : null,
        badge: null,
      };
  }
}

export function buildFlow(sources: Source[], bots: Bot[]): FlowModel {
  const byId = new Map(sources.map((source) => [source.id, source]));
  // The index of the top bot that receives each source.
  const topBot = new Map<string, number>();
  const edges: FlowEdge[] = [];

  const botNodes = bots.map((bot, index): FlowBotNode => {
    const id = botNodeId(bot.id);
    // Sources missing from the list are left out.
    const botSources: FlowBotSource[] = [];
    for (const ref of bot.sources) {
      const source = byId.get(ref.id);
      if (source === undefined) continue;
      botSources.push({ id: sourceNodeId(source.id), sourceId: source.id, name: source.name, enabled: source.enabled });
      if (!topBot.has(source.id)) topBot.set(source.id, index);
      edges.push({ id: edgeId(sourceNodeId(source.id), id), from: sourceNodeId(source.id), to: id, dashed: !source.enabled });
    }
    const delivery = flowDelivery(bot);
    edges.push({ id: edgeId(id, delivery.id), from: id, to: delivery.id, dashed: delivery.badge !== null });
    const sourceNames = botSources.length === 0 ? "なし" : botSources.map(flowSourceName).join(", ");
    return {
      id,
      botId: bot.id,
      name: bot.name,
      sources: botSources,
      badges: botSources.length === 0 ? [{ label: "送信元なし", tone: "error" }] : [],
      delivery,
      description: `受け取る送信元: ${sourceNames}。配信先: ${delivery.kindLabel} ${delivery.primary ?? delivery.badge ?? ""}`,
    };
  });

  const sourceNodes = [...sources]
    .sort((a, b) => {
      const ta = topBot.get(a.id) ?? Number.POSITIVE_INFINITY;
      const tb = topBot.get(b.id) ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return compareByName(a, b);
    })
    .map((source): FlowSourceNode => {
      const linked = topBot.has(source.id);
      const badges: FlowBadge[] = [];
      if (!source.enabled) badges.push({ label: "無効", tone: "off" });
      if (!linked) badges.push({ label: "どの Bot にも届きません", tone: "error" });
      return { id: sourceNodeId(source.id), sourceId: source.id, name: source.name, enabled: source.enabled, linked, badges };
    });

  return { sources: sourceNodes, bots: botNodes, edges };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// The line from the middle of the right side of from to the middle of the left side of to: a cubic Bézier curve that
// leaves and arrives horizontally. The coordinates are relative to origin.
export function edgePath(from: Rect, to: Rect, origin: Rect): string {
  const x1 = round(from.left + from.width - origin.left);
  const y1 = round(from.top + from.height / 2 - origin.top);
  const x2 = round(to.left - origin.left);
  const y2 = round(to.top + to.height / 2 - origin.top);
  const bend = round((x2 - x1) / 2);
  return `M ${x1} ${y1} C ${round(x1 + bend)} ${y1}, ${round(x2 - bend)} ${y2}, ${x2} ${y2}`;
}

// The nodes and edges to highlight while focusedId is hovered or focused: the paths through it from the sources to
// the destinations. Empty when nothing is focused or the node is unknown.
export function relatedIds(model: FlowModel, focusedId: string | null): Set<string> {
  const ids = new Set<string>();
  if (focusedId === null) return ids;

  // Adds a bot with its sources, its destination and the edges between them.
  function addBot(bot: FlowBotNode, withSources: boolean) {
    ids.add(bot.id);
    ids.add(bot.delivery.id);
    ids.add(edgeId(bot.id, bot.delivery.id));
    if (!withSources) return;
    for (const source of bot.sources) {
      ids.add(source.id);
      ids.add(edgeId(source.id, bot.id));
    }
  }

  const source = model.sources.find((s) => s.id === focusedId);
  if (source !== undefined) {
    ids.add(source.id);
    for (const bot of model.bots) {
      if (!bot.sources.some((s) => s.id === source.id)) continue;
      ids.add(edgeId(source.id, bot.id));
      addBot(bot, false);
    }
    return ids;
  }
  const bot = model.bots.find((b) => b.id === focusedId || b.delivery.id === focusedId);
  if (bot !== undefined) addBot(bot, true);
  return ids;
}
