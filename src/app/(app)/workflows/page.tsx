import Link from "next/link";
import type { Metadata } from "next";
import { Workflow, ArrowUpRight, Sparkles, Database } from "lucide-react";
import { query } from "@/lib/db";
import { listWorkflows } from "@/lib/queries";
import { PageHeader, EmptyState } from "@/components/ui-kit";
import { Badge } from "@/components/ui/badge";
import { configFromGraph, normalizeGraph } from "@/lib/workflow/graph";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "工作流" };
export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const [workflows, sources] = await Promise.all([
    listWorkflows(),
    query<{ id: string; name: string }>(
      `select id, name from data_sources order by created_at desc`,
    ),
  ]);
  const sourceName = new Map(sources.map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader
        title="工作流"
        description="每个数据源对应一条可视化分析流水线，节点参数决定抽样规模、并发、是否送入音频与报告风格。"
      />
      <div className="mx-auto max-w-[1440px] p-4 md:p-8">
        {workflows.length === 0 ? (
          <EmptyState
            icon={Workflow}
            title="还没有工作流"
            description="新建数据源时会自动生成默认流水线。"
            action={<ButtonLike href="/sources">去数据源</ButtonLike>}
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {workflows.map((w) => {
              const graph = normalizeGraph(w.graph as unknown);
              const config = configFromGraph(graph);
              const ds = w.data_source_id as string;
              const enabled = graph.nodes.filter((n) => !n.data?.disabled).length;
              return (
                <Link
                  key={String(w.id)}
                  href={`/sources/${ds}/workflow`}
                  className="group flex flex-col rounded-xl border border-border/70 bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-[0_18px_40px_-28px_var(--primary)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-semibold tracking-tight group-hover:text-primary">
                        {String(w.name)}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                        <Database className="size-3" />
                        <span className="truncate">{sourceName.get(ds) ?? "未知数据源"}</span>
                      </div>
                    </div>
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="gap-1 py-0.5 text-[10.5px] font-normal">
                      <Workflow className="size-2.5" />
                      {enabled}/{graph.nodes.length} 节点启用
                    </Badge>
                    <Badge variant="outline" className="py-0.5 text-[10.5px] font-normal">
                      并发 {config.session.concurrency}
                    </Badge>
                    <Badge variant="outline" className="py-0.5 text-[10.5px] font-normal">
                      {config.session.useAudio ? "会话层送音频" : "仅转录文本"}
                    </Badge>
                    <Badge variant="outline" className="py-0.5 text-[10.5px] font-normal">
                      {config.scope.mode === "range" ? "时间范围" : "增量未分析"}
                    </Badge>
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5 text-[11.5px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Sparkles className="size-3" />
                      报告 {config.report.sections} 章节 · {config.report.language === "en" ? "EN" : "中文"}
                    </span>
                    <span className="num">{relativeTime(String(w.updated_at))}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function ButtonLike({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground"
    >
      {children}
    </Link>
  );
}

