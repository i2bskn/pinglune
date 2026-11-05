import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailHtmlView, EmailView, EventList } from "../src/api/types";
import type { SourceRow, UserRow } from "../src/db/schema";
import type { Bindings } from "../src/env";
import { decodeEntities, htmlToText, isHtmlBodyData, parseEmailBody } from "../src/events/email-view";
import { handleEmail } from "../src/intake/email";
import {
  createEmailAddress,
  createSource,
  createUser,
  fakeQueue,
  login,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  send,
  type SessionCookies,
} from "./helpers";

const DOMAIN = "example.com";
const LOCAL_PART = "abcdefghij0123456789";

function mail(...lines: string[]): string {
  return lines.join("\r\n");
}

function multipart(boundary: string, parts: string[][]): string[] {
  const lines: string[] = [];
  for (const part of parts) lines.push(`--${boundary}`, ...part);
  lines.push(`--${boundary}--`, "");
  return lines;
}

// A message of Email Routing to the address of the source, as test/email-intake.test.ts builds it.
function fakeMessage(raw: string): ForwardableEmailMessage & { rejects: string[] } {
  const bytes = new TextEncoder().encode(raw);
  const rejects: string[] = [];
  const message = {
    from: "sender@example.net",
    to: `${LOCAL_PART}@${DOMAIN}`,
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
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
  return message as unknown as ForwardableEmailMessage & { rejects: string[] };
}

const TEXT_BODY = [
  "From: Alice <Alice@Example.COM>",
  "To: Bob <bob@example.org>, carol@example.org",
  "Cc: Dave <dave@example.org>",
  "Reply-To: replies@example.org",
  "Subject: Disk is full",
  "Date: Mon, 2 Nov 2026 01:02:03 +0000",
  "Message-ID: <m1@example.com>",
  "",
  "The disk of db-1 is full.\nPlease check.\n",
].join("\n");

const TEXT_EVENT = { summary: "Disk is full", from: "alice@example.com" };

describe("parseEmailBody", () => {
  it("splits the header lines of the email intake from the text", () => {
    expect(parseEmailBody(TEXT_BODY, TEXT_EVENT)).toEqual({
      headers: {
        from: "Alice <Alice@Example.COM>",
        to: "Bob <bob@example.org>, carol@example.org",
        cc: "Dave <dave@example.org>",
        reply_to: "replies@example.org",
        subject: "Disk is full",
        date: "Mon, 2 Nov 2026 01:02:03 +0000",
        message_id: "<m1@example.com>",
      },
      text: "The disk of db-1 is full.\nPlease check.\n",
    });
  });

  it("takes some of the lines, and a value with ': '", () => {
    expect(parseEmailBody("From: a@example.com\nSubject: Re: hello: world\n\nbody\n\nmore", {
      summary: "Re: hello: world",
      from: "a@example.com",
    })).toEqual({
      headers: {
        from: "a@example.com",
        to: null,
        cc: null,
        reply_to: null,
        subject: "Re: hello: world",
        date: null,
        message_id: null,
      },
      text: "body\n\nmore",
    });
  });

  it("compares the subject as the summary is made", () => {
    const parsed = parseEmailBody("From: a@example.com\nSubject:  a   b \n\nbody", { summary: "a b", from: "a@example.com" });
    expect(parsed.headers.subject).toBe(" a   b ");
  });

  it("takes no subject line for (件名なし)", () => {
    const parsed = parseEmailBody("From: a@example.com\n\nbody", { summary: "(件名なし)", from: "a@example.com" });
    expect(parsed.headers.from).toBe("a@example.com");
    expect(parsed.text).toBe("body");
  });

  it.each([
    ["no blank line", "From: Alice <alice@example.com>\nSubject: Disk is full\nbody"],
    ["an empty header block", "\n\nFrom: Alice <alice@example.com>\nSubject: Disk is full\n\nbody"],
    ["an unknown line", "From: Alice <alice@example.com>\nX-Mailer: m\nSubject: Disk is full\n\nbody"],
    ["a line that is not a header", "From: Alice <alice@example.com>\nSubject: Disk is full\nhello\n\nbody"],
    ["another order", "Subject: Disk is full\nFrom: Alice <alice@example.com>\n\nbody"],
    ["a repeated key", "From: Alice <alice@example.com>\nFrom: Alice <alice@example.com>\nSubject: Disk is full\n\nbody"],
    ["another From", "From: CEO <ceo@example.com>\nSubject: Disk is full\n\nbody"],
    ["another Subject", "From: Alice <alice@example.com>\nSubject: 至急\n\nbody"],
    ["no From line with labels.from", "Subject: Disk is full\n\nbody"],
    ["no Subject line with a subject", "From: Alice <alice@example.com>\n\nbody"],
    ["a lowercase key", "from: Alice <alice@example.com>\nSubject: Disk is full\n\nbody"],
  ])("takes no header lines with %s", (_, text) => {
    expect(parseEmailBody(text, TEXT_EVENT)).toEqual({
      headers: { from: null, to: null, cc: null, reply_to: null, subject: null, date: null, message_id: null },
      text,
    });
  });

  it("takes no From line for an event without labels.from", () => {
    const text = "From: CEO <ceo@example.com>\nSubject: 至急\n\nbody";
    expect(parseEmailBody(text, { summary: "至急", from: null }).headers.from).toBeNull();
  });
});

describe("isHtmlBodyData", () => {
  const html = { role: "attachment", position: 1, name: "body.html", contentType: "text/html; charset=utf-8" };

  it("is the HTML body of the email intake", () => {
    expect(isHtmlBodyData(html)).toBe(true);
  });

  it.each([
    ["a sender's body.html after the HTML body", { ...html, position: 2, contentType: "text/html" }],
    ["a sender's body.html without an HTML body", { ...html, contentType: "text/html" }],
    ["another name", { ...html, name: "index.html" }],
    ["the body", { ...html, role: "body", position: 0 }],
  ])("is not %s", (_, row) => {
    expect(isHtmlBodyData(row)).toBe(false);
  });
});

describe("decodeEntities", () => {
  it("decodes numeric references and the names of the table once", () => {
    expect(decodeEntities("&#65;&#x1F600;&#X41; &amp;lt; &lt;&gt;&quot;&apos;&copy;&hellip;&yen;&times;")).toBe(
      `A${String.fromCodePoint(0x1f600)}A &lt; <>"'©…¥×`,
    );
  });

  it("leaves unknown names and references without a semicolon", () => {
    expect(decodeEntities("&foo; &amp &#xZZ; &#0; &#xD800;")).toBe("&foo; &amp &#xZZ; � �");
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles, titles and the like", async () => {
    const html =
      "<html><head><title>Title</title><style>p{color:red}</style><script>alert(1)</script></head>" +
      "<body><noscript>no</noscript><template><p>t</p></template><p>Hello</p></body></html>";
    expect(await htmlToText(html)).toBe("Hello");
  });

  it("drops what follows <script/> up to </script>", async () => {
    expect(await htmlToText("<p>a</p><script/>alert(1)</script><p>b</p>")).toBe("a\n\nb");
  });

  it("keeps the text after a self-closing <svg/>", async () => {
    expect(await htmlToText("<p>a<svg/>b</p><svg><title>t</title><text>x</text></svg><p>c</p>")).toBe("ab\n\nc");
  });

  it("keeps the body when </head> is left out", async () => {
    expect(await htmlToText("<html><head><meta charset=utf-8><title>T</title><p>Body")).toBe("Body");
  });

  it("breaks lines at blocks, with or without their end tags", async () => {
    expect(await htmlToText("<p>one<p>two<div>three</div>four<h1>five</h1><blockquote>six</blockquote>")).toBe(
      "one\ntwo\nthree\nfour\nfive\n\nsix",
    );
  });

  it("writes br, hr and images", async () => {
    expect(
      await htmlToText('a<br>b<br/>c<hr>d<img src="https://x.test/a.png" alt="Logo &amp; name"><img src="x">'),
    ).toBe("a\nb\nc\n――――\nd[画像: Logo & name][画像]");
  });

  it("writes list items and table cells", async () => {
    expect(await htmlToText("<ul><li>one</li><li> two</li></ul><table><tr><th>a</th><th>b</th></tr><tr><td>1<td>2</table>")).toBe(
      "・one\n・two\n\n\n\ta\tb\n\t1\t2",
    );
  });

  it("adds the href when the text of a link differs", async () => {
    expect(await htmlToText('<a href="https://evil.test/login">https://bank.example.com/</a>')).toBe(
      "https://bank.example.com/ <https://evil.test/login>",
    );
    expect(await htmlToText('<a href=" HTTPS://x.test/a?b=1&amp;c=2 ">here</a>')).toBe("here <https://x.test/a?b=1&c=2>");
    expect(await htmlToText('<p><a href="https://x.test/"><img src="i"></a></p>')).toBe("[画像] <https://x.test/>");
    expect(await htmlToText('<a href="https://x.test/"></a>')).toBe("<https://x.test/>");
  });

  it("adds nothing when the text says where the link goes", async () => {
    expect(await htmlToText('<a href="https://X.test/">https://x.TEST</a>')).toBe("https://x.TEST");
    expect(await htmlToText('<a href="https://x.test/">https://x.test/</a>')).toBe("https://x.test/");
    expect(await htmlToText('<a href="https://x.test">https://x.test/</a>')).toBe("https://x.test/");
    expect(await htmlToText('<a href="mailto:a@example.com">A@example.com</a>')).toBe("A@example.com");
    expect(await htmlToText('<a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a>')).toBe(
      "https://x.test/a?b=1&c=2",
    );
  });

  it("never adds a javascript: or other href", async () => {
    expect(await htmlToText('<a href="javascript:alert(1)">click</a> <a href="data:text/html,x">d</a> <a>none</a>')).toBe(
      "click d none",
    );
    expect(await htmlToText('<a href="jav&#x09;ascript:alert(1)">x</a>')).toBe("x");
  });

  it("adds the href of a link that is not closed", async () => {
    expect(await htmlToText('<p>see <a href="https://x.test/a">this')).toBe("see this <https://x.test/a>");
  });

  it("decodes character references in text", async () => {
    expect(await htmlToText("<p>&lt;b&gt; &amp;lt; &#x41;&#66; &unknown; &copy;</p>")).toBe("<b> &lt; AB &unknown; ©");
  });

  it("collapses whitespace outside pre and keeps it inside", async () => {
    expect(await htmlToText("<p>  a \n\t b  </p><pre>  x\n    y  </pre><p>c&nbsp;&nbsp;d</p>")).toBe(
      "a b\n\n  x\n    y\n\nc  d",
    );
  });

  it("keeps at most two blank lines and trims the lines and the whole", async () => {
    expect(await htmlToText("  <div><div><div><div>a</div></div></div></div><br><br><br><br><br>b   ")).toBe(
      "a\n\n\nb",
    );
  });

  it("converts 256 KiB of HTML with many elements", async () => {
    const unit = '<tr><td><a href="https://x.test/a?b=1&amp;c=2">link</a></td><td>&nbsp;text&amp;</td></tr>';
    const html = `<table>${unit.repeat(Math.floor((256 * 1024) / unit.length))}</table>`;
    const text = await htmlToText(html);
    expect(text.split("\n").length).toBeGreaterThan(2000);
    expect(text.endsWith("\tlink <https://x.test/a?b=1&c=2>\t text&")).toBe(true);
  });
});

// From the email intake to the API.
describe("GET /api/v1/events/:id/email", () => {
  let user: UserRow;
  let source: SourceRow;
  let cookies: SessionCookies;

  function testEnv(): Bindings {
    return { ...env, EMAIL_DOMAIN: DOMAIN, DELIVERY_QUEUE: fakeQueue() };
  }

  beforeEach(async () => {
    await resetDb();
    await resetEventData();
    user = await createUser({ email: "owner@example.com" });
    source = await createSource({ workspaceId: (await personalWorkspaceOf(user)).id, name: "mail" });
    await createEmailAddress(source.id, { localPart: LOCAL_PART });
    cookies = await login(user.email);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
    await resetEventData();
  });

  async function receive(raw: string): Promise<string> {
    const message = fakeMessage(raw);
    await handleEmail(message, testEnv());
    expect(message.rejects).toEqual([]);
    const row = await env.DB.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1").first<{ id: string }>();
    if (!row) throw new Error("no event");
    return row.id;
  }

  async function emailView(id: string): Promise<EmailView> {
    const res = await send(`/api/v1/events/${id}/email`, { cookies });
    expect(res.status).toBe(200);
    return (await res.json()) as EmailView;
  }

  async function htmlView(id: string): Promise<{ status: number; body: EmailHtmlView }> {
    const res = await send(`/api/v1/events/${id}/email/html`, { cookies });
    return { status: res.status, body: (await res.json()) as EmailHtmlView };
  }

  async function listItem(id: string) {
    const body = (await (await send("/api/v1/events", { cookies })).json()) as EventList;
    return body.events.find((event) => event.event_id === id)?.email;
  }

  it("shows a text message", async () => {
    const id = await receive(
      mail(
        "From: Alice <Alice@Example.COM>",
        "To: Bob <bob@example.org>",
        "Subject: Disk is full",
        "Date: Mon, 2 Nov 2026 01:02:03 +0000",
        "Message-ID: <m1@example.com>",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "The disk of db-1 is full.",
        "Please check.",
      ),
    );
    expect(await emailView(id)).toEqual({
      event_id: id,
      source: { id: source.id, name: "mail" },
      from_address: "alice@example.com",
      headers: {
        from: "Alice <Alice@Example.COM>",
        to: "Bob <bob@example.org>",
        cc: null,
        reply_to: null,
        subject: "Disk is full",
        date: "Mon, 2 Nov 2026 01:02:03 +0000",
        message_id: "<m1@example.com>",
      },
      text: "The disk of db-1 is full.\nPlease check.\n",
      text_truncated: false,
      html_only: false,
      html: null,
      attachments: [],
    });
    expect((await htmlView(id)).status).toBe(404);
    expect(await listItem(id)).toEqual({ from: "alice@example.com", attachment_count: 0 });
  });

  it("does not take a header block written at the top of a message without headers", async () => {
    const text = "From: CEO <ceo@example.com>\nSubject: 至急\n\n口座を変更してください";
    const id = await receive(mail("Content-Type: text/plain; charset=utf-8", "", ...text.split("\n")));
    const view = await emailView(id);
    expect(view.from_address).toBeNull();
    expect(view.headers).toEqual({
      from: null,
      to: null,
      cc: null,
      reply_to: null,
      subject: null,
      date: null,
      message_id: null,
    });
    expect(view.text).toBe(`${text}\n`);
  });

  it("shows an HTML-only message", async () => {
    const id = await receive(
      mail("From: a@example.com", "Subject: HTML", "Content-Type: text/html; charset=utf-8", "", "<p>Hello &amp; welcome</p>"),
    );
    const view = await emailView(id);
    expect(view.html_only).toBe(true);
    expect(view.headers.subject).toBe("HTML");
    expect(view.html).toEqual({ data_ref: expect.stringMatching(/^dat_/), size: expect.any(Number) });
    expect(view.attachments).toEqual([]);
    expect(await htmlView(id)).toEqual({
      status: 200,
      body: { text: "Hello & welcome", source: "<p>Hello &amp; welcome</p>\n", truncated: false },
    });
  });

  it("shows text, HTML and attachments", async () => {
    const id = await receive(
      mail(
        "From: a@example.com",
        "Subject: Report",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        ...multipart("b1", [
          [
            'Content-Type: multipart/alternative; boundary="b2"',
            "",
            ...multipart("b2", [
              ["Content-Type: text/plain; charset=utf-8", "", "hello text"],
              ["Content-Type: text/html; charset=utf-8", "", "<p>hello <b>html</b></p>"],
            ]),
          ],
          [
            'Content-Type: application/pdf; name="report.pdf"',
            'Content-Disposition: attachment; filename="report.pdf"',
            "Content-Transfer-Encoding: base64",
            "",
            "JVBERi0=",
          ],
          ["Content-Type: text/html", 'Content-Disposition: attachment; filename="body.html"', "", "<p>sender's</p>"],
        ]),
      ),
    );
    const view = await emailView(id);
    expect(view.html_only).toBe(false);
    expect(view.text).toMatch(/^hello text\n?$/);
    expect(view.html).not.toBeNull();
    expect(view.attachments).toEqual([
      { data_ref: expect.stringMatching(/^dat_/), name: "report.pdf", content_type: "application/pdf", size: 5 },
      { data_ref: expect.stringMatching(/^dat_/), name: "body.html", content_type: "text/html", size: 15 },
    ]);
    expect((await htmlView(id)).body.text).toBe("hello html");
    expect(await listItem(id)).toEqual({ from: "a@example.com", attachment_count: 2 });
  });

  it("lists a sender's body.html of a message without an HTML body as an attachment", async () => {
    const id = await receive(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        ...multipart("b", [
          ["Content-Type: text/plain", "", "text"],
          ["Content-Type: text/html", 'Content-Disposition: attachment; filename="body.html"', "", "<p>x</p>"],
        ]),
      ),
    );
    const view = await emailView(id);
    expect(view.html).toBeNull();
    expect(view.attachments.map((a) => [a.name, a.content_type])).toEqual([["body.html", "text/html"]]);
    expect(await listItem(id)).toEqual({ from: "a@example.com", attachment_count: 1 });
  });

  it("takes a sender's body.html with a quoted charset as the HTML body (a known limit)", async () => {
    const id = await receive(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        ...multipart("b", [
          ["Content-Type: text/plain", "", "text"],
          [
            'Content-Type: "text/html; charset=utf-8"',
            'Content-Disposition: attachment; filename="body.html"',
            "",
            "<p>x</p>",
          ],
        ]),
      ),
    );
    const rows = await env.DB.prepare("SELECT name, content_type, position FROM event_data WHERE event_id = ? AND role = 'attachment'")
      .bind(id)
      .all<{ name: string; content_type: string; position: number }>();
    expect(rows.results).toEqual([{ name: "body.html", content_type: "text/html; charset=utf-8", position: 1 }]);
    const view = await emailView(id);
    expect(view.html).not.toBeNull();
    expect(view.attachments).toEqual([]);
    expect(await listItem(id)).toEqual({ from: "a@example.com", attachment_count: 0 });
  });

  it("is HTML-only with more than 20 attachments", async () => {
    const parts: string[][] = [["Content-Type: text/html; charset=utf-8", "", "<p>see the files</p>"]];
    for (let i = 1; i <= 21; i++) {
      parts.push(["Content-Type: text/plain", `Content-Disposition: attachment; filename="a${i}.txt"`, "", String(i)]);
    }
    const id = await receive(
      mail("From: a@example.com", "Subject: Files", 'Content-Type: multipart/mixed; boundary="b"', "", ...multipart("b", parts)),
    );
    const view = await emailView(id);
    expect(view.html_only).toBe(true);
    expect(view.text).toContain("次の添付は保存していません: a20.txt, a21.txt");
    expect(view.attachments).toHaveLength(19);
    expect(await listItem(id)).toEqual({ from: "a@example.com", attachment_count: 19 });
  });

  it("shows no text when the body object is missing", async () => {
    const id = await receive(mail("From: a@example.com", "Subject: S", "", "body"));
    const body = await env.DB.prepare("SELECT r2_key FROM event_data WHERE event_id = ? AND role = 'body'")
      .bind(id)
      .first<{ r2_key: string }>();
    await env.EVENT_DATA.delete(body?.r2_key ?? "");
    const view = await emailView(id);
    expect(view.text).toBeNull();
    expect(view.headers.from).toBeNull();
    expect(view.from_address).toBe("a@example.com");
  });

  it("shows no HTML when the HTML body object is missing", async () => {
    const id = await receive(mail("From: a@example.com", "Content-Type: text/html", "", "<p>x</p>"));
    const html = await env.DB.prepare("SELECT r2_key FROM event_data WHERE event_id = ? AND role = 'attachment'")
      .bind(id)
      .first<{ r2_key: string }>();
    await env.EVENT_DATA.delete(html?.r2_key ?? "");
    expect(await htmlView(id)).toEqual({ status: 200, body: { text: null, source: null, truncated: false } });
  });

  it("cuts a long body at 256 KiB", async () => {
    const id = await receive(mail("From: a@example.com", "Subject: Long", "", ..."x".repeat(300 * 1024).match(/.{1,900}/g) ?? []));
    const view = await emailView(id);
    expect(view.text_truncated).toBe(true);
    expect(view.headers.subject).toBe("Long");
  });
});
