// The Service Bindings entry point (spec 5.2). The caller's binding sets entrypoint "Intake" and
// props { source_id: "src_..." }. Only DB, EVENT_DATA and DELIVERY_QUEUE are used; loadConfig is not.

import { WorkerEntrypoint } from "cloudflare:workers";
import { describeError } from "../auth/middleware";
import type { IngestConversationResponse } from "../api/types";
import { clock } from "../clock";
import { createDb } from "../db/client";
import type { Bindings } from "../env";
import { SOURCE_ID_PATTERN } from "../ids";
import { parseConversationInput, startSourceConversation } from "./conversation";
import { acceptEvent } from "./service";
import { intakeError, isPlainObject, type IntakeError, type IntakeErrorCode, type IntakeInput } from "./validation";

// Checked at run time: props come from the caller's configuration.
export type IntakeProps = { source_id?: unknown };

export type IntakeRpcError = {
  code: IntakeErrorCode;
  message: string;
  // true only for temporarily_unavailable: retry with the same idempotency_key.
  retryable: boolean;
  fields?: Record<string, string>;
};

export type IntakeRpcResult = { ok: true; event_id: string; duplicate: boolean } | { ok: false; error: IntakeRpcError };

export type IntakeRpcConversationResult =
  | ({ ok: true } & IngestConversationResponse)
  | { ok: false; error: IntakeRpcError };

const INPUT_FIELDS = new Set(["idempotency_key", "type", "summary", "occurred_at", "labels", "body", "attachments"]);
const BODY_FIELDS = new Set(["content_type", "bytes"]);
const ATTACHMENT_FIELDS = new Set(["name", "content_type", "bytes"]);

type Structured = { ok: true; input: IntakeInput } | { ok: false; error: IntakeError };

function toRpcError(error: IntakeError): { ok: false; error: IntakeRpcError } {
  const result: IntakeRpcError = {
    code: error.code,
    message: error.message,
    retryable: error.code === "temporarily_unavailable",
  };
  if (error.fields !== undefined) result.fields = error.fields;
  return { ok: false, error: result };
}

function fail(code: IntakeErrorCode, field?: string, reason?: string): Structured {
  return { ok: false, error: intakeError(code, field === undefined ? undefined : { [field]: reason ?? "" }) };
}

// Uint8Array as is, ArrayBuffer as a view. Anything else (ReadableStream, strings, DataView, ...) is null.
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // A stream sent over RPC that is never read keeps the caller's side waiting; release it.
  if (value instanceof ReadableStream) value.cancel().catch(() => {});
  return null;
}

function unknownKey(value: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(value)) if (!allowed.has(key)) return key;
  return null;
}

function structure(input: unknown): Structured {
  if (!isPlainObject(input)) return fail("invalid_input");
  const unknown = unknownKey(input, INPUT_FIELDS);
  if (unknown !== null) return fail("unknown_field", unknown, "未知の項目です");

  let body: IntakeInput["body"] = null;
  if (input.body !== undefined && input.body !== null) {
    if (!isPlainObject(input.body)) return fail("invalid_body", "body", "オブジェクトにしてください");
    const unknownBodyKey = unknownKey(input.body, BODY_FIELDS);
    if (unknownBodyKey !== null) return fail("unknown_field", `body.${unknownBodyKey}`, "未知の項目です");
    const bytes = toBytes(input.body.bytes);
    if (bytes === null) return fail("invalid_body", "body", "bytes は Uint8Array か ArrayBuffer にしてください");
    body = { content_type: input.body.content_type, bytes };
  }

  let attachments: IntakeInput["attachments"] = null;
  if (input.attachments !== undefined && input.attachments !== null) {
    if (!Array.isArray(input.attachments)) return fail("invalid_attachments", "attachments", "配列にしてください");
    attachments = [];
    for (const [index, item] of (input.attachments as unknown[]).entries()) {
      if (!isPlainObject(item)) {
        return fail("invalid_attachments", "attachments", `${index + 1} 番目をオブジェクトにしてください`);
      }
      const unknownItemKey = unknownKey(item, ATTACHMENT_FIELDS);
      if (unknownItemKey !== null) {
        return fail("unknown_field", `attachments.${unknownItemKey}`, "未知の項目です");
      }
      const bytes = toBytes(item.bytes);
      if (bytes === null) {
        return fail(
          "invalid_attachments",
          "attachments",
          `${index + 1} 番目の bytes は Uint8Array か ArrayBuffer にしてください`,
        );
      }
      attachments.push({ name: item.name, content_type: item.content_type, bytes });
    }
  }

  return {
    ok: true,
    input: {
      idempotency_key: input.idempotency_key,
      type: input.type,
      summary: input.summary,
      occurred_at: input.occurred_at,
      labels: input.labels,
      body,
      attachments,
    },
  };
}

type SourceRow = { id: string; workspace_id: string; name: string; enabled: number; screening_enabled: number };

// The source of props.source_id, or the error: unauthorized for a missing, malformed or unknown ID (the conversation
// source is never matched: it is unknown here), source_disabled for a disabled source. A function, not a method: every
// method of the entry point can be called over RPC.
async function propsSource(
  d1: D1Database,
  props: IntakeProps | undefined,
): Promise<{ ok: true; source: SourceRow } | { ok: false; error: IntakeError }> {
  const sourceId = props?.source_id;
  if (typeof sourceId !== "string" || !SOURCE_ID_PATTERN.test(sourceId)) {
    return { ok: false, error: intakeError("unauthorized") };
  }
  const source = await d1
    .prepare("SELECT id, workspace_id, name, enabled, screening_enabled FROM sources WHERE id = ? AND kind = 'program'")
    .bind(sourceId)
    .first<SourceRow>();
  if (!source) return { ok: false, error: intakeError("unauthorized") };
  if (!source.enabled) return { ok: false, error: intakeError("source_disabled") };
  return { ok: true, source };
}

export class Intake extends WorkerEntrypoint<Bindings, IntakeProps> {
  // Never throws: every failure is returned as { ok: false, error }.
  async submit(input: unknown): Promise<IntakeRpcResult> {
    try {
      // 1. The source, from props.
      const found = await propsSource(this.env.DB, this.ctx.props);
      if (!found.ok) return toRpcError(found.error);
      const source = found.source;

      // 2. Structure and validation, 3. the shared intake.
      const structured = structure(input);
      if (!structured.ok) return toRpcError(structured.error);
      const result = await acceptEvent(
        { db: this.env.DB, bucket: this.env.EVENT_DATA, queue: this.env.DELIVERY_QUEUE, now: clock.now() },
        {
          id: source.id,
          workspaceId: source.workspace_id,
          name: source.name,
          enabled: Boolean(source.enabled),
          screeningEnabled: source.screening_enabled === 1,
        },
        structured.input,
      );
      if (!result.ok) return toRpcError(result.error);
      return { ok: true, event_id: result.event_id, duplicate: result.duplicate };
    } catch (error) {
      console.error("intake: unexpected error in the RPC entry point", describeError(error));
      return toRpcError(intakeError("temporarily_unavailable"));
    }
  }

  // Starts a conversation as the source of props, with the input of POST /ingest/v1/conversations. Never throws:
  // every failure is returned as { ok: false, error }.
  async startConversation(input: unknown): Promise<IntakeRpcConversationResult> {
    try {
      // 1. The source, from props.
      const found = await propsSource(this.env.DB, this.ctx.props);
      if (!found.ok) return toRpcError(found.error);
      const source = found.source;

      // 2. The input.
      if (!isPlainObject(input)) return toRpcError(intakeError("invalid_input"));
      const parsed = parseConversationInput(input);
      if (!parsed.ok) return toRpcError(parsed.error);

      // 3. A retry, the source read again, the limits and the creation.
      const d1 = this.env.DB;
      const result = await startSourceConversation(
        { d1, db: createDb(d1), bucket: this.env.EVENT_DATA, queue: this.env.DELIVERY_QUEUE, now: clock.now() },
        { id: source.id, workspaceId: source.workspace_id },
        parsed.value,
      );
      if (!result.ok) return toRpcError(result.error);
      return { ok: true, ...result.body };
    } catch (error) {
      console.error("intake: unexpected error in the RPC conversation entry point", describeError(error));
      return toRpcError(intakeError("temporarily_unavailable"));
    }
  }
}
