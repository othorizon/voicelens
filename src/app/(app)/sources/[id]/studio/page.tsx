import type { Metadata } from "next";
import { count as countRows, maybeOne, query } from "@/lib/db";
import { Studio } from "@/components/studio/studio";
import type { ExtraFieldDef, JsonObject } from "@/lib/types";
import { requireSourcePage } from "@/lib/actions/common";

export const metadata: Metadata = { title: "分析工作台" };
export const dynamic = "force-dynamic";

export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSourcePage(id);
  const [source, templates, jobs, previews, wf, count] = await Promise.all([
    maybeOne<{ id: string; name: string; description: string; extra_schema: unknown }>(
      `select id, name, description, extra_schema from data_sources where id = $1`,
      [id],
    ),
    query<JsonObject>(
      `select id, version, status, rationale, feedback, created_at, parent_id, metric_schema,
              samples, session_prompt, user_prompt, global_prompt, report_prompt
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
    maybeOne<{ id: string }>(
      `select id from workflows where data_source_id = $1 order by updated_at desc limit 1`,
      [id],
    ),
    countRows(`select count(*) from sessions where data_source_id = $1`, [id]),
  ]);

  if (!source) return <div className="p-8 text-sm text-muted-foreground">数据源不存在</div>;

  return (
    <Studio
      sourceId={id}
      workflowId={wf?.id ?? null}
      sourceName={source.name}
      description={source.description ?? ""}
      extraSchema={((source.extra_schema as ExtraFieldDef[] | null) ?? []) as ExtraFieldDef[]}
      sessionCount={count}
      initial={{
        templates: templates as never,
        jobs: jobs as never,
        previews: previews.map((p) => ({ ...p, hasHtml: Boolean(p.html) })) as never,
      }}
    />
  );
}
