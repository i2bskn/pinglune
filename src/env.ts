import type { AppEnv as CoreAppEnv, CoreBindings } from "@i2bskn/workers-app-core";
import type { WorkspaceRow } from "./db/schema";
import type { DeliveryMessage } from "./deliveries/enqueue";

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
