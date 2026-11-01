import type {
  ApiKey,
  CreateUserRequest,
  CreatedApiKey,
  Source,
  UpdateSourceRequest,
  User,
} from "../../src/api/types";
import { LoginRequiredError, responseErrorMessage, unexpectedResponseMessage } from "./api";
import type { ApiClient } from "./load";
import { isValidId } from "./router";

// The outcomes shared by the actions below.
type SendFailure =
  | { kind: "error"; message: string }
  // The request did not get a response, so it may have succeeded on the server.
  | { kind: "unknown" }
  // Login is required and the move to the login page has started.
  | { kind: "redirecting" };

// Sends a request. A rejection becomes the failure to return; never rejects.
async function send<R>(call: () => Promise<R>): Promise<{ kind: "response"; res: R } | SendFailure> {
  try {
    return { kind: "response", res: await call() };
  } catch (error) {
    if (error instanceof LoginRequiredError) return { kind: "redirecting" };
    return { kind: "unknown" };
  }
}

// The outcome of the actions on a resource. Errors of the request (400), of the permissions (403) and of
// the state of the resource (409) are shown with the server's message.
type ResourceActionResult =
  | { kind: "ok" }
  // The resource is missing or not accessible.
  | { kind: "notFound" }
  | SendFailure;

async function resourceActionResult<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  sent: { kind: "response"; res: R } | SendFailure,
): Promise<ResourceActionResult> {
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type CreateUserResult = { kind: "ok"; user: User } | SendFailure;

// Creates a user with a password (password mode only). Admins only. Errors, including email_taken (409) and
// the 404 of OIDC mode, are shown with the server's message. Never rejects.
export async function createUser(client: ApiClient, input: CreateUserRequest): Promise<CreateUserResult> {
  const sent = await send(() => client.api.v1.users.$post({ json: input }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", user: await res.json() };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}

// The outcome of the actions on a user. notFound means the user is gone; other errors (400, 403, and 409
// last_admin) are shown with the server's message.
export type UserActionResult = ResourceActionResult;

// hc() puts params into the URL without encoding them, so an invalid ID is not sent.
const INVALID_USER_ID: UserActionResult = { kind: "error", message: "ユーザーが見つかりません" };

// Changes the role of a user. Admins only. Never rejects.
export async function changeUserRole(client: ApiClient, userId: string, role: User["role"]): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"].$patch({ param: { id: userId }, json: { role } })),
  );
}

// Sets a new password for a user and ends their sessions and MCP connections (password mode only). Admins
// only. In OIDC mode the server also answers 404 with the same code, which cannot be told apart from a
// missing user; it only happens if the mode changed after the screen loaded, and the reload that follows
// hides the button. Never rejects.
export async function resetUserPassword(client: ApiClient, userId: string, password: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"].password.$post({ param: { id: userId }, json: { password } })),
  );
}

// Ends the sessions and MCP connections of a user. Admins only. Never rejects.
export async function revokeUserSessions(client: ApiClient, userId: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"]["revoke-sessions"].$post({ param: { id: userId } })),
  );
}

// Deletes a user with their personal workspace and everything in it. This cannot be undone. Admins only.
// Never rejects.
export async function deleteUser(client: ApiClient, userId: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(await send(() => client.api.v1.users[":id"].$delete({ param: { id: userId } })));
}

// Reads the JSON body of an ok response; an error if it is not JSON.
async function okJson<T>(res: { status: number; json(): Promise<T> }): Promise<{ kind: "ok"; value: T } | SendFailure> {
  try {
    return { kind: "ok", value: await res.json() };
  } catch {
    return { kind: "error", message: unexpectedResponseMessage(res.status) };
  }
}

export type CreateSourceResult = { kind: "ok"; source: Source } | SendFailure;

// Creates a source in the signed-in user's workspace. Errors, including source_name_taken and
// limit_exceeded (409), are shown with the server's message. Never rejects.
export async function createSource(client: ApiClient, name: string): Promise<CreateSourceResult> {
  const sent = await send(() => client.api.v1.sources.$post({ json: { name } }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson(res);
    return body.kind === "ok" ? { kind: "ok", source: body.value } : body;
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}

// The outcome of the actions on a source or one of its keys. notFound means the source or the key is gone.
export type SourceActionResult = ResourceActionResult;

const INVALID_SOURCE_ID = { kind: "error", message: "送信元が見つかりません" } as const;

// Renames a source, or enables or disables it. Never rejects.
export async function updateSource(
  client: ApiClient,
  sourceId: string,
  input: UpdateSourceRequest,
): Promise<SourceActionResult> {
  if (!isValidId(sourceId)) return INVALID_SOURCE_ID;
  return resourceActionResult(
    await send(() => client.api.v1.sources[":id"].$patch({ param: { id: sourceId }, json: input })),
  );
}

export type IssueApiKeyResult =
  | { kind: "ok"; apiKey: ApiKey; key: string }
  | { kind: "notFound" }
  | SendFailure;

// Issues an API key. key is the plain key, which the server returns only in this response. Errors, including
// limit_exceeded (409), are shown with the server's message. Never rejects.
export async function issueApiKey(client: ApiClient, sourceId: string): Promise<IssueApiKeyResult> {
  if (!isValidId(sourceId)) return INVALID_SOURCE_ID;
  const sent = await send(() => client.api.v1.sources[":id"]["api-keys"].$post({ param: { id: sourceId } }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson<CreatedApiKey>(res);
    return body.kind === "ok" ? { kind: "ok", apiKey: body.value.api_key, key: body.value.key } : body;
  }
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

// Revokes an API key of a source. Revoking a revoked key is ok. Never rejects.
export async function revokeApiKey(client: ApiClient, sourceId: string, keyId: string): Promise<SourceActionResult> {
  if (!isValidId(sourceId) || !isValidId(keyId)) return INVALID_SOURCE_ID;
  return resourceActionResult(
    await send(() =>
      client.api.v1.sources[":id"]["api-keys"][":keyId"].revoke.$post({ param: { id: sourceId, keyId } }),
    ),
  );
}
