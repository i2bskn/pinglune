import { describe, expect, it } from "vitest";
import type { Delivery, Subscription } from "../../src/api/types";
import {
  INVALID_LABELS_MESSAGE,
  attemptsLabel,
  canRetry,
  noRetryReason,
  deliveryDestination,
  deliveryHistoryPath,
  deliveryStatusLabel,
  describeArguments,
  destinationLabel,
  errorLabel,
  lastResult,
  parseLabelLines,
  queueRequest,
  splitList,
  statusFilterOf,
  subscriptionBotLabel,
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
  const empty = { name: "Grok Bot", url: "https://api2.example.com/hook", token: "crsr_x", types: "", labels: "" };

  it("leaves out empty conditions", () => {
    expect(webhookDestinationRequest({ ...empty, types: ", ,", labels: "\n" })).toEqual({
      ok: true,
      value: { name: "Grok Bot", url: "https://api2.example.com/hook", token: "crsr_x" },
    });
  });

  it("converts the conditions", () => {
    expect(
      webhookDestinationRequest({ ...empty, types: "alert.observed, job.finished", labels: "project=a" }),
    ).toEqual({
      ok: true,
      value: {
        name: "Grok Bot",
        url: "https://api2.example.com/hook",
        token: "crsr_x",
        types: ["alert.observed", "job.finished"],
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

  it("describes a retry that could not be enqueued", () => {
    expect(errorLabel("retry_enqueue_failed")).toBe("再送を受け付けられませんでした");
  });
});

describe("the delivery history", () => {
  const base: Delivery = {
    id: "dlv_1",
    event_id: "evt_1",
    subscription_id: "sub_1",
    callback_host: "hooks.example.com",
    destination_kind: "webhook",
    destination_name: "hook",
    status: "failed",
    attempts: 6,
    last_attempt_at: 1,
    last_http_status: 503,
    last_error: "http_5xx",
    delivered_at: null,
    created_at: 1,
  };

  it("offers a retry only for failed deliveries to webhook destinations and MCP Events subscriptions", () => {
    expect(canRetry(base)).toBe(true);
    expect(canRetry({ ...base, destination_kind: "mcp" })).toBe(true);
    expect(canRetry({ ...base, destination_kind: "queue" })).toBe(false);
    expect(canRetry({ ...base, destination_kind: null })).toBe(false);
    expect(canRetry({ ...base, status: "pending" })).toBe(false);
    expect(canRetry({ ...base, status: "delivered" })).toBe(false);
    // An ended webhook destination never comes back; an MCP Events subscription may be made again.
    expect(canRetry({ ...base, last_error: "subscription_inactive" })).toBe(false);
    expect(canRetry({ ...base, destination_kind: "mcp", last_error: "subscription_inactive" })).toBe(true);
  });

  it("says why a failed delivery cannot be retried", () => {
    expect(noRetryReason(base)).toBeNull();
    expect(noRetryReason({ ...base, status: "delivered" })).toBeNull();
    expect(noRetryReason({ ...base, destination_kind: "queue" })).toBe("キューの配信は再送できません");
    expect(noRetryReason({ ...base, last_error: "subscription_inactive" })).toBe("配信先が終了しているため再送できません");
    expect(noRetryReason({ ...base, destination_kind: null })).toBe("配信先が見つからないため再送できません");
  });

  it("names the destination by its name, or its host", () => {
    expect(destinationLabel(base)).toBe("hook");
    expect(destinationLabel({ ...base, destination_name: null })).toBe("hooks.example.com");
    expect(destinationLabel({ ...base, destination_name: null, callback_host: null })).toBe("不明な宛先");
  });

  it("reads the status filter from the query, ignoring unknown values", () => {
    expect(statusFilterOf(new URLSearchParams("status=failed"))).toBe("failed");
    expect(statusFilterOf(new URLSearchParams("status=pending"))).toBe("pending");
    expect(statusFilterOf(new URLSearchParams("status=delivered"))).toBe("delivered");
    expect(statusFilterOf(new URLSearchParams("status=FAILED"))).toBeNull();
    expect(statusFilterOf(new URLSearchParams(""))).toBeNull();
  });

  it("builds the path of each filter", () => {
    expect(deliveryHistoryPath(null)).toBe("/deliveries/history");
    expect(deliveryHistoryPath("failed")).toBe("/deliveries/history?status=failed");
  });
});

describe("describeArguments", () => {
  it("describes every condition", () => {
    expect(describeArguments({ types: ["a"], labels: { k: "v" } })).toBe("種別: a / ラベル: k=v");
    // Sources are not conditions of delivery; a stored value is not shown.
    expect(describeArguments({ sources: ["x"] })).toBe("すべてのイベント");
    expect(describeArguments({})).toBe("すべてのイベント");
  });
});

describe("subscriptionBotLabel", () => {
  const SUBSCRIPTION: Subscription = {
    id: "sub_00000000000000000000000000000001",
    kind: "webhook",
    name: "grok",
    callback_host: "api.example.com",
    arguments: {},
    status: "active",
    refresh_before: null,
    expires_at: null,
    created_at: 1,
    updated_at: 1,
    connection: null,
    bot: null,
  };

  it("names the bot of a subscription", () => {
    expect(subscriptionBotLabel({ ...SUBSCRIPTION, bot: { id: "bot_1", name: "Grok" } })).toBe("Bot: Grok");
  });

  it("tells that an active subscription without a bot receives nothing, but not for ended or expired ones", () => {
    expect(subscriptionBotLabel(SUBSCRIPTION)).toBe("Bot に割り当てていないため、イベントは届きません");
    expect(subscriptionBotLabel({ ...SUBSCRIPTION, status: "unsubscribed" })).toBeNull();
    expect(subscriptionBotLabel({ ...SUBSCRIPTION, kind: "mcp", status: "expired" })).toBeNull();
  });
});

describe("queueRequest", () => {
  const empty = { name: "Muse", types: "", labels: "" };

  it("leaves out empty conditions", () => {
    expect(queueRequest({ ...empty, types: " , ", labels: "\n" })).toEqual({ ok: true, value: { name: "Muse" } });
  });

  it("converts the conditions", () => {
    expect(queueRequest({ ...empty, types: "alert.observed", labels: "project=a" })).toEqual({
      ok: true,
      value: { name: "Muse", types: ["alert.observed"], labels: { project: "a" } },
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

  it("shows a webhook delivery by its name (else its host), with the HTTP status", () => {
    expect(deliveryDestination(WEBHOOK)).toBe("Grok Bot");
    expect(deliveryDestination({ ...WEBHOOK, destination_name: null })).toBe("hooks.example.com");
    expect(deliveryDestination({ ...WEBHOOK, destination_name: null, callback_host: null })).toBe("不明な宛先");
    expect(deliveryStatusLabel(WEBHOOK)).toBe("配信済み");
    expect(attemptsLabel(WEBHOOK)).toBe("試行 2 回");
    expect(lastResult(WEBHOOK)).toBe("成功（HTTP\u00a0204）");
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
    expect(lastResult(failed)).toBe("処理済みの連絡がないまま、取得できる回数の上限に達しました");
    expect(lastResult({ ...failed, last_error: "expired" })).toBe("7 日間処理されなかった");
  });
});

describe("deliveryStatusLabel of a retried delivery", () => {
  it("says a webhook delivery that was tried and will be tried again is waiting to retry", () => {
    expect(
      deliveryStatusLabel({
        id: "dlv_1",
        event_id: "evt_1",
        subscription_id: "sub_1",
        callback_host: "hooks.example.com",
        destination_kind: "webhook",
        destination_name: "hook",
        status: "pending",
        attempts: 2,
        last_attempt_at: 0,
        last_http_status: 502,
        last_error: "http_5xx",
        delivered_at: null,
        created_at: 0,
      }),
    ).toBe("未配信（再試行待ち）");
  });
});
