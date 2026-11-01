import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { EmailAddress } from "../api/types";
import type { Db } from "../db/client";
import { emailAddresses, type EmailAddressRow } from "../db/schema";

// domain is the parsed EMAIL_DOMAIN; null leaves the address out.
export function toApiEmailAddress(row: EmailAddressRow, domain: string | null): EmailAddress {
  return {
    local_part: row.id,
    address: domain === null ? null : `${row.id}@${domain}`,
    created_at: row.createdAt,
    last_received_at: row.lastReceivedAt,
    revoked_at: row.revokedAt,
  };
}

// Revoked addresses included, in the order they were created.
export function listSourceEmailAddresses(db: Db, sourceId: string): Promise<EmailAddressRow[]> {
  return db
    .select()
    .from(emailAddresses)
    .where(eq(emailAddresses.sourceId, sourceId))
    .orderBy(asc(emailAddresses.createdAt), asc(emailAddresses.id))
    .all();
}

export async function countActiveEmailAddresses(db: Db, sourceId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(emailAddresses)
    .where(and(eq(emailAddresses.sourceId, sourceId), isNull(emailAddresses.revokedAt)))
    .get();
  return row?.count ?? 0;
}

// The address only if it belongs to the source.
export function findSourceEmailAddress(db: Db, sourceId: string, localPart: string): Promise<EmailAddressRow | undefined> {
  return db
    .select()
    .from(emailAddresses)
    .where(and(eq(emailAddresses.id, localPart), eq(emailAddresses.sourceId, sourceId)))
    .get();
}
