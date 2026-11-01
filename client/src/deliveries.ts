import type { Delivery, DeliveryStatus, Subscription, SubscriptionStatus } from "../../src/api/types";

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "未配信",
  delivered: "配信済み",
  failed: "失敗",
};

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
  subscription_inactive: "購読が終了しています",
  event_not_found: "イベントが見つかりません",
  payload_too_large: "イベントが大きすぎます",
  secret_unavailable: "署名用の鍵を読めませんでした",
  dead_lettered: "処理を完了できませんでした",
};

export function errorLabel(error: string): string {
  return ERROR_LABELS[error] ?? error;
}

// The outcome of the last try, e.g. "受信側でエラーが起きました（HTTP 503）". null before the first try.
export function lastResult(delivery: Delivery): string | null {
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
