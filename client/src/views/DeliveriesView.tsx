import { type FormEvent, useState } from "react";
import type { Delivery, Subscription } from "../../../src/api/types";
import { createWebhookDestination, deleteWebhookDestination } from "../actions";
import {
  DELIVERY_STATUS_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  WEBHOOK_DESTINATION_STATUS_LABELS,
  type WebhookDestinationForm,
  describeArguments,
  lastResult,
  webhookDestinationRequest,
} from "../deliveries";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, type DeliveriesData, loadDeliveries, loadDeliveriesView, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const DESTINATION_GONE_MESSAGE = "この Webhook 配信先は見つかりません";

// The destinations of the signed-in user's workspace (MCP Events subscriptions, read only, and webhook
// destinations, which can be registered and deleted here) and the deliveries to them.
export function DeliveriesView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadDeliveriesView(client), "deliveries");
  // The result of the last operation, kept across the reload that follows.
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, () => "配信"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return (
    <DeliveriesContent
      key={state.data.deliveries.deliveries[0]?.id ?? "empty"}
      client={client}
      data={state.data}
      notice={notice}
      onDone={(message) => {
        setNotice(message);
        reload();
      }}
    />
  );
}

function DeliveriesContent({
  client,
  data,
  notice,
  onDone,
}: {
  client: ApiClient;
  data: DeliveriesData;
  notice: string | null;
  onDone: (message: string | null) => void;
}) {
  const mcpSubscriptions = data.subscriptions.filter((subscription) => subscription.kind === "mcp");
  const webhookDestinations = data.subscriptions.filter((subscription) => subscription.kind === "webhook");
  return (
    <main className="main">
      <h1>配信</h1>
      <p className="lead">
        MCPクライアント（ChatGPTなど）の購読と、登録したWebhook配信先に、条件に一致したイベントを送った記録です。
      </p>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <h2>購読</h2>
      {mcpSubscriptions.length === 0 ? (
        <div className="notice">
          <p>購読はまだありません。</p>
          <p>MCPクライアントがイベントを購読すると、ここに表示されます。</p>
        </div>
      ) : (
        <ul className="list subscriptions">
          {mcpSubscriptions.map((subscription) => (
            <SubscriptionItem key={subscription.id} subscription={subscription} />
          ))}
        </ul>
      )}

      <h2>Webhook 配信先</h2>
      <p>
        Grok Bot など、Bearer 認証の Webhook で受け取るサービスへイベントを送ります。本文や添付は含まれないので、受け取る側は
        MCP の read_data で読みます。
      </p>
      <CreateWebhookDestinationForm client={client} onCreated={() => onDone("Webhook 配信先を登録しました")} />
      {webhookDestinations.length === 0 ? (
        <p className="muted">Webhook 配信先はまだありません。</p>
      ) : (
        <ul className="list subscriptions">
          {webhookDestinations.map((destination) => (
            <WebhookDestinationItem key={destination.id} client={client} destination={destination} onDone={onDone} />
          ))}
        </ul>
      )}

      <h2>配信の記録</h2>
      <DeliveryPages client={client} first={data.deliveries} />
    </main>
  );
}

function SubscriptionItem({ subscription }: { subscription: Subscription }) {
  return (
    <li className="subscription">
      <span className="delivery-head">
        <span className="delivery-host">{subscription.callback_host ?? "不明な宛先"}</span>
        <span className={subscription.status === "active" ? "badge" : "badge badge-off"}>
          {SUBSCRIPTION_STATUS_LABELS[subscription.status]}
        </span>
      </span>
      <span className="delivery-conditions">{describeArguments(subscription.arguments)}</span>
      <span className="delivery-meta">
        {subscription.status === "active" && subscription.refresh_before !== null && (
          <time dateTime={new Date(subscription.refresh_before).toISOString()}>
            更新期限: {formatDateTime(subscription.refresh_before)}
          </time>
        )}
        <time dateTime={new Date(subscription.updated_at).toISOString()}>
          更新: {formatDateTime(subscription.updated_at)}
        </time>
      </span>
    </li>
  );
}

const EMPTY_FORM: WebhookDestinationForm = { name: "", url: "", token: "", types: "", sources: "", labels: "" };

function CreateWebhookDestinationForm({ client, onCreated }: { client: ApiClient; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The key is kept only in this state, and cleared when the form closes.
  const [form, setForm] = useState<WebhookDestinationForm>(EMPTY_FORM);

  function update(field: keyof WebhookDestinationForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function close() {
    setOpen(false);
    setForm(EMPTY_FORM);
    setFailure(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = webhookDestinationRequest(form);
    if (!request.ok) {
      setFailure(request.message);
      return;
    }
    setSending(true);
    setFailure(null);
    const result = await createWebhookDestination(client, request.value);
    switch (result.kind) {
      case "ok":
        setSending(false);
        close();
        onCreated();
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
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  if (!open) {
    return (
      <div className="actions">
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            setOpen(true);
            setForm(EMPTY_FORM);
            setFailure(null);
          }}
        >
          <PlusIcon />
          Webhook 配信先を登録
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="Webhook 配信先を登録" onSubmit={(event) => void onSubmit(event)}>
      <label>
        名前（64&nbsp;文字以内）
        <input
          type="text"
          value={form.name}
          onChange={(event) => update("name", event.target.value)}
          autoComplete="off"
          required
          maxLength={64}
          disabled={sending}
        />
      </label>
      <label>
        URL（https のみ）
        <input
          type="text"
          inputMode="url"
          value={form.url}
          onChange={(event) => update("url", event.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={2048}
          disabled={sending}
        />
      </label>
      <label>
        キー（<code>Authorization: Bearer</code> ヘッダーで送ります。登録後は表示されません）
        <input
          type="password"
          value={form.token}
          onChange={(event) => update("token", event.target.value)}
          autoComplete="off"
          required
          maxLength={1024}
          disabled={sending}
        />
      </label>
      <label>
        種別（カンマ区切り、任意）
        <input
          type="text"
          value={form.types}
          onChange={(event) => update("types", event.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={sending}
        />
      </label>
      <label>
        送信元の名前（カンマ区切り、任意）
        <input
          type="text"
          value={form.sources}
          onChange={(event) => update("sources", event.target.value)}
          autoComplete="off"
          disabled={sending}
        />
      </label>
      <label>
        ラベル（1行に キー=値、任意）
        <textarea
          value={form.labels}
          onChange={(event) => update("labels", event.target.value)}
          autoComplete="off"
          spellCheck={false}
          rows={3}
          disabled={sending}
        />
      </label>
      <p className="muted">条件を指定しないと、すべてのイベントを送ります。</p>
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          登録
        </button>
        <button type="button" onClick={close} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

function WebhookDestinationItem({
  client,
  destination,
  onDone,
}: {
  client: ApiClient;
  destination: Subscription;
  onDone: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const active = destination.status === "active";
  const name = destination.name ?? "（名前なし）";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await deleteWebhookDestination(client, destination.id);
    switch (result.kind) {
      case "ok":
        setSending(false);
        setConfirming(false);
        onDone(`Webhook 配信先「${name}」を削除しました`);
        return;
      case "notFound":
        setSending(false);
        setConfirming(false);
        onDone(DESTINATION_GONE_MESSAGE);
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
        <span className="delivery-host">{name}</span>
        <span className={active ? "badge" : "badge badge-off"}>{WEBHOOK_DESTINATION_STATUS_LABELS[destination.status]}</span>
        {active && (
          <button
            type="button"
            className="button-danger-outline"
            onClick={() => {
              setConfirming(true);
              setFailure(null);
            }}
            disabled={sending}
          >
            削除
          </button>
        )}
      </span>
      <span className="delivery-conditions">宛先: {destination.callback_host ?? "不明な宛先"}</span>
      <span className="delivery-conditions">{describeArguments(destination.arguments)}</span>
      <span className="delivery-meta">
        <time dateTime={new Date(destination.created_at).toISOString()}>
          作成: {formatDateTime(destination.created_at)}
        </time>
        {!active && (
          <time dateTime={new Date(destination.updated_at).toISOString()}>
            削除: {formatDateTime(destination.updated_at)}
          </time>
        )}
      </span>
      {confirming && (
        <form className="folder-form" aria-label="Webhook 配信先を削除" onSubmit={(event) => void onSubmit(event)}>
          <p>
            Webhook 配信先「{name}」を削除します。これからのイベントは送られなくなり、送信待ちの配信も送られません。元に戻せません。
          </p>
          <div className="folder-form-actions">
            <button type="submit" className="button-danger" disabled={sending}>
              削除する
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

function DeliveryPages({ client, first }: { client: ApiClient; first: DeliveriesData["deliveries"] }) {
  const [deliveries, setDeliveries] = useState(first.deliveries);
  const [cursor, setCursor] = useState(first.next_cursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function loadMore() {
    if (cursor === null) return;
    setLoading(true);
    setFailure(null);
    const next = await loadDeliveries(client, { cursor });
    switch (next.kind) {
      case "ready":
        setDeliveries((current) => [...current, ...next.data.deliveries]);
        setCursor(next.data.next_cursor);
        setLoading(false);
        return;
      case "error":
        setFailure(next.message);
        setLoading(false);
        return;
      case "notFound":
        setFailure("配信の記録を読み込めませんでした");
        setLoading(false);
        return;
      case "redirecting":
        // The move to the login page has started; the button stays disabled.
        return;
    }
  }

  return (
    <>
      {deliveries.length === 0 ? (
        <p className="notice">配信の記録はまだありません。</p>
      ) : (
        <DeliveryList deliveries={deliveries} showEvent />
      )}
      {cursor !== null && (
        <div className="actions list-more">
          <button type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "読み込み中…" : "さらに読み込む"}
          </button>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      )}
    </>
  );
}

const DELIVERY_BADGE_CLASSES: Record<Delivery["status"], string> = {
  pending: "badge badge-off",
  delivered: "badge",
  failed: "badge badge-error",
};

// Deliveries, newest first. showEvent adds a link to the event of each one.
export function DeliveryList({ deliveries, showEvent }: { deliveries: Delivery[]; showEvent: boolean }) {
  return (
    <ul className="list deliveries">
      {deliveries.map((delivery) => {
        const result = lastResult(delivery);
        return (
          <li key={delivery.id} className="delivery">
            <span className="delivery-head">
              <span className="delivery-host">{delivery.callback_host ?? "不明な宛先"}</span>
              <span className={DELIVERY_BADGE_CLASSES[delivery.status]}>
                {DELIVERY_STATUS_LABELS[delivery.status]}
              </span>
            </span>
            {showEvent && (
              <Link to={`/events/${delivery.event_id}`} className="delivery-event">
                <code>{delivery.event_id}</code>
              </Link>
            )}
            <span className="delivery-meta">
              <time dateTime={new Date(delivery.created_at).toISOString()}>{formatDateTime(delivery.created_at)}</time>
              <span>試行 {delivery.attempts} 回</span>
              {result !== null && <span>{result}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
