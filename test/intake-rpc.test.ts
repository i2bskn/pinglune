import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "@i2bskn/workers-app-core";
import type { WorkspaceRow } from "../src/db/schema";
import {
  countTable,
  createSource,
  createUser,
  listEventDataKeys,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
} from "./helpers";

// The props of the bindings in vitest.config.ts. The calls go through Service Bindings to the Intake entry
// point, so this.ctx.props is read as in production.
const RPC_SOURCE_ID = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V";

const BASE = { idempotency_key: "k-1", type: "alert.observed", summary: "s" };

let workspace: WorkspaceRow;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  // Another user's workspace first, so that a wrong workspace would show.
  await createUser({ email: "first@example.com" });
  const user = await createUser({ email: "owner@example.com" });
  workspace = await personalWorkspaceOf(user);
  await createSource({ id: RPC_SOURCE_ID, workspaceId: workspace.id, name: "worker" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

describe("Intake.submit", () => {
  it("puts the event into the workspace of the source in props", async () => {
    const result = await env.INTAKE.submit({
      ...BASE,
      labels: { env: "prod" },
      body: { content_type: "text/plain", bytes: new TextEncoder().encode("raw") },
      attachments: [{ name: "a.bin", bytes: new Uint8Array([1, 2]).buffer }],
    });
    expect(result).toMatchObject({ ok: true, duplicate: false });
    if (!result.ok) return;
    const row = await env.DB.prepare("SELECT workspace_id, source_id FROM events WHERE id = ?")
      .bind(result.event_id)
      .first();
    expect(row).toEqual({ workspace_id: workspace.id, source_id: RPC_SOURCE_ID });
    const keys = await listEventDataKeys(`workspaces/${workspace.id}/events/${result.event_id}/`);
    expect(keys).toHaveLength(2);

    const again = await env.INTAKE.submit({
      ...BASE,
      labels: { env: "prod" },
      body: { content_type: "text/plain", bytes: new TextEncoder().encode("raw") },
      attachments: [{ name: "a.bin", bytes: new Uint8Array([1, 2]) }],
    });
    expect(again).toEqual({ ok: true, event_id: result.event_id, duplicate: true });
  });

  it("treats null optional items as left out", async () => {
    const result = await env.INTAKE.submit({ ...BASE, occurred_at: null, labels: null, body: null, attachments: null });
    expect(result).toMatchObject({ ok: true, duplicate: false });
  });

  it.each([
    ["no props", () => env.INTAKE_NO_PROPS],
    ["a malformed source ID", () => env.INTAKE_MALFORMED],
    ["a source ID that is not a string", () => env.INTAKE_NOT_STRING],
    ["an unknown source ID", () => env.INTAKE_UNKNOWN],
  ])("returns unauthorized for %s without throwing", async (_, binding) => {
    const result = await binding().submit(BASE);
    expect(result).toEqual({
      ok: false,
      error: { code: "unauthorized", message: expect.any(String), retryable: false },
    });
    expect(await countTable("events")).toBe(0);
  });

  it("returns source_disabled for a disabled source", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(RPC_SOURCE_ID).run();
    const result = await env.INTAKE.submit(BASE);
    expect(result).toMatchObject({ ok: false, error: { code: "source_disabled", retryable: false } });
    // Decided before the input is looked at.
    expect(await env.INTAKE.submit("not an object")).toMatchObject({ ok: false, error: { code: "source_disabled" } });
  });

  it("checks the source before the input", async () => {
    const result = await env.INTAKE_UNKNOWN.submit("not an object");
    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it.each([
    ["a string", "text"],
    ["null", null],
    ["an array", [BASE]],
  ])("returns invalid_input for %s", async (_, input) => {
    expect(await env.INTAKE.submit(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("returns unknown_field for an unknown item", async () => {
    expect(await env.INTAKE.submit({ ...BASE, extra: 1 })).toMatchObject({
      ok: false,
      error: { code: "unknown_field", fields: { extra: expect.any(String) } },
    });
    expect(
      await env.INTAKE.submit({ ...BASE, body: { bytes: new Uint8Array(1), encoding: "utf-8" } }),
    ).toMatchObject({ ok: false, error: { code: "unknown_field" } });
  });

  it("rejects bytes that are not a Uint8Array or an ArrayBuffer", async () => {
    expect(await env.INTAKE.submit({ ...BASE, body: { bytes: "text" } })).toMatchObject({
      ok: false,
      error: { code: "invalid_body" },
    });
    expect(await env.INTAKE.submit({ ...BASE, body: { bytes: new DataView(new ArrayBuffer(1)) } })).toMatchObject({
      ok: false,
      error: { code: "invalid_body" },
    });
    expect(await env.INTAKE.submit({ ...BASE, attachments: [{ name: "a", bytes: "text" }] })).toMatchObject({
      ok: false,
      error: { code: "invalid_attachments" },
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    expect(await env.INTAKE.submit({ ...BASE, body: { bytes: stream } })).toMatchObject({
      ok: false,
      error: { code: "invalid_body" },
    });
  });

  it("returns the fields of a validation error and is not retryable", async () => {
    const result = await env.INTAKE.submit({ ...BASE, type: "pinglune.x", labels: { A: "x" } });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_type",
        message: expect.any(String),
        retryable: false,
        fields: { type: expect.any(String), labels: expect.any(String) },
      },
    });
  });

  it("returns idempotency_conflict as not retryable", async () => {
    await env.INTAKE.submit(BASE);
    expect(await env.INTAKE.submit({ ...BASE, summary: "other" })).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict", retryable: false },
    });
  });

  it("returns temporarily_unavailable as retryable for an unexpected error, without throwing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(clock, "now").mockImplementation(() => {
      throw new Error("unexpected");
    });
    const result = await env.INTAKE.submit(BASE);
    expect(result).toEqual({
      ok: false,
      error: { code: "temporarily_unavailable", message: expect.any(String), retryable: true },
    });
    expect(errors).toHaveBeenCalled();
  });
});
