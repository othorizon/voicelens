"use server";

import { redirect } from "next/navigation";
import { AuthError, registerUser, signIn, signOut as clearSession } from "@/lib/auth";
import { ActionError } from "./common";

/**
 * Sign-in / sign-up / sign-out, replacing the browser-side Supabase Auth calls.
 * Credentials only ever reach the server now — the browser never holds a key.
 */

function toActionError(err: unknown): never {
  if (err instanceof AuthError) throw new ActionError(err.message);
  throw new ActionError(err instanceof Error ? err.message : "操作失败");
}

export async function loginAction(email: string, password: string): Promise<void> {
  try {
    await signIn(email, password);
  } catch (err) {
    toActionError(err);
  }
}

export async function registerAction(
  email: string,
  password: string,
  displayName: string | null,
): Promise<void> {
  try {
    await registerUser(email, password, displayName);
    await signIn(email, password);
  } catch (err) {
    toActionError(err);
  }
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect("/login");
}
