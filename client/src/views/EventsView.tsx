import { type FormEvent, useState } from "react";
import type {
  DeliverySummary,
  EventListEmail,
  EventListItem,
  EventScreening,
  EventSummary,
} from "../../../src/api/types";
import { EMAIL_EVENT_TYPE, revealBidiControls } from "../email";
import { type EventFilterValues, deliverySummaryBadges, eventFilterOf, eventsPath, isFiltered } from "../events";
import { formatDateTime, keepNumbersWithUnits } from "../format";
import { Link } from "../Link";
import { type ApiClient, type EventsViewData, loadEvents, loadEventsView, useView } from "../load";
import { navigate, searchParams } from "../router";
import { SCREENING_BADGE_CLASSES, SCREENING_STATUS_LABELS, parseScreeningFilter } from "../screening";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { EventLabels } from "./EventDetailView";

// The events of the signed-in user's workspace, newest first, filtered by type, source and screening (?type=,
// ?source_id=, ?screening=).
export function EventsView({ client, path }: { client: ApiClient; path: string }) {
  const filter = eventFilterOf(searchParams(path));
  const [state, reload] = useView(
    () => loadEventsView(client, filter),
    `events:${filter.type}:${filter.sourceId}:${filter.screening ?? ""}`,
  );
  useDocumentTitle(viewTitle(state, () => "イベント"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return (
    <main className="main">
      <header className="page-head">
        <h1>イベント</h1>
        <p className="lead">送信元から受け取ったイベントです。新しいものから並びます。</p>
      </header>
      <nav className="filter-tabs" aria-label="種類で絞り込む">
        <Link
          to={eventsPath({ ...filter, type: "" })}
          className="filter-tab"
          aria-current={filter.type === "" ? "page" : undefined}
        >
          すべて
        </Link>
        <Link
          to={eventsPath({ ...filter, type: EMAIL_EVENT_TYPE })}
          className="filter-tab"
          aria-current={filter.type === EMAIL_EVENT_TYPE ? "page" : undefined}
        >
          メール
        </Link>
      </nav>
      <EventFilterForm filter={filter} data={state.data} />
      {state.data.events === null ? (
        <p role="alert">{state.data.eventsError}</p>
      ) : (
        // Keyed by the first page, so that a reload starts the extra pages again.
        <EventList
          key={state.data.events.events[0]?.event_id ?? "empty"}
          client={client}
          filter={filter}
          first={state.data.events}
        />
      )}
    </main>
  );
}

function EventFilterForm({ filter, data }: { filter: EventFilterValues; data: EventsViewData }) {
  const [type, setType] = useState(filter.type);
  const [sourceId, setSourceId] = useState(filter.sourceId);
  const [screening, setScreening] = useState<string>(filter.screening ?? "");
  const sourcesUnavailable = data.sourcesError !== null;
  // A source in the URL that is not in the list (another workspace's, or deleted) is kept as a choice, so that the
  // select shows what the list is filtered by.
  const unknownSource = filter.sourceId !== "" && !data.sources.some((source) => source.id === filter.sourceId);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const screeningFilter = parseScreeningFilter(screening);
    navigate(eventsPath(screeningFilter === undefined ? { type, sourceId } : { type, sourceId, screening: screeningFilter }));
  }

  return (
    <>
      <form className="filter-form" role="search" aria-label="イベントを絞り込む" onSubmit={onSubmit}>
        <label>
          種類
          <input
            type="text"
            value={type}
            onChange={(event) => setType(event.target.value)}
            placeholder="例: alert.observed"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
          />
        </label>
        <label>
          送信元
          <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={sourcesUnavailable}>
            <option value="">すべて</option>
            {data.sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.enabled ? source.name : `${source.name}（無効）`}
              </option>
            ))}
            {unknownSource && <option value={filter.sourceId}>不明な送信元</option>}
          </select>
        </label>
        <label>
          判定
          <select value={screening} onChange={(event) => setScreening(event.target.value)}>
            <option value="">すべて</option>
            <option value="held">保留</option>
            <option value="pending">判定待ち</option>
          </select>
        </label>
        <div className="filter-form-actions">
          <button type="submit">絞り込む</button>
          {isFiltered(filter) && <Link to="/events">解除</Link>}
        </div>
      </form>
      {sourcesUnavailable && <p className="hint">送信元を読み込めなかったため、送信元では絞り込めません。{data.sourcesError}</p>}
    </>
  );
}

function EventList({
  client,
  filter,
  first,
}: {
  client: ApiClient;
  filter: EventFilterValues;
  first: { events: EventListItem[]; next_cursor: string | null };
}) {
  const [events, setEvents] = useState(first.events);
  const [cursor, setCursor] = useState(first.next_cursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function loadMore() {
    if (cursor === null) return;
    setLoading(true);
    setFailure(null);
    const next = await loadEvents(client, cursor, filter);
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
    <>
      {events.length === 0 ? (
        isFiltered(filter) ? (
          <p className="empty-note">該当するイベントはありません。</p>
        ) : (
          <div className="notice">
            <p>まだイベントはありません。</p>
            <p>
              <Link to="/sources">送信元</Link>
              を作り、API キーかService Bindings でイベントを送ると、ここに表示されます。
            </p>
          </div>
        )
      ) : (
        <ul className="list events">
          {events.map((event) => (
            <EventRow key={event.event_id} event={event} />
          ))}
        </ul>
      )}
      {cursor !== null ? (
        <div className="actions list-more">
          <button type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "読み込み中…" : "さらに読み込む"}
          </button>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      ) : (
        events.length > 0 && <p className="list-end">{events.length} 件をすべて表示しています</p>
      )}
    </>
  );
}

// One event in a list: its type and source, its summary, when it happened, its labels and, when given, how its
// deliveries went. An email event shows its From and the number of its attachments instead of the data.
// hideSource leaves out the name of the source (on the screen of that source).
export function EventRow({
  event,
  hideSource = false,
}: {
  event: EventSummary & {
    delivery_summary?: DeliverySummary;
    screening?: EventScreening | null;
    email?: EventListEmail | null;
  };
  hideSource?: boolean;
}) {
  const summary = event.delivery_summary;
  const screening = event.screening ?? null;
  const email = event.email ?? null;
  const dataNote =
    email === null
      ? event.data_count > 0
        ? `データ ${event.data_count} 件`
        : "データなし"
      : email.attachment_count > 0
        ? `添付 ${email.attachment_count} 件`
        : null;
  return (
    <li>
      <Link to={`/events/${event.event_id}`} className="event-link">
        <span className="event-head">
          <span className="event-type">{email === null ? event.type : "メール"}</span>
          {!hideSource && <span className="event-source">{event.source.name}</span>}
          {screening !== null && (
            <span className={SCREENING_BADGE_CLASSES[screening.status]} aria-label="判定">
              {SCREENING_STATUS_LABELS[screening.status]}
            </span>
          )}
          <time className="event-time" dateTime={new Date(event.occurred_at).toISOString()}>
            {formatDateTime(event.occurred_at)}
          </time>
        </span>
        {email !== null && email.from !== null && <span className="event-from">From: {revealBidiControls(email.from)}</span>}
        <span className="event-summary">
          {keepNumbersWithUnits(email === null ? event.summary : revealBidiControls(event.summary))}
        </span>
        {((email === null ? event.data_count > 0 : dataNote !== null) || summary !== undefined) && (
          <span className="event-meta">
            {dataNote !== null && <span>{dataNote}</span>}
            {summary !== undefined && (
              <span className="event-deliveries" aria-label="配信">
                {deliverySummaryBadges(summary).map((badge) => (
                  <span key={badge.label} className={badge.className}>
                    {badge.label}
                  </span>
                ))}
              </span>
            )}
          </span>
        )}
      </Link>
      <EventLabels labels={event.labels} />
    </li>
  );
}
