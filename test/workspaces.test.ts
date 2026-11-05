import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isUniqueViolation } from "@i2bskn/workers-app-core";
import type { UserRow } from "../src/db/schema";
import { insertPersonalWorkspaceStatement } from "../src/workspaces/queries";
import { countPersonalWorkspaces, countWorkspaces, createUser, resetDb } from "./helpers";

const T0 = Date.UTC(2026, 9, 1);

let admin: UserRow;

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 - 2000 });
  await createUser({ email: "member@example.com", role: "member", createdAt: T0 - 1000 });
});

describe("insertPersonalWorkspaceStatement", () => {
  it("keeps one personal workspace when run twice", async () => {
    expect(await countPersonalWorkspaces(admin.id)).toBe(1);
    await insertPersonalWorkspaceStatement(env.DB, admin.id, T0).run();
    await insertPersonalWorkspaceStatement(env.DB, admin.id, T0).run();
    expect(await countPersonalWorkspaces(admin.id)).toBe(1);
    expect(await countWorkspaces()).toBe(2);
  });

  it("inserts nothing for an unknown user", async () => {
    await insertPersonalWorkspaceStatement(env.DB, "nope", T0).run();
    expect(await countWorkspaces()).toBe(2);
  });

  it("reports a UNIQUE violation inside a D1 batch through isUniqueViolation", async () => {
    const insert = () =>
      env.DB.prepare(
        "INSERT INTO workspaces (id, kind, name, owner_user_id, created_at, updated_at) VALUES (?, 'personal', NULL, ?, 0, 0)",
      );
    const other = await createUser({ email: "other@example.com", createdAt: T0 });
    await env.DB.prepare("DELETE FROM workspaces WHERE owner_user_id = ?").bind(other.id).run();
    const error = await env.DB.batch([
      insert().bind(crypto.randomUUID(), other.id),
      insert().bind(crypto.randomUUID(), other.id),
    ]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUniqueViolation(error)).toBe(true);
    // The whole batch is rolled back.
    expect(await countPersonalWorkspaces(other.id)).toBe(0);
    expect(await countWorkspaces()).toBe(2);
  });
});
