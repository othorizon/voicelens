import Link from "next/link";
import type { Metadata } from "next";
import {
  MessagesSquare,
  Users,
  Database,
  AudioLines,
  Timer,
  CalendarRange,
  FileArchive,
  Trash2,
  Sparkles,
  Workflow,
} from "lucide-react";
import { maybeOne } from "@/lib/db";
import { sourceStats, listBatches } from "@/lib/queries";
import { StatCard, EmptyState, StatusBadge } from "@/components/ui-kit";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { compactNumber, formatDate, relativeTime } from "@/lib/utils";
import { Sparkline, BarStrip } from "@/components/mini-charts";
import { DescriptionEditor } from "@/components/description-editor";
import { BatchActions } from "@/components/batch-actions";

export const metadata: Metadata = { title: "数据源概览" };
export const dynamic = "force-dynamic";

export default async function SourceOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [source, stats, batches] = await Promise.all([
    maybeOne<{
      id: string;
      name: string;
      description: string;
      extra_schema: unknown;
      created_at: string;
    }>(
      `select id, name, description, extra_schema, created_at from data_sources where id = $1`,
      [id],
    ),
    sourceStats(id),
    listBatches(id),
  ]);

  if (!source) return <EmptyState title="数据源不存在" />;

  const daily = ((stats.daily as { date: string; sessions: number }[] | undefined) ?? [])
    .slice()
    .reverse();
  const turnBuckets = (stats.turn_buckets as { name: string; value: number }[] | undefined) ?? [];

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 p-4 md:p-8">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="会话数" value={compactNumber(Number(stats.sessions ?? 0))} icon={MessagesSquare} />
        <StatCard label="终端用户" value={compactNumber(Number(stats.users ?? 0))} icon={Users} tone="info" />
        <StatCard label="消息总数" value={compactNumber(Number(stats.messages ?? 0))} icon={Database} tone="good" />
        <StatCard label="音频片段" value={compactNumber(Number(stats.audios ?? 0))} icon={AudioLines} tone="warn" />
        <StatCard
          label="平均轮次"
          value={String(stats.avg_turns ?? 0)}
          icon={Timer}
          hint={`${formatDate(stats.first_seen as string | null)} ~ ${formatDate(stats.last_seen as string | null)}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">业务描述</CardTitle>
            <CardDescription className="text-[12.5px]">
              这段描述会作为提示词进入「智能规划」与「报告生成」，决定 AI 分析这段数据的视角与口径。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DescriptionEditor
              sourceId={id}
              initialValue={(source.description as string) ?? ""}
            />
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border/70 pt-4">
              <Link
                href={`/sources/${id}/workflow`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <Workflow className="size-3.5" />
                编排工作流
              </Link>
              <Link
                href={`/sources/${id}/studio`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <Sparkles className="size-3.5" />
                规划与预览
              </Link>
              <Link
                href={`/sources/${id}/schema`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <Database className="size-3.5" />
                配置 extra schema
              </Link>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">每日会话量</CardTitle>
              <CardDescription className="text-[12px]">
                {daily.length ? `${daily[0]?.date} ~ ${daily[daily.length - 1]?.date}` : "暂无时间数据"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {daily.length > 1 ? (
                <Sparkline data={daily.map((d) => d.sessions)} labels={daily.map((d) => d.date.slice(5))} />
              ) : (
                <div className="py-6 text-center text-[12.5px] text-muted-foreground">
                  至少需要两天的数据才能绘制趋势
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">会话轮次分布</CardTitle>
              <CardDescription className="text-[12px]">按单个会话的对话轮次分桶</CardDescription>
            </CardHeader>
            <CardContent>
              {turnBuckets.length ? (
                <BarStrip data={turnBuckets.map((b) => ({ name: b.name, value: b.value }))} />
              ) : (
                <div className="py-6 text-center text-[12.5px] text-muted-foreground">暂无数据</div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-sm font-semibold">导入批次</CardTitle>
            <CardDescription className="text-[12.5px]">
              同一数据源可多次多批导入；音频写入对象存储，JSONL 记录会话、消息与 extra。
            </CardDescription>
          </div>
          <Link
            href={`/sources/${id}/import`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <FileArchive className="size-3.5" />
            导入新数据
          </Link>
        </CardHeader>
        <CardContent>
          {batches.length === 0 ? (
            <EmptyState
              icon={FileArchive}
              title="还没有导入任何数据"
              description="上传一个 zip 压缩包：里面放一个对话 JSONL，以及 JSONL 中引用的音频文件。"
              className="py-10"
            />
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[760px] text-[13px]">
                <thead>
                  <tr className="border-b border-border/70 text-left text-[11.5px] text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">文件</th>
                    <th className="py-2 pr-3 font-medium">状态</th>
                    <th className="py-2 pr-3 text-right font-medium">会话</th>
                    <th className="py-2 pr-3 text-right font-medium">消息</th>
                    <th className="py-2 pr-3 text-right font-medium">音频</th>
                    <th className="py-2 pr-3 font-medium">导入时间</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={String(b.id)} className="border-b border-border/40 last:border-0 hover:bg-accent/30">
                      <td className="max-w-[260px] truncate py-2.5 pr-3 font-medium">{String(b.file_name ?? "—")}</td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={String(b.status)} />
                          {b.error ? (
                            <span className="max-w-[180px] truncate text-[11px] text-destructive" title={String(b.error)}>
                              {String(b.error)}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="num py-2.5 pr-3 text-right">{Number(b.created_sessions ?? 0)}</td>
                      <td className="num py-2.5 pr-3 text-right">{Number(b.created_messages ?? 0)}</td>
                      <td className="num py-2.5 pr-3 text-right">
                        {Number(b.uploaded_audios ?? 0)}
                        {Number(b.failed_audios ?? 0) > 0 ? (
                          <span className="ml-1 text-destructive">/{Number(b.failed_audios)}</span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-3 text-[12px] text-muted-foreground" title={formatDate(String(b.created_at))}>
                        {relativeTime(String(b.created_at))}
                      </td>
                      <td className="py-2.5 text-right">
                        <BatchActions batchId={String(b.id)} sourceId={id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <CalendarRange className="size-3.5" />
        创建于 {formatDate(String(source.created_at))} · 共 {batches.length} 个导入批次
        <span className="ml-auto inline-flex items-center gap-1.5">
          <Trash2 className="size-3" />
          删除批次会同时移除该批次写入的会话、消息与音频记录
        </span>
      </div>
    </div>
  );
}
