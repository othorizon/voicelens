"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  Globe,
  Loader2,
  MessagesSquare,
  Search,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { AudioChip } from "@/components/audio-chip";
import { cn, formatDate } from "@/lib/utils";
import type { JsonObject } from "@/lib/types";

type Level = "users" | "sessions" | "session";

interface UserRow extends JsonObject {
  user_key: string;
  session_count: number;
  status: string;
  summary: string;
  persona: string;
  risk_level: string;
  tags: string[];
  needs: string[];
  metrics: { key: string; label: string; value: number; unit?: string }[];
}

interface SessionRow extends JsonObject {
  session_key: string;
  user_key: string;
  status: string;
  summary: string;
  intent: string;
  outcome: string;
  sentiment: string;
  quality_score: number | null;
  risk_level: string;
  tags: string[];
}

const PAGE_SIZE = 50;

export function DrillExplorer({ taskId }: { taskId: string }) {
  const [level, setLevel] = useState<Level>("users");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [detail, setDetail] = useState<{ result: JsonObject; meta: JsonObject | null; transcript: TranscriptLine[] } | null>(null);
  const [userKey, setUserKey] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchLevel = useCallback(
    async (params: { level: Level; q?: string; user?: string; key?: string; page?: number }) => {
      setLoading(true);
      try {
        const usp = new URLSearchParams();
        usp.set("level", params.level ?? "users");
        if (params.q) usp.set("q", params.q);
        if (params.user) usp.set("user", params.user);
        if (params.key) usp.set("key", params.key);
        usp.set("page", String(params.page ?? 1));
        const res = await fetch(`/api/tasks/${taskId}/results?${usp.toString()}`);
        const json = (await res.json()) as JsonObject;

        if (params.level === "users") {
          setUsers((json.rows ?? []) as UserRow[]);
          setTotal(Number(json.total ?? 0));
        } else if (params.level === "sessions") {
          setSessions((json.rows ?? []) as SessionRow[]);
          setTotal(Number(json.total ?? 0));
        } else {
          setDetail({
            result: (json.result?.result ?? {}) as JsonObject,
            meta: (json.meta ?? null) as JsonObject | null,
            transcript: (json.transcript ?? []) as TranscriptLine[],
          });
        }
      } finally {
        setLoading(false);
      }
    },
    [taskId],
  );

  useEffect(() => {
    void fetchLevel({ level: "users" });
  }, [fetchLevel]);

  function goUsers() {
    setLevel("users");
    setUserKey(null);
    setSessionKey(null);
    setPage(1);
    setQ("");
    void fetchLevel({ level: "users" });
  }

  function goSessions(key: string) {
    setLevel("sessions");
    setUserKey(key);
    setSessionKey(null);
    setPage(1);
    setQ("");
    void fetchLevel({ level: "sessions", user: key });
  }

  function goSession(key: string) {
    setLevel("session");
    setSessionKey(key);
    void fetchLevel({ level: "session", key });
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/70 px-4 py-2.5">
        <Crumb icon={<Globe className="size-3" />} label="全局" active={level === "users"} onClick={goUsers} />
        {userKey && (
          <>
            <ChevronRight className="size-3 text-muted-foreground/50" />
            <Crumb
              icon={<UserRound className="size-3" />}
              label={userKey}
              active={level === "sessions"}
              onClick={() => goSessions(userKey)}
            />
          </>
        )}
        {sessionKey && (
          <>
            <ChevronRight className="size-3 text-muted-foreground/50" />
            <Crumb icon={<MessagesSquare className="size-3" />} label={sessionKey} active />
          </>
        )}
        {loading && <Loader2 className="ml-2 size-3 animate-spin text-muted-foreground" />}

        {level !== "session" && (
          <div className="ml-auto flex items-center gap-1.5">
            <div className="relative">
              <Search className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setPage(1);
                    void fetchLevel({ level, q, user: userKey ?? undefined, page: 1 });
                  }
                }}
                placeholder={level === "users" ? "搜索 user_key" : "搜索 session / user"}
                className="h-7 w-[180px] pl-7 text-[12px]"
              />
            </div>
            {pages > 1 && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  disabled={page <= 1}
                  onClick={() => {
                    const next = page - 1;
                    setPage(next);
                    void fetchLevel({ level, q, user: userKey ?? undefined, page: next });
                  }}
                >
                  上一页
                </Button>
                <span className="num text-[11px] text-muted-foreground">
                  {page}/{pages}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  disabled={page >= pages}
                  onClick={() => {
                    const next = page + 1;
                    setPage(next);
                    void fetchLevel({ level, q, user: userKey ?? undefined, page: next });
                  }}
                >
                  下一页
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <div className={cn("max-h-[68vh] overflow-y-auto scrollbar-thin", loading && "opacity-70")}>
        {level === "users" && (
          users.length === 0 ? (
            <Empty text="还没有用户层结果，任务完成后即可查看" />
          ) : (
            <div className="divide-y divide-border/50">
              {users.map((u) => (
                <div key={u.user_key} className="p-3.5">
                  <button
                    className="group flex w-full items-start gap-3 text-left"
                    onClick={() => goSessions(u.user_key)}
                  >
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-[10.5px] font-semibold text-accent-foreground num">
                      {u.session_count}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[12.5px] font-semibold group-hover:text-primary">
                          {u.user_key}
                        </span>
                        <RiskPill risk={u.risk_level} />
                        {u.status === "degraded" && <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">统计兜底</Badge>}
                      </span>
                      {u.persona ? (
                        <span className="mt-0.5 block truncate text-[12px] text-primary/90">{u.persona}</span>
                      ) : null}
                      <span className="mt-0.5 block line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
                        {u.summary}
                      </span>
                      {u.tags?.length ? (
                        <span className="mt-1.5 flex flex-wrap gap-1">
                          {u.tags.slice(0, 6).map((t) => (
                            <Badge key={t} variant="outline" className="h-4 border-border/60 px-1.5 text-[10px] font-normal">
                              {t}
                            </Badge>
                          ))}
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                  {u.metrics?.length ? (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-10 text-[11px] text-muted-foreground">
                      {u.metrics.slice(0, 6).map((m, i) => (
                        <span key={`${m.key}-${i}`} className="inline-flex items-center gap-1">
                          {m.label}
                          <b className="num text-foreground">{round(m.value)}</b>
                          {m.unit ?? ""}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )
        )}

        {level === "sessions" && (
          sessions.length === 0 ? (
            <Empty text="该用户没有会话层结果" />
          ) : (
            <div className="divide-y divide-border/50">
              {sessions.map((s) => (
                <button
                  key={s.session_key}
                  onClick={() => goSession(s.session_key)}
                  className="group flex w-full items-start gap-3 p-3.5 text-left transition-colors hover:bg-accent/40"
                >
                  <ScoreDot score={s.quality_score} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12.5px] font-semibold group-hover:text-primary">
                        {s.session_key}
                      </span>
                      <RiskPill risk={s.risk_level} />
                      <Tag tone="outline">{s.outcome || "unknown"}</Tag>
                      <Tag tone="outline">{s.sentiment || "—"}</Tag>
                    </span>
                    <span className="mt-0.5 block line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
                      {s.summary}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      {s.intent ? <Tag>{s.intent}</Tag> : null}
                      {(s.tags ?? []).slice(0, 5).map((t) => (
                        <Tag key={t}>{t}</Tag>
                      ))}
                    </span>
                  </span>
                  <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          )
        )}

        {level === "session" && (detail ? <SessionDetail detail={detail} sessionKey={sessionKey} /> : <Empty text="加载中…" />)}
      </div>
    </div>
  );
}

interface TranscriptLine {
  role: string;
  text: string;
  at?: string | number | null;
  seq?: number;
  audio_path?: string;
  extra?: JsonObject;
}

function SessionDetail({
  detail,
  sessionKey,
}: {
  detail: { result: JsonObject; meta: JsonObject | null; transcript: TranscriptLine[] };
  sessionKey: string | null;
}) {
  const r = detail.result;
  const meta = detail.meta;
  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-mono text-[13px] font-semibold">{sessionKey}</h4>
        <RiskPill risk={String(r.risk_level ?? "none")} />
        <Tag tone="outline">{String(r.outcome ?? "unknown")}</Tag>
        <Tag tone="outline">{String(r.sentiment ?? "—")}</Tag>
        {meta ? (
          <span className="num ml-auto text-[11.5px] text-muted-foreground">
            {formatDate(String(meta.started_at ?? ""))} · {String(meta.turn_count ?? 0)} 轮 ·{" "}
            {String(meta.audio_count ?? 0)} 段音频
          </span>
        ) : null}
      </div>

      <p className="mt-2.5 text-[12.8px] leading-relaxed text-foreground/90">{String(r.summary ?? "")}</p>

      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <KV label="质量分" value={String(r.quality_score ?? "—")} />
        <KV label="意图" value={String(r.intent ?? "—")} />
        <KV label="风险" value={String(r.risk_level ?? "none")} />
        <KV label="会话状态" value={String(meta?.resolved ?? "—")} />
      </div>

      {Array.isArray(r.metrics) && r.metrics.length > 0 && (
        <>
          <Separator className="my-3.5" />
          <SubTitle>指标</SubTitle>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {(r.metrics as { label: string; value: number; unit?: string }[]).map((m, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg border border-border/60 px-2.5 py-1.5">
                <span className="truncate text-[11.5px] text-muted-foreground">{m.label}</span>
                <span className="num text-[12.5px] font-semibold">
                  {round(m.value)}
                  {m.unit ?? ""}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-3.5 grid gap-3.5 sm:grid-cols-2">
        {Array.isArray(r.highlights) && r.highlights.length > 0 && (
          <ListBlock title="做得好" items={r.highlights as string[]} tone="good" />
        )}
        {Array.isArray(r.problems) && r.problems.length > 0 && (
          <ListBlock title="问题" items={r.problems as string[]} tone="bad" />
        )}
      </div>

      {Array.isArray(r.evidence) && r.evidence.length > 0 && (
        <div className="mt-3.5">
          <SubTitle>原文证据</SubTitle>
          <div className="space-y-1.5">
            {(r.evidence as { quote: string; role?: string; seq?: number }[]).map((e, i) => (
              <blockquote
                key={i}
                className="rounded-r-lg border-l-2 border-primary/70 bg-muted/30 px-3 py-2 text-[12px] leading-relaxed"
              >
                <span className="mb-0.5 block text-[10px] tracking-wide text-muted-foreground uppercase">
                  {e.role === "user" ? "用户" : "AI"}
                  {e.seq != null ? ` · #${e.seq}` : ""}
                </span>
                {e.quote}
              </blockquote>
            ))}
          </div>
        </div>
      )}

      <Separator className="my-3.5" />
      <SubTitle>完整转录（{detail.transcript.length} 条）</SubTitle>
      <div className="space-y-1.5">
        {detail.transcript.map((line, i) => (
          <div
            key={i}
            className={cn(
              "rounded-lg border px-3 py-2",
              line.role === "user" ? "border-border/60 bg-muted/25" : "border-primary/25 bg-[color-mix(in_oklab,var(--primary)_6%,transparent)]",
            )}
          >
            <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
              <span className="font-medium">{line.role === "user" ? "用户" : line.role === "assistant" ? "AI 助手" : line.role}</span>
              {line.seq != null && <span className="num">#{line.seq}</span>}
              {line.at != null && <span className="num">{typeof line.at === "number" ? line.at : String(line.at).slice(11, 19)}</span>}
              {line.audio_path && <AudioChip path={line.audio_path} />}
            </div>
            <div className="text-[12.8px] leading-relaxed whitespace-pre-wrap">{line.text}</div>
          </div>
        ))}
        {!detail.transcript.length && <Empty text="没有转录数据" />}
      </div>
    </div>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className="num mt-0.5 truncate text-[12.5px] font-semibold">{value}</div>
    </div>
  );
}

function ListBlock({ title, items, tone }: { title: string; items: string[]; tone: "good" | "bad" }) {
  return (
    <div>
      <SubTitle>{title}</SubTitle>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-foreground/85">
            <span
              className={cn(
                "mt-1.5 size-1 shrink-0 rounded-full",
                tone === "good" ? "bg-[var(--success)]" : "bg-destructive",
              )}
            />
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Crumb({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "inline-flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors",
        active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      <span className="truncate font-mono">{label}</span>
    </button>
  );
}

function RiskPill({ risk }: { risk: string }) {
  const map: Record<string, string> = {
    high: "border-destructive/45 bg-destructive/10 text-destructive",
    medium: "border-[var(--warning)]/45 bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] text-[var(--warning)]",
    low: "border-border/70 bg-muted/60 text-muted-foreground",
    none: "border-border/70 bg-muted/40 text-muted-foreground",
  };
  return (
    <span className={cn("rounded-full border px-1.5 py-px text-[10px] leading-tight", map[risk] ?? map.none)}>
      风险 {risk}
    </span>
  );
}

function Tag({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "outline" }) {
  return (
    <span
      className={cn(
        "rounded border border-border/60 bg-muted/40 px-1.5 py-px text-[10.5px] text-muted-foreground",
        tone === "outline" && "bg-transparent",
      )}
    >
      {children}
    </span>
  );
}

function ScoreDot({ score }: { score: number | null }) {
  const tone =
    score == null
      ? "bg-muted text-muted-foreground"
      : score >= 80
        ? "bg-[var(--success)] text-white"
        : score >= 60
          ? "bg-[var(--primary)] text-white"
          : score >= 40
            ? "bg-[var(--warning)] text-white"
            : "bg-destructive text-white";
  return (
    <span className={cn("num mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg text-[11px] font-semibold", tone)}>
      {score == null ? "—" : Math.round(score)}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="py-10 text-center text-[12.5px] text-muted-foreground">{text}</div>;
}

function round(n: number) {
  if (!Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return Math.abs(v) >= 100 || Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}
