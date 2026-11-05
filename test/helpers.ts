import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createDb } from "@i2bskn/workers-app-core";
import {
  createTestHelpers,
  TEST_JWT_SECRET,
  type RequestOptions as CoreRequestOptions,
  type SessionCookies as CoreSessionCookies,
} from "@i2bskn/workers-app-core/testing";
import * as schema from "../src/db/schema";
import {
  apiKeys,
  emailAddresses,
  sources,
  subscriptions,
  workspaces,
  type SourceRow,
  type SubscriptionRow,
  type UserRow,
  type WorkspaceRow,
} from "../src/db/schema";
import type { DeliveryMessage } from "../src/deliveries/enqueue";
import type { Bindings } from "../src/env";
import worker from "../src/index";
import {
  formatApiKey,
  newBotId,
  newConversationId,
  newEmailLocalPart,
  newKeyId,
  newKeySecret,
  newMcpConnectionId,
  newSourceId,
  sha256Hex,
} from "../src/ids";
import { NO_EXPIRY } from "../src/subscriptions/queries";
import { encryptSecret, subscriptionSecretKey } from "../src/subscriptions/secret";
import { insertPersonalWorkspaceStatement } from "../src/workspaces/queries";

// From the test helpers of @i2bskn/workers-app-core. TEST_JWT_SECRET is the JWT_SECRET of vitest.config.ts, which the
// subscription secrets are encrypted with.
export {
  D1_MAX_BOUND_VALUES,
  PASSWORD,
  TEST_JWT_SECRET,
  type LargeBind,
  type SetCookie,
} from "@i2bskn/workers-app-core/testing";

export const ORIGIN = "https://pinglune.test";
export const OIDC_ORIGIN = "https://wiki.example.com";

// Login, users and requests through the Worker entry point (OAuthProvider), like production.
const helpers = createTestHelpers({
  worker,
  env,
  createExecutionContext,
  waitOnExecutionContext,
  brandId: "pinglune",
  origin: ORIGIN,
});

export const { send, setCookies, sessionCookies, login, d1With, countTable, dbChangingBefore, d1RecordingLargeBinds } =
  helpers;

export type RequestOptions = CoreRequestOptions<Cloudflare.Env>;
export type SessionCookies = CoreSessionCookies<"pinglune">;

// With the schema of pinglune, for db.query.* in the tests.
export const db = drizzle(env.DB, { schema });
// Without a schema, like the Db of the app: for the src functions that take a Db.
export const appDb = createDb(env.DB);

export async function resetDb(): Promise<void> {
  // Children first; then the package deletes sessions and users.
  await helpers.resetDb([
    "deliveries",
    "event_data",
    "events",
    "conversation_participants",
    "conversations",
    "mcp_connections",
    "bot_sources",
    "bots",
    "api_keys",
    "email_addresses",
    "sources",
    "subscriptions",
    "workspaces",
  ]);
}

// Deletes every object of the EVENT_DATA bucket.
export async function resetEventData(): Promise<void> {
  for (;;) {
    const listed = await env.EVENT_DATA.list();
    if (listed.objects.length === 0) return;
    await env.EVENT_DATA.delete(listed.objects.map((object) => object.key));
  }
}

export async function listEventDataKeys(prefix?: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const listed = await env.EVENT_DATA.list({ prefix, cursor });
    keys.push(...listed.objects.map((object) => object.key));
    if (!listed.truncated) return keys.sort();
    cursor = listed.cursor;
  }
}

// The default allowlist of the OIDC tests: a domain (not "*"), so that the domain match is exercised end to
// end. Every email that the tests sign in with through OIDC is in this domain.
export const OIDC_ALLOWED_EMAILS = "example.com";

export const oidcEnv: Partial<Bindings> = {
  AUTH_MODE: "oidc",
  APP_ORIGIN: OIDC_ORIGIN,
  OIDC_ISSUER: "https://idp.example.com",
  OIDC_CLIENT_ID: "pinglune-client",
  OIDC_CLIENT_SECRET: "client-secret",
  ALLOWED_EMAILS: OIDC_ALLOWED_EMAILS,
};

// A user with their personal workspace, created in one batch like the userCreatedStatements hook of src/core.ts.
export function createUser(params: {
  email: string;
  role?: "admin" | "member";
  password?: string | null;
  createdAt?: number;
}): Promise<UserRow> {
  return helpers.createUser({
    ...params,
    userCreatedStatements: (d1, id, now) => [insertPersonalWorkspaceStatement(d1, id, now)],
  });
}

export async function countWorkspaces(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces").first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countPersonalWorkspaces(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM workspaces WHERE kind = 'personal' AND owner_user_id = ?",
  )
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// Inserts open conversations of the user's personal workspace directly, started by the bot (or on the screen with
// null).
export async function insertOpenConversations(
  user: UserRow,
  count: number,
  startedByBotId: string | null,
  now = Date.now(),
): Promise<void> {
  const workspaceId = (await personalWorkspaceOf(user)).id;
  for (let i = 0; i < count; i++) {
    await env.DB.prepare(
      `INSERT INTO conversations (id, workspace_id, title, status, max_ai_messages, ai_message_count, created_by_user_id,
        started_by_bot_id, created_at, updated_at)
      VALUES (?, ?, 'open', 'open', 10, 0, ?, ?, ?, ?)`,
    )
      .bind(newConversationId(now), workspaceId, user.id, startedByBotId, now, now)
      .run();
  }
}

export async function personalWorkspaceOf(user: UserRow): Promise<WorkspaceRow> {
  const workspace = await db.select().from(workspaces).where(eq(workspaces.ownerUserId, user.id)).get();
  if (!workspace) throw new Error("personal workspace not found");
  return workspace;
}

// Inserts a source directly. id defaults to a new source ID.
export async function createSource(params: {
  workspaceId: string;
  name: string;
  enabled?: boolean;
  id?: string;
  createdAt?: number;
}): Promise<SourceRow> {
  const now = params.createdAt ?? Date.now();
  const [source] = await db
    .insert(sources)
    .values({
      id: params.id ?? newSourceId(now),
      workspaceId: params.workspaceId,
      name: params.name,
      enabled: params.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!source) throw new Error("failed to create source");
  return source;
}

// Inserts an API key directly and returns its plain key. secret defaults to a new random one.
export async function createApiKey(
  sourceId: string,
  options: { secret?: string; keyId?: string; revokedAt?: number } = {},
): Promise<{ keyId: string; key: string }> {
  const keyId = options.keyId ?? newKeyId();
  const secret = options.secret ?? newKeySecret();
  await db
    .insert(apiKeys)
    .values({
      id: keyId,
      sourceId,
      secretHash: await sha256Hex(secret),
      createdAt: Date.now(),
      revokedAt: options.revokedAt ?? null,
    })
    .run();
  return { keyId, key: formatApiKey(keyId, secret) };
}

// Inserts an intake email address directly and returns its local part.
export async function createEmailAddress(
  sourceId: string,
  options: { localPart?: string; createdAt?: number; revokedAt?: number } = {},
): Promise<string> {
  const localPart = options.localPart ?? newEmailLocalPart();
  await db
    .insert(emailAddresses)
    .values({ id: localPart, sourceId, createdAt: options.createdAt ?? Date.now(), revokedAt: options.revokedAt ?? null })
    .run();
  return localPart;
}

// An R2 binding with some methods replaced, e.g. put.
export function bucketWith(overrides: Partial<Record<keyof R2Bucket, unknown>>): R2Bucket {
  return new Proxy(env.EVENT_DATA, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop as keyof R2Bucket];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// A delivery queue that records the messages sent to it. fail makes sendBatch (and send) throw.
export type FakeQueue = Queue<DeliveryMessage> & { messages: DeliveryMessage[]; fail: boolean };

export function fakeQueue(): FakeQueue {
  const queue = {
    messages: [] as DeliveryMessage[],
    fail: false,
    async send(body: DeliveryMessage) {
      if (queue.fail) throw new Error("queue is down");
      queue.messages.push(body);
    },
    async sendBatch(messages: Iterable<MessageSendRequest<DeliveryMessage>>) {
      if (queue.fail) throw new Error("queue is down");
      for (const message of messages) queue.messages.push(message.body);
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  };
  return queue as unknown as FakeQueue;
}

let subscriptionSequence = 0;

// Inserts a pinglune.event subscription directly, with its secret encrypted as events/subscribe stores it.
// workspaceId defaults to the user's personal workspace; expiresAt to one day from now; kind to "mcp". For a
// webhook destination, pass kind "webhook" and the Bearer key as UTF-8 bytes in secret.
export async function createSubscription(params: {
  user: UserRow;
  kind?: "mcp" | "webhook";
  name?: string | null;
  workspaceId?: string;
  callbackUrl?: string;
  arguments?: string;
  // Any view: TextEncoder returns Uint8Array<ArrayBufferLike>, but Workers have no SharedArrayBuffer.
  secret?: Uint8Array;
  previousSecret?: Uint8Array<ArrayBuffer> | null;
  secretRotatedAt?: number | null;
  expiresAt?: number;
  unsubscribedAt?: number | null;
  createdAt?: number;
  eventName?: string;
}): Promise<SubscriptionRow> {
  subscriptionSequence++;
  const id = `sub_${subscriptionSequence.toString(16).padStart(32, "0")}`;
  const now = params.createdAt ?? Date.now();
  const key = await subscriptionSecretKey(TEST_JWT_SECRET);
  const secret = (params.secret ?? crypto.getRandomValues(new Uint8Array(32))) as Uint8Array<ArrayBuffer>;
  const [row] = await db
    .insert(subscriptions)
    .values({
      id,
      userId: params.user.id,
      workspaceId: params.workspaceId ?? (await personalWorkspaceOf(params.user)).id,
      kind: params.kind ?? "mcp",
      name: params.name ?? null,
      eventName: params.eventName ?? "pinglune.event",
      arguments: params.arguments ?? "{}",
      callbackUrl: params.callbackUrl ?? "https://hooks.example.com/pinglune",
      secret: await encryptSecret(key, id, secret),
      previousSecret:
        params.previousSecret === undefined || params.previousSecret === null
          ? null
          : await encryptSecret(key, id, params.previousSecret),
      secretRotatedAt: params.secretRotatedAt ?? null,
      expiresAt: params.expiresAt ?? now + 24 * 60 * 60 * 1000,
      unsubscribedAt: params.unsubscribedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("failed to create subscription");
  return row;
}

let queueSequence = 0;

// Inserts a polling queue directly, as POST /api/v1/subscriptions/queues stores it. workspaceId defaults to the
// user's personal workspace.
export async function createQueue(params: {
  user: UserRow;
  name?: string;
  workspaceId?: string;
  arguments?: string;
  unsubscribedAt?: number | null;
  createdAt?: number;
}): Promise<SubscriptionRow> {
  queueSequence++;
  const id = `sub_${queueSequence.toString(16).padStart(32, "f")}`;
  const now = params.createdAt ?? Date.now();
  const [row] = await db
    .insert(subscriptions)
    .values({
      id,
      userId: params.user.id,
      workspaceId: params.workspaceId ?? (await personalWorkspaceOf(params.user)).id,
      kind: "queue",
      name: params.name ?? "queue",
      eventName: "pinglune.event",
      arguments: params.arguments ?? "{}",
      callbackUrl: "",
      secret: "",
      previousSecret: null,
      secretRotatedAt: null,
      expiresAt: NO_EXPIRY,
      unsubscribedAt: params.unsubscribedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("failed to create queue");
  return row;
}

export type DeliveryRecord = {
  id: string;
  event_id: string;
  subscription_id: string;
  workspace_id: string;
  status: string;
  attempts: number;
  last_attempt_at: number | null;
  last_http_status: number | null;
  last_error: string | null;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
};

export async function listDeliveries(where = "1 = 1", ...values: unknown[]): Promise<DeliveryRecord[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM deliveries WHERE ${where} ORDER BY id`)
    .bind(...values)
    .all<DeliveryRecord>();
  return results;
}

let botSequence = 0;

// Makes destinations receive the events of sources, as the user sets it up on the screen: a bot that delivers to
// them, linked to the sources. The bot is created in the workspace of the first subscription, by the workspace's owner.
// - webhook / queue: one subscription, the bot's delivery_subscription_id.
// - mcp: one or more subscriptions; an active MCP connection is created for the bot and recorded on them.
// With connect, an active MCP connection is created for a webhook or queue bot too, for its AI to call the tools.
// Returns the IDs of the bot and of the connection (null for webhook and queue without connect).
export async function routeToBot(
  destinations: SubscriptionRow | SubscriptionRow[],
  sourceIds: string[],
  options: { name?: string; connect?: boolean } = {},
): Promise<{ botId: string; connectionId: string | null }> {
  const rows = Array.isArray(destinations) ? destinations : [destinations];
  const [first] = rows;
  if (first === undefined) throw new Error("no destination");
  const kind = first.kind;
  if (kind !== "mcp" && rows.length !== 1) throw new Error("a webhook or queue bot has one destination");
  const now = Date.now();
  botSequence++;
  const botId = newBotId(now);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO bots (id, workspace_id, created_by_user_id, name, delivery_kind, delivery_subscription_id, created_at, updated_at)
      VALUES (?1, ?2, (SELECT owner_user_id FROM workspaces WHERE id = ?2), ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      botId,
      first.workspaceId,
      options.name ?? `test-bot-${botSequence}`,
      kind,
      kind === "mcp" ? null : first.id,
      now,
      now,
    ),
  ];
  let connectionId: string | null = null;
  if (kind === "mcp" || options.connect === true) {
    connectionId = newMcpConnectionId(now);
    statements.push(
      env.DB.prepare(
        `INSERT INTO mcp_connections (id, user_id, workspace_id, bot_id, grant_id, oauth_client_id, client_name, redirect_uri,
          created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, 'test-client', 'Test client', 'https://client.example.com/callback', ?, ?)`,
      ).bind(connectionId, first.userId, first.workspaceId, botId, now, now),
    );
  }
  if (kind === "mcp") {
    statements.push(
      ...rows.map((row) =>
        env.DB.prepare("UPDATE subscriptions SET connection_id = ? WHERE id = ?").bind(connectionId, row.id),
      ),
    );
  }
  statements.push(
    ...sourceIds.map((sourceId) =>
      env.DB.prepare("INSERT INTO bot_sources (bot_id, source_id, workspace_id, created_at) VALUES (?, ?, ?, ?)").bind(
        botId,
        sourceId,
        first.workspaceId,
        now,
      ),
    ),
  );
  await env.DB.batch(statements);
  return { botId, connectionId };
}
