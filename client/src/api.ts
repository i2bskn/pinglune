import { hc } from "hono/client";
import type { ApiFetch } from "@i2bskn/workers-app-core/client";
// Type-only: the server code must not end up in the client bundle.
import type { AppType } from "../../src/app";

// The fetch for hc() that refreshes the session, the error messages and the user management functions, from
// @i2bskn/workers-app-core.
export {
  LoginRequiredError,
  RefreshFailedError,
  changeUserRole,
  createApiFetch,
  createUser,
  deleteUser,
  listUsers,
  reissueUserInvitation,
  resetUserMfa,
  resetUserPassword,
  responseErrorMessage,
  revokeUserSessions,
  unexpectedResponseMessage,
  type ApiFetch,
  type ApiFetchOptions,
  type CreateUserResult,
  type InvitationResult,
  type ListUsersResult,
  type UserActionResult,
  type UserApiFailure,
} from "@i2bskn/workers-app-core/client";

export function createApiClient(apiFetch: ApiFetch) {
  return hc<AppType>("/", { fetch: apiFetch });
}
