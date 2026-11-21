// The addresses that email deliveries send to and from (src/deliveries/email.ts).

import { isDomain, SIMPLE_LOCAL_PART } from "../intake/email-sender";

const ADDRESS_MAX_LENGTH = 254;
const LOCAL_PART_MAX_LENGTH = 64;
// White space, control characters, and the characters of display names and address lists: an address with them is
// not one bare address.
const FORBIDDEN = /[\s\x00-\x1F\x7F<>,"]/;

// A bare address (local@domain) with the domain in lowercase, or null if invalid. Trimmed; the local part keeps its
// case, since only the receiving server may decide what it means. The local part is 1 to 64 printable ASCII
// characters without <>()[]",;:\@ (SIMPLE_LOCAL_PART) and without a leading, trailing or doubled "."; the domain is a
// domain name (isDomain). Display names, quoted local parts and lists of addresses are refused, not parsed.
export function normalizeEmailAddress(value: string): string | null {
  const address = value.trim();
  if (address.length < 1 || address.length > ADDRESS_MAX_LENGTH || FORBIDDEN.test(address)) return null;
  const at = address.indexOf("@");
  if (at < 0 || address.indexOf("@", at + 1) >= 0) return null;
  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();
  if (localPart.length < 1 || localPart.length > LOCAL_PART_MAX_LENGTH || !SIMPLE_LOCAL_PART.test(localPart)) {
    return null;
  }
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) return null;
  return isDomain(domain) ? `${localPart}@${domain}` : null;
}

// Whether the address is at the domain of the email intake or one of its subdomains: sending there would loop back
// into Pinglune. address is a normalized address (lowercase domain); intakeDomain is parseEmailDomain's domain.
export function isIntakeAddress(address: string, intakeDomain: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return domain === intakeDomain || domain.endsWith(`.${intakeDomain}`);
}

const MAILTO = "mailto:";

// The callback_url of an email destination.
export function emailCallbackUrl(address: string): string {
  return `${MAILTO}${address}`;
}

// The address of an email destination's callback_url, or null if it is not "mailto:" and a valid address.
export function emailAddressOf(callbackUrl: string): string | null {
  if (!callbackUrl.startsWith(MAILTO)) return null;
  return normalizeEmailAddress(callbackUrl.slice(MAILTO.length));
}
