import type {
  ApiKey,
  AssignMcpConnectionRequest,
  Bot,
  CreateBotRequest,
  ConversationDetail,
  CreateConversationRequest,
  CreateQueueRequest,
  CreateUserRequest,
  CreateWebhookDestinationRequest,
  CreatedApiKey,
  EmailAddress,
  PostConversationMessageRequest,
  Source,
  Subscription,
  UpdateBotRequest,
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

// Sets a new password for a user and ends their sessions, MCP connections, webhook destinations and polling queues
// (password mode only). Admins only. In OIDC mode the server also answers 404 with the same code, which cannot be told apart from a
// missing user; it only happens if the mode changed after the screen loaded, and the reload that follows
// hides the button. Never rejects.
export async function resetUserPassword(client: ApiClient, userId: string, password: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"].password.$post({ param: { id: userId }, json: { password } })),
  );
}

// Ends the sessions, MCP connections, webhook destinations and polling queues of a user. Admins only. Never rejects.
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

// The outcome of the actions on a source, one of its keys or one of its email addresses. notFound means the source,
// the key or the address is gone.
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

export type IssueEmailAddressResult = { kind: "ok"; emailAddress: EmailAddress } | { kind: "notFound" } | SendFailure;

// Issues an email address of the email intake. Errors, including email_not_configured and limit_exceeded (409),
// are shown with the server's message. Never rejects.
export async function issueEmailAddress(client: ApiClient, sourceId: string): Promise<IssueEmailAddressResult> {
  if (!isValidId(sourceId)) return INVALID_SOURCE_ID;
  const sent = await send(() =>
    client.api.v1.sources[":id"]["email-addresses"].$post({ param: { id: sourceId } }),
  );
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson<EmailAddress>(res);
    return body.kind === "ok" ? { kind: "ok", emailAddress: body.value } : body;
  }
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

// Revokes an email address of a source. Revoking a revoked address is ok. Never rejects.
export async function revokeEmailAddress(
  client: ApiClient,
  sourceId: string,
  localPart: string,
): Promise<SourceActionResult> {
  if (!isValidId(sourceId) || !isValidId(localPart)) return INVALID_SOURCE_ID;
  return resourceActionResult(
    await send(() =>
      client.api.v1.sources[":id"]["email-addresses"][":localPart"].revoke.$post({
        param: { id: sourceId, localPart },
      }),
    ),
  );
}

export type CreateWebhookDestinationResult = { kind: "ok"; subscription: Subscription } | SendFailure;

// Registers a webhook destination in the signed-in user's workspace. Errors, including limit_exceeded (409), are
// shown with the server's message. Never rejects.
export async function createWebhookDestination(
  client: ApiClient,
  input: CreateWebhookDestinationRequest,
): Promise<CreateWebhookDestinationResult> {
  const sent = await send(() => client.api.v1.subscriptions.webhooks.$post({ json: input }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson<Subscription>(res);
    return body.kind === "ok" ? { kind: "ok", subscription: body.value } : body;
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}

// The outcome of deleting a webhook destination. notFound means it is gone (or is not a webhook destination).
export type WebhookDestinationActionResult = ResourceActionResult;

const INVALID_WEBHOOK_DESTINATION_ID = { kind: "error", message: "Webhook 配信先が見つかりません" } as const;

// Deletes (ends) a webhook destination. Deleting a deleted one is ok. Never rejects.
export async function deleteWebhookDestination(
  client: ApiClient,
  subscriptionId: string,
): Promise<WebhookDestinationActionResult> {
  if (!isValidId(subscriptionId)) return INVALID_WEBHOOK_DESTINATION_ID;
  return resourceActionResult(
    await send(() => client.api.v1.subscriptions[":id"].delete.$post({ param: { id: subscriptionId } })),
  );
}

export type CreateQueueResult = { kind: "ok"; subscription: Subscription } | SendFailure;

// Registers a polling queue in the signed-in user's workspace. Errors, including limit_exceeded (409), are shown
// with the server's message. Never rejects.
export async function createQueue(client: ApiClient, input: CreateQueueRequest): Promise<CreateQueueResult> {
  const sent = await send(() => client.api.v1.subscriptions.queues.$post({ json: input }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson<Subscription>(res);
    return body.kind === "ok" ? { kind: "ok", subscription: body.value } : body;
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}

// The outcome of deleting a polling queue. notFound means it is gone (or is not a polling queue).
export type QueueActionResult = ResourceActionResult;

const INVALID_QUEUE_ID = { kind: "error", message: "ポーリング用キューが見つかりません" } as const;

// Deletes (ends) a polling queue; the events not taken yet fail. Deleting a deleted one is ok. Never rejects.
export async function deleteQueue(client: ApiClient, subscriptionId: string): Promise<QueueActionResult> {
  if (!isValidId(subscriptionId)) return INVALID_QUEUE_ID;
  return resourceActionResult(
    await send(() => client.api.v1.subscriptions[":id"].delete.$post({ param: { id: subscriptionId } })),
  );
}

export type CreateConversationResult = { kind: "ok"; conversation: ConversationDetail } | SendFailure;

// Creates a conversation and sends its first message. A retry with the same idempotency_key returns the
// conversation created first (200). Errors, including limit_exceeded (409) and temporarily_unavailable (503), are
// shown with the server's message. Never rejects.
export async function createConversation(
  client: ApiClient,
  input: CreateConversationRequest,
): Promise<CreateConversationResult> {
  const sent = await send(() => client.api.v1.conversations.$post({ json: input }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson<ConversationDetail>(res);
    return body.kind === "ok" ? { kind: "ok", conversation: body.value } : body;
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}

// The outcome of the actions on a conversation. notFound means it is gone; other errors (400, 409
// conversation_stopped, 503) are shown with the server's message.
export type ConversationActionResult = ResourceActionResult;

const INVALID_CONVERSATION_ID = { kind: "error", message: "会話が見つかりません" } as const;

// Sends a message of the user to a conversation. Never rejects.
export async function postConversationMessage(
  client: ApiClient,
  conversationId: string,
  input: PostConversationMessageRequest,
): Promise<ConversationActionResult> {
  if (!isValidId(conversationId)) return INVALID_CONVERSATION_ID;
  return resourceActionResult(
    await send(() =>
      client.api.v1.conversations[":id"].messages.$post({ param: { id: conversationId }, json: input }),
    ),
  );
}

// Stops a conversation. Stopping a stopped one is ok. Never rejects.
export async function stopConversation(client: ApiClient, conversationId: string): Promise<ConversationActionResult> {
  if (!isValidId(conversationId)) return INVALID_CONVERSATION_ID;
  return resourceActionResult(
    await send(() => client.api.v1.conversations[":id"].stop.$post({ param: { id: conversationId } })),
  );
}

// Stops an MCP Events subscription (one left by an old installation, for example). An AI that still runs may subscribe
// again. Stopping a stopped one is ok. Never rejects.
export async function stopMcpSubscription(client: ApiClient, subscriptionId: string): Promise<ResourceActionResult> {
  if (!isValidId(subscriptionId)) return { kind: "error", message: "購読が見つかりません" };
  return resourceActionResult(
    await send(() => client.api.v1.subscriptions[":id"].delete.$post({ param: { id: subscriptionId } })),
  );
}

export type BotResult = { kind: "ok"; bot: Bot } | { kind: "notFound" } | SendFailure;

async function botResult<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  sent: { kind: "response"; res: R } | SendFailure,
): Promise<BotResult> {
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson(res as { status: number; json(): Promise<Bot> });
    return body.kind === "ok" ? { kind: "ok", bot: body.value } : body;
  }
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

// Creates a bot. Errors, including name_conflict, delivery_in_use and limit_exceeded (409), are shown with the
// server's message. Never rejects.
export async function createBot(client: ApiClient, input: CreateBotRequest): Promise<BotResult> {
  return botResult(await send(() => client.api.v1.bots.$post({ json: input })));
}

const INVALID_BOT_ID = { kind: "error", message: "Bot が見つかりません" } as const;

// Changes the name or the destination of a bot. Never rejects.
export async function updateBot(client: ApiClient, botId: string, input: UpdateBotRequest): Promise<BotResult> {
  if (!isValidId(botId)) return INVALID_BOT_ID;
  return botResult(await send(() => client.api.v1.bots[":id"].update.$post({ param: { id: botId }, json: input })));
}

// Deletes a bot. Its MCP connection stays, not assigned to a bot; its destination is not ended. Deleting a deleted bot
// is ok. Never rejects.
export async function deleteBot(client: ApiClient, botId: string): Promise<ResourceActionResult> {
  if (!isValidId(botId)) return INVALID_BOT_ID;
  return resourceActionResult(await send(() => client.api.v1.bots[":id"].delete.$post({ param: { id: botId } })));
}

// Assigns an MCP connection (or a legacy grant) to a bot, or removes the assignment with bot_id null. The other
// connection of the bot, if any, is disconnected. Never rejects.
export async function assignMcpConnection(
  client: ApiClient,
  input: AssignMcpConnectionRequest,
): Promise<ResourceActionResult> {
  return resourceActionResult(await send(() => client.api.v1["mcp-connections"].assign.$post({ json: input })));
}

// Disconnects an MCP connection, or revokes a legacy grant. Disconnecting again is ok. Never rejects.
export async function revokeMcpConnection(
  client: ApiClient,
  target: { connection_id: string } | { grant_id: string },
): Promise<ResourceActionResult> {
  return resourceActionResult(await send(() => client.api.v1["mcp-connections"].revoke.$post({ json: target })));
}
