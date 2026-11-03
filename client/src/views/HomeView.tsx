import { useState } from "react";
import type { EventSummary } from "../../../src/api/types";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadEvents, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { EventLabels } from "./EventDetailView";
import { FlowMap } from "./FlowMap";

// The home screen: the events of the signed-in user's workspace, newest first.
export function HomeView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadEvents(client), "events");
  useDocumentTitle(viewTitle(state, () => "イベント"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  // Keyed by the first page, so that a reload starts the extra pages again.
  return <EventList key={state.data.events[0]?.event_id ?? "empty"} client={client} first={state.data} />;
}

function EventList({
  client,
  first,
}: {
  client: ApiClient;
  first: { events: EventSummary[]; next_cursor: string | null };
}) {
  const [events, setEvents] = useState(first.events);
  const [cursor, setCursor] = useState(first.next_cursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function loadMore() {
    if (cursor === null) return;
    setLoading(true);
    setFailure(null);
    const next = await loadEvents(client, cursor);
    switch (next.kind) {
      case "ready":
        setEvents((current) => [...current, ...next.data.events]);
        setCursor(next.data.next_cursor);
        setLoading(false);
        return;
      case "error":
        setFailure(next.message);
        setLoading(false);
        return;
      case "notFound":
        setFailure("イベントを読み込めませんでした");
        setLoading(false);
        return;
      case "redirecting":
        // The move to the login page has started; the button stays disabled.
        return;
    }
  }

  return (
    <main className="main main-wide">
      <h1>イベント</h1>
      <FlowMap client={client} />
      <h2 className="sr-only">イベント一覧</h2>
      {events.length === 0 ? (
        <div className="notice">
          <p>まだイベントはありません。</p>
          <p>
            <Link to="/sources">送信元</Link>
            を作り、APIキーかService Bindingsでイベントを送ると、ここに表示されます。
          </p>
        </div>
      ) : (
        <ul className="list events">
          {events.map((event) => (
            <li key={event.event_id}>
              <Link to={`/events/${event.event_id}`} className="event-link">
                <span className="event-head">
                  <span className="event-type">{event.type}</span>
                  <span className="event-source">{event.source.name}</span>
                </span>
                <span className="event-summary">{event.summary}</span>
                <span className="event-meta">
                  <time dateTime={new Date(event.occurred_at).toISOString()}>{formatDateTime(event.occurred_at)}</time>
                  {event.data_count > 0 && <span>データ {event.data_count} 件</span>}
                </span>
              </Link>
              <EventLabels labels={event.labels} />
            </li>
          ))}
        </ul>
      )}
      {cursor !== null && (
        <div className="actions list-more">
          <button type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "読み込み中…" : "さらに読み込む"}
          </button>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      )}
    </main>
  );
}
