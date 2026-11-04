import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotList } from "../src/api/types";
import { MAX_BOTS_PER_WORKSPACE, workspaceBotsByIds } from "../src/bots/queries";
import { createDb } from "../src/db/client";
import type { SourceRow, SubscriptionRow, UserRow, WorkspaceRow } from "../src/db/schema";
import { acceptEvent, type IntakeSource } from "../src/intake/service";
import {
  createQueue,
  createSource,
  createSubscription,
  createUser,
  d1RecordingLargeBinds,
  fakeQueue,
  listDeliveries,
  login,
  personalWorkspaceOf,
  resetDb,
  resetEventData,
  routeToBot,
  send,
  type SessionCookies,
} from "./helpers";

// The IN lists of the bots of a workspace are read in chunks, so that no statement binds more values than D1 accepts
// even when the workspace has MAX_BOTS_PER_WORKSPACE bots.

const NO_EXPIRY = 253402300799999;

let owner: UserRow;
let cookies: SessionCookies;
let workspace: WorkspaceRow;
let source: SourceRow;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  owner = await createUser({ email: "owner@example.com" });
  cookies = await login(owner.email);
  workspace = await personalWorkspaceOf(owner);
  source = await createSource({ workspaceId: workspace.id, name: "app" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await resetEventData();
});

// MAX_BOTS_PER_WORKSPACE bots of kind mcp, each with an active connection and an MCP Events subscription, linked to
// the source.
async function mcpBots(): Promise<{ botIds: string[]; subscriptions: SubscriptionRow[] }> {
  const botIds: string[] = [];
  const subscriptions: SubscriptionRow[] = [];
  for (let i = 0; i < MAX_BOTS_PER_WORKSPACE; i++) {
    const row = await createSubscription({ user: owner, workspaceId: workspace.id });
    const { botId } = await routeToBot(row, [source.id], { name: `mcp ${i}` });
    botIds.push(botId);
    subscriptions.push(row);
  }
  return { botIds, subscriptions };
}

// MAX_BOTS_PER_WORKSPACE bots with a destination each (webhook and queue in turn), linked to the source.
async function destinationBots(): Promise<{ botIds: string[]; subscriptions: SubscriptionRow[] }> {
  const botIds: string[] = [];
  const subscriptions: SubscriptionRow[] = [];
  for (let i = 0; i < MAX_BOTS_PER_WORKSPACE; i++) {
    const row =
      i % 2 === 0
        ? await createSubscription({ user: owner, workspaceId: workspace.id, kind: "webhook", expiresAt: NO_EXPIRY })
        : await createQueue({ user: owner, workspaceId: workspace.id, name: `queue ${i}` });
    const { botId } = await routeToBot(row, [source.id], { name: `destination ${i}` });
    botIds.push(botId);
    subscriptions.push(row);
  }
  return { botIds, subscriptions };
}

function acceptOne(d1: D1Database) {
  const intakeSource: IntakeSource = { id: source.id, workspaceId: workspace.id, name: source.name, enabled: true, screeningEnabled: false };
  return acceptEvent(
    { db: d1, bucket: env.EVENT_DATA, queue: fakeQueue(), now: Date.now() },
    intakeSource,
    { idempotency_key: "k-1", type: "alert.observed", summary: "s", labels: {} },
  );
}

describe.each([
  { kind: "mcp", setup: mcpBots },
  { kind: "webhook and queue", setup: destinationBots },
])("$kind bots up to the limit", ({ kind, setup }) => {
  it("lists every bot with its destination and sources", async () => {
    const { botIds } = await setup();
    const { d1, large } = d1RecordingLargeBinds();
    const res = await send("/api/v1/bots", { cookies, env: { DB: d1 } });
    // Checked first: the local D1 may reject such a statement too.
    expect(large).toEqual([]);
    expect(res.status).toBe(200);
    const { bots } = (await res.json()) as BotList;
    expect(bots).toHaveLength(MAX_BOTS_PER_WORKSPACE);
    expect(new Set(bots.map((bot) => bot.id))).toEqual(new Set(botIds));
    for (const bot of bots) {
      if (kind === "mcp") expect(bot.connection).not.toBeNull();
      expect(bot.delivery).not.toBeNull();
      expect(bot.sources.map((linked) => linked.id)).toEqual([source.id]);
    }
  });

  it("delivers an event of the source to every bot", async () => {
    const { subscriptions } = await setup();
    const { d1, large } = d1RecordingLargeBinds();
    const result = await acceptOne(d1);
    expect(large).toEqual([]);
    expect(result.ok).toBe(true);
    const deliveries = await listDeliveries();
    expect(deliveries).toHaveLength(MAX_BOTS_PER_WORKSPACE);
    expect(new Set(deliveries.map((delivery) => delivery.subscription_id))).toEqual(
      new Set(subscriptions.map((row) => row.id)),
    );
  });

  it("reads every bot by ID", async () => {
    const { botIds } = await setup();
    const { d1, large } = d1RecordingLargeBinds();
    const read = workspaceBotsByIds(createDb(d1), workspace.id, botIds);
    await read.catch(() => undefined);
    expect(large).toEqual([]);
    const rows = await read;
    expect(new Set(rows.keys())).toEqual(new Set(botIds));
  });
});
