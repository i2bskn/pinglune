import { type FormEvent, useState } from "react";
import type { Bot, BotDeliveryKind, McpConnection, Source, Subscription } from "../../../src/api/types";
import { assignMcpConnection, createBot, deleteBot, revokeMcpConnection, updateBot } from "../actions";
import {
  BOT_STATUS_LABELS,
  type BotForm,
  CONNECTION_KIND_LABELS,
  DELIVERY_KINDS,
  DELIVERY_KIND_DESCRIPTIONS,
  DELIVERY_KIND_LABELS,
  EMPTY_BOT_FORM,
  MCP_DELIVERY_PENDING_MESSAGE,
  SOURCES_UNAVAILABLE_MESSAGE,
  availableDestinations,
  botConnectionExpired,
  botDeliveryLabel,
  botForm,
  botSourcesLabel,
  connectionLabel,
  createBotRequest,
  replacementWarning,
  sourceChoices,
  updateBotRequest,
} from "../bots";
import { subscriptionLabel } from "../conversations";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, type BotsData, loadBotsView, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const BOT_GONE_MESSAGE = "この Bot は見つかりません。削除された可能性があります";
const CONNECTION_GONE_MESSAGE = "この MCP 接続は見つかりません。切断された可能性があります";
const CONNECTIONS_DELAY_MESSAGE = "接続した直後は表示まで 1 分ほどかかることがあります。";

type Done = (message: string | null) => void;

// The bots of the signed-in user's workspace and the MCP connections of the user.
export function BotsView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadBotsView(client), "bots");
  // The result of the last operation, kept across the reload that follows.
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, () => "Bot"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return (
    <BotsContent
      // Keyed by the data, so that open forms close after a reload.
      key={JSON.stringify([state.data.bots.map((b) => b.updated_at), state.data.connections.map((c) => c.id ?? c.grant_id)])}
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
  onDone: Done;
}) {
  return (
    <main className="main">
      <h1>Bot</h1>
      <p className="lead">
        Bot は会話に参加する AI です。名前・MCP 接続・通知先・受け取る送信元をまとめて管理します。AI から Pinglune
        に接続するとき、どの Bot として接続するかを選びます。送信元のイベントは、その送信元を紐づけた Bot の通知先にだけ届きます。
      </p>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <CreateBotForm client={client} data={data} onDone={onDone} />
      {data.bots.length === 0 ? (
        <p className="notice">Bot を作ると、会話の参加者として選べます。</p>
      ) : (
        <ul className="list subscriptions">
          {data.bots.map((bot) => (
            <BotItem key={bot.id} client={client} bot={bot} data={data} onDone={onDone} />
          ))}
        </ul>
      )}

      <h2>MCP 接続</h2>
      <p>
        AI が Pinglune の MCP に接続（承認）するたびに 1 つ増えます。Bot に割り当てた接続が、その Bot として会話で発言します。
      </p>
      {data.connectionsError !== null ? (
        <p className="notice">{data.connectionsError}</p>
      ) : data.connections.length === 0 ? (
        <div className="notice">
          <p>MCP 接続はまだありません。</p>
          <p>{CONNECTIONS_DELAY_MESSAGE}</p>
        </div>
      ) : (
        <ul className="list subscriptions">
          {data.connections.map((connection) => (
            <ConnectionItem
              key={connection.id ?? `grant:${connection.grant_id ?? ""}`}
              client={client}
              connection={connection}
              bots={data.bots}
              onDone={onDone}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

// The sources of programs, by name, or null when they could not be read.
function sourcesOf(data: BotsData): Source[] | null {
  return data.sourcesError === null ? sourceChoices(data.sources) : null;
}

// The sources whose events the bot receives, as checkboxes.
function SourceFields({
  form,
  onChange,
  sources,
  disabled,
}: {
  form: BotForm;
  onChange: (next: BotForm) => void;
  sources: Source[] | null;
  disabled: boolean;
}) {
  function toggle(id: string, checked: boolean) {
    const rest = form.sourceIds.filter((sourceId) => sourceId !== id);
    onChange({ ...form, sourceIds: checked ? [...rest, id] : rest });
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
              checked={form.sourceIds.includes(source.id)}
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

// The name, the delivery kind, the destination and the sources of a bot, for the creation and the edit forms.
function BotFormFields({
  form,
  onChange,
  destinations,
  sources,
  disabled,
}: {
  form: BotForm;
  onChange: (next: BotForm) => void;
  destinations: (kind: BotDeliveryKind) => Subscription[];
  sources: Source[] | null;
  disabled: boolean;
}) {
  const choices = destinations(form.deliveryKind);
  return (
    <>
      <label>
        名前（64&nbsp;文字以内）
        <input
          type="text"
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
          autoComplete="off"
          required
          maxLength={64}
          disabled={disabled}
        />
      </label>
      <fieldset className="participant-fields" disabled={disabled}>
        <legend>配信方式</legend>
        {DELIVERY_KINDS.map((kind) => (
          <label key={kind} className="choice">
            <input
              type="radio"
              name="delivery_kind"
              value={kind}
              checked={form.deliveryKind === kind}
              onChange={() => onChange({ ...form, deliveryKind: kind, deliverySubscriptionId: "" })}
            />
            <span>
              <span className="choice-title">{DELIVERY_KIND_LABELS[kind]}</span>
              <span className="choice-description">{DELIVERY_KIND_DESCRIPTIONS[kind]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {form.deliveryKind !== "mcp" && (
        <label>
          通知先
          <select
            value={form.deliverySubscriptionId}
            onChange={(event) => onChange({ ...form, deliverySubscriptionId: event.target.value })}
            required
            disabled={disabled}
          >
            <option value="">選んでください</option>
            {choices.map((subscription) => (
              <option key={subscription.id} value={subscription.id}>
                {subscriptionLabel(subscription)}
              </option>
            ))}
          </select>
        </label>
      )}
      {form.deliveryKind !== "mcp" && choices.length === 0 && (
        <p className="muted">
          選べる通知先がありません。<Link to="/deliveries">配信</Link>で
          {form.deliveryKind === "webhook" ? " Webhook 配信先" : "ポーリング用キュー"}
          を登録してください（ほかの Bot が使っている通知先は選べません）。
        </p>
      )}
      <SourceFields form={form} onChange={onChange} sources={sources} disabled={disabled} />
    </>
  );
}

function CreateBotForm({ client, data, onDone }: { client: ApiClient; data: BotsData; onDone: Done }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<BotForm>(EMPTY_BOT_FORM);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setForm(EMPTY_BOT_FORM);
    setFailure(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = createBotRequest(form, data.sourcesError === null);
    if (!request.ok) {
      setFailure(request.message);
      return;
    }
    setSending(true);
    setFailure(null);
    const result = await createBot(client, request.value);
    switch (result.kind) {
      case "ok":
        setSending(false);
        close();
        onDone(`Bot「${result.bot.name}」を作りました`);
        return;
      case "notFound":
        setSending(false);
        setFailure("Bot を作れませんでした");
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

  if (!open) {
    return (
      <div className="actions">
        <button type="button" className="button-primary" onClick={() => setOpen(true)}>
          <PlusIcon />
          Bot を作成
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="Bot を作成" onSubmit={(event) => void onSubmit(event)}>
      <BotFormFields
        form={form}
        onChange={setForm}
        destinations={(kind) => availableDestinations(data.subscriptions, data.bots, kind, null)}
        sources={sourcesOf(data)}
        disabled={sending}
      />
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          作成
        </button>
        <button type="button" onClick={close} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

function BotItem({ client, bot, data, onDone }: { client: ApiClient; bot: Bot; data: BotsData; onDone: Done }) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [form, setForm] = useState<BotForm>(() => botForm(bot));
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const expired = botConnectionExpired(bot, data.connections);

  function open(next: "edit" | "delete") {
    setMode(next);
    setForm(botForm(bot));
    setFailure(null);
  }

  async function finish(result: { kind: "ok" | "notFound" | "error" | "unknown" | "redirecting"; message?: string }, ok: string) {
    switch (result.kind) {
      case "ok":
        setSending(false);
        setMode("view");
        onDone(ok);
        return;
      case "notFound":
        setSending(false);
        setMode("view");
        onDone(BOT_GONE_MESSAGE);
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

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = updateBotRequest(bot, form, data.sourcesError === null);
    if (request === null) {
      setMode("view");
      return;
    }
    if (!request.ok) {
      setFailure(request.message);
      return;
    }
    setSending(true);
    setFailure(null);
    await finish(await updateBot(client, bot.id, request.value), "Bot を更新しました");
  }

  async function onDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    await finish(await deleteBot(client, bot.id), `Bot「${bot.name}」を削除しました`);
  }

  return (
    <li className="subscription">
      <span className="delivery-head">
        <span className="delivery-host">{bot.name}</span>
        <span className={bot.status === "ready" ? "badge" : "badge badge-off"}>{BOT_STATUS_LABELS[bot.status]}</span>
        {expired && <span className="badge badge-error">接続の期限切れ</span>}
        {mode === "view" && (
          <span className="item-actions">
            <button type="button" onClick={() => open("edit")}>
              編集
            </button>
            <button type="button" className="button-danger-outline" onClick={() => open("delete")}>
              削除
            </button>
          </span>
        )}
      </span>
      <span className="delivery-conditions">
        MCP 接続: {bot.connection === null ? "なし" : connectionLabel(bot.connection)}
      </span>
      <span className="delivery-conditions">
        通知先: {botDeliveryLabel(bot)}
        {bot.delivery !== null && bot.delivery.status !== "active" ? "（無効）" : ""}
      </span>
      <span className="delivery-conditions">{botSourcesLabel(bot)}</span>
      {bot.status === "no_connection" && (
        <span className="delivery-conditions">AI から Pinglune に接続するとき、この Bot を選んでください。</span>
      )}
      {bot.status === "no_delivery" && bot.delivery_kind === "mcp" && (
        <span className="delivery-conditions">{MCP_DELIVERY_PENDING_MESSAGE}</span>
      )}
      {bot.connection !== null && (
        <span className="delivery-meta">
          <time dateTime={new Date(bot.connection.created_at).toISOString()}>
            接続: {formatDateTime(bot.connection.created_at)}
          </time>
        </span>
      )}
      {mode === "edit" && (
        <form className="folder-form" aria-label={`Bot「${bot.name}」を編集`} onSubmit={(event) => void onSave(event)}>
          <BotFormFields
            form={form}
            onChange={setForm}
            destinations={(kind) => availableDestinations(data.subscriptions, data.bots, kind, bot.id)}
            sources={sourcesOf(data)}
            disabled={sending}
          />
          <div className="folder-form-actions">
            <button type="submit" disabled={sending}>
              保存
            </button>
            <button type="button" onClick={() => setMode("view")} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
      {mode === "delete" && (
        <form className="folder-form" aria-label={`Bot「${bot.name}」を削除`} onSubmit={(event) => void onDelete(event)}>
          <p>
            Bot「{bot.name}」を削除します。会話の参加者には残りますが、発言も通知もできなくなります。MCP
            接続は切断せず、Bot に割り当てない接続として残ります。通知先（Webhook 配信先・キュー）は終了しませんが、イベントは届かなくなります。
          </p>
          <div className="folder-form-actions">
            <button type="submit" className="button-danger" disabled={sending}>
              削除する
            </button>
            <button type="button" onClick={() => setMode("view")} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
    </li>
  );
}

function ConnectionItem({
  client,
  connection,
  bots,
  onDone,
}: {
  client: ApiClient;
  connection: McpConnection;
  bots: Bot[];
  onDone: Done;
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

  async function settle(result: { kind: "ok" | "notFound" | "error" | "unknown" | "redirecting"; message?: string }, ok: string) {
    switch (result.kind) {
      case "ok":
        setSending(false);
        setPending(null);
        setRevoking(false);
        onDone(ok);
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
          ? `接続を Bot「${bot.name}」に割り当てました。${MCP_DELIVERY_PENDING_MESSAGE}`
          : `接続を Bot「${bot.name}」に割り当てました`;
    await settle(await assignMcpConnection(client, { ...to, bot_id: botId === "" ? null : botId }), message);
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
    await settle(await revokeMcpConnection(client, to), `MCP 接続（${connectionLabel(connection)}）を切断しました`);
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
              切断
            </button>
          </span>
        )}
      </span>
      <span className="delivery-conditions">リダイレクト先: {connection.redirect_host === "" ? "不明" : connection.redirect_host}</span>
      <span className="delivery-meta">
        <time dateTime={new Date(connection.created_at).toISOString()}>接続: {formatDateTime(connection.created_at)}</time>
      </span>
      {assignable ? (
        <label className="inline-select">
          Bot
          <select value={pending ?? current} onChange={(event) => onSelect(event.target.value)} disabled={sending}>
            <option value="">割り当てない</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="delivery-conditions">
          {connection.kind === "expired"
            ? `Bot: ${connection.bot?.name ?? "なし"}（期限切れのため変更できません。AI から接続し直してください）`
            : "切断済みの接続です。AI から接続し直してください"}
        </span>
      )}
      {pending !== null && warning !== null && pendingBot !== undefined && (
        <form className="folder-form" aria-label="接続を Bot に割り当て" onSubmit={(event) => {
          event.preventDefault();
          void assign(pendingBot.id);
        }}>
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
    </li>
  );
}
