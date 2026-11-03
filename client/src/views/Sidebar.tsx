import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { User } from "../../../src/api/types";
import { BRAND_NAME } from "../../../src/brand";
import { BrandLogo } from "../brand";
import {
  BotsIcon,
  CloseIcon,
  ConnectionsIcon,
  ConversationsIcon,
  EventsIcon,
  HistoryIcon,
  LogoutIcon,
  MenuIcon,
  OverviewIcon,
  SourcesIcon,
  UsersIcon,
} from "../icons";
import { Link } from "../Link";
import { type NavItemId, ariaCurrentFor, navGroupsFor } from "../nav";
import type { Route } from "../router";

// Wide screens show the sidebar; narrow ones show a top bar whose button opens the same content in a drawer.
// Keep in sync with the (width >= 900px) and (width < 900px) rules in styles.css.
const WIDE_QUERY = "(width >= 900px)";

const ICONS: Record<NavItemId, () => ReactNode> = {
  overview: OverviewIcon,
  events: EventsIcon,
  sources: SourcesIcon,
  deliveryHistory: HistoryIcon,
  bots: BotsIcon,
  conversations: ConversationsIcon,
  connections: ConnectionsIcon,
  users: UsersIcon,
};

// The frame around every screen once the signed-in user is known.
export function AppShell({
  user,
  route,
  path,
  children,
}: {
  user: User;
  route: Route;
  path: string;
  children: ReactNode;
}) {
  const drawerId = useId();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // Set when the drawer is closed because the screen became wide: the menu button is hidden then, so the focus is
  // left alone.
  const closedByWidth = useRef(false);
  const lastPath = useRef(path);

  // The content is rendered once open is set; the dialog is shown after that, with the focus on the close button.
  // The page behind it does not scroll while it is open.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    closeButtonRef.current?.focus();
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [open]);

  // Closed after a move to another screen, including the browser's back and forward buttons.
  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    if (dialogRef.current?.open) dialogRef.current.close();
  }, [path]);

  // Closed when the screen becomes wide enough for the sidebar.
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    function onChange() {
      const dialog = dialogRef.current;
      if (!query.matches || !dialog?.open) return;
      closedByWidth.current = true;
      dialog.close();
    }
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Fired for every way of closing: the close button, Escape, the backdrop, a link, a move and the width. Clearing
  // open removes the content and, through the effect above, gives the page its scrolling back.
  function onClose() {
    setOpen(false);
    if (closedByWidth.current) {
      closedByWidth.current = false;
      return;
    }
    menuButtonRef.current?.focus();
  }

  // The content covers the whole dialog, so a click on the dialog itself is a click on the backdrop.
  function onDialogClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }

  // A link chosen in the drawer closes it, even one to the screen already shown.
  function onContentClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("a") !== null) dialogRef.current?.close();
  }

  return (
    <div className="app-shell">
      <div className="sidebar">
        <SidebarContent user={user} route={route} />
      </div>
      <div className="app-main">
        <header className="topbar">
          <button
            ref={menuButtonRef}
            type="button"
            className="topbar-button"
            aria-label="メニュー"
            aria-expanded={open}
            aria-controls={drawerId}
            onClick={() => setOpen(true)}
          >
            <MenuIcon />
          </button>
          <Link to="/" className="brand">
            <BrandLogo />
            <span className="sr-only">{BRAND_NAME}</span>
          </Link>
        </header>
        {children}
      </div>
      {/* Shown in the top layer by showModal(), which also traps the focus and closes on Escape. */}
      <dialog ref={dialogRef} id={drawerId} className="drawer" aria-label="メニュー" onClose={onClose} onClick={onDialogClick}>
        {open && (
          <div className="drawer-content" onClick={onContentClick}>
            <button
              ref={closeButtonRef}
              type="button"
              className="drawer-close"
              aria-label="メニューを閉じる"
              onClick={() => dialogRef.current?.close()}
            >
              <CloseIcon />
            </button>
            <SidebarContent user={user} route={route} />
          </div>
        )}
      </dialog>
    </div>
  );
}

// The logo, the sections grouped, and the account at the bottom. Rendered in the sidebar and in the drawer, so the
// IDs come from useId.
function SidebarContent({ user, route }: { user: User; route: Route }) {
  const baseId = useId();
  const name = user.name ?? user.email;
  return (
    <div className="sidebar-content">
      <Link to="/" className="brand">
        <BrandLogo />
        <span className="sr-only">{BRAND_NAME}</span>
      </Link>
      <nav className="nav" aria-label="メイン">
        {navGroupsFor(user.role).map((group) => {
          // Not a heading: the screen's h1 comes after the navigation.
          const labelId = `${baseId}-${group.id}`;
          return (
            <div key={group.id} className="nav-group">
              {group.label !== null && (
                <p className="nav-group-label" id={labelId}>
                  {group.label}
                </p>
              )}
              <ul className="nav-list" aria-labelledby={group.label !== null ? labelId : undefined}>
                {group.items.map((item) => {
                  const ItemIcon = ICONS[item.id];
                  return (
                    <li key={item.id}>
                      <Link to={item.to} className="nav-link" aria-current={ariaCurrentFor(route, item.id)}>
                        <ItemIcon />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="account">
        <div className="account-card">
          <span className="avatar" aria-hidden="true">
            {Array.from(name)[0]?.toUpperCase()}
          </span>
          <div className="account-card-text">
            <span className="account-card-name">{name}</span>
            {user.name !== null && <span className="account-card-email">{user.email}</span>}
            <span className="account-card-role">{user.role === "admin" ? "管理者" : "一般"}</span>
          </div>
        </div>
        <form method="post" action="/auth/logout">
          <button type="submit" className="menu-item">
            <LogoutIcon />
            ログアウト
          </button>
        </form>
      </div>
    </div>
  );
}
