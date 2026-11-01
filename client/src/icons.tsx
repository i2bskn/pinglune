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
