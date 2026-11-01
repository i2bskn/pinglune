import { useState } from "react";
import type { Delivery, Subscription } from "../../../src/api/types";
import { DELIVERY_STATUS_LABELS, SUBSCRIPTION_STATUS_LABELS, describeArguments, lastResult } from "../deliveries";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, type DeliveriesData, loadDeliveries, loadDeliveriesView, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";

// The MCP Events subscriptions of the signed-in user's workspace and the deliveries to them. Read only.
export function DeliveriesView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadDeliveriesView(client), "deliveries");
  useDocumentTitle(viewTitle(state, () => "配信"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return <DeliveriesContent key={state.data.deliveries.deliveries[0]?.id ?? "empty"} client={client} data={state.data} />;
}

function DeliveriesContent({ client, data }: { client: ApiClient; data: DeliveriesData }) {
  return (
    <main className="main">
      <h1>配信</h1>
      <p className="lead">
        MCPクライアント（ChatGPTなど）が購読した条件に一致したイベントを、Webhookで送った記録です。
      </p>

      <h2>購読</h2>
      {data.subscriptions.length === 0 ? (
        <div className="notice">
          <p>購読はまだありません。</p>
          <p>MCPクライアントがイベントを購読すると、ここに表示されます。</p>
        </div>
      ) : (
        <ul className="list subscriptions">
          {data.subscriptions.map((subscription) => (
            <SubscriptionItem key={subscription.id} subscription={subscription} />
          ))}
        </ul>
      )}

      <h2>配信の記録</h2>
      <DeliveryPages client={client} first={data.deliveries} />
    </main>
  );
}

function SubscriptionItem({ subscription }: { subscription: Subscription }) {
  return (
    <li className="subscription">
      <span className="delivery-head">
        <span className="delivery-host">{subscription.callback_host ?? "不明な宛先"}</span>
        <span className={subscription.status === "active" ? "badge" : "badge badge-off"}>
          {SUBSCRIPTION_STATUS_LABELS[subscription.status]}
        </span>
      </span>
      <span className="delivery-conditions">{describeArguments(subscription.arguments)}</span>
      <span className="delivery-meta">
        {subscription.status === "active" && (
          <time dateTime={new Date(subscription.refresh_before).toISOString()}>
            更新期限: {formatDateTime(subscription.refresh_before)}
          </time>
        )}
        <time dateTime={new Date(subscription.updated_at).toISOString()}>
          更新: {formatDateTime(subscription.updated_at)}
        </time>
      </span>
    </li>
  );
}

function DeliveryPages({ client, first }: { client: ApiClient; first: DeliveriesData["deliveries"] }) {
  const [deliveries, setDeliveries] = useState(first.deliveries);
  const [cursor, setCursor] = useState(first.next_cursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function loadMore() {
    if (cursor === null) return;
    setLoading(true);
    setFailure(null);
    const next = await loadDeliveries(client, { cursor });
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

  return (
    <>
      {deliveries.length === 0 ? (
        <p className="notice">配信の記録はまだありません。</p>
      ) : (
        <DeliveryList deliveries={deliveries} showEvent />
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

const DELIVERY_BADGE_CLASSES: Record<Delivery["status"], string> = {
  pending: "badge badge-off",
  delivered: "badge",
  failed: "badge badge-error",
};

// Deliveries, newest first. showEvent adds a link to the event of each one.
export function DeliveryList({ deliveries, showEvent }: { deliveries: Delivery[]; showEvent: boolean }) {
  return (
    <ul className="list deliveries">
      {deliveries.map((delivery) => {
        const result = lastResult(delivery);
        return (
          <li key={delivery.id} className="delivery">
            <span className="delivery-head">
              <span className="delivery-host">{delivery.callback_host ?? "不明な宛先"}</span>
              <span className={DELIVERY_BADGE_CLASSES[delivery.status]}>
                {DELIVERY_STATUS_LABELS[delivery.status]}
              </span>
            </span>
            {showEvent && (
              <Link to={`/events/${delivery.event_id}`} className="delivery-event">
                <code>{delivery.event_id}</code>
              </Link>
            )}
            <span className="delivery-meta">
              <time dateTime={new Date(delivery.created_at).toISOString()}>{formatDateTime(delivery.created_at)}</time>
              <span>試行 {delivery.attempts} 回</span>
              {result !== null && <span>{result}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
