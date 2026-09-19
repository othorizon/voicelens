import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data } = await supabase
    .from("template_previews")
    .select("id, html")
    .eq("id", id)
    .maybeSingle();

  if (!data?.html) notFound();

  return new Response(data.html as string, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
