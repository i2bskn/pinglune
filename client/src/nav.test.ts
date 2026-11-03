import { describe, expect, it } from "vitest";
import { ariaCurrentFor, currentNavItem, navGroupsFor } from "./nav";
import type { Route } from "./router";

describe("navGroupsFor", () => {
  it("leaves out the settings group for members", () => {
    const groups = navGroupsFor("member");
    expect(groups.map((group) => group.label)).toEqual(["受信", "配信"]);
    expect(groups.flatMap((group) => group.items.map((item) => item.id))).not.toContain("users");
  });

  it("shows the settings group to admins", () => {
    const groups = navGroupsFor("admin");
    expect(groups.map((group) => group.label)).toEqual(["受信", "配信", "設定"]);
    expect(groups.at(-1)?.items.map((item) => item.id)).toEqual(["users"]);
  });
});

describe("currentNavItem", () => {
  it.each<[Route, ReturnType<typeof currentNavItem>]>([
    [{ name: "home" }, "events"],
    [{ name: "event", id: "evt_1" }, "events"],
    [{ name: "sources" }, "sources"],
    [{ name: "source", id: "src_1" }, "sources"],
    [{ name: "deliveries" }, "deliveries"],
    [{ name: "bots" }, "bots"],
    [{ name: "conversations" }, "conversations"],
    [{ name: "conversation", id: "cnv_1" }, "conversations"],
    [{ name: "users" }, "users"],
    [{ name: "notFound" }, null],
  ])("maps %o", (route, expected) => {
    expect(currentNavItem(route)).toBe(expected);
  });
});

describe("ariaCurrentFor", () => {
  it("is page on the top screen of the item", () => {
    expect(ariaCurrentFor({ name: "home" }, "events")).toBe("page");
    expect(ariaCurrentFor({ name: "conversations" }, "conversations")).toBe("page");
    expect(ariaCurrentFor({ name: "users" }, "users")).toBe("page");
  });

  it("is location on a screen inside the item", () => {
    expect(ariaCurrentFor({ name: "event", id: "evt_1" }, "events")).toBe("location");
    expect(ariaCurrentFor({ name: "source", id: "src_1" }, "sources")).toBe("location");
    expect(ariaCurrentFor({ name: "conversation", id: "cnv_1" }, "conversations")).toBe("location");
  });

  it("is undefined for other items and on the not found screen", () => {
    expect(ariaCurrentFor({ name: "home" }, "sources")).toBeUndefined();
    expect(ariaCurrentFor({ name: "event", id: "evt_1" }, "conversations")).toBeUndefined();
    for (const item of ["events", "sources", "deliveries", "bots", "conversations", "users"] as const) {
      expect(ariaCurrentFor({ name: "notFound" }, item)).toBeUndefined();
    }
  });
});
