import { codePointLength } from "../intake/validation";

// The rule of display names, shared by the management API (src/routes/) and by the modules that the MCP handler of
// src/core.ts loads (src/mcp/tools.ts, src/events/filter.ts, src/intake/conversation.ts). Kept out of
// src/routes/sources.ts, so that those modules do not load the routes, which use src/core.ts while it is loading.

export const SOURCE_NAME_MAX_LENGTH = 64;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

// The trimmed name, or null if invalid: 1 to 64 characters without control characters. Also the rule of the
// names of webhook destinations (src/routes/subscriptions.ts).
export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = codePointLength(name);
  if (length < 1 || length > SOURCE_NAME_MAX_LENGTH || CONTROL.test(name)) return null;
  return name;
}
