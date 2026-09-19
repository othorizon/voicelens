"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, Loader2, Play, RotateCcw, XCircle, Terminal } from "lucide-react";
import { cancelTask, rerunTask } from "@/lib/actions/tasks";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui-kit";
import { cn, formatDuration, formatDate } from "@/lib/utils";
import type { JsonObject } from "@/lib/types";

const STAGES = [
  { key: "collect", label: "圈定范围" },
  { key: "session_analysis", label: "会话层分析" },
  { key: "user_aggregation", label: "用户层汇总" },
  { key: "global_aggregation", label: "全局层汇总" },
  { key: "report_generation", label: "报告生成" },
  { key: "done", label: "完成" },
];

interface LogRow {
  id: number;
  level: string;
  stage: string | null;
  message: string;
  created_at: string;
}

export function TaskLive({
  taskId,
  initial,
  canRerun,
}: {
  taskId: string;
  initial: {
    status: string;
    stage: string;
    progress: JsonObject;
    stats: JsonObject;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
  };
  canRerun: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [counts, setCounts] = useState({ success: 0, failed: 0, total: 0 });
  const [busy, setBusy] = useState(false);
  const lastLogId = useRef<number | undefined>(undefined);
  const active = ["pending", "running", "aggregating", "reporting"].includes(state.status);

  const poll = useCallback(async () => {
    try {
      const after = lastLogId.current ? `?after=${lastLogId.current}` : "";
      const res = await fetch(`/api/tasks/${taskId}/state${after}`);
      if (!res.ok) return;
      const json = (await res.json()) as {
        task: typeof initial | null;
        logs: LogRow[];
        resultCounts: { success: number; failed: number; total: number };
      };
      if (json.task) {
        setState({
          status: String(json.task.status),
          stage: String(json.task.stage ?? ""),
          progress: (json.task.progress ?? {}) as JsonObject,
          stats: (json.task.stats ?? {}) as JsonObject,
          error: (json.task.error as string | null) ?? null,
          started_at: json.task.started_at ?? null,
          finished_at: json.task.finished_at ?? null,
        });
      }
      setCounts(json.resultCounts);
      if (json.logs?.length) {
        lastLogId.current = Math.max(lastLogId.current ?? 0, ...json.logs.map((l) => l.id));
        setLogs((prev) => {
          const merged = [...prev, ...json.logs].filter(
            (v, i, arr) => arr.findIndex((x) => x.id === v.id) === i,
          );
          return merged.slice(-400);
        });
      }
    } catch {
      /* transient */
    }
  }, [taskId]);

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 3000);
    return () => clearInterval(t);
  }, [poll]);

  const progress = state.progress ?? {};
  const total = Number(progress.total ?? 0);
  const done = Number(progress.done ?? 0);
  const pct = total ? Math.round((done / total) * 100) : state.stage === "done" ? 100 : 0;
  const stageIndex = STAGES.findIndex((s) => s.key === state.stage);
  const stats = state.stats ?? {};
  const duration =
    state.started_at && state.finished_at
      ? Date.parse(state.finished_at) - Date.parse(state.started_at)
      : state.started_at
        ? Date.now() - Date.parse(state.started_at)
        : null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/70 bg-card p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <StatusBadge status={state.status} />
          <span className="text-[12.5px] text-muted-foreground">
            {STAGES[stageIndex]?.label ?? state.stage ?? "排队中"}
          </span>
          {total ? (
            <span className="num text-[12.5px] text-muted-foreground">
              {done} / {total} 会话（{pct}%）
            </span>
          ) : null}
          {counts.total ? (
            <span className="num text-[12px] text-muted-foreground">
              成功 <b className="text-[var(--success)]">{counts.success}</b>
              {counts.failed ? (
                <>
                  {" "}
                  · 失败 <b className="text-destructive">{counts.failed}</b>
                </>
              ) : null}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {active && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11.5px]"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await cancelTask(taskId);
                    toast.success("已请求取消");
                    await poll();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "取消失败");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <XCircle className="size-3.5" />
                取消任务
              </Button>
            )}
            {!active && canRerun && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11.5px]"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const { taskId: next } = await rerunTask(taskId);
                    toast.success("已创建重跑任务");
                    router.push(`/tasks/${next}`);
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "重跑失败");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RotateCcw className="size-3.5" />
                重跑
              </Button>
            )}
          </div>
        </div>

        <Progress value={pct} className="mt-3 h-1.5" />

        <div className="mt-4 flex flex-wrap items-center gap-1">
          {STAGES.map((s, i) => {
            const reached = state.stage === "done" || i < stageIndex || (i === stageIndex && state.status === "completed");
            const current = i === stageIndex && active;
            const failedHere = state.status === "failed" && i === stageIndex;
            return (
              <div key={s.key} className="flex items-center">
                {i > 0 && <span className={cn("h-px w-4", reached ? "bg-primary/60" : "bg-border")} />}
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] whitespace-nowrap transition-colors",
                    failedHere
                      ? "border-destructive/50 bg-destructive/10 text-destructive"
                      : current
                        ? "border-primary/50 bg-accent text-primary"
                        : reached
                          ? "border-[var(--success)]/40 bg-[color-mix(in_oklab,var(--success)_10%,transparent)] text-[var(--success)]"
                          : "border-border/70 text-muted-foreground",
                  )}
                >
                  {failedHere ? (
                    <XCircle className="size-3" />
                  ) : current ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : reached ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                  )}
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="耗时" value={formatDuration(duration)} />
          <Fact label="会话成功" value={String(stats.sessions_ok ?? counts.success ?? 0)} />
          <Fact label="会话失败" value={String(stats.sessions_failed ?? counts.failed ?? 0)} tone={Number(stats.sessions_failed ?? 0) > 0 ? "bad" : undefined} />
          <Fact label="用户数" value={String(stats.users ?? 0)} />
          <Fact label="Token 消耗" value={String(stats.tokens ?? 0)} />
          <Fact label="模型" value={String(stats.model ?? "qwen3.8-omni-flash")} mono />
        </div>

        {state.error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-[12px] leading-relaxed text-destructive">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">任务失败</div>
              <div className="mt-0.5 break-words opacity-90">{state.error}</div>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11.5px] text-muted-foreground">
          <Badge variant="outline" className="gap-1 py-0.5 font-normal">
            <Play className="size-2.5" />
            {state.started_at ? formatDate(state.started_at) : "未开始"}
          </Badge>
          {state.finished_at ? <span className="num">完成于 {formatDate(state.finished_at)}</span> : null}
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card">
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5">
          <Terminal className="size-3.5 text-muted-foreground" />
          <span className="text-[12.5px] font-semibold">执行日志</span>
          <span className="num ml-auto text-[11px] text-muted-foreground">{logs.length} 条</span>
        </div>
        <div className="max-h-[320px] min-h-[120px] overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed scrollbar-thin">
          {logs.length === 0 ? (
            <div className="py-6 text-center font-sans text-muted-foreground">
              {active ? "等待 Worker 输出日志…" : "暂无日志"}
            </div>
          ) : (
            logs.map((l) => (
              <div key={l.id} className="flex gap-2 py-0.5">
                <span className="shrink-0 opacity-55">{formatDate(l.created_at).slice(11)}</span>
                <span
                  className={cn(
                    "shrink-0",
                    l.level === "error"
                      ? "text-destructive"
                      : l.level === "warn"
                        ? "text-[var(--warning)]"
                        : "text-muted-foreground",
                  )}
                >
                  {l.stage ?? "task"}
                </span>
                <span className="min-w-0 break-words">{l.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  tone,
  mono,
}: {
  label: string;
  value: string;
  tone?: "bad";
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-[13px] font-semibold",
          mono && "num text-[11.5px]",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}
