import type { ReactNode } from "react";

// Decorative icons drawn with the current text color. The text next to them names the thing, so screen
// readers skip them; an icon-only button gives itself an aria-label.
function Icon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      className={className === undefined ? "icon" : `icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function UsersIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
      <path d="M15.5 5.8a3 3 0 0 1 0 5.4M17 14.5c1.9.6 3.1 2.2 3.5 4.5" />
    </Icon>
  );
}

export function LogoutIcon() {
  return (
    <Icon>
      <path d="M14 4.5H6.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1H14" />
      <path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5" />
    </Icon>
  );
}

// Events: an inbox tray.
// Overview: a gauge of four tiles.
export function OverviewIcon() {
  return (
    <Icon>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="4.5" rx="1.5" />
      <rect x="13" y="11" width="7" height="9" rx="1.5" />
      <rect x="4" y="13.5" width="7" height="6.5" rx="1.5" />
    </Icon>
  );
}

export function EventsIcon() {
  return (
    <Icon>
      <path d="M4 13.5 6.2 5.6a1 1 0 0 1 1-.6h9.6a1 1 0 0 1 1 .6l2.2 7.9" />
      <path d="M4 13.5V18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4.5h-4.5a3.5 3.5 0 0 1-7 0z" />
    </Icon>
  );
}

// Sources: a plug.
export function SourcesIcon() {
  return (
    <Icon>
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16.5v4" />
    </Icon>
  );
}

// Deliveries: a paper plane.
export function DeliveriesIcon() {
  return (
    <Icon>
      <path d="M20.5 3.5 3.5 10.5l7 3 3 7z" />
      <path d="m20.5 3.5-10 10" />
    </Icon>
  );
}

// Delivery history: a clock.
export function HistoryIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  );
}

// Bots: a robot head.
export function BotsIcon() {
  return (
    <Icon>
      <rect x="4.5" y="8" width="15" height="11" rx="2.5" />
      <path d="M12 4.5V8M9.5 13h.01M14.5 13h.01M2.5 12.5v2M21.5 12.5v2" />
    </Icon>
  );
}

// Conversations: two speech bubbles.
export function ConversationsIcon() {
  return (
    <Icon>
      <path d="M14.5 9.5V6a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 6v5A1.5 1.5 0 0 0 5 12.5h1v3l3-3h1" />
      <path d="M10 11a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v4.5a1.5 1.5 0 0 1-1.5 1.5H18v2.5L15.5 17h-4a1.5 1.5 0 0 1-1.5-1.5z" />
    </Icon>
  );
}

export function MenuIcon() {
  return (
    <Icon>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}
