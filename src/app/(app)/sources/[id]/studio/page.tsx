import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { Studio } from "@/components/studio/studio";
import type { ExtraFieldDef, JsonObject } from "@/lib/types";

export const metadata: Metadata = { title: "分析工作台" };
export const dynamic = "force-dynamic";

export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: source }, { data: templates }, { data: jobs }, { data: previews }, { data: wf }, { count }] =
    await Promise.all([
      supabase.from("data_sources").select("id, name, description, extra_schema").eq("id", id).maybeSingle(),
      supabase
        .from("analysis_templates")
        .select(
          "id, version, status, rationale, feedback, created_at, parent_id, metric_schema, samples, session_prompt, user_prompt, global_prompt, report_prompt",
        )
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
        .select("id, template_id, status, progress, error, created_at, finished_at, html, stats, session_results, user_results")
        .eq("data_source_id", id)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase.from("workflows").select("id").eq("data_source_id", id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("sessions").select("id", { count: "exact", head: true }).eq("data_source_id", id),
    ]);

  if (!source) return <div className="p-8 text-sm text-muted-foreground">数据源不存在</div>;

  return (
    <Studio
      sourceId={id}
      workflowId={(wf?.id as string | undefined) ?? null}
      sourceName={source.name as string}
      description={(source.description as string) ?? ""}
      extraSchema={((source.extra_schema as ExtraFieldDef[] | null) ?? []) as ExtraFieldDef[]}
      sessionCount={count ?? 0}
      initial={{
        templates: (templates ?? []) as never,
        jobs: (jobs ?? []) as never,
        previews: ((previews ?? []) as JsonObject[]).map((p) => ({ ...p, hasHtml: Boolean(p.html) })) as never,
      }}
    />
  );
}
