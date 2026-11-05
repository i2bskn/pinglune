import { eq } from "drizzle-orm";
import { type Db, describeError } from "@i2bskn/workers-app-core";
import { apiKeys, type SourceRow } from "../db/schema";
import { sha256Hex } from "../ids";
import { findSourceById } from "./queries";

// pl_<keyId>_<secret>: keyId is 16 of [a-z0-9], secret is 32 bytes in base64url without padding.
const API_KEY_PATTERN = /^pl_([a-z0-9]{16})_([A-Za-z0-9_-]{43})$/;
const BEARER_PREFIX = "Bearer ";

// Workers-specific API, declared here as in @cloudflare/workers-types so that the client tsconfig,
// which also loads the DOM lib through AppType, accepts it (here and in src/mcp/events.ts).
declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  }
}

export type ApiKeyAuthResult =
  | { ok: true; source: SourceRow }
  // Every reason (no header, wrong format, unknown key, revoked key, wrong secret) is reported the same way.
  | { ok: false; error: "unauthorized" | "source_disabled" };

function timingSafeEqualText(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

// Authenticates the Authorization header of an intake request. Only the header is used; the key in a query
// string is never read. The key is never logged.
export async function authenticateApiKey(
  db: Db,
  authorization: string | undefined,
  now: number,
): Promise<ApiKeyAuthResult> {
  const unauthorized = { ok: false, error: "unauthorized" } as const;
  if (authorization === undefined || !authorization.startsWith(BEARER_PREFIX)) return unauthorized;
  const match = API_KEY_PATTERN.exec(authorization.slice(BEARER_PREFIX.length));
  if (!match) return unauthorized;
  const [, keyId = "", secret = ""] = match;

  const key = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  // The hash is computed for unknown keys too, so that they take about as long as known ones.
  const hash = await sha256Hex(secret);
  if (!key) return unauthorized;
  const matches = timingSafeEqualText(hash, key.secretHash);
  if (!matches || key.revokedAt !== null) return unauthorized;

  // The key is valid. Recorded even if the source is disabled: the key is still in use.
  try {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, keyId)).run();
  } catch (error) {
    console.error("updating last_used_at of an API key failed", { keyId, ...describeError(error) });
  }

  const source = await findSourceById(db, key.sourceId);
  if (!source) return unauthorized;
  if (!source.enabled) return { ok: false, error: "source_disabled" };
  return { ok: true, source };
}
