import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import type { DeliveryListItem, EventData, EventDetail } from "../../../src/api/types";
import { previewKind, previewText } from "../events";
import { formatBytes, formatDateTime, keepNumbersWithUnits } from "../format";
import { Link } from "../Link";
import { type ApiClient, fetchEventData, loadDeliveries, loadEventDetail, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { DeliveryList } from "./DeliveryHistoryView";

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

// One event: its metadata, labels, its data (downloaded, and shown when it is safe and small) and its deliveries.
export function EventDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadEventDetail(client, id), `event:${id}`);
  useDocumentTitle(viewTitle(state, (event) => event.type));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="イベントが見つかりません" onReload={reload} />;
  }
  return <EventDetailContent client={client} event={state.data} />;
}

function EventDetailContent({ client, event }: { client: ApiClient; event: EventDetail }) {
  return (
    <main className="main">
      <p className="breadcrumb">
        <Link to="/events">イベント</Link>
      </p>
      <header className="page-head">
        <p className="event-title-type">
          <span className="event-type">{event.type}</span>
        </p>
        <h1 className="event-title event-detail-summary">{keepNumbersWithUnits(event.summary)}</h1>
      </header>
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
            <DataItem key={data.data_ref} client={client} eventId={event.event_id} data={data} />
          ))}
        </ul>
      )}

      <h2>配信</h2>
      <EventDeliveries client={client} eventId={event.event_id} />
    </main>
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

// One body or attachment: its name, type and size, a download button and, for small text, JSON and images, a preview.
function DataItem({ client, eventId, data }: { client: ApiClient; eventId: string; data: EventData }) {
  const [downloading, setDownloading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const kind = previewKind(data);
  const name = data.role === "body" ? "本文" : data.name;

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
        <TextPreview client={client} eventId={eventId} data={data} kind={kind} initiallyOpen={data.role === "body"} />
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
}: {
  client: ApiClient;
  eventId: string;
  data: EventData;
  kind: "text" | "json";
  initiallyOpen: boolean;
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
      <summary>中身を表示</summary>
      {state.kind === "loading" && <p className="muted">読み込み中…</p>}
      {state.kind === "error" && <p role="alert">{PREVIEW_FAILED_MESSAGE}</p>}
      {state.kind === "ready" && <pre>{state.value}</pre>}
    </details>
  );
}

// An image of up to IMAGE_PREVIEW_MAX_BYTES, read when the screen is shown and put into a data: URL (the CSP allows
// img-src data:, and the API URL itself is never put into the page).
function ImagePreview({ client, eventId, data }: { client: ApiClient; eventId: string; data: EventData }) {
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

// The deliveries of the event (to MCP Events subscriptions, webhook destinations and polling queues): the first
// page only. Failed ones can be sent again.
function EventDeliveries({ client, eventId }: { client: ApiClient; eventId: string }) {
  const [state] = useView(() => loadDeliveries(client, { eventId }), `deliveries:${eventId}`);
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
