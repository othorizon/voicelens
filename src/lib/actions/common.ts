import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Session {
  supabase: SupabaseClient;
  userId: string;
  accessToken: string;
}

/** Server-action guard: returns the request-scoped client + user id. */
export async function requireSession(): Promise<Session> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return { supabase, userId: user.id, accessToken: session?.access_token ?? "" };
}

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

export function fail(message: string): never {
  throw new ActionError(message);
}
