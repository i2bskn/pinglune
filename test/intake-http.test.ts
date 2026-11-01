import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRow, SourceRow, UserRow } from "../src/db/schema";
import { sha256Hex } from "../src/ids";
import worker from "../src/index";
import { intakeLimits, MAX_PAYLOAD_BYTES } from "../src/intake/validation";
import {
  ORIGIN,
  bucketWith,
  countTable,
  createApiKey,
  createSource,
  createUser,
  listEventDataKeys,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
} from "./helpers";

const URL_PATH = "/ingest/v1/events";

let user: UserRow;
let workspace: WorkspaceRow;
let source: SourceRow;
let key: string;
let keyId: string;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  user = await createUser({ email: "owner@example.com", role: "admin" });
  workspace = await personalWorkspaceOf(user);
  source = await createSource({ workspaceId: workspace.id, name: "app" });
  ({ key, keyId } = await createApiKey(source.id));
});

afterEach(async () => {
  intakeLimits.maxPayloadBytes = MAX_PAYLOAD_BYTES;
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

function auth(apiKey = key): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function postJson(json: unknown, apiKey = key, extra: Record<string, string> = {}): Promise<Response> {
  return send(URL_PATH, { json, headers: { ...auth(apiKey), ...extra } });
}

function postForm(form: FormData, apiKey = key): Promise<Response> {
  return send(URL_PATH, { method: "POST", body: form, headers: auth(apiKey) });
}

function metadataForm(metadata: unknown): FormData {
  const form = new FormData();
  form.append("metadata", typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  return form;
}

const BASE = { idempotency_key: "k-1", type: "alert.observed", summary: "疎通確認" };

type ErrorBody = { error: { code: string; message: string; fields?: Record<string, string> } };

async function errorOf(res: Response): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}

async function expectError(res: Response, status: number, code: string): Promise<ErrorBody["error"]> {
  expect(res.status).toBe(status);
  const error = await errorOf(res);
  expect(error.code).toBe(code);
  return error;
}

async function eventRow(id: string) {
  return env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

async function dataRows(eventId: string) {
  const { results } = await env.DB.prepare("SELECT * FROM event_data WHERE event_id = ? ORDER BY position")
    .bind(eventId)
    .all<Record<string, unknown>>();
  return results;
}

describe("POST /ingest/v1/events: success", () => {
  it("accepts JSON without a body", async () => {
    const res = await postJson({ ...BASE, labels: { env: "staging" }, occurred_at: "2026-10-31T12:00:00.5+09:00" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event_id: string; duplicate: boolean };
    expect(body.duplicate).toBe(false);
    expect(body.event_id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    const row = await eventRow(body.event_id);
    expect(row).toMatchObject({
      workspace_id: workspace.id,
      source_id: source.id,
      idempotency_key: "k-1",
      type: "alert.observed",
      summary: "疎通確認",
      labels: '{"env":"staging"}',
      occurred_at: Date.UTC(2026, 9, 31, 3, 0, 0, 500),
    });
    expect(await dataRows(body.event_id)).toEqual([]);
    expect(await listEventDataKeys()).toEqual([]);
  });

  it("uses the time received when occurred_at is left out, and stores {} for no labels", async () => {
    const before = Date.now();
    const res = await postJson(BASE);
    const { event_id } = (await res.json()) as { event_id: string };
    const row = await eventRow(event_id);
    expect(row?.labels).toBe("{}");
    expect(row?.occurred_at).toBe(row?.received_at);
    expect(row?.received_at as number).toBeGreaterThanOrEqual(before);
  });

  it("stores a string body in R2 with its Content-Type", async () => {
    const res = await postJson({ ...BASE, body: "本文です" });
    expect(res.status).toBe(201);
    const { event_id } = (await res.json()) as { event_id: string };
    const [data] = await dataRows(event_id);
    const bytes = new TextEncoder().encode("本文です");
    expect(data).toMatchObject({
      role: "body",
      name: "body",
      content_type: "text/plain; charset=utf-8",
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      position: 0,
      workspace_id: workspace.id,
    });
    const r2Key = `workspaces/${workspace.id}/events/${event_id}/${String(data?.id)}`;
    expect(data?.r2_key).toBe(r2Key);
    const object = await env.EVENT_DATA.get(r2Key);
    expect(await object?.text()).toBe("本文です");
    expect(object?.httpMetadata?.contentType).toBe("text/plain; charset=utf-8");
  });

  it("uses body_content_type for the body", async () => {
    const res = await postJson({ ...BASE, body: "{}", body_content_type: " application/json " });
    const { event_id } = (await res.json()) as { event_id: string };
    expect((await dataRows(event_id))[0]?.content_type).toBe("application/json");
  });

  it("accepts multipart with a body and two attachments", async () => {
    const form = metadataForm(BASE);
    form.append("body", new File(["raw log"], "ignored.txt", { type: "text/plain" }));
    form.append("attachments", new File([new Uint8Array([1, 2, 3])], "a.bin", { type: "application/x-test" }));
    form.append("attachments", new File(["second"], " b.txt ", { type: "text/csv" }));
    const res = await postForm(form);
    expect(res.status).toBe(201);
    const { event_id } = (await res.json()) as { event_id: string };
    const rows = await dataRows(event_id);
    expect(rows.map((r) => [r.role, r.name, r.content_type, r.size, r.position])).toEqual([
      ["body", "body", "text/plain", 7, 0],
      ["attachment", "a.bin", "application/x-test", 3, 1],
      ["attachment", "b.txt", "text/csv", 6, 2],
    ]);
    expect(rows[1]?.sha256).toBe(await sha256Hex(new Uint8Array([1, 2, 3])));
    const keys = await listEventDataKeys();
    expect(keys).toEqual(rows.map((r) => r.r2_key).sort());
    const second = await env.EVENT_DATA.get(String(rows[2]?.r2_key));
    expect(await second?.text()).toBe("second");
    expect(second?.httpMetadata?.contentType).toBe("text/csv");
  });

  it("puts the event into the workspace of the key's source and updates last_used_at", async () => {
    const other = await createUser({ email: "other@example.com" });
    const otherWorkspace = await personalWorkspaceOf(other);
    const otherSource = await createSource({ workspaceId: otherWorkspace.id, name: "app" });
    const otherKey = await createApiKey(otherSource.id);

    const res = await postJson(BASE, otherKey.key);
    const { event_id } = (await res.json()) as { event_id: string };
    expect(await eventRow(event_id)).toMatchObject({ workspace_id: otherWorkspace.id, source_id: otherSource.id });

    const used = await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE id = ?")
      .bind(otherKey.keyId)
      .first<{ last_used_at: number | null }>();
    expect(used?.last_used_at).not.toBeNull();
    const unused = await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE id = ?")
      .bind(keyId)
      .first<{ last_used_at: number | null }>();
    expect(unused?.last_used_at).toBeNull();
  });

  it("accepts application/json with parameters and in any case", async () => {
    const withCharset = await send(URL_PATH, {
      body: JSON.stringify(BASE),
      headers: { ...auth(), "Content-Type": "application/json; charset=utf-8" },
    });
    expect(withCharset.status).toBe(201);
    const upper = await send(URL_PATH, {
      body: JSON.stringify({ ...BASE, idempotency_key: "k-2" }),
      headers: { ...auth(), "Content-Type": "Application/JSON" },
    });
    expect(upper.status).toBe(201);
  });

  it("treats null optional items as left out", async () => {
    const res = await postJson({ ...BASE, occurred_at: null, labels: null, body: null, body_content_type: null });
    expect(res.status).toBe(201);
    // The same event without the items is a duplicate.
    const again = await postJson(BASE);
    expect(again.status).toBe(200);
  });
});

describe("POST /ingest/v1/events: duplicates", () => {
  it("returns the same event for the same key and content without writing again", async () => {
    const first = (await (await postJson({ ...BASE, body: "x" })).json()) as { event_id: string };
    const res = await postJson({ ...BASE, body: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event_id: first.event_id, duplicate: true });
    expect(await countTable("events")).toBe(1);
    expect(await listEventDataKeys()).toHaveLength(1);
  });

  it("rejects the same key with different content", async () => {
    await postJson(BASE);
    await expectError(await postJson({ ...BASE, summary: "別の内容" }), 409, "idempotency_conflict");
    await expectError(await postJson({ ...BASE, labels: { a: "b" } }), 409, "idempotency_conflict");
    await expectError(await postJson({ ...BASE, body: "x" }), 409, "idempotency_conflict");
  });

  it("treats a retry without occurred_at as the same content, whatever the time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 1));
      const first = (await (await postJson(BASE)).json()) as { event_id: string };
      vi.setSystemTime(Date.UTC(2026, 9, 2));
      const res = await postJson(BASE);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { event_id: string }).event_id).toBe(first.event_id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps keys separate per source", async () => {
    const second = await createSource({ workspaceId: workspace.id, name: "second" });
    const secondKey = await createApiKey(second.id);
    expect((await postJson(BASE)).status).toBe(201);
    expect((await postJson({ ...BASE, summary: "other" }, secondKey.key)).status).toBe(201);
  });
});

describe("POST /ingest/v1/events: authentication", () => {
  async function expectUnauthorized(res: Response): Promise<string> {
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    return res.text();
  }

  it("rejects every kind of bad key with the same response", async () => {
    const secret = key.slice(`pl_${keyId}_`.length);
    const revoked = await createApiKey(source.id, { revokedAt: Date.now() });
    const bodies = new Set<string>();
    const cases: (Record<string, string> | undefined)[] = [
      undefined,
      { Authorization: `Basic ${key}` },
      { Authorization: key },
      { Authorization: `bearer ${key}` },
      { Authorization: `Bearer pl_${keyId.slice(1)}_${secret}` },
      { Authorization: `Bearer pl_${keyId}a_${secret}` },
      { Authorization: `Bearer pl_${keyId}_${secret.slice(1)}` },
      { Authorization: `Bearer pl_${keyId}_${secret}A` },
      { Authorization: `Bearer pl_${"z".repeat(16)}_${secret}` },
      { Authorization: `Bearer pl_${keyId}_${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}` },
      { Authorization: `Bearer ${revoked.key}` },
    ];
    for (const headers of cases) {
      const res = await send(URL_PATH, { json: BASE, headers });
      bodies.add(await expectUnauthorized(res));
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0] ?? "")).toMatchObject({ error: { code: "unauthorized" } });
    expect(await countTable("events")).toBe(0);
  });

  it("accepts a correct key whose secret has _ and -", async () => {
    const secret = `_-${"a".repeat(40)}-`;
    const special = await createApiKey(source.id, { secret });
    expect((await postJson(BASE, special.key)).status).toBe(201);
  });

  it("rejects a disabled source with 403", async () => {
    const disabled = await createSource({ workspaceId: workspace.id, name: "off", enabled: false });
    const disabledKey = await createApiKey(disabled.id);
    await expectError(await postJson(BASE, disabledKey.key), 403, "source_disabled");
    expect(await countTable("events")).toBe(0);
    // Decided with the authentication, before the Content-Type and the body.
    const res = await send(URL_PATH, {
      body: "x",
      headers: { Authorization: `Bearer ${disabledKey.key}`, "Content-Type": "text/plain" },
    });
    await expectError(res, 403, "source_disabled");
  });

  it("ignores a key in the query string", async () => {
    const res = await send(`${URL_PATH}?api_key=${encodeURIComponent(key)}&access_token=${encodeURIComponent(key)}`, {
      json: BASE,
    });
    await expectUnauthorized(res);
  });

  it("authenticates before looking at the size", async () => {
    const res = await send(URL_PATH, {
      body: JSON.stringify(BASE),
      headers: { "Content-Type": "application/json", "Content-Length": String(1024 * 1024 * 1024) },
    });
    await expectUnauthorized(res);
  });

  it("authenticates before looking at the Content-Type", async () => {
    const res = await send(URL_PATH, { body: "x", headers: { "Content-Type": "text/plain" } });
    await expectUnauthorized(res);
  });
});

describe("POST /ingest/v1/events: validation", () => {
  async function expectInvalid(json: unknown, code: string, field?: string) {
    const error = await expectError(await postJson(json), 400, code);
    if (field !== undefined) expect(Object.keys(error.fields ?? {})).toContain(field);
    return error;
  }

  async function expectAccepted(json: Record<string, unknown>) {
    const res = await postJson(json);
    expect(res.status).toBe(201);
  }

  it("checks idempotency_key", async () => {
    await expectAccepted({ ...BASE, idempotency_key: "!".repeat(255) });
    await expectInvalid({ ...BASE, idempotency_key: "!".repeat(256) }, "invalid_idempotency_key", "idempotency_key");
    await expectInvalid({ ...BASE, idempotency_key: "a b" }, "invalid_idempotency_key");
    await expectInvalid({ ...BASE, idempotency_key: "" }, "invalid_idempotency_key");
    await expectInvalid({ ...BASE, idempotency_key: "あ" }, "invalid_idempotency_key");
    await expectInvalid({ type: BASE.type, summary: BASE.summary }, "invalid_idempotency_key");
  });

  it("checks type", async () => {
    await expectAccepted({ ...BASE, idempotency_key: "t1", type: `a.${"b".repeat(98)}` });
    await expectInvalid({ ...BASE, type: `a.${"b".repeat(99)}` }, "invalid_type", "type");
    await expectInvalid({ ...BASE, type: "pinglune.event" }, "invalid_type");
    await expectInvalid({ ...BASE, type: "Alert" }, "invalid_type");
    await expectInvalid({ ...BASE, type: "a..b" }, "invalid_type");
    await expectInvalid({ ...BASE, type: ".a" }, "invalid_type");
  });

  it("checks summary", async () => {
    await expectAccepted({ ...BASE, idempotency_key: "s1", summary: "あ".repeat(2000) });
    await expectAccepted({ ...BASE, idempotency_key: "s2", summary: "😀".repeat(2000) });
    await expectAccepted({ ...BASE, idempotency_key: "s3", summary: "a\nb\r\n\tc" });
    await expectInvalid({ ...BASE, summary: "あ".repeat(2001) }, "invalid_summary", "summary");
    await expectInvalid({ ...BASE, summary: "  \n " }, "invalid_summary");
    await expectInvalid({ ...BASE, summary: "a\u0000b" }, "invalid_summary");
    await expectInvalid({ ...BASE, summary: "a\u0085b" }, "invalid_summary");
    await expectInvalid({ ...BASE, summary: 1 }, "invalid_summary");
  });

  it("keeps the spaces around summary", async () => {
    const res = await postJson({ ...BASE, summary: "  padded  " });
    const { event_id } = (await res.json()) as { event_id: string };
    expect((await eventRow(event_id))?.summary).toBe("  padded  ");
  });

  it("checks occurred_at", async () => {
    await expectAccepted({ ...BASE, idempotency_key: "o1", occurred_at: "2026-02-28T23:59:59Z" });
    await expectAccepted({ ...BASE, idempotency_key: "o2", occurred_at: "2028-02-29T00:00:00.123-05:30" });
    await expectInvalid({ ...BASE, occurred_at: "2026-02-30T00:00:00Z" }, "invalid_occurred_at", "occurred_at");
    await expectInvalid({ ...BASE, occurred_at: "2026-02-29T00:00:00Z" }, "invalid_occurred_at");
    await expectInvalid({ ...BASE, occurred_at: "2026-10-31T24:00:00Z" }, "invalid_occurred_at");
    await expectInvalid({ ...BASE, occurred_at: "2026-10-31T12:00:00.123456Z" }, "invalid_occurred_at");
    await expectInvalid({ ...BASE, occurred_at: "2026-10-31 12:00:00Z" }, "invalid_occurred_at");
    await expectInvalid({ ...BASE, occurred_at: "2026-10-31T12:00:00" }, "invalid_occurred_at");
    await expectInvalid({ ...BASE, occurred_at: 1_700_000_000_000 }, "invalid_occurred_at");
  });

  it("checks labels", async () => {
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"]));
    const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
    await expectAccepted({ ...BASE, idempotency_key: "l1", labels: sixteen });
    await expectAccepted({ ...BASE, idempotency_key: "l2", labels: { [`a${"b".repeat(62)}`]: "x".repeat(256) } });
    await expectInvalid({ ...BASE, labels: seventeen }, "invalid_labels", "labels");
    await expectInvalid({ ...BASE, labels: { [`a${"b".repeat(63)}`]: "x" } }, "invalid_labels");
    await expectInvalid({ ...BASE, labels: { a: "x".repeat(257) } }, "invalid_labels");
    await expectInvalid({ ...BASE, labels: { a: "" } }, "invalid_labels");
    await expectInvalid({ ...BASE, labels: { a: "x\ny" } }, "invalid_labels");
    await expectInvalid({ ...BASE, labels: { A: "x" } }, "invalid_labels");
    await expectInvalid({ ...BASE, labels: { _a: "x" } }, "invalid_labels");
    await expectInvalid({ ...BASE, labels: { a: 1 } }, "invalid_labels");
    await expectInvalid({ ...BASE, labels: ["a"] }, "invalid_labels");
  });

  it("checks the body of a JSON request", async () => {
    await expectInvalid({ ...BASE, body: "" }, "invalid_body", "body");
    await expectInvalid({ ...BASE, body: { text: "x" } }, "invalid_body");
    await expectInvalid({ ...BASE, body_content_type: "text/plain" }, "invalid_body");
    await expectInvalid({ ...BASE, body: "x", body_content_type: "text" }, "invalid_body");
    await expectInvalid({ ...BASE, body: "x", body_content_type: `a/${"b".repeat(254)}` }, "invalid_body");
    await expectAccepted({ ...BASE, idempotency_key: "b1", body: "x", body_content_type: `a/${"b".repeat(253)}` });
    await expectInvalid({ ...BASE, body: "x", body_content_type: "text/plain; name=é" }, "invalid_body");
  });

  it("rejects attachments and unknown items in JSON", async () => {
    await expectInvalid({ ...BASE, attachments: [] }, "invalid_attachments", "attachments");
    await expectInvalid({ ...BASE, extra: 1 }, "unknown_field", "extra");
  });

  it("rejects JSON that is not an object", async () => {
    await expectInvalid("[1]", "invalid_json");
    await expectInvalid("{", "invalid_json");
    await expectInvalid('"text"', "invalid_json");
  });

  it("reports the code of the first invalid item and every invalid item in fields", async () => {
    const error = await expectInvalid(
      { idempotency_key: "", type: "pinglune.x", summary: "ok", labels: { A: "x" } },
      "invalid_idempotency_key",
    );
    expect(Object.keys(error.fields ?? {}).sort()).toEqual(["idempotency_key", "labels", "type"]);
  });
});

describe("POST /ingest/v1/events: multipart", () => {
  it("checks the attachments", async () => {
    const twenty = metadataForm(BASE);
    for (let i = 0; i < 20; i++) twenty.append("attachments", new File([""], `f${i}.txt`));
    expect((await postForm(twenty)).status).toBe(201);

    const twentyOne = metadataForm({ ...BASE, idempotency_key: "k-21" });
    for (let i = 0; i < 21; i++) twentyOne.append("attachments", new File(["x"], `f${i}.txt`));
    await expectError(await postForm(twentyOne), 400, "invalid_attachments");

    const longName = metadataForm({ ...BASE, idempotency_key: "k-name" });
    longName.append("attachments", new File(["x"], `${"a".repeat(256)}`));
    await expectError(await postForm(longName), 400, "invalid_attachments");

    const okName = metadataForm({ ...BASE, idempotency_key: "k-name-ok" });
    okName.append("attachments", new File(["x"], `${"a".repeat(255)}`));
    expect((await postForm(okName)).status).toBe(201);

    const backslash = metadataForm({ ...BASE, idempotency_key: "k-slash" });
    backslash.append("attachments", new File(["x"], "a\\b"));
    await expectError(await postForm(backslash), 400, "invalid_attachments");
  });

  it("rejects a 0-byte body (0-byte attachments are accepted above)", async () => {
    const empty = metadataForm(BASE);
    empty.append("body", new File([""], "body.txt", { type: "text/plain" }));
    await expectError(await postForm(empty), 400, "invalid_body");
  });

  it("uses application/octet-stream when a part has no Content-Type", async () => {
    const form = new FormData();
    form.append("metadata", JSON.stringify(BASE));
    form.append("attachments", new File(["x"], "raw"));
    const res = await postForm(form);
    const { event_id } = (await res.json()) as { event_id: string };
    expect((await dataRows(event_id))[0]?.content_type).toBe("application/octet-stream");
  });

  it.each([
    ["no metadata", () => new FormData()],
    [
      "two metadata parts",
      () => {
        const form = metadataForm(BASE);
        form.append("metadata", JSON.stringify(BASE));
        return form;
      },
    ],
    [
      "metadata as a file",
      () => {
        const form = new FormData();
        form.append("metadata", new File([JSON.stringify(BASE)], "m.json", { type: "application/json" }));
        return form;
      },
    ],
    [
      "an unknown part",
      () => {
        const form = metadataForm(BASE);
        form.append("other", "x");
        return form;
      },
    ],
    [
      "body as a string field",
      () => {
        const form = metadataForm(BASE);
        form.append("body", "text");
        return form;
      },
    ],
    [
      "two bodies",
      () => {
        const form = metadataForm(BASE);
        form.append("body", new File(["a"], "a"));
        form.append("body", new File(["b"], "b"));
        return form;
      },
    ],
    [
      "attachments as a string field",
      () => {
        const form = metadataForm(BASE);
        form.append("attachments", "text");
        return form;
      },
    ],
  ])("rejects %s", async (_, build) => {
    await expectError(await postForm(build()), 400, "invalid_multipart");
  });

  it("rejects metadata that is not a JSON object", async () => {
    await expectError(await postForm(metadataForm("{")), 400, "invalid_json");
    await expectError(await postForm(metadataForm("[]")), 400, "invalid_json");
  });

  it.each(["body", "attachments", "body_content_type", "extra"])("rejects %s in metadata", async (field) => {
    const error = await expectError(await postForm(metadataForm({ ...BASE, [field]: "x" })), 400, "unknown_field");
    expect(error.fields).toHaveProperty(field);
  });

  it("rejects a body whose boundary does not match", async () => {
    const res = await send(URL_PATH, {
      body: `--other\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(BASE)}\r\n--other--\r\n`,
      headers: { ...auth(), "Content-Type": "multipart/form-data; boundary=expected" },
    });
    await expectError(res, 400, "invalid_multipart");
  });
});

describe("POST /ingest/v1/events: size", () => {
  it("uses 25 MiB as the payload limit", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(26_214_400);
  });

  it("accepts a payload of exactly the limit and rejects one byte more", async () => {
    intakeLimits.maxPayloadBytes = 1000;
    const exact = metadataForm(BASE);
    exact.append("body", new File([new Uint8Array(600)], "b"));
    exact.append("attachments", new File([new Uint8Array(400)], "a"));
    expect((await postForm(exact)).status).toBe(201);

    const over = metadataForm({ ...BASE, idempotency_key: "k-over" });
    over.append("body", new File([new Uint8Array(600)], "b"));
    over.append("attachments", new File([new Uint8Array(401)], "a"));
    await expectError(await postForm(over), 413, "payload_too_large");
  });

  it("rejects a Content-Length over the limit without reading the body", async () => {
    intakeLimits.maxPayloadBytes = 1000;
    const request = new Request(new URL(URL_PATH, ORIGIN), {
      method: "POST",
      headers: {
        ...auth(),
        "Content-Type": "application/json",
        "Content-Length": String(1000 + 1024 * 1024 + 1),
      },
      body: JSON.stringify(BASE),
    });
    const res = await worker.fetch(request, { ...env }, createExecutionContext());
    await expectError(res, 413, "payload_too_large");
    expect(request.bodyUsed).toBe(false);
  });

  it("stops reading a body without Content-Length once it is over the limit", async () => {
    intakeLimits.maxPayloadBytes = 1000;
    const limit = 1000 + 1024 * 1024;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Far more than the limit, if it were read to the end.
        if (sent > limit * 4) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const request = new Request(new URL(URL_PATH, ORIGIN), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: stream,
    });
    expect(request.headers.get("Content-Length")).toBeNull();
    const res = await worker.fetch(request, { ...env }, createExecutionContext());
    await expectError(res, 413, "payload_too_large");
    expect(canceled).toBe(true);
    expect(sent).toBeLessThan(limit * 2);
  });
});

describe("POST /ingest/v1/events: Content-Type", () => {
  it("rejects a missing or unsupported Content-Type with 415", async () => {
    await expectError(await send(URL_PATH, { body: JSON.stringify(BASE), headers: auth() }), 415, "unsupported_media_type");
    await expectError(
      await send(URL_PATH, { body: JSON.stringify(BASE), headers: { ...auth(), "Content-Type": "text/plain" } }),
      415,
      "unsupported_media_type",
    );
    await expectError(
      await send(URL_PATH, { body: "x", headers: { ...auth(), "Content-Type": "multipart/form-data" } }),
      415,
      "unsupported_media_type",
    );
  });
});

describe("POST /ingest/v1/events: storage failures", () => {
  it("answers 503 and keeps nothing when R2 fails", async () => {
    let puts = 0;
    const failing = bucketWith({
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        puts++;
        if (puts === 2) throw new Error("R2 is down");
        return env.EVENT_DATA.put(...args);
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const form = metadataForm(BASE);
    form.append("body", new File(["a"], "b"));
    form.append("attachments", new File(["b"], "a"));
    const res = await send(URL_PATH, { method: "POST", body: form, headers: auth(), env: { EVENT_DATA: failing } });
    const error = await expectError(res, 503, "temporarily_unavailable");
    expect(error.message).not.toBe("");
    expect(await countTable("events")).toBe(0);
    expect(await countTable("event_data")).toBe(0);
    expect(await listEventDataKeys()).toEqual([]);
  });

  it("never logs the API key", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = bucketWith({
      put: async () => {
        throw new Error("R2 is down");
      },
    });
    await send(URL_PATH, { json: { ...BASE, body: "x" }, headers: auth(), env: { EVENT_DATA: failing } });
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(key.slice(-20));
  });
});

describe("/ingest paths", () => {
  it.each([
    ["GET", "/ingest"],
    ["POST", "/ingest"],
    ["GET", "/ingest/v1/events"],
    ["PUT", "/ingest/v1/events"],
    ["POST", "/ingest/v2/events"],
    ["POST", "/ingest/v1/events/x"],
  ])("answers %s %s with a JSON 404 that is not cached", async (method, path) => {
    const res = await send(path, { method, headers: auth() });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await errorOf(res)).code).toBe("not_found");
  });

  it("does not cache intake responses", async () => {
    const res = await postJson(BASE);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not require the same origin", async () => {
    const res = await send(URL_PATH, { json: BASE, headers: auth(), origin: "https://elsewhere.example" });
    expect(res.status).toBe(201);
  });

  it("answers a configuration error with JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send(URL_PATH, { json: BASE, headers: auth(), env: { JWT_SECRET: "short" } });
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe("internal_error");
  });
});
