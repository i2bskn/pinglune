import { type FormEvent, useState } from "react";
import type { ApiKey, EmailAddress, Source } from "../../../src/api/types";
import {
  type SourceActionResult,
  issueApiKey,
  issueEmailAddress,
  revokeApiKey,
  revokeEmailAddress,
  updateSource,
} from "../actions";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadSourceDetail, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const GONE_MESSAGE = "この送信元は見つかりません";
const KEY_GONE_MESSAGE = "このAPIキーは見つかりません";
const ADDRESS_GONE_MESSAGE = "このメールアドレスは見つかりません";

// One source: rename, enable or disable, its ID for Service Bindings, its API keys and its email addresses.
export function SourceDetailView({ client, id }: { client: ApiClient; id: string }) {
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

  return (
    <main className="main">
      <p className="breadcrumb">
        <Link to="/sources">送信元</Link>
      </p>
      <h1>{source.name}</h1>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <SourceSettings
        client={client}
        source={source}
        onDone={(message) => {
          setNotice(message);
          reload();
        }}
      />

      <h2>Service Bindings</h2>
      <p>
        同じCloudflareアカウントのWorkerから送るときは、バインディングの <code>props</code> に次の送信元IDを指定します。
      </p>
      <p className="copyable">
        <code>{source.id}</code>
      </p>

      <h2>APIキー</h2>
      <p>
        HTTP（<code>POST /ingest/v1/events</code>）で送るときに <code>Authorization: Bearer</code> ヘッダーで使います。
      </p>
      {issued !== null && (
        <div className="issued-key" role="status">
          <p>
            <strong>APIキーを発行しました。このキーは今だけ表示されます。この画面を離れると二度と表示されません。</strong>
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
        onGone={() => {
          setNotice(GONE_MESSAGE);
          reload();
        }}
      />
      {apiKeys.length === 0 ? (
        <p className="muted">APIキーはまだありません。</p>
      ) : (
        <ul className="list api-keys">
          {apiKeys.map((apiKey) => (
            <ApiKeyRow
              key={apiKey.key_id}
              client={client}
              sourceId={source.id}
              apiKey={apiKey}
              onDone={(message) => {
                setNotice(message);
                reload();
              }}
            />
          ))}
        </ul>
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
            onIssued={() => {
              setNotice("メールアドレスを発行しました");
              reload();
            }}
            onGone={() => {
              setNotice(GONE_MESSAGE);
              reload();
            }}
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
                  onDone={(message) => {
                    setNotice(message);
                    reload();
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
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
          <span className={source.enabled ? "badge" : "badge badge-off"}>{source.enabled ? "有効" : "無効"}</span>
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
        APIキーを発行
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
      onDone(`APIキー ${apiKey.key_id} を失効させました`);
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
        {revoked && <span className="badge badge-off">失効</span>}
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
            失効
          </button>
        )}
      </div>
      <div className="api-key-meta">
        <span>作成: {formatDateTime(apiKey.created_at)}</span>
        <span>最終使用: {apiKey.last_used_at === null ? "未使用" : formatDateTime(apiKey.last_used_at)}</span>
        {apiKey.revoked_at !== null && <span>失効: {formatDateTime(apiKey.revoked_at)}</span>}
      </div>
      {confirming && (
        <form className="folder-form" aria-label="APIキーを失効" onSubmit={(event) => void onSubmit(event)}>
          <p>
            APIキー <code>{apiKey.key_id}</code> を失効させます。このキーを使っている送信は 401 になります。元に戻せません。
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
        <span className={revoked ? "badge badge-off" : "badge"}>{revoked ? "無効化済み" : "有効"}</span>
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
            無効にする
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
