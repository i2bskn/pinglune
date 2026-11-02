// Identifiers: prefixed ULIDs for rows, the parts of API keys, and the local parts of intake email addresses.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

// ULID: 26 Crockford base32 characters.
export const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
  // 256 is a multiple of 32, so the low 5 bits are uniform.
  return Array.from(bytes, (b) => b & 31);
}

// Increments a base32 number in place. Returns false on overflow.
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = digits[i] ?? 0;
    if (digit < 31) {
      digits[i] = digit + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

// A ULID for the time now (UNIX ms). Monotonic within this isolate: IDs made in the same millisecond, or
// with a clock that went back, keep increasing.
export function newUlid(now: number): string {
  let time = Math.max(0, Math.floor(now));
  if (time <= lastTime) {
    time = lastTime;
    if (!increment(lastRandom)) {
      time += 1;
      lastRandom = randomDigits();
    }
  } else {
    lastRandom = randomDigits();
  }
  lastTime = time;
  let encodedTime = "";
  for (let i = 0; i < TIME_LENGTH; i++) {
    encodedTime = CROCKFORD[time % 32] + encodedTime;
    time = Math.floor(time / 32);
  }
  return encodedTime + lastRandom.map((d) => CROCKFORD[d]).join("");
}

export const EVENT_ID_PATTERN = new RegExp(`^evt_${ULID_PATTERN}$`);
export const DATA_REF_PATTERN = new RegExp(`^dat_${ULID_PATTERN}$`);
export const SOURCE_ID_PATTERN = new RegExp(`^src_${ULID_PATTERN}$`);
export const DELIVERY_ID_PATTERN = new RegExp(`^dlv_${ULID_PATTERN}$`);
export const CONVERSATION_ID_PATTERN = new RegExp(`^cnv_${ULID_PATTERN}$`);
// MCP Events subscriptions (sub_ + 32 hex digits of SHA-256), webhook destinations and polling queues (sub_ + 16
// random bytes in hex) share this form.
export const SUBSCRIPTION_ID_PATTERN = /^sub_[0-9a-f]{32}$/;

export function newEventId(now: number): string {
  return `evt_${newUlid(now)}`;
}

export function newDataRef(now: number): string {
  return `dat_${newUlid(now)}`;
}

export function newSourceId(now: number): string {
  return `src_${newUlid(now)}`;
}

export function newDeliveryId(now: number): string {
  return `dlv_${newUlid(now)}`;
}

export function newConversationId(now: number): string {
  return `cnv_${newUlid(now)}`;
}

export function newParticipantId(now: number): string {
  return `cpt_${newUlid(now)}`;
}

const RANDOM_SUBSCRIPTION_ID_BYTES = 16;

// The ID of a webhook destination or a polling queue: sub_ + 16 random bytes in lowercase hex, the form of MCP
// subscription IDs.
export function newRandomSubscriptionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_SUBSCRIPTION_ID_BYTES));
  return `sub_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const KEY_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_ID_LENGTH = 16;
const EMAIL_LOCAL_PART_LENGTH = 20;
// The largest multiple of 36 that fits in a byte; bytes at or above it are dropped so that every
// character is equally likely.
const KEY_ID_BYTE_LIMIT = 252;
const SECRET_BYTES = 32;

export const KEY_ID_PATTERN = /^[a-z0-9]{16}$/;
export const EMAIL_LOCAL_PART_PATTERN = /^[a-z0-9]{20}$/;

// length characters of [a-z0-9], chosen without bias.
function randomAlphanumeric(length: number): string {
  let id = "";
  while (id.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte >= KEY_ID_BYTE_LIMIT) continue;
      id += KEY_ID_ALPHABET[byte % KEY_ID_ALPHABET.length];
      if (id.length === length) break;
    }
  }
  return id;
}

// 16 characters of [a-z0-9], chosen without bias.
export function newKeyId(): string {
  return randomAlphanumeric(KEY_ID_LENGTH);
}

// The local part of an intake email address: 20 characters of [a-z0-9] (about 2^103), so it cannot be guessed.
export function newEmailLocalPart(): string {
  return randomAlphanumeric(EMAIL_LOCAL_PART_LENGTH);
}

// 32 random bytes in base64url without padding (43 characters).
export function newKeySecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function formatApiKey(keyId: string, secret: string): string {
  return `pl_${keyId}_${secret}`;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  // Workers have no SharedArrayBuffer, so every view is backed by an ArrayBuffer.
  const bytes = (typeof data === "string" ? new TextEncoder().encode(data) : data) as Uint8Array<ArrayBuffer>;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
