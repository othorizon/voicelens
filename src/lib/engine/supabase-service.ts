import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SERVICE_ACCOUNT } from "./env";

let cached: Promise<SupabaseClient> | null = null;

/**
 * Machine client used by the background worker and by server-side long
 * running operations (imports, planning, report generation).
 *
 * Supabase has no service-role key available in this deployment, so the worker
 * authenticates as a dedicated member account. RLS treats it exactly like any
 * other signed-in user of the team workspace. The account is created on first
 * use through the `register_user` RPC and never expires.
 */
export async function getServiceClient(): Promise<SupabaseClient> {
  if (cached) return cached;
  cached = (async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new Error("Supabase env missing");

    const anon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await anon.auth.signInWithPassword({
      email: SERVICE_ACCOUNT.email,
      password: SERVICE_ACCOUNT.password,
    });

    if (error) {
      const { error: created } = await anon.rpc("register_user", {
        p_email: SERVICE_ACCOUNT.email,
        p_password: SERVICE_ACCOUNT.password,
        p_display_name: "分析引擎",
      });
      if (created) throw new Error(`service account unavailable: ${created.message}`);

      const retried = await anon.auth.signInWithPassword({
        email: SERVICE_ACCOUNT.email,
        password: SERVICE_ACCOUNT.password,
      });
      if (retried.error) throw new Error(`service account sign-in failed: ${retried.error.message}`);
      return createAuthenticatedClient(retried.data.session!.access_token);
    }

    return createAuthenticatedClient(data.session!.access_token);
  })();

  try {
    return await cached;
  } catch (e) {
    cached = null;
    throw e;
  }
}

function createAuthenticatedClient(accessToken: string): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
