import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileBarChart, ExternalLink, Download, Layers, Users, MessagesSquare } from "lucide-react";
import { callJson, count as countRows, maybeOne } from "@/lib/db";
import { TaskLive } from "@/components/task-live";
import { DrillExplorer } from "@/components/drill-explorer";
import { BarStrip, Donut } from "@/components/mini-charts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui-kit";
import { cn, compactNumber, formatDate } from "@/lib/utils";
import type { JsonObject } from "@/lib/types";

export const metadata: Metadata = { title: "任务详情" };
export const dynamic = "force-dynamic";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The embedded resources are left joins now, flattened back into the nested
  // shape this page already reads.
  const task = await maybeOne<JsonObject>(
    `select t.id, t.name, t.status, t.stage, t.progress, t.stats, t.error, t.created_at,
            t.started_at, t.finished_at, t.data_source_id, t.template_id, t.scope_type,
            t.range_start, t.range_end, t.report, t.report_html, t.config,
            d.name as source_name, tpl.version as template_version,
            p.display_name as creator_name
     from analysis_tasks t
     left join data_sources d on d.id = t.data_source_id
     left join analysis_templates tpl on tpl.id = t.template_id
     left join profiles p on p.id = t.created_by
     where t.id = $1`,
    [id],
  );

  if (!task) notFound();

  const t: JsonObject = {
    ...task,
    data_sources: task.source_name ? { name: task.source_name } : null,
    analysis_templates: task.template_version != null ? { version: task.template_version } : null,
    profiles: { display_name: task.creator_name ?? null },
  };
  const completed = t.status === "completed";

  const [globalRes, sessionStats, userStats, userCount] = await Promise.all([
    maybeOne<{ result: JsonObject | null; status: string }>(
      `select result, status from task_global_result where task_id = $1`,
      [id],
    ),
    completed ? callJson<JsonObject>("task_session_stats", [id, "all", null]) : null,
    completed ? callJson<JsonObject>("task_user_stats", [id]) : null,
    countRows(`select count(*) from task_session_results where task_id = $1`, [id]),
  ]);

  const g = (globalRes?.result ?? {}) as JsonObject;
  const ss = (sessionStats ?? {}) as JsonObject;
  const us = (userStats ?? {}) as JsonObject;
  const dist = (ss.distributions ?? {}) as JsonObject;

  return (
    <>
      <div className="border-b border-border/70 bg-background/60 px-4 py-5 backdrop-blur md:px-8">
        <div className="mx-auto max-w-[1440px]">
          <nav className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Link href="/tasks" className="transition-colors hover:text-foreground">
              分析任务
            </Link>
            <span className="opacity-50">/</span>
            <Link
              href={`/sources/${String(t.data_source_id)}`}
              className="transition-colors hover:text-foreground"
            >
              {String((t.data_sources as JsonObject | null)?.name ?? "数据源")}
            </Link>
            <span className="opacity-50">/</span>
            <span className="text-foreground">{String(t.name)}</span>
          </nav>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight md:text-xl">{String(t.name)}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                <span>
                  {t.scope_type === "range" ? "时间范围" : "增量未分析"}
                  {t.range_start || t.range_end
                    ? ` ${formatDate(String(t.range_start ?? "")).slice(0, 10)} ~ ${formatDate(String(t.range_end ?? "")).slice(0, 10)}`
                    : ""}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Layers className="size-3" />
                  模板 v{String((t.analysis_templates as JsonObject | null)?.version ?? "?")}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3" />
                  {String((t.profiles as JsonObject | null)?.display_name ?? "—")}
                </span>
                <span className="num">{formatDate(String(t.created_at))}</span>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {completed && t.report_html ? (
                <>
                  <Button asChild size="sm" variant="outline" className="h-8">
                    <a href={`/api/report/task/${id}`} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-3.5" />
                      新窗口打开报告
                    </a>
                  </Button>
                  <Button asChild size="sm" className="h-8">
                    <a href={`/api/report/task/${id}?download=1`} download={`voicelens-${String(t.name).slice(0, 40)}.html`}>
                      <Download className="size-3.5" />
                      下载报告
                    </a>
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1440px] space-y-5 p-4 md:p-8">
        <TaskLive
          taskId={id}
          initial={{
            status: String(t.status),
            stage: String(t.stage ?? ""),
            progress: (t.progress ?? {}) as JsonObject,
            stats: (t.stats ?? {}) as JsonObject,
            error: (t.error as string | null) ?? null,
            started_at: (t.started_at as string | null) ?? null,
            finished_at: (t.finished_at as string | null) ?? null,
          }}
          canRerun={Boolean(t.data_source_id)}
        />

        {!completed ? (
          <EmptyState
            title={t.status === "failed" ? "任务失败，未产出报告" : "任务尚未完成"}
            description={
              t.status === "failed"
                ? "查看上方日志定位原因，修正模板或数据后点击「重跑」。"
                : "Worker 正在按 会话 → 用户 → 全局 → 报告 的顺序执行，完成后报告会显示在这里。"
            }
            className="py-12"
          />
        ) : (
          <>
            {/* ---------------------------------------------------- 全局结论 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <FileBarChart className="size-4 text-primary" />
                  全局层结论
                </CardTitle>
                <CardDescription className="text-[12.5px]">
                  由全局层提示词基于 {String(ss.session_count ?? 0)} 个会话、
                  {String(us.user_count ?? userCount ?? 0)} 个用户的汇总结果生成。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {g.summary ? (
                  <p className="rounded-xl border border-border/70 bg-muted/25 p-4 text-[13.2px] leading-relaxed">
                    {String(g.summary)}
                  </p>
                ) : null}

                {Array.isArray(g.findings) && g.findings.length > 0 && (
                  <div className="grid gap-2.5 md:grid-cols-2">
                    {(g.findings as JsonObject[]).map((f, i) => (
                      <div
                        key={i}
                        className={cn(
                          "rounded-xl border p-3.5",
                          f.severity === "critical"
                            ? "border-destructive/40 bg-destructive/8"
                            : f.severity === "warning"
                              ? "border-[var(--warning)]/40 bg-[color-mix(in_oklab,var(--warning)_8%,transparent)]"
                              : "border-border/70 bg-card",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "rounded px-1.5 py-px text-[10px] font-semibold",
                              f.severity === "critical"
                                ? "bg-destructive/15 text-destructive"
                                : f.severity === "warning"
                                  ? "bg-[var(--warning)]/18 text-[var(--warning)]"
                                  : "bg-accent text-accent-foreground",
                            )}
                          >
                            {String(f.severity ?? "info").toUpperCase()}
                          </span>
                          <span className="text-[13px] font-semibold">{String(f.title ?? "")}</span>
                        </div>
                        <p className="mt-1.5 text-[12.2px] leading-relaxed text-muted-foreground">
                          {String(f.detail ?? "")}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {Array.isArray(g.recommendations) && g.recommendations.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                        建议
                      </div>
                      <div className="grid gap-2.5 md:grid-cols-2">
                        {(g.recommendations as JsonObject[]).map((r, i) => (
                          <div key={i} className="rounded-xl border border-border/70 bg-card p-3.5">
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "rounded px-1.5 py-px text-[10px] font-semibold",
                                  r.priority === "high"
                                    ? "bg-destructive/12 text-destructive"
                                    : r.priority === "medium"
                                      ? "bg-[var(--warning)]/15 text-[var(--warning)]"
                                      : "bg-accent text-accent-foreground",
                                )}
                              >
                                {String(r.priority ?? "medium").toUpperCase()}
                              </span>
                              <span className="text-[12.8px] font-medium">{String(r.title ?? "")}</span>
                            </div>
                            <p className="mt-1.5 text-[12.2px] leading-relaxed text-muted-foreground">
                              {String(r.detail ?? "")}
                            </p>
                            {r.impact ? (
                              <div className="mt-1.5 text-[11px] text-muted-foreground">影响面：{String(r.impact)}</div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* -------------------------------------------------- 真实统计 */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">会话结果分布</CardTitle>
                  <CardDescription className="text-[12px]">
                    由 Postgres 直接从 {String(ss.session_count ?? 0)} 条会话层结果聚合，非模型生成
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Mini label="平均质量分" value={String(ss.avg_quality ?? "—")} />
                    <Mini label="高危占比" value={`${String(ss.risky_ratio ?? 0)}%`} />
                    <Mini label="会话数" value={compactNumber(Number(ss.session_count ?? 0))} />
                    <Mini label="模型指标" value={String((ss.metrics as unknown[] | undefined)?.length ?? 0)} />
                  </div>
                  <DistBlock title="结果 outcome" items={dist.outcome as { name: string; value: number }[] | undefined} />
                  <DistBlock title="情绪 sentiment" items={dist.sentiment as { name: string; value: number }[] | undefined} />
                  <DistBlock title="风险等级" items={dist.risk_level as { name: string; value: number }[] | undefined} />
                  <DistBlock title="质量分分桶" items={ss.quality_buckets as { name: string; value: number }[] | undefined} />
                  <DistBlock title="Top 意图" items={dist.intent as { name: string; value: number }[] | undefined} />
                  <DistBlock title="Top 标签" items={dist.tags as { name: string; value: number }[] | undefined} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">问题与用户层</CardTitle>
                  <CardDescription className="text-[12px]">
                    会话层 problems 的高频项与用户层聚合指标
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <DistBlock
                    title="高频问题（会话层）"
                    items={dist.problems as { name: string; value: number }[] | undefined}
                  />
                  <DistBlock title="高频诉求（用户层）" items={us.top_needs as { name: string; value: number }[] | undefined} />
                  <DistBlock title="用户层标签" items={us.top_tags as { name: string; value: number }[] | undefined} />
                  <div className="grid grid-cols-2 gap-2">
                    <Mini label="用户数" value={String(us.user_count ?? userCount ?? 0)} />
                    <Mini label="风险用户" value={String(us.risk_count ?? 0)} tone={Number(us.risk_count ?? 0) > 0 ? "warn" : undefined} />
                  </div>
                  <MetricList title="模型定义的度量（会话层均值）" metrics={ss.metrics as JsonObject[] | undefined} />
                  <MetricList title="模型定义的度量（用户层均值）" metrics={us.metrics as JsonObject[] | undefined} />
                </CardContent>
              </Card>
            </div>

            {/* ------------------------------------------------------ 报告 */}
            {t.report_html ? (
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div className="space-y-1">
                    <CardTitle className="text-sm font-semibold">动态生成的单页报告</CardTitle>
                    <CardDescription className="text-[12px]">
                      报告本身自带三层下探：章节内的下探按钮与末尾的用户索引都可点开抽屉查看用户画像与会话转录。
                    </CardDescription>
                  </div>
                  <Button asChild size="sm" variant="ghost" className="h-8">
                    <a href={`/api/report/task/${id}`} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-3.5" />
                      全屏
                    </a>
                  </Button>
                </CardHeader>
                <CardContent>
                  <iframe
                    src={`/api/report/task/${id}`}
                    title="分析报告"
                    className="h-[720px] w-full rounded-xl border border-border/70 bg-white"
                  />
                </CardContent>
              </Card>
            ) : null}

            {/* -------------------------------------------------- 三层下探 */}
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">三层结果下探</h2>
                <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                  <MessagesSquare className="size-3" />
                  全局 → 用户 → 会话（含完整转录与音频播放）
                </span>
              </div>
              <DrillExplorer taskId={id} />
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className={cn("num mt-0.5 text-[15px] font-semibold", tone === "warn" && "text-[var(--warning)]")}>
        {value}
      </div>
    </div>
  );
}

function DistBlock({ title, items }: { title: string; items?: { name: string; value: number }[] }) {
  if (!items?.length) return null;
  const top = items.slice(0, 8);
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3">
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{title}</div>
        <BarStrip data={top} />
      </div>
      {top.length >= 2 && top.length <= 7 ? (
        <div className="hidden self-center sm:block">
          <Donut data={top} size={86} />
        </div>
      ) : null}
    </div>
  );
}

function MetricList({ title, metrics }: { title: string; metrics?: JsonObject[] }) {
  if (!metrics?.length) return null;
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{title}</div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {metrics.slice(0, 12).map((m, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-border/60 px-2.5 py-1.5">
            <span className="truncate text-[11.5px] text-muted-foreground">{String(m.label ?? m.key)}</span>
            <span className="num text-[12px] font-semibold">
              {String(m.avg ?? m.value ?? "—")}
              <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{String(m.unit ?? "")}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
