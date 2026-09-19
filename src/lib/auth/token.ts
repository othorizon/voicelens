import { SignJWT, jwtVerify } from "jose";

/**
 * Session token primitives. This module is deliberately dependency-light —
 * `jose` runs on the Edge runtime, so `middleware.ts` can verify a session
 * without pulling in the Postgres driver or the native argon2 binding.
 */

export const SESSION_COOKIE = "voicelens_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
/** Re-issue a token once it is this close to expiring, so active users stay in. */
export const SESSION_REFRESH_WITHIN_SECONDS = 60 * 60 * 24 * 3;

const ISSUER = "voicelens";
const ALG = "HS256";

export interface SessionClaims {
  userId: string;
  email: string;
  displayName: string | null;
  /** Expiry, seconds since epoch. */
  exp: number;
}

let cachedKey: Uint8Array | null = null;

function secret(): Uint8Array {
  if (cachedKey) return cachedKey;
  const raw = process.env.AUTH_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error("AUTH_SECRET is missing or shorter than 32 characters");
  }
  cachedKey = new TextEncoder().encode(raw);
  return cachedKey;
}

export async function signSessionToken(user: {
  id: string;
  email: string;
  display_name: string | null;
}): Promise<string> {
  return new SignJWT({ email: user.email, name: user.display_name })
    .setProtectedHeader({ alg: ALG })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret());
}

/** Verify a token, returning null for anything malformed, expired or unsigned. */
export async function verifySessionToken(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      algorithms: [ALG],
    });
    if (!payload.sub || typeof payload.exp !== "number") return null;
    return {
      userId: payload.sub,
      email: typeof payload.email === "string" ? payload.email : "",
      displayName: typeof payload.name === "string" ? payload.name : null,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

export function cookieOptions(maxAgeSeconds = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Allow plain HTTP in development; require HTTPS everywhere else.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
