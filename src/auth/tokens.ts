import { sign, verify } from "hono/jwt";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ACCESS_TOKEN_ISSUER = "pinglune";
const ACCESS_TOKEN_AUDIENCE = "pinglune-web";
const REFRESH_TOKEN_BYTES = 32;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export type AccessTokenClaims = {
  sub: string;
  sid: string;
  exp: number;
};

export async function signAccessToken(
  claims: { sub: string; sid: string },
  secret: string,
  now: number,
): Promise<string> {
  const iat = Math.floor(now / 1000);
  return sign(
    {
      sub: claims.sub,
      sid: claims.sid,
      iat,
      exp: iat + ACCESS_TOKEN_TTL_SECONDS,
      iss: ACCESS_TOKEN_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
    },
    secret,
    "HS256",
  );
}

// Verifies alg, signature, iss and aud. exp is checked against `now` unless allowExpired is set
// (logout may identify the session from an expired token).
export async function verifyAccessToken(
  token: string,
  secret: string,
  now: number,
  options: { allowExpired?: boolean } = {},
): Promise<AccessTokenClaims | null> {
  let payload: Record<string, unknown>;
  try {
    payload = await verify(token, secret, {
      alg: "HS256",
      iss: ACCESS_TOKEN_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
      exp: false,
      nbf: false,
      iat: false,
    });
  } catch {
    return null;
  }
  const { sub, sid, exp } = payload;
  if (typeof sub !== "string" || typeof sid !== "string" || typeof exp !== "number" || !Number.isFinite(exp)) {
    return null;
  }
  if (!options.allowExpired && exp * 1000 <= now) return null;
  return { sub, sid, exp };
}

export function generateRefreshToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(REFRESH_TOKEN_BYTES)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
