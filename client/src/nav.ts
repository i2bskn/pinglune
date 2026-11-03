import type { User } from "../../src/api/types";
import type { Route } from "./router";

// The items of the main navigation. No JSX here, so that the tests can load it in Node; the icons are mapped in
// views/Sidebar.tsx.
export type NavItemId =
  | "overview"
  | "events"
  | "sources"
  | "deliveryHistory"
  | "bots"
  | "conversations"
  | "connections"
  | "users";

export type NavItem = {
  id: NavItemId;
  label: string;
  to: string;
  // Shown only to admins; the server checks it again.
  adminOnly?: boolean;
};

export type NavGroup = {
  id: string;
  // null: the group is shown without a label (the overview at the top).
  label: string | null;
  items: readonly NavItem[];
};

// In the order they are shown.
// The groups follow the way events go: received from sources, then relayed by bots to their destinations.
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "home",
    label: null,
    items: [{ id: "overview", label: "概要", to: "/" }],
  },
  {
    id: "intake",
    label: "受信",
    items: [
      { id: "events", label: "イベント", to: "/events" },
      { id: "sources", label: "送信元", to: "/sources" },
    ],
  },
  {
    id: "delivery",
    label: "配信",
    items: [
      { id: "bots", label: "Bot", to: "/bots" },
      { id: "deliveryHistory", label: "配信履歴", to: "/deliveries/history" },
      { id: "conversations", label: "会話", to: "/conversations" },
    ],
  },
  {
    id: "settings",
    label: "設定",
    items: [
      { id: "connections", label: "AI の接続", to: "/connections" },
      { id: "users", label: "ユーザー", to: "/users", adminOnly: true },
    ],
  },
];

// The groups a user sees: admin-only items are left out for members, and so are groups left with no items.
export function navGroupsFor(role: User["role"]): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => role === "admin" || item.adminOnly !== true),
  })).filter((group) => group.items.length > 0);
}

// The item a screen belongs to.
export function currentNavItem(route: Route): NavItemId | null {
  switch (route.name) {
    case "home":
      return "overview";
    case "events":
    case "event":
      return "events";
    case "sources":
    case "source":
      return "sources";
    // The former destinations screen moves on to the bots.
    case "deliveries":
    case "bots":
    case "botNew":
    case "bot":
      return "bots";
    case "deliveryHistory":
      return "deliveryHistory";
    case "connections":
      return "connections";
    case "conversations":
    case "conversation":
      return "conversations";
    case "users":
      return "users";
    case "notFound":
      return null;
  }
}

// The top screen of each item.
const TOP_SCREEN: Record<NavItemId, Route["name"]> = {
  overview: "home",
  events: "events",
  sources: "sources",
  deliveryHistory: "deliveryHistory",
  bots: "bots",
  conversations: "conversations",
  connections: "connections",
  users: "users",
};

// "page" on the top screen of an item, "location" on a screen inside it, and nothing elsewhere.
export function ariaCurrentFor(route: Route, item: NavItemId): "page" | "location" | undefined {
  if (currentNavItem(route) !== item) return undefined;
  return route.name === TOP_SCREEN[item] ? "page" : "location";
}
