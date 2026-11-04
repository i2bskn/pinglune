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
  DeliveryListItem,
  EmailAddress,
  ManagedEventDetail,
  PostConversationMessageRequest,
  Source,
  Subscription,
  UpdateBotConversationStartRequest,
  UpdateBotRequest,
  UpdateSourceConversationStartRequest,
  UpdateSourceRequest,
  UpdateSourceScreeningRequest,
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

// Changes whether a source may start conversations, and its limits. Errors (400) are shown with the server's message.
// Never rejects.
export async function updateSourceConversationStart(
  client: ApiClient,
  sourceId: string,
  input: { enabled: boolean; dailyLimit: number; maxAiMessages: number },
): Promise<SourceActionResult> {
  if (!isValidId(sourceId)) return INVALID_SOURCE_ID;
  const json: UpdateSourceConversationStartRequest = {
    enabled: input.enabled,
    daily_limit: input.dailyLimit,
    max_ai_messages: input.maxAiMessages,
  };
  return resourceActionResult(
    await send(() => client.api.v1.sources[":id"]["conversation-start"].$post({ param: { id: sourceId }, json })),
  );
}

// Turns the screening of a source on or off. apiKey is sent only to turn it on in a workspace without a key. Errors
// (409 with the conversation start, 422 for a key that is missing or refused, 503 when TypeSafe cannot be reached)
// are shown with the server's message. Never rejects.
export async function updateSourceScreening(
  client: ApiClient,
  sourceId: string,
  input: { enabled: boolean; apiKey?: string },
): Promise<SourceActionResult> {
  if (!isValidId(sourceId)) return INVALID_SOURCE_ID;
  const json: UpdateSourceScreeningRequest =
    input.apiKey === undefined ? { enabled: input.enabled } : { enabled: input.enabled, api_key: input.apiKey };
  return resourceActionResult(
    await send(() => client.api.v1.sources[":id"].screening.$post({ param: { id: sourceId }, json })),
  );
}

// Turns the check of the sender of the email intake of a source on or off. Errors (400) are shown with the server's
// message. Never rejects.
export async function updateSourceEmailSenderVerification(
  client: ApiClient,
  sourceId: string,
  enabled: boolean,
): Promise<SourceActionResult> {
  if (!isValidId(sourceId)) return INVALID_SOURCE_ID;
  return resourceActionResult(
    await send(() =>
      client.api.v1.sources[":id"]["email-sender-verification"].$post({ param: { id: sourceId }, json: { enabled } }),
    ),
  );
}

// Saves the allowed senders of the email intake of a source. Errors (400, 422 too_many_senders and invalid_sender) are
// shown with the server's message. Never rejects.
export async function updateSourceEmailSenders(
  client: ApiClient,
  sourceId: string,
  senders: string[],
): Promise<SourceActionResult> {
  if (!isValidId(sourceId)) return INVALID_SOURCE_ID;
  return resourceActionResult(
    await send(() => client.api.v1.sources[":id"]["email-senders"].$post({ param: { id: sourceId }, json: { senders } })),
  );
}

// Sets or changes the TypeSafe API key of the workspace (checked with TypeSafe first). Never rejects.
export async function setScreeningApiKey(client: ApiClient, apiKey: string): Promise<ResourceActionResult> {
  return resourceActionResult(
    await send(() => client.api.v1.screening["api-key"].$put({ json: { api_key: apiKey } })),
  );
}

// Deletes the TypeSafe API key of the workspace. Never rejects.
export async function deleteScreeningApiKey(client: ApiClient): Promise<ResourceActionResult> {
  return resourceActionResult(await send(() => client.api.v1.screening["api-key"].$delete()));
}

export type ScreeningActionResult = { kind: "ok"; event: ManagedEventDetail } | { kind: "notFound" } | SendFailure;

const INVALID_EVENT_ID = { kind: "error", message: "イベントが見つかりません" } as const;

async function screeningActionResult<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  sent: { kind: "response"; res: R } | SendFailure,
): Promise<ScreeningActionResult> {
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson(res);
    // res.ok is true here, so the body is the event.
    return body.kind === "ok" ? { kind: "ok", event: body.value as ManagedEventDetail } : body;
  }
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

// Releases a held event and queues its deliveries (for a released one, queues them again). Errors (409, 503) are
// shown with the server's message. Never rejects.
export async function releaseEvent(client: ApiClient, eventId: string): Promise<ScreeningActionResult> {
  if (!isValidId(eventId)) return INVALID_EVENT_ID;
  return screeningActionResult(
    await send(() => client.api.v1.events[":id"].screening.release.$post({ param: { id: eventId } })),
  );
}

// Screens an event again. Errors (409, 503) are shown with the server's message. Never rejects.
export async function retryScreening(client: ApiClient, eventId: string): Promise<ScreeningActionResult> {
  if (!isValidId(eventId)) return INVALID_EVENT_ID;
  return screeningActionResult(
    await send(() => client.api.v1.events[":id"].screening.retry.$post({ param: { id: eventId } })),
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
// conversation created first (200). Errors, including idempotency_conflict (409) and temporarily_unavailable (503),
// are shown with the server's message. Never rejects.
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

// Changes the name, the sources, the destination or its conditions of a bot. Never rejects.
export async function updateBot(client: ApiClient, botId: string, input: UpdateBotRequest): Promise<BotResult> {
  if (!isValidId(botId)) return INVALID_BOT_ID;
  return botResult(await send(() => client.api.v1.bots[":id"].update.$post({ param: { id: botId }, json: input })));
}

// Changes whether the AI of a bot may start conversations, and its limits. Errors (400) are shown with the server's
// message. Never rejects.
export async function updateConversationStart(
  client: ApiClient,
  botId: string,
  input: { enabled: boolean; dailyLimit: number; maxAiMessages: number },
): Promise<BotResult> {
  if (!isValidId(botId)) return INVALID_BOT_ID;
  const json: UpdateBotConversationStartRequest = {
    enabled: input.enabled,
    daily_limit: input.dailyLimit,
    max_ai_messages: input.maxAiMessages,
  };
  return botResult(
    await send(() => client.api.v1.bots[":id"]["conversation-start"].$post({ param: { id: botId }, json })),
  );
}

export type DeleteBotResult =
  | ResourceActionResult
  // The bot was changed by another operation since the screen read it (409); the screen offers to reload.
  | { kind: "conflict"; message: string };

// Deletes a bot and ends its webhook destination or polling queue, or keeps it, not assigned to a bot, with
// keepDestination (sent as keep_destination=true; without it the request has no query). Its MCP connection stays, not
// assigned to a bot. Deleting a deleted bot is ok. Never rejects.
export async function deleteBot(
  client: ApiClient,
  botId: string,
  options: { keepDestination?: boolean } = {},
): Promise<DeleteBotResult> {
  if (!isValidId(botId)) return INVALID_BOT_ID;
  const query = options.keepDestination === true ? { keep_destination: "true" as const } : {};
  const sent = await send(() => client.api.v1.bots[":id"].delete.$post({ param: { id: botId }, query }));
  if (sent.kind === "response" && sent.res.status === 409) {
    return { kind: "conflict", message: await responseErrorMessage(sent.res) };
  }
  return resourceActionResult(sent);
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

export type RetryDeliveryResult = { kind: "ok"; delivery: DeliveryListItem } | SendFailure;

const INVALID_DELIVERY_ID = { kind: "error", message: "配信が見つかりません" } as const;

// Sends a failed delivery again. Returns the delivery as it is now (pending). Errors, including not_retryable (409),
// temporarily_unavailable (503) and the 404 of a delivery that is gone, are shown with the server's message. Never
// rejects.
export async function retryDelivery(client: ApiClient, deliveryId: string): Promise<RetryDeliveryResult> {
  if (!isValidId(deliveryId)) return INVALID_DELIVERY_ID;
  const sent = await send(() => client.api.v1.deliveries[":id"].retry.$post({ param: { id: deliveryId } }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    const body = await okJson<DeliveryListItem>(res);
    return body.kind === "ok" ? { kind: "ok", delivery: body.value } : body;
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}
