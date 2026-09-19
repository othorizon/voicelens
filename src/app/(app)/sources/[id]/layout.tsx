import Link from "next/link";
import { notFound } from "next/navigation";
import {
  LayoutDashboard,
  Database,
  Braces,
  Upload,
  Workflow,
  Sparkles,
  ArrowLeft,
  MessagesSquare,
  Users,
} from "lucide-react";
import { maybeOne } from "@/lib/db";
import { sourceStats } from "@/lib/queries";
import { requireSourcePage } from "@/lib/actions/common";
import { SourceNav } from "@/components/source-nav";
import { Button } from "@/components/ui/button";
import { compactNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SourceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireSourcePage(id);
  const source = await maybeOne<{
    id: string;
    name: string;
    extra_schema: unknown;
    status: string;
  }>(`select id, name, extra_schema, status from data_sources where id = $1`, [id]);

  if (!source) notFound();
  const stats = await sourceStats(id);

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border/70 bg-background/70 backdrop-blur-md">
        <div className="mx-auto max-w-[1440px] px-4 pt-4 md:px-8">
          <div className="mb-3 flex flex-wrap items-start gap-3">
            <Button asChild variant="ghost" size="icon" className="size-8 shrink-0">
              <Link href="/sources" aria-label="返回数据源列表">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-semibold tracking-tight">
                  {(source.name as string) ?? "数据源"}
                </h1>
                <span className="rounded-full border border-border/70 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                  {String(source.id).slice(0, 8)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <MessagesSquare className="size-3" />
                  <span className="num">{compactNumber(Number(stats.sessions ?? 0))}</span> 会话
                </span>
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3" />
                  <span className="num">{compactNumber(Number(stats.users ?? 0))}</span> 用户
                </span>
                <span className="inline-flex items-center gap-1">
                  <Database className="size-3" />
                  <span className="num">{compactNumber(Number(stats.messages ?? 0))}</span> 消息
                </span>
                <span className="inline-flex items-center gap-1">
                  <Braces className="size-3" />
                  <span className="num">{((source.extra_schema as unknown[]) ?? []).length}</span> extra 字段
                </span>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button asChild variant="outline" size="sm" className="h-8">
                <Link href={`/sources/${id}/import`}>
                  <Upload className="size-3.5" />
                  导入数据
                </Link>
              </Button>
              <Button asChild size="sm" className="h-8">
                <Link href={`/sources/${id}/studio`}>
                  <Sparkles className="size-3.5" />
                  分析工作台
                </Link>
              </Button>
            </div>
          </div>

          <SourceNav
            id={id}
            items={[
              { href: `/sources/${id}`, label: "概览", icon: "layout-dashboard", exact: true },
              { href: `/sources/${id}/data`, label: "会话数据", icon: "messages-square" },
              { href: `/sources/${id}/import`, label: "导入", icon: "upload" },
              { href: `/sources/${id}/schema`, label: "字段 Schema", icon: "braces" },
              { href: `/sources/${id}/workflow`, label: "工作流", icon: "workflow" },
              { href: `/sources/${id}/studio`, label: "分析工作台", icon: "sparkles" },
            ]}
          />
        </div>
      </header>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
