import { useState } from "react";
import type { DeliveryListItem, DeliveryStatus } from "../../../src/api/types";
import { retryDelivery } from "../actions";
import { DELIVERY_KIND_LABELS } from "../bots";
import {
  DELIVERY_STATUS_FILTERS,
  attemptsLabel,
  canRetry,
  noRetryReason,
  deliveryDestination,
  deliveryHistoryPath,
  deliveryStatusLabel,
  destinationLabel,
  lastResult,
  statusFilterOf,
} from "../deliveries";
import { formatDateTime, keepNumbersWithUnits } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadDeliveries, useView } from "../load";
import { searchParams } from "../router";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const RETRY_HINT = "記録された時点の配信先へ送り直します（今の Bot の紐づけには関係しません）";

// The deliveries of the signed-in user's workspace, newest first, filtered by status (?status=).
export function DeliveryHistoryView({ client, path }: { client: ApiClient; path: string }) {
  const status = statusFilterOf(searchParams(path));
  const [state, reload] = useView(
    () => loadDeliveries(client, status === null ? {} : { status }),
    `deliveryHistory:${status ?? "all"}`,
  );
  useDocumentTitle(viewTitle(state, () => "配信履歴"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return (
    <main className="main">
      <header className="page-head">
        <h1>配信履歴</h1>
        <p className="lead">
          イベントを配信先へ送った記録です。新しいものから並びます。失敗した配信は「再送」で、記録された時点の配信先へ送り直せます。
        </p>
      </header>
      <nav className="filter-tabs" aria-label="状態で絞り込む">
        {DELIVERY_STATUS_FILTERS.map((filter) => (
          <Link
            key={filter.label}
            to={deliveryHistoryPath(filter.status)}
            className="filter-tab"
            aria-current={filter.status === status ? "page" : undefined}
          >
            {filter.label}
          </Link>
        ))}
      </nav>
      {/* Keyed by the first page, so that a reload starts the extra pages again. */}
      <DeliveryPages key={state.data.deliveries[0]?.id ?? "empty"} client={client} status={status} first={state.data} />
    </main>
  );
}

function DeliveryPages({
  client,
  status,
  first,
}: {
  client: ApiClient;
  status: DeliveryStatus | null;
  first: { deliveries: DeliveryListItem[]; next_cursor: string | null };
}) {
  const [deliveries, setDeliveries] = useState(first.deliveries);
  const [cursor, setCursor] = useState(first.next_cursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function loadMore() {
    if (cursor === null) return;
    setLoading(true);
    setFailure(null);
    const next = await loadDeliveries(client, status === null ? { cursor } : { cursor, status });
    switch (next.kind) {
      case "ready":
        setDeliveries((current) => [...current, ...next.data.deliveries]);
        setCursor(next.data.next_cursor);
        setLoading(false);
        return;
      case "error":
        setFailure(next.message);
        setLoading(false);
        return;
      case "notFound":
        setFailure("配信の記録を読み込めませんでした");
        setLoading(false);
        return;
      case "redirecting":
        // The move to the login page has started; the button stays disabled.
        return;
    }
  }

  // A retried delivery stays where it is, with what the server returned (pending), even in the list of failures.
  function replace(delivery: DeliveryListItem) {
    setDeliveries((current) => current.map((item) => (item.id === delivery.id ? delivery : item)));
  }

  return (
    <>
      {deliveries.length === 0 ? (
        <p className="empty-note">{status === null ? "まだ配信はありません。" : "該当する配信はありません。"}</p>
      ) : (
        <DeliveryList client={client} deliveries={deliveries} showEvent onRetried={replace} />
      )}
      {cursor !== null && (
        <div className="actions list-more">
          <button type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "読み込み中…" : "さらに読み込む"}
          </button>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      )}
    </>
  );
}

const DELIVERY_BADGE_CLASSES: Record<DeliveryStatus, string> = {
  pending: "badge badge-warning",
  delivered: "badge badge-ok",
  failed: "badge badge-error",
};

// Deliveries (webhooks, MCP Events subscriptions and entries of polling queues), newest first. showEvent shows the
// event of each one with a link to it (the delivery history); without it, the rows are those of an event's detail.
// Failed deliveries to webhook destinations and MCP Events subscriptions can be sent again; onRetried receives the
// delivery the server returned.
export function DeliveryList({
  client,
  deliveries,
  showEvent,
  onRetried,
}: {
  client: ApiClient;
  deliveries: DeliveryListItem[];
  showEvent: boolean;
  onRetried: (delivery: DeliveryListItem) => void;
}) {
  return (
    <ul className={showEvent ? "list deliveries delivery-history" : "list deliveries"}>
      {deliveries.map((delivery) => (
        <DeliveryRow key={delivery.id} client={client} delivery={delivery} showEvent={showEvent} onRetried={onRetried} />
      ))}
    </ul>
  );
}

function DeliveryRow({
  client,
  delivery,
  showEvent,
  onRetried,
}: {
  client: ApiClient;
  delivery: DeliveryListItem;
  showEvent: boolean;
  onRetried: (delivery: DeliveryListItem) => void;
}) {
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const result = lastResult(delivery);
  const retryable = canRetry(delivery);

  async function retry() {
    setSending(true);
    setNotice(null);
    setFailure(null);
    const outcome = await retryDelivery(client, delivery.id);
    switch (outcome.kind) {
      case "ok":
        setSending(false);
        setNotice("再送を受け付けました");
        onRetried(outcome.delivery);
        return;
      case "error":
        setSending(false);
        setFailure(outcome.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        // The move to the login page has started; the button stays disabled.
        return;
    }
  }

  const retryControls = (
    <>
      {retryable && (
        <>
          <button
            type="button"
            className="delivery-retry"
            title={RETRY_HINT}
            onClick={() => void retry()}
            disabled={sending}
          >
            {sending ? "送信中…" : "再送"}
          </button>
        </>
      )}
      {noRetryReason(delivery) !== null && <span className="delivery-no-retry">{noRetryReason(delivery)}</span>}
      {notice !== null && (
        <p className="delivery-notice" role="status">
          {notice}
        </p>
      )}
      {failure !== null && <p role="alert">{failure}</p>}
    </>
  );

  if (!showEvent) {
    return (
      <li className="delivery">
        <span className="delivery-head">
          <span className="delivery-host">{deliveryDestination(delivery)}</span>
          <span className={DELIVERY_BADGE_CLASSES[delivery.status]}>{deliveryStatusLabel(delivery)}</span>
        </span>
        <span className="delivery-meta">
          <time dateTime={new Date(delivery.created_at).toISOString()}>{formatDateTime(delivery.created_at)}</time>
          <span>{attemptsLabel(delivery)}</span>
          {result !== null && <span>{result}</span>}
        </span>
        {retryControls}
      </li>
    );
  }

  const kind = delivery.destination_kind;
  return (
    <li className="delivery">
      <span className="delivery-head">
        <span className={DELIVERY_BADGE_CLASSES[delivery.status]}>{deliveryStatusLabel(delivery)}</span>
        <span className="delivery-destination">
          <span className="kind-chip">{kind === null ? "不明" : DELIVERY_KIND_LABELS[kind]}</span>
          <span className="delivery-host">{destinationLabel(delivery)}</span>
        </span>
        <time className="delivery-time" dateTime={new Date(delivery.created_at).toISOString()}>
          {formatDateTime(delivery.created_at)}
        </time>
      </span>
      <Link to={`/events/${delivery.event_id}`} className="delivery-event-line">
        {delivery.event === null ? (
          <code>{delivery.event_id}</code>
        ) : (
          <>
            <span className="event-type">{delivery.event.type}</span>
            <span className="delivery-event-summary">{keepNumbersWithUnits(delivery.event.summary)}</span>
          </>
        )}
      </Link>
      {(delivery.status !== "delivered" || notice !== null || failure !== null) && (
        <div className="delivery-foot">
          {delivery.status !== "delivered" && (
            <span className="delivery-result">
              {result !== null && <span>{result}</span>}
              <span>{attemptsLabel(delivery)}</span>
            </span>
          )}
          {retryControls}
        </div>
      )}
    </li>
  );
}
