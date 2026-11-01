// The Email Workers entry point. Email Routing sends every message of the EMAIL_DOMAIN zone here (a catch-all rule);
// the random local part of the recipient identifies the source. Only DB, EVENT_DATA, DELIVERY_QUEUE and
// EMAIL_DOMAIN are used; loadConfig is not.
//
// A permanent rejection calls message.setReject. A temporary failure throws instead: the reply to an exception is
// not documented, but setReject would stop the sender from retrying, and a retry is what recovers the message.
// Logs never carry the content of a message (subject, body, addresses) nor the local part.

import PostalMime from "postal-mime";
import type { Address, Attachment, Email } from "postal-mime";
import { describeError } from "../auth/middleware";
import { canonicalJson } from "../canonical-json";
import { clock } from "../clock";
import { parseEmailDomain, type Bindings } from "../env";
import { EMAIL_LOCAL_PART_PATTERN, sha256Hex } from "../ids";
import { acceptEvent, type IntakeDeps, type IntakeSource } from "./service";
import {
  codePointLength,
  intakeLimits,
  LABEL_VALUE_MAX_LENGTH,
  MAX_ATTACHMENTS,
  parseOccurredAt,
  type IntakeInput,
} from "./validation";

export const EMAIL_EVENT_TYPE = "email.received";

// The limits of src/intake/validation.ts, which does not export them.
const SUMMARY_MAX_LENGTH = 2000;
const ATTACHMENT_NAME_MAX_LENGTH = 255;
const CONTENT_TYPE_MAX_LENGTH = 255;

const BODY_CONTENT_TYPE = "text/plain; charset=utf-8";
const HTML_NAME = "body.html";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const NO_SUBJECT = "(件名なし)";
const HTML_ONLY_TEXT = "（テキストの本文はありません。HTML の本文は添付の body.html にあります）";
const NO_BODY_TEXT = "（本文はありません）";
// The names of the dropped attachments listed in the note of the body.
const MAX_DROPPED_NAMES = 10;

// Unicode general category Cc.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
// Cc and the line and paragraph separators, which would start a new line in a header line or the summary.
const LINE_BREAKING = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
// The same plus the path separators, which attachment names must not contain.
const UNSAFE_IN_NAME = /[\u0000-\u001F\u007F-\u009F\u2028\u2029/\\]/g;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

const REJECT_NOT_ACCEPTING = "This address does not accept email";
const REJECT_UNKNOWN = "Unknown recipient";
const REJECT_DISABLED = "Recipient is disabled";
const REJECT_TOO_LARGE = "Message too large";
const REJECT_MALFORMED = "Malformed message";
const REJECT_NOT_ACCEPTED = "Message could not be accepted";

// A temporary failure that has been logged already.
class TemporaryFailure extends Error {
  override name = "TemporaryFailure";
}

type AddressRow = { source_id: string; revoked_at: number | null };
type SourceRow = { id: string; workspace_id: string; name: string; enabled: number };

type DataItem = { name: string; content_type: string; bytes: Uint8Array };

export async function handleEmail(message: ForwardableEmailMessage, env: Bindings): Promise<void> {
  // The source, once known, for the log of an unexpected error.
  const context: { sourceId: string | null } = { sourceId: null };
  try {
    await receive(message, env, context);
  } catch (error) {
    if (!(error instanceof TemporaryFailure)) {
      console.error("email intake: unexpected error", { sourceId: context.sourceId, ...describeError(error) });
    }
    throw error;
  }
}

async function receive(
  message: ForwardableEmailMessage,
  env: Bindings,
  context: { sourceId: string | null },
): Promise<void> {
  // 1-2. The domain of the intake.
  const configured = parseEmailDomain(env.EMAIL_DOMAIN);
  if (!configured.ok) {
    console.error("email intake: invalid EMAIL_DOMAIN");
    throw new TemporaryFailure("email intake: invalid EMAIL_DOMAIN");
  }
  if (configured.domain === null) {
    message.setReject(REJECT_NOT_ACCEPTING);
    return;
  }

  // 3. The recipient of the envelope: exactly <local part>@<domain>, compared in lowercase.
  const localPart = parseRecipient(message.to, configured.domain);
  if (localPart === null) {
    message.setReject(REJECT_UNKNOWN);
    return;
  }

  // 4. The address. 5. The source, in a separate query.
  const address = await env.DB.prepare("SELECT source_id, revoked_at FROM email_addresses WHERE id = ?")
    .bind(localPart)
    .first<AddressRow>();
  if (!address || address.revoked_at !== null) {
    message.setReject(REJECT_UNKNOWN);
    return;
  }
  const row = await env.DB.prepare("SELECT id, workspace_id, name, enabled FROM sources WHERE id = ?")
    .bind(address.source_id)
    .first<SourceRow>();
  if (!row) {
    message.setReject(REJECT_UNKNOWN);
    return;
  }
  context.sourceId = row.id;
  // Told apart from an unknown recipient on purpose, so that the sender's operator can see it was stopped.
  if (!row.enabled) {
    message.setReject(REJECT_DISABLED);
    return;
  }
  const source: IntakeSource = { id: row.id, workspaceId: row.workspace_id, name: row.name, enabled: true };

  // 6. The size announced by Email Routing, before anything is read.
  if (message.rawSize > intakeLimits.maxPayloadBytes) {
    message.setReject(REJECT_TOO_LARGE);
    return;
  }

  // 7-8. Read and parse.
  const parsed = await readAndParse(message, source.id);
  if (parsed.kind === "too_large") {
    message.setReject(REJECT_TOO_LARGE);
    return;
  }
  if (parsed.kind === "malformed") {
    message.setReject(REJECT_MALFORMED);
    return;
  }

  // 9. The event. now is read once and shared by the key, the intake and last_received_at.
  const deps: IntakeDeps = { db: env.DB, bucket: env.EVENT_DATA, queue: env.DELIVERY_QUEUE, now: clock.now() };
  const input = await toIntakeInput(parsed.email, deps.now);
  const result = await acceptEvent(deps, source, input);

  // 10. The outcome.
  if (result.ok) {
    try {
      await env.DB.prepare("UPDATE email_addresses SET last_received_at = ? WHERE id = ?").bind(deps.now, localPart).run();
    } catch (error) {
      console.error("email intake: updating last_received_at failed", { sourceId: source.id, ...describeError(error) });
    }
    return;
  }
  switch (result.error.code) {
    case "temporarily_unavailable":
      // acceptEvent has logged the cause.
      throw new TemporaryFailure("email intake: temporarily unavailable");
    case "source_disabled":
      message.setReject(REJECT_DISABLED);
      return;
    case "payload_too_large":
      // The decoded parts can be larger than the raw message (e.g. Shift_JIS converted to UTF-8).
      message.setReject(REJECT_TOO_LARGE);
      return;
    default:
      // The conversion below builds only valid values, so this is a bug of the conversion.
      console.error("email intake: the event was rejected", {
        sourceId: source.id,
        code: result.error.code,
        fields: result.error.fields,
      });
      message.setReject(REJECT_NOT_ACCEPTED);
  }
}

// The lowercase local part, or null unless the address is <20 [a-z0-9]>@<domain>. Subaddresses (+) are not
// handled: they fail the pattern.
function parseRecipient(to: string, domain: string): string | null {
  const at = to.lastIndexOf("@");
  if (at < 0) return null;
  const localPart = to.slice(0, at).toLowerCase();
  if (to.slice(at + 1).toLowerCase() !== domain) return null;
  return EMAIL_LOCAL_PART_PATTERN.test(localPart) ? localPart : null;
}

type Parsed = { kind: "ok"; email: Email } | { kind: "too_large" } | { kind: "malformed" };

// The raw bytes live only in this function, so that they can be freed once parsed.
async function readAndParse(message: ForwardableEmailMessage, sourceId: string): Promise<Parsed> {
  let raw: ArrayBuffer;
  try {
    raw = await new Response(message.raw).arrayBuffer();
  } catch (error) {
    console.error("email intake: reading the message failed", { sourceId, ...describeError(error) });
    throw new TemporaryFailure("email intake: reading the message failed");
  }
  if (raw.byteLength > intakeLimits.maxPayloadBytes) return { kind: "too_large" };
  try {
    // An ArrayBuffer as is: postal-mime copies the whole message for a view.
    return { kind: "ok", email: await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" }) };
  } catch (error) {
    console.warn("email intake: parsing failed", { sourceId, ...describeError(error) });
    return { kind: "malformed" };
  }
}

async function toIntakeInput(email: Email, now: number): Promise<IntakeInput> {
  const summary = toSummary(email.subject);
  const occurredAt = toOccurredAt(email.date);
  const from = toFromLabel(email.from);
  const labels = from === null ? undefined : { from };

  const { kept, dropped } = toAttachments(email);
  const bodyBytes = new TextEncoder().encode(toBodyText(email, dropped));
  const body = { content_type: BODY_CONTENT_TYPE, bytes: bodyBytes };

  // The key is a hash of the converted event, not of the raw message: a resent message usually differs only in
  // trace headers (Received, ARC-*), and must be a duplicate so that the deliveries it left pending are queued
  // again. A message without a Message-ID gets the time it was received, so that identical notifications are not
  // merged; a retry of such a message is then a new event.
  const idempotencyKey = `email:${await sha256Hex(
    canonicalJson({
      summary,
      occurred_at: occurredAt ?? null,
      labels: labels ?? {},
      body: { content_type: body.content_type, sha256: await sha256Hex(bodyBytes) },
      attachments: await Promise.all(
        kept.map(async (a) => ({ name: a.name, content_type: a.content_type, sha256: await sha256Hex(a.bytes) })),
      ),
      received_at: email.messageId ? null : now,
    }),
  )}`;

  const input: IntakeInput = { idempotency_key: idempotencyKey, type: EMAIL_EVENT_TYPE, summary, body, attachments: kept };
  if (occurredAt !== undefined) input.occurred_at = occurredAt;
  if (labels !== undefined) input.labels = labels;
  return input;
}

function truncate(value: string, maxLength: number): string {
  return codePointLength(value) <= maxLength ? value : Array.from(value).slice(0, maxLength).join("");
}

// The decoded subject on one line, within the limit of the summary.
function toSummary(subject: string | undefined): string {
  const line = (subject ?? "").replace(LINE_BREAKING, " ").replace(/ {2,}/g, " ").trim();
  const summary = truncate(line, SUMMARY_MAX_LENGTH).trim();
  return summary === "" ? NO_SUBJECT : summary;
}

// The Date header as postal-mime gives it, only if it is a valid occurred_at. Otherwise the time received is used.
function toOccurredAt(date: string | undefined): string | undefined {
  if (date === undefined || parseOccurredAt(date) === null) return undefined;
  return date;
}

// The first address of From (the first member of a group), in lowercase, or null if it cannot be a label.
// The sender can forge From.
function toFromLabel(from: Address | undefined): string | null {
  const mailbox = from?.group !== undefined ? from.group[0] : from;
  const address = mailbox?.address?.toLowerCase() ?? "";
  const length = codePointLength(address);
  if (length < 1 || length > LABEL_VALUE_MAX_LENGTH || CONTROL.test(address)) return null;
  return address;
}

// Values of the header lines of the body stay on one line, so that they cannot fake another line.
function oneLine(value: string): string {
  return value.replace(LINE_BREAKING, " ");
}

function formatMailbox(name: string, address: string | undefined): string {
  if (name !== "" && address) return `${name} <${address}>`;
  return name !== "" ? name : (address ?? "");
}

function formatAddress(address: Address): string {
  if (address.group !== undefined) {
    return `${address.name}: ${address.group.map((m) => formatMailbox(m.name, m.address)).join(", ")};`;
  }
  return formatMailbox(address.name, address.address);
}

function formatAddresses(addresses: Address[] | undefined): string {
  return (addresses ?? []).map(formatAddress).filter((a) => a !== "").join(", ");
}

// The main headers and the text, so that one read_data shows what the message says.
function toBodyText(email: Email, dropped: string[]): string {
  const headers: [string, string][] = [
    ["From", email.from === undefined ? "" : formatAddress(email.from)],
    ["To", formatAddresses(email.to)],
    ["Cc", formatAddresses(email.cc)],
    ["Reply-To", formatAddresses(email.replyTo)],
    ["Subject", email.subject ?? ""],
    ["Date", email.headers.find((h) => h.key === "date")?.value ?? ""],
    ["Message-ID", email.messageId ?? ""],
  ];
  const lines = headers.filter(([, value]) => value !== "").map(([key, value]) => `${key}: ${oneLine(value)}`);

  let text: string;
  if (email.text !== undefined) text = email.text.replace(/\r\n?/g, "\n");
  else if (email.html !== undefined) text = HTML_ONLY_TEXT;
  else text = NO_BODY_TEXT;

  let result = lines.length === 0 ? text : `${lines.join("\n")}\n\n${text}`;
  if (dropped.length > 0) {
    const listed = dropped.slice(0, MAX_DROPPED_NAMES).join(", ");
    const rest = dropped.length > MAX_DROPPED_NAMES ? ` ほか ${dropped.length - MAX_DROPPED_NAMES} 件` : "";
    result += `\n\n（添付が上限の ${MAX_ATTACHMENTS} 個を超えたため、次の添付は保存していません: ${listed}${rest}）`;
  }
  return result;
}

// The HTML body first, then the attachments of the message (inline images included), up to MAX_ATTACHMENTS.
// dropped has the names of the rest.
function toAttachments(email: Email): { kept: DataItem[]; dropped: string[] } {
  const items: DataItem[] = [];
  if (email.html !== undefined) {
    items.push({ name: HTML_NAME, content_type: HTML_CONTENT_TYPE, bytes: new TextEncoder().encode(email.html) });
  }
  email.attachments.forEach((attachment, index) => {
    items.push({
      name: toAttachmentName(attachment.filename, index + 1),
      content_type: toContentType(attachment.mimeType),
      bytes: toBytes(attachment.content),
    });
  });
  return { kept: items.slice(0, MAX_ATTACHMENTS), dropped: items.slice(MAX_ATTACHMENTS).map((item) => item.name) };
}

function toAttachmentName(filename: string | null, position: number): string {
  const name = (filename ?? "").replace(UNSAFE_IN_NAME, "_").trim();
  if (name === "") return `attachment-${position}`;
  return truncate(name, ATTACHMENT_NAME_MAX_LENGTH).trim();
}

function toContentType(mimeType: string): string {
  if (PRINTABLE_ASCII.test(mimeType) && mimeType.includes("/") && mimeType.length <= CONTENT_TYPE_MAX_LENGTH) {
    return mimeType;
  }
  return DEFAULT_CONTENT_TYPE;
}

// attachmentEncoding "arraybuffer" gives an ArrayBuffer or a Uint8Array; a string is not expected.
function toBytes(content: Attachment["content"]): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array(content);
}
