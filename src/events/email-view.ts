// The email view of the management screen: an email.received event read as a message. The body stored by the email
// intake (src/intake/email.ts toBodyText) is split into its header lines and the text, and the HTML body (body.html)
// is converted to text, so that nothing a sender wrote is ever rendered as HTML.
//
// Any source may send an email.received event, so the header lines are taken only when they match the event exactly
// (the summary and labels.from); otherwise the whole body is shown as text.

import type { EmailHeaders } from "../api/types";
import { UTF8_BOUNDARY_MARGIN } from "../conversations/service";
import { HTML_ONLY_TEXT, toSummary } from "../intake/email";
import { sliceUtf8 } from "../mcp/text";

// The most of the body and of the HTML body read and shown.
export const EMAIL_VIEW_MAX_BYTES = 256 * 1024;

const BODY_CONTENT_TYPE = "text/plain; charset=utf-8";
const HTML_NAME = "body.html";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const NO_SUBJECT = "(件名なし)";
// The start of the note toBodyText adds when attachments were dropped.
const DROPPED_NOTE_START = "\n\n（添付が上限の ";

export type EmailDataKind = { role: string; position: number; name: string; contentType: string };

// The HTML body stored by the email intake. A sender's own attachment named body.html has no charset parameter
// (postal-mime drops the parameters), unless its Content-Type quoted it: that one is taken as the HTML body.
export function isHtmlBodyData(row: EmailDataKind): boolean {
  return row.role === "attachment" && row.position === 1 && row.name === HTML_NAME && row.contentType === HTML_CONTENT_TYPE;
}

// A body with the header lines of the email intake. Any other body is not parsed.
export function isEmailBodyData(row: EmailDataKind): boolean {
  return row.role === "body" && row.contentType === BODY_CONTENT_TYPE;
}

// --- The header lines ---

const HEADER_KEYS = ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID"] as const;
type HeaderKey = (typeof HEADER_KEYS)[number];
const HEADER_LINE = /^(From|To|Cc|Reply-To|Subject|Date|Message-ID): (.*)$/;
const HEADER_FIELDS: Record<HeaderKey, keyof EmailHeaders> = {
  From: "from",
  To: "to",
  Cc: "cc",
  "Reply-To": "reply_to",
  Subject: "subject",
  Date: "date",
  "Message-ID": "message_id",
};

export function emptyHeaders(): EmailHeaders {
  return { from: null, to: null, cc: null, reply_to: null, subject: null, date: null, message_id: null };
}

// The header lines before the first blank line, only if every line is one of HEADER_KEYS, each at most once and in
// the order toBodyText writes them, and From and Subject agree with the event. Otherwise all null and the whole text.
export function parseEmailBody(
  text: string,
  event: { summary: string; from: string | null },
): { headers: EmailHeaders; text: string } {
  const rejected = { headers: emptyHeaders(), text };
  const end = text.indexOf("\n\n");
  if (end <= 0) return rejected;
  const headers = emptyHeaders();
  let last = -1;
  for (const line of text.slice(0, end).split("\n")) {
    const match = HEADER_LINE.exec(line);
    if (match === null) return rejected;
    const key = match[1] as HeaderKey;
    const index = HEADER_KEYS.indexOf(key);
    if (index <= last) return rejected;
    last = index;
    headers[HEADER_FIELDS[key]] = match[2] ?? "";
  }
  if (headers.from === null) {
    if (event.from !== null) return rejected;
  } else if (event.from === null || !headers.from.toLowerCase().includes(event.from)) {
    return rejected;
  }
  if (headers.subject === null) {
    if (event.summary !== NO_SUBJECT) return rejected;
  } else if (toSummary(headers.subject) !== event.summary) {
    return rejected;
  }
  return { headers, text: text.slice(end + 2) };
}

// Whether the text of the body (after the header lines) is the one the email intake writes for an HTML-only message.
export function isHtmlOnlyText(text: string): boolean {
  return text === HTML_ONLY_TEXT || text.startsWith(HTML_ONLY_TEXT + DROPPED_NOTE_START);
}

// --- R2 ---

// The first EMAIL_VIEW_MAX_BYTES of an object as UTF-8, moved back to a character boundary. null when the object is
// missing.
export async function readTextPrefix(
  bucket: R2Bucket,
  data: { r2Key: string; size: number },
): Promise<{ text: string; truncated: boolean } | null> {
  if (data.size === 0) return { text: "", truncated: false };
  const object = await bucket.get(data.r2Key, {
    range: { offset: 0, length: Math.min(EMAIL_VIEW_MAX_BYTES + UTF8_BOUNDARY_MARGIN, data.size) },
  });
  if (object === null) return null;
  const slice = sliceUtf8(new Uint8Array(await object.arrayBuffer()), 0, EMAIL_VIEW_MAX_BYTES, data.size);
  return { text: slice.text, truncated: slice.nextOffset !== null };
}

// --- HTML to text ---

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  laquo: "\u00AB",
  raquo: "\u00BB",
  yen: "\u00A5",
  euro: "\u20AC",
  middot: "\u00B7",
  bull: "\u2022",
  times: "\u00D7",
};

const ENTITY = /&(?:#([0-9]{1,8})|#[xX]([0-9a-fA-F]{1,8})|([A-Za-z][A-Za-z0-9]{0,31}));/g;

function codePointText(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
  return String.fromCodePoint(code);
}

// Decodes the character references once (&amp;lt; is &lt;): numeric ones and the names of NAMED_ENTITIES. Other
// names are left as they are. HTMLRewriter gives text and attribute values without decoding them.
export function decodeEntities(value: string): string {
  return value.replace(ENTITY, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) return codePointText(Number.parseInt(decimal, 10));
    if (hex !== undefined) return codePointText(Number.parseInt(hex, 16));
    return (name !== undefined && Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : undefined) ?? whole;
  });
}

// The elements whose content is never shown.
const DROPPED = ["script", "style", "title", "noscript", "template", "svg"];
// A line break before and after (when the end tag comes).
const BLOCKS = [
  "p",
  "div",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "table",
  "section",
  "article",
  "header",
  "footer",
];
const LINK_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const SHOWN_SCHEMES = new Set(["http", "https", "mailto"]);
// The ASCII whitespace of HTML, collapsed outside pre. U+00A0 is not.
const COLLAPSIBLE = /[\t\n\f\r ]+/g;

// The href of a link if it is shown: decoded, trimmed, with a lowercase scheme, and only http:, https: or mailto:.
function shownHref(raw: string | null): string | null {
  if (raw === null) return null;
  const href = decodeEntities(raw).trim();
  const match = LINK_SCHEME.exec(href);
  if (match === null) return null;
  const scheme = (match[1] ?? "").toLowerCase();
  if (!SHOWN_SCHEMES.has(scheme)) return null;
  return scheme + href.slice(scheme.length);
}

// Whether the text of a link already says where it goes, ignoring case, mailto: and one trailing slash.
function linkTextMatches(text: string, href: string): boolean {
  const withoutSlash = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value);
  const target = href.toLowerCase().startsWith("mailto:") ? href.slice("mailto:".length) : href;
  return withoutSlash(text).toLowerCase() === withoutSlash(target).toLowerCase();
}

// Registers an end tag handler. HTMLRewriter throws for an element without an end tag (a void element, or a foreign
// element written as <svg/>); false then. Element.canHaveContent is not available in this runtime.
function onEnd(element: Element, handler: () => void): boolean {
  try {
    element.onEndTag(handler);
    return true;
  } catch {
    return false;
  }
}

// The text of an HTML document, for reading it on the screen: no scripts or styles, line breaks for the blocks, links
// with their href when the text differs, images as [画像]. Nothing is fetched and nothing is kept as markup.
export async function htmlToText(html: string): Promise<string> {
  let out = "";
  // > 0 inside a dropped element: nothing is written.
  let dropped = 0;
  let pre = 0;
  let pending = "";
  let link: { href: string | null; start: number } | null = null;

  // Whether the last thing written was a line break, a bullet or a tab (or nothing yet): a space after it is dropped.
  let structural = true;
  const write = (value: string, isStructural = true) => {
    if (dropped > 0) return;
    out += value;
    structural = isStructural;
  };
  const atSpace = () => structural || /[ \t\n]$/.test(out);
  const finishLink = () => {
    if (link === null) return;
    const { href, start } = link;
    link = null;
    if (href === null) return;
    if (linkTextMatches(out.slice(start).trim(), href)) return;
    out += atSpace() ? `<${href}>` : ` <${href}>`;
    structural = false;
  };

  let rewriter = new HTMLRewriter().onDocument({
    text(chunk) {
      pending += chunk.text;
      if (!chunk.lastInTextNode) return;
      const raw = pending;
      pending = "";
      if (dropped > 0 || raw === "") return;
      const decoded = decodeEntities(raw);
      if (pre > 0) {
        write(decoded.replace(/\r\n?/g, "\n").replace(/\u00A0/g, " "), false);
        return;
      }
      let text = decoded.replace(COLLAPSIBLE, " ");
      if (text.startsWith(" ") && atSpace()) text = text.slice(1);
      if (text !== "") write(text.replace(/\u00A0/g, " "), false);
    },
  });
  for (const name of DROPPED) {
    rewriter = rewriter.on(name, {
      element(element) {
        if (onEnd(element, () => dropped--)) dropped++;
      },
    });
  }
  for (const name of BLOCKS) {
    rewriter = rewriter.on(name, {
      element(element) {
        write("\n");
        onEnd(element, () => write("\n"));
      },
    });
  }
  rewriter = rewriter
    .on("pre", {
      element(element) {
        write("\n");
        if (onEnd(element, () => {
          pre--;
          write("\n");
        })) {
          pre++;
        }
      },
    })
    .on("tr", {
      element() {
        write("\n");
      },
    })
    .on("li", {
      element() {
        write("\n・");
      },
    })
    .on("br", {
      element() {
        write("\n");
      },
    })
    .on("hr", {
      element() {
        write("\n――――\n");
      },
    })
    .on("td, th", {
      element() {
        write("\t");
      },
    })
    .on("img", {
      element(element) {
        const alt = decodeEntities(element.getAttribute("alt") ?? "")
          .replace(COLLAPSIBLE, " ")
          .trim();
        write(alt === "" ? "[画像]" : `[画像: ${alt}]`, false);
      },
    })
    .on("a", {
      element(element) {
        if (dropped > 0) return;
        finishLink();
        const opened = { href: shownHref(element.getAttribute("href")), start: out.length };
        link = opened;
        onEnd(element, () => {
          if (dropped === 0 && link === opened) finishLink();
        });
      },
    });

  await rewriter.transform(new Response(html)).arrayBuffer();
  // A link whose end tag never came.
  finishLink();

  return out
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}
