import { describe, expect, it } from "vitest";
import {
  INVALID_LABELS_MESSAGE,
  describeArguments,
  errorLabel,
  parseLabelLines,
  splitList,
  webhookDestinationRequest,
} from "./deliveries";

describe("splitList", () => {
  it("splits by commas, trims and drops empty items", () => {
    expect(splitList(" alert.observed, job.finished ,,")).toEqual(["alert.observed", "job.finished"]);
  });

  it.each(["", "   ", ", ,", ","])("is empty for %j", (value) => {
    expect(splitList(value)).toEqual([]);
  });
});

describe("parseLabelLines", () => {
  it("reads one key=value per line, trimming and skipping empty lines", () => {
    expect(parseLabelLines(" project = a \r\n\n  env=prod\n")).toEqual({ project: "a", env: "prod" });
  });

  it("splits at the first =", () => {
    expect(parseLabelLines("query=a=b")).toEqual({ query: "a=b" });
  });

  it("is empty for an empty field", () => {
    expect(parseLabelLines(" \n ")).toEqual({});
  });

  it("keeps __proto__ as an ordinary key", () => {
    const labels = parseLabelLines("__proto__=x");
    expect(labels === null ? null : Object.keys(labels)).toEqual(["__proto__"]);
  });

  it.each(["project", "=a", "project=", "project = ", "project=a\nproject=b"])("is null for %j", (value) => {
    expect(parseLabelLines(value)).toBeNull();
  });
});

describe("webhookDestinationRequest", () => {
  const empty = { name: "Grok Bot", url: "https://api2.example.com/hook", token: "crsr_x", types: "", sources: "", labels: "" };

  it("leaves out empty conditions", () => {
    expect(webhookDestinationRequest({ ...empty, types: ", ,", sources: " ", labels: "\n" })).toEqual({
      ok: true,
      value: { name: "Grok Bot", url: "https://api2.example.com/hook", token: "crsr_x" },
    });
  });

  it("converts the conditions", () => {
    expect(
      webhookDestinationRequest({ ...empty, types: "alert.observed, job.finished", sources: "app", labels: "project=a" }),
    ).toEqual({
      ok: true,
      value: {
        name: "Grok Bot",
        url: "https://api2.example.com/hook",
        token: "crsr_x",
        types: ["alert.observed", "job.finished"],
        sources: ["app"],
        labels: { project: "a" },
      },
    });
  });

  it("is not ok for invalid labels", () => {
    expect(webhookDestinationRequest({ ...empty, labels: "project" })).toEqual({ ok: false, message: INVALID_LABELS_MESSAGE });
  });
});

describe("error labels", () => {
  it("does not depend on the kind of destination", () => {
    expect(errorLabel("secret_unavailable")).toBe("鍵を読めませんでした");
    expect(errorLabel("subscription_inactive")).toBe("配信先が終了しています");
  });
});

describe("describeArguments", () => {
  it("describes every condition", () => {
    expect(describeArguments({ types: ["a"], sources: ["x"], labels: { k: "v" } })).toBe("種別: a / 送信元: x / ラベル: k=v");
    expect(describeArguments({})).toBe("すべてのイベント");
  });
});
