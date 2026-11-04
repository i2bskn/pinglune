// The allowed senders of the email intake of a source, as one sender per line of a text area. The check mirrors
// normalizeAllowedSender of src/intake/email-sender.ts (not imported: that module also loads postal-mime), so that an
// invalid line is reported with its line number in the text area. The API checks again.

export const MAX_ALLOWED_SENDERS = 20;

const MAX_LENGTH = 254;
const DOMAIN_MAX_LENGTH = 253;
const LOCAL_PART_MAX_LENGTH = 64;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SIMPLE_LOCAL_PART = /^[\x21\x23-\x27\x2A\x2B\x2D-\x39\x3D\x3F\x41-\x5A\x5E-\x7E]+$/;

function isDomain(value: string): boolean {
  if (value.length < 1 || value.length > DOMAIN_MAX_LENGTH) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => LABEL.test(label));
}

// The same rule as normalizeAllowedSender: local@domain or domain, trimmed and in lowercase.
export function isValidAllowedSender(value: string): boolean {
  const sender = value.trim().toLowerCase();
  if (sender.length < 1 || sender.length > MAX_LENGTH) return false;
  const at = sender.indexOf("@");
  if (at < 0) return isDomain(sender);
  const localPart = sender.slice(0, at);
  return localPart.length <= LOCAL_PART_MAX_LENGTH && SIMPLE_LOCAL_PART.test(localPart) && isDomain(sender.slice(at + 1));
}

// The text area: the saved senders, one per line.
export function allowedSendersText(senders: string[]): string {
  return senders.join("\n");
}

// The senders to send: each line trimmed, the empty lines left out. An invalid line is reported with its line number
// (1-based) in the text area.
export function allowedSendersRequest(text: string): { ok: true; value: string[] } | { ok: false; message: string } {
  const senders: string[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (const [index, line] of lines.entries()) {
    const sender = line.trim();
    if (sender === "") continue;
    if (!isValidAllowedSender(sender)) {
      return { ok: false, message: `${index + 1}行目の送信者の書き方が正しくありません` };
    }
    senders.push(sender);
  }
  if (senders.length > MAX_ALLOWED_SENDERS) {
    return { ok: false, message: `許可する送信者は ${MAX_ALLOWED_SENDERS} 個までです` };
  }
  return { ok: true, value: senders };
}
