import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { users, workspaces, type SubscriptionRow, type UserRow, type WorkspaceRow } from "../src/db/schema";
import { NO_EXPIRY } from "../src/subscriptions/queries";
import {
  createApiKey,
  createEmailAddress,
  createSource,
  createSubscription,
  createUser,
  db,
  dbChangingBefore,
  listDeliveries,
  listEventDataKeys,
  login,
  resetDb,
  resetEventData,
  routeToBot,
  send,
  type SessionCookies,
} from "./helpers";

const T0 = Date.UTC(2026, 9, 1);

async function personalWorkspaceOf(user: UserRow): Promise<WorkspaceRow> {
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.ownerUserId, user.id) });
  if (!workspace) throw new Error("personal workspace not found");
  return workspace;
}

async function countSessions(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function countRows(table: string, ids: string[]): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function readUser(id: string) {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

function deleteRequest(id: string, cookies?: SessionCookies): Promise<Response> {
  return send(`/api/v1/users/${id}`, { method: "DELETE", cookies });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  await resetEventData();
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 });
  adminCookies = await login(admin.email);
  await login(member.email);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetEventData();
});

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// A source with a key, an email address, and an event with a body and an attachment, received through the HTTP
// intake.
// destinations receive the event of the source, through bots linked to it.
async function fillWorkspace(
  user: UserRow,
  destinations: SubscriptionRow[] = [],
): Promise<{ workspace: WorkspaceRow; sourceId: string; keyId: string }> {
  const workspace = await personalWorkspaceOf(user);
  const source = await createSource({ workspaceId: workspace.id, name: "app" });
  for (const destination of destinations) await routeToBot(destination, [source.id]);
  const { key, keyId } = await createApiKey(source.id);
  await createEmailAddress(source.id);
  const form = new FormData();
  form.append("metadata", JSON.stringify({ idempotency_key: "k", type: "t", summary: "s" }));
  form.append("body", new File(["body"], "b"));
  form.append("attachments", new File(["file"], "a.txt"));
  const res = await send("/ingest/v1/events", { method: "POST", body: form, headers: { Authorization: `Bearer ${key}` } });
  if (res.status !== 201) throw new Error(`ingest failed: ${res.status}`);
  return { workspace, sourceId: source.id, keyId };
}

describe("DELETE /api/v1/users/:id", () => {
  it("deletes the user with their sessions and their personal workspace", async () => {
    await login(member.email);
    const workspace = await personalWorkspaceOf(member);
    expect(await countSessions(member.id)).toBe(2);

    const res = await deleteRequest(member.id, adminCookies);
    expect(res.status).toBe(204);

    expect(await readUser(member.id)).toBeUndefined();
    expect(await countSessions(member.id)).toBe(0);
    expect(await countRows("workspaces", [workspace.id])).toBe(0);
  });

  it("deletes the sources, API keys, email addresses, events, event data and R2 objects of the workspace", async () => {
    const mine = await fillWorkspace(member);
    const theirs = await fillWorkspace(admin);
    // An orphan left by a failed intake.
    await env.EVENT_DATA.put(`workspaces/${mine.workspace.id}/events/evt_orphan/dat_orphan`, "orphan");
    expect(await listEventDataKeys(`workspaces/${mine.workspace.id}/`)).toHaveLength(3);

    expect((await deleteRequest(member.id, adminCookies)).status).toBe(204);

    expect(await countWhere("sources", "workspace_id", mine.workspace.id)).toBe(0);
    expect(await countWhere("api_keys", "source_id", mine.sourceId)).toBe(0);
    expect(await countWhere("email_addresses", "source_id", mine.sourceId)).toBe(0);
    expect(await countWhere("events", "workspace_id", mine.workspace.id)).toBe(0);
    expect(await countWhere("event_data", "workspace_id", mine.workspace.id)).toBe(0);
    expect(await listEventDataKeys(`workspaces/${mine.workspace.id}/`)).toEqual([]);

    expect(await countWhere("sources", "workspace_id", theirs.workspace.id)).toBe(1);
    expect(await countWhere("api_keys", "source_id", theirs.sourceId)).toBe(1);
    expect(await countWhere("email_addresses", "source_id", theirs.sourceId)).toBe(1);
    expect(await countWhere("events", "workspace_id", theirs.workspace.id)).toBe(1);
    expect(await countWhere("event_data", "workspace_id", theirs.workspace.id)).toBe(2);
    expect(await listEventDataKeys(`workspaces/${theirs.workspace.id}/`)).toHaveLength(2);
  });

  it("deletes the deliveries of the workspace and of the user's subscriptions", async () => {
    const adminWorkspace = await personalWorkspaceOf(admin);
    const memberWorkspace = await personalWorkspaceOf(member);
    const own = await createSubscription({ user: member });
    // A subscription of the member delivering from another workspace: its deliveries must go before it.
    const crossing = await createSubscription({ user: member, workspaceId: adminWorkspace.id });
    const adminSubscription = await createSubscription({ user: admin });
    await fillWorkspace(member, [own]);
    await fillWorkspace(admin, [crossing, adminSubscription]);
    expect((await listDeliveries()).map((row) => row.subscription_id).sort()).toEqual(
      [own.id, crossing.id, adminSubscription.id].sort(),
    );

    expect((await deleteRequest(member.id, adminCookies)).status).toBe(204);

    expect(await listDeliveries("workspace_id = ?", memberWorkspace.id)).toEqual([]);
    expect((await listDeliveries()).map((row) => row.subscription_id)).toEqual([adminSubscription.id]);
    expect(await countWhere("subscriptions", "user_id", member.id)).toBe(0);
    // The linked sources of the member's bots go before the bots and the sources.
    expect(await countWhere("bot_sources", "workspace_id", memberWorkspace.id)).toBe(0);
    expect(await countWhere("bots", "workspace_id", memberWorkspace.id)).toBe(0);
    expect(await countWhere("bot_sources", "workspace_id", adminWorkspace.id)).toBe(2);
  });

  it("deletes the webhook destinations of the user and their deliveries", async () => {
    const webhook = await createSubscription({
      user: member,
      kind: "webhook",
      name: "bot",
      secret: new TextEncoder().encode("crsr_key"),
      expiresAt: NO_EXPIRY,
    });
    const adminWebhook = await createSubscription({
      user: admin,
      kind: "webhook",
      name: "bot",
      secret: new TextEncoder().encode("crsr_key"),
      expiresAt: NO_EXPIRY,
    });
    await fillWorkspace(member, [webhook]);
    await fillWorkspace(admin, [adminWebhook]);
    expect((await listDeliveries()).map((row) => row.subscription_id).sort()).toEqual(
      [webhook.id, adminWebhook.id].sort(),
    );

    expect((await deleteRequest(member.id, adminCookies)).status).toBe(204);

    expect((await listDeliveries()).map((row) => row.subscription_id)).toEqual([adminWebhook.id]);
    expect(await countWhere("subscriptions", "id", webhook.id)).toBe(0);
    expect(await countWhere("subscriptions", "id", adminWebhook.id)).toBe(1);
  });

  it("keeps the user deleted when deleting the R2 objects fails", async () => {
    await fillWorkspace(member);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new Proxy(env.EVENT_DATA, {
      get(target, prop) {
        if (prop === "list") {
          return async () => {
            throw new Error("R2 is down");
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await send(`/api/v1/users/${member.id}`, {
      method: "DELETE",
      cookies: adminCookies,
      env: { EVENT_DATA: failing },
    });
    expect(res.status).toBe(204);
    expect(await readUser(member.id)).toBeUndefined();
  });

  it("leaves the personal workspaces of other users alone", async () => {
    const other = await createUser({ email: "other@example.com", createdAt: T0 });
    const kept = [(await personalWorkspaceOf(other)).id, (await personalWorkspaceOf(admin)).id];

    expect((await deleteRequest(member.id, adminCookies)).status).toBe(204);

    expect(await countRows("workspaces", kept)).toBe(2);
    expect(await countSessions(admin.id)).toBe(1);
  });

  it("lets an admin delete another admin when there are two", async () => {
    const second = await createUser({ email: "second@example.com", role: "admin", createdAt: T0 });
    const workspace = await personalWorkspaceOf(second);
    expect((await deleteRequest(second.id, adminCookies)).status).toBe(204);
    expect(await readUser(second.id)).toBeUndefined();
    expect(await countRows("workspaces", [workspace.id])).toBe(0);
  });
});

// The guard of the batch (src/core.ts userDeleteStatements), through DELETE /api/v1/users/:id. dbChangingBefore runs
// the change right before the first statement of the hook.
describe("DELETE /api/v1/users/:id under a race", () => {
  it("deletes nothing when the requester stops being an admin after the check", async () => {
    const target = await createUser({ email: "target@example.com", role: "admin", createdAt: T0 });
    await login(target.email);
    const { workspace, sourceId } = await fillWorkspace(target);
    // The first statement of the batch.
    const raced = dbChangingBefore(/^DELETE FROM deliveries/i, () =>
      env.DB.prepare("UPDATE users SET role = 'member' WHERE id = ?").bind(admin.id).run(),
    );

    const res = await send(`/api/v1/users/${target.id}`, {
      method: "DELETE",
      cookies: adminCookies,
      env: { DB: raced.$client },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("last_admin");

    expect(await readUser(target.id)).toMatchObject({ role: "admin" });
    expect(await countSessions(target.id)).toBe(1);
    expect(await countRows("workspaces", [workspace.id])).toBe(1);
    expect(await countRows("sources", [sourceId])).toBe(1);
    expect(await countWhere("api_keys", "source_id", sourceId)).toBe(1);
    expect(await countWhere("email_addresses", "source_id", sourceId)).toBe(1);
    expect(await countWhere("events", "workspace_id", workspace.id)).toBe(1);
    expect(await countWhere("event_data", "workspace_id", workspace.id)).toBe(2);
  });

  it("deletes nothing when the user is deleted after the check", async () => {
    const workspace = await personalWorkspaceOf(member);
    const raced = dbChangingBefore(/^DELETE FROM deliveries/i, () =>
      env.DB.batch([
        env.DB.prepare("DELETE FROM workspaces WHERE owner_user_id = ?").bind(member.id),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(member.id),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(member.id),
      ]),
    );

    const res = await send(`/api/v1/users/${member.id}`, {
      method: "DELETE",
      cookies: adminCookies,
      env: { DB: raced.$client },
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect(await countRows("workspaces", [workspace.id])).toBe(0);
  });
});
