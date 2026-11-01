import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { NewSession } from "./sessions";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from "./tokens";

// Names without the "__Host-" prefix; hono adds it via `prefix: "host"`.
const ACCESS_COOKIE = "pinglune_at";
const REFRESH_COOKIE = "pinglune_rt";
const OIDC_COOKIE = "pinglune_oidc";
export const OIDC_COOKIE_TTL_SECONDS = 10 * 60;

const baseOptions: CookieOptions = {
  prefix: "host",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
};

export function getAccessCookie(c: Context): string | undefined {
  return getCookie(c, ACCESS_COOKIE, "host");
}

export function getRefreshCookie(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE, "host");
}

export function setSessionCookies(
  c: Context,
  tokens: { accessToken: string; refreshToken: string; familyExpiresAt: number },
  now: number,
): void {
  setCookie(c, ACCESS_COOKIE, tokens.accessToken, { ...baseOptions, maxAge: ACCESS_TOKEN_TTL_SECONDS });
  const refreshMaxAge = Math.max(0, Math.floor((tokens.familyExpiresAt - now) / 1000));
  setCookie(c, REFRESH_COOKIE, tokens.refreshToken, { ...baseOptions, maxAge: refreshMaxAge });
}

// Signs an access token for the session and sets both session cookies.
export async function setCookiesForSession(c: Context, session: NewSession, secret: string, now: number): Promise<void> {
  const accessToken = await signAccessToken({ sub: session.userId, sid: session.sessionId }, secret, now);
  setSessionCookies(
    c,
    { accessToken, refreshToken: session.refreshToken, familyExpiresAt: session.familyExpiresAt },
    now,
  );
}

export function clearSessionCookies(c: Context): void {
  deleteCookie(c, ACCESS_COOKIE, baseOptions);
  deleteCookie(c, REFRESH_COOKIE, baseOptions);
}

export function getOidcCookie(c: Context): string | undefined {
  return getCookie(c, OIDC_COOKIE, "host");
}

export function setOidcCookie(c: Context, value: string): void {
  setCookie(c, OIDC_COOKIE, value, { ...baseOptions, maxAge: OIDC_COOKIE_TTL_SECONDS });
}

export function clearOidcCookie(c: Context): void {
  deleteCookie(c, OIDC_COOKIE, baseOptions);
}
