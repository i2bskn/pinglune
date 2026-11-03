import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name"),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    passwordHash: text("password_hash"),
    oidcIssuer: text("oidc_issuer"),
    oidcSubject: text("oidc_subject"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastLoginAt: integer("last_login_at"),
  },
  (t) => [
    uniqueIndex("users_oidc_issuer_subject_unique").on(t.oidcIssuer, t.oidcSubject),
    check("users_role_check", sql`${t.role} IN ('admin', 'member')`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    familyId: text("family_id").notNull(),
    authMode: text("auth_mode", { enum: ["oidc", "password"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    familyExpiresAt: integer("family_expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    rotatedAt: integer("rotated_at"),
    rotatedTo: text("rotated_to"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_family_id_idx").on(t.familyId),
    check("sessions_auth_mode_check", sql`${t.authMode} IN ('oidc', 'password')`),
  ],
);

// Every user has one personal workspace, created in the same batch as the user. "shared" is allowed by
// the CHECK constraints only, for future shared workspaces; nothing creates one yet.
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["personal", "shared"] }).notNull(),
    // NULL only for personal workspaces; clients decide their display name.
    name: text("name"),
    // Set only for personal workspaces. Not deleted in cascade.
    ownerUserId: text("owner_user_id").references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // One personal workspace per user. NULLs do not conflict.
    uniqueIndex("workspaces_owner_user_id_unique").on(t.ownerUserId),
    // Names are unique across shared workspaces, compared exactly.
    uniqueIndex("workspaces_name_unique").on(t.name),
    check("workspaces_kind_check", sql`${t.kind} IN ('personal', 'shared')`),
    check(
      "workspaces_personal_check",
      sql`(${t.kind} = 'personal') = (${t.ownerUserId} IS NOT NULL) AND (${t.kind} = 'personal') = (${t.name} IS NULL)`,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;

// A program that sends events into a workspace. Sources are never deleted (events refer to them); they are
// disabled instead.
// kind "conversation" is the hidden source of the messages of conversations (src/conversations/): one per workspace,
// created when it is first needed. It is never listed, never matched by the management API, the API keys, the email
// addresses or Service Bindings, and its name does not take a name from the user's sources.
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // Trimmed. Case-sensitive.
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // Checked by the application only: a CHECK constraint would rebuild the table. Existing rows are programs.
    kind: text("kind", { enum: ["program", "conversation"] }).notNull().default("program"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // Names are unique among the user's sources only. The condition is a literal: a bound value would not work in
    // the index definition.
    uniqueIndex("sources_workspace_id_name_unique")
      .on(t.workspaceId, t.name)
      .where(sql`${t.kind} = 'program'`),
    // One conversation source per workspace.
    uniqueIndex("sources_workspace_conversation_unique")
      .on(t.workspaceId)
      .where(sql`${t.kind} = 'conversation'`),
  ],
);

// API keys of the HTTP intake. The key is pl_<id>_<secret>; only the SHA-256 of the secret is stored.
export const apiKeys = sqliteTable(
  "api_keys",
  {
    // keyId: 16 lowercase letters and digits.
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    // SHA-256 of the secret, lowercase hex.
    secretHash: text("secret_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("api_keys_source_id_idx").on(t.sourceId)],
);

// Addresses of the email intake (src/intake/email.ts): <id>@<EMAIL_DOMAIN>. The domain is not stored, so the
// addresses keep working when EMAIL_DOMAIN changes. Rows are revoked rather than deleted, except when the user is
// deleted.
export const emailAddresses = sqliteTable(
  "email_addresses",
  {
    // The local part: 20 lowercase letters and digits.
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    createdAt: integer("created_at").notNull(),
    lastReceivedAt: integer("last_received_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("email_addresses_source_id_idx").on(t.sourceId)],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    type: text("type").notNull(),
    summary: text("summary").notNull(),
    // A JSON object of strings. "{}" when there are no labels.
    labels: text("labels").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    receivedAt: integer("received_at").notNull(),
    // The conversation of a message (src/conversations/). NULL for the events of programs; the event lists show
    // only those.
    conversationId: text("conversation_id").references(() => conversations.id),
  },
  (t) => [
    uniqueIndex("events_source_idempotency_unique").on(t.sourceId, t.idempotencyKey),
    // The cursor of the list. ULIDs are in time order.
    index("events_workspace_id_id_idx").on(t.workspaceId, t.id),
    // The history of a conversation, in time order.
    index("events_conversation_id_id_idx").on(t.conversationId, t.id),
  ],
);

// The body and the attachments of an event, stored in R2. The id is the data_ref.
export const eventData = sqliteTable(
  "event_data",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    role: text("role", { enum: ["body", "attachment"] }).notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    r2Key: text("r2_key").notNull(),
    // 0 for the body, 1.. for the attachments in the order they were sent.
    position: integer("position").notNull(),
  },
  (t) => [
    index("event_data_event_id_idx").on(t.eventId),
    check("event_data_role_check", sql`${t.role} IN ('body', 'attachment')`),
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type EmailAddressRow = typeof emailAddresses.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type EventDataRow = typeof eventData.$inferSelect;

// The destinations of pinglune.event deliveries, of three kinds:
// - mcp: MCP Events subscriptions (events/subscribe). The id is derived from the user, the callback URL, the event
//   name and the arguments, so that the same subscription is an update. Signed with Standard Webhooks.
// - webhook: webhook destinations registered on the management screen (src/routes/subscriptions.ts). The id is
//   random, the secret is a Bearer key, and expires_at is NO_EXPIRY.
// - queue: polling queues registered on the management screen. Nothing is sent: an AI takes the deliveries with
//   the claim_events and ack_events MCP tools (src/queues/). The id is random, callback_url and secret are empty,
//   and expires_at is NO_EXPIRY.
// Rows are ended with unsubscribed_at rather than deleted (deliveries refer to them), except when the user is
// deleted. Active: unsubscribed_at IS NULL AND expires_at > now.
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    eventName: text("event_name").notNull(),
    // Checked by the application only: a CHECK constraint would rebuild the table. The default keeps the inserts
    // of the code before this column working while a deploy applies the migration first.
    kind: text("kind", { enum: ["mcp", "webhook", "queue"] }).notNull().default("mcp"),
    // The display name of a webhook destination or a polling queue (trimmed, 1 to 64 characters). NULL for mcp.
    name: text("name"),
    // Canonical JSON of the validated arguments. "{}" when there are none.
    arguments: text("arguments").notNull(),
    // new URL(url).href. "" for queue, which sends nothing.
    callbackUrl: text("callback_url").notNull(),
    // mcp: the signing secret; webhook: the Bearer key as UTF-8. Encrypted (src/subscriptions/secret.ts). "" for
    // queue, which has no key.
    secret: text("secret").notNull(),
    // The secret before the last rotation, encrypted. Deliveries also sign with it for 1 hour after
    // secret_rotated_at, so that the receiver can switch keys.
    previousSecret: text("previous_secret"),
    secretRotatedAt: integer("secret_rotated_at"),
    // mcp: refreshBefore + 1 hour of grace. webhook and queue: NO_EXPIRY.
    expiresAt: integer("expires_at").notNull(),
    unsubscribedAt: integer("unsubscribed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // mcp only: the MCP connection (mcp_connections.id) that subscribed last. NULL for the other kinds, and for the
    // subscriptions of connections made before MCP connections were recorded. No foreign key, like oauth_client_id
    // elsewhere: bots.delivery_subscription_id refers to this table, and the reference would go round.
    connectionId: text("connection_id"),
  },
  (t) => [
    index("subscriptions_workspace_id_idx").on(t.workspaceId),
    index("subscriptions_user_id_idx").on(t.userId),
    index("subscriptions_connection_id_idx").on(t.connectionId),
  ],
);

export type SubscriptionRow = typeof subscriptions.$inferSelect;

// One delivery of an event to a subscription (pinglune.event webhooks, or a polling queue). Created with the event,
// in the same D1 batch. Rows are deleted only with the workspace (deleteUser).
// For a polling queue: attempts is the number of claims, last_attempt_at the time of the last claim (the start of
// the lease), delivered_at the time of the ack, and last_http_status is always NULL.
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    // The workspace of the event.
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    status: text("status", { enum: ["pending", "delivered", "failed"] }).notNull(),
    // The number of sends tried.
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: integer("last_attempt_at"),
    // The HTTP status of the last response.
    lastHttpStatus: integer("last_http_status"),
    // The reason of the last failure.
    lastError: text("last_error"),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("deliveries_event_subscription_unique").on(t.eventId, t.subscriptionId),
    // The cursor of the list.
    index("deliveries_workspace_id_id_idx").on(t.workspaceId, t.id),
    // The daily check of stale pending deliveries.
    index("deliveries_status_created_at_idx").on(t.status, t.createdAt),
    index("deliveries_subscription_id_idx").on(t.subscriptionId),
    check("deliveries_status_check", sql`${t.status} IN ('pending', 'delivered', 'failed')`),
  ],
);

export type DeliveryRow = typeof deliveries.$inferSelect;

// A conversation between AIs (and the user) whose messages are events (events.conversation_id). Each message is
// delivered to the destinations of the other participants only. A conversation stops when the AIs have sent
// max_ai_messages messages, or when the user stops it; it is never resumed. Rows are deleted only with the user.
export const conversations = sqliteTable(
  "conversations",
  {
    // cnv_ + ULID.
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // Trimmed, 1 to 64 characters (normalizeDisplayName).
    title: text("title").notNull(),
    status: text("status", { enum: ["open", "stopped"] }).notNull(),
    // NULL while open.
    stopReason: text("stop_reason", { enum: ["user", "limit"] }),
    // 1 to 100.
    maxAiMessages: integer("max_ai_messages").notNull(),
    // The messages of the AIs accepted so far. The messages of the user are not counted.
    aiMessageCount: integer("ai_message_count").notNull().default(0),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    stoppedAt: integer("stopped_at"),
  },
  (t) => [
    // The cursor of the list.
    index("conversations_workspace_id_id_idx").on(t.workspaceId, t.id),
    check("conversations_status_check", sql`${t.status} IN ('open', 'stopped')`),
    check("conversations_stop_reason_check", sql`${t.stopReason} IS NULL OR ${t.stopReason} IN ('user', 'limit')`),
  ],
);

// An AI in a conversation. A participant created with a bot (bot_id) is matched with the MCP connection of the bot
// and notified at the destination of the bot, both resolved when they are needed (src/bots/queries.ts). A participant
// created before bots (bot_id NULL) is matched with its OAuth client and notified at its subscription. Set when the
// conversation is created, and never changed.
// The table was rebuilt to make oauth_client_id and subscription_id nullable: an exception to avoiding rebuilds,
// because a placeholder value would break the meaning of these columns.
export const conversationParticipants = sqliteTable(
  "conversation_participants",
  {
    // cpt_ + ULID.
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // The display name, unique in the conversation. For a bot, a copy of its name when the conversation was created.
    name: text("name").notNull(),
    // Participants before bots: ctx.auth.clientId of the MCP requests of this AI. NULL for bots.
    oauthClientId: text("oauth_client_id"),
    // Participants before bots: a subscription of kind mcp, webhook or queue. Nothing is delivered to it once it has
    // ended. NULL for bots.
    subscriptionId: text("subscription_id").references(() => subscriptions.id),
    botId: text("bot_id").references(() => bots.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // Also the index of the participants of a conversation.
    uniqueIndex("conversation_participants_client_unique").on(t.conversationId, t.oauthClientId),
    uniqueIndex("conversation_participants_name_unique").on(t.conversationId, t.name),
    uniqueIndex("conversation_participants_bot_unique").on(t.conversationId, t.botId),
    check(
      "conversation_participants_target_check",
      sql`${t.botId} IS NOT NULL OR (${t.oauthClientId} IS NOT NULL AND ${t.subscriptionId} IS NOT NULL)`,
    ),
  ],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationParticipantRow = typeof conversationParticipants.$inferSelect;

// An AI as the user manages it: a name, the way it is notified, and (through mcp_connections.bot_id) the MCP
// connection it speaks with. Conversations take bots as participants. Deleted with deleted_at (participants refer to
// it), except when the user is deleted.
// - mcp: notified at the MCP Events subscription of its connection (subscriptions.connection_id).
// - webhook / queue: notified at delivery_subscription_id, a webhook destination or a polling queue.
export const bots = sqliteTable(
  "bots",
  {
    // bot_ + ULID.
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    // Trimmed, 1 to 64 characters (normalizeDisplayName). Unique among the bots of the workspace that are not deleted.
    name: text("name").notNull(),
    deliveryKind: text("delivery_kind", { enum: ["mcp", "webhook", "queue"] }).notNull(),
    // webhook / queue only. One destination is used by one bot.
    deliverySubscriptionId: text("delivery_subscription_id").references(() => subscriptions.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    uniqueIndex("bots_workspace_name_unique")
      .on(t.workspaceId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex("bots_delivery_subscription_unique")
      .on(t.deliverySubscriptionId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.deliverySubscriptionId} IS NOT NULL`),
    index("bots_workspace_id_idx").on(t.workspaceId),
    check("bots_delivery_kind_check", sql`${t.deliveryKind} IN ('mcp', 'webhook', 'queue')`),
    check(
      "bots_delivery_subscription_check",
      sql`(${t.deliveryKind} = 'mcp' AND ${t.deliverySubscriptionId} IS NULL) OR (${t.deliveryKind} IN ('webhook', 'queue') AND ${t.deliverySubscriptionId} IS NOT NULL)`,
    ),
  ],
);

// One authorization of an MCP client (one OAuth grant). A grant made by POST /authorize carries the ID in its
// metadata and props (connectionId); a grant made before this table (a legacy connection) gets a row when the user
// assigns it to a bot, with grant_id. Rows are revoked rather than deleted, except when the user is deleted.
export const mcpConnections = sqliteTable(
  "mcp_connections",
  {
    // mcn_ + ULID.
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // NULL: not assigned to a bot.
    botId: text("bot_id").references(() => bots.id),
    // Legacy connections only: the grant. New connections are found by the connectionId of the grant's metadata.
    grantId: text("grant_id"),
    oauthClientId: text("oauth_client_id").notNull(),
    // The client name when it was authorized (clientName()).
    clientName: text("client_name").notNull(),
    // The redirect URI of the authorization request. "" when a legacy grant does not have one.
    redirectUri: text("redirect_uri").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    revokedAt: integer("revoked_at"),
    // user: disconnected on the screen. replaced: a newer connection of the same bot or the same app took its place.
    // sessions_revoked: a password change or the revocation of every session.
    revokeReason: text("revoke_reason", { enum: ["user", "replaced", "sessions_revoked"] }),
  },
  (t) => [
    // One active connection per bot.
    uniqueIndex("mcp_connections_active_bot_unique")
      .on(t.botId)
      .where(sql`${t.revokedAt} IS NULL AND ${t.botId} IS NOT NULL`),
    uniqueIndex("mcp_connections_grant_unique")
      .on(t.grantId)
      .where(sql`${t.grantId} IS NOT NULL`),
    index("mcp_connections_user_id_idx").on(t.userId),
    check(
      "mcp_connections_revoke_reason_check",
      sql`${t.revokeReason} IS NULL OR ${t.revokeReason} IN ('user', 'replaced', 'sessions_revoked')`,
    ),
    check("mcp_connections_revoked_check", sql`(${t.revokedAt} IS NULL) = (${t.revokeReason} IS NULL)`),
  ],
);

export type BotRow = typeof bots.$inferSelect;
export type McpConnectionRow = typeof mcpConnections.$inferSelect;
