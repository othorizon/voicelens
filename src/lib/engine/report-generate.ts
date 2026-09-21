import { PROTOCOL_DOC, runReportAgent, type AgentTurnNote } from "./report-agent";
import { renderDataProfile } from "./report-profile";
import { VL_API_DOC, type ReportPayload, type ReportSnapshot } from "./report-runtime";
import type { AnalysisRuntime } from "@/lib/models/registry";
import type { ReportShot, ValidationResult } from "./report-validate";

/**
 * Write the report page for this run's data, then prove it renders.
 *
 * The model is given a design brief, the data profile and the VL contract, and
 * writes a whole document — markup, styling, charts, interaction. From there it
 * works against a real browser: `report-agent` loads what it wrote, hands back
 * the failures *and* the frames, and lets it patch, look again and ask about the
 * data until the page holds up. Only a page that rendered is returned as
 * usable, so the caller always knows whether to fall back.
 *
 * What lives here is the contract — who the model is, what it is designing for,
 * and what the data looks like. The loop that enforces it lives next door.
 */

export interface GeneratePageInput {
  runtime: AnalysisRuntime;
  /** The planner's report prompt, used here as the design brief. */
  brief: string;
  payload: ReportPayload;
  /**
   * Detail rows to carry inside the document, for a report small enough to
   * need no host. Validation then exercises drill-down for real instead of
   * watching every call fail for want of a parent window.
   */
  snapshot?: ReportSnapshot | null;
  /** Model turns including the first; each turn is one call. */
  maxAttempts?: number;
  /** Show the model its own renders. Off only for a text-only endpoint. */
  vision?: boolean;
  onStep?: (message: string) => void;
  /** Checked between turns; a reason ends the loop. See `runReportAgent`. */
  shouldStop?: () => Promise<string | null>;
}

export interface GeneratePageResult {
  /** The model's document, before the runtime is injected. */
  page: string;
  /** What gets stored and served. */
  document: string;
  validation: ValidationResult;
  /** Model turns spent. Recorded as `report_attempts` on the task's stats. */
  attempts: number;
  tokens: number;
  /** The frames of the page being returned. */
  shots: ReportShot[];
  history: AgentTurnNote[];
}

/* ------------------------------------------------------------------ prompt */

/** Role, brief and both contracts — constant for every turn of a run. */
export function reportSystemPrompt(brief: string): string {
  return `你是一名资深的数据可视化工程师兼信息设计师。你的任务是为一批**具体的**分析数据设计并实现一份单页 HTML 报告。

这不是套模板。页面的章节结构、视觉语言、图表形态、交互方式全部由你根据这批数据的实际形状决定 —— 数据里什么最值得说，页面就应该长成什么样。

# 本次报告的设计要求（由规划阶段针对该数据源生成）
${brief}

# 数据接口
${VL_API_DOC}

# 工作方式
${PROTOCOL_DOC}`;
}

/** The design requirements, unchanged whether the page is new or being fixed. */
const DESIGN_RULES = `1. **先读画像再定结构**。哪些字段的分布最有信息量，哪些几乎是常量，决定了哪些该做成主线章节、哪些一笔带过。不要机械地每个字段配一张图。
2. **图表形态跟着数据走**。取值少且互斥可以用占比图；取值多、长尾重的用排序条形图并合并尾部；有序数值用分布直方图或箱形；两个数值字段的关系才用散点。画像里 \`topCoverage\` 偏低时，占比图一定会骗人。
3. **结论先行**。\`VL.global.summary\` 和 \`VL.global.findings\` 是这批数据的结论，应该出现在最显眼的位置，图表是它的论据而不是相反。
4. **真值优先**。\`VL.groundTruth.metrics\` 是平台用 SQL 直算的权威口径，同名指标以它为准，并把 \`formula\` 作为口径说明展示出来。
5. **下探是这个平台的核心能力**。报告要能从全局钻到用户、再钻到具体会话和原文转录，用 \`VL.listUsers\` / \`VL.getUser\` / \`VL.getSession\` 实现。注意总量可能上万，必须分页或虚拟滚动，不要一次性渲染。
6. **自适应**。同一份代码在几十行和上万行数据下都要好看：空数组要有占位，超长文本要截断或折叠，缺失值要跳过而不是当 0。
7. **可用性**。支持深色/浅色（\`prefers-color-scheme\`），390px 窄屏不能横向溢出，\`@media print\` 下要能打印成 PDF。这三条平台会逐项校验并把截图发回给你。
8. 视觉风格由你决定，但要专业、克制、信息密度高，像一份给决策者看的分析报告，而不是演示页。`;

/** The data this page is for: what it is about, and what shape it is. */
export function reportBriefing(payload: ReportPayload, profileText: string): string {
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

${profileText}`;
}

function taskPrompt(payload: ReportPayload, profileText: string): string {
  return `${reportBriefing(payload, profileText)}

# 设计要求
${DESIGN_RULES}

现在输出这份 HTML（第一轮请输出完整文档）。`;
}

/* -------------------------------------------------------------------- run */

export async function generateReportPage(input: GeneratePageInput): Promise<GeneratePageResult> {
  const profileText = renderDataProfile(input.payload.profile);

  const result = await runReportAgent({
    runtime: input.runtime,
    payload: input.payload,
    snapshot: input.snapshot,
    seed: {
      system: reportSystemPrompt(input.brief),
      task: taskPrompt(input.payload, profileText),
    },
    maxTurns: input.maxAttempts,
    vision: input.vision,
    label: "报告页面生成",
    onStep: input.onStep,
    shouldStop: input.shouldStop,
  });

  return {
    page: result.page,
    document: result.document,
    validation: result.validation,
    attempts: result.turns,
    tokens: result.tokens,
    shots: result.shots,
    history: result.history,
  };
}

/** Kept here so callers that only know this module can still unwrap a reply. */
export { extractHtml } from "./report-edit";
