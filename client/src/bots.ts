import type {
  Bot,
  BotDeliveryKind,
  BotStatus,
  CreateBotRequest,
  McpConnection,
  Subscription,
  UpdateBotRequest,
} from "../../src/api/types";

export const BOT_STATUS_LABELS: Record<BotStatus, string> = {
  ready: "準備OK",
  no_connection: "接続なし",
  no_delivery: "通知先なし",
};

export const DELIVERY_KIND_LABELS: Record<BotDeliveryKind, string> = {
  mcp: "MCP Event",
  webhook: "Webhook",
  queue: "キュー",
};

export const DELIVERY_KIND_DESCRIPTIONS: Record<BotDeliveryKind, string> = {
  mcp: "ChatGPT など、Pinglune に購読を作る AI。通知先は AI の接続から自動で決まります",
  webhook: "配信画面で作った Webhook 配信先に送ります（Grok Bot など）",
  queue: "配信画面で作ったポーリング用キューに入れます（Muse など）",
};

export const DELIVERY_KINDS: BotDeliveryKind[] = ["mcp", "webhook", "queue"];

// Shown for an mcp bot without a destination, and after a legacy connection is taken in.
export const MCP_DELIVERY_PENDING_MESSAGE =
  "AI が次に購読を更新すると届くようになります（最大 24 時間）。すぐ試すなら、AI に Pinglune のイベントを購読し直すよう頼んでください";

export type BotForm = { name: string; deliveryKind: BotDeliveryKind; deliverySubscriptionId: string };

export const EMPTY_BOT_FORM: BotForm = { name: "", deliveryKind: "mcp", deliverySubscriptionId: "" };

// The form for editing a bot. The destination of a webhook or queue bot is kept only while it is active (the API
// returns it only then).
export function botForm(bot: Bot): BotForm {
  return {
    name: bot.name,
    deliveryKind: bot.delivery_kind,
    deliverySubscriptionId: bot.delivery_kind === "mcp" ? "" : (bot.delivery?.subscription_id ?? ""),
  };
}

type FormResult<T> = { ok: true; value: T } | { ok: false; message: string };

const CHOOSE_DESTINATION_MESSAGE = "通知先を選んでください";

// The request of the creation form. The server checks the name.
export function createBotRequest(form: BotForm): FormResult<CreateBotRequest> {
  if (form.deliveryKind === "mcp") return { ok: true, value: { name: form.name, delivery_kind: "mcp" } };
  if (form.deliverySubscriptionId === "") return { ok: false, message: CHOOSE_DESTINATION_MESSAGE };
  return {
    ok: true,
    value: { name: form.name, delivery_kind: form.deliveryKind, delivery_subscription_id: form.deliverySubscriptionId },
  };
}

// The request of the edit form: the fields that changed. null when nothing changed.
export function updateBotRequest(bot: Bot, form: BotForm): FormResult<UpdateBotRequest> | null {
  const request: UpdateBotRequest = {};
  if (form.name.trim() !== bot.name) request.name = form.name;
  if (form.deliveryKind === "mcp") {
    if (bot.delivery_kind !== "mcp") {
      request.delivery_kind = "mcp";
      request.delivery_subscription_id = null;
    }
  } else {
    if (form.deliverySubscriptionId === "") return { ok: false, message: CHOOSE_DESTINATION_MESSAGE };
    if (bot.delivery_kind !== form.deliveryKind) request.delivery_kind = form.deliveryKind;
    if (request.delivery_kind !== undefined || form.deliverySubscriptionId !== bot.delivery?.subscription_id) {
      request.delivery_subscription_id = form.deliverySubscriptionId;
    }
  }
  return Object.keys(request).length === 0 ? null : { ok: true, value: request };
}

// The destinations a webhook or queue bot may use: the active subscriptions of that kind that no other bot uses.
export function availableDestinations(
  subscriptions: Subscription[],
  bots: Bot[],
  kind: BotDeliveryKind,
  exceptBotId: string | null,
): Subscription[] {
  if (kind === "mcp") return [];
  const used = new Set(
    bots.flatMap((bot) =>
      bot.id !== exceptBotId && bot.delivery_kind !== "mcp" && bot.delivery !== null ? [bot.delivery.subscription_id] : [],
    ),
  );
  return subscriptions.filter((s) => s.kind === kind && s.status === "active" && !used.has(s.id));
}

// The destination of a bot as the list shows it.
export function botDeliveryLabel(bot: Bot): string {
  const delivery = bot.delivery;
  if (delivery === null) return `${DELIVERY_KIND_LABELS[bot.delivery_kind]}: なし`;
  switch (bot.delivery_kind) {
    case "mcp":
      return `MCP Event: ${delivery.callback_host ?? "不明な宛先"}`;
    case "webhook":
      return `Webhook: ${delivery.name ?? "（名前なし）"}${delivery.callback_host === null ? "" : `（${delivery.callback_host}）`}`;
    case "queue":
      return `キュー: ${delivery.name ?? "（名前なし）"}`;
  }
}

// "ChatGPT, chatgpt.com": the app and the host of a connection.
export function connectionLabel(connection: { client_name: string; redirect_host: string }): string {
  return connection.redirect_host === "" ? connection.client_name : `${connection.client_name}, ${connection.redirect_host}`;
}

// Whether the active connection of the bot has expired (its grant is gone), as the list of connections tells.
export function botConnectionExpired(bot: Bot, connections: McpConnection[]): boolean {
  if (bot.connection === null) return false;
  const id = bot.connection.id;
  return connections.some((c) => c.kind === "expired" && c.id === id);
}

// The confirmation before a connection is assigned to a bot that has another connection; null when nothing is
// replaced.
export function replacementWarning(bot: Bot | undefined, connection: McpConnection): string | null {
  if (bot === undefined || bot.connection === null || bot.connection.id === connection.id) return null;
  return `${bot.name} の今の接続（${connectionLabel(bot.connection)}）は切断されます`;
}

export const CONNECTION_KIND_LABELS: Record<McpConnection["kind"], string | null> = {
  active: null,
  legacy: "以前の接続",
  expired: "期限切れ",
  stale: "切断済み",
};
