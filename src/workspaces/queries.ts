import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { workspaces, type WorkspaceRow } from "../db/schema";

// Inserts the user's personal workspace only if the user exists and has none yet (idempotent).
// Returns a D1 statement because drizzle's D1 batch cannot run db.run(sql) with parameters.
export function insertPersonalWorkspaceStatement(d1: D1Database, userId: string, now: number): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO workspaces (id, kind, name, owner_user_id, created_at, updated_at)
      SELECT ?1, 'personal', NULL, ?2, ?3, ?3
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)
        AND NOT EXISTS (SELECT 1 FROM workspaces WHERE owner_user_id = ?2)`,
    )
    .bind(crypto.randomUUID(), userId, now);
}

export function findWorkspaceById(db: Db, id: string): Promise<WorkspaceRow | undefined> {
  return db.select().from(workspaces).where(eq(workspaces.id, id)).get();
}

// The personal workspace of a user. Every user has one; undefined means the invariant is broken.
export function findPersonalWorkspaceByUserId(db: Db, userId: string): Promise<WorkspaceRow | undefined> {
  return db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.ownerUserId, userId), eq(workspaces.kind, "personal")))
    .get();
}
