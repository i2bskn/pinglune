// Validation and normalization of an event, shared by the HTTP and RPC entry points (spec 4.1).

// 25 MiB: the total of the body and the attachments.
export const MAX_PAYLOAD_BYTES = 26_214_400;
const MIB = 1024 * 1024;

// Indirection so that tests can lower the limit. maxRequestBytes() follows it.
export const intakeLimits = {
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
};

// The limit of an HTTP request body: the payload plus 1 MiB for the metadata and the multipart framing.
export function maxRequestBytes(): number {
  return intakeLimits.maxPayloadBytes + MIB;
}

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;
export const TYPE_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
export const TYPE_MAX_LENGTH = 100;
const RESERVED_TYPE_PREFIX = "pinglune.";
const SUMMARY_MAX_LENGTH = 2000;
const OCCURRED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
export const MAX_LABELS = 16;
export const LABEL_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
export const LABEL_VALUE_MAX_LENGTH = 256;
const CONTENT_TYPE_MAX_LENGTH = 255;
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
export const MAX_ATTACHMENTS = 20;
const ATTACHMENT_NAME_MAX_LENGTH = 255;

// Unicode general category Cc.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
// Cc except \n, \r and \t.
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

// The input of the shared intake. Both entry points convert their requests into this shape; the values are
// not checked yet. null in an optional item means the same as leaving it out.
export type IntakeInput = {
  idempotency_key: unknown;
  type: unknown;
  summary: unknown;
  occurred_at?: unknown;
  labels?: unknown;
  body?: { content_type?: unknown; bytes: unknown } | null;
  attachments?: { name: unknown; content_type?: unknown; bytes: unknown }[] | null;
};

export type NormalizedData = { contentType: string; bytes: Uint8Array };

export type NormalizedInput = {
  idempotencyKey: string;
  type: string;
  summary: string;
  // UNIX ms, or null when left out.
  occurredAt: number | null;
  labels: Record<string, string>;
  body: NormalizedData | null;
  attachments: (NormalizedData & { name: string })[];
};

export type IntakeErrorCode =
  | "invalid_json"
  | "invalid_multipart"
  | "invalid_input"
  | "unknown_field"
  | "invalid_idempotency_key"
  | "invalid_type"
  | "invalid_summary"
  | "invalid_occurred_at"
  | "invalid_labels"
  | "invalid_body"
  | "invalid_attachments"
  | "payload_too_large"
  | "unauthorized"
  | "source_disabled"
  | "idempotency_conflict"
  | "unsupported_media_type"
  | "temporarily_unavailable";

export type IntakeError = {
  status: 400 | 401 | 403 | 409 | 413 | 415 | 503;
  code: IntakeErrorCode;
  message: string;
  fields?: Record<string, string>;
};

export const INTAKE_MESSAGES: Record<IntakeErrorCode, string> = {
  invalid_json: "本文を JSON オブジェクトとして解析できません",
  invalid_multipart: "multipart の本文の形式が正しくありません",
  invalid_input: "入力はオブジェクトにしてください",
  unknown_field: "未知の項目があります",
  invalid_idempotency_key: "idempotency_key が正しくありません",
  invalid_type: "type が正しくありません",
  invalid_summary: "summary が正しくありません",
  invalid_occurred_at: "occurred_at が正しくありません",
  invalid_labels: "labels が正しくありません",
  invalid_body: "body が正しくありません",
  invalid_attachments: "attachments が正しくありません",
  payload_too_large: "本文と添付の合計サイズが上限を超えています",
  unauthorized: "認証に失敗しました",
  source_disabled: "送信元が無効です",
  idempotency_conflict: "同じ idempotency_key で内容の違うイベントがすでにあります",
  unsupported_media_type: "Content-Type は application/json か multipart/form-data にしてください",
  temporarily_unavailable: "一時的に受け付けられません。同じ idempotency_key で再送してください",
};

export const INTAKE_STATUS: Record<IntakeErrorCode, IntakeError["status"]> = {
  invalid_json: 400,
  invalid_multipart: 400,
  invalid_input: 400,
  unknown_field: 400,
  invalid_idempotency_key: 400,
  invalid_type: 400,
  invalid_summary: 400,
  invalid_occurred_at: 400,
  invalid_labels: 400,
  invalid_body: 400,
  invalid_attachments: 400,
  payload_too_large: 413,
  unauthorized: 401,
  source_disabled: 403,
  idempotency_conflict: 409,
  unsupported_media_type: 415,
  temporarily_unavailable: 503,
};

export function intakeError(code: IntakeErrorCode, fields?: Record<string, string>): IntakeError {
  const error: IntakeError = { status: INTAKE_STATUS[code], code, message: INTAKE_MESSAGES[code] };
  if (fields !== undefined) error.fields = fields;
  return error;
}

export function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The calendar parts of an RFC 3339 time, checked to exist. Returns UNIX ms or null.
export function parseOccurredAt(value: string): number | null {
  const match = OCCURRED_AT_PATTERN.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction, zone, sign, offsetHours, offsetMinutes] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const ms = fraction === undefined ? 0 : Number(fraction.padEnd(3, "0"));
  const local = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(local);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }
  if (zone === "Z") return local;
  const oh = Number(offsetHours);
  const om = Number(offsetMinutes);
  if (oh > 23 || om > 59) return null;
  const offset = (oh * 60 + om) * 60_000;
  return sign === "+" ? local - offset : local + offset;
}

// The normalized Content-Type, or null if invalid. Missing or blank means application/octet-stream.
function normalizeContentType(value: unknown): string | null {
  if (value === undefined || value === null) return DEFAULT_CONTENT_TYPE;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return DEFAULT_CONTENT_TYPE;
  if (!PRINTABLE_ASCII.test(trimmed) || !trimmed.includes("/") || trimmed.length > CONTENT_TYPE_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

function checkIdempotencyKey(value: unknown): Checked<string> {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    return { ok: false, reason: "1〜255 文字の印字可能な ASCII（空白を除く）にしてください" };
  }
  return { ok: true, value };
}

function checkType(value: unknown): Checked<string> {
  if (typeof value !== "string" || value.length > TYPE_MAX_LENGTH || !TYPE_PATTERN.test(value)) {
    return { ok: false, reason: "英小文字・数字・_・- の語をドットで区切った 100 文字以下にしてください" };
  }
  if (value.startsWith(RESERVED_TYPE_PREFIX)) return { ok: false, reason: "pinglune. で始まる type は予約されています" };
  return { ok: true, value };
}

function checkSummary(value: unknown): Checked<string> {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, reason: "空でない文字列にしてください" };
  if (codePointLength(value) > SUMMARY_MAX_LENGTH) return { ok: false, reason: "2,000 文字以下にしてください" };
  if (CONTROL_EXCEPT_NEWLINE_TAB.test(value)) return { ok: false, reason: "改行とタブ以外の制御文字は使えません" };
  return { ok: true, value };
}

function checkOccurredAt(value: unknown): Checked<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  const ms = typeof value === "string" ? parseOccurredAt(value) : null;
  if (ms === null) return { ok: false, reason: "RFC 3339 の日時（ミリ秒まで、タイムゾーン付き）にしてください" };
  return { ok: true, value: ms };
}

function checkLabels(value: unknown): Checked<Record<string, string>> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isPlainObject(value)) return { ok: false, reason: "値が文字列のオブジェクトにしてください" };
  const entries = Object.entries(value);
  if (entries.length > MAX_LABELS) return { ok: false, reason: "16 個以下にしてください" };
  const labels: Record<string, string> = {};
  for (const [key, label] of entries) {
    if (!LABEL_KEY_PATTERN.test(key)) return { ok: false, reason: `キー ${JSON.stringify(key)} が正しくありません` };
    if (typeof label !== "string") return { ok: false, reason: `${key} の値は文字列にしてください` };
    const length = codePointLength(label);
    if (length < 1 || length > LABEL_VALUE_MAX_LENGTH || CONTROL.test(label)) {
      return { ok: false, reason: `${key} の値は制御文字を含まない 1〜256 文字にしてください` };
    }
    labels[key] = label;
  }
  return { ok: true, value: labels };
}

function checkBody(value: IntakeInput["body"]): Checked<NormalizedData | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isPlainObject(value) || !(value.bytes instanceof Uint8Array)) return { ok: false, reason: "中身がありません" };
  if (value.bytes.byteLength === 0) return { ok: false, reason: "0 バイトの本文は送れません。本文がなければ省略してください" };
  const contentType = normalizeContentType(value.content_type);
  if (contentType === null) return { ok: false, reason: "Content-Type が正しくありません" };
  return { ok: true, value: { contentType, bytes: value.bytes } };
}

function checkAttachments(value: IntakeInput["attachments"]): Checked<NormalizedInput["attachments"]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "配列にしてください" };
  if (value.length > MAX_ATTACHMENTS) return { ok: false, reason: "20 個以下にしてください" };
  const attachments: NormalizedInput["attachments"] = [];
  for (const [index, item] of value.entries()) {
    const label = `${index + 1} 番目`;
    if (!isPlainObject(item) || !(item.bytes instanceof Uint8Array)) {
      return { ok: false, reason: `${label}の中身がありません` };
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const nameLength = codePointLength(name);
    if (nameLength < 1 || nameLength > ATTACHMENT_NAME_MAX_LENGTH || /[/\\]/.test(name) || CONTROL.test(name)) {
      return { ok: false, reason: `${label}の名前は / と \\ と制御文字を含まない 1〜255 文字にしてください` };
    }
    const contentType = normalizeContentType(item.content_type);
    if (contentType === null) return { ok: false, reason: `${label}の Content-Type が正しくありません` };
    attachments.push({ name, contentType, bytes: item.bytes });
  }
  return { ok: true, value: attachments };
}

// Checks every item in the order of the spec. The code is the one of the first invalid item; fields has all
// of them. A payload over the limit is reported only when the items are valid.
export function validateIntakeInput(input: IntakeInput): { ok: true; value: NormalizedInput } | { ok: false; error: IntakeError } {
  const fields: Record<string, string> = {};
  let firstCode: IntakeErrorCode | null = null;
  function fail(field: string, code: IntakeErrorCode, reason: string) {
    fields[field] = reason;
    firstCode ??= code;
  }

  const idempotencyKey = checkIdempotencyKey(input.idempotency_key);
  if (!idempotencyKey.ok) fail("idempotency_key", "invalid_idempotency_key", idempotencyKey.reason);
  const type = checkType(input.type);
  if (!type.ok) fail("type", "invalid_type", type.reason);
  const summary = checkSummary(input.summary);
  if (!summary.ok) fail("summary", "invalid_summary", summary.reason);
  const occurredAt = checkOccurredAt(input.occurred_at);
  if (!occurredAt.ok) fail("occurred_at", "invalid_occurred_at", occurredAt.reason);
  const labels = checkLabels(input.labels);
  if (!labels.ok) fail("labels", "invalid_labels", labels.reason);
  const body = checkBody(input.body);
  if (!body.ok) fail("body", "invalid_body", body.reason);
  const attachments = checkAttachments(input.attachments);
  if (!attachments.ok) fail("attachments", "invalid_attachments", attachments.reason);

  if (
    firstCode !== null ||
    !idempotencyKey.ok ||
    !type.ok ||
    !summary.ok ||
    !occurredAt.ok ||
    !labels.ok ||
    !body.ok ||
    !attachments.ok
  ) {
    return { ok: false, error: intakeError(firstCode ?? "invalid_input", fields) };
  }

  const total =
    (body.value?.bytes.byteLength ?? 0) + attachments.value.reduce((sum, a) => sum + a.bytes.byteLength, 0);
  if (total > intakeLimits.maxPayloadBytes) return { ok: false, error: intakeError("payload_too_large") };

  return {
    ok: true,
    value: {
      idempotencyKey: idempotencyKey.value,
      type: type.value,
      summary: summary.value,
      occurredAt: occurredAt.value,
      labels: labels.value,
      body: body.value,
      attachments: attachments.value,
    },
  };
}
