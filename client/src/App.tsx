import type { User } from "../../src/api/types";
import { BRAND_NAME } from "../../src/brand";
import { createApiClient, createApiFetch, unexpectedResponseMessage } from "./api";
import { loadMe, useView } from "./load";
import { type Route, matchRoute, usePath } from "./router";
import { markLeaving } from "./unload";
import { BotsView } from "./views/BotsView";
import { LoadError, NotFound, useDocumentTitle } from "./views/common";
import { ConversationDetailView } from "./views/ConversationDetailView";
import { ConversationsView } from "./views/ConversationsView";
import { DeliveriesView } from "./views/DeliveriesView";
import { DeliveryHistoryView } from "./views/DeliveryHistoryView";
import { ErrorBoundary } from "./views/ErrorBoundary";
import { EventDetailView } from "./views/EventDetailView";
import { EventsView } from "./views/EventsView";
import { HomeView } from "./views/HomeView";
import { AppShell } from "./views/Sidebar";
import { SourceDetailView } from "./views/SourceDetailView";
import { SourcesView } from "./views/SourcesView";
import { UsersView } from "./views/UsersView";

// One client for every screen: the shared refresh and the single move to the login page are per instance.
const client = createApiClient(
  createApiFetch({
    fetch: globalThis.fetch.bind(globalThis),
    redirectToLogin: (url) => {
      markLeaving();
      location.assign(url);
    },
    currentPath: () => location.pathname + location.search,
  }),
);

export function App() {
  // Loaded once; moving between screens does not load it again. Screens load their data after it.
  const [me, reload] = useView(() => loadMe(client), "me");
  const path = usePath();
  const route = matchRoute(path);

  switch (me.kind) {
    case "loading":
      return <p className="status">読み込み中…</p>;
    case "redirecting":
      return <p className="status">ログイン画面へ移動しています…</p>;
    case "error":
      return <LoadError message={me.message} onReload={reload} />;
    case "notFound":
      // loadMe reports a 404 as an error; this case only completes the switch.
      return <LoadError message={unexpectedResponseMessage(404)} onReload={reload} />;
    case "ready":
      return (
        <AppShell user={me.data} route={route} path={path}>
          <div className="layout">
            <div className="layout-screen">
              <ErrorBoundary key={path}>
                <Screen route={route} path={path} user={me.data} />
              </ErrorBoundary>
            </div>
          </div>
        </AppShell>
      );
  }
}

// path includes the query, which the event list and the delivery history read their filters from.
function Screen({ route, path, user }: { route: Route; path: string; user: User }) {
  switch (route.name) {
    case "home":
      return <HomeView client={client} />;
    case "events":
      return <EventsView client={client} path={path} />;
    case "event":
      return <EventDetailView client={client} id={route.id} />;
    case "sources":
      return <SourcesView client={client} />;
    case "source":
      return <SourceDetailView client={client} id={route.id} />;
    case "deliveries":
      return <DeliveriesView client={client} />;
    case "deliveryHistory":
      return <DeliveryHistoryView client={client} path={path} />;
    case "bots":
      return <BotsView client={client} />;
    case "conversations":
      return <ConversationsView client={client} />;
    case "conversation":
      return <ConversationDetailView client={client} id={route.id} />;
    case "users":
      return <UsersView client={client} currentUserId={user.id} />;
    case "notFound":
      return <RouteNotFound />;
  }
}

function RouteNotFound() {
  useDocumentTitle(`見つかりません - ${BRAND_NAME}`);
  return <NotFound message="ページが見つかりません" />;
}
