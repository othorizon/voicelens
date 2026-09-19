import Link from "next/link";
import type { Metadata } from "next";
import { ListChecks, FileBarChart, ArrowUpRight, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { listTasks } from "@/lib/queries";
import { PageHeader, StatusBadge, StageLabel, EmptyState } from "@/components/ui-kit";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { compactNumber, formatDate, formatDuration, relativeTime } from "@/lib/utils";
import type { JsonObject } from "@/lib/types";

export const metadata: Metadata = { title: "分析任务" };
export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const supabase = await createClient();
  const tasks = await listTasks(supabase, 100);
  const hasActive = tasks.some((t) => ["pending", "running", "aggregating", "reporting"].includes(t.status));

  return (
    <>
      <AutoRefresh enabled={hasActive} />
      <PageHeader
        title="分析任务"
        description="每个任务保存自己的状态、三层结果与最终报告。任务由后台 Worker 执行，可按增量或时间范围重跑。"
      />
      <div className="mx-auto max-w-[1440px] p-4 md:p-8">
        {tasks.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="还没有分析任务"
            description="在数据源的分析工作台里确认模板后，即可启动全量分析任务。"
            action={
              <Button asChild size="sm">
                <Link href="/sources">前往数据源</Link>
              </Button>
            }
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[900px] text-[13px]">
                  <thead>
                    <tr className="border-b border-border/70 text-left text-[11.5px] text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">任务</th>
                      <th className="px-3 py-2.5 font-medium">状态</th>
                      <th className="px-3 py-2.5 font-medium">进度</th>
                      <th className="px-3 py-2.5 text-right font-medium">会话 / 用户</th>
                      <th className="px-3 py-2.5 font-medium">耗时</th>
                      <th className="px-3 py-2.5 font-medium">创建时间</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => {
                      const p = (t.progress ?? {}) as JsonObject;
                      const total = Number(p.total ?? 0);
                      const done = Number(p.done ?? 0);
                      const stats = (t.stats ?? {}) as JsonObject;
                      const duration =
                        t.started_at && t.finished_at
                          ? Date.parse(t.finished_at) - Date.parse(t.started_at)
                          : t.started_at
                            ? Date.now() - Date.parse(t.started_at)
                            : null;
                      return (
                        <tr key={t.id} className="border-b border-border/40 transition-colors last:border-0 hover:bg-accent/30">
                          <td className="px-4 py-3">
                            <Link href={`/tasks/${t.id}`} className="group block">
                              <div className="font-medium group-hover:text-primary">{t.name}</div>
                              <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                                <span className="truncate">
                                  {(t.data_sources as { name?: string } | null)?.name ?? "—"}
                                </span>
                                <span>·</span>
                                <span>{t.scope_type === "range" ? "时间范围" : "增量"}</span>
                                <span>·</span>
                                <StageLabel stage={t.stage} />
                              </div>
                            </Link>
                          </td>
                          <td className="px-3 py-3">
                            <StatusBadge status={t.status} />
                          </td>
                          <td className="w-[160px] px-3 py-3">
                            {total ? (
                              <div className="space-y-1">
                                <Progress value={Math.round((done / total) * 100)} className="h-1" />
                                <div className="num text-[11px] text-muted-foreground">
                                  {done} / {total}
                                </div>
                              </div>
                            ) : (
                              <span className="text-[11.5px] text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="num px-3 py-3 text-right">
                            {compactNumber(Number(stats.sessions_ok ?? done))} / {compactNumber(Number(stats.users ?? 0))}
                          </td>
                          <td className="px-3 py-3">
                            <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                              <Clock className="size-3" />
                              <span className="num">{formatDuration(duration)}</span>
                            </span>
                          </td>
                          <td className="px-3 py-3 text-[11.5px] text-muted-foreground" title={formatDate(t.created_at)}>
                            {relativeTime(t.created_at)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {t.status === "completed" ? (
                              <Link
                                href={`/api/report/task/${t.id}`}
                                target="_blank"
                                className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                              >
                                <FileBarChart className="size-3" />
                                报告
                                <ArrowUpRight className="size-3" />
                              </Link>
                            ) : (
                              <Link
                                href={`/tasks/${t.id}`}
                                className="text-[11.5px] text-muted-foreground transition-colors hover:text-primary"
                              >
                                详情
                              </Link>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
