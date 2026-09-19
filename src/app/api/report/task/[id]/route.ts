import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data } = await supabase
    .from("analysis_tasks")
    .select("id, name, report_html")
    .eq("id", id)
    .maybeSingle();

  if (!data?.report_html) notFound();

  const download = new URL(req.url).searchParams.get("download") === "1";
  const safeName = String(data.name ?? "report")
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 60);

  return new Response(data.report_html as string, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(download
        ? { "content-disposition": `attachment; filename="voicelens-${safeName}.html"; filename*=UTF-8''${encodeURIComponent(`voicelens-${safeName}.html`)}` }
        : {}),
    },
  });
}
