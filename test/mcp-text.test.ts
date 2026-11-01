import { describe, expect, it } from "vitest";
import { isReadableText, sliceUtf8, type Utf8Slice } from "../src/mcp/text";

const encoder = new TextEncoder();

function decodeAll(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

// What read_data passes to sliceUtf8: the bytes from offset, limit + 6 at most.
function slice(data: Uint8Array, offset: number, limit: number): Utf8Slice {
  const length = Math.min(limit + 6, data.length - offset);
  return sliceUtf8(data.subarray(offset, offset + length), offset, limit, data.length);
}

// Reads the whole data with next_offset, as a client would.
function readAll(data: Uint8Array, limit: number): string {
  let text = "";
  let offset = 0;
  for (;;) {
    const piece = slice(data, offset, limit);
    expect(piece.offset).toBe(offset);
    text += piece.text;
    if (piece.nextOffset === null) return text;
    expect(piece.nextOffset).toBeGreaterThan(offset);
    offset = piece.nextOffset;
  }
}

function bytesOf(...parts: (string | number[])[]): Uint8Array {
  const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : new Uint8Array(part)));
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
}

describe("isReadableText", () => {
  it.each([
    "text/plain",
    "text/markdown; charset=utf-8",
    "Text/Plain; Charset=\"UTF-8\"",
    "text/csv; charset=utf8",
    "text/plain; charset=US-ASCII",
    "text/plain; format=flowed",
    " application/json ",
    "application/xml",
    "application/javascript",
    "application/x-ndjson",
    "application/yaml",
    "application/x-yaml",
    "application/csv",
    "message/rfc822",
    "application/vnd.api+json",
    "application/atom+xml; charset=utf-8",
  ])("accepts %s", (contentType) => {
    expect(isReadableText(contentType)).toBe(true);
  });

  it.each([
    "application/pdf",
    "application/octet-stream",
    "image/svg+xml",
    "image/png",
    "text/plain; charset=iso-2022-jp",
    "text/plain; charset=shift_jis",
    "text/plain; charset=",
    "text/plain; charset",
    "text/plain; charset=utf-8; charset=utf-8",
    "application/jsonx",
    "",
  ])("rejects %s", (contentType) => {
    expect(isReadableText(contentType)).toBe(false);
  });
});

describe("sliceUtf8", () => {
  it("moves a start in the middle of a character to the next character", () => {
    // あ is E3 81 82.
    const data = bytesOf("あb");
    expect(slice(data, 1, 10)).toEqual({ text: "b", offset: 3, nextOffset: null });
  });

  it("moves the start past 3 continuation bytes and the end back within the extra bytes", () => {
    // 😀 is F0 9F 98 80. Reading from 1 skips 3 bytes; the end at 4 + 5 = 9 is in the middle of the second.
    const data = bytesOf("😀😀😀");
    expect(slice(data, 1, 5)).toEqual({ text: "😀", offset: 4, nextOffset: 8 });
  });

  it("moves an end in the middle of a character back", () => {
    const data = bytesOf("aあい");
    expect(slice(data, 0, 3)).toEqual({ text: "a", offset: 0, nextOffset: 1 });
    expect(slice(data, 0, 5)).toEqual({ text: "aあ", offset: 0, nextOffset: 4 });
  });

  it("returns one character when limit is smaller than it", () => {
    const data = bytesOf("あい");
    expect(slice(data, 0, 1)).toEqual({ text: "あ", offset: 0, nextOffset: 3 });
    // The start moves to い first.
    expect(slice(data, 1, 1)).toEqual({ text: "い", offset: 3, nextOffset: null });
    expect(slice(bytesOf("😀a"), 0, 2)).toEqual({ text: "😀", offset: 0, nextOffset: 4 });
  });

  it("returns nothing when moving the start reaches the end of the data", () => {
    expect(slice(bytesOf("😀"), 1, 10)).toEqual({ text: "", offset: 4, nextOffset: null });
  });

  it("returns null as nextOffset at the end of the data", () => {
    const data = bytesOf("abc");
    expect(slice(data, 0, 3)).toEqual({ text: "abc", offset: 0, nextOffset: null });
    expect(slice(data, 1, 10)).toEqual({ text: "bc", offset: 1, nextOffset: null });
    expect(slice(data, 0, 2)).toEqual({ text: "ab", offset: 0, nextOffset: 2 });
  });

  it("keeps a BOM at the start of the data", () => {
    const data = bytesOf([0xef, 0xbb, 0xbf], "a");
    expect(slice(data, 0, 10)).toEqual({ text: "﻿a", offset: 0, nextOffset: null });
  });

  it("keeps a U+FEFF at the start of a piece", () => {
    const data = bytesOf("a", [0xef, 0xbb, 0xbf], "b");
    expect(slice(data, 1, 3)).toEqual({ text: "﻿", offset: 1, nextOffset: 4 });
  });

  it("decodes invalid bytes as U+FFFD", () => {
    const data = bytesOf("a", [0xff], "b");
    expect(slice(data, 0, 10)).toEqual({ text: "a�b", offset: 0, nextOffset: null });
    expect(slice(data, 1, 1)).toEqual({ text: "�", offset: 1, nextOffset: 2 });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("reads the whole data in pieces of %i bytes", (limit) => {
    const data = bytesOf([0xef, 0xbb, 0xbf], "aé漢字😀b", [0xff], "c", [0xef, 0xbb, 0xbf], "日本語😀😀\n", [0xf8], "z");
    expect(readAll(data, limit)).toBe(decodeAll(data));
  });
});
