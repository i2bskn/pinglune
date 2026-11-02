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

// An address of the email intake. The local part is not a secret: it can be shown any number of times.
export type EmailAddress = {
  local_part: string;
  // `${local_part}@${EMAIL_DOMAIN}`. null when EMAIL_DOMAIN is unset or invalid.
  address: string | null;
  created_at: number;
  last_received_at: number | null;
  revoked_at: number | null;
};

// The email intake is off when email_domain is null.
export type EmailAddressList = { email_domain: string | null; email_addresses: EmailAddress[] };

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

// data is in position order: the body first, then the attachments in the order they were sent. conversation_id is
// set for the messages of conversations, and null for the events of programs.
export type EventDetail = EventSummary & { conversation_id: string | null; data: EventData[] };

// The response of POST /ingest/v1/events: 201 for a new event, 200 for a retry of an existing one.
export type IngestResponse = { event_id: string; duplicate: boolean };

export type SubscriptionStatus = "active" | "expired" | "unsubscribed";

// mcp: an MCP Events subscription (events/subscribe). webhook: a webhook destination registered on the screen,
// sent with a Bearer key. queue: a polling queue registered on the screen, taken with the claim_events and
// ack_events MCP tools.
export type SubscriptionKind = "mcp" | "webhook" | "queue";

// An MCP Events subscription, a webhook destination or a polling queue. Neither the secrets (or keys) nor the
// whole callback URL is returned.
export type Subscription = {
  id: string;
  kind: SubscriptionKind;
  // The name of a webhook destination or a polling queue. null for mcp.
  name: string | null;
  // The host of the callback URL only. null for queue, which sends nothing.
  callback_host: string | null;
  // The conditions (types, sources, labels); null if the stored value is broken.
  arguments: Record<string, unknown> | null;
  // Webhook destinations and polling queues are "active" or "unsubscribed" (deleted); they never expire.
  status: SubscriptionStatus;
  // mcp only: expires_at minus the grace of 1 hour, when the client should refresh the subscription. null for
  // webhook and queue.
  refresh_before: number | null;
  // mcp only. null for webhook and queue, which do not expire.
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

// The conditions (types, sources, labels) are optional, as in events/subscribe; an empty array or object is
// rejected. The key is never returned.
export type CreateWebhookDestinationRequest = {
  name: string;
  url: string;
  token: string;
  types?: string[];
  sources?: string[];
  labels?: Record<string, string>;
};

// The conditions are optional, as for webhook destinations.
export type CreateQueueRequest = {
  name: string;
  types?: string[];
  sources?: string[];
  labels?: Record<string, string>;
};

export type SubscriptionList = { subscriptions: Subscription[] };

export type DeliveryStatus = "pending" | "delivered" | "failed";

// One delivery of an event to a subscription: a webhook, or an entry of a polling queue. Times are UNIX time in
// milliseconds.
export type Delivery = {
  id: string;
  event_id: string;
  subscription_id: string;
  // null for queue, and when the subscription is not found.
  callback_host: string | null;
  // The kind and the name of the subscription; both null when it is not found.
  destination_kind: SubscriptionKind | null;
  destination_name: string | null;
  // For queue: pending until acknowledged (claimed or not), delivered once acknowledged.
  status: DeliveryStatus;
  // The number of sends tried; for queue, the number of claims.
  attempts: number;
  // For queue: the time of the last claim.
  last_attempt_at: number | null;
  // Always null for queue.
  last_http_status: number | null;
  // The reason of the last failure, e.g. "http_5xx", "subscription_inactive" or, for queue, "not_acknowledged".
  last_error: string | null;
  delivered_at: number | null;
  created_at: number;
};

export type DeliveryList = { deliveries: Delivery[]; next_cursor: string | null };

export type ConversationStatus = "open" | "stopped";

// user: stopped on the management screen. limit: the AIs sent max_ai_messages messages.
export type ConversationStopReason = "user" | "limit";

// A conversation between AIs and the user. Times are UNIX time in milliseconds.
export type Conversation = {
  id: string;
  title: string;
  status: ConversationStatus;
  // null while open.
  stop_reason: ConversationStopReason | null;
  max_ai_messages: number;
  ai_message_count: number;
  participants: { name: string }[];
  created_at: number;
  updated_at: number;
};

export type ConversationList = { conversations: Conversation[]; next_cursor: string | null };

// An AI in a conversation: the MCP connection its messages come from, and the destination its notifications go to.
export type ConversationParticipant = {
  name: string;
  oauth_client_id: string;
  // The client_name of the MCP connection; the client ID when it is unknown.
  oauth_client_name: string;
  // The kind, the name (webhook and queue) and the host (mcp and webhook) of the destination; all null when it is
  // not found.
  destination_kind: SubscriptionKind | null;
  destination_name: string | null;
  callback_host: string | null;
  // Nothing is delivered to a destination that is not active.
  destination_status: SubscriptionStatus | null;
};

export type ConversationDetail = Omit<Conversation, "participants"> & { participants: ConversationParticipant[] };

// A message, as the management screen shows it. is_user tells the messages of the user from those of the AIs (a
// participant may have the same name as the user).
export type ConversationMessage = {
  event_id: string;
  sender: string;
  sender_kind: "user" | "ai";
  is_user: boolean;
  // The whole text.
  text: string;
  created_at: number;
};

// The newest messages (older than cursor, if given), oldest first. older_cursor is set when there are older ones.
export type ConversationMessageList = { messages: ConversationMessage[]; older_cursor: string | null };

export type CreateConversationParticipant = { name: string; oauth_client_id: string; subscription_id: string };

// idempotency_key is generated by the screen for each new conversation, and sent again on a retry.
export type CreateConversationRequest = {
  title: string;
  // 1 to 100. Default 20.
  max_ai_messages?: number;
  participants: CreateConversationParticipant[];
  // The first message, from the user.
  message: string;
  idempotency_key: string;
};

// idempotency_key is generated by the screen for each message, and sent again on a retry.
export type PostConversationMessageRequest = { text: string; idempotency_key: string };

export type PostedConversationMessage = { event_id: string; conversation: ConversationDetail };

// An OAuth client that the user has authorized to use MCP.
export type McpConnection = { client_id: string; client_name: string };

export type McpConnectionList = { connections: McpConnection[] };
