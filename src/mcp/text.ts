// Text data for read_data: which content types are readable, and cutting UTF-8 at character boundaries.

const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
  "application/csv",
  "message/rfc822",
]);

const UTF8_CHARSETS = new Set(["utf-8", "utf8", "us-ascii"]);

function isTextMediaType(mediaType: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  if (TEXT_MEDIA_TYPES.has(mediaType)) return true;
  return mediaType.startsWith("application/") && (mediaType.endsWith("+json") || mediaType.endsWith("+xml"));
}

// Whether data of the content type can be returned as UTF-8 text. Parameters are split on ";" without
// regard to quotes.
export function isReadableText(contentType: string): boolean {
  const [mediaType = "", ...parameters] = contentType.split(";");
  if (!isTextMediaType(mediaType.trim().toLowerCase())) return false;
  const charsets: string[] = [];
  for (const parameter of parameters) {
    const index = parameter.indexOf("=");
    const name = (index === -1 ? parameter : parameter.slice(0, index)).trim().toLowerCase();
    if (name !== "charset") continue;
    const value = index === -1 ? "" : parameter.slice(index + 1).trim();
    charsets.push(value.replace(/^"|"$/g, "").toLowerCase());
  }
  if (charsets.length === 0) return true;
  if (charsets.length > 1) return false;
  return UTF8_CHARSETS.has(charsets[0] ?? "");
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

// The length of a character from its first byte. Continuation and invalid bytes count as 1.
function charLength(byte: number | undefined): number {
  if (byte === undefined || byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

// The longest a boundary adjustment moves: a character has at most 3 continuation bytes.
const MAX_ADJUST = 3;

export type Utf8Slice = { text: string; offset: number; nextOffset: number | null };

// Decodes up to limit bytes of the data at offset, moved to character boundaries. bytes starts at offset and
// holds min(limit + 6, totalSize - offset) bytes: up to 3 more for the start and 3 for the end. The start moves
// forward past continuation bytes; the end moves back to the start of a character, except that at least one
// character is returned (up to 3 bytes over limit). Invalid bytes become U+FFFD. A BOM is kept wherever it is,
// so that the pieces joined equal the whole data decoded.
export function sliceUtf8(bytes: Uint8Array, offset: number, limit: number, totalSize: number): Utf8Slice {
  let start = 0;
  if (offset > 0) {
    while (start < MAX_ADJUST && start < bytes.length && isContinuation(bytes[start])) start++;
  }
  if (offset + start >= totalSize) return { text: "", offset: totalSize, nextOffset: null };

  let end = Math.min(start + limit, bytes.length);
  if (offset + end < totalSize) {
    const limitEnd = end;
    while (limitEnd - end < MAX_ADJUST && end > start && isContinuation(bytes[end])) end--;
  }
  if (end <= start) end = Math.min(start + charLength(bytes[start]), bytes.length);

  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes.subarray(start, end));
  const nextOffset = offset + end;
  return { text, offset: offset + start, nextOffset: nextOffset >= totalSize ? null : nextOffset };
}
