import { Fragment, type SyntheticEvent, useEffect, useRef, useState } from "react";
import type {
  DeliveryList as DeliveryListData,
  DeliveryListItem,
  EmailAttachment,
  EmailView,
  EventData,
  ManagedEventDetail,
} from "../../../src/api/types";
import { type ScreeningActionResult, releaseEvent, retryScreening } from "../actions";
import { type EmailBodyMode, attachmentPreview, defaultBodyMode, isEmailEvent, revealBidiControls } from "../email";
import { previewKind, previewText } from "../events";
import { formatBytes, formatDateTime, keepNumbersWithUnits } from "../format";
import { Link } from "../Link";
import {
  type ApiClient,
  type ViewState,
  fetchEventData,
  loadDeliveries,
  loadEmailHtml,
  loadEmailView,
  loadEventDetail,
  useView,
} from "../load";
import {
  SCREENING_BADGE_CLASSES,
  SCREENING_STATUS_LABELS,
  canRetryScreening,
  hasUnsentDeliveries,
  screeningReason,
} from "../screening";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { DeliveryList } from "./DeliveryHistoryView";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const PREVIEW_FAILED_MESSAGE = "プレビューを読み込めませんでした";
// How long a downloaded file's object URL is kept: long enough for the browser to start saving it.
const OBJECT_URL_LIFETIME_MS = 60_000;

export function EventLabels({ labels }: { labels: Record<string, string> }) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return null;
  return (
    <ul className="labels" aria-label="ラベル">
      {entries.map(([key, value]) => (
        <li key={key} className="label">
          <span className="label-key">{key}</span>
          <span className="label-value">{value}</span>
        </li>
      ))}
    </ul>
  );
}

// One event: its metadata, its screening, labels, its data (downloaded, and shown when it is safe and small) and its
// deliveries.
export function EventDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadEventDetail(client, id), `event:${id}`);
  // The result of the last operation, kept across the reload that follows.
  const [notice, setNotice] = useState<string | null>(null);
  // Counts the reloads after an operation, so that the email view is read again with the event.
  const [reloads, setReloads] = useState(0);
  useDocumentTitle(viewTitle(state, (event) => event.type));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="イベントが見つかりません" onReload={reload} />;
  }
  return (
    <EventDetailContent
      client={client}
      event={state.data}
      notice={notice}
      loadKey={`${id}:${reloads}`}
      onDone={(message) => {
        setNotice(message);
        setReloads((n) => n + 1);
        reload();
      }}
    />
  );
}

function EventDetailContent({
  client,
  event,
  notice,
  loadKey,
  onDone,
}: {
  client: ApiClient;
  event: ManagedEventDetail;
  notice: string | null;
  // Changes when the event is read again after an operation.
  loadKey: string;
  onDone: (message: string | null) => void;
}) {
  // Read once for both the deliveries and the screening panel (whether deliveries are left unsent).
  const [deliveries] = useView(() => loadDeliveries(client, { eventId: event.event_id }), `deliveries:${event.event_id}`);
  const email = isEmailEvent(event);
  // A held or pending email is checked by reading the email view: the screening comes above it.
  const screeningFirst = email && (event.screening?.status === "held" || event.screening?.status === "pending");
  const screeningPanel = (
    <ScreeningPanel
      client={client}
      event={event}
      deliveries={deliveries.kind === "ready" ? deliveries.data.deliveries : null}
      releaseCheck={email ? "下のメールの内容を確かめてから解除してください" : "下のデータで内容を確かめてから解除してください"}
      onDone={onDone}
    />
  );
  return (
    <main className="main">
      <p className="breadcrumb">
        <Link to="/events">イベント</Link>
      </p>
      <header className="page-head">
        <p className="event-title-type">
          <span className="event-type">{event.type}</span>
        </p>
        <h1 className="event-title event-detail-summary">
          {keepNumbersWithUnits(email ? revealBidiControls(event.summary) : event.summary)}
        </h1>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {screeningFirst && screeningPanel}
      {email && (
        <>
          <EmailSection client={client} eventId={event.event_id} loadKey={loadKey} />
          <h2 className="email-detail-heading">イベントの詳細</h2>
        </>
      )}
      {!screeningFirst && screeningPanel}
      <dl className="details">
        <dt>イベントID</dt>
        <dd>
          <code>{event.event_id}</code>
        </dd>
        {event.conversation_id === null ? (
          <>
            <dt>送信元</dt>
            <dd>
              <Link to={`/sources/${event.source.id}`}>{event.source.name}</Link>
            </dd>
          </>
        ) : (
          <>
            <dt>会話</dt>
            <dd>
              <Link to={`/conversations/${event.conversation_id}`}>会話を開く</Link>
            </dd>
          </>
        )}
        <dt>発生日時</dt>
        <dd>
          <time dateTime={new Date(event.occurred_at).toISOString()}>{formatDateTime(event.occurred_at)}</time>
        </dd>
        <dt>受付日時</dt>
        <dd>
          <time dateTime={new Date(event.received_at).toISOString()}>{formatDateTime(event.received_at)}</time>
        </dd>
      </dl>

      <h2>ラベル</h2>
      {Object.keys(event.labels).length === 0 ? <p className="muted">ラベルはありません</p> : <EventLabels labels={event.labels} />}

      <h2>データ</h2>
      {event.data.length === 0 ? (
        <p className="muted">本文・添付はありません</p>
      ) : (
        <ul className="list data-list">
          {event.data.map((data) => (
            <DataItem key={data.data_ref} client={client} eventId={event.event_id} data={data} openBody={!email} />
          ))}
        </ul>
      )}

      <h2>配信</h2>
      <EventDeliveries client={client} state={deliveries} />
    </main>
  );
}

// The screening of the event (src/screening/): its state, the score or the reason, and the operations. A held event
// is released only after a confirmation here.
function ScreeningPanel({
  client,
  event,
  deliveries,
  releaseCheck,
  onDone,
}: {
  client: ApiClient;
  event: ManagedEventDetail;
  // null while they are loading or could not be read.
  deliveries: DeliveryListItem[] | null;
  // Where to check the contents before releasing it.
  releaseCheck: string;
  onDone: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const screening = event.screening;
  if (screening === null) return null;
  const reason = screeningReason(screening);
  const canRetry = canRetryScreening(screening, Date.now());
  const canRedeliver = screening.status === "released" && deliveries !== null && hasUnsentDeliveries(deliveries);

  async function run(action: () => Promise<ScreeningActionResult>, success: string) {
    setSending(true);
    setFailure(null);
    const result = await action();
    if (result.kind === "redirecting") return;
    setSending(false);
    if (result.kind === "ok") {
      setConfirming(false);
      onDone(success);
      return;
    }
    if (result.kind === "notFound") {
      onDone("イベントが見つかりません");
      return;
    }
    setFailure(result.kind === "error" ? result.message : UNKNOWN_RESULT_MESSAGE);
  }

  return (
    <section className="screening-panel" aria-labelledby="event-screening">
      <h2 id="event-screening">AIへの指示の判定</h2>
      <p>
        <span className={SCREENING_BADGE_CLASSES[screening.status]}>{SCREENING_STATUS_LABELS[screening.status]}</span>
        {reason !== null && <span className="muted">（{reason}）</span>}
      </p>
      {screening.status === "held" && (
        <p>AI への指示を含むか、判定できなかったため保留しています。Bot には配信されず、MCP からも読めません。</p>
      )}
      {screening.status === "pending" && <p>判定が終わるまで、Bot には配信されず、MCP からも読めません。</p>}
      <dl className="details">
        {screening.requested_at !== null && (
          <>
            <dt>判定の依頼</dt>
            <dd>{formatDateTime(screening.requested_at)}</dd>
          </>
        )}
        {screening.screened_at !== null && (
          <>
            <dt>判定日時</dt>
            <dd>{formatDateTime(screening.screened_at)}</dd>
          </>
        )}
        {screening.released_at !== null && (
          <>
            <dt>解除日時</dt>
            <dd>{formatDateTime(screening.released_at)}</dd>
          </>
        )}
      </dl>
      {!confirming && (screening.status === "held" || canRetry || canRedeliver) && (
        <div className="actions">
          {screening.status === "held" && (
            <button
              type="button"
              className="button-primary"
              onClick={() => {
                setConfirming(true);
                setFailure(null);
              }}
              disabled={sending}
            >
              保留を解除して配信する…
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={() => void run(() => retryScreening(client, event.event_id), "判定し直しています")}
              disabled={sending}
            >
              判定し直す
            </button>
          )}
          {canRedeliver && (
            <button
              type="button"
              onClick={() => void run(() => releaseEvent(client, event.event_id), "配信をやり直しました")}
              disabled={sending}
            >
              配信をやり直す
            </button>
          )}
        </div>
      )}
      {confirming && (
        <form
          className="folder-form"
          aria-label="保留を解除"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void run(() => releaseEvent(client, event.event_id), "保留を解除して配信しました");
          }}
        >
          <p>
            このイベントを Bot の配信先に配信し、MCP から読めるようにします。{releaseCheck}。元に戻せません。
          </p>
          <div className="folder-form-actions">
            <button type="submit" className="button-primary" disabled={sending}>
              解除して配信する
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={sending}>
              やめる
            </button>
          </div>
        </form>
      )}
      {failure !== null && <p role="alert">{failure}</p>}
    </section>
  );
}

// The result of reading a data item, through the API client so that an expired access token is refreshed. null while
// the move to the login page has started: nothing is shown then.
async function readData(
  client: ApiClient,
  eventId: string,
  dataRef: string,
): Promise<{ kind: "ok"; blob: Blob } | { kind: "error"; message: string } | null> {
  const result = await fetchEventData(client, eventId, dataRef);
  return result.kind === "redirecting" ? null : result;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("no data URL")));
    reader.onerror = () => reject(reader.error ?? new Error("reading failed"));
    reader.readAsDataURL(blob);
  });
}

// Downloads a data item as a file of its name. Shared by the data list and the attachments of the email view.
function useDownload(
  client: ApiClient,
  eventId: string,
  data: Pick<EventData, "data_ref" | "name">,
): { downloading: boolean; failure: string | null; download: () => Promise<void> } {
  const [downloading, setDownloading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function download() {
    setDownloading(true);
    setFailure(null);
    const result = await readData(client, eventId, data.data_ref);
    if (result === null) return;
    setDownloading(false);
    if (result.kind === "error") {
      setFailure(result.message);
      return;
    }
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = data.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
  }

  return { downloading, failure, download };
}

// One body or attachment: its name, type and size, a download button and, for small text, JSON and images, a preview.
// openBody: the preview of the body is open from the start.
function DataItem({
  client,
  eventId,
  data,
  openBody,
}: {
  client: ApiClient;
  eventId: string;
  data: EventData;
  openBody: boolean;
}) {
  const { downloading, failure, download } = useDownload(client, eventId, data);
  const kind = previewKind(data);
  const name = data.role === "body" ? "本文" : data.name;

  return (
    <li>
      <span className="data-head">
        <span className="data-name">{name}</span>
        <button type="button" className="data-download" onClick={() => void download()} disabled={downloading}>
          {downloading ? "読み込み中…" : "ダウンロード"}
        </button>
      </span>
      <span className="data-meta">
        <span>{data.content_type}</span>
        <span>{formatBytes(data.size)}</span>
      </span>
      {failure !== null && <p role="alert">{failure}</p>}
      {(kind === "text" || kind === "json") && (
        <TextPreview
          client={client}
          eventId={eventId}
          data={data}
          kind={kind}
          initiallyOpen={openBody && data.role === "body"}
        />
      )}
      {kind === "image" && <ImagePreview client={client} eventId={eventId} data={data} />}
    </li>
  );
}

type PreviewState = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; value: string } | { kind: "error" };

// Text and JSON, read when the details is first opened (the body's is open from the start).
function TextPreview({
  client,
  eventId,
  data,
  kind,
  initiallyOpen,
  label = "中身を表示",
}: {
  client: ApiClient;
  eventId: string;
  data: Pick<EventData, "data_ref">;
  kind: "text" | "json";
  initiallyOpen: boolean;
  label?: string;
}) {
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const started = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (initiallyOpen) void load();
    return () => {
      mounted.current = false;
    };
    // Loaded once; load reads the props of this data item, which do not change.
  }, []);

  async function load() {
    if (started.current) return;
    started.current = true;
    setState({ kind: "loading" });
    const result = await readData(client, eventId, data.data_ref);
    if (!mounted.current || result === null) return;
    if (result.kind === "error") {
      setState({ kind: "error" });
      return;
    }
    try {
      const text = await result.blob.text();
      if (mounted.current) setState({ kind: "ready", value: previewText(kind, text) });
    } catch {
      if (mounted.current) setState({ kind: "error" });
    }
  }

  function onToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open) void load();
  }

  return (
    <details className="data-preview" open={initiallyOpen} onToggle={onToggle}>
      <summary>{label}</summary>
      {state.kind === "loading" && <p className="muted">読み込み中…</p>}
      {state.kind === "error" && <p role="alert">{PREVIEW_FAILED_MESSAGE}</p>}
      {state.kind === "ready" && <pre>{state.value}</pre>}
    </details>
  );
}

// An image of up to IMAGE_PREVIEW_MAX_BYTES, read when the screen is shown and put into a data: URL (the CSP allows
// img-src data:, and the API URL itself is never put into the page).
function ImagePreview({
  client,
  eventId,
  data,
}: {
  client: ApiClient;
  eventId: string;
  data: Pick<EventData, "data_ref" | "name">;
}) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await readData(client, eventId, data.data_ref);
      if (cancelled || result === null) return;
      if (result.kind === "error") {
        setState({ kind: "error" });
        return;
      }
      try {
        const url = await readAsDataUrl(result.blob);
        if (!cancelled) setState({ kind: "ready", value: url });
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, data.data_ref]);

  switch (state.kind) {
    case "idle":
    case "loading":
      return <p className="muted">画像を読み込み中…</p>;
    case "error":
      return <p role="alert">{PREVIEW_FAILED_MESSAGE}</p>;
    case "ready":
      return <img className="data-image" src={state.value} alt={data.name} loading="lazy" />;
  }
}

// An image previewed only once its details is opened.
function LazyImagePreview({
  client,
  eventId,
  data,
}: {
  client: ApiClient;
  eventId: string;
  data: Pick<EventData, "data_ref" | "name">;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className="data-preview"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>プレビュー</summary>
      {opened && <ImagePreview client={client} eventId={eventId} data={data} />}
    </details>
  );
}

// The email view of an email.received event, above the event detail: the source, the header lines, the body and the
// attachments. Everything the sender wrote is shown as text, never as HTML. A failure here leaves the rest of the
// screen as it is.
function EmailSection({ client, eventId, loadKey }: { client: ApiClient; eventId: string; loadKey: string }) {
  const [state, reload] = useView(() => loadEmailView(client, eventId), `email:${loadKey}`);
  switch (state.kind) {
    case "loading":
      return <ViewStatus state={state} notFoundMessage="" onReload={reload} />;
    case "redirecting":
      return null;
    case "notFound":
    case "error":
      return (
        <section className="email-error" role="alert">
          <h2>メールの表示を読み込めませんでした</h2>
          <p>{state.kind === "error" ? state.message : "メールが見つかりません"}</p>
          <button type="button" onClick={reload}>
            再読み込み
          </button>
        </section>
      );
    case "ready":
      return <EmailContent client={client} view={state.data} loadKey={loadKey} />;
  }
}

function EmailContent({ client, view, loadKey }: { client: ApiClient; view: EmailView; loadKey: string }) {
  const { headers } = view;
  const optional: [string, string | null][] = [
    ["宛先（To）", headers.to],
    ["Cc", headers.cc],
    ["返信先（Reply-To）", headers.reply_to],
    ["日時（Date）", headers.date],
    ["Message-ID", headers.message_id],
  ];
  return (
    <section className="email-view" aria-label="メール">
      <p className="email-source">
        送信元: <Link to={`/sources/${view.source.id}`}>{view.source.name}</Link>
      </p>
      <dl className="details email-headers">
        <dt>差出人（From のアドレス）</dt>
        <dd className="email-from">
          {view.from_address !== null ? (
            <>
              <strong>{revealBidiControls(view.from_address)}</strong>
              {headers.from !== null && (
                <span className="email-from-raw">メールの表記: {revealBidiControls(headers.from)}</span>
              )}
            </>
          ) : headers.from !== null ? (
            revealBidiControls(headers.from)
          ) : (
            "不明"
          )}
        </dd>
        {optional.map(
          ([label, value]) =>
            value !== null && (
              <Fragment key={label}>
                <dt>{label}</dt>
                <dd>{revealBidiControls(value)}</dd>
              </Fragment>
            ),
        )}
      </dl>

      <EmailBody client={client} view={view} loadKey={loadKey} />

      <h2>添付（{view.attachments.length} 件）</h2>
      {view.attachments.length === 0 ? (
        <p className="muted">添付はありません</p>
      ) : (
        <ul className="email-attachments">
          {view.attachments.map((attachment) => (
            <EmailAttachmentItem
              key={attachment.data_ref}
              client={client}
              eventId={view.event_id}
              attachment={attachment}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// The text of the body, or the HTML body converted to text (read when it is first shown).
function EmailBody({ client, view, loadKey }: { client: ApiClient; view: EmailView; loadKey: string }) {
  const [mode, setMode] = useState<EmailBodyMode>(() => defaultBodyMode(view));
  // Kept once shown, so that switching back and forth does not read it again.
  const [htmlShown, setHtmlShown] = useState(mode === "html");

  function choose(next: EmailBodyMode) {
    setMode(next);
    if (next === "html") setHtmlShown(true);
  }

  return (
    <>
      <h2>本文</h2>
      {view.html !== null && (
        <div className="filter-tabs" role="group" aria-label="本文の表示">
          <button type="button" className="filter-tab" aria-pressed={mode === "text"} onClick={() => choose("text")}>
            テキスト
          </button>
          <button type="button" className="filter-tab" aria-pressed={mode === "html"} onClick={() => choose("html")}>
            HTML
          </button>
        </div>
      )}
      <div hidden={mode !== "text"}>
        {view.text === null ? (
          <p className="muted">本文を読み込めませんでした</p>
        ) : (
          <div className="email-text">{view.text}</div>
        )}
        {view.text_truncated && (
          <p className="hint">本文が長いため先頭の 256 KiB だけ表示しています。全体は下のデータの本文をダウンロードしてください</p>
        )}
      </div>
      {view.html !== null && htmlShown && (
        <div hidden={mode !== "html"}>
          <EmailHtml client={client} eventId={view.event_id} loadKey={loadKey} />
        </div>
      )}
    </>
  );
}

function EmailHtml({ client, eventId, loadKey }: { client: ApiClient; eventId: string; loadKey: string }) {
  const [state, reload] = useView(() => loadEmailHtml(client, eventId), `email-html:${loadKey}`);
  switch (state.kind) {
    case "loading":
      return <p className="muted">読み込み中…</p>;
    case "redirecting":
      return null;
    case "notFound":
    case "error":
      return (
        <div className="email-error" role="alert">
          <p>HTML の本文を読み込めませんでした。{state.kind === "error" ? state.message : ""}</p>
          <button type="button" onClick={reload}>
            再読み込み
          </button>
        </div>
      );
    case "ready": {
      const { text, source, truncated } = state.data;
      return (
        <>
          <p className="hint email-html-note">HTML をテキストに変換して表示しています（画像・レイアウト・リンクは表示しません）</p>
          {text === null ? (
            <p className="muted">HTML の本文をテキストにできませんでした</p>
          ) : (
            <div className="email-text">{text}</div>
          )}
          {truncated && <p className="hint">HTML が長いため先頭の 256 KiB だけ表示しています</p>}
          {source !== null && (
            <details className="data-preview">
              <summary>HTML のソースを表示</summary>
              <pre>{source}</pre>
            </details>
          )}
        </>
      );
    }
  }
}

// One attachment of the email view: a card with its name, type and size, the download and, for images and text, a
// preview read when it is opened.
function EmailAttachmentItem({
  client,
  eventId,
  attachment,
}: {
  client: ApiClient;
  eventId: string;
  attachment: EmailAttachment;
}) {
  const { downloading, failure, download } = useDownload(client, eventId, attachment);
  const kind = attachmentPreview(attachment);
  const name = revealBidiControls(attachment.name);
  return (
    <li className="email-attachment">
      <span className="email-attachment-name">{name}</span>
      <span className="data-meta">
        <span>{attachment.content_type}</span>
        <span>{formatBytes(attachment.size)}</span>
      </span>
      <span className="email-attachment-actions">
        <button type="button" className="data-download" onClick={() => void download()} disabled={downloading}>
          {downloading ? "読み込み中…" : "ダウンロード"}
        </button>
      </span>
      {failure !== null && <p role="alert">{failure}</p>}
      {(kind === "text" || kind === "json") && (
        <TextPreview
          client={client}
          eventId={eventId}
          data={attachment}
          kind={kind}
          initiallyOpen={false}
          label="プレビュー"
        />
      )}
      {kind === "image" && (
        <LazyImagePreview client={client} eventId={eventId} data={{ data_ref: attachment.data_ref, name }} />
      )}
    </li>
  );
}

// The deliveries of the event (to MCP Events subscriptions, webhook destinations and polling queues): the first
// page only. Failed ones can be sent again.
function EventDeliveries({ client, state }: { client: ApiClient; state: ViewState<DeliveryListData> }) {
  switch (state.kind) {
    case "loading":
      return <p className="muted">読み込み中…</p>;
    case "redirecting":
      return null;
    case "notFound":
    case "error":
      return <p className="muted">配信の記録を読み込めませんでした</p>;
    case "ready":
      return state.data.deliveries.length === 0 ? (
        <p className="muted">このイベントの配信はありません</p>
      ) : (
        <EventDeliveryList client={client} first={state.data.deliveries} />
      );
  }
}

function EventDeliveryList({ client, first }: { client: ApiClient; first: DeliveryListItem[] }) {
  const [deliveries, setDeliveries] = useState(first);
  return (
    <DeliveryList
      client={client}
      deliveries={deliveries}
      showEvent={false}
      onRetried={(delivery) =>
        setDeliveries((current) => current.map((item) => (item.id === delivery.id ? delivery : item)))
      }
    />
  );
}
