import { NextResponse } from "next/server";
import { maybeOne, query } from "@/lib/db";
import { canAccessSource, currentViewer } from "@/lib/auth/access";
import type { JsonObject } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sources/[id]/studio-state
 * Lightweight poll payload for the analysis studio (planning jobs, templates,
 * previews) so the UI can refresh without re-rendering the whole page.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await canAccessSource(viewer, id))) {
    return NextResponse.json({ error: "数据源不存在" }, { status: 404 });
  }

  const [templates, jobs, previews, source] = await Promise.all([
    query<JsonObject>(
      `select id, version, status, rationale, feedback, created_at, parent_id, metric_schema
       from analysis_templates
       where data_source_id = $1
       order by version desc
       limit 50`,
      [id],
    ),
    query<JsonObject>(
      `select id, status, kind, feedback, error, created_at, finished_at, progress, template_id
       from planning_jobs
       where data_source_id = $1
       order by created_at desc
       limit 10`,
      [id],
    ),
    query<JsonObject>(
      `select id, template_id, status, progress, error, created_at, finished_at, html, stats,
              session_results, user_results
       from template_previews
       where data_source_id = $1
       order by created_at desc
       limit 5`,
      [id],
    ),
    maybeOne<JsonObject>(
      `select id, name, description, extra_schema from data_sources where id = $1`,
      [id],
    ),
  ]);

  return NextResponse.json({
    source,
    templates,
    jobs,
    // The report html is fetched lazily through its own route; keep payloads small.
    previews: previews.map((p) => ({ ...p, hasHtml: Boolean(p.html) })),
  });
}
