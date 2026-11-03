import { type FormEvent, useState } from "react";
import type { BotDetail, DeliveryListItem } from "../../../src/api/types";
import { type BotResult, deleteBot, updateBot, updateConversationStart } from "../actions";
import {
  DELIVERY_KIND_DESCRIPTIONS,
  DELIVERY_KIND_LABELS,
  EMPTY_CONDITIONS_FORM,
  MCP_DELIVERY_PENDING_MESSAGE,
  type ConditionsForm,
  type DeliveryChangeForm,
  botConnectionExpired,
  botStatusLabel,
  conditionsFormOf,
  conditionsRequest,
  connectionLabel,
  conversationStartForm,
  conversationStartRequest,
  deliveryChangeKinds,
  deliveryChangeRequest,
  deliveryChangeWarning,
  sourceChoices,
} from "../bots";
import { WEBHOOK_DESTINATION_STATUS_LABELS, describeArguments } from "../deliveries";
import { setFlash } from "../flash";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, type BotDetailData, type ViewState, loadBotDetail, loadDeliveries, useView } from "../load";
import { navigate } from "../router";
import { WebhookFields } from "./BotNewView";
import { SourceFields } from "./BotsView";
import { ViewStatus, useDocumentTitle, useFlashNotice, viewTitle } from "./common";
import { ConditionFields, CopyableId } from "./DeliveriesView";
import { DeliveryList } from "./DeliveryHistoryView";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const BOT_GONE_MESSAGE = "この Bot は見つかりません。削除された可能性があります";
const RECENT_DELIVERIES = 10;
const QUEUE_GUIDE =
  "AI に、このキューの ID を claim_events に渡して定期的に（5 分おきなど）取得させ、処理したら ack_events を呼ばせてください。";
const CONDITIONS_NOTE = "条件を指定しないと、受け取る送信元のすべてのイベントが届きます。";
const DELETE_CONFIRMATION =
  "Bot を削除します。Webhook / キューの配信先も終了し、これからのイベントは届かなくなります。MCP 接続は割り当てなしの接続として残ります。元に戻せません。";

// The confirmation when the destination is kept.
function keepDestinationConfirmation(name: string): string {
  return `Bot を削除します。配信先『${name}』は残ります。すでに送信待ちの配信はそのまま送られますが、新しいイベントは、別の Bot に割り当てるまで届きません。MCP 接続は割り当てなしの接続として残ります。元に戻せません。`;
}

type Done = (message: string | null) => void;

// One bot: the sources it receives, its delivery kind and destination, the MCP connection it uses and its newest
// deliveries.
export function BotDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadBotDetail(client, id), `bot:${id}`);
  // The result of the last operation, kept across the reload that follows; or the message of the creation screen.
  const [notice, setNotice] = useState<string | null>(null);
  useFlashNotice(setNotice);
  useDocumentTitle(viewTitle(state, (data) => data.bot.name));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={BOT_GONE_MESSAGE} onReload={reload} />;
  }
  const { bot } = state.data;
  return (
    <BotContent
      // Keyed by the data, so that open forms close after a reload.
      key={JSON.stringify([bot.updated_at, bot.destination, bot.delivery, bot.connection?.id ?? null])}
      client={client}
      data={state.data}
      notice={notice}
      reload={reload}
      onDone={(message) => {
        setNotice(message);
        reload();
      }}
    />
  );
}

// Sorts the outcome of an update: ok and gone are passed on, the others become the message of the form (null while
// moving to the login page).
function updateFailure(result: Exclude<BotResult, { kind: "ok" }>): string | null {
  switch (result.kind) {
    case "notFound":
      return BOT_GONE_MESSAGE;
    case "error":
      return result.message;
    case "unknown":
      return UNKNOWN_RESULT_MESSAGE;
    case "redirecting":
      return null;
  }
}

// Sends an update of the bot. Returns the failure to show in the form, or null when it is done (onDone has been
// called) or the move to the login page has started.
async function sendUpdate(
  client: ApiClient,
  bot: BotDetail,
  input: Parameters<typeof updateBot>[2],
  ok: string,
  onDone: Done,
): Promise<string | null> {
  const result = await updateBot(client, bot.id, input);
  if (result.kind === "ok") {
    onDone(ok);
    return null;
  }
  if (result.kind === "notFound") {
    onDone(BOT_GONE_MESSAGE);
    return null;
  }
  return updateFailure(result);
}

function BotContent({
  client,
  data,
  notice,
  reload,
  onDone,
}: {
  client: ApiClient;
  data: BotDetailData;
  notice: string | null;
  reload: () => void;
  onDone: Done;
}) {
  const { bot } = data;
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const expired = botConnectionExpired(bot, data.connections);

  return (
    <main className="main">
      <p className="breadcrumb">
        <Link to="/bots">Bot</Link>
      </p>
      <header className="page-head page-head-row">
        <div className="page-head-title">
          <h1>{bot.name}</h1>
          <span className={bot.status === "ready" ? "badge badge-ok" : "badge badge-warning"}>{botStatusLabel(bot)}</span>
          {expired && <span className="badge badge-warning">接続の期限切れ</span>}
        </div>
        {mode === "view" && (
          <div className="actions page-head-actions">
            <button type="button" onClick={() => setMode("rename")}>
              名前を変更
            </button>
            <button type="button" className="button-danger-outline" onClick={() => setMode("delete")}>
              削除…
            </button>
          </div>
        )}
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {mode === "rename" && <RenameForm client={client} bot={bot} onCancel={() => setMode("view")} onDone={onDone} />}
      {mode === "delete" && <DeleteForm client={client} bot={bot} onCancel={() => setMode("view")} reload={reload} />}

      <SourcesSection client={client} data={data} onDone={onDone} />
      <DeliverySection client={client} bot={bot} onDone={onDone} />
      <ConnectionSection bot={bot} />
      <ConversationStartSection client={client} bot={bot} onDone={onDone} />
      <RecentDeliveries client={client} bot={bot} />
    </main>
  );
}

function RenameForm({
  client,
  bot,
  onCancel,
  onDone,
}: {
  client: ApiClient;
  bot: BotDetail;
  onCancel: () => void;
  onDone: Done;
}) {
  const [name, setName] = useState(bot.name);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === bot.name) {
      onCancel();
      return;
    }
    setSending(true);
    setFailure(null);
    const message = await sendUpdate(client, bot, { name }, "名前を変更しました", onDone);
    setSending(false);
    setFailure(message);
  }

  return (
    <form className="folder-form" aria-label="名前を変更" onSubmit={(event) => void onSubmit(event)}>
      <label>
        新しい名前（64&nbsp;文字以内）
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          required
          maxLength={64}
          disabled={sending}
        />
      </label>
      {bot.destination !== null && bot.destination.status === "active" && (
        <p className="muted">配信先の名前も Bot の名前に変わります。</p>
      )}
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          変更
        </button>
        <button type="button" onClick={onCancel} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

function DeleteForm({
  client,
  bot,
  onCancel,
  reload,
}: {
  client: ApiClient;
  bot: BotDetail;
  onCancel: () => void;
  reload: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The bot was changed by another operation: the screen must be read again before deleting.
  const [conflict, setConflict] = useState<string | null>(null);
  // Whether the webhook destination or polling queue is kept, not assigned to a bot. Offered only while it is active.
  const [keep, setKeep] = useState(false);
  const destination = bot.delivery_kind !== "mcp" && bot.destination?.status === "active" ? bot.destination : null;
  const destinationName = destination?.name ?? "（名前なし）";
  const keepDestination = destination !== null && keep;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await deleteBot(client, bot.id, { keepDestination });
    switch (result.kind) {
      case "ok":
        // A 204 does not tell whether the destination was kept (the bot may have been deleted meanwhile), so the
        // notice says what was asked.
        setFlash(
          keepDestination
            ? `Bot「${bot.name}」を削除しました。配信先を残すよう指定しました（Bot 一覧の『Bot に割り当てられていない配信先』で確かめられます）`
            : `Bot「${bot.name}」を削除しました`,
        );
        navigate("/bots");
        return;
      case "notFound":
        setFlash(BOT_GONE_MESSAGE);
        navigate("/bots");
        return;
      case "conflict":
        setSending(false);
        setConflict(result.message);
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
    <form className="folder-form" aria-label={`Bot「${bot.name}」を削除`} onSubmit={(event) => void onSubmit(event)}>
      <p>{keepDestination ? keepDestinationConfirmation(destinationName) : DELETE_CONFIRMATION}</p>
      {destination?.kind === "queue" && !keepDestination && (
        <p className="muted">
          キューのまだ処理されていないイベント（取得済みで処理済みの連絡がないものを含む）は失敗になり、あとから ack_events で処理済みにはできません。
        </p>
      )}
      {destination !== null && (
        <label className="choice">
          <input
            type="checkbox"
            name="keep_destination"
            checked={keep}
            onChange={(event) => setKeep(event.target.checked)}
            disabled={sending}
          />
          <span>
            <span className="choice-title">配信先『{destinationName}』を残す</span>
            <span className="choice-description">
              残した配信先は、Bot 一覧の『Bot に割り当てられていない配信先』から別の Bot で使えます
            </span>
          </span>
        </label>
      )}
      {conflict !== null ? (
        <div className="callout" role="alert">
          <p className="warning-note">{conflict}</p>
          <button type="button" className="button-primary" onClick={reload}>
            読み込み直す
          </button>
        </div>
      ) : (
        <div className="folder-form-actions">
          <button type="submit" className="button-danger" disabled={sending}>
            削除する
          </button>
          <button type="button" onClick={onCancel} disabled={sending}>
            やめる
          </button>
        </div>
      )}
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

function SourcesSection({ client, data, onDone }: { client: ApiClient; data: BotDetailData; onDone: Done }) {
  const { bot } = data;
  const current = bot.sources.map((source) => source.id);
  const [selected, setSelected] = useState(current);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sources = data.sourcesError === null ? sourceChoices(data.sources) : null;
  const changed = selected.length !== current.length || selected.some((id) => !current.includes(id));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sources === null) return;
    setSending(true);
    setFailure(null);
    const message = await sendUpdate(client, bot, { source_ids: selected }, "受け取る送信元を保存しました", onDone);
    setSending(false);
    setFailure(message);
  }

  return (
    <section className="source-section" aria-labelledby="bot-sources">
      <div className="section-head">
        <h2 id="bot-sources">受け取る送信元</h2>
      </div>
      {bot.sources.length === 0 && (
        <p className="warning-note">送信元がないため、イベントは届きません（会話には参加できます）。</p>
      )}
      <form className="folder-form" aria-label="受け取る送信元" onSubmit={(event) => void onSubmit(event)}>
        <SourceFields selected={selected} onChange={setSelected} sources={sources} disabled={sending} />
        <div className="folder-form-actions">
          <button type="submit" disabled={sending || sources === null || !changed}>
            保存
          </button>
        </div>
        {failure !== null && <p role="alert">{failure}</p>}
      </form>
    </section>
  );
}

function DeliverySection({ client, bot, onDone }: { client: ApiClient; bot: BotDetail; onDone: Done }) {
  const [mode, setMode] = useState<"view" | "conditions" | "change">("view");
  const destination = bot.destination;
  const ended = destination !== null && destination.status !== "active";

  return (
    <section className="source-section" aria-labelledby="bot-delivery">
      <div className="section-head">
        <h2 id="bot-delivery">配信方式</h2>
      </div>
      <dl className="facts">
        <div>
          <dt>方式</dt>
          <dd>
            <span className="kind-chip">{DELIVERY_KIND_LABELS[bot.delivery_kind]}</span>
            <span className="muted">{DELIVERY_KIND_DESCRIPTIONS[bot.delivery_kind]}</span>
          </dd>
        </div>
        {bot.delivery_kind === "mcp" ? (
          <McpDeliveryFacts bot={bot} />
        ) : destination === null ? (
          <div>
            <dt>配信先</dt>
            <dd>
              <span className="warning-note">なし（イベントは届きません）</span>
            </dd>
          </div>
        ) : (
          <>
            <div>
              <dt>配信先</dt>
              <dd>
                {destination.name ?? "（名前なし）"}
                <span className={ended ? "badge badge-off" : "badge badge-ok"}>
                  {WEBHOOK_DESTINATION_STATUS_LABELS[destination.status]}
                </span>
              </dd>
            </div>
            {destination.kind === "webhook" && (
              <div>
                <dt>宛先</dt>
                <dd>{destination.callback_host ?? "不明"}</dd>
              </div>
            )}
            {destination.kind === "queue" && !ended && (
              <div>
                <dt>キュー ID</dt>
                <dd>
                  <CopyableId id={destination.subscription_id} />
                </dd>
              </div>
            )}
            <div>
              <dt>条件</dt>
              <dd>{describeArguments(destination.arguments)}</dd>
            </div>
          </>
        )}
      </dl>
      {bot.delivery_kind === "mcp" && bot.connection !== null && bot.delivery === null && (
        <p className="hint">{MCP_DELIVERY_PENDING_MESSAGE}</p>
      )}
      {destination?.kind === "queue" && !ended && <p className="hint">{QUEUE_GUIDE}</p>}
      {ended && (
        <p className="warning-note">配信先が終了しているため、イベントは届きません。「配信方式を変更…」で新しい配信先を作ってください。</p>
      )}
      {mode === "view" && (
        <div className="actions">
          {destination !== null && !ended && (
            <button type="button" onClick={() => setMode("conditions")}>
              条件を変更
            </button>
          )}
          <button type="button" onClick={() => setMode("change")}>
            配信方式を変更…
          </button>
        </div>
      )}
      {mode === "conditions" && destination !== null && (
        <ConditionsEditForm
          client={client}
          bot={bot}
          initial={conditionsFormOf(destination.arguments)}
          onCancel={() => setMode("view")}
          onDone={onDone}
        />
      )}
      {mode === "change" && <DeliveryChangeEditForm client={client} bot={bot} onCancel={() => setMode("view")} onDone={onDone} />}
    </section>
  );
}

// The destination of an MCP Event bot: the app of its connection and the state of its subscription.
function McpDeliveryFacts({ bot }: { bot: BotDetail }) {
  return (
    <div>
      <dt>配信先</dt>
      <dd>
        {bot.connection === null ? (
          <span className="warning-note">未接続（AI から接続するとき、この Bot を選んでください）</span>
        ) : bot.delivery === null ? (
          <>
            {bot.connection.client_name}
            <span className="badge badge-warning">未購読</span>
          </>
        ) : (
          <>
            {bot.connection.client_name}（{bot.delivery.callback_host ?? "不明な宛先"}）
            <span className="badge badge-ok">購読中</span>
          </>
        )}
      </dd>
    </div>
  );
}

function ConditionsEditForm({
  client,
  bot,
  initial,
  onCancel,
  onDone,
}: {
  client: ApiClient;
  bot: BotDetail;
  initial: ConditionsForm;
  onCancel: () => void;
  onDone: Done;
}) {
  const [form, setForm] = useState(initial);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const conditions = conditionsRequest(form);
    if (!conditions.ok) {
      setFailure(conditions.message);
      return;
    }
    setSending(true);
    setFailure(null);
    const message = await sendUpdate(client, bot, { conditions: conditions.value }, "条件を変更しました", onDone);
    setSending(false);
    setFailure(message);
  }

  return (
    <form className="folder-form" aria-label="条件を変更" onSubmit={(event) => void onSubmit(event)}>
      <ConditionFields value={form} onChange={setForm} disabled={sending} note={CONDITIONS_NOTE} />
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

function DeliveryChangeEditForm({
  client,
  bot,
  onCancel,
  onDone,
}: {
  client: ApiClient;
  bot: BotDetail;
  onCancel: () => void;
  onDone: Done;
}) {
  const kinds = deliveryChangeKinds(bot);
  // The key of a new webhook destination is kept only in this state.
  const [form, setForm] = useState<DeliveryChangeForm>({
    kind: kinds[0] ?? "webhook",
    url: "",
    token: "",
    conditions: EMPTY_CONDITIONS_FORM,
  });
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const warning = deliveryChangeWarning(bot);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = deliveryChangeRequest(form);
    if (!request.ok) {
      setFailure(request.message);
      return;
    }
    setSending(true);
    setFailure(null);
    const message = await sendUpdate(client, bot, request.value, "配信方式を変更しました", onDone);
    setSending(false);
    setFailure(message);
  }

  return (
    <form className="folder-form" aria-label="配信方式を変更" onSubmit={(event) => void onSubmit(event)}>
      <fieldset className="participant-fields" disabled={sending}>
        <legend>新しい配信方式</legend>
        {kinds.map((kind) => (
          <label key={kind} className="choice">
            <input
              type="radio"
              name="new_delivery_kind"
              value={kind}
              checked={form.kind === kind}
              onChange={() => setForm({ ...form, kind })}
            />
            <span>
              <span className="choice-title">
                {DELIVERY_KIND_LABELS[kind]}
                {kind === bot.delivery_kind ? "（新しい配信先）" : ""}
              </span>
              <span className="choice-description">{DELIVERY_KIND_DESCRIPTIONS[kind]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {form.kind === "webhook" && <WebhookFields form={form} onChange={setForm} disabled={sending} />}
      {form.kind !== "mcp" && (
        <ConditionFields
          value={form.conditions}
          onChange={(conditions) => setForm({ ...form, conditions })}
          disabled={sending}
          note={CONDITIONS_NOTE}
        />
      )}
      {form.kind === "mcp" && (
        <p className="muted">AI から接続するときにこの Bot を選ぶと、その AI の購読が配信先になります。</p>
      )}
      {warning !== null && <p className="warning-note">{warning}</p>}
      {bot.delivery_kind === "queue" && <p className="muted">キューを作り直すことはできません。新しいキューが必要なときは Bot を作り直してください。</p>}
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          変更する
        </button>
        <button type="button" onClick={onCancel} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

function ConnectionSection({ bot }: { bot: BotDetail }) {
  const connection = bot.connection;
  return (
    <section className="source-section" aria-labelledby="bot-connection">
      <div className="section-head">
        <h2 id="bot-connection">使う接続</h2>
        <Link to="/connections">AI の接続で管理する</Link>
      </div>
      {connection === null ? (
        <p className="empty-note">未接続です。AI から Pinglune に接続するとき、この Bot を選んでください。</p>
      ) : (
        <dl className="facts">
          <div>
            <dt>アプリ</dt>
            <dd>{connectionLabel(connection)}</dd>
          </div>
          <div>
            <dt>接続日時</dt>
            <dd>
              <time dateTime={new Date(connection.created_at).toISOString()}>{formatDateTime(connection.created_at)}</time>
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

// Whether the AI of the bot may start conversations with other bots over MCP, and its limits.
function ConversationStartSection({ client, bot, onDone }: { client: ApiClient; bot: BotDetail; onDone: Done }) {
  const [form, setForm] = useState(() => conversationStartForm(bot));
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = conversationStartRequest(bot, form);
    if (!request.ok) {
      setFailure(request.message);
      return;
    }
    setSending(true);
    setFailure(null);
    const result = await updateConversationStart(client, bot.id, request.value);
    setSending(false);
    if (result.kind === "ok") {
      onDone("会話の開始の設定を保存しました");
      return;
    }
    if (result.kind === "notFound") {
      onDone(BOT_GONE_MESSAGE);
      return;
    }
    setFailure(updateFailure(result));
  }

  return (
    <section className="source-section" aria-labelledby="bot-conversation-start">
      <div className="section-head">
        <h2 id="bot-conversation-start">会話の開始</h2>
      </div>
      <form className="folder-form" aria-label="会話の開始" onSubmit={(event) => void onSubmit(event)}>
        <label className="choice">
          <input
            type="checkbox"
            name="can_start_conversations"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            disabled={sending}
          />
          <span>
            <span className="choice-title">この Bot が自分から会話を始めることを許可する</span>
            <span className="choice-description">
              許可すると、この Bot の AI が MCP で別の Bot との会話を始められます。AI の判断で会話が始まり、相手の AI
              の利用料が増えることがあります
            </span>
          </span>
        </label>
        {form.enabled && (
          <>
            <label>
              1日に始められる会話（1〜1000&nbsp;件）
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                step={1}
                value={form.dailyLimit}
                onChange={(event) => setForm({ ...form, dailyLimit: event.target.value })}
                required
                disabled={sending}
              />
            </label>
            <label>
              AI の発言の上限（1〜100&nbsp;回）
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                step={1}
                value={form.maxAiMessages}
                onChange={(event) => setForm({ ...form, maxAiMessages: event.target.value })}
                required
                disabled={sending}
              />
            </label>
          </>
        )}
        <p className="muted">許可を外しても、すでに始まった会話はそのまま続きます。</p>
        <div className="folder-form-actions">
          <button type="submit" disabled={sending}>
            保存
          </button>
        </div>
        {failure !== null && <p role="alert">{failure}</p>}
      </form>
    </section>
  );
}

// The subscription whose deliveries are shown: the destination of a webhook or queue bot (ended or not), or the
// newest active subscription of an MCP Event bot.
function deliveriesSubscriptionId(bot: BotDetail): string | null {
  if (bot.delivery_kind === "mcp") return bot.delivery?.subscription_id ?? null;
  return bot.destination?.subscription_id ?? null;
}

function RecentDeliveries({ client, bot }: { client: ApiClient; bot: BotDetail }) {
  const subscriptionId = deliveriesSubscriptionId(bot);
  return (
    <section className="source-section" aria-labelledby="bot-deliveries">
      <div className="section-head">
        <h2 id="bot-deliveries">最近の配信</h2>
        <Link to="/deliveries/history">配信履歴で見る</Link>
      </div>
      {subscriptionId === null ? (
        <p className="empty-note">
          {bot.delivery_kind === "mcp"
            ? "購読がないため、配信はまだありません。AI が購読すると、ここに表示されます。"
            : "配信先がないため、配信はありません。"}
        </p>
      ) : (
        <>
          {bot.delivery_kind === "mcp" && <p className="hint">最新の購読への配信だけを表示しています。</p>}
          <RecentDeliveriesBody client={client} subscriptionId={subscriptionId} />
        </>
      )}
    </section>
  );
}

function RecentDeliveriesBody({ client, subscriptionId }: { client: ApiClient; subscriptionId: string }) {
  const [state] = useView(() => loadDeliveries(client, { subscriptionId }), `bot-deliveries:${subscriptionId}`);
  return <RecentDeliveriesState client={client} state={state} />;
}

function RecentDeliveriesState({
  client,
  state,
}: {
  client: ApiClient;
  state: ViewState<{ deliveries: DeliveryListItem[] }>;
}) {
  switch (state.kind) {
    case "loading":
      return <p className="muted">読み込み中…</p>;
    case "redirecting":
      return null;
    case "notFound":
      return <p role="alert">配信の記録を読み込めませんでした</p>;
    case "error":
      return <p role="alert">{state.message}</p>;
    case "ready":
      return state.data.deliveries.length === 0 ? (
        <p className="empty-note">まだ配信はありません。</p>
      ) : (
        <RecentDeliveryList client={client} first={state.data.deliveries.slice(0, RECENT_DELIVERIES)} />
      );
  }
}

// The newest deliveries, with the retry of the history. A retried delivery stays where it is, as the server returned it.
function RecentDeliveryList({ client, first }: { client: ApiClient; first: DeliveryListItem[] }) {
  const [deliveries, setDeliveries] = useState(first);
  return (
    <DeliveryList
      client={client}
      deliveries={deliveries}
      showEvent
      onRetried={(delivery) => setDeliveries((current) => current.map((item) => (item.id === delivery.id ? delivery : item)))}
    />
  );
}
