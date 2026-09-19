import Link from "next/link";
import type { Metadata } from "next";
import {
  Database,
  MessagesSquare,
  Users,
  ListChecks,
  ArrowRight,
  Upload,
  Workflow,
  Sparkles,
  FileBarChart,
} from "lucide-react";
import { count } from "@/lib/db";
import { listDataSources, listTasks } from "@/lib/queries";
import { PageHeader, StatCard, StatusBadge, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateSourceDialog } from "@/components/create-source-dialog";
import { compactNumber, formatDate, relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "概览" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [sources, tasks, running] = await Promise.all([
    listDataSources(),
    listTasks(8),
    count(
      `select count(*) from analysis_tasks
       where status in ('pending', 'running', 'aggregating', 'reporting')`,
    ),
  ]);

  const totals = sources.reduce(
    (acc, s) => ({
      sessions: acc.sessions + s.stats.session_count,
      users: acc.users + s.stats.user_count,
      messages: acc.messages + s.stats.message_count,
      audios: acc.audios + s.stats.audio_count,
    }),
    { sessions: 0, users: 0, messages: 0, audios: 0 },
  );
  const completed = tasks.filter((t) => t.status === "completed").length;
  const isEmpty = sources.length === 0;

  return (
    <>
      <PageHeader
        title="概览"
        description="语音对话数据的三层分析视图：数据源 → 工作流编排 → 规划预览 → 全量分析与报告。"
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/workflows">
                <Workflow className="size-4" />
                工作流
              </Link>
            </Button>
            <CreateSourceDialog>
              <Button size="sm">
                <Database className="size-4" />
                新建数据源
              </Button>
            </CreateSourceDialog>
          </>
        }
      />

      <div className="mx-auto max-w-[1440px] space-y-6 p-4 md:p-8">
        {isEmpty ? (
          <EmptyState
            icon={Database}
            title="还没有数据源"
            description={
              <>
                数据源是一段语音对话业务的容器。创建后可以多批次导入
                <span className="mx-1 rounded bg-accent px-1.5 py-0.5 font-mono text-[12px]">zip</span>
                压缩包（内含一个 JSONL 与对应的音频文件），并为 extra 字段配置 schema，
                这些描述会直接决定后续 AI 如何做分析。
              </>
            }
            action={
              <CreateSourceDialog>
                <Button>
                  <Database className="size-4" />
                  创建第一个数据源
                </Button>
              </CreateSourceDialog>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="数据源" value={sources.length} hint={`${totals.audios ? compactNumber(totals.audios) : 0} 条音频已入库`} icon={Database} />
            <StatCard label="会话总数" value={compactNumber(totals.sessions)} hint={`${compactNumber(totals.messages)} 条消息`} icon={MessagesSquare} tone="info" />
            <StatCard label="终端用户" value={compactNumber(totals.users)} hint="按 userid 去重" icon={Users} tone="good" />
            <StatCard
              label="分析任务"
              value={running ?? 0}
              hint={`进行中 · 最近 ${completed} 个已完成`}
              icon={ListChecks}
              tone={running ? "warn" : "default"}
            />
          </div>
        )}

        {!isEmpty && (
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-sm font-semibold">数据源</CardTitle>
              <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
                <Link href="/sources">
                  全部
                  <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {sources.slice(0, 6).map((s) => (
                  <Link
                    key={s.id}
                    href={`/sources/${s.id}`}
                    className="group rounded-xl border border-border/70 bg-card p-4 transition-all hover:border-primary/50 hover:shadow-[0_8px_28px_-20px_var(--primary)]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium group-hover:text-primary">{s.name}</div>
                        <div className="mt-1 line-clamp-2 min-h-[2.2em] text-[12px] leading-relaxed text-muted-foreground">
                          {s.description || "（未填写业务描述，AI 会从抽样数据自行推断）"}
                        </div>
                      </div>
                      <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                      <span className="num">{compactNumber(s.stats.session_count)} 会话</span>
                      <span className="num">{compactNumber(s.stats.user_count)} 用户</span>
                      <span className="num">{s.extra_schema.length} 个 extra 字段</span>
                      <span className="ml-auto">{relativeTime(s.created_at)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-sm font-semibold">最近分析任务</CardTitle>
              <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
                <Link href="/tasks">
                  任务中心
                  <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="pt-0">
              {tasks.length === 0 ? (
                <div className="py-8 text-center text-[13px] text-muted-foreground">
                  还没有分析任务。先到数据源里完成「导入 → 规划 → 预览」，再启动全量分析。
                </div>
              ) : (
                <div className="divide-y divide-border/70">
                  {tasks.map((t) => (
                    <Link
                      key={t.id}
                      href={`/tasks/${t.id}`}
                      className="flex items-center gap-3 py-2.5 transition-colors hover:bg-accent/40"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{t.name}</div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                          <span className="truncate">{(t.data_sources as { name?: string } | null)?.name ?? "—"}</span>
                          <span>·</span>
                          <span>{relativeTime(t.created_at)}</span>
                        </div>
                      </div>
                      <StatusBadge status={t.status} />
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">标准作业流程</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ol className="space-y-3">
                {[
                  { icon: Upload, title: "导入数据", body: "上传 zip（JSONL + 音频），音频自动写入对象存储，可多次多批追加。", href: "/sources" },
                  { icon: Workflow, title: "编排工作流", body: "在 React Flow 画布上调整抽样、并发、是否送入音频等 8 个节点的参数。", href: "/workflows" },
                  { icon: Sparkles, title: "规划与预览", body: "三层抽样后由模型生成提示词模板，跑抽样预览报告并提交修改意见迭代。", href: "/sources" },
                  { icon: FileBarChart, title: "全量生成", body: "确认模板后启动任务，产出可下探的单页 HTML 报告。", href: "/tasks" },
                ].map((s, i) => (
                  <li key={s.title} className="flex gap-3">
                    <div className="relative flex flex-col items-center">
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-[11px] font-semibold text-accent-foreground">
                        {i + 1}
                      </span>
                      {i < 3 && <span className="mt-1 w-px flex-1 bg-border" />}
                    </div>
                    <div className="pb-1">
                      <Link href={s.href} className="text-[13px] font-medium hover:text-primary">
                        {s.title}
                      </Link>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{s.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-4 rounded-lg border border-border/70 bg-muted/40 p-3 text-[11.5px] leading-relaxed text-muted-foreground">
                最近任务完成时间：{formatDate(tasks.find((t) => t.finished_at)?.finished_at)}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
