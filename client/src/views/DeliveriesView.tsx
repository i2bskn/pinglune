import { type FormEvent, useEffect, useState } from "react";
import type { Subscription } from "../../../src/api/types";
import { stopMcpSubscription } from "../actions";
import type { ConditionsForm } from "../bots";
import { SUBSCRIPTION_STATUS_LABELS, describeArguments } from "../deliveries";
import { formatDateTime } from "../format";
import type { ApiClient } from "../load";
import { navigate } from "../router";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const SUBSCRIPTION_GONE_MESSAGE = "この購読は見つかりません";
const STOP_SUBSCRIPTION_CONFIRMATION =
  "この購読を停止します。これからのイベントは送られなくなります。AI が動いていれば、また購読し直されることがあります。止め続けるには、AI の接続画面で接続を切断してください。";

// The former destinations screen (/deliveries). Webhook destinations and polling queues are managed with their bots
// now, and MCP Events subscriptions with their connections: the screen moves on to the bots without staying in the
// history. The parts below are shared by those screens.
export function DeliveriesView() {
  useEffect(() => {
    navigate("/bots", { replace: true });
  }, []);
  return null;
}

// An ID to copy (the ID of a queue for claim_events, the ID of a source), selectable as a whole, with a button that
// copies it.
export function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy() {
    try {
      // Missing without a secure context, and rejected without the permission.
      if (navigator.clipboard === undefined) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(id);
      setCopied("コピーしました");
    } catch {
      setCopied("コピーできませんでした。ID を選択してコピーしてください");
    }
  }

  return (
    <span className="copyable-id">
      <span className="copyable">
        <code>{id}</code>
      </span>
      <button type="button" onClick={() => void copy()}>
        コピー
      </button>
      <span role="status" className="muted">
        {copied}
      </span>
    </span>
  );
}

// The conditions of a webhook destination or a polling queue: comma-separated types and key=value lines.
export function ConditionFields({
  value,
  onChange,
  disabled,
  note,
}: {
  value: ConditionsForm;
  onChange: (next: ConditionsForm) => void;
  disabled: boolean;
  note: string;
}) {
  return (
    <>
      <label>
        種別（カンマ区切り、任意）
        <input
          type="text"
          value={value.types}
          onChange={(event) => onChange({ ...value, types: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
      </label>
      <label>
        ラベル（1行に キー=値、任意）
        <textarea
          value={value.labels}
          onChange={(event) => onChange({ ...value, labels: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          rows={3}
          disabled={disabled}
        />
      </label>
      <p className="muted">{note}</p>
    </>
  );
}

// An MCP Events subscription, which can be stopped. showConnection adds the app of its connection (left out inside the
// card of that connection).
export function McpSubscriptionItem({
  client,
  subscription,
  showConnection,
  onDone,
}: {
  client: ApiClient;
  subscription: Subscription;
  showConnection: boolean;
  onDone: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const active = subscription.status === "active";
  const connection = subscription.connection;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await stopMcpSubscription(client, subscription.id);
    switch (result.kind) {
      case "ok":
        setSending(false);
        setConfirming(false);
        onDone("購読を停止しました");
        return;
      case "notFound":
        setSending(false);
        setConfirming(false);
        onDone(SUBSCRIPTION_GONE_MESSAGE);
        return;
      case "error":
        setSending(false);
        setFailure(result.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        return;
    }
  }

  return (
    <li className="subscription">
      <span className="delivery-head">
        <span className="delivery-host">{subscription.callback_host ?? "不明な宛先"}</span>
        <span
          className={
            active ? "badge badge-ok" : subscription.status === "expired" ? "badge badge-warning" : "badge badge-off"
          }
        >
          {subscription.status === "expired" ? "未購読（期限切れ）" : SUBSCRIPTION_STATUS_LABELS[subscription.status]}
        </span>
        {active && (
          <button
            type="button"
            className="button-quiet"
            onClick={() => {
              setConfirming(true);
              setFailure(null);
            }}
            disabled={sending}
          >
            停止
          </button>
        )}
      </span>
      {subscription.status === "expired" && (
        <span className="warning-note">AI が購読を更新しなかったため、イベントは届きません。AI が購読し直すと届きます。</span>
      )}
      <dl className="facts">
        {showConnection && (
          <div>
            <dt>接続</dt>
            <dd>{connection === null ? "不明（以前の接続）" : connection.client_name}</dd>
          </div>
        )}
        <div>
          <dt>Bot</dt>
          <dd>{subscription.bot === null ? "なし（イベントは届きません）" : subscription.bot.name}</dd>
        </div>
        <div>
          <dt>条件</dt>
          <dd>{describeArguments(subscription.arguments)}</dd>
        </div>
      </dl>
      <span className="delivery-meta">
        {active && subscription.refresh_before !== null && (
          <time dateTime={new Date(subscription.refresh_before).toISOString()}>
            更新期限: {formatDateTime(subscription.refresh_before)}
          </time>
        )}
        <time dateTime={new Date(subscription.updated_at).toISOString()}>
          更新: {formatDateTime(subscription.updated_at)}
        </time>
      </span>
      {confirming && (
        <form className="folder-form" aria-label="購読を停止" onSubmit={(event) => void onSubmit(event)}>
          <p>{STOP_SUBSCRIPTION_CONFIRMATION}</p>
          <div className="folder-form-actions">
            <button type="submit" className="button-danger" disabled={sending}>
              停止する
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
    </li>
  );
}
