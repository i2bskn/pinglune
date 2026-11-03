import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { hashPassword } from "../src/auth/password";
import { createDb, type Db } from "../src/db/client";
import {
  apiKeys,
  emailAddresses,
  sources,
  subscriptions,
  users,
  workspaces,
  type SourceRow,
  type SubscriptionRow,
  type UserRow,
  type WorkspaceRow,
} from "../src/db/schema";
import type { DeliveryMessage } from "../src/deliveries/enqueue";
import type { Bindings } from "../src/env";
import worker from "../src/index";
import { formatApiKey, newEmailLocalPart, newKeyId, newKeySecret, newSourceId, sha256Hex } from "../src/ids";
import { NO_EXPIRY } from "../src/subscriptions/queries";
import { encryptSecret, subscriptionSecretKey } from "../src/subscriptions/secret";
import { insertPersonalWorkspaceStatement } from "../src/workspaces/queries";

export const ORIGIN = "https://pinglune.test";
export const OIDC_ORIGIN = "https://wiki.example.com";
export const PASSWORD = "correct horse battery";

export const db = createDb(env.DB);

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    // Children first.
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM event_data"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM conversation_participants"),
    env.DB.prepare("DELETE FROM conversations"),
    env.DB.prepare("DELETE FROM mcp_connections"),
    env.DB.prepare("DELETE FROM bots"),
    env.DB.prepare("DELETE FROM api_keys"),
    env.DB.prepare("DELETE FROM email_addresses"),
    env.DB.prepare("DELETE FROM sources"),
    env.DB.prepare("DELETE FROM subscriptions"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM users"),
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

export type RequestOptions = {
  method?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
  // Sent as is, without a Content-Type.
  body?: BodyInit;
  env?: Partial<Bindings>;
  // Passed to the Worker as is, without the per-request copy. Overrides env.
  sharedEnv?: Cloudflare.Env;
  // Origin header for non-GET requests. Defaults to the request origin; null omits it.
  origin?: string | null;
};

export async function send(url: string, options: RequestOptions = {}): Promise<Response> {
  const fullUrl = new URL(url, ORIGIN);
  const method =
    options.method ?? (options.form || options.json !== undefined || options.body !== undefined ? "POST" : "GET");
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? fullUrl.origin : options.origin;
  if (method !== "GET" && method !== "HEAD" && origin !== null) {
    headers.set("Origin", origin);
  }
  if (options.cookies) {
    headers.set(
      "Cookie",
      Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  let body: BodyInit | undefined;
  if (options.form) {
    body = new URLSearchParams(options.form);
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  } else if (options.json !== undefined) {
    body = typeof options.json === "string" ? options.json : JSON.stringify(options.json);
    headers.set("Content-Type", "application/json");
  } else if (options.body !== undefined) {
    body = options.body;
  }
  const request = new Request(fullUrl, { method, headers, body, redirect: "manual" });
  // Through the Worker entry point (OAuthProvider), like production.
  return worker.fetch(request, options.sharedEnv ?? { ...env, ...options.env }, createExecutionContext());
}

export type SetCookie = { value: string; maxAge: number | null; raw: string };

export function setCookies(res: Response): Record<string, SetCookie> {
  const result: Record<string, SetCookie> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair = "", ...attributes] = raw.split(";").map((s) => s.trim());
    const index = pair.indexOf("=");
    const maxAge = attributes.find((a) => a.toLowerCase().startsWith("max-age="));
    result[pair.slice(0, index)] = {
      value: pair.slice(index + 1),
      maxAge: maxAge ? Number(maxAge.split("=")[1]) : null,
      raw,
    };
  }
  return result;
}

export type SessionCookies = { "__Host-pinglune_at": string; "__Host-pinglune_rt": string };

export function sessionCookies(res: Response): SessionCookies {
  const cookies = setCookies(res);
  const at = cookies["__Host-pinglune_at"]?.value;
  const rt = cookies["__Host-pinglune_rt"]?.value;
  if (!at || !rt) throw new Error(`session cookies are missing: ${res.headers.getSetCookie().join(" | ")}`);
  return { "__Host-pinglune_at": at, "__Host-pinglune_rt": rt };
}

export async function createUser(params: {
  email: string;
  role?: "admin" | "member";
  password?: string | null;
  createdAt?: number;
}): Promise<UserRow> {
  const now = params.createdAt ?? Date.now();
  const password = params.password === undefined ? PASSWORD : params.password;
  const [user] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email: params.email,
      role: params.role ?? "member",
      passwordHash: password === null ? null : await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!user) throw new Error("failed to create user");
  await insertPersonalWorkspaceStatement(env.DB, user.id, now).run();
  return user;
}

export async function login(email: string, password = PASSWORD): Promise<SessionCookies> {
  const res = await send("/auth/login", { form: { email, password, next: "/" } });
  if (res.status !== 303) throw new Error(`login failed: ${res.status}`);
  return sessionCookies(res);
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

// A Db whose D1 binding runs before() once, right before the first statement matching pattern runs (alone
// or in a batch), as if another request changed the data between the checks of a service and its write.
export function dbChangingBefore(pattern: RegExp, before: () => Promise<unknown>): Db {
  const real = env.DB;
  const wrapped = new WeakMap<object, D1PreparedStatement>();
  let done = false;
  async function runBefore() {
    if (done) return;
    done = true;
    await before();
  }
  const d1 = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!pattern.test(query)) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              const wrapper = {
                all: async () => (await runBefore(), bound.all()),
                raw: async () => (await runBefore(), bound.raw()),
                run: async () => (await runBefore(), bound.run()),
                first: async () => (await runBefore(), bound.first()),
              };
              wrapped.set(wrapper, bound);
              return wrapper;
            },
          };
        };
      }
      if (prop === "batch") {
        return async (statements: object[]) => {
          if (statements.some((statement) => wrapped.has(statement))) await runBefore();
          return target.batch(statements.map((statement) => wrapped.get(statement) ?? (statement as D1PreparedStatement)));
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createDb(d1);
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

export async function countTable(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? 0;
}

// A D1 binding with some methods replaced, e.g. batch.
export function d1With(overrides: Partial<Record<keyof D1Database, unknown>>): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop as keyof D1Database];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

// The JWT_SECRET of vitest.config.ts, which the subscription secrets are encrypted with.
export const TEST_JWT_SECRET = "test-secret-test-secret-test-secret-0123";

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
