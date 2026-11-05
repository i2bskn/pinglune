// The TypeSafe API key of a workspace, which the screening of its events uses (src/screening/service.ts). Entered on
// the management screen, checked with TypeSafe and stored encrypted, like the Bearer keys of webhook destinations
// (src/subscriptions/secret.ts). The key is never returned, logged or put in an error message.

import { describeError } from "@i2bskn/workers-app-core";
import { decryptSecret, encryptSecret, subscriptionSecretKey } from "../subscriptions/secret";
import { TYPESAFE_API_ORIGIN, TYPESAFE_TIMEOUT_MS } from "./jev";

const MAX_API_KEY_LENGTH = 256;
// Printable ASCII only.
const API_KEY_PATTERN = /^[\x20-\x7E]+$/;
const HINT_LENGTH = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The trimmed key, or null unless it is 1 to 256 printable ASCII characters.
export function normalizeApiKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (key.length < 1 || key.length > MAX_API_KEY_LENGTH || !API_KEY_PATTERN.test(key)) return null;
  return key;
}

// The additional authenticated data of the stored key. Prefixed so that it never equals the ID of a subscription,
// whose secrets are encrypted with the same key.
function context(workspaceId: string): string {
  return `screening-api-key:${workspaceId}`;
}

export async function encryptApiKey(jwtSecret: string, workspaceId: string, apiKey: string): Promise<string> {
  const key = await subscriptionSecretKey(jwtSecret);
  // Workers have no SharedArrayBuffer, so every view is backed by an ArrayBuffer.
  return encryptSecret(key, context(workspaceId), encoder.encode(apiKey) as Uint8Array<ArrayBuffer>);
}

// The key, or null if the stored value cannot be decrypted (JWT_SECRET changed, or it belongs to another workspace).
export async function decryptApiKey(jwtSecret: string, workspaceId: string, stored: string): Promise<string | null> {
  const key = await subscriptionSecretKey(jwtSecret);
  const plain = await decryptSecret(key, context(workspaceId), stored);
  return plain === null ? null : decoder.decode(plain);
}

export type ApiKeyCheck = "ok" | "invalid" | "unavailable";

// Checks the key with GET /v1/models: 2xx is valid, 401 and 403 invalid, anything else (and a timeout or a network
// error) unknown.
export async function verifyApiKey(apiKey: string): Promise<ApiKeyCheck> {
  let response: Response;
  try {
    response = await fetch(`${TYPESAFE_API_ORIGIN}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TYPESAFE_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("screening: checking the API key failed", describeError(error));
    return "unavailable";
  }
  // The body is not needed.
  await response.body?.cancel();
  if (response.ok) return "ok";
  if (response.status === 401 || response.status === 403) return "invalid";
  console.warn("screening: checking the API key returned an unexpected status", { status: response.status });
  return "unavailable";
}

export type SaveApiKeyResult = { ok: true } | { ok: false; code: "invalid_api_key" | "screening_unavailable" };

// Checks the key with TypeSafe and stores it for the workspace, replacing the previous one. Nothing is stored unless
// the check succeeds.
export async function verifyAndSaveApiKey(
  d1: D1Database,
  params: { jwtSecret: string; workspaceId: string; apiKey: string },
): Promise<SaveApiKeyResult> {
  const check = await verifyApiKey(params.apiKey);
  if (check === "invalid") return { ok: false, code: "invalid_api_key" };
  if (check === "unavailable") return { ok: false, code: "screening_unavailable" };
  const encrypted = await encryptApiKey(params.jwtSecret, params.workspaceId, params.apiKey);
  await d1
    .prepare("UPDATE workspaces SET screening_api_key = ?, screening_api_key_hint = ? WHERE id = ?")
    .bind(encrypted, params.apiKey.slice(-HINT_LENGTH), params.workspaceId)
    .run();
  return { ok: true };
}

export async function deleteApiKey(d1: D1Database, workspaceId: string): Promise<void> {
  await d1
    .prepare("UPDATE workspaces SET screening_api_key = NULL, screening_api_key_hint = NULL WHERE id = ?")
    .bind(workspaceId)
    .run();
}
