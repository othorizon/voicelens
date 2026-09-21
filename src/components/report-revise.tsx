"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, ExternalLink, Loader2, Paintbrush } from "lucide-react";
import { reviseReport } from "@/lib/actions/tasks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDate } from "@/lib/utils";
import type { ReportVersion } from "@/lib/report-history";

/**
 * Ask for a change to the report that exists, and read its history.
 *
 * The button next to it — 重新生成报告 — designs a different report from the
 * brief. This one keeps the report and changes what the note asks for, which is
 * what people actually want when a page is right apart from one chart. The two
 * are deliberately not the same control: which of them is wanted is the whole
 * decision, and a single button would have to guess.
 *
 * Every version stays reachable, because the reason to keep them is comparison:
 * a revision that turned out worse is only obviously worse next to the one it
 * came from.
 */
export function ReportRevise({
  taskId,
  versions,
  active,
}: {
  taskId: string;
  versions: ReportVersion[];
  /** The task is queued or running — nothing new can be asked for yet. */
  active: boolean;
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  const latest = versions[0];
  const revisable = Boolean(latest?.revisable);

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-sm font-semibold">按建议修改报告</CardTitle>
        <CardDescription className="text-[12px]">
          模型会拿到现在这份报告页面、它在浏览器里的渲染截图和你的建议，只改建议指到的地方，其余原样保留 —— 不重新分析，也不重新设计。
          想整份换一个设计，用上方的「重新生成报告」。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3.5">
          <Label className="text-[11.5px] font-medium">修改建议</Label>
          <p className="mt-1 mb-2 text-[11.5px] leading-relaxed text-muted-foreground">
            越具体越好：指明是哪一处、现在是什么样、希望改成什么样。例如「KPI 卡片在手机上挤成两行，改成两列」
            「失败原因那张饼图取值太多了，换成排序条形图并合并长尾」「把结论段落放到第一张图之前」。
          </p>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={4}
            placeholder="写下这份报告需要改的地方…"
            className="text-[12.5px]"
            disabled={!revisable || active}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="h-8"
              disabled={!feedback.trim() || !revisable || active || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await reviseReport(taskId, feedback);
                  toast.success("已排队：按建议修改报告");
                  setFeedback("");
                  router.refresh();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "按建议修改报告失败");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Paintbrush className="size-3.5" />}
              按建议修改报告
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {active
                ? "任务正在运行，完成后才能提交修改。"
                : revisable
                  ? `基于 v${latest?.version ?? "?"} 生成新版本，旧版本保留，可随时对比。`
                  : latest?.engine === "spec"
                    ? "当前报告由内置渲染器产出，没有可修改的页面源码：先「重新生成报告」拿到 AI 生成的页面。"
                    : "当前报告没有保存页面源码（生成于本功能上线之前）：先「重新生成报告」。"}
            </span>
          </div>
        </div>

        {versions.length ? (
          <div>
            <div className="mb-2 text-[11.5px] font-medium">报告版本</div>
            <div className="space-y-1.5">
              {versions.map((v, i) => (
                <VersionRow key={v.id} taskId={taskId} version={v} current={i === 0} />
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function VersionRow({
  taskId,
  version: v,
  current,
}: {
  taskId: string;
  version: ReportVersion;
  current: boolean;
}) {
  const issues = (v.validation?.issues ?? []) as { level: string; kind: string; message: string }[];
  const warnings = issues.filter((i) => i.level === "warn").length;
  // The current version is served without a `report` parameter, so the link
  // stays valid even for a row written before versions were numbered.
  const query = current ? "" : `?report=${encodeURIComponent(v.id)}`;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 text-[11.5px]",
        current ? "border-primary/45 bg-accent/30" : "border-border/70 bg-card",
      )}
    >
      <span className="num shrink-0 font-semibold">v{v.version ?? "?"}</span>
      <span className="shrink-0 rounded bg-muted px-1 text-[10.5px] text-muted-foreground">{howMade(v)}</span>
      {current ? (
        <span className="shrink-0 rounded bg-primary/15 px-1 text-[10.5px] text-primary">当前</span>
      ) : null}
      <span className="num shrink-0 text-muted-foreground">{formatDate(String(v.created_at))}</span>
      {warnings ? (
        <span className="shrink-0 text-muted-foreground" title={issues.map((i) => i.message).join("\n")}>
          {warnings} 项可改善
        </span>
      ) : null}
      {v.feedback ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={v.feedback}>
          「{v.feedback}」
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[11px]">
          <a href={`/api/report/task/${taskId}${query}`} target="_blank" rel="noreferrer">
            <ExternalLink className="size-3" />
            查看
          </a>
        </Button>
        <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[11px]">
          <a href={`/api/report/task/${taskId}${query ? `${query}&` : "?"}download=1`}>
            <Download className="size-3" />
            下载
          </a>
        </Button>
      </div>
    </div>
  );
}

/** How the version came to be. Lives here because this is the only renderer. */
function howMade(v: ReportVersion): string {
  if (v.kind === "revision") return "按建议修改";
  if (v.kind === "final-fallback" || v.engine === "spec") return "内置渲染器";
  return "AI 生成页面";
}
