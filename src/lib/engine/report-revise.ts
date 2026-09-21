import { runReportAgent } from "./report-agent";
import { reportBriefing, reportSystemPrompt, type GeneratePageResult } from "./report-generate";
import { renderDataProfile } from "./report-profile";
import type { ReportPayload, ReportSnapshot } from "./report-runtime";
import type { AnalysisRuntime } from "@/lib/models/registry";

/**
 * Change a report that already exists, instead of asking for another one.
 *
 * Regenerating is what the platform could do until now: the brief goes back to
 * the model and a different page comes out. That is the wrong tool for the
 * complaint people actually have. "这个图例压在标题上"、"结论那段顺序反了" is a
 * note about *this* page — and a fresh generation answers it by throwing away
 * the layout they were otherwise happy with, then possibly reintroducing the
 * same defect somewhere else.
 *
 * So the previous page comes back as the starting point, rendered first so the
 * model can see the state it is being asked to change, and the note travels as
 * the reason. The loop underneath is the same one that wrote the page, which is
 * what makes a revision safe: whatever the model does here still has to render
 * in a real browser before it is accepted, and a revision that breaks the page
 * loses to the version it started from.
 *
 * Patching is strongly preferred over rewriting, and not only to save tokens: a
 * few hundred lines rewritten to move a legend is a few hundred lines of new
 * chances to break something that worked.
 */

export interface ReviseReportInput {
  runtime: AnalysisRuntime;
  /** The planner's report prompt — the design brief the page was written to. */
  brief: string;
  payload: ReportPayload;
  snapshot?: ReportSnapshot | null;
  /** The page to change: the model's own document, before runtime injection. */
  page: string;
  /** What the reviewer wants different, in their words. */
  feedback: string;
  /** Model turns including the first; each turn is one call. */
  maxAttempts?: number;
  vision?: boolean;
  onStep?: (message: string) => void;
  /** Checked between turns; a reason ends the loop. See `runReportAgent`. */
  shouldStop?: () => Promise<string | null>;
}

export interface ReviseReportResult extends GeneratePageResult {
  /** How the change was made, for the log the operator reads afterwards. */
  mode: "patch" | "rewrite" | "mixed" | "none";
}

function taskPrompt(payload: ReportPayload, profileText: string): string {
  return `${reportBriefing(payload, profileText)}

# 你这次的任务
这份报告已经生成过了，页面就是上面那一份（assistant 消息里的完整 HTML）。**现在不是重新设计，而是按评审意见改它。**

要求：
1. **只改被指出的地方。** 没有被提到的章节、配色、图表、交互一律原样保留 —— 评审者认可现在这份页面的其余部分。
2. **优先用 \`<vl:patch>\` 局部修改。** 只有当意见本身要求改变整体结构、或者要改的地方太多太散时，才整份重写。
3. 意见里描述的是「看起来不对」的现象时，先看截图和校验结果定位真正的原因，再改 —— 不要凭猜测调样式。
4. 意见与硬性规则冲突时（例如要求把数字写死在页面里、要求引用远程图片），按规则来，并在 \`<vl:done/>\` 里说明哪一条没有照办、为什么。
5. 改完仍然要通过渲染校验：页面必须调用 \`VL.done()\`，不能报错、不能白屏、不能在 390px 下横向溢出。`;
}

function note(feedback: string): string {
  return `评审者对这份报告提出了以下修改意见：
"""
${feedback.trim()}
"""

请先判断这些意见分别对应页面里的哪一处，然后动手改。只改这些，其余保持原样。`;
}

export async function reviseReportPage(input: ReviseReportInput): Promise<ReviseReportResult> {
  if (!input.page.trim()) {
    throw new Error("这份报告没有保存可修改的页面源码，只能重新生成");
  }
  if (!input.feedback.trim()) throw new Error("请填写修改建议");

  const profileText = renderDataProfile(input.payload.profile);

  const result = await runReportAgent({
    runtime: input.runtime,
    payload: input.payload,
    snapshot: input.snapshot,
    seed: {
      system: reportSystemPrompt(input.brief),
      task: taskPrompt(input.payload, profileText),
      base: { page: input.page, note: note(input.feedback) },
    },
    maxTurns: input.maxAttempts,
    vision: input.vision,
    label: "按建议修改报告",
    onStep: input.onStep,
    shouldStop: input.shouldStop,
  });

  const patched = result.history.some((h) => h.did.includes("应用了"));
  const rewritten = result.history.some((h) => h.did.includes("重写整页"));

  return {
    page: result.page,
    document: result.document,
    validation: result.validation,
    attempts: result.turns,
    tokens: result.tokens,
    shots: result.shots,
    history: result.history,
    mode: patched && rewritten ? "mixed" : patched ? "patch" : rewritten ? "rewrite" : "none",
  };
}
