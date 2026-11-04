// The TypeSafe API key of the workspace, which the screening of events uses (src/screening/). The key itself is never
// returned: only its last 4 characters.

import { Hono, type Context } from "hono";
import type { ScreeningSettings, UpdateScreeningApiKeyRequest } from "../api/types";
import { apiError, requireUser } from "../auth/middleware";
import type { AppEnv } from "../env";
import { deleteApiKey, normalizeApiKey, verifyAndSaveApiKey } from "../screening/api-key";
import { findWorkspaceById } from "../workspaces/queries";
import { jsonBody } from "./api";
import { unknownField } from "./sources";
import { requirePersonalWorkspace } from "./workspace";

export const invalidApiKeyMessage = "TypeSafe の API キーが正しくありません";
const screeningUnavailableMessage =
  "TypeSafe に接続できなかったため、API キーを確かめられませんでした。しばらくしてからもう一度お試しください";

// The response when a key could not be saved: 422 for a key that TypeSafe refused, 503 when TypeSafe could not tell.
export function screeningApiKeyError(c: Context<AppEnv>, code: "invalid_api_key" | "screening_unavailable"): Response {
  return code === "invalid_api_key"
    ? apiError(c, 422, "invalid_api_key", invalidApiKeyMessage)
    : apiError(c, 503, "screening_unavailable", screeningUnavailableMessage);
}

const apiKeyBody = jsonBody<UpdateScreeningApiKeyRequest, { apiKey: unknown }>((body, c) => {
  const unknown = unknownField(body, ["api_key"]);
  if (unknown !== null) return apiError(c, 400, "unknown_field", `未知の項目があります: ${unknown}`);
  return { ok: true, value: { apiKey: body.api_key } };
});

async function settingsOf(c: Context<AppEnv>): Promise<ScreeningSettings> {
  const workspace = await findWorkspaceById(c.get("db"), c.get("workspace").id);
  const hint = workspace?.screeningApiKey === null || workspace === undefined ? null : workspace.screeningApiKeyHint;
  return { api_key: hint === null ? null : { hint } };
}

const screeningApi = new Hono<AppEnv>()
  .use("*", requireUser, requirePersonalWorkspace)
  .get("/", async (c) => c.json(await settingsOf(c), 200))
  // Sets or changes the key, checked with TypeSafe first.
  .put("/api-key", apiKeyBody, async (c) => {
    const apiKey = normalizeApiKey(c.req.valid("json").apiKey);
    if (apiKey === null) return apiError(c, 422, "invalid_api_key", invalidApiKeyMessage);
    const saved = await verifyAndSaveApiKey(c.env.DB, {
      jwtSecret: c.get("config").jwtSecret,
      workspaceId: c.get("workspace").id,
      apiKey,
    });
    if (!saved.ok) return screeningApiKeyError(c, saved.code);
    return c.json(await settingsOf(c), 200);
  })
  // Deletes the key, even while sources have the screening on: their events are then held as
  // screening_not_configured.
  .delete("/api-key", async (c) => {
    await deleteApiKey(c.env.DB, c.get("workspace").id);
    return c.json(await settingsOf(c), 200);
  });

export default screeningApi;
