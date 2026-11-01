import type { EventDetail } from "../../../src/api/types";
import { formatBytes, formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadDeliveries, loadEventDetail, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { DeliveryList } from "./DeliveriesView";

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

// One event: its metadata, labels and the list of its data. The contents are not shown here.
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
        <Link to="/">イベント</Link>
      </p>
      <h1 className="event-title">{event.type}</h1>
      <p className="event-detail-summary">{event.summary}</p>
      <dl className="details">
        <dt>イベントID</dt>
        <dd>
          <code>{event.event_id}</code>
        </dd>
        <dt>送信元</dt>
        <dd>
          <Link to={`/sources/${event.source.id}`}>{event.source.name}</Link>
        </dd>
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
            <li key={data.data_ref}>
              <span className="data-name">
                {data.role === "body" ? "本文" : data.name}
              </span>
              <span className="data-meta">
                <span>{data.content_type}</span>
                <span>{formatBytes(data.size)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>配信</h2>
      <EventDeliveries client={client} eventId={event.event_id} />
    </main>
  );
}

// The deliveries of the event to MCP Events subscriptions: the first page only.
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
        <DeliveryList deliveries={state.data.deliveries} showEvent={false} />
      );
  }
}
