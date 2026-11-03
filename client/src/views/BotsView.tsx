import { type FormEvent, useState } from "react";
import type { Bot, Source, Subscription } from "../../../src/api/types";
import { deleteQueue, deleteWebhookDestination } from "../actions";
import {
  DELIVERY_KIND_LABELS,
  SOURCES_UNAVAILABLE_MESSAGE,
  botConnectionExpired,
  botPath,
  botStatusLabel,
  unassignedBotDestinations,
} from "../bots";
import { describeArguments } from "../deliveries";
import { formatDateTime } from "../format";
import { ChevronRightIcon, PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, type BotsData, loadBotsView, useView } from "../load";
import { ViewStatus, useDocumentTitle, useFlashNotice, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const DESTINATION_GONE_MESSAGE = "この配信先は見つかりません。削除された可能性があります";

// The bots of the signed-in user's workspace, each a link to its screen, and the destinations that no bot uses.
export function BotsView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadBotsView(client), "bots");
  // The result of the last operation, kept across the reload that follows; or the message of the screen before
  // (a bot deleted on its screen).
  const [notice, setNotice] = useState<string | null>(null);
  useFlashNotice(setNotice);
  useDocumentTitle(viewTitle(state, () => "Bot"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return (
    <BotsContent
      // Keyed by the data, so that open forms close after a reload.
      key={JSON.stringify(state.data.subscriptions.map((s) => [s.id, s.status]))}
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

function BotsContent({
  client,
  data,
  notice,
  onDone,
}: {
  client: ApiClient;
  data: BotsData;
  notice: string | null;
  onDone: (message: string | null) => void;
}) {
  const unassigned = unassignedBotDestinations(data.subscriptions);
  return (
    <main className="main">
      <header className="page-head page-head-row">
        <div>
          <h1>Bot</h1>
          <p className="lead">
            Bot は、イベントを受け取る AI です。受け取る送信元と配信方式（AI の購読・Webhook・キュー）を決め、AI から接続するときにどの Bot
            として接続するかを選びます。
          </p>
        </div>
        <Link to="/bots/new" className="button button-primary">
          <PlusIcon />
          Bot を作成
        </Link>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {data.bots.length === 0 ? (
        <p className="notice">Bot はまだありません。Bot を作ると、イベントを受け取り、会話の参加者として選べます。</p>
      ) : (
        <ul className="list sources">
          {data.bots.map((bot) => (
            <li key={bot.id}>
              <BotRow bot={bot} expired={botConnectionExpired(bot, data.connections)} />
            </li>
          ))}
        </ul>
      )}

      {unassigned.length > 0 && (
        <section className="source-section" aria-labelledby="unassigned-destinations">
          <div className="section-head">
            <h2 id="unassigned-destinations">Bot に割り当てられていない配信先</h2>
          </div>
          <p className="hint">
            どの Bot にも属さない配信先には、イベントが届きません。この配信先で Bot を作るか、使わなければ削除してください。
          </p>
          <ul className="list subscriptions">
            {unassigned.map((destination) => (
              <UnassignedDestinationItem key={destination.id} client={client} destination={destination} onDone={onDone} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

// One bot as a row that links to its screen.
function BotRow({ bot, expired }: { bot: Bot; expired: boolean }) {
  return (
    <Link to={botPath(bot.id)} className="source-link bot-link">
      <span className="bot-link-body">
        <span className="source-head">
          <span className="source-name">{bot.name}</span>
          <span className={bot.status === "ready" ? "badge badge-ok" : "badge badge-warning"}>{botStatusLabel(bot)}</span>
          {expired && <span className="badge badge-warning">接続の期限切れ</span>}
        </span>
        <span className="source-meta">
          <span className="bot-link-delivery">
            <span className="kind-chip">{DELIVERY_KIND_LABELS[bot.delivery_kind]}</span>
            {botDeliveryValue(bot)}
          </span>
          {bot.sources.length === 0 ? (
            <span className="warning-note">送信元なし</span>
          ) : (
            <span>受け取る送信元 {bot.sources.length} 件</span>
          )}
          {bot.conversation_start.enabled && <span className="kind-chip">会話を開始できる</span>}
        </span>
      </span>
      <ChevronRightIcon />
    </Link>
  );
}

// A webhook destination or a polling queue that no bot uses: a bot can be made with it, or it can be deleted.
function UnassignedDestinationItem({
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
  const name = destination.name ?? "（名前なし）";
  const kind = destination.kind === "queue" ? "queue" : "webhook";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result =
      kind === "queue" ? await deleteQueue(client, destination.id) : await deleteWebhookDestination(client, destination.id);
    switch (result.kind) {
      case "ok":
        setSending(false);
        setConfirming(false);
        onDone(`配信先「${name}」を削除しました`);
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
        <span className="kind-chip">{DELIVERY_KIND_LABELS[kind]}</span>
        <span className="delivery-host">{name}</span>
        <span className="badge badge-warning">割り当てなし</span>
      </span>
      <dl className="facts">
        {kind === "webhook" && (
          <div>
            <dt>宛先</dt>
            <dd>{destination.callback_host ?? "不明"}</dd>
          </div>
        )}
        <div>
          <dt>条件</dt>
          <dd>{describeArguments(destination.arguments)}</dd>
        </div>
      </dl>
      <span className="delivery-meta">
        <time dateTime={new Date(destination.created_at).toISOString()}>作成: {formatDateTime(destination.created_at)}</time>
      </span>
      {!confirming && (
        <div className="actions">
          <Link to={`/bots/new?destination=${destination.id}`} className="button button-small">
            この配信先で Bot を作る
          </Link>
          <button
            type="button"
            className="button-danger-outline button-small"
            onClick={() => {
              setConfirming(true);
              setFailure(null);
            }}
          >
            削除…
          </button>
        </div>
      )}
      {confirming && (
        <form className="folder-form" aria-label="配信先を削除" onSubmit={(event) => void onSubmit(event)}>
          <p>
            {kind === "queue"
              ? `キュー「${name}」を削除します。まだ取得されていないイベントは届かなくなります。元に戻せません。`
              : `Webhook 配信先「${name}」を削除します。送信待ちの配信も送られなくなります。元に戻せません。`}
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

// The sources whose events a bot receives, as checkboxes. sources is null when they could not be read.
export function SourceFields({
  selected,
  onChange,
  sources,
  disabled,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  sources: Source[] | null;
  disabled: boolean;
}) {
  function toggle(id: string, checked: boolean) {
    const rest = selected.filter((sourceId) => sourceId !== id);
    onChange(checked ? [...rest, id] : rest);
  }

  return (
    <fieldset className="participant-fields" disabled={disabled}>
      <legend>受け取る送信元</legend>
      {sources === null ? (
        <p className="muted" role="alert">
          {SOURCES_UNAVAILABLE_MESSAGE}
        </p>
      ) : sources.length === 0 ? (
        <p className="muted">
          送信元がありません。<Link to="/sources">送信元</Link>画面で作成してください
        </p>
      ) : (
        sources.map((source) => (
          <label key={source.id} className="choice">
            <input
              type="checkbox"
              value={source.id}
              checked={selected.includes(source.id)}
              onChange={(event) => toggle(source.id, event.target.checked)}
            />
            <span className="choice-title">
              {source.name}
              {source.enabled ? "" : "（無効）"}
            </span>
          </label>
        ))
      )}
    </fieldset>
  );
}

// The destination of a bot without its kind (shown as a chip next to it): "なし" when there is none.
export function botDeliveryValue(bot: Bot): string {
  const delivery = bot.delivery;
  // An MCP Event bot is shown by the app of its connection, as the flow map shows it.
  if (bot.delivery_kind === "mcp") {
    // Without a connection the status badge already says 未接続.
    if (bot.connection === null) return "なし";
    const app = bot.connection.client_name;
    if (delivery === null) return app;
    return `${app}（${delivery.callback_host ?? "不明な宛先"}）${delivery.status === "active" ? "" : "（無効）"}`;
  }
  if (delivery === null) return "なし";
  const inactive = delivery.status === "active" ? "" : "（無効）";
  switch (bot.delivery_kind) {
    case "webhook":
      return `${delivery.name ?? "（名前なし）"}${delivery.callback_host === null ? "" : `（${delivery.callback_host}）`}${inactive}`;
    case "queue":
      return `${delivery.name ?? "（名前なし）"}${inactive}`;
  }
}
