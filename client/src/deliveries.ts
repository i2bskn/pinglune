import type {
  CreateQueueRequest,
  CreateWebhookDestinationRequest,
  Delivery,
  DeliveryStatus,
  Subscription,
  SubscriptionStatus,
} from "../../src/api/types";

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "未配信",
  delivered: "配信済み",
  failed: "失敗",
};

// Deliveries to polling queues wait for an AI to take them, and are done when it reports them processed.
export const QUEUE_DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "取得待ち",
  delivered: "処理済み",
  failed: "失敗",
};

export function isQueueDelivery(delivery: Delivery): boolean {
  return delivery.destination_kind === "queue";
}

export function deliveryStatusLabel(delivery: Delivery): string {
  return (isQueueDelivery(delivery) ? QUEUE_DELIVERY_STATUS_LABELS : DELIVERY_STATUS_LABELS)[delivery.status];
}

// Where a delivery goes: the callback host, or the name of a polling queue.
export function deliveryDestination(delivery: Delivery): string {
  if (isQueueDelivery(delivery)) {
    return delivery.destination_name === null ? "キュー" : `キュー: ${delivery.destination_name}`;
  }
  return delivery.callback_host ?? "不明な宛先";
}

// The number of tries, e.g. "試行 2 回"; for a polling queue, the number of times it was taken.
export function attemptsLabel(delivery: Delivery): string {
  return `${isQueueDelivery(delivery) ? "取得" : "試行"} ${delivery.attempts} 回`;
}

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: "有効",
  expired: "期限切れ",
  unsubscribed: "解除済み",
};

// Short descriptions of last_error. Unknown values are shown as they are.
const ERROR_LABELS: Record<string, string> = {
  http_4xx: "受信側がリクエストを受け付けませんでした",
  http_5xx: "受信側でエラーが起きました",
  timeout: "応答がありませんでした",
  connection_failed: "接続できませんでした",
  redirect: "リダイレクトが返されました",
  dns_failed: "名前解決に失敗しました",
  blocked_destination: "送信できない宛先です",
  subscription_inactive: "配信先が終了しています",
  event_not_found: "イベントが見つかりません",
  payload_too_large: "イベントが大きすぎます",
  secret_unavailable: "鍵を読めませんでした",
  dead_lettered: "処理を完了できませんでした",
  not_acknowledged: "処理済みの連絡がないまま 5 回取得された",
  expired: "7 日間処理されなかった",
  conversation_stopped: "会話が停止された",
};

export function errorLabel(error: string): string {
  return ERROR_LABELS[error] ?? error;
}

// The outcome of the last try, e.g. "受信側でエラーが起きました（HTTP 503）". null before the first try. Polling
// queues have no HTTP status, and are "処理済み" when acknowledged.
export function lastResult(delivery: Delivery): string | null {
  if (isQueueDelivery(delivery)) {
    if (delivery.last_error !== null) return errorLabel(delivery.last_error);
    return delivery.status === "delivered" ? "処理済み" : null;
  }
  const status = delivery.last_http_status === null ? "" : `（HTTP ${delivery.last_http_status}）`;
  if (delivery.last_error !== null) return `${errorLabel(delivery.last_error)}${status}`;
  if (delivery.status === "delivered") return `成功${status}`;
  return null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

// The conditions of a subscription, e.g. "種別: a, b / 送信元: x / ラベル: k=v".
export function describeArguments(args: Subscription["arguments"]): string {
  if (args === null) return "不明";
  const parts: string[] = [];
  const types = stringList(args.types);
  if (types !== null) parts.push(`種別: ${types.join(", ")}`);
  const sources = stringList(args.sources);
  if (sources !== null) parts.push(`送信元: ${sources.join(", ")}`);
  const labels = args.labels;
  if (typeof labels === "object" && labels !== null && !Array.isArray(labels)) {
    const entries = Object.entries(labels as Record<string, unknown>).map(([key, value]) => `${key}=${String(value)}`);
    if (entries.length > 0) parts.push(`ラベル: ${entries.join(", ")}`);
  }
  return parts.length === 0 ? "すべてのイベント" : parts.join(" / ");
}

// Webhook destinations and polling queues are deleted rather than unsubscribed; they never expire.
export const WEBHOOK_DESTINATION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: "有効",
  expired: "期限切れ",
  unsubscribed: "削除済み",
};

// The items of a comma-separated field, trimmed, without empty ones. An empty list means the field is not sent.
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export const INVALID_LABELS_MESSAGE = "ラベルは1行に キー=値 の形で、キーを重複させずに書いてください";

// The labels of a textarea with one key=value per line. Lines are trimmed and empty ones skipped; the first "="
// separates the key from the value, and both are trimmed. null for a line without "=", an empty key or value, or
// a key given twice.
export function parseLabelLines(value: string): Record<string, string> | null {
  // A Map, so that a key such as "__proto__" is an ordinary key.
  const labels = new Map<string, string>();
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const index = line.indexOf("=");
    if (index < 0) return null;
    const key = line.slice(0, index).trim();
    const label = line.slice(index + 1).trim();
    if (key === "" || label === "" || labels.has(key)) return null;
    labels.set(key, label);
  }
  return Object.fromEntries(labels);
}

export type WebhookDestinationForm = {
  name: string;
  url: string;
  token: string;
  types: string;
  sources: string;
  labels: string;
};

// The request of the registration form. Empty condition fields are left out; the server checks the rest.
export function webhookDestinationRequest(
  form: WebhookDestinationForm,
): { ok: true; value: CreateWebhookDestinationRequest } | { ok: false; message: string } {
  const labels = parseLabelLines(form.labels);
  if (labels === null) return { ok: false, message: INVALID_LABELS_MESSAGE };
  const value: CreateWebhookDestinationRequest = { name: form.name, url: form.url, token: form.token };
  const types = splitList(form.types);
  if (types.length > 0) value.types = types;
  const sources = splitList(form.sources);
  if (sources.length > 0) value.sources = sources;
  if (Object.keys(labels).length > 0) value.labels = labels;
  return { ok: true, value };
}

export type QueueForm = { name: string; types: string; sources: string; labels: string };

// The request of the polling queue form. Empty condition fields are left out; the server checks the rest.
export function queueRequest(form: QueueForm): { ok: true; value: CreateQueueRequest } | { ok: false; message: string } {
  const labels = parseLabelLines(form.labels);
  if (labels === null) return { ok: false, message: INVALID_LABELS_MESSAGE };
  const value: CreateQueueRequest = { name: form.name };
  const types = splitList(form.types);
  if (types.length > 0) value.types = types;
  const sources = splitList(form.sources);
  if (sources.length > 0) value.sources = sources;
  if (Object.keys(labels).length > 0) value.labels = labels;
  return { ok: true, value };
}
