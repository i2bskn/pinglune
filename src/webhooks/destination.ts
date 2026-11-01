// Checks of callback URLs before anything is sent to them.
//
// Workers cannot pin the address that fetch() connects to, so the host is resolved with DNS over HTTPS right
// before every send and rejected if any address is not public; fetch() then resolves the name again. A DNS
// answer that changes between the two lookups (DNS rebinding) is not caught: see docs/mcp-events.md.

export type DestinationFailure = "blocked_destination" | "dns_failed";

export type ResolveResult = { ok: true; addresses: string[] } | { ok: false };

export type DestinationDeps = {
  // Hosts of this service, normalized with normalizeHost. Callbacks to them are blocked.
  selfHosts: string[];
  // Resolves the A and AAAA records of a host. Defaults to DNS over HTTPS through fetch.
  resolve?: (host: string) => Promise<ResolveResult>;
};

const MAX_URL_LENGTH = 2048;
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5_000;
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

// Lowercase without the trailing dot.
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

// The host of APP_ORIGIN, normalized, if it is a URL. Callbacks to it are blocked in every mode: loadConfig
// rejects a non-URL APP_ORIGIN only in oidc mode, and password mode does not use it.
export function appOriginHost(appOrigin: string | undefined): string | null {
  if (!appOrigin) return null;
  try {
    return normalizeHost(new URL(appOrigin).hostname);
  } catch {
    return null;
  }
}

// Checks the form of a callback URL without resolving it: https, no credentials, no port other than 443, no
// fragment, at most 2,048 characters.
export function parseCallbackUrl(value: unknown): { ok: true; url: URL } | { ok: false; reason: "invalid_url" } {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return { ok: false, reason: "invalid_url" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    // An empty fragment ("#") leaves url.hash empty.
    url.hash !== "" ||
    value.includes("#") ||
    url.href.length > MAX_URL_LENGTH
  ) {
    return { ok: false, reason: "invalid_url" };
  }
  return { ok: true, url };
}

// new URL() normalizes every IPv4 form (0x7f.1, 2130706433, ...) to dotted decimal, and keeps IPv6 in brackets.
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

// Checks a callback URL right before sending to it. Every send must call this (src/webhooks/send.ts does).
export async function checkDestination(
  url: URL,
  deps: DestinationDeps,
): Promise<{ ok: true } | { ok: false; reason: DestinationFailure }> {
  const blocked = { ok: false, reason: "blocked_destination" } as const;
  // Workers' fetch() cannot send to IP addresses, public or not.
  if (isIpLiteral(url.hostname)) return blocked;
  const host = normalizeHost(url.hostname);
  if (host === "" || host === "localhost" || !host.includes(".")) return blocked;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return blocked;
  if (deps.selfHosts.some((self) => normalizeHost(self) === host)) return blocked;

  const resolved = await (deps.resolve ?? resolveWithDoh)(host);
  if (!resolved.ok || resolved.addresses.length === 0) return { ok: false, reason: "dns_failed" };
  if (!resolved.addresses.every(isPublicAddress)) return blocked;
  return { ok: true };
}

async function queryDoh(host: string, type: "A" | "AAAA"): Promise<string[] | null> {
  const query = new URL(DOH_ENDPOINT);
  query.searchParams.set("name", host);
  query.searchParams.set("type", type);
  try {
    const res = await fetch(query, {
      headers: { Accept: "application/dns-json" },
      redirect: "manual",
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return null;
    }
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const { Status, Answer } = body as { Status?: unknown; Answer?: unknown };
    // NXDOMAIN (3) and every other error fail too.
    if (Status !== 0) return null;
    if (Answer === undefined) return [];
    if (!Array.isArray(Answer)) return null;
    const addresses: string[] = [];
    // Answers through a CNAME include the final addresses.
    for (const record of Answer as unknown[]) {
      if (typeof record !== "object" || record === null) continue;
      const { type: recordType, data } = record as { type?: unknown; data?: unknown };
      if ((recordType === DNS_TYPE_A || recordType === DNS_TYPE_AAAA) && typeof data === "string") {
        addresses.push(data);
      }
    }
    return addresses;
  } catch {
    // Network errors, timeouts and invalid JSON.
    return null;
  }
}

// A and AAAA through DNS over HTTPS. Fails if either query fails; one of them may have no records.
export async function resolveWithDoh(host: string): Promise<ResolveResult> {
  const [a, aaaa] = await Promise.all([queryDoh(host, "A"), queryDoh(host, "AAAA")]);
  if (a === null || aaaa === null) return { ok: false };
  return { ok: true, addresses: [...a, ...aaaa] };
}

// [network, prefix length] of the IPv4 ranges that are not public.
const BLOCKED_IPV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  // Includes 255.255.255.255.
  ["240.0.0.0", 4],
];

// Dotted decimal without leading zeros, as an unsigned 32-bit number, or null.
function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inIpv4Range(address: number, network: string, prefix: number): boolean {
  const base = parseIpv4(network) ?? 0;
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(base / size);
}

// The eight 16-bit groups of an IPv6 address (with "::" and a trailing IPv4 part), or null.
function parseIpv6(address: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(address)) return null;
  let text = address;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 65536), v4 % 65536);
    text = text.slice(0, lastColon + 1);
    // "::1.2.3.4" leaves "::", "a::1.2.3.4" leaves "a::"; a single trailing colon is a separator.
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] ?? "");
  if (head === null) return null;
  if (halves.length === 1) {
    const groups = [...head, ...tail];
    return groups.length === 8 ? groups : null;
  }
  const rest = parseGroups(halves[1] ?? "");
  if (rest === null) return null;
  const missing = 8 - head.length - rest.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest, ...tail];
}

// Whether an address from DNS may be sent to. IPv4 blocks the special-purpose ranges; IPv6 allows global
// unicast (2000::/3) only, without the special-purpose and documentation ranges inside it. Unparsable
// addresses are not public.
export function isPublicAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== null) return !BLOCKED_IPV4.some(([network, prefix]) => inIpv4Range(v4, network, prefix));
  const v6 = parseIpv6(address);
  if (v6 === null) return false;
  const [first = 0, second = 0] = v6;
  if ((first & 0xe000) !== 0x2000) return false;
  // 2001::/23 (IETF protocol assignments, Teredo) and 2001:db8::/32 (documentation).
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
  // 2002::/16 (6to4).
  if (first === 0x2002) return false;
  // 3fff::/20 (documentation).
  if (first === 0x3fff && (second & 0xf000) === 0) return false;
  return true;
}
