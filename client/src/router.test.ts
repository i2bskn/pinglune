import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClickEvent, matchRoute, navigate, shouldHandleClick } from "./router";

describe("matchRoute", () => {
  it("matches the screens", () => {
    expect(matchRoute("/")).toEqual({ name: "home" });
  });

  it("matches the users screen exactly", () => {
    expect(matchRoute("/users")).toEqual({ name: "users" });
    expect(matchRoute("/users?a=1")).toEqual({ name: "users" });
    expect(matchRoute("/users/")).toEqual({ name: "notFound" });
    expect(matchRoute("/users/abc")).toEqual({ name: "notFound" });
  });

  it("matches the events and sources screens", () => {
    const eventId = "evt_01JC9Z8Q4R6T2V7W3X5Y1A0B2C";
    const sourceId = "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V";
    expect(matchRoute(`/events/${eventId}`)).toEqual({ name: "event", id: eventId });
    expect(matchRoute(`/events/${eventId}?x=1`)).toEqual({ name: "event", id: eventId });
    expect(matchRoute("/sources")).toEqual({ name: "sources" });
    expect(matchRoute("/sources?x=1")).toEqual({ name: "sources" });
    expect(matchRoute("/deliveries")).toEqual({ name: "deliveries" });
    expect(matchRoute("/deliveries?x=1")).toEqual({ name: "deliveries" });
    expect(matchRoute("/deliveries/")).toEqual({ name: "notFound" });
    expect(matchRoute(`/sources/${sourceId}`)).toEqual({ name: "source", id: sourceId });
  });

  it("matches the bots screen", () => {
    expect(matchRoute("/bots")).toEqual({ name: "bots" });
    expect(matchRoute("/bots?x=1")).toEqual({ name: "bots" });
    expect(matchRoute("/bots/")).toEqual({ name: "notFound" });
  });

  it("matches the conversations screens", () => {
    const id = "cnv_01JC9Z8Q4R6T2V7W3X5Y1A0B2C";
    expect(matchRoute("/conversations")).toEqual({ name: "conversations" });
    expect(matchRoute("/conversations?x=1")).toEqual({ name: "conversations" });
    expect(matchRoute(`/conversations/${id}`)).toEqual({ name: "conversation", id });
    expect(matchRoute("/conversations/")).toEqual({ name: "notFound" });
    expect(matchRoute("/conversations/a/b")).toEqual({ name: "notFound" });
    expect(matchRoute("/conversations/a.b")).toEqual({ name: "notFound" });
  });

  it.each([
    "/events",
    "/events/",
    "/events/a/b",
    "/events/a.b",
    "/events/%2e%2e",
    `/events/${"a".repeat(65)}`,
    "/sources/",
    "/sources/a/api-keys",
    "/sources/a%2Fb",
  ])("does not match the invalid path %s", (path) => {
    expect(matchRoute(path)).toEqual({ name: "notFound" });
  });

  it("ignores the search part on other screens", () => {
    expect(matchRoute("/?q=a")).toEqual({ name: "home" });
  });

  it.each(["/spaces/", "/spaces/abc/", "/spaces/abc/x", "//spaces/abc", "/pages", "/folders", "/folders/", "/unknown"])(
    "does not match %s",
    (path) => {
      expect(matchRoute(path)).toEqual({ name: "notFound" });
    },
  );
});

describe("navigate", () => {
  // navigate() reads location and calls history and window, which Node does not have.
  function stubBrowser(path: string) {
    const pushState = vi.fn();
    const scrollTo = vi.fn();
    vi.stubGlobal("location", { pathname: path, search: "" });
    vi.stubGlobal("history", { pushState });
    vi.stubGlobal("window", { scrollTo });
    return { pushState, scrollTo };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves to another path", () => {
    const { pushState } = stubBrowser("/a");
    navigate("/b");
    expect(pushState).toHaveBeenCalledWith(null, "", "/b");
  });
});

describe("shouldHandleClick", () => {
  const click: ClickEvent = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };

  it("handles a plain left click", () => {
    expect(shouldHandleClick(click)).toBe(true);
  });

  it("leaves a click whose default is prevented", () => {
    expect(shouldHandleClick({ ...click, defaultPrevented: true })).toBe(false);
  });

  it("leaves a middle click", () => {
    expect(shouldHandleClick({ ...click, button: 1 })).toBe(false);
  });

  it.each(["metaKey", "ctrlKey", "shiftKey", "altKey"] as const)("leaves a click with %s", (key) => {
    expect(shouldHandleClick({ ...click, [key]: true })).toBe(false);
  });

  it("leaves a link with a target", () => {
    expect(shouldHandleClick(click, "_blank")).toBe(false);
  });
});
