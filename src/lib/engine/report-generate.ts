import { chat, type ChatMessage } from "./ai";
import { requireModel, type AnalysisRuntime } from "@/lib/models/registry";
import { stageOptions, textModelKind } from "@/lib/models/mode";
import { renderDataProfile } from "./report-profile";
import { composeReportDocument, VL_API_DOC, type ReportPayload } from "./report-runtime";
import {
  renderIssues,
  validateReportDocument,
  type ValidationIssue,
  type ValidationResult,
} from "./report-validate";

/**
 * Write the report page for this run's data, then prove it renders.
 *
 * The model is given a design brief, the data profile and the VL contract,
 * and writes a whole document — markup, styling, charts, interaction. What
 * comes back is loaded in a real browser; if it does not render, the failures
 * go back to the model and it tries again. Only a page that rendered is
 * returned as usable, so the caller always knows whether to fall back.
 */

/**
 * A page runs to a few thousand lines, which the JSON-era budget of 16k
 * tokens cuts off around the first chart. The stage setting still wins when
 * an operator raised it, and 0 still means "no limit".
 */
const HTML_TOKEN_FLOOR = 64000;

export interface GeneratePageInput {
  runtime: AnalysisRuntime;
  /** The planner's report prompt, used here as the design brief. */
  brief: string;
  payload: ReportPayload;
  /** Total tries including the first; each retry sees the previous failures. */
  maxAttempts?: number;
  onStep?: (message: string) => void;
}

export interface GeneratePageResult {
  /** The model's document, before the runtime is injected. */
  page: string;
  /** What gets stored and served. */
  document: string;
  validation: ValidationResult;
  attempts: number;
  tokens: number;
  screenshot?: Buffer;
}

/* ------------------------------------------------------------------ prompt */

function systemPrompt(brief: string): string {
  return `你是一名资深的数据可视化工程师兼信息设计师。你的任务是为一批**具体的**分析数据设计并实现一份单页 HTML 报告。

这不是套模板。页面的章节结构、视觉语言、图表形态、交互方式全部由你根据这批数据的实际形状决定 —— 数据里什么最值得说，页面就应该长成什么样。

# 本次报告的设计要求（由规划阶段针对该数据源生成）
${brief}

# 数据接口
${VL_API_DOC}

# 输出格式
只输出一个完整的 HTML 文档，从 \`<!doctype html>\` 开始、到 \`</html>\` 结束。
不要输出 Markdown 代码块，不要任何解释文字、前言或结语。整个回答就是这份 HTML。`;
}

function userPrompt(payload: ReportPayload, profileText: string): string {
  const m = payload.meta;
  return `# 报告基本信息
标题：${m.title}
数据范围：${m.scopeNote}
语言：${m.language === "en" ? "English" : "中文"}
基调：${m.tone || "客观、数据驱动、结论先行"}
是否可引用原文证据：${m.includeEvidence ? "是（VL.evidence 里有可引用的片段）" : "否"}

# 数据画像
下面是这批数据的真实统计特征。**这不是样例数据，而是你要设计的那批数据本身的形状。**
页面必须在这些数字下成立：分类有多少种就要能显示多少种，文本有多长就要能容纳多长，
有多少行就要按多少行考虑渲染成本。

${profileText}

# 设计要求
1. **先读画像再定结构**。哪些字段的分布最有信息量，哪些几乎是常量，决定了哪些该做成主线章节、哪些一笔带过。不要机械地每个字段配一张图。
2. **图表形态跟着数据走**。取值少且互斥可以用占比图；取值多、长尾重的用排序条形图并合并尾部；有序数值用分布直方图或箱形；两个数值字段的关系才用散点。画像里 \`topCoverage\` 偏低时，占比图一定会骗人。
3. **结论先行**。\`VL.global.summary\` 和 \`VL.global.findings\` 是这批数据的结论，应该出现在最显眼的位置，图表是它的论据而不是相反。
4. **真值优先**。\`VL.groundTruth.metrics\` 是平台用 SQL 直算的权威口径，同名指标以它为准，并把 \`formula\` 作为口径说明展示出来。
5. **下探是这个平台的核心能力**。报告要能从全局钻到用户、再钻到具体会话和原文转录，用 \`VL.listUsers\` / \`VL.getUser\` / \`VL.getSession\` 实现。注意总量可能上万，必须分页或虚拟滚动，不要一次性渲染。
6. **自适应**。同一份代码在几十行和上万行数据下都要好看：空数组要有占位，超长文本要截断或折叠，缺失值要跳过而不是当 0。
7. **可用性**。支持深色/浅色（\`prefers-color-scheme\`），390px 窄屏不能横向溢出，\`@media print\` 下要能打印成 PDF。
8. 视觉风格由你决定，但要专业、克制、信息密度高，像一份给决策者看的分析报告，而不是演示页。

现在输出这份 HTML。`;
}

/* ---------------------------------------------------------------- extract */

/**
 * Models wrap output in fences even when told not to, and occasionally add a
 * sentence before it. Take the document and drop the rest.
 */
export function extractHtml(text: string): string {
  let s = text.trim();

  const fence = s.match(/```(?:html?)?\s*\n([\s\S]*?)(?:\n```|$)/i);
  if (fence && /<(?:!doctype|html)/i.test(fence[1])) s = fence[1].trim();

  const start = s.search(/<!doctype\s+html|<html[\s>]/i);
  if (start > 0) s = s.slice(start);

  const end = s.toLowerCase().lastIndexOf("</html>");
  if (end !== -1) s = s.slice(0, end + "</html>".length);

  return s.trim();
}

/** A page cut off mid-tag fails every other check for confusing reasons. */
function truncationIssue(page: string, finishReason: string | null): ValidationIssue | null {
  const complete = /<\/html\s*>$/i.test(page.trim());
  if (complete) return null;
  return {
    level: "error",
    kind: "truncated",
    message:
      finishReason === "length"
        ? "回答在写完之前达到了长度上限，页面不完整。请把实现写得更紧凑：复用渲染函数、减少重复的内联样式，确保能在一次回答里写完整份文档。"
        : "输出不是一个完整的 HTML 文档（缺少结尾的 </html>）。",
  };
}

/* -------------------------------------------------------------------- run */

export async function generateReportPage(input: GeneratePageInput): Promise<GeneratePageResult> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  const step = input.onStep ?? (() => {});
  const profileText = renderDataProfile(input.payload.profile);

  const system = systemPrompt(input.brief);
  const user = userPrompt(input.payload, profileText);

  const stage = stageOptions(input.runtime.stages, "report");
  const options = {
    model: requireModel(input.runtime, textModelKind(input.runtime.mode), "报告页面生成"),
    temperature: 0.6,
    label: "报告页面生成",
    ...stage,
    // Only raise a budget that was left at the JSON-era default; an explicit
    // 0 means the operator wants the model to stop where it stops.
    ...(stage.maxTokens !== undefined && stage.maxTokens < HTML_TOKEN_FLOOR
      ? { maxTokens: HTML_TOKEN_FLOOR }
      : {}),
  };

  let tokens = 0;
  let best: { page: string; document: string; validation: ValidationResult } | null = null;
  let previous: { page: string; issues: string } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    step(attempt === 1 ? "设计报告页面" : `按校验结果重写报告页面（第 ${attempt} 次）`);

    // Only the most recent attempt is carried, so context stays at roughly
    // two pages however many rounds it takes.
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    if (previous) {
      messages.push({ role: "assistant", content: previous.page });
      messages.push({
        role: "user",
        content: `这份页面在真实浏览器里的校验结果如下。\n\n${previous.issues}\n\n请修正这些问题，重新输出**完整的** HTML 文档（不是补丁、不是片段、不要解释）。除必要的修改外保留原有设计。`,
      });
    }

    const res = await chat(messages, options);
    tokens += res.usage.total_tokens;

    const page = extractHtml(res.text);
    const cut = truncationIssue(page, res.finishReason);

    let validation: ValidationResult;
    if (cut) {
      validation = {
        ok: false,
        issues: [cut],
        stats: { textChars: 0, domNodes: 0, scrollHeight: 0, overflowPx: 0, durationMs: 0 },
      };
    } else {
      step(`校验页面（第 ${attempt} 次）`);
      validation = await validateReportDocument(composeReportDocument(page, input.payload));
    }

    const document = composeReportDocument(page, input.payload);
    const errors = validation.issues.filter((i) => i.level === "error").length;

    if (validation.ok) {
      step(`页面校验通过（第 ${attempt} 次尝试）`);
      return { page, document, validation, attempts: attempt, tokens, screenshot: validation.screenshot };
    }

    // Keep whichever attempt came closest, in case none of them passes.
    const bestErrors = best ? best.validation.issues.filter((i) => i.level === "error").length : Infinity;
    if (errors < bestErrors) best = { page, document, validation };

    step(`页面未通过校验（${errors} 个错误）`);
    previous = { page, issues: renderIssues(validation.issues) };
  }

  const fallback = best ?? {
    page: "",
    document: "",
    validation: {
      ok: false,
      issues: [{ level: "error" as const, kind: "no-output", message: "模型没有产出可用页面。" }],
      stats: { textChars: 0, domNodes: 0, scrollHeight: 0, overflowPx: 0, durationMs: 0 },
    },
  };
  return {
    ...fallback,
    attempts: maxAttempts,
    tokens,
    screenshot: fallback.validation.screenshot,
  };
}
