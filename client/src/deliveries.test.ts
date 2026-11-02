import { describe, expect, it } from "vitest";
import type { Delivery } from "../../src/api/types";
import {
  INVALID_LABELS_MESSAGE,
  attemptsLabel,
  deliveryDestination,
  deliveryStatusLabel,
  describeArguments,
  errorLabel,
  lastResult,
  parseLabelLines,
  queueRequest,
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

describe("queueRequest", () => {
  const empty = { name: "Muse", types: "", sources: "", labels: "" };

  it("leaves out empty conditions", () => {
    expect(queueRequest({ ...empty, types: " , ", labels: "\n" })).toEqual({ ok: true, value: { name: "Muse" } });
  });

  it("converts the conditions", () => {
    expect(queueRequest({ ...empty, types: "alert.observed", sources: "app, job", labels: "project=a" })).toEqual({
      ok: true,
      value: { name: "Muse", types: ["alert.observed"], sources: ["app", "job"], labels: { project: "a" } },
    });
  });

  it("is not ok for invalid labels", () => {
    expect(queueRequest({ ...empty, labels: "project" })).toEqual({ ok: false, message: INVALID_LABELS_MESSAGE });
  });
});

describe("the display of a delivery", () => {
  const WEBHOOK: Delivery = {
    id: "dlv_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
    event_id: "evt_01JC9Z7H2K4M6N8P0Q2R4S6T8V",
    subscription_id: "sub_0123456789abcdef0123456789abcdef",
    callback_host: "hooks.example.com",
    destination_kind: "webhook",
    destination_name: "Grok Bot",
    status: "delivered",
    attempts: 2,
    last_attempt_at: 1,
    last_http_status: 204,
    last_error: null,
    delivered_at: 1,
    created_at: 1,
  };
  const QUEUE: Delivery = {
    ...WEBHOOK,
    callback_host: null,
    destination_kind: "queue",
    destination_name: "Muse",
    status: "pending",
    attempts: 1,
    last_http_status: null,
    delivered_at: null,
  };

  it("shows a webhook delivery by its host, with the HTTP status", () => {
    expect(deliveryDestination(WEBHOOK)).toBe("hooks.example.com");
    expect(deliveryDestination({ ...WEBHOOK, callback_host: null })).toBe("不明な宛先");
    expect(deliveryStatusLabel(WEBHOOK)).toBe("配信済み");
    expect(attemptsLabel(WEBHOOK)).toBe("試行 2 回");
    expect(lastResult(WEBHOOK)).toBe("成功（HTTP 204）");
  });

  it("shows a queue delivery by the queue's name, counting the times it was taken", () => {
    expect(deliveryDestination(QUEUE)).toBe("キュー: Muse");
    expect(deliveryDestination({ ...QUEUE, destination_name: null })).toBe("キュー");
    expect(deliveryStatusLabel(QUEUE)).toBe("取得待ち");
    expect(attemptsLabel(QUEUE)).toBe("取得 1 回");
    expect(lastResult(QUEUE)).toBeNull();
  });

  it("shows a processed or failed queue delivery without an HTTP status", () => {
    const processed: Delivery = { ...QUEUE, status: "delivered", delivered_at: 2 };
    expect(deliveryStatusLabel(processed)).toBe("処理済み");
    expect(lastResult(processed)).toBe("処理済み");
    const failed: Delivery = { ...QUEUE, status: "failed", attempts: 5, last_error: "not_acknowledged" };
    expect(deliveryStatusLabel(failed)).toBe("失敗");
    expect(lastResult(failed)).toBe("処理済みの連絡がないまま 5 回取得された");
    expect(lastResult({ ...failed, last_error: "expired" })).toBe("7 日間処理されなかった");
  });
});
