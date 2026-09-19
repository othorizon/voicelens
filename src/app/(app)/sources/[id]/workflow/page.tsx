import type { Metadata } from "next";
import Link from "next/link";
import { ReactFlowProvider } from "@xyflow/react";
import { count, maybeOne } from "@/lib/db";
import { WorkflowCanvas } from "@/components/workflow-canvas";
import { normalizeGraph, type WfGraph } from "@/lib/workflow/graph";
import { EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Workflow } from "lucide-react";
import { requireSourcePage } from "@/lib/actions/common";

export const metadata: Metadata = { title: "工作流" };
export const dynamic = "force-dynamic";

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSourcePage(id);
  const wf = await maybeOne<{ id: string; name: string; graph: unknown }>(
    `select id, name, graph from workflows
     where data_source_id = $1
     order by updated_at desc
     limit 1`,
    [id],
  );

  const confirmed = await count(
    `select count(*) from analysis_templates where data_source_id = $1 and status = 'confirmed'`,
    [id],
  );

  if (!wf) {
    return (
      <div className="p-4 md:p-8">
        <EmptyState
          icon={Workflow}
          title="这个数据源还没有工作流"
          description="创建数据源时会自动生成默认分析流水线。若被删除，可在「工作流」页面重新创建。"
          action={
            <Button asChild size="sm">
              <Link href="/workflows">前往工作流列表</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <WorkflowCanvas
        sourceId={id}
        workflowId={wf.id as string}
        initialGraph={normalizeGraph(wf.graph as unknown) as WfGraph}
        templateReady={(confirmed ?? 0) > 0}
      />
    </ReactFlowProvider>
  );
}
