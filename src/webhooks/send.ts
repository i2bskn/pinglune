// Sends a signed webhook to a callback URL. Used by the callback verification and by deliveries.

import { checkDestination, type DestinationDeps, type DestinationFailure } from "./destination";
import { signWebhook } from "./sign";

export type SendFailure = DestinationFailure | "timeout" | "connection_failed" | "redirect" | "http_4xx" | "http_5xx";

// status is set for HTTP failures, so that deliveries can tell 410 and 413 apart.
export type SendResult = { ok: true; status: number; body: string } | { ok: false; reason: SendFailure; status?: number };

export type WebhookMessage = {
  url: URL;
  subscriptionId: string;
  msgId: string;
  timestampSec: number;
  // Serialized once: the signature covers these exact bytes.
  body: Uint8Array;
  // Every secret signs the message (more than one while a secret is being rotated).
  secrets: Uint8Array<ArrayBuffer>[];
};

const SEND_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4096;
const USER_AGENT = "Pinglune-Webhooks/1";

// Reads at most limit bytes of the body and cancels the rest.
async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(length, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset === bytes.length) break;
  }
  return new TextDecoder().decode(bytes);
}

function fetchFailure(error: unknown): SendResult {
  // AbortSignal.timeout rejects with a DOMException named TimeoutError.
  const timedOut = typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
  return { ok: false, reason: timedOut ? "timeout" : "connection_failed" };
}

// Checks the destination, then POSTs the message without following redirects. Never throws. The whole send
// takes at most about 20 seconds (DNS over HTTPS 5 seconds, then the request 10 seconds).
export async function sendWebhook(message: WebhookMessage, deps: DestinationDeps): Promise<SendResult> {
  const destination = await checkDestination(message.url, deps);
  if (!destination.ok) return { ok: false, reason: destination.reason };

  const { url, subscriptionId, msgId, timestampSec, body, secrets } = message;
  let res: Response;
  try {
    const signature = await signWebhook(secrets, msgId, timestampSec, body);
    res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      // Workers have no SharedArrayBuffer, so every view is backed by an ArrayBuffer.
      body: body as Uint8Array<ArrayBuffer>,
      headers: {
        "Content-Type": "application/json",
        "webhook-id": msgId,
        "webhook-timestamp": String(timestampSec),
        "webhook-signature": signature,
        "X-MCP-Subscription-Id": subscriptionId,
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    return fetchFailure(error);
  }

  const { status } = res;
  if (status >= 200 && status < 300) {
    try {
      return { ok: true, status, body: await readLimited(res, MAX_RESPONSE_BYTES) };
    } catch (error) {
      return fetchFailure(error);
    }
  }
  await res.body?.cancel().catch(() => {});
  if (status >= 300 && status < 400) return { ok: false, reason: "redirect", status };
  if (status >= 500) return { ok: false, reason: "http_5xx", status };
  return { ok: false, reason: "http_4xx", status };
}
