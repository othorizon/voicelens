import type { Metadata } from "next";
import { count as countRows, maybeOne } from "@/lib/db";
import { Studio } from "@/components/studio/studio";
import type { ExtraFieldDef } from "@/lib/types";
import { loadStudioState } from "@/lib/queries";
import { requireSourcePage } from "@/lib/actions/common";
import { configFromGraph, normalizeGraph } from "@/lib/workflow/graph";

export const metadata: Metadata = { title: "分析工作台" };
export const dynamic = "force-dynamic";

export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSourcePage(id);
  const [source, studio, wf, count] = await Promise.all([
    maybeOne<{ id: string; name: string; description: string; extra_schema: unknown }>(
      `select id, name, description, extra_schema from data_sources where id = $1`,
      [id],
    ),
    loadStudioState(id),
    maybeOne<{ id: string; graph: unknown }>(
      `select id, graph from workflows where data_source_id = $1 order by updated_at desc limit 1`,
      [id],
    ),
    countRows(`select count(*) from sessions where data_source_id = $1`, [id]),
  ]);

  if (!source) return <div className="p-8 text-sm text-muted-foreground">数据源不存在</div>;

  // The workbench shows the same switches as the canvas, so it has to start
  // from the same values — otherwise the two pages disagree and whichever
  // page you pressed the button on wins.
  const wfConfig = configFromGraph(wf ? normalizeGraph(wf.graph) : null);

  return (
    <Studio
      sourceId={id}
      workflowId={wf?.id ?? null}
      sourceName={source.name}
      description={source.description ?? ""}
      extraSchema={((source.extra_schema as ExtraFieldDef[] | null) ?? []) as ExtraFieldDef[]}
      sessionCount={count}
      initial={studio as never}
      runParams={{ plan: wfConfig.plan, preview: wfConfig.preview }}
    />
  );
}
