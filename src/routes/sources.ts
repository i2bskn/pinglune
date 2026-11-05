import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import type {
  ApiKeyList,
  CreateSourceRequest,
  CreatedApiKey,
  EmailAddressList,
  SourceList,
  UpdateSourceEmailSendersRequest,
  UpdateSourceEmailSenderVerificationRequest,
  UpdateSourceRequest,
  UpdateSourceScreeningRequest,
} from "../api/types";
import { apiError, clock, isUniqueViolation } from "@i2bskn/workers-app-core";
import { requireUser } from "../core";
import { apiKeys, emailAddresses, sources, type WorkspaceRow } from "../db/schema";
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
import { MAX_ALLOWED_SENDERS, normalizeAllowedSender } from "../intake/email-sender";
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
import { normalizeApiKey, verifyAndSaveApiKey } from "../screening/api-key";
import { jsonBody, unknownField } from "./api";
import { conversationStartBody } from "./conversation-start";
import { invalidApiKeyMessage, screeningApiKeyError } from "./screening";
import { normalizeDisplayName, SOURCE_NAME_MAX_LENGTH } from "../sources/names";
import { requirePersonalWorkspace } from "./workspace";

// The rule of display names (src/sources/names.ts) and unknownField (./api), also used by the other routes.
export { normalizeDisplayName, SOURCE_NAME_MAX_LENGTH, unknownField };

export const MAX_SOURCES_PER_WORKSPACE = 100;
const MAX_ACTIVE_KEYS_PER_SOURCE = 10;
const MAX_ACTIVE_EMAIL_ADDRESSES_PER_SOURCE = 10;

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

export const invalidNameMessage = "名前は制御文字を含まない 1〜64 文字にしてください";

const createSourceBody = jsonBody<CreateSourceRequest, { name: string }, AppEnv>((body, c) => {
  const unknown = unknownField(body, ["name"]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const name = normalizeDisplayName(body.name);
  if (name === null) return apiError(c, 400, "invalid_name", invalidNameMessage);
  return { ok: true, value: { name } };
});

// Whether the workspace has a TypeSafe API key for the screening. Whether it can be decrypted is not checked.
export function hasScreeningApiKey(workspace: WorkspaceRow): boolean {
  return workspace.screeningApiKey !== null;
}

const screeningEnabledMessage = "AI への指示の判定が有効な送信元からは会話を始められません。先に判定を無効にしてください";
const conversationStartEnabledMessage =
  "会話の開始が有効な送信元では AI への指示の判定を有効にできません。先に会話の開始を無効にしてください";
const apiKeyRequiredMessage = "判定を有効にするには TypeSafe の API キーを入力してください";
const apiKeyAlreadySetMessage = "API キーは設定済みです。変更は API キーの「変更」から行ってください";

const sourceScreeningBody = jsonBody<UpdateSourceScreeningRequest, { enabled: boolean; apiKey?: unknown }, AppEnv>(
  (body, c) => {
    const unknown = unknownField(body, ["enabled", "api_key"]);
    if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
    if (typeof body.enabled !== "boolean") {
      return apiError(c, 400, "invalid_request", "enabled は true か false で指定してください");
    }
    // Checked by the route: whether it is allowed depends on the key of the workspace.
    return { ok: true, value: body.api_key === undefined ? { enabled: body.enabled } : { enabled: body.enabled, apiKey: body.api_key } };
  },
);

const emailSenderVerificationBody = jsonBody<UpdateSourceEmailSenderVerificationRequest, { enabled: boolean }, AppEnv>(
  (body, c) => {
    const unknown = unknownField(body, ["enabled"]);
    if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
    if (typeof body.enabled !== "boolean") {
      return apiError(c, 400, "invalid_request", "enabled は true か false で指定してください");
    }
    return { ok: true, value: { enabled: body.enabled } };
  },
);

// The senders normalized, without duplicates, in the order given. The limit counts the elements given, duplicates
// included. The position in the message is that of the element (1-based), of the first invalid one.
const emailSendersBody = jsonBody<UpdateSourceEmailSendersRequest, { senders: string[] }, AppEnv>((body, c) => {
  const unknown = unknownField(body, ["senders"]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  const input: unknown = body.senders;
  if (!Array.isArray(input) || !input.every((sender) => typeof sender === "string")) {
    return apiError(c, 400, "invalid_request", "senders は文字列の配列で指定してください");
  }
  if (input.length > MAX_ALLOWED_SENDERS) {
    return apiError(c, 422, "too_many_senders", `許可する送信者は ${MAX_ALLOWED_SENDERS} 個までです`);
  }
  const senders: string[] = [];
  for (const [index, value] of (input as string[]).entries()) {
    const sender = normalizeAllowedSender(value);
    if (sender === null) {
      return apiError(c, 422, "invalid_sender", `${index + 1}行目の送信者の書き方が正しくありません`);
    }
    if (!senders.includes(sender)) senders.push(sender);
  }
  return { ok: true, value: { senders } };
});

const updateSourceBody = jsonBody<UpdateSourceRequest, { name?: string; enabled?: boolean }, AppEnv>((body, c) => {
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
    const screeningAvailable = hasScreeningApiKey(c.get("workspace"));
    const body: SourceList = { sources: rows.map((row) => toApiSource(row, { screeningAvailable })) };
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
      // The sender of the email intake is checked from the start; only the sources made before the check are off.
      await db
        .insert(sources)
        .values({ id, workspaceId, name, enabled: true, emailSenderVerification: 1, createdAt: now, updatedAt: now })
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "source_name_taken", "この名前の送信元はすでにあります");
      throw error;
    }
    const created = await findWorkspaceSource(db, workspaceId, id);
    if (!created) throw new Error("created source not found");
    return c.json(toApiSource(created, { screeningAvailable: hasScreeningApiKey(c.get("workspace")) }), 201);
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
    return c.json(toApiSource(updated, { screeningAvailable: hasScreeningApiKey(c.get("workspace")) }), 200);
  })
  // The conversation start settings, as for a bot. Saved for a disabled source too. Turning them off does not stop
  // the conversations the source has started. Not turned on while the screening is on: the first message is written
  // by the program and would reach the bots without the screening.
  .post("/:id/conversation-start", conversationStartBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const workspaceId = c.get("workspace").id;
    const id = c.req.param("id");
    if (!SOURCE_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", sourceNotFound);
    // kind 'program': the conversation source is never matched.
    const result = await c.env.DB.prepare(
      `UPDATE sources SET can_start_conversations = ?1, start_daily_limit = ?2, start_max_ai_messages = ?3, updated_at = ?4
      WHERE id = ?5 AND workspace_id = ?6 AND kind = 'program' AND (?1 = 0 OR screening_enabled = 0)`,
    )
      .bind(input.enabled ? 1 : 0, input.dailyLimit, input.maxAiMessages, clock.now(), id, workspaceId)
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      const source = await findWorkspaceSource(db, workspaceId, id);
      if (source?.screeningEnabled === 1) {
        return apiError(c, 409, "screening_enabled", screeningEnabledMessage);
      }
      return apiError(c, 404, "not_found", sourceNotFound);
    }
    const updated = await findWorkspaceSource(db, workspaceId, id);
    if (!updated) return apiError(c, 404, "not_found", sourceNotFound);
    return c.json(toApiSource(updated, { screeningAvailable: hasScreeningApiKey(c.get("workspace")) }), 200);
  })
  // The screening of the events for instructions to AIs (src/screening/). Turning it on needs the TypeSafe API key of
  // the workspace: api_key is required when the workspace has none (it is checked and saved first), and rejected when
  // it has one (PUT /api/v1/screening/api-key changes it). Turning it off is always allowed. Not turned on while the
  // source may start conversations.
  .post("/:id/screening", sourceScreeningBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const workspace = c.get("workspace");
    const id = c.req.param("id");
    if (!SOURCE_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", sourceNotFound);
    const source = await findWorkspaceSource(db, workspace.id, id);
    if (!source) return apiError(c, 404, "not_found", sourceNotFound);
    let screeningAvailable = hasScreeningApiKey(workspace);
    if (input.enabled) {
      if (source.canStartConversations === 1) {
        return apiError(c, 409, "conversation_start_enabled", conversationStartEnabledMessage);
      }
      if (screeningAvailable && input.apiKey !== undefined) {
        return apiError(c, 422, "api_key_already_set", apiKeyAlreadySetMessage);
      }
      if (!screeningAvailable) {
        if (input.apiKey === undefined) return apiError(c, 422, "api_key_required", apiKeyRequiredMessage);
        const apiKey = normalizeApiKey(input.apiKey);
        if (apiKey === null) return apiError(c, 422, "invalid_api_key", invalidApiKeyMessage);
        const saved = await verifyAndSaveApiKey(c.env.DB, {
          jwtSecret: c.get("config").jwtSecret,
          workspaceId: workspace.id,
          apiKey,
        });
        if (!saved.ok) return screeningApiKeyError(c, saved.code);
        screeningAvailable = true;
      }
    }
    // The conversation start is checked again in the same statement, for a change of both at the same time.
    const result = await c.env.DB.prepare(
      `UPDATE sources SET screening_enabled = ?1, updated_at = ?2
      WHERE id = ?3 AND workspace_id = ?4 AND kind = 'program' AND (?1 = 0 OR can_start_conversations = 0)`,
    )
      .bind(input.enabled ? 1 : 0, clock.now(), id, workspace.id)
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      const current = await findWorkspaceSource(db, workspace.id, id);
      if (current?.canStartConversations === 1) {
        return apiError(c, 409, "conversation_start_enabled", conversationStartEnabledMessage);
      }
      return apiError(c, 404, "not_found", sourceNotFound);
    }
    const updated = await findWorkspaceSource(db, workspace.id, id);
    if (!updated) return apiError(c, 404, "not_found", sourceNotFound);
    return c.json(toApiSource(updated, { screeningAvailable }), 200);
  })
  // The check of the sender of the email intake. Saved for a disabled source too. The allowed senders are kept when it
  // is turned off, and used again when it is turned on. The screen asks before turning it off; the API does not.
  .post("/:id/email-sender-verification", emailSenderVerificationBody, async (c) => {
    const { enabled } = c.req.valid("json");
    const workspace = c.get("workspace");
    const id = c.req.param("id");
    if (!SOURCE_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", sourceNotFound);
    // kind 'program': the conversation source is never matched.
    const result = await c.env.DB.prepare(
      `UPDATE sources SET email_sender_verification = ?1, updated_at = ?2
      WHERE id = ?3 AND workspace_id = ?4 AND kind = 'program'`,
    )
      .bind(enabled ? 1 : 0, clock.now(), id, workspace.id)
      .run();
    if ((result.meta.changes ?? 0) === 0) return apiError(c, 404, "not_found", sourceNotFound);
    const updated = await findWorkspaceSource(c.get("db"), workspace.id, id);
    if (!updated) return apiError(c, 404, "not_found", sourceNotFound);
    return c.json(toApiSource(updated, { screeningAvailable: hasScreeningApiKey(workspace) }), 200);
  })
  // The allowed senders of the email intake. Saved for a disabled source too. An empty list is stored as NULL.
  .post("/:id/email-senders", emailSendersBody, async (c) => {
    const { senders } = c.req.valid("json");
    const workspace = c.get("workspace");
    const id = c.req.param("id");
    if (!SOURCE_ID_PATTERN.test(id)) return apiError(c, 404, "not_found", sourceNotFound);
    const result = await c.env.DB.prepare(
      `UPDATE sources SET email_allowed_senders = ?1, updated_at = ?2
      WHERE id = ?3 AND workspace_id = ?4 AND kind = 'program'`,
    )
      .bind(senders.length === 0 ? null : JSON.stringify(senders), clock.now(), id, workspace.id)
      .run();
    if ((result.meta.changes ?? 0) === 0) return apiError(c, 404, "not_found", sourceNotFound);
    const updated = await findWorkspaceSource(c.get("db"), workspace.id, id);
    if (!updated) return apiError(c, 404, "not_found", sourceNotFound);
    return c.json(toApiSource(updated, { screeningAvailable: hasScreeningApiKey(workspace) }), 200);
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
