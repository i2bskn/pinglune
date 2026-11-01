/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { clock } from "../clock";
import type { AppEnv } from "../env";
import {
  clearOidcCookie,
  clearSessionCookies,
  getAccessCookie,
  getOidcCookie,
  getRefreshCookie,
  setCookiesForSession,
  setOidcCookie,
} from "../auth/cookies";
import { parseAllowlist } from "../auth/allowlist";
import { apiError, describeError, requireMode } from "../auth/middleware";
import { evaluateIdTokenClaims, exchangeCode, startOidcLogin, verifyOidcState } from "../auth/oidc";
import { hashPassword, verifyDummyPassword, verifyPassword } from "../auth/password";
import { safeNext } from "../auth/redirect";
import {
  findSessionById,
  findSessionByTokenHash,
  issueSession,
  revokeFamilyQuery,
  rotateSession,
} from "../auth/sessions";
import { hashToken, verifyAccessToken } from "../auth/tokens";
import { countUsers, createInitialAdmin, findUserByEmail, resolveOidcUser } from "../auth/users";
import { isValidPassword, normalizeEmail, normalizeName } from "../auth/validate";
import { ErrorPage } from "../views/error";
import { LoggedOutPage } from "../views/logged-out";
import { LoginPage } from "../views/login";
import { SetupPage } from "../views/setup";

type AppContext = Context<AppEnv>;

const auth = new Hono<AppEnv>();

function nextBaseOrigin(c: AppContext): string {
  const { oidc } = c.get("config");
  return oidc ? oidc.appOrigin : new URL(c.req.url).origin;
}

export function isPrefetch(c: AppContext): boolean {
  const purpose = `${c.req.header("Sec-Purpose") ?? ""} ${c.req.header("Purpose") ?? ""}`;
  return purpose.toLowerCase().includes("prefetch");
}

function formString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// HEAD is routed here too; like prefetches, it must not rotate the refresh token.
auth.get("/login", async (c) => {
  if (c.req.method === "HEAD" || isPrefetch(c)) return c.body(null, 204);

  const config = c.get("config");
  const db = c.get("db");
  const now = clock.now();
  const next = safeNext(c.req.query("next"), nextBaseOrigin(c));

  const refreshToken = getRefreshCookie(c);
  if (refreshToken) {
    const result = await rotateSession(db, config, refreshToken, now);
    if (result.ok) {
      await setCookiesForSession(c, result.session, config.jwtSecret, now);
      return c.redirect(next, 302);
    }
    // Lost a concurrent rotation: the winner's cookies are valid.
    if (!result.clearCookies) return c.redirect(next, 302);
    clearSessionCookies(c);
  }

  if (config.oidc) {
    const { authorizationUrl, stateToken } = await startOidcLogin(config.oidc, config.jwtSecret, next, now);
    setOidcCookie(c, stateToken);
    return c.redirect(authorizationUrl.href, 302);
  }

  if ((await countUsers(db)) === 0) return c.redirect("/auth/setup", 302);
  return c.html(<LoginPage next={next} />);
});

auth.post("/login", requireMode("password"), async (c) => {
  const config = c.get("config");
  const db = c.get("db");
  const body = await c.req.parseBody();
  const emailInput = formString(body.email);
  const password = formString(body.password);
  const next = safeNext(body.next, nextBaseOrigin(c));

  const email = normalizeEmail(emailInput);
  const user = email ? await findUserByEmail(db, email) : undefined;
  let verified = false;
  if (user?.passwordHash) {
    verified = await verifyPassword(password, user.passwordHash);
  } else {
    await verifyDummyPassword(password);
  }
  if (!user || !verified) {
    return c.html(
      <LoginPage next={next} email={emailInput} error="メールアドレスまたはパスワードが違います" />,
      401,
    );
  }

  const now = clock.now();
  const session = await issueSession(db, user.id, "password", now);
  await setCookiesForSession(c, session, config.jwtSecret, now);
  return c.redirect(next, 303);
});

auth.get("/setup", requireMode("password"), async (c) => {
  if ((await countUsers(c.get("db"))) > 0) return c.notFound();
  return c.html(<SetupPage />);
});

auth.post("/setup", requireMode("password"), async (c) => {
  const config = c.get("config");
  const db = c.get("db");
  if ((await countUsers(db)) > 0) return c.notFound();

  const body = await c.req.parseBody();
  const emailInput = formString(body.email);
  const nameInput = formString(body.name);
  const password = formString(body.password);
  const passwordConfirm = formString(body.password_confirm);

  const errors: string[] = [];
  const email = normalizeEmail(emailInput);
  if (email === null) errors.push("メールアドレスの形式が正しくありません");
  const name = normalizeName(nameInput);
  if (!name.ok) errors.push("名前は 100 文字以下にしてください");
  if (!isValidPassword(password)) errors.push("パスワードは 12 文字以上 256 文字以下にしてください");
  if (password !== passwordConfirm) errors.push("パスワードと確認用のパスワードが一致しません");
  if (email === null || !name.ok || errors.length > 0) {
    return c.html(<SetupPage email={emailInput} name={nameInput} errors={errors} />, 400);
  }

  const now = clock.now();
  const user = await createInitialAdmin(db, {
    email,
    name: name.value,
    passwordHash: await hashPassword(password),
    now,
  });
  if (!user) return c.html(<ErrorPage message="すでに初期設定が完了しています" />, 409);

  const session = await issueSession(db, user.id, "password", now);
  await setCookiesForSession(c, session, config.jwtSecret, now);
  return c.redirect("/", 303);
});

auth.get("/oidc/callback", requireMode("oidc"), async (c) => {
  const config = c.get("config");
  const oidc = config.oidc;
  if (!oidc) return c.notFound();
  const db = c.get("db");
  const now = clock.now();

  const stateToken = getOidcCookie(c);
  clearOidcCookie(c);
  const state = stateToken ? await verifyOidcState(stateToken, config.jwtSecret, now) : null;
  if (!state || c.req.query("state") !== state.state) {
    return c.html(<ErrorPage message="ログインの有効期限が切れたか、リクエストが正しくありません。もう一度ログインしてください" />, 400);
  }

  const idpError = c.req.query("error");
  if (idpError !== undefined) {
    console.warn("oidc authorization error", { error: idpError, description: c.req.query("error_description") });
    return c.html(<ErrorPage message="ログインに失敗しました" />, 400);
  }

  let claims: Record<string, unknown>;
  try {
    claims = await exchangeCode(oidc, new URL(c.req.url).search, state);
  } catch (error) {
    // TODO: Network errors to the IdP are also reported as 400; revisit if a 502 is preferable.
    console.warn("oidc code exchange failed", describeError(error));
    return c.html(<ErrorPage message="ログインに失敗しました" />, 400);
  }

  const evaluated = evaluateIdTokenClaims(claims, oidc);
  if (!evaluated.ok) {
    // An empty ALLOWED_EMAILS rejects everyone. Logged with its own reason so that the misconfiguration is
    // visible; the response is the same as for an email that is not allowed.
    const reason =
      evaluated.reason === "not_allowed" && parseAllowlist(oidc.allowedEmails).length === 0
        ? "allowlist_empty"
        : evaluated.reason;
    // Log only the type of email_verified to tell a missing claim from false. Never log claim values.
    console.warn(
      "oidc login rejected",
      reason === "email_not_verified" ? { reason, email_verified: typeof claims.email_verified } : { reason },
    );
    return c.html(<ErrorPage message="このアカウントではログインできません" />, 403);
  }
  const { iss, sub } = claims;
  if (typeof iss !== "string" || typeof sub !== "string") {
    return c.html(<ErrorPage message="ログインに失敗しました" />, 400);
  }

  const resolved = await resolveOidcUser(
    db,
    { issuer: iss, subject: sub, email: evaluated.email, name: evaluated.name },
    now,
  );
  if (!resolved.ok) {
    if (resolved.reason === "conflict") {
      console.warn("oidc login rejected", { reason: "identity_conflict" });
      return c.html(<ErrorPage message="このアカウントではログインできません" />, 403);
    }
    console.error("oidc user resolution failed");
    return c.html(<ErrorPage message="ログインに失敗しました" />, 500);
  }

  const session = await issueSession(db, resolved.user.id, "oidc", now);
  await setCookiesForSession(c, session, config.jwtSecret, now);
  return c.redirect(safeNext(state.next, oidc.appOrigin), 303);
});

auth.post("/refresh", async (c) => {
  const config = c.get("config");
  const refreshToken = getRefreshCookie(c);
  if (!refreshToken) return apiError(c, 401, "invalid_refresh_token", "再ログインが必要です");

  const now = clock.now();
  const result = await rotateSession(c.get("db"), config, refreshToken, now);
  if (!result.ok) {
    if (result.clearCookies) clearSessionCookies(c);
    return apiError(c, 401, "invalid_refresh_token", "再ログインが必要です");
  }
  await setCookiesForSession(c, result.session, config.jwtSecret, now);
  return c.body(null, 204);
});

auth.post("/logout", async (c) => {
  const config = c.get("config");
  const db = c.get("db");
  const now = clock.now();

  const refreshToken = getRefreshCookie(c);
  let session = refreshToken ? await findSessionByTokenHash(db, await hashToken(refreshToken)) : undefined;
  if (!session) {
    const accessToken = getAccessCookie(c);
    const claims = accessToken
      ? await verifyAccessToken(accessToken, config.jwtSecret, now, { allowExpired: true })
      : null;
    if (claims) session = await findSessionById(db, claims.sid);
  }
  if (session) await revokeFamilyQuery(db, session.familyId, now).run();

  clearSessionCookies(c);
  return c.html(<LoggedOutPage />);
});

export default auth;
