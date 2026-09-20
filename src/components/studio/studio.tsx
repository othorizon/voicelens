"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  MessagesSquare,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Eye,
  Send,
  GitBranch,
  CircleAlert,
  Calculator,
  Wand2,
} from "lucide-react";
import {
  confirmTemplate,
  startPlanning,
  startPreview,
  rerunPreviewReport,
  startPromptRefine,
  startReplanning,
  type PlanningParams,
} from "@/lib/actions/studio";
import { createAnalysisTask, estimateTaskScope, type ScopeEstimate } from "@/lib/actions/tasks";
import { updateNodeParams } from "@/lib/actions/workflow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StatusBadge, EmptyState } from "@/components/ui-kit";
import { ScopeEstimatePanel } from "@/components/scope-estimate";
import { PromptViewer } from "./prompt-viewer";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import type { ExtraFieldDef, JsonObject } from "@/lib/types";

interface TemplateRow extends JsonObject {
  id: string;
  version: number;
  status: string;
  rationale: string;
  feedback: string;
  created_at: string;
  parent_id: string | null;
  session_prompt: string;
  user_prompt: string;
  global_prompt: string;
  report_prompt: string;
  metric_schema: { session?: unknown[]; user?: unknown[]; global?: unknown[] };
  samples: JsonObject;
}

interface JobRow extends JsonObject {
  id: string;
  status: string;
  kind: string;
  feedback: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  progress: JsonObject;
  template_id: string | null;
}

interface PreviewRow extends JsonObject {
  id: string;
  template_id: string;
  status: string;
  progress: JsonObject;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  hasHtml: boolean;
  /** Regenerated the report over an earlier preview's analysis. */
  reportOnly: boolean | null;
  stats: JsonObject;
}

interface StudioState {
  templates: TemplateRow[];
  jobs: JobRow[];
  previews: PreviewRow[];
}

/** Run parameters, seeded from the workflow graph so this page and the canvas agree. */
export interface StudioRunParams {
  plan: PlanningParams;
  preview: { sessions: number; useAudio: boolean };
}

export function Studio({
  sourceId,
  workflowId,
  sourceName,
  description,
  extraSchema,
  sessionCount,
  initial,
  runParams,
}: {
  sourceId: string;
  workflowId: string | null;
  sourceName: string;
  description: string;
  extraSchema: ExtraFieldDef[];
  sessionCount: number;
  initial: StudioState;
  runParams: StudioRunParams;
}) {
  const router = useRouter();
  const [state, setState] = useState<StudioState>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.templates.find((t) => t.status === "confirmed")?.id ?? initial.templates[0]?.id ?? null,
  );
  // Versions already on screen, so a poll can tell an arriving one apart from
  // the ones the user is looking at.
  const knownTemplateIds = useRef<Set<string>>(new Set(initial.templates.map((t) => t.id)));
  const [plan, setPlan] = useState<PlanningParams>(runParams.plan);
  const [previewParams, setPreviewParams] = useState(runParams.preview);
  const [feedback, setFeedback] = useState("");
  const [scope, setScope] = useState<{ type: "incremental" | "range"; start: string; end: string }>({
    type: "incremental",
    start: "",
    end: "",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [estimate, setEstimate] = useState<ScopeEstimate | null>(null);

  const selected = useMemo(
    () => state.templates.find((t) => t.id === selectedId) ?? state.templates[0] ?? null,
    [state.templates, selectedId],
  );

  const activeJob = state.jobs.find((j) => ["pending", "running"].includes(j.status));
  const activePreview = state.previews.find((p) => ["pending", "running"].includes(p.status));
  const polling = Boolean(activeJob || activePreview);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/sources/${sourceId}/studio-state`);
      if (!res.ok) return;
      const json = (await res.json()) as StudioState;
      const templates = (json.templates ?? []) as TemplateRow[];
      // A version that was not there on the previous poll came from the
      // planning job (or manual edit) the user just ran, so move the selection
      // onto it: previewing and replanning both follow the selection, and
      // leaving it on the old version would silently run the wrong prompts.
      const known = knownTemplateIds.current;
      const arrived = templates.some((t) => !known.has(t.id));
      knownTemplateIds.current = new Set(templates.map((t) => t.id));
      setState({
        templates,
        jobs: (json.jobs ?? []) as JobRow[],
        previews: (json.previews ?? []) as PreviewRow[],
      });
      if (arrived && templates.length) setSelectedId(templates[0].id);
    } catch {
      /* ignore transient polling errors */
    }
  }, [sourceId]);

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => void poll(), 3000);
    return () => clearInterval(t);
  }, [polling]);

  // Nothing selected yet (the source had no template when the page rendered):
  // fall back to the newest one. New versions arriving later are selected by
  // `poll` instead.
  useEffect(() => {
    if (!selectedId && state.templates.length) setSelectedId(state.templates[0].id);
  }, [selectedId, state.templates]);

  // An estimate belongs to the scope it was measured for; changing the scope
  // retires it rather than leaving a stale number under the new settings.
  useEffect(() => setEstimate(null), [scope.type, scope.start, scope.end]);

  const confirmed = state.templates.find((t) => t.status === "confirmed");
  // Versions are numbered per data source, so iterating an older one still
  // lands on max + 1 — promising v3 while the source is already on v5 would be
  // a lie every time someone goes back to compare.
  const nextVersion = (state.templates[0]?.version ?? 0) + 1;
  const latestPreview = state.previews.find((p) => p.status === "completed" && p.hasHtml);
  // A preview is a report *of one template version*. Previewing already runs
  // the selected version, so the page shows that version's preview when it has
  // one, and only falls back to the newest one — clearly labelled — when it
  // does not. Reading v2's report while v3 is selected is how a rerun gets
  // mistaken for "the change did nothing".
  const selectedPreview = state.previews.find(
    (p) => p.template_id === selected?.id && p.status === "completed" && p.hasHtml,
  );
  const shownPreview = selectedPreview ?? latestPreview;
  const shownVersion = versionOf(state.templates, shownPreview?.template_id);
  const previewIsStale = Boolean(shownPreview && selected && shownPreview.template_id !== selected.id);
  // Only the newest preview's failure is worth showing: an older one has
  // already been answered by whatever ran after it.
  const failedPreview =
    !activePreview && state.previews[0]?.status === "failed" ? state.previews[0] : null;
  // Same rule for planning jobs, split by where the button that starts them
  // lives: planning in the card above, refine down in the preview card.
  const lastPlanJob = state.jobs.find((j) => j.kind !== "refine") ?? null;
  const lastRefineJob = state.jobs.find((j) => j.kind === "refine") ?? null;
  const planFailure = !activeJob && lastPlanJob?.status === "failed" ? lastPlanJob : null;
  const refineFailure = !activeJob && lastRefineJob?.status === "failed" ? lastRefineJob : null;

  async function guard(fn: () => Promise<void>, key: string) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  function plan_(kind: "create" | "revise") {
    return async () => {
      if (!sessionCount) {
        toast.error("请先导入数据，规划需要真实抽样");
        return;
      }
      // The params you just ran with become the saved defaults, so the canvas
      // and this page never drift apart. Persisting on run rather than on every
      // toggle keeps a bit of fiddling from rewriting the workflow.
      await persist("plan", {
        sessionSamples: plan.sessionSamples,
        userSamples: plan.userSamples,
        includeAudio: plan.includeAudio,
        focus: plan.focus,
      });
      const res =
        kind === "create" || !selected
          ? await startPlanning(sourceId, workflowId, plan)
          : await startReplanning(selected.id, feedback, plan);
      toast.success(kind === "create" ? "已开始规划：模型正在抽样并生成提示词模板" : "已提交修改建议，正在重新规划");
      if (kind === "revise") setFeedback("");
      setShowPreview(false);
      await poll();
      void res;
    };
  }

  /**
   * The other half of the feedback loop: hand the note straight to the model
   * that owns the prompts, which edits them in place. No sampling, so none of
   * the planning params apply and nothing is written back to the workflow.
   */
  function refine_() {
    return async () => {
      if (!selected) {
        toast.error("请先完成规划生成模板");
        return;
      }
      await startPromptRefine(selected.id, feedback);
      toast.success(`已按修改建议调整 v${selected.version} 的配置，正在生成新版本`);
      setFeedback("");
      setShowPreview(false);
      await poll();
    };
  }

  function preview_() {
    return async () => {
      if (!selected) {
        toast.error("请先完成规划生成模板");
        return;
      }
      await persist("preview", { sessions: previewParams.sessions, useAudio: previewParams.useAudio });
      const { previewId } = await startPreview(selected.id, previewParams);
      toast.success("预览任务已创建，正在跑抽样分析");
      await poll();
      void previewId;
    };
  }

  /** Write a node's params back to the workflow; never blocks the run itself. */
  async function persist(kind: "plan" | "preview", params: Record<string, unknown>) {
    if (!workflowId) return;
    try {
      await updateNodeParams(workflowId, kind, params);
    } catch {
      // The run is what the user asked for; a failed sync is not worth aborting it.
    }
  }

  function confirm_() {
    return async () => {
      if (!selected) return;
      await confirmTemplate(selected.id);
      toast.success(`模板 v${selected.version} 已确认为执行模板`);
      await poll();
      router.refresh();
    };
  }

  /**
   * The scope the launch would submit. The estimate measures this same one.
   * The days go over as days: the server reads them in its own timezone, where
   * an end date covers all of that day.
   */
  function scopeArgs() {
    return {
      scopeType: scope.type,
      rangeStart: scope.type === "range" ? scope.start || null : null,
      rangeEnd: scope.type === "range" ? scope.end || null : null,
    };
  }

  function launch() {
    return async () => {
      if (!confirmed) {
        toast.error("请先确认一个执行模板");
        return;
      }
      const { taskId } = await createAnalysisTask({
        dataSourceId: sourceId,
        workflowId,
        templateId: confirmed.id,
        ...scopeArgs(),
      });
      toast.success("全量分析任务已启动");
      router.push(`/tasks/${taskId}`);
    };
  }

  function measure() {
    return async () => {
      const res = await estimateTaskScope({ dataSourceId: sourceId, workflowId, ...scopeArgs() });
      setEstimate(res);
      if (!res.sessions) toast.info("当前范围内没有可分析的会话");
    };
  }

  const steps = [
    { n: 1, title: "规划", done: state.templates.length > 0, active: !state.templates.length, hint: "三层抽样 → 生成提示词模板" },
    {
      n: 2,
      title: "预览",
      done: Boolean(latestPreview),
      active: state.templates.length > 0 && !latestPreview,
      hint: "抽样报告 → 改配置 / 重新规划",
    },
    { n: 3, title: "确认并生成", done: Boolean(confirmed), active: Boolean(latestPreview) && !confirmed, hint: "锁定模板 → 启动全量分析" },
  ];

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 p-4 md:p-8">
      <div className="grid gap-2.5 sm:grid-cols-3">
        {steps.map((s, i) => (
          <div
            key={s.n}
            className={cn(
              "relative flex items-center gap-3 rounded-xl border p-3.5 transition-colors",
              s.done
                ? "border-[var(--success)]/35 bg-[color-mix(in_oklab,var(--success)_7%,var(--card))]"
                : s.active
                  ? "border-primary/45 bg-accent/40"
                  : "border-border/70 bg-card",
            )}
          >
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-lg text-[11.5px] font-semibold",
                s.done
                  ? "bg-[var(--success)] text-white"
                  : s.active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {s.done ? <CheckCircle2 className="size-3.5" /> : s.n}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">{s.title}</div>
              <div className="truncate text-[11.5px] text-muted-foreground">{s.hint}</div>
            </div>
            {i < 2 ? <span className="absolute -right-2.5 top-1/2 hidden h-px w-2.5 bg-border sm:block" /> : null}
          </div>
        ))}
      </div>

      {/* ---------------------------------------------------------- 规划 */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="size-4 text-primary" />
                1. 智能规划
              </CardTitle>
              <CardDescription className="max-w-3xl text-[12.5px] leading-relaxed">
                平台会按「会话 → 用户 → 全局」三层各抽取真实样本，连同业务描述与 extra schema 一起交给
                qwen3.8-omni-flash，让它自己决定分析什么、怎么算指标、报告怎么写，并把结果固化为可版本化的执行模板。
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {state.templates.length > 0 && (
                <Badge variant="outline" className="gap-1.5 py-1 text-[11.5px] font-normal">
                  <GitBranch className="size-3" />
                  {state.templates.length} 个模板版本
                </Badge>
              )}
              <Button size="sm" onClick={() => void guard(plan_("create"), "plan")} disabled={Boolean(busy) || Boolean(activeJob)}>
                {busy === "plan" || activeJob ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {state.templates.length ? "重新规划" : "开始规划"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <NumField
              label="会话层样本数"
              value={plan.sessionSamples ?? 5}
              min={1}
              max={20}
              onChange={(v) => setPlan((p) => ({ ...p, sessionSamples: v }))}
              hint="抽取多少个完整会话给模型看"
            />
            <NumField
              label="用户层样本数"
              value={plan.userSamples ?? 4}
              min={1}
              max={20}
              onChange={(v) => setPlan((p) => ({ ...p, userSamples: v }))}
              hint="抽取多少个多会话用户"
            />
            <div className="flex flex-col justify-between rounded-lg border border-border/70 bg-muted/20 p-3">
              <div>
                <Label className="text-[11.5px] font-medium">规划时试听音频</Label>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  让模型实际听样本音频，把语气、打断、TTS 卡顿纳入指标设计
                </p>
              </div>
              <Switch
                checked={plan.includeAudio !== false}
                onCheckedChange={(v) => setPlan((p) => ({ ...p, includeAudio: v }))}
                className="mt-2.5"
              />
            </div>
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
              <Label className="text-[11.5px] font-medium">当前口径</Label>
              <div className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-muted-foreground">
                <div>会话 {sessionCount} 个 · extra 字段 {extraSchema.length} 个</div>
                <div className="line-clamp-2" title={description}>
                  业务描述 {description ? `${description.length} 字` : "未填写（模型将自行推断）"}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11.5px] font-medium">规划侧重（可选）</Label>
            <Input
              value={plan.focus ?? ""}
              onChange={(e) => setPlan((p) => ({ ...p, focus: e.target.value }))}
              placeholder="例如：重点看打断率和 TTS 首包延迟对解决率的影响，报告面向算法团队"
              className="h-8 text-[12.5px]"
            />
          </div>

          {/* A refine job is started from the preview card below, and reports
              there: progress that lands two cards away from the button reads as
              nothing having happened. */}
          {activeJob && activeJob.kind !== "refine" && <JobProgress job={activeJob} />}
          {planFailure && <JobFailure job={planFailure} />}
        </CardContent>
      </Card>

      {/* -------------------------------------------------------- 模板 */}
      {state.templates.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <Card className="h-max">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">模板版本</CardTitle>
              <CardDescription className="text-[11.5px]">每次规划或手工编辑都会存为一个版本</CardDescription>
            </CardHeader>
            <CardContent className="max-h-[60vh] space-y-2 overflow-y-auto scrollbar-thin">
              {state.templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={cn(
                    "w-full rounded-lg border p-3 text-left transition-colors",
                    t.id === selected?.id
                      ? "border-primary/55 bg-accent/50"
                      : "border-border/70 hover:border-border",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="num text-[12.5px] font-semibold">v{t.version}</span>
                    <StatusBadge status={t.status} />
                    <span className="num ml-auto text-[11px] text-muted-foreground">{relativeTime(t.created_at)}</span>
                  </div>
                  {t.feedback ? (
                    <div className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      修改意见：{t.feedback}
                    </div>
                  ) : null}
                  {t.parent_id ? (
                    <div className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-muted-foreground">
                      <GitBranch className="size-2.5" />
                      由 v{state.templates.find((x) => x.id === t.parent_id)?.version ?? "?"} 演进
                    </div>
                  ) : null}
                </button>
              ))}
            </CardContent>
          </Card>

          {selected ? (
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">
                    v{selected.version} · 规划说明
                  </CardTitle>
                  <CardDescription className="text-[11.5px]">
                    模型对这批数据的判断，以及它为什么这样设计提示词
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-[12.8px] leading-relaxed whitespace-pre-wrap text-foreground/85">{selected.rationale}</p>
                  {selected.samples?.audio_impression ? (
                    <div className="rounded-lg border border-border/70 bg-muted/25 p-3">
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">音频试听结论</div>
                      <p className="text-[12.2px] leading-relaxed whitespace-pre-wrap">
                        {String(selected.samples.audio_impression)}
                      </p>
                    </div>
                  ) : null}
                  <Separator />
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[
                      { k: "session", label: "会话层指标" },
                      { k: "user", label: "用户层指标" },
                      { k: "global", label: "全局层指标" },
                    ].map((g) => {
                      const items = ((selected.metric_schema as Record<string, unknown[]> | undefined)?.[g.k] ?? []) as {
                        key?: string;
                        label?: string;
                        desc?: string;
                      }[];
                      return (
                        <div key={g.k}>
                          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                            {g.label}（{items.length}）
                          </div>
                          <div className="space-y-1">
                            {items.slice(0, 8).map((m, i) => (
                              <div key={`${m.key}-${i}`} className="rounded border border-border/60 px-2 py-1">
                                <div className="truncate text-[11.5px] font-medium">{m.label ?? m.key}</div>
                                <div className="truncate font-mono text-[10px] text-muted-foreground">{m.key}</div>
                              </div>
                            ))}
                            {!items.length && <div className="text-[11px] text-muted-foreground">—</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Keyed by template: a half-typed draft belongs to the version
                  it was started on, not to whichever one is selected next. */}
              <PromptViewer
                key={selected.id}
                template={selected}
                onSaved={async (created) => {
                  // Pull the new version into the list first, then select it,
                  // so the selection never lands on a row that is not there yet.
                  await poll();
                  setSelectedId(created.id);
                }}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* -------------------------------------------------------- 预览 */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Eye className="size-4 text-primary" />
                2. 预览报告
              </CardTitle>
              <CardDescription className="max-w-3xl text-[12.5px] leading-relaxed">
                用<b>当前选中的模板版本</b>
                {selected ? `（v${selected.version}）` : ""}
                跑一小批抽样数据，真实走完「会话分析 → 用户汇总 → 全局汇总 → 报告渲染」，
                让你在启动全量分析前先看到报告长什么样。换一个版本再点一次，就能横向对比两版的报告。
                不满意就在下面写修改建议：既可以让模型直接改这一版的配置，也可以带着意见回到规划重新生成一版。
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {shownPreview && (
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setShowPreview((v) => !v)}>
                  {showPreview ? "收起预览" : `查看 v${shownVersion} 预览`}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!selected || Boolean(activePreview)}
                onClick={() => void guard(preview_(), "preview")}
              >
                {busy === "preview" || activePreview ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {selected
                  ? `基于 v${selected.version} ${selectedPreview ? "重新生成预览" : "生成预览"}`
                  : "生成预览"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <NumField
              label="预览会话数"
              value={previewParams.sessions}
              min={3}
              max={60}
              onChange={(v) => setPreviewParams((p) => ({ ...p, sessions: v }))}
              hint="太少则用户层与全局层结论不够稳"
            />
            <div className="flex flex-col justify-between rounded-lg border border-border/70 bg-muted/20 p-3">
              <div>
                <Label className="text-[11.5px] font-medium">预览时送入音频</Label>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  更准但更慢，建议正式任务再开
                </p>
              </div>
              <Switch
                checked={previewParams.useAudio}
                onCheckedChange={(v) => setPreviewParams((p) => ({ ...p, useAudio: v }))}
                className="mt-2.5"
              />
            </div>
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
              <Label className="text-[11.5px] font-medium">历史预览</Label>
              <div className="mt-2 space-y-1">
                {state.previews.slice(0, 4).map((p) => (
                  <div key={p.id} className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                    <StatusBadge status={p.status} />
                    <span className="num">{formatDate(String(p.created_at))}</span>
                    <span
                      className={cn(
                        "num truncate",
                        p.template_id === selected?.id && "font-semibold text-foreground",
                      )}
                    >
                      v{versionOf(state.templates, p.template_id)}
                    </span>
                    {p.reportOnly ? (
                      <span className="shrink-0 rounded bg-muted px-1 text-[10.5px]">仅报告</span>
                    ) : null}
                  </div>
                ))}
                {!state.previews.length && <div className="text-[11.5px] text-muted-foreground">暂无</div>}
              </div>
            </div>
          </div>

          {activePreview && (
            <PreviewProgress
              preview={activePreview}
              version={versionOf(state.templates, activePreview.template_id)}
            />
          )}
          {failedPreview && <PreviewFailure preview={failedPreview} />}
          {shownPreview && <PreviewFallbacks preview={shownPreview} />}

          {previewIsStale && selected ? (
            <div className="rounded-xl border border-border/70 bg-muted/25 p-3 text-[11.5px] leading-relaxed text-muted-foreground">
              当前选中的是 <b className="num text-foreground">v{selected.version}</b>，但它还没有预览报告；
              下面展示的是 <b className="num text-foreground">v{shownVersion}</b> 的那一份。点上方
              「基于 v{selected.version} 生成预览」用选中的版本重跑一次。
            </div>
          ) : null}

          {showPreview && shownPreview ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="num text-[11.5px] text-muted-foreground">
                  {formatDate(String(shownPreview.created_at))} · 模板 v{shownVersion}
                  {shownPreview.reportOnly ? " · 仅重新生成报告" : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-7 text-[11.5px]"
                  disabled={Boolean(activePreview)}
                  title="复用这份预览已有的三层分析结果，只重新设计并生成报告页面"
                  onClick={async () => {
                    try {
                      await rerunPreviewReport(shownPreview.id);
                      toast.success("已排队：只重新生成报告");
                      await poll();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "重新生成报告失败");
                    }
                  }}
                >
                  <RefreshCw className="size-3" />
                  只重新生成报告
                </Button>
                <Button asChild size="sm" variant="ghost" className="h-7 text-[11.5px]">
                  <a href={`/api/report/preview/${shownPreview.id}`} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3" />
                    新窗口打开
                  </a>
                </Button>
              </div>
              <iframe
                key={shownPreview.id}
                src={`/api/report/preview/${shownPreview.id}`}
                title="预览报告"
                className="h-[640px] w-full rounded-xl border border-border/70 bg-white"
              />
            </div>
          ) : null}

          {selected ? (
            <div className="rounded-xl border border-border/70 bg-muted/20 p-3.5">
              <Label className="text-[11.5px] font-medium">对报告内容提出修改建议</Label>
              <p className="mt-1 mb-2 text-[11.5px] leading-relaxed text-muted-foreground">
                写下希望报告改进的地方，例如「章节顺序改成先讲问题再讲成绩」「打断率要按噪音等级分组」
                「KPI 里加上 TTS P90 延迟」。两种落地方式都会生成新的模板版本，改完记得基于新版本再跑一次预览。
              </p>
              <Textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={4}
                placeholder="写下你希望报告改进的地方…"
                className="text-[12.5px]"
              />
              {activeJob?.kind === "refine" ? (
                <div className="mt-2.5">
                  <JobProgress job={activeJob} />
                </div>
              ) : null}
              {refineFailure ? (
                <div className="mt-2.5">
                  <JobFailure job={refineFailure} />
                </div>
              ) : null}
              <div className="mt-2.5 grid gap-2.5 md:grid-cols-2">
                <FeedbackAction
                  icon={busy === "refine" || activeJob ? Loader2 : Wand2}
                  spinning={busy === "refine" || Boolean(activeJob)}
                  title="按建议直接改配置"
                  desc="不重新抽样、不重新试听音频，模型只在现有提示词上改动建议涉及的部分，几十秒完成。适合口径微调、章节顺序、增删指标。"
                  onClick={() => void guard(refine_(), "refine")}
                  disabled={!feedback.trim() || Boolean(activeJob)}
                  primary
                />
                <FeedbackAction
                  icon={busy === "revise" || activeJob ? Loader2 : Send}
                  spinning={busy === "revise" || Boolean(activeJob)}
                  title="带建议重新规划"
                  desc="重新抽样（按上方规划参数，可含试听音频）并整套重写四段提示词。适合分析方向本身要换，或数据在这之后有较大变化。"
                  onClick={() => void guard(plan_("revise"), "revise")}
                  disabled={!feedback.trim() || Boolean(activeJob)}
                />
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                两者都基于 v{selected.version}，生成 v{nextVersion}（父版本保留，可随时切回）。
              </div>
            </div>
          ) : (
            <EmptyState
              icon={Sparkles}
              title="还没有模板"
              description="先在上方点「开始规划」，让模型看过真实数据后自动生成三层分析提示词与报告提示词。"
              className="py-8"
            />
          )}
        </CardContent>
      </Card>

      {/* -------------------------------------------------- 确认与启动 */}
      <Card className={cn(confirmed && "border-[var(--success)]/40")}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <CheckCircle2 className={cn("size-4", confirmed ? "text-[var(--success)]" : "text-muted-foreground")} />
            3. 确认模板并启动全量分析
          </CardTitle>
          <CardDescription className="text-[12.5px] leading-relaxed">
            确认后该版本会成为这个数据源的执行模板。任务由后台 Worker 执行，按 workflow 中配置的并发与范围跑完三层分析并产出报告，
            之后仍可回到这里修改模板（新版本不影响已完成的历史任务）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {confirmed ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--success)]/30 bg-[color-mix(in_oklab,var(--success)_8%,transparent)] p-3 text-[12.5px]">
              <CheckCircle2 className="size-3.5 text-[var(--success)]" />
              当前执行模板：<b className="num">v{confirmed.version}</b>
              <span className="text-muted-foreground">确认于 {formatDate(confirmed.created_at)}</span>
              {selected && selected.id !== confirmed.id && (
                <span className="text-muted-foreground">（当前选中 v{selected.version} 尚未确认）</span>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/80 p-3 text-[12.5px] text-muted-foreground">
              还没有确认的执行模板。任务启动需要至少一个已确认版本。
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-[200px_1fr_1fr_auto]">
            <div className="space-y-1.5">
              <Label className="text-[11.5px]">分析范围</Label>
              <div className="flex rounded-lg border border-border/70 p-0.5">
                {(["incremental", "range"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setScope((s) => ({ ...s, type: m }))}
                    className={cn(
                      "flex-1 rounded-md px-2 py-1.5 text-[11.5px] font-medium transition-colors",
                      scope.type === m ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m === "incremental" ? "增量未分析" : "时间范围"}
                  </button>
                ))}
              </div>
            </div>
            {scope.type === "range" ? (
              <>
                <div className="space-y-1.5">
                  <Label className="text-[11.5px]">开始时间</Label>
                  <Input
                    type="date"
                    value={scope.start}
                    onChange={(e) => setScope((s) => ({ ...s, start: e.target.value }))}
                    className="h-8 text-[12px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11.5px]">结束时间</Label>
                  <Input
                    type="date"
                    value={scope.end}
                    onChange={(e) => setScope((s) => ({ ...s, end: e.target.value }))}
                    className="h-8 text-[12px]"
                  />
                </div>
              </>
            ) : (
              <div className="md:col-span-2">
                <Label className="text-[11.5px]">说明</Label>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                  只分析尚未被任何已完成任务覆盖过的会话，适合数据持续导入后的增量分析。上限由工作流中「分析范围」节点的
                  session 上限控制。
                </p>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => void guard(measure(), "measure")}
                disabled={busy === "measure"}
              >
                {busy === "measure" ? <Loader2 className="size-3.5 animate-spin" /> : <Calculator className="size-3.5" />}
                计算数据量
              </Button>
              {confirmed ? (
                <Button size="sm" className="h-8" onClick={() => void guard(launch(), "launch")} disabled={busy === "launch"}>
                  {busy === "launch" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  启动全量分析
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-8"
                  onClick={() => void guard(confirm_(), "confirm")}
                  disabled={!selected || busy === "confirm"}
                >
                  {busy === "confirm" ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                  确认 v{selected?.version ?? "?"} 为执行模板
                </Button>
              )}
            </div>
          </div>

          {estimate ? <ScopeEstimatePanel estimate={estimate} /> : null}

          {confirmed && selected && selected.id !== confirmed.id ? (
            <Button size="sm" variant="outline" className="h-8" onClick={() => void guard(confirm_(), "confirm")}>
              <RotateCcw className="size-3.5" />
              改为确认 v{selected.version}
            </Button>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-t border-border/70 pt-3 text-[11.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <MessagesSquare className="size-3" />
              数据源 {sourceName} 共 {sessionCount} 个会话
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              最近规划 {state.jobs[0] ? relativeTime(String(state.jobs[0].created_at)) : "—"}
            </span>
            <Link href="/tasks" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
              前往任务中心
              <ExternalLink className="size-3" />
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** The version label of a template id, for rows that only carry the id. */
function versionOf(templates: TemplateRow[], templateId: string | null | undefined): string {
  const v = templates.find((t) => t.id === templateId)?.version;
  return v === undefined ? "?" : String(v);
}

/** One of the two ways a piece of feedback can become a new template version. */
function FeedbackAction({
  icon: Icon,
  spinning,
  title,
  desc,
  onClick,
  disabled,
  primary,
}: {
  icon: typeof Send;
  spinning: boolean;
  title: string;
  desc: string;
  onClick: () => void;
  disabled: boolean;
  primary?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        primary ? "border-primary/45 bg-accent/30" : "border-border/70 bg-card",
      )}
    >
      <p className="text-[11px] leading-relaxed text-muted-foreground">{desc}</p>
      <Button
        size="sm"
        variant={primary ? "default" : "outline"}
        className="mt-auto h-8 w-full"
        onClick={onClick}
        disabled={disabled}
      >
        <Icon className={cn("size-3.5", spinning && "animate-spin")} />
        {title}
      </Button>
    </div>
  );
}

function NumField({
  label,
  value,
  min,
  max,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
      <Label className="text-[11.5px] font-medium">{label}</Label>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))}
        className="num mt-1.5 h-8 text-[13px]"
      />
      {hint ? <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function JobFailure({ job }: { job: JobRow }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-[12px] text-destructive">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{JOB_KIND_LABEL[String(job.kind)] ?? "规划"}失败</div>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-destructive/10 p-2.5 text-[11px] leading-relaxed">
          {String(job.error ?? "未知错误")}
        </pre>
      </div>
    </div>
  );
}

const JOB_KIND_LABEL: Record<string, string> = {
  create: "规划",
  revise: "重新规划",
  refine: "按建议改配置",
};

function JobProgress({ job }: { job: JobRow }) {
  const step = String((job.progress as JsonObject)?.step ?? "");
  const label =
    job.status === "pending"
      ? "排队中"
      : job.kind === "refine"
        ? "正在按修改建议调整配置"
        : step === "sampling"
          ? "三层抽样中"
          : "模型正在生成提示词模板";
  return (
    <div className="rounded-xl border border-primary/35 bg-accent/40 p-3.5">
      <div className="flex items-center gap-2 text-[12.5px] font-medium">
        {job.status === "running" ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : (
          <Clock className="size-3.5 text-primary" />
        )}
        {label}
        <span className="num ml-auto text-[11px] text-muted-foreground">{formatDate(String(job.created_at))}</span>
      </div>
      <Progress value={job.status === "running" ? 55 : 12} className="mt-2.5 h-1" />
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
        {job.feedback
          ? `修改意见：${job.feedback}`
          : "规划耗时约 30–90 秒（取决于是否试听音频），完成后会自动出现在右侧模板列表。"}
      </p>
    </div>
  );
}

/**
 * The worker writes the failure to `template_previews.error`; without this the
 * page just kept offering "生成预览" and the reason lived only in the container
 * log, which is not where the person who pressed the button is looking.
 */
function PreviewFailure({ preview }: { preview: PreviewRow }) {
  return (
    <div className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/8 p-3.5 text-[12px] text-destructive">
      <div className="flex items-center gap-2 font-medium">
        <CircleAlert className="size-3.5 shrink-0" />
        预览失败
        <span className="num ml-auto text-[11px] font-normal opacity-80">
          {formatDate(String(preview.finished_at ?? preview.created_at))}
        </span>
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-destructive/10 p-2.5 text-[11px] leading-relaxed">
        {String(preview.error ?? "未知错误")}
      </pre>
      <p className="text-[11px] opacity-80">
        同一条错误也会写进 Worker 日志（docker logs 里以 [worker] preview 开头）。
      </p>
    </div>
  );
}

/**
 * A preview whose session or user layer fell back still renders a report — one
 * written from placeholder text. Saying so keeps a degraded preview from being
 * read as a verdict on the template.
 */
function PreviewFallbacks({ preview }: { preview: PreviewRow }) {
  const stats = (preview.stats ?? {}) as {
    failure_count?: number;
    failures?: { stage?: string; key?: string; message?: string }[];
  };
  const count = Number(stats.failure_count ?? 0);
  if (!count) return null;
  const first = stats.failures?.[0];
  return (
    <div className="space-y-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-[12px] text-amber-700 dark:text-amber-400">
      <div className="flex items-center gap-2 font-medium">
        <CircleAlert className="size-3.5 shrink-0" />
        本次预览有 {count} 处分析失败并使用了兜底文案，报告结论会偏离真实数据
      </div>
      {first ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-amber-500/10 p-2.5 text-[11px] leading-relaxed">
          {`${first.stage ?? "分析"} ${first.key ?? ""}：${first.message ?? ""}`}
        </pre>
      ) : null}
    </div>
  );
}

function PreviewProgress({ preview, version }: { preview: PreviewRow; version: string }) {
  const p = (preview.progress ?? {}) as { stage?: string; done?: number; total?: number; message?: string };
  const stageLabel: Record<string, string> = {
    collect: "选取预览样本",
    session_analysis: "会话层分析",
    user_aggregation: "用户层汇总",
    global_aggregation: "全局层汇总",
    report: "渲染报告",
    queued: "排队中",
  };
  const done = Number(p.done ?? 0);
  const total = Number(p.total ?? 1);
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="rounded-xl border border-primary/35 bg-accent/40 p-3.5">
      <div className="flex items-center gap-2 text-[12.5px] font-medium">
        <Loader2 className="size-3.5 animate-spin text-primary" />
        {stageLabel[String(p.stage ?? "")] ?? "处理中"}
        <span className="text-[11px] font-normal text-muted-foreground">基于 v{version}</span>
        <span className="num ml-auto text-[11px] text-muted-foreground">
          {done} / {total}
        </span>
      </div>
      <Progress value={pct} className="mt-2.5 h-1" />
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
        {p.message ?? "预览任务由后台 Worker 执行，完成后报告会显示在下方。"}
      </p>
    </div>
  );
}
