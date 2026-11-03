// Polling queues (subscriptions of kind "queue"): for AIs that cannot be called from outside and poll with the
// claim_events and ack_events MCP tools instead. The deliveries are leased (claimed) and acknowledged; nothing is
// sent to the delivery queue.
// Note: a Worker rolled back to the code before queues would put their deliveries into the delivery queue, and its
// consumer would fail them as subscription_inactive.

// A claimed delivery is not claimed again for this long.
export const QUEUE_LEASE_MS = 10 * 60 * 1000;
// A delivery claimed this many times without an ack fails as not_acknowledged.
export const QUEUE_MAX_CLAIMS = 5;
// A delivery not acknowledged for this long fails as expired (the daily cron), and is not claimed anymore.
export const QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CLAIM_DEFAULT_LIMIT = 10;
export const CLAIM_MAX_LIMIT = 50;
export const ACK_MAX_IDS = 50;
export const MAX_ACTIVE_QUEUES_PER_WORKSPACE = 100;
