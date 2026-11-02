import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { ChangeMyPasswordRequest } from "../api/types";
import { clock } from "../clock";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { setCookiesForSession } from "../auth/cookies";
import { apiError, requireMode, requireUser } from "../auth/middleware";
import { hashPassword, verifyPassword } from "../auth/password";
import { prepareNewSession, revokeUserSessionsQuery } from "../auth/sessions";
import { isValidPassword } from "../auth/validate";
import { revokeAllGrants } from "../mcp/grants";
import { endUserSubscriptionsQuery } from "../subscriptions/queries";
import { jsonBody, toApiUser } from "./api";

const changeMyPasswordBody = jsonBody<ChangeMyPasswordRequest, ChangeMyPasswordRequest>((body, c) => {
  if (typeof body.current_password !== "string") {
    return apiError(c, 400, "invalid_current_password", "現在のパスワードを指定してください");
  }
  if (!isValidPassword(body.new_password)) {
    return apiError(c, 400, "invalid_new_password", "新しいパスワードは 12 文字以上 256 文字以下にしてください");
  }
  return { ok: true, value: { current_password: body.current_password, new_password: body.new_password } };
});

const me = new Hono<AppEnv>()
  .get("/", requireUser, (c) => c.json(toApiUser(c.get("user")), 200))
  .post("/password", requireMode("password"), requireUser, changeMyPasswordBody, async (c) => {
    const input = c.req.valid("json");
    const user = c.get("user");
    if (user.passwordHash === null) {
      return apiError(c, 400, "password_not_set", "パスワードが設定されていません");
    }
    if (!(await verifyPassword(input.current_password, user.passwordHash))) {
      return apiError(c, 400, "invalid_current_password", "現在のパスワードが違います");
    }

    // All MCP grants are revoked, unlike sessions, where the current one is kept, and the MCP Events
    // subscriptions end. Webhook destinations stay: their keys belong to the receivers, not to the user's login,
    // so a routine password change does not stop them silently. Polling queues stay too: they are read through MCP,
    // which needs a new authorization anyway. KV first: if it fails, D1 is unchanged and the request can be
    // retried.
    if (c.env.OAUTH_PROVIDER) await revokeAllGrants(c.env.OAUTH_PROVIDER, user.id);
    const db = c.get("db");
    const config = c.get("config");
    const now = clock.now();
    const passwordHash = await hashPassword(input.new_password);
    const { session, insert } = await prepareNewSession(db, user.id, "password", now);
    // Order matters: revoke existing sessions before inserting the new one.
    await db.batch([
      db.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, user.id)),
      revokeUserSessionsQuery(db, user.id, now),
      endUserSubscriptionsQuery(db, user.id, now, { includeWebhooks: false }),
      insert,
    ]);
    await setCookiesForSession(c, session, config.jwtSecret, now);
    return c.body(null, 204);
  });

export default me;
