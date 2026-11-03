import { type FormEvent, useState } from "react";
import type { ApiKey, Bot, EmailAddress, EventList, Source } from "../../../src/api/types";
import {
  type SourceActionResult,
  issueApiKey,
  issueEmailAddress,
  revokeApiKey,
  revokeEmailAddress,
  updateSource,
  updateSourceConversationStart,
} from "../actions";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { eventsPath } from "../events";
import {
  SOURCE_TABS,
  botPath,
  conversationStartForm,
  conversationStartRequest,
  sourceTabOf,
  sourceTabPath,
} from "../bots";
import { conversationCurlExample } from "../conversations";
import { type ApiClient, type ViewState, loadEvents, loadSourceBots, loadSourceDetail, useView } from "../load";
import { searchParams } from "../router";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { EventRow } from "./EventsView";
import { CopyableId } from "./DeliveriesView";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const GONE_MESSAGE = "この送信元は見つかりません";
const KEY_GONE_MESSAGE = "このAPI キーは見つかりません";
const ADDRESS_GONE_MESSAGE = "このメールアドレスは見つかりません";

const RECENT_EVENTS = 5;

// One source, in three tabs (?tab=): the overview (the bots that receive its events and its newest events), how to
// send (its ID for Service Bindings, its API keys, the example of starting a conversation and its email addresses),
// and the settings (rename, enable or disable, the conversation start settings). A move to another tab loads the
// screen again.
export function SourceDetailView({ client, id, path }: { client: ApiClient; id: string; path: string }) {
  const tab = sourceTabOf(searchParams(path));
  const [state, reload] = useView(() => loadSourceDetail(client, id), `source:${id}`);
  // The result of the last operation, kept across the reload that follows.
  const [notice, setNotice] = useState<string | null>(null);
  // The plain key just issued. Kept only in memory, until the screen is left.
  const [issued, setIssued] = useState<{ keyId: string; key: string } | null>(null);
  useDocumentTitle(viewTitle(state, (data) => data.source.name));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage={GONE_MESSAGE} onReload={reload} />;
  }
  const { source, apiKeys, emailAddresses } = state.data;
  const onDone = (message: string | null) => {
    setNotice(message);
    reload();
  };

  return (
    <main className="main">
      <p className="breadcrumb">
        <Link to="/sources">送信元</Link>
      </p>
      <header className="page-head">
        <div className="page-head-title">
          <h1>{source.name}</h1>
          <span className={source.enabled ? "badge badge-ok" : "badge badge-off"}>{source.enabled ? "有効" : "無効"}</span>
        </div>
        <p className="lead">この送信元から受け取ったイベントは、紐づけた Bot の配信先に届きます。</p>
      </header>
      <nav className="filter-tabs" aria-label="送信元の表示">
        {SOURCE_TABS.map((item) => (
          <Link
            key={item.tab}
            to={sourceTabPath(source.id, item.tab)}
            className="filter-tab"
            aria-current={item.tab === tab ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {tab === "overview" && (
        <>
          <SourceBots client={client} sourceId={source.id} />
          <SourceEvents client={client} sourceId={source.id} />
        </>
      )}

      {tab === "settings" && (
        <>
          <SourceSettings client={client} source={source} onDone={onDone} />
          <ConversationStartSection client={client} source={source} onDone={onDone} />
        </>
      )}

      {tab === "intake" && (
        <>
          <h2>送信元 ID（Service Bindings 用）</h2>
          <p>
            同じ Cloudflare アカウントの Worker から送るときは、バインディングの <code>props</code> に次の送信元 ID を指定します。
          </p>
          <CopyableId id={source.id} />

          <h2>API キー</h2>
          <p>
            HTTP（<code>POST /ingest/v1/events</code>）で送るときに <code>Authorization: Bearer</code> ヘッダーで使います。
          </p>
          {issued !== null && (
            <div className="issued-key" role="status">
              <p>
                <strong>API キーを発行しました。このキーは今だけ表示されます。この画面を離れると二度と表示されません。</strong>
                安全な場所に保存してください。
              </p>
              <p className="copyable">
                <code>{issued.key}</code>
              </p>
              <button type="button" onClick={() => setIssued(null)}>
                保存したので閉じる
              </button>
            </div>
          )}
          <IssueKeyButton
            client={client}
            sourceId={source.id}
            onIssued={(keyId, key) => {
              setNotice(null);
              setIssued({ keyId, key });
              reload();
            }}
            onGone={() => onDone(GONE_MESSAGE)}
          />
          {apiKeys.length === 0 ? (
            <p className="muted">API キーはまだありません。</p>
          ) : (
            <ul className="list api-keys">
              {apiKeys.map((apiKey) => (
                <ApiKeyRow key={apiKey.key_id} client={client} sourceId={source.id} apiKey={apiKey} onDone={onDone} />
              ))}
            </ul>
          )}

          <h2>会話を始める</h2>
          {source.conversation_start.enabled ? (
            <>
              <p>
                HTTP（<code>POST /ingest/v1/conversations</code>）で、Bot を指定して会話を始められます。API
                キーはイベントと同じものを使います。
              </p>
              {/* data-preview: a long command scrolls inside its box instead of widening the page. */}
              <div className="data-preview">
                <pre>{conversationCurlExample(window.location.origin)}</pre>
              </div>
            </>
          ) : (
            <p className="muted">設定で会話の開始を許可すると、会話を始める API の例が出ます</p>
          )}

          <h2>メールアドレス</h2>
          {emailAddresses.email_domain === null ? (
            <p className="muted">
              メールでの受付は設定されていません。README の『メールでの受付』を参照して <code>EMAIL_DOMAIN</code>{" "}
              を設定してください。
            </p>
          ) : (
            <>
              <p>メールで送るときの宛先です。届いたメールはこの送信元のイベントとして受け付けます。</p>
              <IssueEmailAddressButton
                client={client}
                sourceId={source.id}
                onIssued={() => onDone("メールアドレスを発行しました")}
                onGone={() => onDone(GONE_MESSAGE)}
              />
              {emailAddresses.email_addresses.length === 0 ? (
                <p className="muted">メールアドレスはまだありません。</p>
              ) : (
                <ul className="list api-keys email-addresses">
                  {emailAddresses.email_addresses.map((emailAddress) => (
                    <EmailAddressRow
                      key={emailAddress.local_part}
                      client={client}
                      sourceId={source.id}
                      emailAddress={emailAddress}
                      onDone={onDone}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}

// The bots linked to the source, which its events reach. A failure is shown in this section only.
function SourceBots({ client, sourceId }: { client: ApiClient; sourceId: string }) {
  const [state] = useView(() => loadSourceBots(client, sourceId), `source-bots:${sourceId}`);
  return (
    <section className="source-section" aria-labelledby="source-bots">
      <div className="section-head">
        <h2 id="source-bots">受け取る Bot</h2>
      </div>
      <SourceBotsBody state={state} />
    </section>
  );
}

function SourceBotsBody({ state }: { state: ViewState<Bot[]> }) {
  switch (state.kind) {
    case "loading":
      return <p className="muted">読み込み中…</p>;
    case "redirecting":
      return null;
    case "notFound":
      return <p role="alert">Bot を読み込めませんでした</p>;
    case "error":
      return <p role="alert">{state.message}</p>;
    case "ready":
      return state.data.length === 0 ? (
        <>
          <div className="callout">
            <p className="warning-note">どの Bot にも紐づいていないため、イベントは届きません</p>
            <Link to="/bots" className="button button-primary">
              Bot 画面で紐づける
            </Link>
          </div>
        </>
      ) : (
        <ul className="list source-bots">
          {state.data.map((bot) => (
            <li key={bot.id}>
              <Link to={botPath(bot.id)} className="source-link">
                <span className="source-name">{bot.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      );
  }
}

// The newest events of the source. A failure is shown in this section only.
function SourceEvents({ client, sourceId }: { client: ApiClient; sourceId: string }) {
  const [state] = useView(() => loadEvents(client, undefined, { type: "", sourceId }), `source-events:${sourceId}`);
  return (
    <section className="source-section" aria-labelledby="source-events">
      <div className="section-head">
        <h2 id="source-events">最近のイベント</h2>
        <Link to={eventsPath({ type: "", sourceId })}>すべて見る</Link>
      </div>
      <SourceEventsBody state={state} />
    </section>
  );
}

function SourceEventsBody({ state }: { state: ViewState<EventList> }) {
  switch (state.kind) {
    case "loading":
      return <p className="muted">読み込み中…</p>;
    case "redirecting":
      return null;
    case "notFound":
      return <p role="alert">イベントを読み込めませんでした</p>;
    case "error":
      return <p role="alert">{state.message}</p>;
    case "ready":
      return state.data.events.length === 0 ? (
        <p className="empty-note">まだイベントはありません。</p>
      ) : (
        <ul className="list events">
          {state.data.events.slice(0, RECENT_EVENTS).map((event) => (
            <EventRow key={event.event_id} event={event} hideSource />
          ))}
        </ul>
      );
  }
}

function resultMessage(result: Exclude<SourceActionResult, { kind: "ok" }>, gone: string): string | null {
  switch (result.kind) {
    case "notFound":
      return gone;
    case "error":
      return result.message;
    case "unknown":
      return UNKNOWN_RESULT_MESSAGE;
    case "redirecting":
      return null;
  }
}

function SourceSettings({
  client,
  source,
  onDone,
}: {
  client: ApiClient;
  source: Source;
  onDone: (message: string | null) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(source.name);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(input: { name?: string; enabled?: boolean }, success: string) {
    setSending(true);
    setFailure(null);
    const result = await updateSource(client, source.id, input);
    if (result.kind === "redirecting") return;
    setSending(false);
    if (result.kind === "ok") {
      setRenaming(false);
      onDone(success);
      return;
    }
    if (result.kind === "notFound") {
      onDone(GONE_MESSAGE);
      return;
    }
    setFailure(resultMessage(result, GONE_MESSAGE));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run({ name }, "名前を変更しました");
  }

  return (
    <>
      <dl className="details">
        <dt>状態</dt>
        <dd>
          <span className={source.enabled ? "badge badge-ok" : "badge badge-off"}>{source.enabled ? "有効" : "無効"}</span>
          {!source.enabled && <span className="muted">（HTTP・Service Bindings・メールのいずれからも受け付けません）</span>}
        </dd>
        <dt>作成日時</dt>
        <dd>{formatDateTime(source.created_at)}</dd>
      </dl>
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            setRenaming(true);
            setName(source.name);
            setFailure(null);
          }}
          disabled={sending}
        >
          名前を変更
        </button>
        <button
          type="button"
          onClick={() =>
            void run(
              { enabled: !source.enabled },
              source.enabled ? "送信元を無効にしました" : "送信元を有効にしました",
            )
          }
          disabled={sending}
        >
          {source.enabled ? "無効にする" : "有効にする"}
        </button>
      </div>
      {renaming && (
        <form className="folder-form" aria-label="名前を変更" onSubmit={onSubmit}>
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
          <div className="folder-form-actions">
            <button type="submit" disabled={sending}>
              変更
            </button>
            <button type="button" onClick={() => setRenaming(false)} disabled={sending}>
              やめる
            </button>
          </div>
        </form>
      )}
      {failure !== null && <p role="alert">{failure}</p>}
    </>
  );
}

// Whether the source may start conversations with bots, and its limits.
function ConversationStartSection({
  client,
  source,
  onDone,
}: {
  client: ApiClient;
  source: Source;
  onDone: (message: string | null) => void;
}) {
  const [form, setForm] = useState(() => conversationStartForm(source));
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = conversationStartRequest(source, form);
    if (!request.ok) {
      setFailure(request.message);
      return;
    }
    setSending(true);
    setFailure(null);
    const result = await updateSourceConversationStart(client, source.id, request.value);
    if (result.kind === "redirecting") return;
    setSending(false);
    if (result.kind === "ok") {
      onDone("会話の開始の設定を保存しました");
      return;
    }
    if (result.kind === "notFound") {
      onDone(GONE_MESSAGE);
      return;
    }
    setFailure(resultMessage(result, GONE_MESSAGE));
  }

  return (
    <section className="source-section" aria-labelledby="source-conversation-start">
      <div className="section-head">
        <h2 id="source-conversation-start">会話の開始</h2>
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
            <span className="choice-title">この送信元から会話を始めることを許可する</span>
            <span className="choice-description">
              許可すると、この送信元の API キーか Service Bindings で、Bot を指定して会話を始められます。会話に参加する
              AI の利用料が増えることがあります
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

function IssueKeyButton({
  client,
  sourceId,
  onIssued,
  onGone,
}: {
  client: ApiClient;
  sourceId: string;
  onIssued: (keyId: string, key: string) => void;
  onGone: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function issue() {
    setSending(true);
    setFailure(null);
    const result = await issueApiKey(client, sourceId);
    switch (result.kind) {
      case "ok":
        setSending(false);
        onIssued(result.apiKey.key_id, result.key);
        return;
      case "notFound":
        setSending(false);
        onGone();
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
    <div className="actions">
      <button type="button" className="button-primary" onClick={() => void issue()} disabled={sending}>
        <PlusIcon />
        API キーを発行
      </button>
      {failure !== null && <p role="alert">{failure}</p>}
    </div>
  );
}

function ApiKeyRow({
  client,
  sourceId,
  apiKey,
  onDone,
}: {
  client: ApiClient;
  sourceId: string;
  apiKey: ApiKey;
  onDone: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const revoked = apiKey.revoked_at !== null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await revokeApiKey(client, sourceId, apiKey.key_id);
    if (result.kind === "redirecting") return;
    setSending(false);
    if (result.kind === "ok") {
      setConfirming(false);
      onDone(`API キー ${apiKey.key_id} を失効させました`);
      return;
    }
    if (result.kind === "notFound") {
      setConfirming(false);
      onDone(KEY_GONE_MESSAGE);
      return;
    }
    setFailure(resultMessage(result, KEY_GONE_MESSAGE));
  }

  return (
    <li className={revoked ? "api-key api-key-revoked" : "api-key"}>
      <div className="api-key-head">
        <code className="api-key-id">{apiKey.key_id}</code>
        {revoked && <span className="badge badge-off">失効済み</span>}
        {!revoked && (
          <button
            type="button"
            className="button-danger-outline"
            onClick={() => {
              setConfirming(true);
              setFailure(null);
            }}
            disabled={sending}
          >
            失効させる…
          </button>
        )}
      </div>
      <div className="api-key-meta">
        <span>作成: {formatDateTime(apiKey.created_at)}</span>
        <span>最終使用: {apiKey.last_used_at === null ? "未使用" : formatDateTime(apiKey.last_used_at)}</span>
        {apiKey.revoked_at !== null && <span>失効: {formatDateTime(apiKey.revoked_at)}</span>}
      </div>
      {confirming && (
        <form className="folder-form" aria-label="API キーを失効" onSubmit={(event) => void onSubmit(event)}>
          <p>
            API キー <code>{apiKey.key_id}</code> を失効させます。このキーを使っている送信は 401 になります。元に戻せません。
          </p>
          <div className="folder-form-actions">
            <button type="submit" className="button-danger" disabled={sending}>
              失効させる
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

function IssueEmailAddressButton({
  client,
  sourceId,
  onIssued,
  onGone,
}: {
  client: ApiClient;
  sourceId: string;
  onIssued: () => void;
  onGone: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function issue() {
    setSending(true);
    setFailure(null);
    const result = await issueEmailAddress(client, sourceId);
    switch (result.kind) {
      case "ok":
        setSending(false);
        onIssued();
        return;
      case "notFound":
        setSending(false);
        onGone();
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
    <div className="actions">
      <button type="button" className="button-primary" onClick={() => void issue()} disabled={sending}>
        <PlusIcon />
        メールアドレスを発行
      </button>
      {failure !== null && <p role="alert">{failure}</p>}
    </div>
  );
}

function EmailAddressRow({
  client,
  sourceId,
  emailAddress,
  onDone,
}: {
  client: ApiClient;
  sourceId: string;
  emailAddress: EmailAddress;
  onDone: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const revoked = emailAddress.revoked_at !== null;
  // The domain is set whenever the list is shown; the local part is the fallback.
  const shown = emailAddress.address ?? emailAddress.local_part;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await revokeEmailAddress(client, sourceId, emailAddress.local_part);
    if (result.kind === "redirecting") return;
    setSending(false);
    if (result.kind === "ok") {
      setConfirming(false);
      onDone("メールアドレスを無効にしました");
      return;
    }
    if (result.kind === "notFound") {
      setConfirming(false);
      onDone(ADDRESS_GONE_MESSAGE);
      return;
    }
    setFailure(resultMessage(result, ADDRESS_GONE_MESSAGE));
  }

  return (
    <li className={revoked ? "api-key api-key-revoked" : "api-key"}>
      <div className="api-key-head">
        <code className="api-key-id email-address">{shown}</code>
        <span className={revoked ? "badge badge-off" : "badge badge-ok"}>{revoked ? "無効化済み" : "有効"}</span>
        {!revoked && (
          <button
            type="button"
            className="button-danger-outline"
            onClick={() => {
              setConfirming(true);
              setFailure(null);
            }}
            disabled={sending}
          >
            無効化する…
          </button>
        )}
      </div>
      <div className="api-key-meta">
        <span>作成: {formatDateTime(emailAddress.created_at)}</span>
        <span>
          最終受信: {emailAddress.last_received_at === null ? "未受信" : formatDateTime(emailAddress.last_received_at)}
        </span>
        {emailAddress.revoked_at !== null && <span>無効化: {formatDateTime(emailAddress.revoked_at)}</span>}
      </div>
      {confirming && (
        <form className="folder-form" aria-label="メールアドレスを無効にする" onSubmit={(event) => void onSubmit(event)}>
          <p>
            メールアドレス <code>{shown}</code> を無効にします。このアドレス宛てのメールは受け付けなくなります。元に戻せません。
          </p>
          <div className="folder-form-actions">
            <button type="submit" className="button-danger" disabled={sending}>
              無効にする
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
