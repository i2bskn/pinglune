import type { User } from "../../src/api/types";
import { BRAND_NAME } from "../../src/brand";
import { createApiClient, createApiFetch, unexpectedResponseMessage } from "./api";
import { BrandLogo } from "./brand";
import { LogoutIcon, UsersIcon } from "./icons";
import { Link } from "./Link";
import { loadMe, useView } from "./load";
import { type Route, matchRoute, usePath } from "./router";
import { markLeaving } from "./unload";
import { LoadError, Menu, NotFound, useDocumentTitle } from "./views/common";
import { DeliveriesView } from "./views/DeliveriesView";
import { ErrorBoundary } from "./views/ErrorBoundary";
import { EventDetailView } from "./views/EventDetailView";
import { HomeView } from "./views/HomeView";
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
        <>
          <Header user={me.data} path={path} route={route} />
          <div className="layout">
            <div className="layout-screen">
              <ErrorBoundary key={path}>
                <Screen route={route} user={me.data} />
              </ErrorBoundary>
            </div>
          </div>
        </>
      );
  }
}

function Screen({ route, user }: { route: Route; user: User }) {
  switch (route.name) {
    case "home":
      return <HomeView client={client} />;
    case "event":
      return <EventDetailView client={client} id={route.id} />;
    case "sources":
      return <SourcesView client={client} />;
    case "source":
      return <SourceDetailView client={client} id={route.id} />;
    case "deliveries":
      return <DeliveriesView client={client} />;
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

// The section of the navigation a screen belongs to.
function section(route: Route): "events" | "sources" | "deliveries" | null {
  switch (route.name) {
    case "home":
    case "event":
      return "events";
    case "sources":
    case "source":
      return "sources";
    case "deliveries":
      return "deliveries";
    case "users":
    case "notFound":
      return null;
  }
}

function Header({ user, path, route }: { user: User; path: string; route: Route }) {
  const name = user.name ?? user.email;
  const current = section(route);
  // "page" on the top screen of a section, "location" on a screen inside it.
  const ariaCurrent = (to: "events" | "sources" | "deliveries", top: Route["name"]) =>
    current !== to ? undefined : route.name === top ? ("page" as const) : ("location" as const);
  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="brand">
          <BrandLogo />
          <span className="sr-only">{BRAND_NAME}</span>
        </Link>
        <nav className="nav" aria-label="メイン">
          <Link to="/" className="nav-link" aria-current={ariaCurrent("events", "home")}>
            イベント
          </Link>
          <Link to="/sources" className="nav-link" aria-current={ariaCurrent("sources", "sources")}>
            送信元
          </Link>
          <Link to="/deliveries" className="nav-link" aria-current={ariaCurrent("deliveries", "deliveries")}>
            配信
          </Link>
        </nav>
        {/* Keyed by the path, so that it is closed again on every screen. */}
        <Menu
          key={path}
          className="account-menu"
          label={`アカウント: ${name}`}
          summary={
            <>
              <span className="avatar" aria-hidden="true">
                {Array.from(name)[0]?.toUpperCase()}
              </span>
              <span className="account-name">{name}</span>
            </>
          }
        >
          <div className="account-card">
            <span className="account-card-name">{name}</span>
            {user.name !== null && <span className="account-card-email">{user.email}</span>}
            <span className="account-card-role">{user.role === "admin" ? "管理者" : "一般"}</span>
          </div>
          {/* Shown only to admins; the server checks it again. */}
          {user.role === "admin" && (
            <Link to="/users" className="menu-item">
              <UsersIcon />
              ユーザー管理
            </Link>
          )}
          <form method="post" action="/auth/logout">
            <button type="submit" className="menu-item">
              <LogoutIcon />
              ログアウト
            </button>
          </form>
        </Menu>
      </div>
    </header>
  );
}
