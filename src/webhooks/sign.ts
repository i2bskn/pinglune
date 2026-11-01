// Standard Webhooks signatures (https://www.standardwebhooks.com/).

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// The webhook-signature header: v1,<base64 HMAC-SHA256 of "msgId.timestamp.body"> for each secret, separated by
// spaces. body must be the exact bytes that are sent.
export async function signWebhook(
  secrets: Uint8Array<ArrayBuffer>[],
  msgId: string,
  timestampSec: number,
  body: Uint8Array,
): Promise<string> {
  const prefix = encoder.encode(`${msgId}.${timestampSec}.`);
  const content = new Uint8Array(prefix.length + body.length);
  content.set(prefix, 0);
  content.set(body, prefix.length);
  const signatures = await Promise.all(
    secrets.map(async (secret) => {
      const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return `v1,${base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, content)))}`;
    }),
  );
  return signatures.join(" ");
}
