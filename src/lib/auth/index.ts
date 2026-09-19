import { cookies } from "next/headers";
import { hash, verify } from "@node-rs/argon2";
import { maybeOne, one } from "@/lib/db";
import {
  SESSION_COOKIE,
  cookieOptions,
  signSessionToken,
  verifySessionToken,
} from "./token";

/**
 * Email/password authentication, replacing Supabase Auth.
 *
 * Every signed-in member shares one workspace, which is the model the app had
 * before: there is no per-row ownership to enforce, only the question of
 * whether the caller is signed in at all.
 *
 * Node-runtime only — argon2 is a native binding and the queries need the
 * Postgres pool. `middleware.ts` verifies sessions through ./token instead.
 */

export interface AuthUser {
  id: string;
  email: string;
  display_name: string | null;
  avatar_color: string;
  role: string;
}

// OWASP's argon2id baseline: 19 MiB, 2 passes, 1 lane.
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash.
    return false;
  }
}

/** The signed-in user, or null. Reads the cookie and re-checks the database. */
export async function currentUser(): Promise<AuthUser | null> {
  const store = await cookies();
  const claims = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!claims) return null;

  // The token proves the session; this read proves the account still exists.
  return maybeOne<AuthUser>(
    `select id, email, display_name, avatar_color, role from users where id = $1`,
    [claims.userId],
  );
}

export async function requireUser(): Promise<AuthUser> {
  const user = await currentUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Check an email/password pair. Touches no cookies, so it is callable from
 * anywhere — `signIn` is this plus the cookie.
 */
export async function verifyCredentials(email: string, password: string): Promise<AuthUser> {
  const row = await maybeOne<AuthUser & { password_hash: string }>(
    `select id, email, display_name, avatar_color, role, password_hash
     from users where lower(email) = $1`,
    [normalizeEmail(email)],
  );

  // Same message either way, so the response cannot be used to enumerate
  // which addresses have accounts.
  const invalid = new AuthError("邮箱或密码不正确");
  if (!row) {
    // Spend comparable time on a missing account to blunt timing analysis.
    await verifyPassword(
      "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$3S1FQ1cVvV7cQVMsmGRUCfQEVHiTTRzRkcHZ0Y0mZ3A",
      password,
    );
    throw invalid;
  }
  if (!(await verifyPassword(row.password_hash, password))) throw invalid;

  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_color: row.avatar_color,
    role: row.role,
  };
}

/** Verify credentials and set the session cookie. */
export async function signIn(email: string, password: string): Promise<AuthUser> {
  const user = await verifyCredentials(email, password);
  await establishSession(user);
  return user;
}

/**
 * Create an account. Replaces the `register_user` RPC; the first account to be
 * created becomes the workspace owner.
 */
export async function registerUser(
  email: string,
  password: string,
  displayName?: string | null,
): Promise<AuthUser> {
  const normalized = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new AuthError("请填写有效的邮箱地址");
  if (password.length < 8) throw new AuthError("密码至少需要 8 个字符");

  const existing = await maybeOne<{ id: string }>(`select id from users where lower(email) = $1`, [
    normalized,
  ]);
  if (existing) throw new AuthError("该邮箱已注册");

  const isFirst = !(await maybeOne<{ id: string }>(`select id from users limit 1`));
  const palette = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

  try {
    return await one<AuthUser>(
      `insert into users (email, password_hash, display_name, avatar_color, role)
       values ($1, $2, $3, $4, $5)
       returning id, email, display_name, avatar_color, role`,
      [
        normalized,
        await hashPassword(password),
        displayName?.trim() || null,
        palette[Math.floor(Math.random() * palette.length)],
        isFirst ? "owner" : "member",
      ],
    );
  } catch (err) {
    // Two concurrent registrations race past the check above; the unique index
    // is what actually decides.
    if ((err as { code?: string }).code === "23505") throw new AuthError("该邮箱已注册");
    throw err;
  }
}

/** Issue a session cookie for an already-authenticated user. */
export async function establishSession(user: {
  id: string;
  email: string;
  display_name: string | null;
}): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, await signSessionToken(user), cookieOptions());
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", cookieOptions(0));
}

export { SESSION_COOKIE };
