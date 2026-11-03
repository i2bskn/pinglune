import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "events" }
  | { name: "event"; id: string }
  | { name: "sources" }
  | { name: "source"; id: string }
  | { name: "users" }
  | { name: "deliveries" }
  | { name: "deliveryHistory" }
  | { name: "bots" }
  | { name: "botNew" }
  | { name: "bot"; id: string }
  | { name: "connections" }
  | { name: "conversations" }
  | { name: "conversation"; id: string }
  | { name: "notFound" };

// hc() puts params into the URL without encoding them, so IDs are limited to characters that cannot
// change the path (no "/", "." or "%"). Server IDs (UUIDs and prefixed ULIDs) always match.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Whether an ID may be put into a link or an API URL. Not decoded first.
export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

// path is the pathname followed by the search part, if any. The search part is ignored.
export function matchRoute(path: string): Route {
  const index = path.indexOf("?");
  const pathname = index === -1 ? path : path.slice(0, index);
  if (pathname === "/") return { name: "home" };
  if (pathname === "/events") return { name: "events" };
  if (pathname === "/users") return { name: "users" };
  if (pathname === "/sources") return { name: "sources" };
  if (pathname === "/deliveries") return { name: "deliveries" };
  if (pathname === "/deliveries/history") return { name: "deliveryHistory" };
  if (pathname === "/bots") return { name: "bots" };
  // Before /bots/:id, so that "new" is never taken as an ID.
  if (pathname === "/bots/new") return { name: "botNew" };
  if (pathname === "/connections") return { name: "connections" };
  if (pathname === "/conversations") return { name: "conversations" };
  const event = /^\/events\/([^/]+)$/.exec(pathname);
  if (event?.[1] !== undefined && isValidId(event[1])) return { name: "event", id: event[1] };
  const source = /^\/sources\/([^/]+)$/.exec(pathname);
  if (source?.[1] !== undefined && isValidId(source[1])) return { name: "source", id: source[1] };
  const bot = /^\/bots\/([^/]+)$/.exec(pathname);
  if (bot?.[1] !== undefined && isValidId(bot[1])) return { name: "bot", id: bot[1] };
  const conversation = /^\/conversations\/([^/]+)$/.exec(pathname);
  if (conversation?.[1] !== undefined && isValidId(conversation[1])) return { name: "conversation", id: conversation[1] };
  return { name: "notFound" };
}

// The query of a path (the part after "?"), empty without one.
export function searchParams(path: string): URLSearchParams {
  const index = path.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : path.slice(index + 1));
}

// Notified by navigate(); popstate covers the back and forward buttons.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

// Includes the search part, so that a change of the query alone renders again.
function getPath(): string {
  return location.pathname + location.search;
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, getPath);
}

// Moves to a path inside the SPA. The scroll position is not restored on back; that is left to the browser. replace
// takes the place of the current entry of the history (a screen that only moves on), so that back does not return to
// it.
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path !== getPath()) {
    if (options.replace === true) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
    for (const listener of listeners) listener();
  }
  window.scrollTo(0, 0);
}

export type ClickEvent = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

// Whether a click on a link is handled by the SPA. Other clicks (new tab, new window, download, a
// target attribute) are left to the browser.
export function shouldHandleClick(event: ClickEvent, target?: string): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    target === undefined
  );
}
