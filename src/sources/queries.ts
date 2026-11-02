import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { ApiKey, Source } from "../api/types";
import type { Db } from "../db/client";
import { apiKeys, sources, type ApiKeyRow, type SourceRow } from "../db/schema";

export type SourceWithKeyCount = SourceRow & { activeKeyCount: number };

// Qualified by hand: drizzle renders ${sources.id} without the table name, which would bind to api_keys.
const activeKeyCount = sql<number>`(SELECT COUNT(*) FROM api_keys WHERE api_keys.source_id = sources.id AND api_keys.revoked_at IS NULL)`;

const sourceColumns = {
  id: sources.id,
  workspaceId: sources.workspaceId,
  name: sources.name,
  enabled: sources.enabled,
  kind: sources.kind,
  createdAt: sources.createdAt,
  updatedAt: sources.updatedAt,
  activeKeyCount,
};

export function toApiSource(source: SourceWithKeyCount): Source {
  return {
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    created_at: source.createdAt,
    updated_at: source.updatedAt,
    active_key_count: source.activeKeyCount,
  };
}

export function toApiKey(key: ApiKeyRow): ApiKey {
  return {
    key_id: key.id,
    created_at: key.createdAt,
    last_used_at: key.lastUsedAt,
    revoked_at: key.revokedAt,
  };
}

// The source of programs with this ID. The conversation source (src/conversations/) is never matched.
export function findSourceById(db: Db, id: string): Promise<SourceRow | undefined> {
  return db
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.kind, "program")))
    .get();
}

// The source only if it belongs to the workspace. The conversation source is never matched.
export function findWorkspaceSource(db: Db, workspaceId: string, id: string): Promise<SourceWithKeyCount | undefined> {
  return db
    .select(sourceColumns)
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.workspaceId, workspaceId), eq(sources.kind, "program")))
    .get();
}

// The sources of programs. The conversation source is not listed.
export function listWorkspaceSources(db: Db, workspaceId: string): Promise<SourceWithKeyCount[]> {
  return db
    .select(sourceColumns)
    .from(sources)
    .where(and(eq(sources.workspaceId, workspaceId), eq(sources.kind, "program")))
    .orderBy(asc(sources.createdAt), asc(sources.id))
    .all();
}

// The sources of programs, for the limit. The conversation source is not counted.
export async function countWorkspaceSources(db: Db, workspaceId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(sources)
    .where(and(eq(sources.workspaceId, workspaceId), eq(sources.kind, "program")))
    .get();
  return row?.count ?? 0;
}

export function listSourceApiKeys(db: Db, sourceId: string): Promise<ApiKeyRow[]> {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.sourceId, sourceId))
    .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id))
    .all();
}

export async function countActiveApiKeys(db: Db, sourceId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(apiKeys)
    .where(and(eq(apiKeys.sourceId, sourceId), isNull(apiKeys.revokedAt)))
    .get();
  return row?.count ?? 0;
}

// The key only if it belongs to the source.
export function findSourceApiKey(db: Db, sourceId: string, keyId: string): Promise<ApiKeyRow | undefined> {
  return db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.sourceId, sourceId)))
    .get();
}
