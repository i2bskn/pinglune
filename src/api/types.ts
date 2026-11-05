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
  // Whether the source may start conversations with bots (POST /ingest/v1/conversations, Intake.startConversation),
  // with the same fields and ranges as the conversation start settings of a bot.
  conversation_start: ConversationStartSettings;
  // The screening of the events for instructions to AIs (src/screening/). available: the workspace has a TypeSafe API
  // key (whether it can be decrypted is not checked).
  screening: SourceScreening;
  // Whether the email intake checks the sender (the DMARC result of Cloudflare and From). On for a new source, off for
  // the sources made before the check.
  email_sender_verification: boolean;
  // The allowed senders (addresses or domains, normalized), used only while email_sender_verification is on. [] when
  // there are none: every sender that passes DMARC is accepted.
  email_senders: string[];
};

// POST /api/v1/sources/:id/email-sender-verification.
export type UpdateSourceEmailSenderVerificationRequest = { enabled: boolean };

// POST /api/v1/sources/:id/email-senders. Up to 20 elements; an empty list removes them.
export type UpdateSourceEmailSendersRequest = { senders: string[] };

export type SourceScreening = { enabled: boolean; available: boolean };

// POST /api/v1/sources/:id/screening. api_key is required to turn it on in a workspace without a key, and rejected in
// one with a key (the key is changed with PUT /api/v1/screening/api-key).
export type UpdateSourceScreeningRequest = { enabled: boolean; api_key?: string };

// GET /api/v1/screening. The key itself is never returned; hint is its last 4 characters.
export type ScreeningSettings = { api_key: { hint: string } | null };

// PUT /api/v1/screening/api-key.
export type UpdateScreeningApiKeyRequest = { api_key: string };

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

// The number of deliveries of an event by status.
export type DeliverySummary = { delivered: number; pending: number; failed: number };

// An event of GET /api/v1/events. The MCP tools and the polling queues return EventSummary, without the deliveries.
// An interface rather than an intersection, so that hono's JSON typing of the response keeps labels as they are.
export interface EventListItem extends EventSummary {
  delivery_summary: DeliverySummary;
  screening: EventScreening | null;
  // Only for an event of type email.received (any source may send one, not only the email intake); null otherwise.
  email: EventListEmail | null;
}

// from: labels.from, or null. attachment_count: the attachments without the HTML body (body.html).
export type EventListEmail = { from: string | null; attachment_count: number };

export type ScreeningStatus = "pending" | "passed" | "held" | "released";

// The screening of an event, for the management screen only (never for MCP or the webhooks). null: not screened.
// score: 0 to 1, null when it was not scored. error: why it could not be screened (held without a score). retryable:
// the owner may screen it again (POST /api/v1/events/:id/screening/retry).
export type EventScreening = {
  status: ScreeningStatus;
  score: number | null;
  error: string | null;
  retryable: boolean;
  requested_at: number | null;
  screened_at: number | null;
  released_at: number | null;
};

export type EventList = { events: EventListItem[]; next_cursor: string | null };

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

// An event of GET /api/v1/events/:id and of the screening operations: EventDetail with the screening.
export type ManagedEventDetail = EventDetail & { screening: EventScreening | null };

// The header lines of the body of an email.received event, as the body has them (what the message said, not checked).
// All null when the body has no header block that matches the event (src/events/email-view.ts).
export type EmailHeaders = {
  from: string | null;
  to: string | null;
  cc: string | null;
  reply_to: string | null;
  subject: string | null;
  date: string | null;
  message_id: string | null;
};

export type EmailAttachment = { data_ref: string; name: string; content_type: string; size: number };

// GET /api/v1/events/:id/email. text: the text of the body after the header lines, up to 256 KiB (text_truncated);
// null when the body cannot be read. html_only: the message had only an HTML body. html: the HTML body, read as text
// with GET /api/v1/events/:id/email/html. attachments: the data in position order without the body and the HTML body.
export type EmailView = {
  event_id: string;
  source: { id: string; name: string };
  from_address: string | null;
  headers: EmailHeaders;
  text: string | null;
  text_truncated: boolean;
  html_only: boolean;
  html: { data_ref: string; size: number } | null;
  attachments: EmailAttachment[];
};

// GET /api/v1/events/:id/email/html: the first 256 KiB of the HTML body (truncated) converted to text, and as it is.
// text is null when the conversion failed; both are null when the object is missing.
export type EmailHtmlView = { text: string | null; source: string | null; truncated: boolean };

// The response of POST /ingest/v1/events: 201 for a new event, 200 for a retry of an existing one.
export type IngestResponse = { event_id: string; duplicate: boolean };

// POST /ingest/v1/conversations and Intake.startConversation: a conversation started by a source, with the first
// message of the program. participants are the names of the bots to invite, 1 to 5. max_ai_messages: 1 to the limit
// of the source; default that limit.
export type IngestConversationRequest = {
  title: string;
  participants: string[];
  message: string;
  max_ai_messages?: number | null;
  idempotency_key: string;
};

// 201 for a new conversation, 200 for a retry (duplicate true, notified null). notified: whether the bot had a
// destination for the first message.
export type IngestConversationResponse = {
  conversation_id: string;
  title: string;
  status: ConversationStatus;
  max_ai_messages: number;
  ai_message_count: number;
  participants: { name: string; notified: boolean | null }[];
  duplicate: boolean;
};

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
  // The conditions that delivery uses (types, labels); null if the stored value is broken. sources, which an MCP
  // Events subscription may still carry, is left out: the sources of the events are those linked to the bot.
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
  // mcp only: the MCP connection that subscribed last (id is mcp_connections.id), with the name of its bot while the
  // connection is active and assigned to a bot that is not deleted (of any delivery kind). null for webhook and queue,
  // and for the subscriptions of legacy connections.
  connection: { id: string; client_name: string; bot_name: string | null } | null;
  // The bot whose destination this is; events are delivered only to the destinations of bots. webhook / queue: the
  // bot (not deleted) whose delivery_subscription_id it is. mcp: the bot of its connection while the connection is
  // active, the bot is not deleted and its delivery kind is mcp. null otherwise.
  bot: { id: string; name: string } | null;
};

// The conditions (types, labels) are optional; an empty array or object is rejected. sources is not accepted: the
// sources of the events are those linked to the bot that uses the destination. The key is never returned.
export type CreateWebhookDestinationRequest = {
  name: string;
  url: string;
  token: string;
  types?: string[];
  labels?: Record<string, string>;
};

// The conditions are optional, as for webhook destinations.
export type CreateQueueRequest = {
  name: string;
  types?: string[];
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
  // The kind and the name of the subscription; both null when it is not found. For mcp, the name is the app of the
  // connection that subscribed (null for a connection made before connections were recorded).
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

// The event of a delivery, as the lists of the management screen show it. source_name is the name of the source of
// the event (for the messages of conversations, the source of the conversations).
export type DeliveryEvent = { type: string; summary: string; source_name: string };

// A delivery of GET /api/v1/deliveries and of POST /api/v1/deliveries/:id/retry. event is null when the event is not
// found.
export type DeliveryListItem = Delivery & { event: DeliveryEvent | null };

export type DeliveryList = { deliveries: DeliveryListItem[]; next_cursor: string | null };

export type ConversationStatus = "open" | "stopped";

// user: stopped on the management screen. limit: the AIs sent max_ai_messages messages.
export type ConversationStopReason = "user" | "limit";

// Who started a conversation: the user on the management screen, the AI of a bot with start_conversation (MCP), or a
// source of programs (POST /ingest/v1/conversations, Intake.startConversation). For a bot, name is the name of the
// bot's participant (its name when the conversation was started); for a source, the current name of the source. ""
// when it is not found.
export type ConversationStartedBy =
  | { kind: "user" }
  | { kind: "bot"; bot_id: string; name: string }
  | { kind: "source"; source_id: string; name: string };

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
  started_by: ConversationStartedBy;
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
  // delivery_kind: how the bot is notified (null when the bot row is gone), so that a missing destination can be
  // explained (an mcp bot without an active subscription is 未購読).
  bot: { id: string; name: string; deleted: boolean; delivery_kind: BotDeliveryKind | null } | null;
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
// participant may have the same name as the user). program: the first message of a conversation started by a source.
export type ConversationMessage = {
  event_id: string;
  sender: string;
  sender_kind: "user" | "ai" | "program";
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
  // The sources whose events the bot receives, by name. Disabled sources are listed (enabled false). Empty: the bot
  // receives no events (it still takes part in conversations).
  sources: { id: string; name: string; enabled: boolean }[];
  conversation_start: BotConversationStart;
  created_at: number;
  updated_at: number;
};

// Whether a bot or a source may start conversations. daily_limit: 1 to 1000, the conversations it may start in the
// last 24 hours. max_ai_messages: 1 to 100, the default and the maximum of the limit of AI messages of the
// conversations it starts. A new bot or source has { enabled: false, daily_limit: 10, max_ai_messages: 10 }.
export type ConversationStartSettings = { enabled: boolean; daily_limit: number; max_ai_messages: number };

// The conversation start settings of a bot: whether its AI may start conversations with other bots
// (start_conversation, MCP).
export type BotConversationStart = ConversationStartSettings;

// POST /api/v1/bots/:id/conversation-start. All three fields are required.
export type UpdateBotConversationStartRequest = BotConversationStart;

// POST /api/v1/sources/:id/conversation-start. All three fields are required, as for a bot.
export type UpdateSourceConversationStartRequest = ConversationStartSettings;

export type BotList = { bots: Bot[] };

// A bot with the destination it refers to (delivery_subscription_id), as GET /api/v1/bots/:id returns it.
// destination is returned even when it has ended (status "unsubscribed"); null for mcp. arguments are the conditions
// that delivery uses, as in Subscription.
export type BotDetail = Bot & {
  destination: {
    subscription_id: string;
    kind: "webhook" | "queue";
    name: string | null;
    callback_host: string | null;
    status: SubscriptionStatus;
    arguments: Record<string, unknown> | null;
  } | null;
};

// The conditions of a webhook destination or a polling queue made with a bot. {} (or no field) means every event.
export type DestinationConditions = { types?: string[]; labels?: Record<string, string> };

// The webhook destination made with a bot: its URL and Bearer key, checked as POST /api/v1/subscriptions/webhooks.
export type BotWebhookRequest = { url: string; token: string };

// webhook / queue: a new destination named after the bot is made in the same batch, unless delivery_subscription_id
// names an existing one. webhook needs exactly one of webhook and delivery_subscription_id; queue makes a new queue
// without delivery_subscription_id. mcp takes none of webhook, conditions and delivery_subscription_id. conditions
// apply to a new destination only.
// source_ids: the sources (of programs, in the workspace) whose events the bot receives, up to 100. Default none.
export type CreateBotRequest = {
  name: string;
  delivery_kind: BotDeliveryKind;
  delivery_subscription_id?: string;
  webhook?: BotWebhookRequest;
  conditions?: DestinationConditions;
  source_ids?: string[];
};

// At least one field. delivery_kind changes the destination: to delivery_subscription_id if given, to a new webhook
// destination with webhook, to a new queue for queue without either, to none for mcp (null or no
// delivery_subscription_id). webhook alone makes a new webhook destination for a webhook bot. conditions alone changes
// the conditions of the current webhook / queue destination; with a new destination, they are its conditions.
// A change of the destination ends the previous webhook / queue destination. source_ids replaces the linked sources;
// left out, they stay.
export type UpdateBotRequest = {
  name?: string;
  delivery_kind?: BotDeliveryKind;
  delivery_subscription_id?: string | null;
  webhook?: BotWebhookRequest;
  conditions?: DestinationConditions;
  source_ids?: string[];
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
