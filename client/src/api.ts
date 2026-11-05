import { hc } from "hono/client";
import type { ApiFetch } from "@i2bskn/workers-app-core/client";
// Type-only: the server code must not end up in the client bundle.
import type { AppType } from "../../src/app";

// The fetch for hc() that refreshes the session, and the error messages, from @i2bskn/workers-app-core.
export {
  LoginRequiredError,
  RefreshFailedError,
  createApiFetch,
  responseErrorMessage,
  unexpectedResponseMessage,
  type ApiFetch,
  type ApiFetchOptions,
} from "@i2bskn/workers-app-core/client";

export function createApiClient(apiFetch: ApiFetch) {
  return hc<AppType>("/", { fetch: apiFetch });
}
