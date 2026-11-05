// The JSON body helpers and toApiUser come from @i2bskn/workers-app-core. Pass AppEnv as the third type argument of
// jsonBody, so that the c of the check functions is typed.
export { jsonBody, readJsonObject, toApiUser, type JsonCheck } from "@i2bskn/workers-app-core";

// The first key of body that is not in allowed, or null.
export function unknownField(body: Record<string, unknown>, allowed: string[]): string | null {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) return key;
  return null;
}
