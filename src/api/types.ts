import type { Role } from "../auth/validate";
import type { AuthMode } from "../env";

export type User = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  // UNIX time in milliseconds.
  created_at: number;
  // UNIX time in milliseconds.
  last_login_at: number | null;
};

export type UserList = {
  users: User[];
  // The screen hides the operations that exist only in password mode.
  auth_mode: AuthMode;
};

export type ApiError = {
  error: {
    // snake_case error code, e.g. `invalid_email`, `not_found`.
    code: string;
    message: string;
    // The reason for each invalid item, keyed by the item name. Only on validation errors.
    fields?: Record<string, string>;
  };
};

export type ChangeMyPasswordRequest = {
  current_password: string;
  new_password: string;
};

export type CreateUserRequest = {
  email: string;
  name?: string | null;
  password: string;
  role: Role;
};

// CreateUserRequest after validation. email is normalized and a missing or blank name is null.
export type CreateUserInput = {
  email: string;
  name: string | null;
  password: string;
  role: Role;
};

export type ResetPasswordRequest = {
  password: string;
};

export type UpdateUserRequest = {
  role: Role;
};

// A sender of events. Times are UNIX time in milliseconds.
export type Source = {
  id: string;
  name: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  // API keys that are not revoked.
  active_key_count: number;
};

export type SourceList = { sources: Source[] };

export type CreateSourceRequest = { name: string };

// At least one of the two.
export type UpdateSourceRequest = { name?: string; enabled?: boolean };

// Neither the secret nor its hash is ever returned.
export type ApiKey = {
  key_id: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

export type ApiKeyList = { api_keys: ApiKey[] };

// key is the plain key `pl_<keyId>_<secret>`, returned only in this response.
export type CreatedApiKey = { api_key: ApiKey; key: string };

export type EventSummary = {
  event_id: string;
  type: string;
  source: { id: string; name: string };
  labels: Record<string, string>;
  summary: string;
  occurred_at: number;
  received_at: number;
  data_count: number;
};

export type EventList = { events: EventSummary[]; next_cursor: string | null };

export type EventData = {
  data_ref: string;
  role: "body" | "attachment";
  name: string;
  content_type: string;
  size: number;
};

// data is in position order: the body first, then the attachments in the order they were sent.
export type EventDetail = EventSummary & { data: EventData[] };

// The response of POST /ingest/v1/events: 201 for a new event, 200 for a retry of an existing one.
export type IngestResponse = { event_id: string; duplicate: boolean };

export type SubscriptionStatus = "active" | "expired" | "unsubscribed";

// An MCP Events subscription. Neither the secrets nor the whole callback URL is returned.
export type Subscription = {
  id: string;
  // The host of the callback URL only.
  callback_host: string | null;
  // The conditions (types, sources, labels); null if the stored value is broken.
  arguments: Record<string, unknown> | null;
  status: SubscriptionStatus;
  // expires_at minus the grace of 1 hour: when the client should refresh the subscription.
  refresh_before: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
};

export type SubscriptionList = { subscriptions: Subscription[] };

export type DeliveryStatus = "pending" | "delivered" | "failed";

// One webhook delivery of an event to a subscription. Times are UNIX time in milliseconds.
export type Delivery = {
  id: string;
  event_id: string;
  subscription_id: string;
  callback_host: string | null;
  status: DeliveryStatus;
  // The number of sends tried.
  attempts: number;
  last_attempt_at: number | null;
  last_http_status: number | null;
  // The reason of the last failure, e.g. "http_5xx" or "subscription_inactive".
  last_error: string | null;
  delivered_at: number | null;
  created_at: number;
};

export type DeliveryList = { deliveries: Delivery[]; next_cursor: string | null };
