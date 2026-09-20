import type { LucideIcon } from "lucide-react";
import { cn, formatDuration, relativeTime } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: { label: string; href?: string }[];
}) {
  return (
    <div className="border-b border-border/70 bg-background/60 px-4 py-6 backdrop-blur md:px-8">
      <div className="mx-auto max-w-[1440px]">
        {breadcrumb?.length ? (
          <nav className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            {breadcrumb.map((b, i) => (
              <span key={b.label} className="flex items-center gap-1.5">
                {i > 0 && <span className="opacity-50">/</span>}
                {b.href ? (
                  <a href={b.href} className="transition-colors hover:text-foreground">
                    {b.label}
                  </a>
                ) : (
                  <span className="text-foreground">{b.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
            {description ? (
              <div className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                {description}
              </div>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "good" | "warn" | "bad" | "info";
}) {
  const toneClass = {
    default: "text-primary bg-accent",
    good: "text-[var(--success)] bg-[color-mix(in_oklab,var(--success)_14%,transparent)]",
    warn: "text-[var(--warning)] bg-[color-mix(in_oklab,var(--warning)_16%,transparent)]",
    bad: "text-destructive bg-destructive/10",
    info: "text-[var(--info)] bg-[color-mix(in_oklab,var(--info)_14%,transparent)]",
  }[tone];

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/70 bg-card p-4 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{label}</div>
          <div className="num mt-2 text-2xl font-semibold tracking-tight">{value}</div>
          {hint ? <div className="mt-1.5 truncate text-[11.5px] text-muted-foreground">{hint}</div> : null}
        </div>
        {Icon ? (
          <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg", toneClass)}>
            <Icon className="size-4" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  queued: "bg-muted text-muted-foreground",
  processing: "bg-[color-mix(in_oklab,var(--info)_16%,transparent)] text-[var(--info)]",
  running: "bg-[color-mix(in_oklab,var(--info)_16%,transparent)] text-[var(--info)]",
  aggregating: "bg-[color-mix(in_oklab,var(--info)_16%,transparent)] text-[var(--info)]",
  reporting: "bg-accent text-primary",
  report_pending: "bg-accent text-primary",
  completed: "bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]",
  success: "bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]",
  confirmed: "bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]",
  failed: "bg-destructive/12 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
  draft: "bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]",
  archived: "bg-muted text-muted-foreground",
  degraded: "bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]",
  active: "bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "排队中",
  queued: "排队中",
  processing: "处理中",
  running: "运行中",
  aggregating: "汇总中",
  reporting: "生成报告中",
  report_pending: "待重新生成报告",
  completed: "已完成",
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
  draft: "草稿",
  confirmed: "已确认",
  archived: "已归档",
  degraded: "降级完成",
};

export function StatusBadge({
  status,
  pulse,
  className,
}: {
  status: string;
  pulse?: boolean;
  className?: string;
}) {
  const active = ["running", "processing", "aggregating", "reporting", "pending", "queued"].includes(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        STATUS_STYLE[status] ?? STATUS_STYLE.pending,
        className,
      )}
    >
      {pulse ?? active ? (
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function StageLabel({ stage }: { stage?: string | null }) {
  const map: Record<string, string> = {
    queued: "排队",
    collect: "圈定范围",
    session_analysis: "会话层分析",
    user_aggregation: "用户层汇总",
    global_aggregation: "全局层汇总",
    report_generation: "报告生成",
    done: "完成",
    sampling: "抽样",
  };
  if (!stage) return null;
  return <span className="text-[11px] text-muted-foreground">{map[stage] ?? stage}</span>;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-card/40 px-6 py-14 text-center",
        className,
      )}
    >
      {Icon ? (
        <div className="mb-4 grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground">
          <Icon className="size-5" />
        </div>
      ) : null}
      <div className="text-sm font-medium">{title}</div>
      {description ? (
        <div className="mt-1.5 max-w-md text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </div>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function TimeAgo({ value, className }: { value?: string | Date | null; className?: string }) {
  return <span className={cn("num text-xs text-muted-foreground", className)}>{relativeTime(value)}</span>;
}

export function Duration({ ms }: { ms?: number | null }) {
  return <span className="num text-xs text-muted-foreground">{formatDuration(ms)}</span>;
}
