import { type FormEvent, useState } from "react";
import type { Subscription } from "../../../src/api/types";
import {
  createQueue,
  createWebhookDestination,
  deleteQueue,
  deleteWebhookDestination,
  stopMcpSubscription,
} from "../actions";
import {
  SUBSCRIPTION_STATUS_LABELS,
  WEBHOOK_DESTINATION_STATUS_LABELS,
  type QueueForm,
  type WebhookDestinationForm,
  describeArguments,
  queueRequest,
  webhookDestinationRequest,
} from "../deliveries";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, type DeliveriesData, loadDeliveriesView, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const DESTINATION_GONE_MESSAGE = "この Webhook 配信先は見つかりません";
const SUBSCRIPTION_GONE_MESSAGE = "この購読は見つかりません";
const STOP_SUBSCRIPTION_CONFIRMATION =
  "この購読を停止します。これからのイベントは送られなくなります。AI が動いていれば、また購読し直されることがあります。止め続けるには、Bot 画面で接続を切断してください。";
const QUEUE_GONE_MESSAGE = "このポーリング用キューは見つかりません。削除された可能性があります";
const QUEUE_GUIDE =
  "AI に、このキューの ID を claim_events に渡して定期的に（5 分おきなど）取得させ、処理したら ack_events を呼ばせてください。";

// The destinations of the signed-in user's workspace: MCP Events subscriptions, which can be stopped here, and webhook
// destinations and polling queues, which can be registered and deleted here. The deliveries to them are on the
// delivery history (DeliveryHistoryView).
export function DeliveriesView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadDeliveriesView(client), "deliveries");
  // The result of the last operation, kept across the reload that follows.
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, () => "配信先"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return (
    <DeliveriesContent
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
  const queues = data.subscriptions.filter((subscription) => subscription.kind === "queue");
  return (
    <main className="main">
      <header className="page-head">
        <h1>配信先</h1>
        <p className="lead">
          イベントを受け取る先の一覧です。AI の購読（MCP Event）、Webhook、ポーリング用キューの3種類があります。どの送信元のイベントが届くかは
          <Link to="/bots">Bot</Link> で決まり、送った記録は <Link to="/deliveries/history">配信履歴</Link> で確かめられます。
        </p>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <h2>MCP Event（AI の購読）</h2>
      {mcpSubscriptions.length === 0 ? (
        <div className="notice">
          <p>購読はまだありません。</p>
          <p>MCP クライアントがイベントを購読すると、ここに表示されます。</p>
        </div>
      ) : (
        <ul className="list subscriptions">
          {mcpSubscriptions.map((subscription) => (
            <SubscriptionItem key={subscription.id} client={client} subscription={subscription} onDone={onDone} />
          ))}
        </ul>
      )}

      <h2>Webhook 配信先</h2>
      <p>
        チャットボットなど、Bearer 認証の Webhook で受け取るサービスへイベントを送ります。本文や添付は含まれないので、受け取る側は
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

      <h2>ポーリング用キュー</h2>
      <p>
        外から呼び出せない AI のために、条件に一致したイベントをためておきます。AI は MCP の claim_events
        で取得し、処理したら ack_events で知らせます。本文や添付は含まれないので、AI は MCP の read_data で読みます。
      </p>
      <CreateQueueForm client={client} onCreated={() => onDone("ポーリング用キューを登録しました")} />
      {queues.length === 0 ? (
        <p className="muted">ポーリング用キューはまだありません。</p>
      ) : (
        <>
          <p className="muted">{QUEUE_GUIDE}</p>
          <ul className="list subscriptions">
            {queues.map((queue) => (
              <QueueItem key={queue.id} client={client} queue={queue} onDone={onDone} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function SubscriptionItem({
  client,
  subscription,
  onDone,
}: {
  client: ApiClient;
  subscription: Subscription;
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
        <span className="delivery-host">{connection?.client_name ?? subscription.callback_host ?? "不明な宛先"}</span>
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
        <div>
          <dt>宛先</dt>
          <dd>{subscription.callback_host ?? "不明"}</dd>
        </div>
        <div>
          <dt>接続</dt>
          <dd>{connection === null ? "不明（以前の接続）" : connection.client_name}</dd>
        </div>
        <div>
          <dt>Bot</dt>
          <dd>
            <BotValue subscription={subscription} />
          </dd>
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

const EMPTY_FORM: WebhookDestinationForm = { name: "", url: "", token: "", types: "", labels: "" };

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
      <p className="muted">
        条件を指定しないと、すべてのイベントを送ります。届くのは、この配信先を使う Bot に紐づけた送信元のイベントだけです。
      </p>
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
        <span className={active ? "badge badge-ok" : "badge badge-off"}>{WEBHOOK_DESTINATION_STATUS_LABELS[destination.status]}</span>
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
      <dl className="facts">
        <div>
          <dt>宛先</dt>
          <dd>{destination.callback_host ?? "不明"}</dd>
        </div>
        <div>
          <dt>Bot</dt>
          <dd>
            <BotValue subscription={destination} />
          </dd>
        </div>
        <div>
          <dt>条件</dt>
          <dd>{describeArguments(destination.arguments)}</dd>
        </div>
      </dl>
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

const EMPTY_QUEUE_FORM: QueueForm = { name: "", types: "", labels: "" };

function CreateQueueForm({ client, onCreated }: { client: ApiClient; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [form, setForm] = useState<QueueForm>(EMPTY_QUEUE_FORM);

  function update(field: keyof QueueForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function close() {
    setOpen(false);
    setForm(EMPTY_QUEUE_FORM);
    setFailure(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = queueRequest(form);
    if (!request.ok) {
      setFailure(request.message);
      return;
    }
    setSending(true);
    setFailure(null);
    const result = await createQueue(client, request.value);
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
            setForm(EMPTY_QUEUE_FORM);
            setFailure(null);
          }}
        >
          <PlusIcon />
          ポーリング用キューを登録
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="ポーリング用キューを登録" onSubmit={(event) => void onSubmit(event)}>
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
      <p className="muted">
        条件を指定しないと、すべてのイベントをためます。届くのは、このキューを使う Bot に紐づけた送信元のイベントだけです。
      </p>
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

function QueueItem({
  client,
  queue,
  onDone,
}: {
  client: ApiClient;
  queue: Subscription;
  onDone: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const active = queue.status === "active";
  const name = queue.name ?? "（名前なし）";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await deleteQueue(client, queue.id);
    switch (result.kind) {
      case "ok":
        setSending(false);
        setConfirming(false);
        onDone(`ポーリング用キュー「${name}」を削除しました`);
        return;
      case "notFound":
        setSending(false);
        setConfirming(false);
        onDone(QUEUE_GONE_MESSAGE);
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
        <span className={active ? "badge badge-ok" : "badge badge-off"}>{WEBHOOK_DESTINATION_STATUS_LABELS[queue.status]}</span>
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
      {active && <CopyableId id={queue.id} />}
      <dl className="facts">
        <div>
          <dt>Bot</dt>
          <dd>
            <BotValue subscription={queue} />
          </dd>
        </div>
        <div>
          <dt>条件</dt>
          <dd>{describeArguments(queue.arguments)}</dd>
        </div>
      </dl>
      <span className="delivery-meta">
        <time dateTime={new Date(queue.created_at).toISOString()}>作成: {formatDateTime(queue.created_at)}</time>
        {!active && (
          <time dateTime={new Date(queue.updated_at).toISOString()}>削除: {formatDateTime(queue.updated_at)}</time>
        )}
      </span>
      {confirming && (
        <form className="folder-form" aria-label="ポーリング用キューを削除" onSubmit={(event) => void onSubmit(event)}>
          <p>
            ポーリング用キュー「{name}」を削除します。削除すると、まだ取得されていないイベントは届かなくなります。元に戻せません。
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

// The bot of a subscription as a value of the facts, or why it receives nothing.
function BotValue({ subscription }: { subscription: Subscription }) {
  if (subscription.bot !== null) return <>{subscription.bot.name}</>;
  if (subscription.status !== "active") return <>なし</>;
  return (
    <>
      <span className="warning-note">割り当てなし（イベントは届きません）</span>
      <Link to="/bots" className="button button-small">
        Bot に割り当てる
      </Link>
    </>
  );
}

