import type { EmailAttachment, EmailView } from "../../src/api/types";
import { type PreviewKind, previewKind } from "./events";

// The email view of the event detail. No JSX, so that the tests can load it in Node.

export const EMAIL_EVENT_TYPE = "email.received";

// The bidirectional controls: U+061C, U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069. A sender may use them to
// make a file name or a display name read differently (e.g. "invoice[U+202E]fdp.exe").
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// The text with each bidirectional control shown as [U+XXXX], so that it cannot reorder what is around it.
export function revealBidiControls(value: string): string {
  return value.replace(
    BIDI_CONTROLS,
    (char) => `[U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`,
  );
}

export type EmailBodyMode = "text" | "html";

// The view of the body shown first: the HTML for a message that had only an HTML body, otherwise the text.
export function defaultBodyMode(view: Pick<EmailView, "html" | "html_only">): EmailBodyMode {
  return view.html !== null && view.html_only ? "html" : "text";
}

// How an attachment is previewed: as the data of the event detail are (images, and text or JSON in UTF-8); null for a
// download only.
export function attachmentPreview(attachment: Pick<EmailAttachment, "content_type" | "size">): PreviewKind | null {
  return previewKind(attachment);
}

// Whether the event detail shows the email view: an email.received event that is not a message of a conversation.
export function isEmailEvent(event: { type: string; conversation_id: string | null }): boolean {
  return event.type === EMAIL_EVENT_TYPE && event.conversation_id === null;
}
