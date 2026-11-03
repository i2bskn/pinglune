import type {
  Bot,
  BotDeliveryKind,
  BotDetail,
  BotStatus,
  ConversationStartSettings,
  CreateBotRequest,
  DestinationConditions,
  McpConnection,
  Source,
  Subscription,
  UpdateBotRequest,
} from "../../src/api/types";
import { INVALID_LABELS_MESSAGE, parseLabelLines, splitList } from "./deliveries";

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
  webhook: "Bearer 認証の Webhook に送ります（チャットボットなど）。URL とキーをこの Bot に登録します",
  queue: "この Bot 用のポーリング用キューに入れます（外から呼び出せない AI など）。キューは Bot と一緒に作られます",
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

// The path of the detail screen of a bot.
export function botPath(id: string): string {
  return `/bots/${id}`;
}

// The webhook destinations and polling queues that no bot uses, active ones only: a bot can be made with them.
export function unassignedBotDestinations(subscriptions: Subscription[]): Subscription[] {
  return subscriptions.filter(
    (subscription) => subscription.kind !== "mcp" && subscription.status === "active" && subscription.bot === null,
  );
}

// The destination named by ?destination= of the creation screen, if it may be used: an active webhook destination or
// polling queue that no bot uses. null otherwise (the query is then ignored).
export function destinationFromQuery(params: URLSearchParams, subscriptions: Subscription[]): Subscription | null {
  const id = params.get("destination");
  if (id === null) return null;
  return unassignedBotDestinations(subscriptions).find((subscription) => subscription.id === id) ?? null;
}

// The conditions of a new destination, as the form holds them: comma-separated types and key=value lines.
export type ConditionsForm = { types: string; labels: string };

export const EMPTY_CONDITIONS_FORM: ConditionsForm = { types: "", labels: "" };

// The conditions of the form. Empty fields are left out ({} is every event); the server checks the rest.
export function conditionsRequest(form: ConditionsForm): FormResult<DestinationConditions> {
  const labels = parseLabelLines(form.labels);
  if (labels === null) return { ok: false, message: INVALID_LABELS_MESSAGE };
  const value: DestinationConditions = {};
  const types = splitList(form.types);
  if (types.length > 0) value.types = types;
  if (Object.keys(labels).length > 0) value.labels = labels;
  return { ok: true, value };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// The form of the stored conditions of a destination, to edit them.
export function conditionsFormOf(args: Record<string, unknown> | null): ConditionsForm {
  if (args === null) return EMPTY_CONDITIONS_FORM;
  const labels = args.labels;
  const lines =
    typeof labels === "object" && labels !== null && !Array.isArray(labels)
      ? Object.entries(labels as Record<string, unknown>).map(([key, value]) => `${key}=${String(value)}`)
      : [];
  return { types: stringList(args.types).join(", "), labels: lines.join("\n") };
}

// The creation form of a bot. url and token are for webhook; the conditions for webhook and queue. destinationId is
// an existing destination to use (from ?destination=), which fixes the delivery kind and leaves out url, token and the
// conditions.
export type NewBotForm = {
  name: string;
  deliveryKind: BotDeliveryKind;
  url: string;
  token: string;
  conditions: ConditionsForm;
  sourceIds: string[];
  destinationId: string | null;
};

export const EMPTY_NEW_BOT_FORM: NewBotForm = {
  name: "",
  deliveryKind: "mcp",
  url: "",
  token: "",
  conditions: EMPTY_CONDITIONS_FORM,
  sourceIds: [],
  destinationId: null,
};

// The request of the creation form: an existing destination by ID, a new webhook destination with its URL and key, a
// new polling queue, or none for MCP Event. The server checks the name, the URL and the key. sourcesLoaded is false
// when the sources could not be read: nothing is sent.
export function newBotRequest(form: NewBotForm, sourcesLoaded = true): FormResult<CreateBotRequest> {
  if (!sourcesLoaded) return { ok: false, message: SOURCES_UNAVAILABLE_MESSAGE };
  let value: CreateBotRequest;
  if (form.deliveryKind === "mcp") {
    value = { name: form.name, delivery_kind: "mcp" };
  } else if (form.destinationId !== null) {
    value = { name: form.name, delivery_kind: form.deliveryKind, delivery_subscription_id: form.destinationId };
  } else {
    const conditions = conditionsRequest(form.conditions);
    if (!conditions.ok) return conditions;
    value = { name: form.name, delivery_kind: form.deliveryKind };
    if (form.deliveryKind === "webhook") value.webhook = { url: form.url, token: form.token };
    if (Object.keys(conditions.value).length > 0) value.conditions = conditions.value;
  }
  if (form.sourceIds.length > 0) value.source_ids = form.sourceIds;
  return { ok: true, value };
}

// The form that changes the delivery kind of a bot to a new destination: a new webhook destination (url, token), a
// new polling queue, or MCP Event.
export type DeliveryChangeForm = { kind: BotDeliveryKind; url: string; token: string; conditions: ConditionsForm };

// The kinds the form offers for a bot: a queue bot cannot get a new queue (the server keeps the current one), and an
// MCP Event bot is MCP Event already. A webhook bot may get a new webhook destination.
export function deliveryChangeKinds(bot: Pick<Bot, "delivery_kind">): BotDeliveryKind[] {
  return DELIVERY_KINDS.filter((kind) => kind === "webhook" || kind !== bot.delivery_kind);
}

// The request of the form that changes the destination. The previous webhook destination or queue ends with it.
export function deliveryChangeRequest(form: DeliveryChangeForm): FormResult<UpdateBotRequest> {
  if (form.kind === "mcp") return { ok: true, value: { delivery_kind: "mcp" } };
  const conditions = conditionsRequest(form.conditions);
  if (!conditions.ok) return conditions;
  const value: UpdateBotRequest = { delivery_kind: form.kind };
  if (form.kind === "webhook") value.webhook = { url: form.url, token: form.token };
  if (Object.keys(conditions.value).length > 0) value.conditions = conditions.value;
  return { ok: true, value };
}

// What the confirmation of a change of the destination says will end, or null when nothing ends.
export function deliveryChangeWarning(bot: BotDetail): string | null {
  const destination = bot.destination;
  if (destination === null || destination.status !== "active") return null;
  const name = destination.name ?? "（名前なし）";
  return destination.kind === "queue"
    ? `今のキュー「${name}」は終了します。まだ処理されていないイベント（取得済みで処理済みの連絡がないものを含む）は失敗になり、あとから ack_events で処理済みにはできません。`
    : `今の Webhook 配信先「${name}」は終了します。まだ送っていない配信は送られません。`;
}

export type SourceTab = "overview" | "intake" | "settings";

export const SOURCE_TABS: readonly { tab: SourceTab; label: string }[] = [
  { tab: "overview", label: "概要" },
  { tab: "intake", label: "送り方" },
  { tab: "settings", label: "設定" },
];

// The tab of the detail screen of a source (?tab=); overview without one or for an unknown value.
export function sourceTabOf(params: URLSearchParams): SourceTab {
  const tab = params.get("tab");
  return tab === "intake" || tab === "settings" ? tab : "overview";
}

// The path of a tab of the detail screen of a source. The overview is the plain path.
export function sourceTabPath(sourceId: string, tab: SourceTab): string {
  return tab === "overview" ? `/sources/${sourceId}` : `/sources/${sourceId}?tab=${tab}`;
}

// The conversation start settings of a bot or a source, as the form edits them. The numbers are the text of the
// inputs.
export type ConversationStartForm = { enabled: boolean; dailyLimit: string; maxAiMessages: string };

// A bot or a source, with its conversation start settings.
type ConversationStarter = { conversation_start: ConversationStartSettings };

export function conversationStartForm(starter: ConversationStarter): ConversationStartForm {
  return {
    enabled: starter.conversation_start.enabled,
    dailyLimit: String(starter.conversation_start.daily_limit),
    maxAiMessages: String(starter.conversation_start.max_ai_messages),
  };
}

export type ConversationStartInput = { enabled: boolean; dailyLimit: number; maxAiMessages: number };

// A whole number from min to max written in the input, or null.
function wholeNumberIn(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return number >= min && number <= max ? number : null;
}

// The request of the conversation start form. When it is off, the numbers are not checked and the saved ones are
// sent as they are (the inputs are hidden).
export function conversationStartRequest(
  starter: ConversationStarter,
  form: ConversationStartForm,
): FormResult<ConversationStartInput> {
  if (!form.enabled) {
    return {
      ok: true,
      value: {
        enabled: false,
        dailyLimit: starter.conversation_start.daily_limit,
        maxAiMessages: starter.conversation_start.max_ai_messages,
      },
    };
  }
  const dailyLimit = wholeNumberIn(form.dailyLimit, 1, 1000);
  if (dailyLimit === null) return { ok: false, message: "1日に始められる会話の数は 1〜1000 の整数にしてください" };
  const maxAiMessages = wholeNumberIn(form.maxAiMessages, 1, 100);
  if (maxAiMessages === null) return { ok: false, message: "AI の発言の上限は 1〜100 の整数にしてください" };
  return { ok: true, value: { enabled: true, dailyLimit, maxAiMessages } };
}
