import { useEffect, useState } from "react";
import type {
  ApiKey,
  Bot,
  BotDetail,
  ConversationDetail,
  ConversationList,
  ConversationMessageList,
  DeliveryList,
  DeliveryStatus,
  EmailAddressList,
  EventDetail,
  EventList,
  McpConnection,
  Source,
  Subscription,
  User,
  UserList,
} from "../../src/api/types";
import { type EventFilterValues, eventsQuery } from "./events";
import { isValidId } from "./router";
import {
  LoginRequiredError,
  type createApiClient,
  responseErrorMessage,
  unexpectedResponseMessage,
} from "./api";

export type ApiClient = ReturnType<typeof createApiClient>;

// The state of a screen that loads its own data.
export type ViewState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  // The API answered 404.
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "redirecting" };

export type Loaded<T> = Exclude<ViewState<T>, { kind: "loading" }>;

export const CONNECTION_ERROR = "サーバーに接続できませんでした";

type Result<T> =
  | { kind: "ok"; value: T }
  | { kind: "notFound"; message: string }
  // status is null when there was no response.
  | { kind: "error"; message: string; status: number | null }
  | { kind: "redirecting" };

type JsonResponse = { ok: boolean; status: number; json(): Promise<unknown> };

// The JSON body of the ok responses of an hc() call.
type OkJson<R> = R extends { ok: true; json(): Promise<infer T> } ? T : never;

// Reads the JSON body of an ok response. null if it is not JSON.
async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Calls the API and sorts the outcome. Never rejects.
async function request<R extends JsonResponse>(call: () => Promise<R>): Promise<Result<OkJson<R>>> {
  let res: R;
  try {
    res = await call();
  } catch (error) {
    if (error instanceof LoginRequiredError) return { kind: "redirecting" };
    return { kind: "error", message: CONNECTION_ERROR, status: null };
  }
  if (res.status === 404) return { kind: "notFound", message: await responseErrorMessage(res) };
  if (!res.ok) return { kind: "error", message: await responseErrorMessage(res), status: res.status };
  const body = await readJson(res);
  if (body === null) return { kind: "error", message: unexpectedResponseMessage(res.status), status: res.status };
  // res.ok is true here, so the body is one of the ok bodies.
  return { kind: "ok", value: body as OkJson<R> };
}

// Combines the results of the calls of one screen, at least one of which is not ok:
// redirecting > not found > error.
function failure(results: Result<unknown>[]): Loaded<never> {
  if (results.some((r) => r.kind === "redirecting")) return { kind: "redirecting" };
  if (results.some((r) => r.kind === "notFound")) return { kind: "notFound" };
  for (const r of results) {
    if (r.kind === "error") return { kind: "error", message: r.message };
  }
  throw new Error("failure() needs a result that is not ok");
}

export async function loadMe(client: ApiClient): Promise<Loaded<User>> {
  const me = await request(() => client.api.v1.me.$get());
  if (me.kind === "redirecting") return me;
  // There is no "not found" for the signed-in user; show it as an error.
  if (me.kind === "notFound" || me.kind === "error") return { kind: "error", message: me.message };
  return { kind: "ready", data: me.value };
}

export type UsersData = { users: User[]; authMode: UserList["auth_mode"] };

// Admins only. A 403 (a member opened the URL) is shown with the server's message.
export async function loadUsersView(client: ApiClient): Promise<Loaded<UsersData>> {
  const list = await request(() => client.api.v1.users.$get());
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: { users: list.value.users, authMode: list.value.auth_mode } };
}

const NO_FILTER: EventFilterValues = { type: "", sourceId: "" };

// A page of the event list. cursor is the next_cursor of the previous page; filter limits it to a type and a source
// (empty values are not sent).
export async function loadEvents(
  client: ApiClient,
  cursor?: string,
  filter: EventFilterValues = NO_FILTER,
): Promise<Loaded<EventList>> {
  const list = await request(() => client.api.v1.events.$get({ query: eventsQuery(filter, cursor) }));
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: list.value };
}

export type EventsViewData = {
  // null with eventsError set when the filter was rejected (400): the screen keeps the form to fix it.
  events: EventList | null;
  eventsError: string | null;
  // The sources of the filter. Empty with sourcesError set when they cannot be read; the events are shown anyway.
  sources: Source[];
  sourcesError: string | null;
};

// The first page of the event list with the filter, and the sources to choose from.
export async function loadEventsView(client: ApiClient, filter: EventFilterValues): Promise<Loaded<EventsViewData>> {
  const [events, sources] = await Promise.all([
    request(() => client.api.v1.events.$get({ query: eventsQuery(filter) })),
    request(() => client.api.v1.sources.$get()),
  ]);
  if (events.kind === "redirecting" || sources.kind === "redirecting") return { kind: "redirecting" };
  const sourceData = {
    sources: sources.kind === "ok" ? sources.value.sources : [],
    sourcesError: sources.kind === "ok" ? null : sources.message,
  };
  if (events.kind === "error" && events.status === 400) {
    return { kind: "ready", data: { events: null, eventsError: events.message, ...sourceData } };
  }
  // The list itself is never missing; a 404 here is an unexpected response.
  if (events.kind !== "ok") return { kind: "error", message: events.message };
  return { kind: "ready", data: { events: events.value, eventsError: null, ...sourceData } };
}

export async function loadEventDetail(client: ApiClient, id: string): Promise<Loaded<EventDetail>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const event = await request(() => client.api.v1.events[":id"].$get({ param: { id } }));
  if (event.kind !== "ok") return failure([event]);
  return { kind: "ready", data: event.value };
}

// A page of the delivery list. cursor is the next_cursor of the previous page; eventId limits it to one event, status
// to one status and subscriptionId to one destination.
export async function loadDeliveries(
  client: ApiClient,
  options: { cursor?: string; eventId?: string; status?: DeliveryStatus; subscriptionId?: string } = {},
): Promise<Loaded<DeliveryList>> {
  const query: { cursor?: string; event_id?: string; status?: DeliveryStatus; subscription_id?: string } = {};
  if (options.cursor !== undefined) query.cursor = options.cursor;
  if (options.eventId !== undefined) query.event_id = options.eventId;
  if (options.status !== undefined) query.status = options.status;
  if (options.subscriptionId !== undefined) query.subscription_id = options.subscriptionId;
  const list = await request(() => client.api.v1.deliveries.$get({ query }));
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: list.value };
}

export type DeliveriesData = { subscriptions: Subscription[] };

// The destinations: the subscriptions of every kind. The deliveries are on the delivery history.
export async function loadDeliveriesView(client: ApiClient): Promise<Loaded<DeliveriesData>> {
  const subscriptions = await request(() => client.api.v1.subscriptions.$get());
  if (subscriptions.kind === "redirecting") return subscriptions;
  // The list is never missing; a 404 here is an unexpected response.
  if (subscriptions.kind !== "ok") return { kind: "error", message: subscriptions.message };
  return { kind: "ready", data: { subscriptions: subscriptions.value.subscriptions } };
}

// The bots that receive the events of a source, by name.
export async function loadSourceBots(client: ApiClient, sourceId: string): Promise<Loaded<Bot[]>> {
  const bots = await request(() => client.api.v1.bots.$get());
  if (bots.kind === "redirecting") return bots;
  // The list is never missing; a 404 here is an unexpected response.
  if (bots.kind !== "ok") return { kind: "error", message: bots.message };
  return { kind: "ready", data: bots.value.bots.filter((bot) => bot.sources.some((source) => source.id === sourceId)) };
}

export type DataResult = { kind: "ok"; blob: Blob } | { kind: "error"; message: string } | { kind: "redirecting" };

// The contents of the body or an attachment of an event, through the API client (so that an expired access token is
// refreshed). Never rejects.
export async function fetchEventData(client: ApiClient, eventId: string, dataRef: string): Promise<DataResult> {
  if (!isValidId(eventId) || !isValidId(dataRef)) return { kind: "error", message: "データが見つかりません" };
  let res: Awaited<ReturnType<(typeof client.api.v1.events)[":id"]["data"][":dataRef"]["$get"]>>;
  try {
    res = await client.api.v1.events[":id"].data[":dataRef"].$get({ param: { id: eventId, dataRef } });
  } catch (error) {
    if (error instanceof LoginRequiredError) return { kind: "redirecting" };
    return { kind: "error", message: CONNECTION_ERROR };
  }
  if (!res.ok) return { kind: "error", message: await responseErrorMessage(res) };
  try {
    return { kind: "ok", blob: await res.blob() };
  } catch {
    return { kind: "error", message: CONNECTION_ERROR };
  }
}

export async function loadSources(client: ApiClient): Promise<Loaded<Source[]>> {
  const list = await request(() => client.api.v1.sources.$get());
  if (list.kind === "redirecting") return list;
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: list.value.sources };
}

export type FlowData = { sources: Source[]; bots: Bot[] };

// The sources and the bots of the flow map of the home screen.
export async function loadFlow(client: ApiClient): Promise<Loaded<FlowData>> {
  const [sources, bots] = await Promise.all([
    request(() => client.api.v1.sources.$get()),
    request(() => client.api.v1.bots.$get()),
  ]);
  if (sources.kind === "redirecting" || bots.kind === "redirecting") return { kind: "redirecting" };
  // Neither list is ever missing; a 404 here is an unexpected response.
  if (sources.kind !== "ok") return { kind: "error", message: sources.message };
  if (bots.kind !== "ok") return { kind: "error", message: bots.message };
  return { kind: "ready", data: { sources: sources.value.sources, bots: bots.value.bots } };
}
export type OverviewData = FlowData & { events: EventList; deliveries: DeliveryList; subscriptions: Subscription[] };

// The overview screen: the sources and bots (for the flow map), and the first page of the events and of the
// deliveries (the newest ones).
export async function loadOverview(client: ApiClient): Promise<Loaded<OverviewData>> {
  const [sources, bots, events, deliveries, subscriptions] = await Promise.all([
    request(() => client.api.v1.sources.$get()),
    request(() => client.api.v1.bots.$get()),
    request(() => client.api.v1.events.$get({ query: {} })),
    request(() => client.api.v1.deliveries.$get({ query: {} })),
    request(() => client.api.v1.subscriptions.$get()),
  ]);
  if (
    sources.kind === "redirecting" ||
    bots.kind === "redirecting" ||
    events.kind === "redirecting" ||
    deliveries.kind === "redirecting" ||
    subscriptions.kind === "redirecting"
  ) {
    return { kind: "redirecting" };
  }
  // None of the lists is ever missing; a 404 here is an unexpected response.
  if (sources.kind !== "ok") return { kind: "error", message: sources.message };
  if (bots.kind !== "ok") return { kind: "error", message: bots.message };
  if (events.kind !== "ok") return { kind: "error", message: events.message };
  if (deliveries.kind !== "ok") return { kind: "error", message: deliveries.message };
  if (subscriptions.kind !== "ok") return { kind: "error", message: subscriptions.message };
  return {
    kind: "ready",
    data: {
      sources: sources.value.sources,
      bots: bots.value.bots,
      events: events.value,
      deliveries: deliveries.value,
      subscriptions: subscriptions.value.subscriptions,
    },
  };
}

export type SourceDetailData = { source: Source; apiKeys: ApiKey[]; emailAddresses: EmailAddressList };

// There is no API for one source; it is taken from the list.
export async function loadSourceDetail(client: ApiClient, id: string): Promise<Loaded<SourceDetailData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const [list, keys, addresses] = await Promise.all([
    request(() => client.api.v1.sources.$get()),
    request(() => client.api.v1.sources[":id"]["api-keys"].$get({ param: { id } })),
    request(() => client.api.v1.sources[":id"]["email-addresses"].$get({ param: { id } })),
  ]);
  if (list.kind !== "ok" || keys.kind !== "ok" || addresses.kind !== "ok") return failure([list, keys, addresses]);
  const source = list.value.sources.find((s) => s.id === id);
  if (!source) return { kind: "notFound" };
  return { kind: "ready", data: { source, apiKeys: keys.value.api_keys, emailAddresses: addresses.value } };
}

// A page of the conversation list. cursor is the next_cursor of the previous page.
export async function loadConversations(client: ApiClient, cursor?: string): Promise<Loaded<ConversationList>> {
  const list = await request(() => client.api.v1.conversations.$get({ query: cursor === undefined ? {} : { cursor } }));
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: list.value };
}

export type ConversationDetailData = { conversation: ConversationDetail; messages: ConversationMessageList };

// A conversation and its newest messages.
export async function loadConversationDetail(client: ApiClient, id: string): Promise<Loaded<ConversationDetailData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const [conversation, messages] = await Promise.all([
    request(() => client.api.v1.conversations[":id"].$get({ param: { id } })),
    request(() => client.api.v1.conversations[":id"].messages.$get({ param: { id }, query: {} })),
  ]);
  if (conversation.kind !== "ok" || messages.kind !== "ok") return failure([conversation, messages]);
  return { kind: "ready", data: { conversation: conversation.value, messages: messages.value } };
}

// The messages older than cursor (the older_cursor of the previous page).
export async function loadConversationMessages(
  client: ApiClient,
  id: string,
  cursor: string,
): Promise<Loaded<ConversationMessageList>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const page = await request(() =>
    client.api.v1.conversations[":id"].messages.$get({ param: { id }, query: { cursor } }),
  );
  if (page.kind !== "ok") return failure([page]);
  return { kind: "ready", data: page.value };
}

export type ConversationFormData = {
  // The bots of the workspace, by name.
  bots: Bot[];
};

// The choices of the creation form of a conversation.
export async function loadConversationForm(client: ApiClient): Promise<Loaded<ConversationFormData>> {
  const bots = await request(() => client.api.v1.bots.$get());
  if (bots.kind === "redirecting") return bots;
  // The list is never missing; a 404 here is an unexpected response.
  if (bots.kind !== "ok") return { kind: "error", message: bots.message };
  return { kind: "ready", data: { bots: bots.value.bots } };
}

export type BotsData = {
  bots: Bot[];
  // The MCP connections of the user. Empty with connectionsError set when they cannot be read (e.g. 503 where MCP is
  // not served).
  connections: McpConnection[];
  connectionsError: string | null;
  // Every subscription, for the destinations of the bots and the subscriptions of the connections.
  subscriptions: Subscription[];
  // The sources of programs, for the sources of the bots. Empty with sourcesError set when they cannot be read; the
  // bots are shown anyway.
  sources: Source[];
  sourcesError: string | null;
};

// The bots, the MCP connections, the subscriptions and the sources of the Bot screen.
export async function loadBotsView(client: ApiClient): Promise<Loaded<BotsData>> {
  const [bots, connections, subscriptions, sources] = await Promise.all([
    request(() => client.api.v1.bots.$get()),
    request(() => client.api.v1["mcp-connections"].$get()),
    request(() => client.api.v1.subscriptions.$get()),
    request(() => client.api.v1.sources.$get()),
  ]);
  if (
    bots.kind === "redirecting" ||
    connections.kind === "redirecting" ||
    subscriptions.kind === "redirecting" ||
    sources.kind === "redirecting"
  ) {
    return { kind: "redirecting" };
  }
  // The lists are never missing; a 404 here is an unexpected response.
  if (bots.kind !== "ok") return { kind: "error", message: bots.message };
  if (subscriptions.kind !== "ok") return { kind: "error", message: subscriptions.message };
  return {
    kind: "ready",
    data: {
      bots: bots.value.bots,
      connections: connections.kind === "ok" ? connections.value.connections : [],
      connectionsError: connections.kind === "ok" ? null : connections.message,
      subscriptions: subscriptions.value.subscriptions,
      sources: sources.kind === "ok" ? sources.value.sources : [],
      sourcesError: sources.kind === "ok" ? null : sources.message,
    },
  };
}

export type BotDetailData = {
  bot: BotDetail;
  // The sources of programs, for the sources of the bot. Empty with sourcesError set when they cannot be read.
  sources: Source[];
  sourcesError: string | null;
  // The MCP connections of the user, to tell an expired connection. Empty when they cannot be read.
  connections: McpConnection[];
};

// One bot with its destination, the sources to choose from and the MCP connections. A deleted bot is not found.
export async function loadBotDetail(client: ApiClient, id: string): Promise<Loaded<BotDetailData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const [bot, sources, connections] = await Promise.all([
    request(() => client.api.v1.bots[":id"].$get({ param: { id } })),
    request(() => client.api.v1.sources.$get()),
    request(() => client.api.v1["mcp-connections"].$get()),
  ]);
  if (sources.kind === "redirecting" || connections.kind === "redirecting") return { kind: "redirecting" };
  if (bot.kind !== "ok") return failure([bot]);
  return {
    kind: "ready",
    data: {
      bot: bot.value,
      sources: sources.kind === "ok" ? sources.value.sources : [],
      sourcesError: sources.kind === "ok" ? null : sources.message,
      connections: connections.kind === "ok" ? connections.value.connections : [],
    },
  };
}

// Loads a screen's data while the component is mounted, and again when key changes or reload is called.
// A result that arrives after key has changed is dropped, so a previous screen does not overwrite the state.
export function useView<T>(load: () => Promise<Loaded<T>>, key: string): [ViewState<T>, () => void] {
  const [state, setState] = useState<ViewState<T>>({ kind: "loading" });
  // Incremented by reload to load again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
    // load is a new function on every render; key identifies what it loads.
  }, [key, attempt]);

  return [state, () => setAttempt((n) => n + 1)];
}
