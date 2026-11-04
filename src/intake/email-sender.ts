// The check of the sender of the email intake (sources.email_sender_verification): the DMARC result Cloudflare
// Email Routing put on the message, the From of the message, and the allowed senders of the source.
//
// Cloudflare adds `Authentication-Results: mx.cloudflare.net; ...` at the top of the message; only that first one is
// trusted, any other may have been written by the sender. The escaping of its values is not documented, so every form
// in which the sender could control a character is refused rather than parsed.

import { addressParser } from "postal-mime";

export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

// RFC 5322: a line is at most 998 characters.
const FROM_LINE_MAX_LENGTH = 998;
const ADDRESS_MAX_LENGTH = 254;
const DOMAIN_MAX_LENGTH = 253;
const LOCAL_PART_MAX_LENGTH = 64;
// The most allowed senders of a source.
export const MAX_ALLOWED_SENDERS = 20;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Printable ASCII without the space and <>()[]",;:\@.
const SIMPLE_LOCAL_PART = /^[\x21\x23-\x27\x2A\x2B\x2D-\x39\x3D\x3F\x41-\x5A\x5E-\x7E]+$/;

export type AuthResultsReason =
  | "ar_missing"
  | "ar_authserv"
  | "ar_syntax"
  | "dmarc_missing"
  | "dmarc_multiple"
  | "dmarc_fail"
  | "dmarc_none"
  | "dmarc_temperror"
  | "header_from_missing"
  | "header_from_invalid";

export type FromReason = "multiple_from" | "from_unusable" | "header_from_mismatch" | "not_allowed";

export type SenderRejectReason = AuthResultsReason | FromReason;

// result "invalid": the value could not be read (ar_*, dmarc_missing, dmarc_multiple, header_from_invalid). reason is
// null only for a pass with header.from.
export type CloudflareAuthResults = {
  result: "pass" | "none" | "fail" | "temperror" | "invalid";
  reason: AuthResultsReason | null;
  headerFrom: string | null;
};

function invalid(reason: AuthResultsReason): CloudflareAuthResults {
  return { result: "invalid", reason, headerFrom: null };
}

// Only SP and HTAB are white space here (not \s).
function isWsp(ch: string): boolean {
  return ch === " " || ch === "\t";
}

function trimWsp(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isWsp(value.charAt(start))) start++;
  while (end > start && isWsp(value.charAt(end - 1))) end--;
  return value.slice(start, end);
}

function splitWsp(value: string): string[] {
  return value.split(/[ \t]+/).filter((word) => word !== "");
}

// The first line of the joined value (Headers.get joins the lines with ", "), with the comments replaced by a space,
// or null when it has a form that is not handled: a nested or unclosed comment, an unmatched ")", a "," in a comment,
// or a quote or a backslash anywhere.
function firstLine(value: string): string | null {
  let line = "";
  let inComment = false;
  for (const ch of value) {
    if (ch === '"' || ch === "\\") return null;
    if (inComment) {
      if (ch === "(" || ch === ",") return null;
      if (ch === ")") {
        inComment = false;
        line += " ";
      }
      continue;
    }
    if (ch === ",") return line;
    if (ch === ")") return null;
    if (ch === "(") {
      inComment = true;
      continue;
    }
    line += ch;
  }
  return inComment ? null : line;
}

// The DMARC result of the first Authentication-Results, which must be the one of Cloudflare. value is
// message.headers.get("authentication-results").
export function parseCloudflareAuthResults(value: string | null): CloudflareAuthResults {
  if (value === null) return invalid("ar_missing");
  const line = firstLine(value);
  if (line === null) return invalid("ar_syntax");

  const [head = "", ...rest] = line.split(";");
  // A version may follow the authserv-id.
  const authservId = splitWsp(head)[0] ?? "";
  if (authservId.toLowerCase() !== CLOUDFLARE_AUTHSERV_ID) return invalid("ar_authserv");

  const dmarcs = rest.map(trimWsp).filter((element) => element.toLowerCase().startsWith("dmarc="));
  if (dmarcs.length === 0) return invalid("dmarc_missing");
  if (dmarcs.length > 1) return invalid("dmarc_multiple");
  const [dmarc = ""] = dmarcs;

  const words = splitWsp(dmarc);
  const verdict = (words[0] ?? "").slice("dmarc=".length).toLowerCase();
  const result = verdict === "pass" || verdict === "none" || verdict === "temperror" ? verdict : "fail";

  const headerFroms = words.filter((word) => word.toLowerCase().startsWith("header.from="));
  if (headerFroms.length > 1) return invalid("dmarc_multiple");
  let headerFrom: string | null = null;
  if (headerFroms.length === 1) {
    const domain = (headerFroms[0] ?? "").slice("header.from=".length).toLowerCase();
    if (!isDomain(domain)) return invalid("header_from_invalid");
    headerFrom = domain;
  }

  switch (result) {
    case "pass":
      return { result, reason: headerFrom === null ? "header_from_missing" : null, headerFrom };
    case "none":
      return { result, reason: "dmarc_none", headerFrom };
    case "temperror":
      return { result, reason: "dmarc_temperror", headerFrom };
    default:
      return { result, reason: "dmarc_fail", headerFrom };
  }
}

// Labels of [a-z0-9-] joined by ".", at least two, each 1 to 63 characters not starting or ending with "-", 253
// characters in all. Lowercase only. Internationalized domains are written in punycode.
export function isDomain(value: string): boolean {
  if (value.length < 1 || value.length > DOMAIN_MAX_LENGTH) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => LABEL.test(label));
}

// The one address of a From line (the value postal-mime gives: unfolded and trimmed), in lowercase, or null unless it
// is exactly one mailbox with an address whose domain is a domain name. The local part may have any form. Parsed by
// addressParser in one pass, not by a regular expression over the whole value.
export function parseFromLine(value: string): string | null {
  if (value.length > FROM_LINE_MAX_LENGTH) return null;
  const addresses = addressParser(value);
  if (addresses.length !== 1) return null;
  const [mailbox] = addresses;
  if (!mailbox || mailbox.group !== undefined || !mailbox.address) return null;
  const address = mailbox.address.toLowerCase();
  if (address.length > ADDRESS_MAX_LENGTH) return null;
  const at = address.indexOf("@");
  if (at < 0 || address.indexOf("@", at + 1) >= 0) return null;
  return isDomain(address.slice(at + 1)) ? address : null;
}

// An allowed sender in its stored form, or null if invalid: local@domain (that address only) or domain (every
// address of the domain, not of its subdomains). Trimmed and in lowercase. The local part is 1 to 64 printable ASCII
// characters without white space and <>()[]",;:\@.
export function normalizeAllowedSender(value: string): string | null {
  const sender = value.trim().toLowerCase();
  if (sender.length < 1 || sender.length > ADDRESS_MAX_LENGTH) return null;
  const at = sender.indexOf("@");
  if (at < 0) return isDomain(sender) ? sender : null;
  const localPart = sender.slice(0, at);
  const domain = sender.slice(at + 1);
  if (localPart.length > LOCAL_PART_MAX_LENGTH || !SIMPLE_LOCAL_PART.test(localPart)) return null;
  // A second "@" fails the domain.
  return isDomain(domain) ? sender : null;
}

// Whether the lowercase address matches one of the normalized senders.
export function matchesAllowedSender(address: string, senders: string[]): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return senders.some((sender) => (sender.includes("@") ? sender === address : sender === domain));
}

// The stored allowed senders (sources.email_allowed_senders): [] for NULL or [], null when the value is broken (not
// JSON, not an array, or an element that is not a valid sender).
export function parseAllowedSenders(stored: string | null): string[] | null {
  if (stored === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const senders: string[] = [];
  for (const element of value) {
    if (typeof element !== "string") return null;
    const sender = normalizeAllowedSender(element);
    if (sender === null) return null;
    senders.push(sender);
  }
  return senders;
}
