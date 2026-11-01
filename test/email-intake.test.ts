import { env } from "cloudflare:workers";
import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import type { SourceRow, UserRow } from "../src/db/schema";
import type { Bindings } from "../src/env";
import worker from "../src/index";
import { handleEmail } from "../src/intake/email";
import { intakeLimits, MAX_PAYLOAD_BYTES } from "../src/intake/validation";
import {
  countTable,
  createEmailAddress,
  createSource,
  createSubscription,
  createUser,
  d1With,
  fakeQueue,
  listDeliveries,
  listEventDataKeys,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  type FakeQueue,
} from "./helpers";

const DOMAIN = "example.com";
const NOW = Date.UTC(2026, 10, 2, 3, 4, 5);
const LOCAL_PART = "abcdefghij0123456789";
const RECIPIENT = `${LOCAL_PART}@${DOMAIN}`;

type FakeMessage = ForwardableEmailMessage & { rejects: string[] };

function fakeMessage(raw: string | Uint8Array, options: { to?: string; rawSize?: number } = {}): FakeMessage {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  const rejects: string[] = [];
  const message = {
    from: "sender@example.net",
    to: options.to ?? RECIPIENT,
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: options.rawSize ?? bytes.byteLength,
    rejects,
    setReject(reason: string) {
      rejects.push(reason);
    },
    async forward() {
      throw new Error("not used");
    },
    async reply() {
      throw new Error("not used");
    },
  };
  return message as unknown as FakeMessage;
}

function mail(...lines: string[]): string {
  return lines.join("\r\n");
}

const TEXT_MAIL = mail(
  "Received: from relay1.example.net by mx.example.com",
  "From: Alice <Alice@Example.COM>",
  "To: Bob <bob@example.org>, carol@example.org",
  "Cc: Dave <dave@example.org>",
  "Reply-To: replies@example.org",
  "Subject: Disk is full",
  "Date: Mon, 2 Nov 2026 01:02:03 +0000",
  "Message-ID: <m1@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "The disk of db-1 is full.",
  "Please check.",
  "",
);

function testEnv(overrides: Partial<Bindings> = {}): Bindings {
  return { ...env, EMAIL_DOMAIN: DOMAIN, DELIVERY_QUEUE: queue, ...overrides };
}

type EventRecord = {
  id: string;
  workspace_id: string;
  source_id: string;
  idempotency_key: string;
  type: string;
  summary: string;
  labels: string;
  occurred_at: number;
  received_at: number;
};

type DataRecord = { name: string; role: string; content_type: string; size: number; r2_key: string; position: number };

async function listEvents(): Promise<EventRecord[]> {
  return (await env.DB.prepare("SELECT * FROM events ORDER BY id").all<EventRecord>()).results;
}

async function onlyEvent(): Promise<EventRecord> {
  const events = await listEvents();
  expect(events).toHaveLength(1);
  const event = events[0];
  if (!event) throw new Error("no event");
  return event;
}

async function listData(eventId: string): Promise<DataRecord[]> {
  return (
    await env.DB.prepare("SELECT * FROM event_data WHERE event_id = ? ORDER BY position").bind(eventId).all<DataRecord>()
  ).results;
}

async function readObject(key: string): Promise<string> {
  const object = await env.EVENT_DATA.get(key);
  if (!object) throw new Error(`object ${key} is missing`);
  return object.text();
}

async function bodyOf(eventId: string): Promise<string> {
  const body = (await listData(eventId)).find((d) => d.role === "body");
  if (!body) throw new Error("no body");
  return readObject(body.r2_key);
}

async function lastReceivedAt(localPart = LOCAL_PART): Promise<number | null> {
  const row = await env.DB.prepare("SELECT last_received_at FROM email_addresses WHERE id = ?")
    .bind(localPart)
    .first<{ last_received_at: number | null }>();
  return row?.last_received_at ?? null;
}

let user: UserRow;
let source: SourceRow;
let queue: FakeQueue;
let now: number;
let logs: { error: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; log: ReturnType<typeof vi.spyOn> };

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  user = await createUser({ email: "owner@example.com" });
  const workspace = await personalWorkspaceOf(user);
  source = await createSource({ workspaceId: workspace.id, name: "mail" });
  await createEmailAddress(source.id, { localPart: LOCAL_PART });
  queue = fakeQueue();
  now = NOW;
  vi.spyOn(clock, "now").mockImplementation(() => now);
  logs = {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  intakeLimits.maxPayloadBytes = MAX_PAYLOAD_BYTES;
  await resetDb();
  await resetEventData();
});

function multipart(boundary: string, parts: string[][]): string[] {
  const lines: string[] = [];
  for (const part of parts) lines.push(`--${boundary}`, ...part);
  lines.push(`--${boundary}--`, "");
  return lines;
}

describe("handleEmail", () => {
  it("accepts a text message as an event of the source", async () => {
    const message = fakeMessage(TEXT_MAIL);
    await handleEmail(message, testEnv());
    expect(message.rejects).toEqual([]);

    const event = await onlyEvent();
    expect(event).toMatchObject({
      workspace_id: source.workspaceId,
      source_id: source.id,
      type: "email.received",
      summary: "Disk is full",
      occurred_at: Date.UTC(2026, 10, 2, 1, 2, 3),
      received_at: NOW,
    });
    expect(JSON.parse(event.labels)).toEqual({ from: "alice@example.com" });
    expect(event.idempotency_key).toMatch(/^email:[0-9a-f]{64}$/);

    const data = await listData(event.id);
    expect(data.map((d) => [d.role, d.name, d.content_type])).toEqual([["body", "body", "text/plain; charset=utf-8"]]);
    expect(await bodyOf(event.id)).toBe(
      [
        "From: Alice <Alice@Example.COM>",
        "To: Bob <bob@example.org>, carol@example.org",
        "Cc: Dave <dave@example.org>",
        "Reply-To: replies@example.org",
        "Subject: Disk is full",
        "Date: Mon, 2 Nov 2026 01:02:03 +0000",
        "Message-ID: <m1@example.com>",
        "",
        "The disk of db-1 is full.\nPlease check.\n",
      ].join("\n"),
    );
    expect(await listEventDataKeys()).toHaveLength(1);
    expect(await lastReceivedAt()).toBe(NOW);
  });

  it("goes through the email handler of the Worker", async () => {
    const message = fakeMessage(TEXT_MAIL);
    await worker.email(message, testEnv());
    expect(await countTable("events")).toBe(1);
  });

  it("accepts an HTML-only message with the HTML as body.html", async () => {
    const message = fakeMessage(
      mail("From: a@example.com", "Subject: HTML", "Content-Type: text/html; charset=utf-8", "", "<p>Hello</p>", ""),
    );
    await handleEmail(message, testEnv());
    const event = await onlyEvent();
    const data = await listData(event.id);
    expect(data.map((d) => [d.role, d.name, d.content_type])).toEqual([
      ["body", "body", "text/plain; charset=utf-8"],
      ["attachment", "body.html", "text/html; charset=utf-8"],
    ]);
    expect(await bodyOf(event.id)).toBe(
      "From: a@example.com\nSubject: HTML\n\n（テキストの本文はありません。HTML の本文は添付の body.html にあります）",
    );
    expect(await readObject(data[1]?.r2_key ?? "")).toContain("<p>Hello</p>");
  });

  it("accepts text, HTML and attachments", async () => {
    const message = fakeMessage(
      mail(
        "From: a@example.com",
        "Subject: Report",
        "Message-ID: <m2@example.com>",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        ...multipart("b1", [
          ['Content-Type: multipart/alternative; boundary="b2"', "", ...multipart("b2", [
            ["Content-Type: text/plain; charset=utf-8", "", "hello text"],
            ["Content-Type: text/html; charset=utf-8", "", "<p>hello html</p>"],
          ])],
          [
            'Content-Type: application/pdf; name="report.pdf"',
            'Content-Disposition: attachment; filename="report.pdf"',
            "Content-Transfer-Encoding: base64",
            "",
            "JVBERi0=",
          ],
        ]),
      ),
    );
    await handleEmail(message, testEnv());
    const event = await onlyEvent();
    const data = await listData(event.id);
    expect(data.map((d) => [d.role, d.name, d.content_type, d.position])).toEqual([
      ["body", "body", "text/plain; charset=utf-8", 0],
      ["attachment", "body.html", "text/html; charset=utf-8", 1],
      ["attachment", "report.pdf", "application/pdf", 2],
    ]);
    expect(await bodyOf(event.id)).toMatch(/\n\nhello text\n?$/);
    expect(await readObject(data[2]?.r2_key ?? "")).toBe("%PDF-");
    expect(await listEventDataKeys()).toHaveLength(3);
  });

  it("does not add body.html to a text-only message", async () => {
    await handleEmail(fakeMessage(TEXT_MAIL), testEnv());
    const event = await onlyEvent();
    expect((await listData(event.id)).map((d) => d.name)).toEqual(["body"]);
  });

  it("decodes a Japanese subject in ISO-2022-JP", async () => {
    const message = fakeMessage(
      mail("From: a@example.com", "Subject: =?ISO-2022-JP?B?GyRCJUYlOSVIJE43b0w+GyhC?=", "", "body", ""),
    );
    await handleEmail(message, testEnv());
    const event = await onlyEvent();
    expect(event.summary).toBe("テストの件名");
    expect(await bodyOf(event.id)).toContain("Subject: テストの件名\n");
  });

  it("uses (件名なし) without a subject", async () => {
    await handleEmail(fakeMessage(mail("From: a@example.com", "", "body", "")), testEnv());
    const event = await onlyEvent();
    expect(event.summary).toBe("(件名なし)");
    expect(await bodyOf(event.id)).not.toContain("Subject:");
  });

  it("puts a subject with encoded line breaks on one line", async () => {
    // "line1\nline2\u2028line3" in UTF-8.
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode("line1\n\tline2\u2028line3")));
    await handleEmail(fakeMessage(mail("From: a@example.com", `Subject: =?UTF-8?B?${encoded}?=`, "", "body", "")), testEnv());
    const event = await onlyEvent();
    expect(event.summary).toBe("line1 line2 line3");
    const body = await bodyOf(event.id);
    expect(body.split("\n")).toContain("Subject: line1  line2 line3");
  });

  it("cuts a long subject to 2,000 characters", async () => {
    await handleEmail(fakeMessage(mail("From: a@example.com", `Subject: ${"あ".repeat(2100)}`, "", "body", "")), testEnv());
    expect((await onlyEvent()).summary).toBe("あ".repeat(2000));
  });

  it("uses the time received when Date is invalid", async () => {
    await handleEmail(fakeMessage(mail("From: a@example.com", "Date: not a date", "", "body", "")), testEnv());
    const event = await onlyEvent();
    expect(event.occurred_at).toBe(NOW);
    expect(await bodyOf(event.id)).toContain("Date: not a date\n");
  });

  it("is a duplicate when the same message comes twice", async () => {
    await handleEmail(fakeMessage(TEXT_MAIL), testEnv());
    now = NOW + 60_000;
    const again = fakeMessage(TEXT_MAIL);
    await handleEmail(again, testEnv());
    expect(again.rejects).toEqual([]);
    expect(await countTable("events")).toBe(1);
    expect(await lastReceivedAt()).toBe(NOW + 60_000);
  });

  it("makes a new event every time for a message without a Message-ID", async () => {
    const raw = mail("From: a@example.com", "Subject: ping", "", "same body", "");
    await handleEmail(fakeMessage(raw), testEnv());
    now = NOW + 1;
    await handleEmail(fakeMessage(raw), testEnv());
    expect(await countTable("events")).toBe(2);
  });

  it("keeps 20 attachments and notes the rest in the body", async () => {
    const parts = [["Content-Type: text/plain; charset=utf-8", "", "text"]];
    for (let i = 1; i <= 32; i++) {
      parts.push([
        "Content-Type: text/plain",
        `Content-Disposition: attachment; filename="a${i}.txt"`,
        "",
        `file ${i}`,
      ]);
    }
    const message = fakeMessage(
      mail("From: a@example.com", 'Content-Type: multipart/mixed; boundary="b"', "", ...multipart("b", parts)),
    );
    await handleEmail(message, testEnv());
    expect(message.rejects).toEqual([]);
    const event = await onlyEvent();
    const data = await listData(event.id);
    expect(data.filter((d) => d.role === "attachment").map((d) => d.name)).toEqual(
      Array.from({ length: 20 }, (_, i) => `a${i + 1}.txt`),
    );
    const dropped = Array.from({ length: 10 }, (_, i) => `a${i + 21}.txt`).join(", ");
    expect(await bodyOf(event.id)).toMatch(
      new RegExp(`\\n\\n（添付が上限の 20 個を超えたため、次の添付は保存していません: ${dropped} ほか 2 件）$`),
    );
  });

  it("replaces unsafe characters of attachment names and fills in missing names and types", async () => {
    const message = fakeMessage(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        ...multipart("b", [
          ["Content-Type: text/plain; charset=utf-8", "", "text"],
          ["Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="a/b\\\\c.txt"', "", "1"],
          ["Content-Type: application/octet-stream", "Content-Disposition: attachment; filename*=utf-8''x%01y%E2%80%A8z.bin", "", "2"],
          ["Content-Type: weird", "Content-Disposition: attachment", "", "3"],
          ["Content-Type: text/plain", 'Content-Disposition: attachment; filename="   "', "", "4"],
        ]),
      ),
    );
    await handleEmail(message, testEnv());
    expect(message.rejects).toEqual([]);
    const event = await onlyEvent();
    const attachments = (await listData(event.id)).filter((d) => d.role === "attachment");
    expect(attachments.map((d) => [d.name, d.content_type])).toEqual([
      ["a_b_c.txt", "application/octet-stream"],
      ["x_y_z.bin", "application/octet-stream"],
      ["attachment-3", "application/octet-stream"],
      ["attachment-4", "text/plain"],
    ]);
  });

  describe("the from label", () => {
    async function labelsFor(fromLine: string | null): Promise<Record<string, string>> {
      const lines = fromLine === null ? [] : [fromLine];
      await handleEmail(fakeMessage(mail(...lines, "Subject: s", "", "body", "")), testEnv());
      return JSON.parse((await onlyEvent()).labels) as Record<string, string>;
    }

    it("is left out without From", async () => {
      expect(await labelsFor(null)).toEqual({});
    });

    it("uses the first member of a group", async () => {
      expect(await labelsFor("From: Team: First@Example.com, second@example.com;")).toEqual({ from: "first@example.com" });
    });

    it("is left out when the address is longer than 256 characters", async () => {
      expect(await labelsFor(`From: ${"a".repeat(250)}@example.com`)).toEqual({});
    });
  });

  describe("rejects", () => {
    async function expectRejected(message: FakeMessage, reason: string, overrides: Partial<Bindings> = {}) {
      await handleEmail(message, testEnv(overrides));
      expect(message.rejects).toEqual([reason]);
      expect(await countTable("events")).toBe(0);
      expect(await listEventDataKeys()).toEqual([]);
    }

    it("every message when EMAIL_DOMAIN is unset", async () => {
      await expectRejected(fakeMessage(TEXT_MAIL), "This address does not accept email", { EMAIL_DOMAIN: undefined });
      await expectRejected(fakeMessage(TEXT_MAIL), "This address does not accept email", { EMAIL_DOMAIN: " " });
    });

    it("another domain", async () => {
      await expectRejected(fakeMessage(TEXT_MAIL, { to: `${LOCAL_PART}@example.org` }), "Unknown recipient");
      await expectRejected(fakeMessage(TEXT_MAIL, { to: `${LOCAL_PART}@sub.example.com` }), "Unknown recipient");
    });

    it("a local part of another form", async () => {
      await expectRejected(fakeMessage(TEXT_MAIL, { to: `${LOCAL_PART}+tag@${DOMAIN}` }), "Unknown recipient");
      await expectRejected(fakeMessage(TEXT_MAIL, { to: `abc@${DOMAIN}` }), "Unknown recipient");
      await expectRejected(fakeMessage(TEXT_MAIL, { to: "no-at-sign" }), "Unknown recipient");
    });

    it("an unknown address", async () => {
      await expectRejected(fakeMessage(TEXT_MAIL, { to: `zzzzzzzzzz0123456789@${DOMAIN}` }), "Unknown recipient");
    });

    it("a revoked address", async () => {
      await env.DB.prepare("UPDATE email_addresses SET revoked_at = 1 WHERE id = ?").bind(LOCAL_PART).run();
      await expectRejected(fakeMessage(TEXT_MAIL), "Unknown recipient");
    });

    it("a disabled source", async () => {
      await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(source.id).run();
      await expectRejected(fakeMessage(TEXT_MAIL), "Recipient is disabled");
      expect(await lastReceivedAt()).toBeNull();
    });

    it("a message whose announced size is over the limit, without reading it", async () => {
      intakeLimits.maxPayloadBytes = 1000;
      const message = fakeMessage(TEXT_MAIL, { rawSize: 1001 });
      await expectRejected(message, "Message too large");
      expect(message.raw.locked).toBe(false);
    });

    it("a message that is larger than announced", async () => {
      intakeLimits.maxPayloadBytes = 1000;
      await expectRejected(fakeMessage(`${TEXT_MAIL}${"x".repeat(1000)}`, { rawSize: 10 }), "Message too large");
    });

    it("a message whose decoded parts are over the limit", async () => {
      // ISO-8859-1 text: each é is 1 byte in the raw message and 2 bytes in UTF-8, so the raw message fits but the
      // body does not.
      const raw = mail("From: a@example.com", "Content-Type: text/plain; charset=iso-8859-1", "", "\u00e9".repeat(600), "");
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      intakeLimits.maxPayloadBytes = bytes.byteLength;
      await expectRejected(fakeMessage(bytes), "Message too large");
    });

    it("a message that cannot be parsed", async () => {
      vi.spyOn(PostalMime, "parse").mockRejectedValue(new Error("Maximum MIME part count exceeded"));
      await expectRejected(fakeMessage(TEXT_MAIL), "Malformed message");
      expect(logs.warn).toHaveBeenCalledWith("email intake: parsing failed", expect.objectContaining({ sourceId: source.id }));
    });

    it("a message with too many MIME parts", async () => {
      const parts = Array.from({ length: 10_001 }, () => ["Content-Type: text/plain", "", "x"]);
      await expectRejected(
        fakeMessage(mail("From: a@example.com", 'Content-Type: multipart/mixed; boundary="b"', "", ...multipart("b", parts))),
        "Malformed message",
      );
    });
  });

  describe("temporary failures", () => {
    it("throws without rejecting when EMAIL_DOMAIN is invalid", async () => {
      const message = fakeMessage(TEXT_MAIL);
      await expect(handleEmail(message, testEnv({ EMAIL_DOMAIN: "not a domain" }))).rejects.toThrow();
      expect(message.rejects).toEqual([]);
      expect(logs.error).toHaveBeenCalledWith("email intake: invalid EMAIL_DOMAIN");
      expect(JSON.stringify(logs.error.mock.calls)).not.toContain("not a domain");
    });

    it("accepts messages without JWT_SECRET", async () => {
      const message = fakeMessage(TEXT_MAIL);
      await handleEmail(message, testEnv({ JWT_SECRET: undefined, AUTH_MODE: "bogus" }));
      expect(message.rejects).toEqual([]);
      expect(await countTable("events")).toBe(1);
    });

    it("throws when the queue fails, and a resend with other trace headers is a duplicate", async () => {
      await createSubscription({ user });
      queue.fail = true;
      const message = fakeMessage(TEXT_MAIL);
      await expect(handleEmail(message, testEnv())).rejects.toThrow("email intake: temporarily unavailable");
      expect(message.rejects).toEqual([]);
      expect(await countTable("events")).toBe(1);
      expect(await lastReceivedAt()).toBeNull();
      const [pending] = await listDeliveries();
      expect(pending?.status).toBe("pending");

      queue.fail = false;
      now = NOW + 60_000;
      const resent = fakeMessage(
        mail("Received: from relay2.example.net by mx.example.com", "ARC-Seal: i=1; a=rsa-sha256; cv=none", TEXT_MAIL),
      );
      await handleEmail(resent, testEnv());
      expect(resent.rejects).toEqual([]);
      expect(await countTable("events")).toBe(1);
      expect(queue.messages).toEqual([{ delivery_id: pending?.id }]);
      expect(await lastReceivedAt()).toBe(NOW + 60_000);
    });

    it("throws when D1 fails", async () => {
      const db = d1With({
        batch: async () => {
          throw new Error("D1 is down");
        },
      });
      const message = fakeMessage(TEXT_MAIL);
      await expect(handleEmail(message, testEnv({ DB: db }))).rejects.toThrow();
      expect(message.rejects).toEqual([]);
      expect(await countTable("events")).toBe(0);
    });

    it("throws when reading the message fails", async () => {
      const message = fakeMessage(TEXT_MAIL);
      Object.defineProperty(message, "raw", {
        value: new ReadableStream({
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
      });
      await expect(handleEmail(message, testEnv())).rejects.toThrow();
      expect(message.rejects).toEqual([]);
    });
  });

  it("succeeds when updating last_received_at fails", async () => {
    const db = d1With({
      prepare: (query: string) => {
        if (query.startsWith("UPDATE email_addresses")) throw new Error("D1 is down");
        return env.DB.prepare(query);
      },
    });
    const message = fakeMessage(TEXT_MAIL);
    await handleEmail(message, testEnv({ DB: db }));
    expect(message.rejects).toEqual([]);
    expect(await countTable("events")).toBe(1);
    expect(await lastReceivedAt()).toBeNull();
    expect(logs.error).toHaveBeenCalledWith(
      "email intake: updating last_received_at failed",
      expect.objectContaining({ sourceId: source.id }),
    );
  });

  it("logs neither the content of the message nor the local part", async () => {
    // Paths that log: a failed parse, a temporary failure and a failed update of last_received_at.
    const parse = vi.spyOn(PostalMime, "parse").mockRejectedValueOnce(new Error("broken"));
    await handleEmail(fakeMessage(TEXT_MAIL), testEnv());
    parse.mockRestore();

    await createSubscription({ user });
    queue.fail = true;
    await expect(handleEmail(fakeMessage(TEXT_MAIL), testEnv())).rejects.toThrow();
    queue.fail = false;

    const db = d1With({
      prepare: (query: string) => {
        if (query.startsWith("UPDATE email_addresses")) throw new Error("D1 is down");
        return env.DB.prepare(query);
      },
    });
    await handleEmail(fakeMessage(TEXT_MAIL), testEnv({ DB: db }));

    const logged = JSON.stringify([logs.error.mock.calls, logs.warn.mock.calls, logs.log.mock.calls]);
    expect(logs.error).toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalled();
    for (const secret of [LOCAL_PART, "Disk is full", "db-1", "alice", "bob@example.org", "m1@example.com"]) {
      expect(logged.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});
