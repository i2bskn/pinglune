// The secrets of subscriptions: parsing the whsec_ form of MCP Events signing secrets, and encryption at rest of
// those and of the Bearer keys of webhook destinations.
//
// The key is derived from JWT_SECRET with HKDF, so that no new setting is needed and the key is separate from
// the one that signs JWTs. Changing JWT_SECRET makes the stored secrets undecryptable. ChatGPT subscribes again
// with the secret before the subscription expires, which repairs it; webhook destinations have to be registered
// again.

import { base64UrlDecode, base64UrlEncode } from "../auth/tokens";

const SECRET_PREFIX = "whsec_";
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
// atob also accepts whitespace, so the alphabet is checked first.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const HKDF_INFO = "pinglune subscription secret v1";
const VERSION = "v1";
const IV_BYTES = 12;

const encoder = new TextEncoder();

// The bytes of a whsec_<standard base64> secret (with or without padding) of 24 to 64 bytes, or null.
export function parseWebhookSecret(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string" || !value.startsWith(SECRET_PREFIX)) return null;
  let encoded = value.slice(SECRET_PREFIX.length);
  if (!BASE64_PATTERN.test(encoded)) return null;
  while (encoded.length % 4 !== 0) encoded += "=";
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return null;
  }
  if (binary.length < MIN_SECRET_BYTES || binary.length > MAX_SECRET_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The AES-GCM key for subscription secrets, derived from JWT_SECRET (HKDF-SHA256, empty salt).
export async function subscriptionSecretKey(jwtSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(jwtSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// v1.<base64url IV>.<base64url ciphertext and tag>. The subscription ID is the additional authenticated data, so
// that a stored value cannot be moved to another row.
export async function encryptSecret(key: CryptoKey, subscriptionId: string, secret: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(subscriptionId) },
    key,
    secret,
  );
  return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(sealed))}`;
}

// The secret bytes, or null if the value is malformed, was tampered with, belongs to another subscription or was
// encrypted with another key.
export async function decryptSecret(
  key: CryptoKey,
  subscriptionId: string,
  value: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const iv = base64UrlDecode(parts[1] ?? "");
  const sealed = base64UrlDecode(parts[2] ?? "");
  if (iv === null || iv.length !== IV_BYTES || sealed === null) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(subscriptionId) },
      key,
      sealed,
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}
