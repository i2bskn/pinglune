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
  // mcp only: the MCP connection that subscribed last, with the name of its bot while the connection is active and
  // assigned to a bot that is not deleted. null for webhook and queue, and for the subscriptions of legacy connections.
  connection: { client_name: string; bot_name: string | null } | null;
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

// An AI in a conversation. bot is null for a participant created before bots, whose connection_client_name is its
// OAuth client ID and whose destination is its subscription (whatever its state).
export type ConversationParticipant = {
  // The name when the conversation was created.
  name: string;
  // name is the current name of the bot.
  bot: { id: string; name: string; deleted: boolean } | null;
  // Bots: the client_name of the active MCP connection of the bot (null without one).
  connection_client_name: string | null;
  // Bots: the destination resolved now (null without one). Nothing is delivered to a destination that is not active.
  destination: {
    kind: SubscriptionKind;
    // The name of a webhook destination or a polling queue.
    name: string | null;
    // The host of mcp and webhook destinations.
    callback_host: string | null;
    status: SubscriptionStatus;
  } | null;
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

export type CreateConversationParticipant = { bot_id: string };

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

export type BotDeliveryKind = "mcp" | "webhook" | "queue";

// ready: it has an MCP connection and a destination. no_connection takes precedence over no_delivery. Decided from D1
// only: a connection whose grant has expired is still counted (the screen compares with the MCP connections).
export type BotStatus = "ready" | "no_connection" | "no_delivery";

// An AI as the user manages it: a name, an MCP connection and a destination. Times are UNIX time in milliseconds.
export type Bot = {
  id: string;
  name: string;
  delivery_kind: BotDeliveryKind;
  // The destination resolved now: the subscription of webhook and queue, or for mcp the newest active MCP Events
  // subscription of its connection. null when there is none (or it is not active).
  delivery: {
    subscription_id: string;
    name: string | null;
    callback_host: string | null;
    status: SubscriptionStatus;
  } | null;
  // The active MCP connection assigned to the bot.
  connection: { id: string; client_name: string; redirect_host: string; created_at: number } | null;
  status: BotStatus;
  created_at: number;
  updated_at: number;
};

export type BotList = { bots: Bot[] };

// delivery_subscription_id: required for webhook and queue (a destination of that kind), absent for mcp.
export type CreateBotRequest = {
  name: string;
  delivery_kind: BotDeliveryKind;
  delivery_subscription_id?: string;
};

// At least one field. Changing delivery_kind needs delivery_subscription_id too (null for mcp).
export type UpdateBotRequest = {
  name?: string;
  delivery_kind?: BotDeliveryKind;
  delivery_subscription_id?: string | null;
};

// active: a recorded connection with its grant. legacy: a grant made before connections were recorded, not assigned
// yet. expired: a recorded connection whose grant is gone (expired or revoked elsewhere). stale: a grant whose
// connection is revoked or was never recorded.
export type McpConnectionKind = "active" | "legacy" | "expired" | "stale";

// An authorization of an MCP client.
export type McpConnection = {
  kind: McpConnectionKind;
  // active / expired: the ID of the connection. legacy / stale: null.
  id: string | null;
  // legacy / stale: the ID of the grant. active / expired: null.
  grant_id: string | null;
  client_name: string;
  // The host of the redirect URI; "" when it is unknown.
  redirect_host: string;
  // active / expired only. null when it is not assigned or the bot is deleted.
  bot: { id: string; name: string } | null;
  // UNIX time in milliseconds.
  created_at: number;
};

export type McpConnectionList = { connections: McpConnection[] };

// Exactly one of connection_id and grant_id. bot_id null removes the assignment.
export type AssignMcpConnectionRequest = {
  connection_id?: string;
  grant_id?: string;
  bot_id: string | null;
};

// Exactly one of connection_id and grant_id.
export type RevokeMcpConnectionRequest = { connection_id?: string; grant_id?: string };
