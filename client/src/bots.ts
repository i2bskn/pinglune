import type {
  Bot,
  BotDeliveryKind,
  BotStatus,
  CreateBotRequest,
  McpConnection,
  Source,
  Subscription,
  UpdateBotRequest,
} from "../../src/api/types";

export const BOT_STATUS_LABELS: Record<BotStatus, string> = {
  ready: "準備完了",
  no_connection: "未接続",
  no_delivery: "配信先なし",
};

// The state of a bot in the shared words of the screens: an mcp bot without a subscription is 未購読.
export function botStatusLabel(bot: Pick<Bot, "status" | "delivery_kind">): string {
  if (bot.status === "no_delivery" && bot.delivery_kind === "mcp") return "未購読";
  return BOT_STATUS_LABELS[bot.status];
}

export const DELIVERY_KIND_LABELS: Record<BotDeliveryKind, string> = {
  mcp: "MCP Event",
  webhook: "Webhook",
  queue: "キュー",
};

export const DELIVERY_KIND_DESCRIPTIONS: Record<BotDeliveryKind, string> = {
  mcp: "ChatGPT など、Pinglune に購読を作る AI。配信先は AI の接続から自動で決まります",
  webhook: "配信先画面で作った Webhook 配信先に送ります（チャットボットなど）",
  queue: "配信先画面で作ったポーリング用キューに入れます（外から呼び出せない AI など）",
};

export const DELIVERY_KINDS: BotDeliveryKind[] = ["mcp", "webhook", "queue"];

// Shown for an mcp bot without a destination, and after a legacy connection is taken in.
export const MCP_DELIVERY_PENDING_MESSAGE =
  "AI が次に購読を更新すると届くようになります（最大 24 時間）。すぐ試すなら、AI に Pinglune のイベントを購読し直すよう頼んでください";

// sourceIds: the sources whose events the bot receives.
export type BotForm = { name: string; deliveryKind: BotDeliveryKind; deliverySubscriptionId: string; sourceIds: string[] };

export const EMPTY_BOT_FORM: BotForm = { name: "", deliveryKind: "mcp", deliverySubscriptionId: "", sourceIds: [] };

// The form for editing a bot. The destination of a webhook or queue bot is kept only while it is active (the API
// returns it only then).
export function botForm(bot: Bot): BotForm {
  return {
    name: bot.name,
    deliveryKind: bot.delivery_kind,
    deliverySubscriptionId: bot.delivery_kind === "mcp" ? "" : (bot.delivery?.subscription_id ?? ""),
    sourceIds: bot.sources.map((source) => source.id),
  };
}

type FormResult<T> = { ok: true; value: T } | { ok: false; message: string };

const CHOOSE_DESTINATION_MESSAGE = "配信先を選んでください";
export const SOURCES_UNAVAILABLE_MESSAGE = "送信元を読み込めませんでした";

// The request of the creation form. The server checks the name. sourcesLoaded is false when the sources could not be
// read: the form cannot tell which ones were chosen, so nothing is sent. No sources are left out (the default).
export function createBotRequest(form: BotForm, sourcesLoaded = true): FormResult<CreateBotRequest> {
  if (!sourcesLoaded) return { ok: false, message: SOURCES_UNAVAILABLE_MESSAGE };
  let value: CreateBotRequest;
  if (form.deliveryKind === "mcp") {
    value = { name: form.name, delivery_kind: "mcp" };
  } else {
    if (form.deliverySubscriptionId === "") return { ok: false, message: CHOOSE_DESTINATION_MESSAGE };
    value = { name: form.name, delivery_kind: form.deliveryKind, delivery_subscription_id: form.deliverySubscriptionId };
  }
  if (form.sourceIds.length > 0) value.source_ids = form.sourceIds;
  return { ok: true, value };
}

function sameIds(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

// The request of the edit form: the fields that changed. null when nothing changed. The sources are left out (kept)
// when they could not be read.
export function updateBotRequest(bot: Bot, form: BotForm, sourcesLoaded = true): FormResult<UpdateBotRequest> | null {
  const request: UpdateBotRequest = {};
  if (form.name.trim() !== bot.name) request.name = form.name;
  if (
    sourcesLoaded &&
    !sameIds(
      form.sourceIds,
      bot.sources.map((source) => source.id),
    )
  ) {
    request.source_ids = form.sourceIds;
  }
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

// The sources a bot may receive: the sources of programs, by name (the API lists them in the order they were made).
export function sourceChoices(sources: Source[]): Source[] {
  return [...sources].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// The sources of a bot as the list shows it, e.g. "受け取る送信元: app, batch（無効）".
export function botSourcesLabel(bot: Bot): string {
  if (bot.sources.length === 0) return "受け取る送信元: なし（イベントは届きません）";
  return `受け取る送信元: ${bot.sources.map((source) => `${source.name}${source.enabled ? "" : "（無効）"}`).join(", ")}`;
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
