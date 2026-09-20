import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Encryption for the model API keys held in `ai_models.api_key_cipher`.
 *
 * AES-256-GCM, with the key derived from `MODEL_SECRET` when it is set and
 * `AUTH_SECRET` otherwise. The fallback is what makes this zero-config on an
 * existing deployment; the consequence is that rotating `AUTH_SECRET` without
 * a `MODEL_SECRET` in place makes every stored key undecryptable and the owner
 * has to paste them in again. `describe()` below is what surfaces that in the
 * UI rather than letting it turn into a confusing run-time failure.
 *
 * Nothing here ever reaches a browser: the plaintext is decrypted only in the
 * moment an OpenAI client is built, and the settings page renders `describe()`.
 */

const SALT = "voicelens.model-secret.v1";
const VERSION = "v1";
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;
let cachedFrom = "";

function key(): Buffer {
  const raw = process.env.MODEL_SECRET || process.env.AUTH_SECRET || "";
  if (raw.length < 32) {
    throw new Error(
      "MODEL_SECRET（或回退的 AUTH_SECRET）缺失或短于 32 字符，无法加密模型 API Key",
    );
  }
  // scrypt is deliberately slow; deriving it on every call would show up on a
  // page that lists a dozen models.
  if (cachedKey && cachedFrom === raw) return cachedKey;
  cachedKey = scryptSync(raw, SALT, 32);
  cachedFrom = raw;
  return cachedKey;
}

/** `v1:<iv>:<tag>:<ciphertext>`, all base64url. */
export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(
    ":",
  );
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  const [version, iv, tag, body] = stored.split(":");
  if (version !== VERSION || !iv || !tag || !body) {
    throw new Error("模型 API Key 密文格式无法识别");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  // A wrong key fails here, in `final()`, as an auth-tag mismatch.
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export interface SecretState {
  /** False when the ciphertext is present but this process cannot read it. */
  readable: boolean;
  /** Whether anything is stored at all. */
  present: boolean;
  /** `sk-…a1b2`, safe to render. Empty when nothing is stored. */
  masked: string;
}

/**
 * What the settings page shows for a stored key. An unreadable key is reported
 * as such instead of throwing, because the whole point of showing it is to tell
 * the owner which rows need re-entering after a secret rotation.
 */
export function describeSecret(stored: string): SecretState {
  if (!stored) return { readable: true, present: false, masked: "" };
  try {
    return { readable: true, present: true, masked: mask(decryptSecret(stored)) };
  } catch {
    return { readable: false, present: true, masked: "" };
  }
}

function mask(plain: string): string {
  if (plain.length <= 8) return "•".repeat(Math.max(plain.length, 4));
  return `${plain.slice(0, 3)}…${plain.slice(-4)}`;
}

/**
 * Whether a freshly submitted key is the same string already stored, so an
 * unchanged form does not rewrite the row (and re-encrypt with a new IV).
 */
export function sameSecret(stored: string, plain: string): boolean {
  try {
    const current = Buffer.from(decryptSecret(stored), "utf8");
    const next = Buffer.from(plain, "utf8");
    return current.length === next.length && timingSafeEqual(current, next);
  } catch {
    return false;
  }
}
