import Link from "next/link";
import type { Metadata } from "next";
import { Database, MessagesSquare, Users, ArrowUpRight, AudioLines } from "lucide-react";
import { listDataSources } from "@/lib/queries";
import { PageHeader, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { CreateSourceDialog } from "@/components/create-source-dialog";
import { compactNumber, relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "数据源" };
export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const sources = await listDataSources();

  return (
    <>
      <PageHeader
        title="数据源"
        description="每个数据源代表一段语音对话业务，承载多次多批导入的数据、业务描述与 extra 字段 schema。"
        actions={
          <CreateSourceDialog>
            <Button size="sm">
              <Database className="size-4" />
              新建数据源
            </Button>
          </CreateSourceDialog>
        }
      />

      <div className="mx-auto max-w-[1440px] p-4 md:p-8">
        {sources.length === 0 ? (
          <EmptyState
            icon={Database}
            title="还没有数据源"
            description="创建一个数据源，写入业务描述，然后上传 zip（一个 JSONL + 音频文件）开始导入。"
            action={
              <CreateSourceDialog>
                <Button>创建数据源</Button>
              </CreateSourceDialog>
            }
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {sources.map((s) => (
              <Link
                key={s.id}
                href={`/sources/${s.id}`}
                className="group relative flex flex-col rounded-xl border border-border/70 bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-[0_18px_40px_-28px_var(--primary)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-semibold tracking-tight group-hover:text-primary">
                      {s.name}
                    </h3>
                    <div className="mt-1 line-clamp-3 min-h-[3.6em] text-[12.5px] leading-relaxed text-muted-foreground">
                      {s.description || "未填写业务描述 — AI 规划时将从抽样数据推断业务场景"}
                    </div>
                  </div>
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </div>

                <div className="mt-4 grid grid-cols-4 gap-2 border-t border-border/70 pt-3">
                  <Metric icon={MessagesSquare} label="会话" value={compactNumber(s.stats.session_count)} />
                  <Metric icon={Users} label="用户" value={compactNumber(s.stats.user_count)} />
                  <Metric icon={AudioLines} label="音频" value={compactNumber(s.stats.audio_count)} />
                  <Metric icon={Database} label="extra" value={String(s.extra_schema.length)} />
                </div>

                <div className="mt-3 flex items-center justify-between text-[11.5px] text-muted-foreground">
                  <span>{s.creator?.display_name ?? s.creator?.email ?? "—"}</span>
                  <span className="num">{relativeTime(s.created_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <div className="num mt-0.5 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}
