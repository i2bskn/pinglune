import { describe, expect, it } from "vitest";
import type { Bot, Source } from "../../src/api/types";
import { buildFlow, edgePath, relatedIds } from "./flow";

function source(id: string, name: string, enabled = true): Source {
  return { id, name, enabled, created_at: 1, updated_at: 1, active_key_count: 0 };
}

const ACTIVE_HOOK: Bot["delivery"] = {
  subscription_id: "sub_1",
  name: "grok",
  callback_host: "api.example.com",
  status: "active",
};

const CONNECTION: Bot["connection"] = { id: "c1", client_name: "ChatGPT", redirect_host: "chatgpt.com", created_at: 1 };

function bot(id: string, name: string, sources: Source[], overrides: Partial<Bot> = {}): Bot {
  return {
    id,
    name,
    delivery_kind: "webhook",
    delivery: ACTIVE_HOOK,
    connection: null,
    status: "ready",
    sources: sources.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled })),
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("buildFlow", () => {
  it("is empty for no sources and no bots", () => {
    expect(buildFlow([], [])).toEqual({ sources: [], bots: [], edges: [] });
  });

  it("orders the sources by their top bot, then by name and ID, with the unlinked ones last", () => {
    const a = source("s1", "a");
    const b = source("s2", "b");
    const c = source("s3", "c");
    const z = source("s4", "z");
    const y1 = source("s6", "y");
    const y0 = source("s5", "y");
    const free = source("s7", "free");
    // The API lists the sources in the order they were made.
    const model = buildFlow([free, c, b, a, z, y1, y0], [bot("b1", "Alpha", [z]), bot("b2", "Beta", [c, a, z])]);
    expect(model.sources.map((s) => s.name)).toEqual(["z", "a", "c", "b", "free", "y", "y"]);
    expect(model.sources.slice(-2).map((s) => s.sourceId)).toEqual(["s5", "s6"]);
    expect(model.bots.map((x) => x.name)).toEqual(["Alpha", "Beta"]);
  });

  it("compares the names by code unit", () => {
    const model = buildFlow([source("s1", "b"), source("s2", "B"), source("s3", "a")], []);
    expect(model.sources.map((s) => s.name)).toEqual(["B", "a", "b"]);
  });

  it("draws an edge from each source of a bot and one to its destination", () => {
    const a = source("s1", "a");
    const b = source("s2", "b", false);
    const model = buildFlow([a, b], [bot("b1", "Dot", [a, b])]);
    expect(model.edges).toEqual([
      { id: "source:s1->bot:b1", from: "source:s1", to: "bot:b1", dashed: false },
      { id: "source:s2->bot:b1", from: "source:s2", to: "bot:b1", dashed: true },
      { id: "bot:b1->delivery:b1", from: "bot:b1", to: "delivery:b1", dashed: false },
    ]);
  });

  it("leaves out the sources of a bot that are not in the list", () => {
    const a = source("s1", "a");
    const model = buildFlow([a], [bot("b1", "Dot", [a, source("gone", "gone")])]);
    expect(model.bots[0]?.sources.map((s) => s.sourceId)).toEqual(["s1"]);
    expect(model.edges.map((e) => e.id)).toEqual(["source:s1->bot:b1", "bot:b1->delivery:b1"]);
  });

  it("marks disabled and unlinked sources", () => {
    const off = source("s1", "off", false);
    const free = source("s2", "free");
    const both = source("s3", "both", false);
    const model = buildFlow([off, free, both], [bot("b1", "Dot", [off])]);
    expect(model.sources).toEqual([
      { id: "source:s1", sourceId: "s1", name: "off", enabled: false, linked: true, badges: [{ label: "無効", tone: "off" }] },
      {
        id: "source:s3",
        sourceId: "s3",
        name: "both",
        enabled: false,
        linked: false,
        badges: [
          { label: "無効", tone: "off" },
          { label: "どの Bot にも届きません", tone: "error" },
        ],
      },
      {
        id: "source:s2",
        sourceId: "s2",
        name: "free",
        enabled: true,
        linked: false,
        badges: [{ label: "どの Bot にも届きません", tone: "error" }],
      },
    ]);
  });

  it("marks a bot without sources", () => {
    const model = buildFlow([], [bot("b1", "Dot", [])]);
    expect(model.bots[0]?.badges).toEqual([{ label: "送信元なし", tone: "error" }]);
    expect(model.bots[0]?.description).toBe("受け取る送信元: なし。配信先: Webhook grok");
  });

  it("describes the sources and the destination of a bot", () => {
    const a = source("s1", "a");
    const b = source("s2", "b", false);
    const model = buildFlow([a, b], [bot("b1", "Dot", [a, b])]);
    expect(model.bots[0]?.badges).toEqual([]);
    expect(model.bots[0]?.description).toBe("受け取る送信元: a, b（無効）。配信先: Webhook grok");
  });

  describe("the destination", () => {
    function delivery(overrides: Partial<Bot>) {
      return buildFlow([], [bot("b1", "Dot", [], overrides)]).bots[0]?.delivery;
    }

    it("is 接続なし for an mcp bot without a connection", () => {
      expect(delivery({ delivery_kind: "mcp", delivery: null, connection: null })).toEqual({
        id: "delivery:b1",
        kind: "mcp",
        kindLabel: "MCP Event",
        primary: null,
        note: "AI から接続するとき、この Bot を選んでください",
        badge: "接続なし",
      });
      expect(buildFlow([], [bot("b1", "Dot", [], { delivery_kind: "mcp", delivery: null })]).bots[0]?.description).toBe(
        "受け取る送信元: なし。配信先: MCP Event 接続なし",
      );
    });

    it("is 購読なし for an mcp bot whose connection has no active subscription", () => {
      const expected = {
        id: "delivery:b1",
        kind: "mcp",
        kindLabel: "MCP Event",
        primary: "ChatGPT",
        note: "AI が購読すると届きます",
        badge: "購読なし",
      };
      expect(delivery({ delivery_kind: "mcp", delivery: null, connection: CONNECTION })).toEqual(expected);
      expect(
        delivery({ delivery_kind: "mcp", delivery: { ...ACTIVE_HOOK, status: "expired" }, connection: CONNECTION }),
      ).toEqual(expected);
    });

    it("shows the app of the connection for an mcp bot with an active subscription", () => {
      expect(
        delivery({
          delivery_kind: "mcp",
          delivery: { subscription_id: "sub_1", name: null, callback_host: null, status: "active" },
          connection: CONNECTION,
        }),
      ).toEqual({ id: "delivery:b1", kind: "mcp", kindLabel: "MCP Event", primary: "ChatGPT", note: null, badge: null });
    });

    it("shows the name and the host of an active webhook", () => {
      expect(delivery({})).toEqual({
        id: "delivery:b1",
        kind: "webhook",
        kindLabel: "Webhook",
        primary: "grok",
        note: "api.example.com",
        badge: null,
      });
      expect(delivery({ delivery: { ...ACTIVE_HOOK, name: null, callback_host: null } })).toMatchObject({
        primary: "（名前なし）",
        note: null,
      });
    });

    it("shows the name of an active queue without a note", () => {
      expect(
        delivery({ delivery_kind: "queue", delivery: { ...ACTIVE_HOOK, name: "muse", callback_host: null } }),
      ).toEqual({ id: "delivery:b1", kind: "queue", kindLabel: "キュー", primary: "muse", note: null, badge: null });
    });

    it("is 配信先なし for a webhook or queue bot without an active destination", () => {
      for (const kind of ["webhook", "queue"] as const) {
        expect(delivery({ delivery_kind: kind, delivery: null })).toMatchObject({
          primary: "なし",
          note: null,
          badge: "配信先なし",
        });
        expect(delivery({ delivery_kind: kind, delivery: { ...ACTIVE_HOOK, status: "unsubscribed" } })).toMatchObject({
          primary: "なし",
          badge: "配信先なし",
        });
      }
    });

    it("dashes the line to a destination that events do not reach", () => {
      const model = buildFlow([], [bot("b1", "Dot", [], { delivery: null })]);
      expect(model.edges).toEqual([{ id: "bot:b1->delivery:b1", from: "bot:b1", to: "delivery:b1", dashed: true }]);
    });
  });
});

describe("edgePath", () => {
  it("curves from the right middle of one card to the left middle of the other, relative to the origin", () => {
    const origin = { left: 100, top: 50, width: 800, height: 600 };
    const from = { left: 110, top: 60, width: 200, height: 40 };
    const to = { left: 350, top: 160, width: 200, height: 60 };
    // From (210, 30) to (250, 140).
    expect(edgePath(from, to, origin)).toBe("M 210 30 C 230 30, 230 140, 250 140");
  });

  it("rounds to two decimals", () => {
    const origin = { left: 0, top: 0, width: 100, height: 100 };
    const from = { left: 0, top: 0, width: 10.3333, height: 1 };
    const to = { left: 20.01, top: 0, width: 10, height: 1 };
    expect(edgePath(from, to, origin)).toBe("M 10.33 0.5 C 15.17 0.5, 15.17 0.5, 20.01 0.5");
  });
});

describe("relatedIds", () => {
  const a = source("s1", "a");
  const b = source("s2", "b");
  const free = source("s3", "free");
  const model = buildFlow([a, b, free], [bot("b1", "Alpha", [a]), bot("b2", "Beta", [a, b])]);

  it("is empty when nothing is focused or the node is unknown", () => {
    expect(relatedIds(model, null)).toEqual(new Set());
    expect(relatedIds(model, "bot:none")).toEqual(new Set());
  });

  it("follows a source to its bots and their destinations", () => {
    expect(relatedIds(model, "source:s1")).toEqual(
      new Set([
        "source:s1",
        "source:s1->bot:b1",
        "bot:b1",
        "bot:b1->delivery:b1",
        "delivery:b1",
        "source:s1->bot:b2",
        "bot:b2",
        "bot:b2->delivery:b2",
        "delivery:b2",
      ]),
    );
  });

  it("is only the source itself when no bot receives it", () => {
    expect(relatedIds(model, "source:s3")).toEqual(new Set(["source:s3"]));
  });

  it("takes the sources and the destination of a bot", () => {
    const expected = new Set([
      "bot:b2",
      "bot:b2->delivery:b2",
      "delivery:b2",
      "source:s1",
      "source:s1->bot:b2",
      "source:s2",
      "source:s2->bot:b2",
    ]);
    expect(relatedIds(model, "bot:b2")).toEqual(expected);
    // A destination leads back to its bot and the bot's sources.
    expect(relatedIds(model, "delivery:b2")).toEqual(expected);
  });
});
