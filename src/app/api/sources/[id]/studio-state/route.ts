import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sources/[id]/studio-state
 * Lightweight poll payload for the analysis studio (planning jobs, templates,
 * previews) so the UI can refresh without re-rendering the whole page.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [{ data: templates }, { data: jobs }, { data: previews }, { data: source }] = await Promise.all([
    supabase
      .from("analysis_templates")
      .select("id, version, status, rationale, feedback, created_at, parent_id, metric_schema")
      .eq("data_source_id", id)
      .order("version", { ascending: false })
      .limit(50),
    supabase
      .from("planning_jobs")
      .select("id, status, kind, feedback, error, created_at, finished_at, progress, template_id")
      .eq("data_source_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("template_previews")
      .select(
        "id, template_id, status, progress, error, created_at, finished_at, html, stats, session_results, user_results",
      )
      .eq("data_source_id", id)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase.from("data_sources").select("id, name, description, extra_schema").eq("id", id).maybeSingle(),
  ]);

  return NextResponse.json({
    source,
    templates: templates ?? [],
    jobs: jobs ?? [],
    // The report html is fetched lazily through its own route; keep payloads small.
    previews: (previews ?? []).map((p) => ({ ...p, hasHtml: Boolean(p.html) })),
  });
}
