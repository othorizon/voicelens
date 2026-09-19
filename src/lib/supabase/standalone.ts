import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Build a Supabase client that is *not* bound to a Next.js request context, so
 * it keeps working after the HTTP response is sent (background imports,
 * planning jobs, report generation). Pass a user access token to keep that
 * user's RLS identity, or omit it for an anonymous client.
 */
export function createStandaloneClient(accessToken?: string | null): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createSupabaseClient(url, key, {
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
