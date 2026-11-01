import { type FormEvent, useState } from "react";
import { createSource } from "../actions";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadSources, useView } from "../load";
import { navigate } from "../router";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";

export const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。読み込み直して確かめてください";

// The sources of the signed-in user's workspace, with the form to create one.
export function SourcesView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadSources(client), "sources");
  useDocumentTitle(viewTitle(state, () => "送信元"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const sources = state.data;

  return (
    <main className="main">
      <h1>送信元</h1>
      <p className="lead">
        イベントを送るプログラムです。送信元ごとにAPIキーを発行するか、Service Bindingsで送信元IDを指定して送ります。
      </p>
      <CreateSourceForm client={client} />
      {sources.length === 0 ? (
        <p className="notice">送信元はまだありません。</p>
      ) : (
        <ul className="list sources">
          {sources.map((source) => (
            <li key={source.id}>
              <Link to={`/sources/${source.id}`} className="source-link">
                <span className="source-head">
                  <span className="source-name">{source.name}</span>
                  <span className={source.enabled ? "badge" : "badge badge-off"}>{source.enabled ? "有効" : "無効"}</span>
                </span>
                <span className="source-meta">
                  <span>有効なAPIキー {source.active_key_count} 個</span>
                  <time dateTime={new Date(source.created_at).toISOString()}>作成: {formatDateTime(source.created_at)}</time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function CreateSourceForm({ client }: { client: ApiClient }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [name, setName] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await createSource(client, name);
    switch (result.kind) {
      case "ok":
        // Straight to the new source, where its keys are issued.
        navigate(`/sources/${result.source.id}`);
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
            setName("");
            setFailure(null);
          }}
        >
          <PlusIcon />
          送信元を作成
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="送信元を作成" onSubmit={(event) => void onSubmit(event)}>
      <label>
        名前（64&nbsp;文字以内。ワークスペース内で重複できません）
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
          作成
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}
