import Link from "next/link";
import type { Metadata } from "next";
import { Search, MessagesSquare, AudioLines, ChevronLeft, ChevronRight, UserRound } from "lucide-react";
import { count as countRows, query } from "@/lib/db";
import { EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate } from "@/lib/utils";
import type { JsonObject } from "@/lib/types";
import { AudioChip } from "@/components/audio-chip";
import { requireSourcePage } from "@/lib/actions/common";

export const metadata: Metadata = { title: "会话数据" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

export default async function DataPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; user?: string; session?: string; page?: string; sort?: string }>;
}) {
  const { id } = await params;
  await requireSourcePage(id);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const q = sp.q?.trim() ?? "";
  const user = sp.user?.trim() ?? "";
  // Whitelisted, never interpolated from raw input.
  const sort = sp.sort === "turns" ? "turn_count" : "started_at";

  // The filters are optional, so each one is a null-guarded predicate rather
  // than a conditionally built query.
  const where = `data_source_id = $1
       and ($2::text is null or session_key ilike '%' || $2 || '%')
       and ($3::text is null or user_key = $3)`;
  const filters = [id, q || null, user || null];

  const [sessions, count, users] = await Promise.all([
    query<JsonObject>(
      `select id, session_key, user_key, started_at, ended_at, turn_count, audio_count,
              char_count, extra
       from sessions
       where ${where}
       order by ${sort} desc nulls last
       limit $4 offset $5`,
      [...filters, PAGE_SIZE, (page - 1) * PAGE_SIZE],
    ),
    countRows(`select count(*) from sessions where ${where}`, filters),
    query<{ user_key: string }>(
      `select distinct user_key from sessions where data_source_id = $1 order by user_key limit 4000`,
      [id],
    ),
  ]);

  const userList = users.map((u) => u.user_key);

  const selectedKey = sp.session;
  const selected = sessions.find((s) => s.session_key === selectedKey) ?? null;

  let detail: { session: JsonObject; messages: JsonObject[] } | null = null;
  if (selected) {
    const msgs = await query<JsonObject>(
      `select seq, role, content_text, occurred_at, audio_path, extra
       from messages
       where session_id = $1
       order by seq
       limit 600`,
      [selected.id],
    );
    detail = { session: selected, messages: msgs };
  }

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  const qs = (next: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = { q, user, sort: sp.sort, session: selectedKey, page, ...next };
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== "" && v !== null) p.set(k, String(v));
    }
    return p.toString();
  };

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 p-4 md:p-8">
      <form className="flex flex-wrap items-center gap-2" action={`/sources/${id}/data`}>
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input name="q" defaultValue={q} placeholder="搜索 session id" className="h-8 pl-8 text-[12.5px]" />
        </div>
        <Input
          name="user"
          defaultValue={user}
          placeholder="按 user id 过滤"
          list="user-keys"
          className="h-8 w-[190px] font-mono text-[12px]"
        />
        <datalist id="user-keys">
          {userList.slice(0, 300).map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
        <input type="hidden" name="sort" value={sp.sort ?? ""} />
        <Button type="submit" size="sm" variant="outline" className="h-8">
          筛选
        </Button>
        {(q || user) && (
          <Button asChild size="sm" variant="ghost" className="h-8">
            <Link href={`/sources/${id}/data`}>清除</Link>
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="num">{count}</span> 个会话
          <span className="mx-1 opacity-40">·</span>
          排序
          <Button asChild size="sm" variant={sp.sort === "turns" ? "secondary" : "ghost"} className="h-7 px-2 text-[11.5px]">
            <Link href={`/sources/${id}/data?${qs({ sort: "turns", page: 1 })}`}>轮次</Link>
          </Button>
          <Button asChild size="sm" variant={sp.sort !== "turns" ? "secondary" : "ghost"} className="h-7 px-2 text-[11.5px]">
            <Link href={`/sources/${id}/data?${qs({ sort: undefined, page: 1 })}`}>时间</Link>
          </Button>
        </div>
      </form>

      {!sessions.length ? (
        <EmptyState
          icon={MessagesSquare}
          title={count ? "没有匹配的会话" : "这个数据源还没有会话数据"}
          description={count ? "调整搜索条件试试。" : "先到「导入」页上传 zip 压缩包。"}
          action={
            !count ? (
              <Button asChild size="sm">
                <Link href={`/sources/${id}/import`}>去导入数据</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          <div className="space-y-2">
            <div className="grid gap-2">
              {sessions.map((s) => {
                const active = s.session_key === selectedKey;
                const extra = (s.extra ?? {}) as JsonObject;
                return (
                  <Link
                    key={s.id}
                    href={`/sources/${id}/data?${qs({ session: s.session_key, page })}`}
                    className={cn(
                      "group rounded-xl border bg-card p-3 transition-all",
                      active
                        ? "border-primary/60 shadow-[0_10px_30px_-22px_var(--primary)]"
                        : "border-border/70 hover:border-border",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium">
                        {s.session_key}
                      </span>
                      <span className="num shrink-0 text-[11.5px] text-muted-foreground">
                        {formatDate(s.started_at)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <UserRound className="size-3" />
                        <span className="font-mono">{s.user_key}</span>
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MessagesSquare className="size-3" />
                        <span className="num">{s.turn_count}</span> 轮
                      </span>
                      {s.audio_count ? (
                        <span className="inline-flex items-center gap-1">
                          <AudioLines className="size-3" />
                          <span className="num">{s.audio_count}</span> 段音频
                        </span>
                      ) : null}
                      {extra.resolved !== undefined && (
                        <Badge variant="outline" className="h-4 border-border/70 px-1.5 text-[10.5px] font-normal">
                          resolved={String(extra.resolved)}
                        </Badge>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button asChild size="sm" variant="outline" className="h-7" disabled={page <= 1}>
                <Link href={`/sources/${id}/data?${qs({ page: page - 1 })}`} aria-disabled={page <= 1}>
                  <ChevronLeft className="size-3.5" />
                  上一页
                </Link>
              </Button>
              <span className="num text-[11.5px] text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button asChild size="sm" variant="outline" className="h-7" disabled={page >= totalPages}>
                <Link href={`/sources/${id}/data?${qs({ page: page + 1 })}`} aria-disabled={page >= totalPages}>
                  下一页
                  <ChevronRight className="size-3.5" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="lg:sticky lg:top-[70px] lg:self-start">
            {detail ? (
              <div className="max-h-[calc(100vh-180px)] overflow-y-auto rounded-xl border border-border/70 bg-card scrollbar-thin">
                <div className="sticky top-0 z-10 border-b border-border/70 bg-card/95 px-4 py-3 backdrop-blur">
                  <div className="font-mono text-[12.5px] font-medium">{detail.session.session_key as string}</div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {String(detail.session.user_key)} · {formatDate(detail.session.started_at as string)} ·{" "}
                    {String(detail.session.turn_count)} 轮 · {detail.messages.length} 条消息
                  </div>
                </div>
                <div className="space-y-2.5 p-4">
                  {detail.messages.map((m) => (
                    <div
                      key={String(m.seq)}
                      className={cn(
                        "rounded-lg border px-3 py-2",
                        m.role === "user"
                          ? "border-border/70 bg-muted/30"
                          : "border-primary/25 bg-[color-mix(in_oklab,var(--primary)_6%,transparent)]",
                      )}
                    >
                      <div className="mb-1 flex items-center gap-2 text-[10.5px] text-muted-foreground">
                        <span className="font-medium">
                          {m.role === "user" ? "用户" : m.role === "assistant" ? "AI 助手" : String(m.role)}
                        </span>
                        <span className="num">#{String(m.seq)}</span>
                        {m.occurred_at ? <span className="num">{String(m.occurred_at).slice(11, 19)}</span> : null}
                        {m.audio_path ? <AudioChip path={String(m.audio_path)} /> : null}
                      </div>
                      <div className="text-[13px] leading-relaxed whitespace-pre-wrap">
                        {String(m.content_text ?? "")}
                      </div>
                      {m.extra && Object.keys(m.extra as JsonObject).length ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {Object.entries(m.extra as JsonObject)
                            .slice(0, 10)
                            .map(([k, v]) => (
                              <span
                                key={k}
                                className="rounded border border-border/60 bg-background/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground"
                                title={`${k} = ${JSON.stringify(v)}`}
                              >
                                {k}={typeof v === "boolean" ? String(v) : String(v).slice(0, 14)}
                              </span>
                            ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState
                icon={MessagesSquare}
                title="选择左侧会话查看完整转录"
                description="包含每条消息的角色、时间戳、extra 字段，以及可直接播放的音频（如已上传）。"
                className="py-16"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
