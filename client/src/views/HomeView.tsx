import { useMemo } from "react";
import { buildFlow } from "../flow";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { DELIVERY_KIND_LABELS } from "../bots";
import { destinationLabel, lastResult } from "../deliveries";
import { type ApiClient, type OverviewData, loadOverview, useView } from "../load";
import { deliveryHistoryLink, overviewStats, recentFailures, unassignedDestinations } from "../overview";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { EventRow } from "./EventsView";
import { FlowMap } from "./FlowMap";

const RECENT_EVENTS = 5;
const RECENT_FAILURES = 5;

// The overview: whether events reach the bots, from the sources to the destinations, with the newest events and
// failures.
export function HomeView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadOverview(client), "overview");
  useDocumentTitle(viewTitle(state, () => "概要"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return <Overview data={state.data} />;
}

function Overview({ data }: { data: OverviewData }) {
  const model = useMemo(() => buildFlow(data.sources, data.bots), [data]);
  const stats = overviewStats(model, data.deliveries.deliveries);
  const failures = recentFailures(data.deliveries.deliveries, RECENT_FAILURES);
  const events = data.events.events.slice(0, RECENT_EVENTS);
  const latest = data.events.events[0];
  const historyLink = deliveryHistoryLink(data.deliveries.deliveries);

  return (
    <main className="main main-wide">
      <header className="page-head">
        <h1>概要</h1>
        <p className="lead">送信元から届いたイベントが、Bot を通って配信先まで届いているかを確かめられます。</p>
      </header>

      <ul className="stats" aria-label="現在の状態">
        <li className="stat">
          <Link to="/sources" className="stat-link">
            <span className="stat-label">送信元</span>
            <span className="stat-value">{stats.sources.total}</span>
            <span className={`stat-note${stats.sources.unlinked > 0 ? " is-warning" : ""}`}>
              {stats.sources.unlinked > 0
                ? <>どの Bot にも届かない <span className="nowrap">{stats.sources.unlinked} 件</span></>
                : stats.sources.disabled > 0
                  ? <>無効 <span className="nowrap">{stats.sources.disabled} 件</span></>
                  : "すべて Bot につながっています"}
            </span>
          </Link>
        </li>
        <li className="stat">
          <Link to="/bots" className="stat-link">
            <span className="stat-label">Bot</span>
            <span className="stat-value">{stats.bots.total}</span>
            <span className={`stat-note${stats.bots.stopped > 0 ? " is-warning" : ""}`}>
              {stats.bots.total === 0
                ? "まだありません"
                : stats.bots.stopped > 0
                  ? <>届かない Bot <span className="nowrap">{stats.bots.stopped} 件</span></>
                  : "すべて届く状態です"}
            </span>
          </Link>
        </li>
        <li className="stat">
          <Link to={historyLink} className="stat-link">
            <span className="stat-label">直近の配信</span>
            <span className={`stat-value${stats.deliveries.failed > 0 ? " is-error" : ""}`}>
              {stats.deliveries.failed}
              <span className="stat-unit"> 件失敗</span>
            </span>
            <span className="stat-note">
              {stats.deliveries.total === 0
                ? "まだ配信はありません"
                : <>直近 <span className="nowrap">{stats.deliveries.total} 件</span>のうち 成功 <span className="nowrap">{stats.deliveries.delivered}</span>・未配信 <span className="nowrap">{stats.deliveries.pending}</span></>}
            </span>
          </Link>
        </li>
        <li className="stat">
          <Link to="/events" className="stat-link">
            <span className="stat-label">最新のイベント</span>
            <span className="stat-value stat-value-text">
              {latest === undefined ? "なし" : formatDateTime(latest.occurred_at)}
            </span>
            <span className="stat-note">{latest === undefined ? "送信元からまだ届いていません" : latest.source.name}</span>
          </Link>
        </li>
      </ul>

      <FlowMap data={data} unassigned={unassignedDestinations(data.subscriptions)} />

      <div className="overview-columns">
        <section className="overview-section" aria-labelledby="overview-events">
          <div className="section-head">
            <h2 id="overview-events">最近のイベント</h2>
            <Link to="/events">すべて見る</Link>
          </div>
          {events.length === 0 ? (
            <p className="empty-note">
              まだイベントはありません。<Link to="/sources">送信元</Link>
              を作り、API キーか Service Bindings でイベントを送ると、ここに表示されます。
            </p>
          ) : (
            <ul className="list events">
              {events.map((event) => (
                <EventRow key={event.event_id} event={event} />
              ))}
            </ul>
          )}
        </section>

        <section className="overview-section" aria-labelledby="overview-failures">
          <div className="section-head">
            <h2 id="overview-failures">最近の配信の失敗</h2>
            <Link to={historyLink}>配信を見る</Link>
          </div>
          {failures.length === 0 ? (
            <p className="empty-note">直近の配信に失敗はありません。</p>
          ) : (
            <ul className="list failures">
              {failures.map((delivery) => (
                <li key={delivery.id}>
                  <Link to={`/events/${delivery.event_id}`} className="failure-link">
                    <span className="failure-head">
                      <span className="failure-destination">
                        <span className="badge badge-error">失敗</span>
                        {delivery.destination_kind !== null && (
                          <span className="kind-chip">{DELIVERY_KIND_LABELS[delivery.destination_kind]}</span>
                        )}
                        {destinationLabel(delivery)}
                      </span>
                      <time dateTime={new Date(delivery.created_at).toISOString()}>
                        {formatDateTime(delivery.created_at)}
                      </time>
                    </span>
                    <span className="failure-reason">{lastResult(delivery) ?? "失敗"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
