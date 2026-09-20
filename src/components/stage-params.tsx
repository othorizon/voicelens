"use client";

import {
  ANALYSIS_STAGES,
  MAX_TOKENS_CEILING,
  STAGE_HINT,
  STAGE_LABEL,
  THINKING_LABEL,
  type AnalysisStage,
  type StageParams,
  type StageParamsPatch,
  type StagePatchMap,
  type ThinkingChoice,
} from "@/lib/models/mode";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Per-stage call parameters, shared by the workspace default and the per-source
 * override exactly like the model pickers are: both edit a patch, and they
 * differ only in what an empty field falls back to — the built-in defaults at
 * the workspace level, the workspace's own values on a data source.
 */

// Radix treats "" as "no value", so "inherit" needs a sentinel of its own.
const INHERIT = "__inherit__";

const THINKING_CHOICES: ThinkingChoice[] = ["auto", "on", "off"];

export function describeBudget(maxTokens: number): string {
  return maxTokens > 0 ? String(maxTokens) : "不限制";
}

export function StageParamsEditor({
  value,
  base,
  baseLabel,
  disabled,
  onChange,
}: {
  value: StagePatchMap;
  /** What an unset field resolves to, and what the placeholders show. */
  base: Record<AnalysisStage, StageParams>;
  /** How "unset" reads here: 内置默认 on the settings page, 继承全局 on a source. */
  baseLabel: string;
  disabled?: boolean;
  onChange: (next: StagePatchMap) => void;
}) {
  function setStage(stage: AnalysisStage, patch: Partial<StageParamsPatch>) {
    const current: StageParamsPatch = value[stage] ?? { thinking: null, maxTokens: null };
    const next: StageParamsPatch = { ...current, ...patch };
    const out = { ...value };
    // A stage that overrides nothing is removed rather than stored as two
    // nulls, so "是否继承" is a question about the presence of a key.
    if (next.thinking === null && next.maxTokens === null) delete out[stage];
    else out[stage] = next;
    onChange(out);
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-border/60">
        <div className="hidden bg-muted/40 px-3 py-2 text-[11.5px] font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_215px_130px] sm:gap-3">
          <span>阶段</span>
          <span>思考模式</span>
          <span>max_tokens</span>
        </div>
        {ANALYSIS_STAGES.map((stage, i) => {
          const patch = value[stage];
          const effective: StageParams = {
            thinking: patch?.thinking ?? base[stage].thinking,
            maxTokens: patch?.maxTokens ?? base[stage].maxTokens,
          };
          return (
            <div
              key={stage}
              className={`grid gap-3 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_215px_130px] sm:items-center ${
                i > 0 ? "border-t border-border/60" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium">{STAGE_LABEL[stage]}</div>
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  {STAGE_HINT[stage]}
                </div>
              </div>

              <Select
                value={patch?.thinking ?? INHERIT}
                disabled={disabled}
                onValueChange={(v) =>
                  setStage(stage, { thinking: v === INHERIT ? null : (v as ThinkingChoice) })
                }
              >
                <SelectTrigger className="w-full text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT} className="text-[12.5px]">
                    {baseLabel}（{THINKING_LABEL[base[stage].thinking]}）
                  </SelectItem>
                  {THINKING_CHOICES.map((c) => (
                    <SelectItem key={c} value={c} className="text-[12.5px]">
                      {THINKING_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                type="number"
                min={0}
                max={MAX_TOKENS_CEILING}
                step={1000}
                inputMode="numeric"
                disabled={disabled}
                value={patch?.maxTokens ?? ""}
                placeholder={describeBudget(base[stage].maxTokens)}
                title={`当前生效：${describeBudget(effective.maxTokens)}`}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  setStage(stage, { maxTokens: raw === "" ? null : Number(raw) });
                }}
                className="h-8 text-[12.5px]"
              />
            </div>
          );
        })}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        max_tokens 留空 = {baseLabel}，填 <span className="num">0</span> =
        不限制（不发送该参数，由模型自己决定写多长）。它只限制回答本身，思考内容不计入；
        写满上限时回答会被截断，平台会自动要求模型精简重写一次，仍不完整才报错。
      </p>
    </div>
  );
}

export function StageParamsSummary({
  stages,
}: {
  stages: Record<AnalysisStage, StageParams>;
}) {
  return (
    <dl className="grid gap-2 text-[12px] sm:grid-cols-2">
      {ANALYSIS_STAGES.map((stage) => (
        <div
          key={stage}
          className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
        >
          <dt className="shrink-0 text-muted-foreground">{STAGE_LABEL[stage]}</dt>
          <dd className="num truncate text-right text-foreground">
            {THINKING_LABEL[stages[stage].thinking]} · {describeBudget(stages[stage].maxTokens)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
