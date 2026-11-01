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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("sources_workspace_id_name_unique").on(t.workspaceId, t.name)],
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
  },
  (t) => [
    uniqueIndex("events_source_idempotency_unique").on(t.sourceId, t.idempotencyKey),
    // The cursor of the list. ULIDs are in time order.
    index("events_workspace_id_id_idx").on(t.workspaceId, t.id),
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

// The destinations of pinglune.event webhooks, of two kinds:
// - mcp: MCP Events subscriptions (events/subscribe). The id is derived from the user, the callback URL, the event
//   name and the arguments, so that the same subscription is an update. Signed with Standard Webhooks.
// - webhook: webhook destinations registered on the management screen (src/routes/subscriptions.ts). The id is
//   random, the secret is a Bearer key, and expires_at is NO_EXPIRY.
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
    kind: text("kind", { enum: ["mcp", "webhook"] }).notNull().default("mcp"),
    // The display name of a webhook destination (trimmed, 1 to 64 characters). NULL for mcp.
    name: text("name"),
    // Canonical JSON of the validated arguments. "{}" when there are none.
    arguments: text("arguments").notNull(),
    // new URL(url).href.
    callbackUrl: text("callback_url").notNull(),
    // mcp: the signing secret; webhook: the Bearer key as UTF-8. Encrypted (src/subscriptions/secret.ts).
    secret: text("secret").notNull(),
    // The secret before the last rotation, encrypted. Deliveries also sign with it for 1 hour after
    // secret_rotated_at, so that the receiver can switch keys.
    previousSecret: text("previous_secret"),
    secretRotatedAt: integer("secret_rotated_at"),
    // mcp: refreshBefore + 1 hour of grace. webhook: NO_EXPIRY.
    expiresAt: integer("expires_at").notNull(),
    unsubscribedAt: integer("unsubscribed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("subscriptions_workspace_id_idx").on(t.workspaceId),
    index("subscriptions_user_id_idx").on(t.userId),
  ],
);

export type SubscriptionRow = typeof subscriptions.$inferSelect;

// One delivery of an event to a subscription (pinglune.event webhooks). Created with the event, in the same D1
// batch. Rows are deleted only with the workspace (deleteUser).
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
