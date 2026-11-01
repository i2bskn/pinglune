import type { MouseEvent, ReactNode } from "react";
import { navigate, shouldHandleClick } from "./router";

// A link to a path inside the SPA, moved to without reloading the page.
export function Link({
  to,
  className,
  title,
  "aria-current": ariaCurrent,
  children,
}: {
  to: string;
  className?: string;
  title?: string;
  "aria-current"?: "page" | "location";
  children: ReactNode;
}) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!shouldHandleClick(event, event.currentTarget.getAttribute("target") ?? undefined)) return;
    event.preventDefault();
    navigate(to);
  }

  return (
    <a href={to} className={className} title={title} aria-current={ariaCurrent} onClick={onClick}>
      {children}
    </a>
  );
}
