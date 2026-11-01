import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import type {
  ApiKeyList,
  CreateSourceRequest,
  CreatedApiKey,
  EmailAddressList,
  SourceList,
  UpdateSourceRequest,
} from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import { isUniqueViolation } from "../auth/users";
import { clock } from "../clock";
import { apiKeys, emailAddresses, sources } from "../db/schema";
import {
  countActiveEmailAddresses,
  findSourceEmailAddress,
  listSourceEmailAddresses,
  toApiEmailAddress,
} from "../email-addresses/queries";
import { parseEmailDomain, type AppEnv, type Bindings } from "../env";
import {
  EMAIL_LOCAL_PART_PATTERN,
  formatApiKey,
  KEY_ID_PATTERN,
  newEmailLocalPart,
  newKeyId,
  newKeySecret,
  newSourceId,
  sha256Hex,
  SOURCE_ID_PATTERN,
} from "../ids";
import { codePointLength } from "../intake/validation";
import {
  countActiveApiKeys,
  countWorkspaceSources,
  findSourceApiKey,
  findWorkspaceSource,
  listSourceApiKeys,
  listWorkspaceSources,
  toApiKey,
  toApiSource,
} from "../sources/queries";
import { jsonBody } from "./api";
import { requirePersonalWorkspace } from "./workspace";

const MAX_SOURCES_PER_WORKSPACE = 100;
const MAX_ACTIVE_KEYS_PER_SOURCE = 10;
const MAX_ACTIVE_EMAIL_ADDRESSES_PER_SOURCE = 10;
export const SOURCE_NAME_MAX_LENGTH = 64;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

const sourceNotFound = "送信元が見つかりません";
const keyNotFound = "APIキーが見つかりません";
const emailAddressNotFound = "メールアドレスが見つかりません";

// The domain of the email intake, or null when it is off. An invalid value is treated as unset here, so that the
// screen tells the operator; the value itself is not logged.
function emailDomainOf(env: Bindings): string | null {
  const result = parseEmailDomain(env.EMAIL_DOMAIN);
  if (!result.ok) {
    console.error("invalid EMAIL_DOMAIN");
    return null;
  }
  return result.domain;
}

// The trimmed name, or null if invalid: 1 to 64 characters without control characters. Also the rule of the
// names of webhook destinations (src/routes/subscriptions.ts).
export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = codePointLength(name);
  if (length < 1 || length > SOURCE_NAME_MAX_LENGTH || CONTROL.test(name)) return null;
  return name;
}

export const invalidNameMessage = "名前は制御文字を含まない 1〜64 文字にしてください";

export function unknownField(body: Record<string, unknown>, allowed: string[]): string | null {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) return key;
  return null;
}

const createSourceBody = jsonBody<CreateSourceRequest, { name: string }>((body, c) => {
  const unknown = unknownField(body, ["name"]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const name = normalizeDisplayName(body.name);
  if (name === null) return apiError(c, 400, "invalid_name", invalidNameMessage);
  return { ok: true, value: { name } };
});

const updateSourceBody = jsonBody<UpdateSourceRequest, { name?: string; enabled?: boolean }>((body, c) => {
  const unknown = unknownField(body, ["name", "enabled"]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  if (!("name" in body) && !("enabled" in body)) {
    return apiError(c, 400, "invalid_request", "name か enabled を指定してください");
  }
  const value: { name?: string; enabled?: boolean } = {};
  if ("name" in body) {
    const name = normalizeDisplayName(body.name);
    if (name === null) return apiError(c, 400, "invalid_name", invalidNameMessage);
    value.name = name;
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return apiError(c, 400, "invalid_enabled", "enabled は true か false にしてください");
    value.enabled = body.enabled;
  }
  return { ok: true, value };
});

const sourcesApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", async (c) => {
    const rows = await listWorkspaceSources(c.get("db"), c.get("workspace").id);
    const body: SourceList = { sources: rows.map(toApiSource) };
    return c.json(body, 200);
  })
  .post("/", createSourceBody, async (c) => {
    const { name } = c.req.valid("json");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    // A loose limit: concurrent requests may go slightly over it.
    if ((await countWorkspaceSources(db, workspaceId)) >= MAX_SOURCES_PER_WORKSPACE) {
      return apiError(c, 409, "limit_exceeded", "送信元は 100 件までです");
    }
    const now = clock.now();
    const id = newSourceId(now);
    try {
      await db.insert(sources).values({ id, workspaceId, name, enabled: true, createdAt: now, updatedAt: now }).run();
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "source_name_taken", "この名前の送信元はすでにあります");
      throw error;
    }
    const created = await findWorkspaceSource(db, workspaceId, id);
    if (!created) throw new Error("created source not found");
    return c.json(toApiSource(created), 201);
  })
  .patch("/:id", updateSourceBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const id = c.req.param("id");
    if (!SOURCE_ID_PATTERN.test(id) || !(await findWorkspaceSource(db, workspaceId, id))) {
      return apiError(c, 404, "not_found", sourceNotFound);
    }
    try {
      await db
        .update(sources)
        .set({ ...input, updatedAt: clock.now() })
        .where(and(eq(sources.id, id), eq(sources.workspaceId, workspaceId)))
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "source_name_taken", "この名前の送信元はすでにあります");
      throw error;
    }
    const updated = await findWorkspaceSource(db, workspaceId, id);
    if (!updated) return apiError(c, 404, "not_found", sourceNotFound);
    return c.json(toApiSource(updated), 200);
  })
  .get("/:id/api-keys", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    if (!SOURCE_ID_PATTERN.test(id) || !(await findWorkspaceSource(db, c.get("workspace").id, id))) {
      return apiError(c, 404, "not_found", sourceNotFound);
    }
    const body: ApiKeyList = { api_keys: (await listSourceApiKeys(db, id)).map(toApiKey) };
    return c.json(body, 200);
  })
  .post("/:id/api-keys", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    // Keys can be issued for a disabled source too.
    if (!SOURCE_ID_PATTERN.test(id) || !(await findWorkspaceSource(db, c.get("workspace").id, id))) {
      return apiError(c, 404, "not_found", sourceNotFound);
    }
    // A loose limit: concurrent requests may go slightly over it.
    if ((await countActiveApiKeys(db, id)) >= MAX_ACTIVE_KEYS_PER_SOURCE) {
      return apiError(c, 409, "limit_exceeded", "有効なAPIキーは 1 つの送信元に 10 個までです");
    }
    const now = clock.now();
    const secret = newKeySecret();
    const secretHash = await sha256Hex(secret);
    // On a keyId collision, one more try.
    for (let attempt = 0; attempt < 2; attempt++) {
      const keyId = newKeyId();
      try {
        await db.insert(apiKeys).values({ id: keyId, sourceId: id, secretHash, createdAt: now }).run();
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
      const created = await findSourceApiKey(db, id, keyId);
      if (!created) throw new Error("created API key not found");
      const body: CreatedApiKey = { api_key: toApiKey(created), key: formatApiKey(keyId, secret) };
      return c.json(body, 201);
    }
    return apiError(c, 503, "temporarily_unavailable", "APIキーを発行できませんでした。もう一度試してください");
  })
  .post("/:id/api-keys/:keyId/revoke", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const keyId = c.req.param("keyId");
    if (!SOURCE_ID_PATTERN.test(id) || !(await findWorkspaceSource(db, c.get("workspace").id, id))) {
      return apiError(c, 404, "not_found", sourceNotFound);
    }
    // Only a key of this source: a key of another source (or another user) is never revoked here.
    if (!KEY_ID_PATTERN.test(keyId) || !(await findSourceApiKey(db, id, keyId))) {
      return apiError(c, 404, "not_found", keyNotFound);
    }
    // Revoking again keeps the first revoked_at.
    await db
      .update(apiKeys)
      .set({ revokedAt: clock.now() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.sourceId, id), isNull(apiKeys.revokedAt)))
      .run();
    const key = await findSourceApiKey(db, id, keyId);
    if (!key) return apiError(c, 404, "not_found", keyNotFound);
    return c.json(toApiKey(key), 200);
  })
  .get("/:id/email-addresses", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    if (!SOURCE_ID_PATTERN.test(id) || !(await findWorkspaceSource(db, c.get("workspace").id, id))) {
      return apiError(c, 404, "not_found", sourceNotFound);
    }
    const domain = emailDomainOf(c.env);
    const rows = await listSourceEmailAddresses(db, id);
    const body: EmailAddressList = {
      email_domain: domain,
      email_addresses: rows.map((row) => toApiEmailAddress(row, domain)),
    };
    return c.json(body, 200);
  })
  .post("/:id/email-addresses", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    // Addresses can be issued for a disabled source too, like API keys.
    if (!SOURCE_ID_PATTERN.test(id) || !(await findWorkspaceSource(db, c.get("workspace").id, id))) {
      return apiError(c, 404, "not_found", sourceNotFound);
    }
    const domain = emailDomainOf(c.env);
    if (domain === null) {
      return apiError(c, 409, "email_not_configured", "メールでの受付が設定されていません（EMAIL_DOMAIN）");
    }
    // A loose limit: concurrent requests may go slightly over it.
    if ((await countActiveEmailAddresses(db, id)) >= MAX_ACTIVE_EMAIL_ADDRESSES_PER_SOURCE) {
      return apiError(c, 409, "limit_exceeded", "有効なメールアドレスは 1 つの送信元に 10 個までです");
    }
    const now = clock.now();
    // On a collision, one more try.
    for (let attempt = 0; attempt < 2; attempt++) {
      const localPart = newEmailLocalPart();
      try {
        await db.insert(emailAddresses).values({ id: localPart, sourceId: id, createdAt: now }).run();
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
      const created = await findSourceEmailAddress(db, id, localPart);
      if (!created) throw new Error("created email address not found");
      return c.json(toApiEmailAddress(created, domain), 201);
    }
    return apiError(c, 503, "temporarily_unavailable", "メールアドレスを発行できませんでした。もう一度試してください");
  })
  .post("/:id/email-addresses/:localPart/revoke", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const localPart = c.req.param("localPart");
    if (!SOURCE_ID_PATTERN.test(id) || !(await findWorkspaceSource(db, c.get("workspace").id, id))) {
      return apiError(c, 404, "not_found", sourceNotFound);
    }
    // Only an address of this source: an address of another source (or another user) is never revoked here.
    if (!EMAIL_LOCAL_PART_PATTERN.test(localPart) || !(await findSourceEmailAddress(db, id, localPart))) {
      return apiError(c, 404, "not_found", emailAddressNotFound);
    }
    // Revoking again keeps the first revoked_at.
    await db
      .update(emailAddresses)
      .set({ revokedAt: clock.now() })
      .where(and(eq(emailAddresses.id, localPart), eq(emailAddresses.sourceId, id), isNull(emailAddresses.revokedAt)))
      .run();
    const address = await findSourceEmailAddress(db, id, localPart);
    if (!address) return apiError(c, 404, "not_found", emailAddressNotFound);
    return c.json(toApiEmailAddress(address, emailDomainOf(c.env)), 200);
  });

export default sourcesApi;
