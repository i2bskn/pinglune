import type { User } from "../../src/api/types";
import type { Route } from "./router";

// The items of the main navigation. No JSX here, so that the tests can load it in Node; the icons are mapped in
// views/Sidebar.tsx.
export type NavItemId = "events" | "sources" | "deliveries" | "bots" | "conversations" | "users";

export type NavItem = {
  id: NavItemId;
  label: string;
  to: string;
  // Shown only to admins; the server checks it again.
  adminOnly?: boolean;
};

export type NavGroup = {
  id: string;
  label: string;
  items: readonly NavItem[];
};

// In the order they are shown.
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "intake",
    label: "受信",
    items: [
      { id: "events", label: "イベント", to: "/" },
      { id: "sources", label: "送信元", to: "/sources" },
    ],
  },
  {
    id: "delivery",
    label: "配信",
    items: [
      { id: "deliveries", label: "配信", to: "/deliveries" },
      { id: "bots", label: "Bot", to: "/bots" },
      { id: "conversations", label: "会話", to: "/conversations" },
    ],
  },
  {
    id: "settings",
    label: "設定",
    items: [{ id: "users", label: "ユーザー", to: "/users", adminOnly: true }],
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
    case "event":
      return "events";
    case "sources":
    case "source":
      return "sources";
    case "deliveries":
      return "deliveries";
    case "bots":
      return "bots";
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
  events: "home",
  sources: "sources",
  deliveries: "deliveries",
  bots: "bots",
  conversations: "conversations",
  users: "users",
};

// "page" on the top screen of an item, "location" on a screen inside it, and nothing elsewhere.
export function ariaCurrentFor(route: Route, item: NavItemId): "page" | "location" | undefined {
  if (currentNavItem(route) !== item) return undefined;
  return route.name === TOP_SCREEN[item] ? "page" : "location";
}
