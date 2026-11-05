// POST /ingest/v1/events (spec 5.1) and POST /ingest/v1/conversations. Authenticated with an API key; sameOrigin does
// not apply.

import { Hono, type Context } from "hono";
import type { ApiError, IngestResponse } from "../api/types";
import { clock, describeError } from "@i2bskn/workers-app-core";
import type { AppEnv } from "../env";
import { authenticateApiKey } from "../sources/auth";
import { parseConversationInput, startSourceConversation } from "./conversation";
import { acceptEvent } from "./service";
import {
  intakeError,
  isPlainObject,
  maxRequestBytes,
  type IntakeError,
  type IntakeErrorCode,
  type IntakeInput,
} from "./validation";

const JSON_FIELDS = new Set(["idempotency_key", "type", "summary", "occurred_at", "labels", "body", "body_content_type"]);
const METADATA_FIELDS = new Set(["idempotency_key", "type", "summary", "occurred_at", "labels"]);
const DEFAULT_JSON_BODY_CONTENT_TYPE = "text/plain; charset=utf-8";
// The limit of the JSON body of POST /ingest/v1/conversations: a message of 64 KiB may take about 3 times as much
// once escaped in JSON (\uXXXX\uXXXX for an emoji), with room for the title and the participants.
const CONVERSATION_MAX_REQUEST_BYTES = 256 * 1024;
const conversationMediaTypeMessage = "Content-Type は application/json にしてください";
const conversationTooLargeMessage = "本文が大きすぎます（JSON 全体で 256 KiB まで）";

type Structured = { ok: true; input: IntakeInput } | { ok: false; error: IntakeError };

function errorResponse(c: Context<AppEnv>, error: IntakeError): Response {
  const body: ApiError = { error: { code: error.code, message: error.message } };
  if (error.fields !== undefined) body.error.fields = error.fields;
  if (error.status === 401) c.header("WWW-Authenticate", "Bearer");
  return c.json(body, error.status);
}

function fail(code: IntakeErrorCode, field?: string, reason?: string): Structured {
  return { ok: false, error: intakeError(code, field === undefined ? undefined : { [field]: reason ?? "" }) };
}

// The media type without parameters, lowercased, and whether a boundary parameter is present.
function parseContentType(header: string | undefined): { mediaType: string; hasBoundary: boolean } | null {
  if (header === undefined) return null;
  const [mediaType = "", ...parameters] = header.split(";");
  const hasBoundary = parameters.some((p) => {
    const [name = "", value = ""] = p.split("=");
    return name.trim().toLowerCase() === "boundary" && value.trim() !== "";
  });
  return { mediaType: mediaType.trim().toLowerCase(), hasBoundary };
}

// Reads the body while counting the bytes. null if it is over limit; reading stops there.
async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      // cancel() rejects on a stream that has errored; the 413 stands.
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function fromJson(bytes: Uint8Array): Structured {
  const json = parseJsonObject(bytes);
  if (json === null) return fail("invalid_json");

  const body = json.body ?? null;
  const bodyContentType = json.body_content_type ?? null;
  if (body !== null && typeof body !== "string") return fail("invalid_body", "body", "文字列にしてください");
  if (bodyContentType !== null && body === null) {
    return fail("invalid_body", "body", "body_content_type だけを指定することはできません");
  }
  if ("attachments" in json) {
    return fail("invalid_attachments", "attachments", "添付は multipart/form-data で送ってください");
  }
  for (const key of Object.keys(json)) {
    if (!JSON_FIELDS.has(key)) return fail("unknown_field", key, "未知の項目です");
  }

  return {
    ok: true,
    input: {
      idempotency_key: json.idempotency_key,
      type: json.type,
      summary: json.summary,
      occurred_at: json.occurred_at,
      labels: json.labels,
      body:
        body === null
          ? null
          : {
              content_type: bodyContentType ?? DEFAULT_JSON_BODY_CONTENT_TYPE,
              bytes: new TextEncoder().encode(body),
            },
    },
  };
}

async function fromMultipart(bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<Structured> {
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return fail("invalid_multipart");
  }

  let metadata: string | null = null;
  let metadataCount = 0;
  let body: File | null = null;
  const attachments: File[] = [];
  for (const [name, value] of form.entries()) {
    switch (name) {
      case "metadata":
        metadataCount++;
        if (typeof value !== "string") return fail("invalid_multipart", "metadata", "文字列のフィールドにしてください");
        metadata = value;
        break;
      case "body":
        if (typeof value === "string") return fail("invalid_multipart", "body", "ファイルのパートにしてください");
        if (body !== null) return fail("invalid_multipart", "body", "1 つまでです");
        body = value;
        break;
      case "attachments":
        if (typeof value === "string") return fail("invalid_multipart", "attachments", "ファイルのパートにしてください");
        attachments.push(value);
        break;
      default:
        return fail("invalid_multipart", name, "未知のパートです");
    }
  }
  if (metadata === null || metadataCount !== 1) {
    return fail("invalid_multipart", "metadata", "metadata のパートを 1 つだけ含めてください");
  }

  const json = parseJsonObject(new TextEncoder().encode(metadata));
  if (json === null) return fail("invalid_json", "metadata", "JSON オブジェクトにしてください");
  for (const key of Object.keys(json)) {
    if (!METADATA_FIELDS.has(key)) return fail("unknown_field", key, "未知の項目です");
  }

  return {
    ok: true,
    input: {
      idempotency_key: json.idempotency_key,
      type: json.type,
      summary: json.summary,
      occurred_at: json.occurred_at,
      labels: json.labels,
      body: body === null ? null : { content_type: body.type, bytes: new Uint8Array(await body.arrayBuffer()) },
      attachments: await Promise.all(
        attachments.map(async (file) => ({
          name: file.name,
          content_type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      ),
    },
  };
}

async function ingest(c: Context<AppEnv>): Promise<Response> {
  const now = clock.now();
  const db = c.get("db");

  // 1. Authentication, from the header only. The body is not read yet.
  const auth = await authenticateApiKey(db, c.req.header("Authorization"), now);
  if (!auth.ok) return errorResponse(c, intakeError(auth.error));

  // 2. Content-Type.
  const contentType = c.req.header("Content-Type");
  const parsed = parseContentType(contentType);
  const isJson = parsed?.mediaType === "application/json";
  const isMultipart = parsed?.mediaType === "multipart/form-data" && parsed.hasBoundary;
  if (contentType === undefined || (!isJson && !isMultipart)) {
    return errorResponse(c, intakeError("unsupported_media_type"));
  }

  // 3. Content-Length, before reading.
  const limit = maxRequestBytes();
  const declared = c.req.header("Content-Length");
  if (declared !== undefined && Number(declared) > limit) return errorResponse(c, intakeError("payload_too_large"));

  // 4. The body, counted while reading (a request may have no Content-Length).
  const bytes = await readLimited(c.req.raw.body, limit);
  if (bytes === null) return errorResponse(c, intakeError("payload_too_large"));

  // 5. Structure.
  const structured = isJson ? fromJson(bytes) : await fromMultipart(bytes, contentType);
  if (!structured.ok) return errorResponse(c, structured.error);

  // 6. Validation and the shared intake.
  const result = await acceptEvent(
    { db: c.env.DB, bucket: c.env.EVENT_DATA, queue: c.env.DELIVERY_QUEUE, now },
    {
      id: auth.source.id,
      workspaceId: auth.source.workspaceId,
      name: auth.source.name,
      enabled: auth.source.enabled,
      screeningEnabled: auth.source.screeningEnabled === 1,
    },
    structured.input,
  );
  if (!result.ok) return errorResponse(c, result.error);
  const body: IngestResponse = { event_id: result.event_id, duplicate: result.duplicate };
  return c.json(body, result.duplicate ? 200 : 201);
}

// A conversation started by the source of the API key, with the first message of the program.
async function startConversation(c: Context<AppEnv>): Promise<Response> {
  const now = clock.now();
  const db = c.get("db");

  // 1. Authentication, from the header only. The body is not read yet.
  const auth = await authenticateApiKey(db, c.req.header("Authorization"), now);
  if (!auth.ok) return errorResponse(c, intakeError(auth.error));

  // 2. Content-Type, then the size: Content-Length before reading, then the bytes counted while reading.
  if (parseContentType(c.req.header("Content-Type"))?.mediaType !== "application/json") {
    return errorResponse(c, { ...intakeError("unsupported_media_type"), message: conversationMediaTypeMessage });
  }
  const tooLarge = { ...intakeError("payload_too_large"), message: conversationTooLargeMessage };
  const declared = c.req.header("Content-Length");
  if (declared !== undefined && Number(declared) > CONVERSATION_MAX_REQUEST_BYTES) return errorResponse(c, tooLarge);
  const bytes = await readLimited(c.req.raw.body, CONVERSATION_MAX_REQUEST_BYTES);
  if (bytes === null) return errorResponse(c, tooLarge);

  // 3. JSON and the input.
  const json = parseJsonObject(bytes);
  if (json === null) return errorResponse(c, intakeError("invalid_json"));
  const parsed = parseConversationInput(json);
  if (!parsed.ok) return errorResponse(c, parsed.error);

  // 4. to 9.: a retry, the source, the limits and the creation.
  const result = await startSourceConversation(
    { d1: c.env.DB, db, bucket: c.env.EVENT_DATA, queue: c.env.DELIVERY_QUEUE, now },
    { id: auth.source.id, workspaceId: auth.source.workspaceId },
    parsed.value,
  );
  if (!result.ok) return errorResponse(c, result.error);
  return c.json(result.body, result.status);
}

const intake = new Hono<AppEnv>()
  .post("/v1/events", async (c) => {
    try {
      return await ingest(c);
    } catch (error) {
      // Never logs the request headers: they carry the API key.
      console.error("intake: unexpected error in the HTTP handler", describeError(error));
      return errorResponse(c, intakeError("temporarily_unavailable"));
    }
  })
  .post("/v1/conversations", async (c) => {
    try {
      return await startConversation(c);
    } catch (error) {
      // Never logs the request headers: they carry the API key.
      console.error("intake: unexpected error in the HTTP conversation handler", describeError(error));
      return errorResponse(c, intakeError("temporarily_unavailable"));
    }
  });

export default intake;
