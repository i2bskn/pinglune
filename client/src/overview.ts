import type { Delivery, DeliveryStatus, Subscription } from "../../src/api/types";
import type { FlowModel } from "./flow";

// The figures of the overview screen. No JSX, so that the tests can load it in Node.
export type OverviewStats = {
  sources: { total: number; disabled: number; unlinked: number };
  // reaching: bots linked to a source whose destination events reach. stopped: the others.
  bots: { total: number; reaching: number; stopped: number };
  // Over the deliveries given (the newest page), by status.
  deliveries: { total: number } & Record<DeliveryStatus, number>;
};

export function overviewStats(model: FlowModel, deliveries: Delivery[]): OverviewStats {
  const reaching = model.bots.filter((bot) => bot.badges.length === 0 && bot.delivery.badge === null).length;
  const counts: Record<DeliveryStatus, number> = { delivered: 0, pending: 0, failed: 0 };
  for (const delivery of deliveries) counts[delivery.status] += 1;
  return {
    sources: {
      total: model.sources.length,
      disabled: model.sources.filter((source) => !source.enabled).length,
      unlinked: model.sources.filter((source) => !source.linked).length,
    },
    bots: { total: model.bots.length, reaching, stopped: model.bots.length - reaching },
    deliveries: { total: deliveries.length, ...counts },
  };
}

// The newest failed deliveries, at most limit of them, in the order given (newest first).
export function recentFailures(deliveries: Delivery[], limit: number): Delivery[] {
  return deliveries.filter((delivery) => delivery.status === "failed").slice(0, limit);
}

// Where the overview links for the deliveries: the failed ones when the newest page has a failure, otherwise every
// delivery (filtering by status reads the whole workspace when few match, so it is not the default).
export function deliveryHistoryLink(deliveries: Delivery[]): string {
  return deliveries.some((delivery) => delivery.status === "failed")
    ? "/deliveries/history?status=failed"
    : "/deliveries/history";
}

// The active destinations that belong to no bot: events never reach them.
export function unassignedDestinations(subscriptions: Subscription[]): Subscription[] {
  return subscriptions.filter((subscription) => subscription.status === "active" && subscription.bot === null);
}
