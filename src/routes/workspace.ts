import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { apiError } from "../auth/middleware";
import { findPersonalWorkspaceByUserId } from "../workspaces/queries";

// After requireUser. Sets the signed-in user's personal workspace, the only one the management API works on,
// for admins too. Every user has one, so a missing workspace is a broken invariant (500).
export const requirePersonalWorkspace: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  const workspace = await findPersonalWorkspaceByUserId(c.get("db"), user.id);
  if (!workspace) {
    console.error("personal workspace not found", { userId: user.id });
    return apiError(c, 500, "internal_error", "サーバーでエラーが発生しました");
  }
  c.set("workspace", workspace);
  return next();
};
