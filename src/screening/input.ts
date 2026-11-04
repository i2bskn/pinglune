// The input of the screening: everything of an event that an AI can read through MCP or a webhook.
//
// Every request carries the common fields (type, summary, labels, and the name and content_type of every data item).
// The data that read_data returns as text (isReadableText: the body, body.html, text attachments) is read from R2,
// joined in position order with a heading per item, and cut into parts of 32 KiB at UTF-8 character boundaries: one
// request per part. Binary data is not sent: AIs cannot read it as text, and its name and content_type are in the
// common fields.

import { isReadableText } from "../mcp/text";
import type { JevState } from "./jev";

const KIB = 1024;
// The common fields as JSON.
export const MAX_COMMON_BYTES = 16 * KIB;
export const PART_BYTES = 32 * KIB;
// 8 parts.
export const MAX_TEXT_BYTES = 256 * KIB;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ScreeningData = { name: string; contentType: string; size: number; r2Key: string };

export type ScreeningEvent = {
  type: string;
  summary: string;
  labels: Record<string, string>;
  // In position order.
  data: ScreeningData[];
};

export type ScreeningInput =
  | { ok: true; states: JevState[] }
  | { ok: false; error: "screening_too_large" | "screening_data_missing" };

// The whole object as text, or null if it is missing. Unlike readMessageText (src/conversations/service.ts), a
// missing object is told apart from an empty one.
async function readObjectText(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  if (object === null) return null;
  return decoder.decode(await object.arrayBuffer());
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

// Cuts the bytes into parts of up to size bytes, each ending at a character boundary.
export function splitUtf8(bytes: Uint8Array, size: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + size, bytes.length);
    while (end < bytes.length && end > start && isContinuation(bytes[end])) end--;
    // Not UTF-8 at all (only continuation bytes): cut at the size.
    if (end === start) end = Math.min(start + size, bytes.length);
    parts.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return parts;
}

// The states to send for the event. R2 errors are thrown: the caller retries.
export async function buildScreeningInput(bucket: R2Bucket, event: ScreeningEvent): Promise<ScreeningInput> {
  const common = {
    type: event.type,
    summary: event.summary,
    labels: event.labels,
    data: event.data.map((item) => ({ name: item.name, content_type: item.contentType })),
  };
  if (encoder.encode(JSON.stringify(common)).byteLength > MAX_COMMON_BYTES) {
    return { ok: false, error: "screening_too_large" };
  }

  // Empty items have nothing to read, and no heading.
  const readable = event.data.filter((item) => item.size > 0 && isReadableText(item.contentType));
  const headings = readable.map((item) => `--- ${item.name} ---\n`);
  // Checked with the stored sizes before anything is read, so that large data is never read.
  // The items are joined with one newline.
  const estimated = readable.reduce(
    (total, item, index) => total + item.size + encoder.encode(headings[index] ?? "").byteLength,
    Math.max(0, readable.length - 1),
  );
  if (estimated > MAX_TEXT_BYTES) return { ok: false, error: "screening_too_large" };

  const sections: string[] = [];
  for (const [index, item] of readable.entries()) {
    const text = await readObjectText(bucket, item.r2Key);
    if (text === null) return { ok: false, error: "screening_data_missing" };
    sections.push(`${headings[index] ?? ""}${text}`);
  }
  const bytes = encoder.encode(sections.join("\n"));
  // Decoding may replace invalid bytes with longer characters, so the text is checked again.
  if (bytes.byteLength > MAX_TEXT_BYTES) return { ok: false, error: "screening_too_large" };

  const parts = splitUtf8(bytes, PART_BYTES);
  if (parts.length === 0) return { ok: true, states: [common] };
  return {
    ok: true,
    states: parts.map((text, index) => ({ ...common, part: { index, total: parts.length, text } })),
  };
}
