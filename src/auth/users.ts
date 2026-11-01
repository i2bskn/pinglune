import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { users, type UserRow } from "../db/schema";
import { findPersonalWorkspaceByUserId, insertPersonalWorkspaceStatement } from "../workspaces/queries";

export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes("UNIQUE constraint failed")) return true;
  }
  return false;
}

export function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  return db.select().from(users).where(eq(users.email, email)).get();
}

export async function countUsers(db: Db): Promise<number> {
  const row = await db.select({ count: sql<number>`COUNT(*)` }).from(users).get();
  return row?.count ?? 0;
}

// Creates the first admin and their personal workspace only when there are no users, in one batch.
// Returns null if a user already exists; the personal workspace statement then inserts nothing.
export async function createInitialAdmin(
  db: Db,
  params: { email: string; name: string | null; passwordHash: string; now: number },
): Promise<UserRow | null> {
  const id = crypto.randomUUID();
  const { email, name, passwordHash, now } = params;
  const d1 = db.$client;
  const [userResult] = await d1.batch([
    d1
      .prepare(`
    INSERT INTO users (id, email, name, role, password_hash, oidc_issuer, oidc_subject, created_at, updated_at, last_login_at)
    SELECT ?, ?, ?, 'admin', ?, NULL, NULL, ?, ?, NULL
    WHERE NOT EXISTS (SELECT 1 FROM users)`)
      .bind(id, email, name, passwordHash, now, now),
    insertPersonalWorkspaceStatement(d1, id, now),
  ]);
  if (userResult?.meta.changes !== 1) return null;
  return (await findUserById(db, id)) ?? null;
}

export type OidcIdentity = {
  issuer: string;
  subject: string;
  email: string;
  name: string | null;
};

export type OidcUserResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: "conflict" | "failed" };

// Maps an OIDC identity to a user, creating one just in time (spec 6.6).
export async function resolveOidcUser(db: Db, identity: OidcIdentity, now: number): Promise<OidcUserResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await tryResolveOidcUser(db, identity, now);
    if (result !== "retry") return result;
  }
  return { ok: false, reason: "failed" };
}

async function tryResolveOidcUser(
  db: Db,
  identity: OidcIdentity,
  now: number,
): Promise<OidcUserResult | "retry"> {
  const { issuer, subject, email, name } = identity;

  const linked = await db
    .select()
    .from(users)
    .where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSubject, subject)))
    .get();
  if (linked) {
    if (linked.email === email) return { ok: true, user: linked };
    try {
      await db.update(users).set({ email, updatedAt: now }).where(eq(users.id, linked.id)).run();
      return { ok: true, user: { ...linked, email, updatedAt: now } };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      console.warn("oidc email update skipped: email is used by another user", { userId: linked.id });
      return { ok: true, user: linked };
    }
  }

  const byEmail = await findUserByEmail(db, email);
  if (byEmail) {
    if (byEmail.oidcSubject !== null) return { ok: false, reason: "conflict" };
    try {
      const result = await db
        .update(users)
        .set({ oidcIssuer: issuer, oidcSubject: subject, updatedAt: now })
        .where(and(eq(users.id, byEmail.id), isNull(users.oidcSubject)))
        .run();
      if (result.meta.changes !== 1) return "retry";
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return "retry";
    }
    const user = await findUserById(db, byEmail.id);
    return user ? { ok: true, user } : "retry";
  }

  const id = crypto.randomUUID();
  const d1 = db.$client;
  try {
    // The personal workspace is created in the same batch, so a UNIQUE violation rolls back both.
    await d1.batch([
      d1
        .prepare(`
      INSERT INTO users (id, email, name, role, password_hash, oidc_issuer, oidc_subject, created_at, updated_at, last_login_at)
      SELECT ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'member' ELSE 'admin' END,
        NULL, ?, ?, ?, ?, NULL`)
        .bind(id, email, name, issuer, subject, now, now),
      insertPersonalWorkspaceStatement(d1, id, now),
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return "retry";
  }
  const user = await findUserById(db, id);
  return user ? { ok: true, user } : "retry";
}

export type DeleteUserResult =
  | { ok: true; workspaceId: string | null }
  | { ok: false; error: "not_found" | "last_admin" };

// Deletes the user with their personal workspace, everything in it, and their sessions. workspaceId is the
// deleted personal workspace (null if the user had none); the caller deletes its R2 objects.
// When adding tables that belong to a workspace, add their DELETE statements to this batch before the
// workspace statement. The users statement stays last: its result decides success.
// TODO: one batch deletes every event of the workspace. With a very large number of events this may hit the
// D1 limits; the deletion would then have to be split. Not expected at personal scale.
export async function deleteUser(db: Db, id: string): Promise<DeleteUserResult> {
  const target = await findUserById(db, id);
  if (!target) return { ok: false, error: "not_found" };
  if (target.role === "admin") {
    const row = await db.select({ count: sql<number>`COUNT(*)` }).from(users).where(eq(users.role, "admin")).get();
    if ((row?.count ?? 0) <= 1) return { ok: false, error: "last_admin" };
  }
  const workspace = await findPersonalWorkspaceByUserId(db, id);
  const workspaceId = workspace?.id ?? null;

  // Every statement carries the same guard, so that nothing is deleted if the user is gone or is the last
  // admin when the batch runs; the check above is only a fast path. The batch is one transaction.
  const guard = `EXISTS (SELECT 1 FROM users WHERE id = ?1
    AND (role = 'member' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1))`;
  const d1 = db.$client;
  // Children first: the deliveries (of the workspace's events and of the user's subscriptions), the data of the
  // workspace, the subscriptions, the workspace, the sessions, then the user. ?2 is the workspace ID; NULL
  // matches nothing.
  const results = await d1.batch([
    d1
      .prepare(
        `DELETE FROM deliveries WHERE (workspace_id = ?2 OR subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ?1)) AND ${guard}`,
      )
      .bind(id, workspaceId),
    d1.prepare(`DELETE FROM event_data WHERE workspace_id = ?2 AND ${guard}`).bind(id, workspaceId),
    d1.prepare(`DELETE FROM events WHERE workspace_id = ?2 AND ${guard}`).bind(id, workspaceId),
    d1
      .prepare(`DELETE FROM api_keys WHERE source_id IN (SELECT id FROM sources WHERE workspace_id = ?2) AND ${guard}`)
      .bind(id, workspaceId),
    d1
      .prepare(
        `DELETE FROM email_addresses WHERE source_id IN (SELECT id FROM sources WHERE workspace_id = ?2) AND ${guard}`,
      )
      .bind(id, workspaceId),
    d1.prepare(`DELETE FROM sources WHERE workspace_id = ?2 AND ${guard}`).bind(id, workspaceId),
    d1.prepare(`DELETE FROM subscriptions WHERE user_id = ?1 AND ${guard}`).bind(id),
    d1.prepare(`DELETE FROM workspaces WHERE owner_user_id = ?1 AND kind = 'personal' AND ${guard}`).bind(id),
    d1.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND ${guard}`).bind(id),
    d1.prepare(`DELETE FROM users WHERE id = ?1 AND ${guard} RETURNING id`).bind(id),
  ]);

  // meta.changes counts cascaded rows too, so success is decided by the row returned by the users statement.
  if ((results.at(-1)?.results.length ?? 0) === 0) {
    return (await findUserById(db, id)) ? { ok: false, error: "last_admin" } : { ok: false, error: "not_found" };
  }
  return { ok: true, workspaceId };
}
