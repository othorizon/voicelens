"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";
import { resetSourceModelConfig, saveSourceModelConfig } from "@/lib/actions/models";
import {
  ANALYSIS_MODES,
  MODEL_KIND_LABEL,
  MODE_HINT,
  MODE_LABEL,
  PLAN_AUDIO_KIND,
  STRATEGY_LABEL,
  describeModeCost,
  sessionStrategy,
  textModelKind,
  type AnalysisMode,
  type AnalysisSelectionPatch,
} from "@/lib/models/mode";
import { ModePicker, ModelPicker, type ModelOption } from "@/components/model-pickers";
import { PageHeader } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Per-data-source analysis configuration.
 *
 * Every field can say "inherit", and inheritance is per field: a source can pin
 * a mode while still following the workspace's models. The routing table below
 * is rendered from the same `@/lib/models/mode` helpers the engine calls, so
 * what it promises is what will run.
 */

export function SourceModelConfig({
  sourceId,
  models,
  defaults,
  override,
}: {
  sourceId: string;
  models: ModelOption[];
  defaults: { mode: AnalysisMode; omniModelId: string | null; multimodalModelId: string | null };
  override: AnalysisSelectionPatch;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<AnalysisSelectionPatch>(override);

  const effective = {
    mode: draft.mode ?? defaults.mode,
    omniModelId: draft.omniModelId ?? defaults.omniModelId,
    multimodalModelId: draft.multimodalModelId ?? defaults.multimodalModelId,
  };

  const dirty =
    draft.mode !== override.mode ||
    draft.omniModelId !== override.omniModelId ||
    draft.multimodalModelId !== override.multimodalModelId;
  const inherits = !draft.mode && !draft.omniModelId && !draft.multimodalModelId;

  const nameOf = (id: string | null) => models.find((m) => m.id === id)?.name ?? "未选择";

  function save() {
    startTransition(async () => {
      try {
        await saveSourceModelConfig(sourceId, draft);
        toast.success("分析模型配置已保存，下一个规划或分析任务生效");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存失败");
      }
    });
  }

  function reset() {
    startTransition(async () => {
      try {
        await resetSourceModelConfig(sourceId);
        setDraft({ mode: null, omniModelId: null, multimodalModelId: null });
        toast.success("已改回完全继承全局默认");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "重置失败");
      }
    });
  }

  return (
    <>
      <PageHeader
        title="分析模型"
        description="为这个数据源单独指定分析模式与模型。留空的项继承设置页里的全局默认，对任务规划与实际分析任务同时生效。"
      />

      <div className="mx-auto max-w-[1440px] space-y-4 p-4 md:p-8">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm font-semibold">本数据源的配置</CardTitle>
              <CardDescription className="text-[12.5px]">
                {inherits
                  ? "当前完全继承全局默认。"
                  : "当前有自定义项，未自定义的仍然跟随全局默认。"}
              </CardDescription>
            </div>
            <Badge variant="outline" className="shrink-0">
              {inherits ? "继承全局" : "已自定义"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-3">
              <ModePicker
                label="分析模式"
                value={draft.mode}
                modes={ANALYSIS_MODES as readonly AnalysisMode[]}
                disabled={pending}
                emptyLabel={`继承全局默认（${MODE_LABEL[defaults.mode]}）`}
                onChange={(mode) => setDraft((d) => ({ ...d, mode }))}
              />
              <ModelPicker
                label={MODEL_KIND_LABEL.omni}
                kind="omni"
                value={draft.omniModelId}
                options={models}
                disabled={pending}
                emptyLabel={`继承全局默认（${nameOf(defaults.omniModelId)}）`}
                onChange={(id) => setDraft((d) => ({ ...d, omniModelId: id }))}
              />
              <ModelPicker
                label={MODEL_KIND_LABEL.multimodal}
                kind="multimodal"
                value={draft.multimodalModelId}
                options={models}
                disabled={pending}
                emptyLabel={`继承全局默认（${nameOf(defaults.multimodalModelId)}）`}
                onChange={(id) => setDraft((d) => ({ ...d, multimodalModelId: id }))}
              />
            </div>

            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-[12px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">{MODE_LABEL[effective.mode]}</span>
              <span className="mx-1.5">·</span>
              {MODE_HINT[effective.mode]}
              <div className="mt-1 text-[11.5px]">开销：{describeModeCost(effective.mode)}</div>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={reset}
                disabled={pending || (inherits && !dirty)}
              >
                <RotateCcw className="size-3.5" />
                恢复继承
              </Button>
              <Button size="sm" onClick={save} disabled={!dirty || pending}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                保存
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">生效后的调用路由</CardTitle>
            <CardDescription className="text-[12.5px]">
              下面是保存后每一类调用实际会用到的模型。「含音频」指该会话确实有音频片段、工作流里的音频开关也打开了；
              签不出预签名 URL 的会话按「无音频」处理。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border border-border/60">
              {routing(effective.mode).map((row, i) => (
                <div
                  key={row.label}
                  className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[12.5px] ${
                    i > 0 ? "border-t border-border/60" : ""
                  }`}
                >
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className="text-right font-medium">{row.via}</span>
                </div>
              ))}
            </div>
            <dl className="mt-3 grid gap-2 text-[12px] sm:grid-cols-2">
              <Fact k={MODEL_KIND_LABEL.omni} v={nameOf(effective.omniModelId)} />
              <Fact k={MODEL_KIND_LABEL.multimodal} v={nameOf(effective.multimodalModelId)} />
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function routing(mode: AnalysisMode): { label: string; via: string }[] {
  const text = MODEL_KIND_LABEL[textModelKind(mode)];
  return [
    { label: "规划 · 试听样本音频", via: MODEL_KIND_LABEL[PLAN_AUDIO_KIND] },
    { label: "规划 · 生成四段提示词", via: text },
    { label: "会话层 · 含音频", via: STRATEGY_LABEL[sessionStrategy(mode, true)] },
    { label: "会话层 · 无音频", via: STRATEGY_LABEL[sessionStrategy(mode, false)] },
    { label: "用户层 / 全局层 / 报告", via: text },
  ];
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className="num truncate text-foreground" title={v}>
        {v}
      </dd>
    </div>
  );
}
