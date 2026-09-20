import type { ScopeEstimate } from "@/lib/actions/tasks";
import { cn, compactNumber, formatDate } from "@/lib/utils";

/**
 * What a task launched under the current settings would chew through. Shared by
 * the workbench and the canvas so both read the same figures the same way.
 *
 * `compact` drops to a single column for the canvas's 320px sidebar.
 */
export function ScopeEstimatePanel({
  estimate,
  compact = false,
  className,
}: {
  estimate: ScopeEstimate;
  compact?: boolean;
  className?: string;
}) {
  const n = (v: number) => v.toLocaleString("zh-CN");
  const deferred = estimate.matched - estimate.sessions;

  const metrics = [
    { label: "会话", value: compactNumber(estimate.sessions), hint: "每个会话一次模型调用" },
    { label: "终端用户", value: compactNumber(estimate.users), hint: "用户层汇总的条数" },
    { label: "对话轮次", value: compactNumber(estimate.turns), hint: `约 ${compactNumber(estimate.chars)} 字` },
    {
      label: "音频片段",
      value: estimate.useAudio ? compactNumber(estimate.audioClipsSent) : "不送入",
      hint: estimate.useAudio
        ? `范围内共 ${compactNumber(estimate.audioClips)} 段，按每会话上限截断`
        : `范围内有 ${compactNumber(estimate.audioClips)} 段，会话节点未开启音频`,
    },
  ];

  return (
    <div className={cn("rounded-xl border border-border/70 bg-muted/20 p-3.5", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]">
        <span className="font-medium">
          按当前配置，本次将分析 <b className="num text-primary">{n(estimate.sessions)}</b> 个会话
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          （{estimate.mode === "range" ? "时间范围" : "增量未分析"}命中 {n(estimate.matched)} 个
          {deferred > 0
            ? `，受工作流「session 上限 ${estimate.limit}」限制，其余 ${n(deferred)} 个留给下次任务`
            : "，已全部覆盖"}
          ）
        </span>
      </div>

      <div className={cn("mt-3 grid gap-2", compact ? "grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-4")}>
        {metrics.map((m) => (
          <div key={m.label} className="rounded-lg border border-border/70 bg-card p-2.5">
            <div className="text-[11px] text-muted-foreground">{m.label}</div>
            <div className="num mt-0.5 text-[15px] font-semibold">{m.value}</div>
            <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">{m.hint}</div>
          </div>
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
        <span>
          预计模型调用 <b className="num text-foreground">{n(estimate.modelCalls)}</b> 次（会话{" "}
          {compactNumber(estimate.sessions)} + 用户 {compactNumber(estimate.users)} + 全局 1 + 报告 1，不含失败重试）
        </span>
        {estimate.firstAt && estimate.lastAt ? (
          <span className="num">
            数据时间 {formatDate(estimate.firstAt)} ~ {formatDate(estimate.lastAt)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
