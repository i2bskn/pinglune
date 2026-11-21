import type { AppEnv as CoreAppEnv, CoreBindings } from "@i2bskn/workers-app-core";
import type { WorkspaceRow } from "./db/schema";
import type { DeliveryMessage } from "./deliveries/enqueue";
import { normalizeEmailAddress } from "./email/address";

export { loadConfig, type AuthMode, type Config } from "@i2bskn/workers-app-core";

// Login, sessions, user management and MCP OAuth come from @i2bskn/workers-app-core (src/core.ts), with their bindings
// (DB, OAUTH_KV, OAUTH_PROVIDER, AUTH_MODE, JWT_SECRET, APP_ORIGIN, OIDC_*, ALLOWED_EMAILS).
export type Bindings = CoreBindings & {
  // The bodies and attachments of received events.
  EVENT_DATA: R2Bucket;
  // Webhook deliveries of MCP Events (src/deliveries).
  DELIVERY_QUEUE: Queue<DeliveryMessage>;
  // The domain of the email intake (the apex of a Cloudflare zone). Optional; read by parseEmailDomain, not by
  // loadConfig.
  EMAIL_DOMAIN?: string;
  // Email deliveries of bots (src/deliveries/email.ts): the send_email binding (wrangler.jsonc) and the sender address.
  // Both are needed; read by emailDeliveryConfig, not by loadConfig.
  SEND_EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  // The score at or above which the screening holds an event (src/screening/service.ts), greater than 0 and at most
  // 1. Optional (0.5); read by screeningThreshold, not by loadConfig.
  SCREENING_THRESHOLD?: string;
};

// workspace is set by requirePersonalWorkspace (src/routes/workspace.ts).
export type AppEnv = CoreAppEnv<Bindings, { workspace: WorkspaceRow }>;

export type EmailDomainResult = { ok: true; domain: string | null } | { ok: false };

const EMAIL_DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// EMAIL_DOMAIN, trimmed and lowercased. Unset or blank turns the email intake off (domain null). Kept out of
// loadConfig so that a mistake in this optional setting stops only the email intake, not HTTP, MCP or deliveries.
export function parseEmailDomain(value: unknown): EmailDomainResult {
  if (value === undefined) return { ok: true, domain: null };
  if (typeof value !== "string") return { ok: false };
  const domain = value.trim().toLowerCase();
  if (domain === "") return { ok: true, domain: null };
  return EMAIL_DOMAIN_PATTERN.test(domain) ? { ok: true, domain } : { ok: false };
}

export type EmailDeliveryConfig = { send: SendEmail; from: string };

// Logged once per isolate: emailDeliveryConfig runs on every request and queue batch.
let invalidEmailFromWarned = false;

// The binding and the sender of email deliveries, or null when they are off: no SEND_EMAIL binding, EMAIL_FROM unset
// or blank, or EMAIL_FROM not an address (logged). Kept out of loadConfig, like EMAIL_DOMAIN, so that a mistake in
// this optional setting stops only the email deliveries.
export function emailDeliveryConfig(env: Pick<Bindings, "SEND_EMAIL" | "EMAIL_FROM">): EmailDeliveryConfig | null {
  const send = env.SEND_EMAIL;
  const value = env.EMAIL_FROM;
  if (send === undefined || typeof value !== "string" || value.trim() === "") return null;
  const from = normalizeEmailAddress(value);
  if (from === null) {
    if (!invalidEmailFromWarned) {
      invalidEmailFromWarned = true;
      console.warn("EMAIL_FROM is not an email address: email deliveries are off");
    }
    return null;
  }
  return { send, from };
}
