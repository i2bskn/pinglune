import type { Context, MiddlewareHandler } from "hono";
import type { User } from "../api/types";
import type { UserRow } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../auth/middleware";
import { isJsonObject } from "../auth/validate";

export function toApiUser(user: UserRow): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    created_at: user.createdAt,
    last_login_at: user.lastLoginAt,
  };
}

// Returns the JSON body if it is an object, otherwise null.
export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return isJsonObject(body) ? body : null;
  } catch {
    return null;
  }
}

export type JsonCheck<Out> = (
  body: Record<string, unknown>,
  c: Context<AppEnv>,
) => { ok: true; value: Out } | Response;

// Validates the JSON body and passes the result to c.req.valid("json").
// Reads the body regardless of Content-Type, and returns the error response from check as is.
export function jsonBody<In, Out extends object>(
  check: JsonCheck<Out>,
): MiddlewareHandler<AppEnv, string, { in: { json: In }; out: { json: Out } }> {
  return async (c, next) => {
    const body = await readJsonObject(c);
    if (!body) return apiError(c, 400, "invalid_body", "リクエストの形式が正しくありません");
    const result = check(body, c);
    if (result instanceof Response) return result;
    c.req.addValidatedData("json", result.value);
    return next();
  };
}
