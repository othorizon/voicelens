"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, RotateCcw } from "lucide-react";
import { updateTemplatePrompt } from "@/lib/actions/studio";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface TemplatePrompt {
  id: string;
  version: number;
  session_prompt: string;
  user_prompt: string;
  global_prompt: string;
  report_prompt: string;
}

const TABS = [
  { key: "session", label: "会话层提示词", hint: "每次接收单个 session 的完整转录（含时间戳、extra、可选音频），输出结构化分析结果。" },
  { key: "user", label: "用户层提示词", hint: "接收该用户全部 session 的结构化结果，跨会话归纳画像、诉求与行为模式。" },
  { key: "global", label: "全局层提示词", hint: "接收用户层结论 + 平台真实统计，输出决策级洞察、指标、分布与建议。" },
  { key: "report", label: "报告生成提示词", hint: "接收三层结果，规划报告章节、图表选型与下探入口，输出报告结构 JSON。" },
] as const;

export function PromptViewer({
  template,
  onSaved,
}: {
  template: TemplatePrompt;
  /** Saving forks a new version; the page has to pull it in and select it. */
  onSaved?: (created: { id: string; version: number }) => void | Promise<void>;
}) {
  const [tab, setTab] = useState<string>("session");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const current = draft[tab] ?? (template as unknown as Record<string, string>)[`${tab}_prompt`] ?? "";

  function save() {
    startTransition(async () => {
      try {
        const patch = Object.fromEntries(
          Object.entries(draft).filter(([, v]) => v.trim().length > 0),
        ) as Partial<TemplatePrompt>;
        const res = await updateTemplatePrompt(template.id, patch);
        toast.success(`已保存为新版本 v${res.version}`);
        setDraft({});
        setEditing(false);
        await onSaved?.(res);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存失败");
      }
    });
  }

  const meta = TABS.find((t) => t.key === tab)!;

  return (
    <div className="rounded-xl border border-border/70 bg-card">
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 pt-2">
          <TabsList className="h-8 bg-transparent p-0">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="h-8 rounded-t-md text-[12px] data-[state=active]:bg-accent">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="ml-auto flex items-center gap-1.5 pb-1.5">
            {editing ? (
              <>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11.5px]" onClick={() => { setDraft({}); setEditing(false); }}>
                  <RotateCcw className="size-3" />
                  放弃
                </Button>
                <Button size="sm" className="h-7 px-2.5 text-[11.5px]" onClick={save} disabled={pending}>
                  {pending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                  存为新版本
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-[11.5px]"
                onClick={() => {
                  setDraft({
                    session: template.session_prompt,
                    user: template.user_prompt,
                    global: template.global_prompt,
                    report: template.report_prompt,
                  });
                  setEditing(true);
                }}
              >
                <Pencil className="size-3" />
                编辑提示词
              </Button>
            )}
          </div>
        </div>

        {TABS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="mt-0 px-3 pb-3">
            <p className="py-2 text-[11.5px] leading-relaxed text-muted-foreground">{t.hint}</p>
            {editing ? (
              <Textarea
                value={current}
                onChange={(e) => setDraft((d) => ({ ...d, [t.key]: e.target.value }))}
                rows={22}
                className="font-mono text-[11.5px] leading-relaxed"
                spellCheck={false}
              />
            ) : (
              <pre className="max-h-[46vh] overflow-auto rounded-lg border border-border/60 bg-muted/25 p-3.5 font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap text-foreground/85 scrollbar-thin">
                {(template as unknown as Record<string, string>)[`${t.key}_prompt`] || "（空）"}
              </pre>
            )}
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{meta.label}</span>
              <span className="num">
                {((template as unknown as Record<string, string>)[`${t.key}_prompt`] ?? "").length} 字
              </span>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
