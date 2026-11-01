import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceRow } from "../src/db/schema";
import { newEventId, sha256Hex } from "../src/ids";
import { acceptEvent, requestHash, type IntakeSource } from "../src/intake/service";
import { validateIntakeInput, type IntakeInput } from "../src/intake/validation";
import {
  countTable,
  createSource,
  createUser,
  d1With,
  fakeQueue,
  listEventDataKeys,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
} from "./helpers";

const BODY = new TextEncoder().encode("raw");
const INPUT: IntakeInput = {
  idempotency_key: "k-1",
  type: "alert.observed",
  summary: "s",
  body: { content_type: "text/plain", bytes: BODY },
};

let source: SourceRow;
let intakeSource: IntakeSource;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  const user = await createUser({ email: "owner@example.com" });
  const workspace = await personalWorkspaceOf(user);
  source = await createSource({ workspaceId: workspace.id, name: "app" });
  intakeSource = { id: source.id, workspaceId: workspace.id, name: source.name, enabled: true };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

async function hashOf(input: IntakeInput): Promise<string> {
  const validated = validateIntakeInput(input);
  if (!validated.ok) throw new Error("invalid input");
  const body = validated.value.body;
  return requestHash(validated.value, body === null ? null : await sha256Hex(body.bytes), []);
}

// Inserts an event with the same (source_id, idempotency_key), as another request would.
async function insertCompeting(hash: string): Promise<string> {
  const id = newEventId(Date.now());
  await env.DB.prepare(
    `INSERT INTO events (id, workspace_id, source_id, idempotency_key, request_hash, type, summary, labels, occurred_at, received_at)
    VALUES (?, ?, ?, 'k-1', ?, 'alert.observed', 's', '{}', 0, 0)`,
  )
    .bind(id, intakeSource.workspaceId, source.id, hash)
    .run();
  return id;
}

describe("acceptEvent when another request wrote first", () => {
  it("is a duplicate of the other event and leaves no orphan in R2", async () => {
    let competing = "";
    const db = d1With({
      batch: async (statements: D1PreparedStatement[]) => {
        competing = await insertCompeting(await hashOf(INPUT));
        return env.DB.batch(statements);
      },
    });
    const result = await acceptEvent({ db, bucket: env.EVENT_DATA, queue: fakeQueue(), now: Date.now() }, intakeSource, INPUT);
    expect(result).toEqual({ ok: true, event_id: competing, duplicate: true });
    expect(await countTable("events")).toBe(1);
    expect(await countTable("event_data")).toBe(0);
    expect(await listEventDataKeys()).toEqual([]);
  });

  it("is a conflict when the other event has different content", async () => {
    const db = d1With({
      batch: async (statements: D1PreparedStatement[]) => {
        await insertCompeting("different");
        return env.DB.batch(statements);
      },
    });
    const result = await acceptEvent({ db, bucket: env.EVENT_DATA, queue: fakeQueue(), now: Date.now() }, intakeSource, INPUT);
    expect(result).toMatchObject({ ok: false, error: { status: 409, code: "idempotency_conflict" } });
    expect(await listEventDataKeys()).toEqual([]);
  });
});

describe("acceptEvent when the D1 write throws", () => {
  it("succeeds and keeps R2 when the write committed", async () => {
    const db = d1With({
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.batch(statements);
        throw new Error("network error after commit");
      },
    });
    const result = await acceptEvent({ db, bucket: env.EVENT_DATA, queue: fakeQueue(), now: Date.now() }, intakeSource, INPUT);
    expect(result).toMatchObject({ ok: true, duplicate: false });
    if (!result.ok) return;
    const row = await env.DB.prepare("SELECT r2_key FROM event_data WHERE event_id = ?")
      .bind(result.event_id)
      .first<{ r2_key: string }>();
    expect(await listEventDataKeys()).toEqual([row?.r2_key]);
  });

  it("answers 503 and keeps R2 when nothing was written", async () => {
    const db = d1With({
      batch: async () => {
        throw new Error("D1 is down");
      },
    });
    const result = await acceptEvent({ db, bucket: env.EVENT_DATA, queue: fakeQueue(), now: Date.now() }, intakeSource, INPUT);
    expect(result).toMatchObject({ ok: false, error: { status: 503, code: "temporarily_unavailable" } });
    expect(await countTable("events")).toBe(0);
    // An orphan, left for the daily cron: the write may still commit.
    expect(await listEventDataKeys()).toHaveLength(1);
  });

  it("answers 503 and keeps R2 when the lookup after the failure also fails", async () => {
    let failLookups = false;
    const db = d1With({
      prepare: (query: string) => {
        if (failLookups && query.startsWith("SELECT")) throw new Error("D1 is down");
        return env.DB.prepare(query);
      },
      batch: async () => {
        failLookups = true;
        throw new Error("D1 is down");
      },
    });
    const result = await acceptEvent({ db, bucket: env.EVENT_DATA, queue: fakeQueue(), now: Date.now() }, intakeSource, INPUT);
    expect(result).toMatchObject({ ok: false, error: { status: 503, code: "temporarily_unavailable" } });
    expect(await listEventDataKeys()).toHaveLength(1);
  });

  it("answers 503 when the first lookup fails", async () => {
    const db = d1With({
      prepare: () => {
        throw new Error("D1 is down");
      },
    });
    const result = await acceptEvent({ db, bucket: env.EVENT_DATA, queue: fakeQueue(), now: Date.now() }, intakeSource, INPUT);
    expect(result).toMatchObject({ ok: false, error: { status: 503, code: "temporarily_unavailable" } });
    expect(await listEventDataKeys()).toEqual([]);
  });
});

describe("acceptEvent", () => {
  it("rejects a disabled source", async () => {
    const result = await acceptEvent(
      { db: env.DB, bucket: env.EVENT_DATA, queue: fakeQueue(), now: Date.now() },
      { ...intakeSource, enabled: false },
      INPUT,
    );
    expect(result).toMatchObject({ ok: false, error: { status: 403, code: "source_disabled" } });
  });
});
