"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Loader2, Plus, Trash2, Wand2, X } from "lucide-react";
import { inferSchemaFromData, saveExtraSchema } from "@/lib/actions/sources";
import type { ExtraFieldDef, ExtraFieldKind, ExtraFieldUsage } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const KINDS: { value: ExtraFieldKind; label: string; hint: string }[] = [
  { value: "enum", label: "枚举", hint: "有限取值，可作为分群维度" },
  { value: "sentiment", label: "情绪", hint: "情绪/满意度标签，报告中单独配色" },
  { value: "boolean", label: "布尔", hint: "true/false，适合计率" },
  { value: "number", label: "数值", hint: "连续值，聚合为均值 / 分位数" },
  { value: "text", label: "文本", hint: "自由文本，仅作上下文" },
];

const USAGES: { value: ExtraFieldUsage; label: string; hint: string }[] = [
  { value: "metric", label: "指标", hint: "聚合为数值指标，进入 KPI 与图表" },
  { value: "segment", label: "分群", hint: "作为 group by 维度，产出分布图" },
  { value: "context", label: "上下文", hint: "只帮助模型理解语义，不单独统计" },
  { value: "filter", label: "过滤", hint: "用于判断样本是否纳入或标记异常" },
];

const blank = (): ExtraFieldDef => ({
  name: "",
  label: "",
  kind: "enum",
  scope: "message",
  options: [],
  description: "",
  usage: "context",
});

export function ExtraSchemaEditor({
  sourceId,
  initial,
}: {
  sourceId: string;
  initial: ExtraFieldDef[];
}) {
  const [fields, setFields] = useState<ExtraFieldDef[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [pending, startTransition] = useTransition();
  const [inferring, setInferring] = useState(false);

  useEffect(() => setFields(initial), [initial]);

  const patch = (i: number, p: Partial<ExtraFieldDef>) => {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...p } : f)));
    setDirty(true);
  };

  function save() {
    const invalid = fields.find((f) => !f.name.trim());
    if (invalid) {
      toast.error("存在未命名的字段，请填写字段名或删除该行");
      return;
    }
    startTransition(async () => {
      try {
        await saveExtraSchema(sourceId, fields);
        toast.success("extra 字段 schema 已保存，规划与任务会使用最新口径");
        setDirty(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存失败");
      }
    });
  }

  async function infer() {
    setInferring(true);
    try {
      const inferred = await inferSchemaFromData(sourceId);
      if (!inferred.length) {
        toast.info("当前数据里没有发现 extra 字段");
      } else {
        setFields(inferred);
        setDirty(true);
        toast.success(`已从真实数据推断出 ${inferred.length} 个字段，请核对用途后保存`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "推断失败，请确认已导入数据");
    } finally {
      setInferring(false);
    }
  }

  const counts = fields.reduce(
    (acc, f) => ({ ...acc, [f.usage]: (acc[f.usage] ?? 0) + 1 }),
    {} as Record<string, number>,
  );

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 p-4 md:p-8">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-sm font-semibold">extra 字段 Schema</CardTitle>
            <CardDescription className="max-w-3xl text-[12.5px] leading-relaxed">
              手工定义 extra 里每个字段的语义、类型与<strong className="font-medium text-foreground">分析用途</strong>。
              这份 schema 会随数据一起交给模型：标记为「指标」的字段会被聚合成 KPI，「分群」字段会成为图表维度，
              「上下文」只用于辅助理解，「过滤」用于判断样本取舍。规划阶段与任务执行都会读取最新配置。
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={infer} disabled={inferring}>
              {inferring ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
              从数据推断
            </Button>
            <Button size="sm" onClick={save} disabled={pending || !dirty}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {dirty ? "保存更改" : "已保存"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            {USAGES.map((u) => (
              <Badge key={u.value} variant="outline" className="gap-1.5 py-1 font-normal">
                {u.label}
                <span className="num text-muted-foreground">{counts[u.value] ?? 0}</span>
              </Badge>
            ))}
            <span className="ml-auto text-muted-foreground">共 {fields.length} 个字段</span>
          </div>
        </CardContent>
      </Card>

      {fields.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[13px] text-muted-foreground">
              还没有配置 extra 字段。如果数据已经导入，可以直接「从数据推断」，也可以手工添加。
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setFields([blank()]); setDirty(true); }}>
                <Plus className="size-3.5" />
                手工添加字段
              </Button>
              <Button variant="outline" size="sm" onClick={infer} disabled={inferring}>
                {inferring ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                从数据推断
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {fields.map((f, i) => (
            <Card key={i} className={cn("overflow-hidden", !f.name.trim() && "border-[var(--warning)]/60")}>
              <CardContent className="space-y-3 p-4">
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-[170px_150px_120px_120px_150px_1fr_auto]">
                  <Field label="字段名">
                    <Input
                      value={f.name}
                      onChange={(e) => patch(i, { name: e.target.value.replace(/\s/g, "") })}
                      placeholder="extra 中的键"
                      className="h-8 font-mono text-[12px]"
                    />
                  </Field>
                  <Field label="显示名">
                    <Input
                      value={f.label}
                      onChange={(e) => patch(i, { label: e.target.value })}
                      placeholder="中文名"
                      className="h-8 text-[12px]"
                    />
                  </Field>
                  <Field label="类型">
                    <Select value={f.kind} onValueChange={(v) => patch(i, { kind: v as ExtraFieldKind })}>
                      <SelectTrigger className="h-8 text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KINDS.map((k) => (
                          <SelectItem key={k.value} value={k.value} className="text-[12px]">
                            {k.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="层级">
                    <Select value={f.scope} onValueChange={(v) => patch(i, { scope: v as "message" | "session" })}>
                      <SelectTrigger className="h-8 text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="message" className="text-[12px]">消息级</SelectItem>
                        <SelectItem value="session" className="text-[12px]">会话级</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="分析用途">
                    <Select value={f.usage} onValueChange={(v) => patch(i, { usage: v as ExtraFieldUsage })}>
                      <SelectTrigger className="h-8 text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {USAGES.map((u) => (
                          <SelectItem key={u.value} value={u.value} className="text-[12px]">
                            <span className="flex items-center gap-2">
                              {u.label}
                              <span className="text-[10.5px] text-muted-foreground">{u.hint}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="语义说明（供 AI 理解口径）">
                    <Input
                      value={f.description ?? ""}
                      onChange={(e) => patch(i, { description: e.target.value })}
                      placeholder="例如：低于 0.6 通常意味着噪声导致的误识别"
                      className="h-8 text-[12px]"
                    />
                  </Field>
                  <div className="flex items-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setFields((prev) => prev.filter((_, idx) => idx !== i));
                        setDirty(true);
                      }}
                      aria-label="删除字段"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {(f.kind === "enum" || f.kind === "sentiment") && (
                  <div className="border-t border-border/60 pt-3">
                    <div className="mb-1.5 text-[11.5px] text-muted-foreground">
                      可选值（回车添加，点击标签删除）
                    </div>
                    <OptionsEditor
                      options={f.options ?? []}
                      onChange={(options) => patch(i, { options })}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          <Button
            variant="outline"
            size="sm"
            className="w-full border-dashed"
            onClick={() => {
              setFields((prev) => [...prev, blank()]);
              setDirty(true);
            }}
          >
            <Plus className="size-3.5" />
            添加字段
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10.5px] font-medium tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => (
        <span
          key={o}
          className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 font-mono text-[11.5px]"
        >
          {o}
          <button
            type="button"
            className="text-muted-foreground transition-colors hover:text-destructive"
            onClick={() => onChange(options.filter((x) => x !== o))}
            aria-label={`删除 ${o}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            e.preventDefault();
            const v = draft.trim();
            if (!options.includes(v)) onChange([...options, v]);
            setDraft("");
          } else if (e.key === "Backspace" && !draft && options.length) {
            onChange(options.slice(0, -1));
          }
        }}
        placeholder={options.length ? "继续添加…" : "输入取值后回车"}
        className="min-w-[120px] flex-1 border-none bg-transparent px-1 py-0.5 text-[12px] outline-none placeholder:text-muted-foreground/70"
      />
    </div>
  );
}
