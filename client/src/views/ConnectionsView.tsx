import { type FormEvent, useState } from "react";
import type { Bot, McpConnection, Subscription } from "../../../src/api/types";
import { assignMcpConnection, revokeMcpConnection } from "../actions";
import { CONNECTION_KIND_LABELS, MCP_DELIVERY_PENDING_MESSAGE, botPath, connectionLabel, replacementWarning } from "../bots";
import { groupConnectionSubscriptions } from "../connections";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, type BotsData, loadBotsView, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { McpSubscriptionItem } from "./DeliveriesView";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const CONNECTION_GONE_MESSAGE = "この MCP 接続は見つかりません。切断された可能性があります";
const CONNECTIONS_DELAY_MESSAGE = "接続した直後は表示まで 1 分ほどかかることがあります。";

// The key of a connection on the screen: its ID, or the grant of a legacy or stale one.
function connectionKey(connection: McpConnection): string {
  return connection.id ?? `grant:${connection.grant_id ?? ""}`;
}

// The MCP connections of the user, each with the bot it is assigned to and the MCP Events subscriptions it made,
// and the subscriptions of no listed connection.
export function ConnectionsView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadBotsView(client), "connections");
  // The result of the last operation on the screen, kept across the reload that follows.
  const [notice, setNotice] = useState<string | null>(null);
  // The result of the last assignment of each connection, shown in its card.
  const [cardNotices, setCardNotices] = useState<Record<string, string>>({});
  useDocumentTitle(viewTitle(state, () => "AI の接続"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return (
    <ConnectionsContent
      // Keyed by the data, so that open forms close after a reload.
      key={JSON.stringify([
        state.data.connections.map((c) => [connectionKey(c), c.kind, c.bot?.id ?? null]),
        state.data.subscriptions.map((s) => [s.id, s.status]),
      ])}
      client={client}
      data={state.data}
      notice={notice}
      cardNotices={cardNotices}
      onDone={(message) => {
        setNotice(message);
        setCardNotices({});
        reload();
      }}
      onAssigned={(key, message) => {
        setNotice(null);
        setCardNotices({ [key]: message });
        reload();
      }}
    />
  );
}

function ConnectionsContent({
  client,
  data,
  notice,
  cardNotices,
  onDone,
  onAssigned,
}: {
  client: ApiClient;
  data: BotsData;
  notice: string | null;
  cardNotices: Record<string, string>;
  onDone: (message: string | null) => void;
  onAssigned: (key: string, message: string) => void;
}) {
  const { cards, orphans } = groupConnectionSubscriptions(data.connections, data.subscriptions, data.connectionsError === null);
  return (
    <main className="main">
      <header className="page-head">
        <h1>AI の接続</h1>
        <p className="lead">
          AI が Pinglune の MCP に接続（承認）するたびに 1 件増えます。Bot に割り当てた接続が、その Bot として会話で発言し、その接続の購読が Bot
          の配信先（MCP Event）になります。
        </p>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {data.connectionsError !== null ? (
        <p className="notice">{data.connectionsError}</p>
      ) : cards.length === 0 ? (
        <div className="notice">
          <p>MCP 接続はまだありません。</p>
          <p>{CONNECTIONS_DELAY_MESSAGE}</p>
        </div>
      ) : (
        <ul className="list subscriptions">
          {cards.map(({ connection, subscriptions }) => (
            <ConnectionItem
              key={connectionKey(connection)}
              client={client}
              connection={connection}
              subscriptions={subscriptions}
              bots={data.bots}
              notice={cardNotices[connectionKey(connection)] ?? null}
              onDone={onDone}
              onAssigned={(message) => onAssigned(connectionKey(connection), message)}
            />
          ))}
        </ul>
      )}

      {orphans.length > 0 && (
        <section className="source-section" aria-labelledby="orphan-subscriptions">
          <div className="section-head">
            <h2 id="orphan-subscriptions">以前の接続の購読</h2>
          </div>
          <p className="hint">
            接続の記録より前に作られた購読や、一覧にない接続の購読です。どの Bot にも属さないため、イベントは届きません。AI
            が購読を更新すると、今の接続の購読になります。
          </p>
          <ul className="list subscriptions">
            {orphans.map((subscription) => (
              <McpSubscriptionItem key={subscription.id} client={client} subscription={subscription} showConnection onDone={onDone} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

type Settled = { kind: "ok" | "notFound" | "error" | "unknown" | "redirecting"; message?: string };

function ConnectionItem({
  client,
  connection,
  subscriptions,
  bots,
  notice,
  onDone,
  onAssigned,
}: {
  client: ApiClient;
  connection: McpConnection;
  subscriptions: Subscription[];
  bots: Bot[];
  notice: string | null;
  onDone: (message: string | null) => void;
  onAssigned: (message: string) => void;
}) {
  // The bot chosen in the select, waiting for the confirmation of a replacement; "" means no bot.
  const [pending, setPending] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const badge = CONNECTION_KIND_LABELS[connection.kind];
  const assignable = connection.kind === "active" || connection.kind === "legacy";
  const current = connection.bot?.id ?? "";
  const pendingBot = pending === null || pending === "" ? undefined : bots.find((bot) => bot.id === pending);
  const warning = pendingBot === undefined ? null : replacementWarning(pendingBot, connection);

  function target(): { connection_id: string } | { grant_id: string } | null {
    if (connection.id !== null) return { connection_id: connection.id };
    if (connection.grant_id !== null) return { grant_id: connection.grant_id };
    return null;
  }

  // ok is passed to done; the other outcomes are shown in the card.
  function settle(result: Settled, done: () => void) {
    switch (result.kind) {
      case "ok":
        setSending(false);
        setPending(null);
        setRevoking(false);
        done();
        return;
      case "notFound":
        setSending(false);
        setPending(null);
        setRevoking(false);
        onDone(CONNECTION_GONE_MESSAGE);
        return;
      case "error":
        setSending(false);
        setFailure(result.message ?? UNKNOWN_RESULT_MESSAGE);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        return;
    }
  }

  async function assign(botId: string) {
    const to = target();
    if (to === null) return;
    setSending(true);
    setFailure(null);
    const bot = bots.find((b) => b.id === botId);
    const message =
      bot === undefined
        ? "接続の割り当てを外しました"
        : connection.kind === "legacy" && bot.delivery_kind === "mcp"
          ? `Bot「${bot.name}」に割り当てました。${MCP_DELIVERY_PENDING_MESSAGE}`
          : `Bot「${bot.name}」に割り当てました`;
    const result = await assignMcpConnection(client, { ...to, bot_id: botId === "" ? null : botId });
    // A legacy connection is recorded by the assignment and comes back with an ID, as another card: the result is
    // shown on the screen.
    settle(result, () => (connection.kind === "legacy" ? onDone(message) : onAssigned(message)));
  }

  function onSelect(botId: string) {
    setFailure(null);
    if (botId === current) {
      setPending(null);
      return;
    }
    const bot = botId === "" ? undefined : bots.find((b) => b.id === botId);
    // Confirmed on the screen first when another connection of the bot would be disconnected.
    if (bot !== undefined && replacementWarning(bot, connection) !== null) {
      setPending(botId);
      return;
    }
    void assign(botId);
  }

  async function onRevoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const to = target();
    if (to === null) return;
    setSending(true);
    setFailure(null);
    const result = await revokeMcpConnection(client, to);
    settle(result, () => onDone(`MCP 接続（${connectionLabel(connection)}）を切断しました`));
  }

  return (
    <li className="subscription">
      <span className="delivery-head">
        <span className="delivery-host">{connection.client_name}</span>
        {badge !== null && <span className="badge badge-off">{badge}</span>}
        {!revoking && (
          <span className="item-actions">
            <button
              type="button"
              className="button-danger-outline"
              onClick={() => {
                setRevoking(true);
                setPending(null);
                setFailure(null);
              }}
              disabled={sending}
            >
              切断…
            </button>
          </span>
        )}
      </span>
      <dl className="facts">
        <div>
          <dt>宛先</dt>
          <dd>{connection.redirect_host === "" ? "不明" : connection.redirect_host}</dd>
        </div>
        <div>
          <dt>接続日時</dt>
          <dd>
            <time dateTime={new Date(connection.created_at).toISOString()}>{formatDateTime(connection.created_at)}</time>
          </dd>
        </div>
        <div>
          <dt>Bot</dt>
          <dd>
            {assignable ? (
              <label className="inline-select">
                <span className="sr-only">割り当てる Bot</span>
                <select value={pending ?? current} onChange={(event) => onSelect(event.target.value)} disabled={sending}>
                  <option value="">割り当てない</option>
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : connection.kind === "expired" ? (
              <>
                {connection.bot === null ? "なし" : <Link to={botPath(connection.bot.id)}>{connection.bot.name}</Link>}
                <span className="muted">（期限切れのため変更できません。AI から接続し直してください）</span>
              </>
            ) : (
              <span className="muted">この接続は使えません。AI から接続し直してください</span>
            )}
            {assignable && connection.bot !== null && <Link to={botPath(connection.bot.id)}>Bot を開く</Link>}
          </dd>
        </div>
      </dl>
      {notice !== null && (
        <p className="delivery-notice" role="status">
          {notice}
        </p>
      )}
      {pending !== null && warning !== null && pendingBot !== undefined && (
        <form
          className="folder-form"
          aria-label="接続を Bot に割り当て"
          onSubmit={(event) => {
            event.preventDefault();
            void assign(pendingBot.id);
          }}
        >
          <p>{warning}。この接続を Bot「{pendingBot.name}」に割り当てますか？</p>
          <div className="folder-form-actions">
            <button type="submit" disabled={sending}>
              割り当てる
            </button>
            <button type="button" onClick={() => setPending(null)} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
      {revoking && (
        <form className="folder-form" aria-label="MCP 接続を切断" onSubmit={(event) => void onRevoke(event)}>
          <p>
            MCP 接続（{connectionLabel(connection)}）を切断します。AI はもう一度接続するまで、この接続で Pinglune を使えません。
            {connection.kind === "legacy" || connection.kind === "stale"
              ? "この接続が作った購読は、期限が来るまで残ります。"
              : "この接続が作った購読も停止します。"}
          </p>
          <div className="folder-form-actions">
            <button type="submit" className="button-danger" disabled={sending}>
              切断する
            </button>
            <button type="button" onClick={() => setRevoking(false)} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
      {pending === null && !revoking && failure !== null && <p role="alert">{failure}</p>}
      <div className="connection-subscriptions">
        <h3>購読</h3>
        {subscriptions.length === 0 ? (
          <p className="muted">
            {connection.kind === "legacy" || connection.kind === "stale"
              ? "この接続の購読は記録されていません。"
              : "この接続の購読はまだありません。AI がイベントを購読すると、ここに表示されます。"}
          </p>
        ) : (
          <ul className="list subscriptions">
            {subscriptions.map((subscription) => (
              <McpSubscriptionItem
                key={subscription.id}
                client={client}
                subscription={subscription}
                showConnection={false}
                onDone={onDone}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
