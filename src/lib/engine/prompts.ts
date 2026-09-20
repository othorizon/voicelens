import type { ExtraFieldDef, JsonObject } from "@/lib/types";
import type { ChatMessage } from "./ai";
import { truncate } from "./normalize";

/* ------------------------------------------------------------------ schema */

/**
 * Every contract below is itself valid JSON, and deliberately so: a model shown
 * `"value": 数字` or `{label,value,unit}` as an example copies that shape into
 * its answer, and a bare key or a Chinese word where a value belongs is exactly
 * the "Expected double-quoted property name" that used to kill a report after
 * the model had already written four thousand tokens of it. The semantics that
 * used to live inside the braces now live in a legend under them.
 */
export const SESSION_JSON_CONTRACT = `{
  "summary": "1-3 句话概括这次会话发生了什么、用户想要什么、结果如何",
  "intent": "用户核心意图，短语形式",
  "outcome": "resolved",
  "sentiment": "neutral",
  "quality_score": 0,
  "risk_level": "none",
  "tags": ["3-8 个业务标签，短词"],
  "metrics": [{ "key": "英文 snake_case 唯一键", "label": "中文指标名", "value": 0, "unit": "可选单位" }],
  "highlights": ["做得好或值得关注的具体片段，每条 <= 40 字"],
  "problems": ["存在的问题，每条 <= 40 字"],
  "evidence": [{ "quote": "对话原文片段", "role": "user", "seq": 0 }]
}

取值说明（上面是结构示例，值要按真实情况填）：
- outcome：resolved | partial | unresolved | abandoned | unknown
- sentiment：positive | neutral | mixed | negative
- quality_score：0-100 的整数，衡量本次对话整体服务质量
- risk_level：none | low | medium | high
- metrics[].value：数字（不是字符串）
- evidence[].role：user 或 assistant；evidence[].seq：轮次序号，数字`;

export const USER_JSON_CONTRACT = `{
  "summary": "该用户的整体情况概述，2-4 句",
  "persona": "用户画像标签组合，例如「高频重度用户 · 价格敏感 · 易怒」",
  "needs": ["用户反复出现的核心诉求，3-6 条"],
  "behaviour": ["行为模式与交互习惯，3-6 条"],
  "metrics": [{ "key": "英文 snake_case", "label": "中文名", "value": 0, "unit": "可选" }],
  "risk_level": "none",
  "tags": ["3-8 个标签"],
  "key_sessions": ["最能说明该用户的 session_key，最多 5 个"]
}

取值说明：risk_level 取 none | low | medium | high；metrics[].value 是数字`;

export const GLOBAL_JSON_CONTRACT = `{
  "summary": "面向决策者的整体结论，4-8 句，结论先行",
  "findings": [{ "title": "发现标题", "detail": "支撑说明与量化依据", "severity": "info", "metric": "可选指标名" }],
  "metrics": [{ "key": "英文 snake_case", "label": "中文名", "value": 0, "unit": "可选" }],
  "distributions": [{ "key": "英文键", "label": "分布名", "unit": "可选", "items": [{ "name": "分类名", "value": 0 }] }],
  "recommendations": [{ "title": "建议", "detail": "怎么做、预期效果", "priority": "high", "impact": "可选影响面" }]
}

取值说明：severity 取 info | warning | critical；priority 取 high | medium | low；value 一律是数字`;

export const REPORT_SPEC_CONTRACT = `{
  "title": "报告标题",
  "subtitle": "副标题：数据范围与样本量",
  "level": "global",
  "meta": [{ "label": "口径说明", "value": "2026-08-01 ~ 2026-08-31 · 1,204 会话" }],
  "hero": {
    "headline": "一句话最重要的结论",
    "summary": "3-5 句整体摘要",
    "kpis": [{ "label": "指标名", "value": 0, "unit": "可选", "delta": null, "hint": "口径说明", "tone": "default" }]
  },
  "sections": [{
    "id": "overview",
    "title": "章节标题",
    "summary": "该章节 2-4 句导读",
    "drill": { "users": [], "sessions": [] },
    "blocks": [{ "kind": "markdown", "text": "见下方 block 类型" }]
  }]
}

取值说明：
- kpis[].value：数字或字符串；kpis[].delta：环比数字，没有就填 null；kpis[].tone：default | good | warn | bad
- sections[].id：英文短 id；drill.users / drill.sessions：可下探的 user_key / session_key，没有就留空数组

block 类型（kind 必填，其余字段按类型取用；每个示例都是可以直接解析的合法 JSON）：
1. {"kind":"kpis","title":"可选","kpis":[{"label":"指标名","value":0,"unit":"","delta":null,"hint":"口径说明","tone":"default","source_field":""}]}
   source_field 必填规则：若该 KPI 由某个 extra 字段算出，source_field 必须填该字段的英文 key（与 C 部分给出的字段名完全一致）；
   若是模型自己的判断（如 quality_score），source_field 填 "" 或省略。
2. {"kind":"markdown","title":"可选","text":"Markdown 正文，可用 **加粗**、列表、表格"}
3. {"kind":"bar","title":"","caption":"可选注释","categories":["分类"],"series":[{"name":"系列名","data":[0]}],"unit":"可选"}
4. {"kind":"hbar","title":"","categories":["分类"],"series":[{"name":"","data":[0]}],"unit":""}
5. {"kind":"line","title":"","categories":["x 轴"],"series":[{"name":"","data":[0]}]}
6. {"kind":"pie","title":"","categories":["分类"],"series":[{"name":"占比","data":[0]}]}
7. {"kind":"radar","title":"","categories":["维度"],"series":[{"name":"","data":[0]}]}
8. {"kind":"scatter","title":"","caption":"x=.. y=..","categories":["点名"],"series":[{"name":"y 值","data":[0]}]}
9. {"kind":"table","title":"","table":{"columns":["列名"],"rows":[["单元格",0]]}}
10. {"kind":"callout","title":"","text":"重点提示","tone":"info"}
11. {"kind":"list","title":"","items":["条目"]}
12. {"kind":"divider"}

图表类 block 里 data 的每一项都是数字；callout 的 tone 取 info | warning | critical | success。`;

/* ------------------------------------------------------------- extra 描述 */

export function describeExtraSchema(schema: ExtraFieldDef[] | undefined | null): string {
  if (!schema?.length) return "（该数据源未定义 extra 字段 schema）";
  const lines = schema.map((f) => {
    const parts = [
      `- ${f.name}（${f.label}）`,
      `类型=${f.kind}`,
      `层级=${f.scope}`,
      `用途=${f.usage}`,
    ];
    if (f.options?.length) parts.push(`可选值=[${f.options.join(" | ")}]`);
    if (f.description) parts.push(`语义=${f.description}`);
    return parts.join("，");
  });
  return [
    "数据源已定义的 extra 字段 schema（分析时必须按此口径使用这些字段）：",
    ...lines,
    "",
    "用途口径：",
    "- metric：需要聚合为数值指标（计数 / 均值 / 比率），并出现在报告的 KPI 或图表中",
    "- segment：作为分群维度，用于 group by，产出分布类图表",
    "- context：仅作为上下文帮助模型理解语义，不单独统计",
    "- filter：用于判断样本是否应纳入分析或标记异常",
  ].join("\n");
}

/* ---------------------------------------------------------------- sampling */

export interface SampleLayers {
  sessions: {
    session_key: string;
    user_key: string;
    started_at: string | null;
    turn_count: number;
    digest: string;
    extra: JsonObject;
    audios?: number;
  }[];
  users: { user_key: string; session_count: number; digests: string[] }[];
  global: {
    session_count: number;
    user_count: number;
    message_count: number;
    audio_count: number;
    extra_histogram: { key: string; values: { name: string; value: number }[] }[];
    outcome_hint?: string;
  };
}

export function renderSamples(samples: SampleLayers, maxDigest = 4000): string {
  const sessionBlocks = samples.sessions
    .map((s, i) => {
      const extra = s.extra && Object.keys(s.extra).length ? `\n  extra: ${JSON.stringify(s.extra)}` : "";
      const audio = s.audios ? `\n  音频：${s.audios} 个片段` : "";
      return [
        `【样本会话 ${i + 1}】session_key=${s.session_key} user_key=${s.user_key} 轮次=${s.turn_count} 时间=${s.started_at ?? "未知"}${audio}${extra}`,
        s.digest ? truncate(s.digest, maxDigest) : "（无转录）",
      ].join("\n");
    })
    .join("\n\n");

  const userBlocks = samples.users
    .map(
      (u, i) =>
        `【样本用户 ${i + 1}】user_key=${u.user_key}，共 ${u.session_count} 个会话\n` +
        u.digests.map((d, j) => `  · 会话${j + 1}：${truncate(d, 900)}`).join("\n"),
    )
    .join("\n\n");

  const hist = samples.global.extra_histogram
    .map((h) => `  ${h.key}: ${(h.values ?? []).map((it) => `${it.name}=${it.value}`).join(", ")}`)
    .join("\n");

  return [
    "==================== A. 会话层抽样 ====================",
    sessionBlocks || "（无）",
    "",
    "==================== B. 用户层抽样 ====================",
    userBlocks || "（无）",
    "",
    "==================== C. 全局统计 ====================",
    `会话总数=${samples.global.session_count}，用户总数=${samples.global.user_count}，消息总数=${samples.global.message_count}，含音频消息=${samples.global.audio_count}`,
    hist ? `extra 字段取值分布：\n${hist}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* -------------------------------------------------------------- 规划提示词 */

export function buildPlanningMessages(input: {
  dataSourceName: string;
  businessDesc: string;
  extraSchema: ExtraFieldDef[];
  samplesText: string;
  focus: string;
  audioNote: string;
}) {
  const system = `你是一名资深的对话数据分析专家，同时精通提示工程。你的工作是为一个「语音对话数据分析平台」设计一套可复用的分析提示词模板。

平台的数据结构：
- 三层视角：session（一次完整会话）→ user（一个终端用户的全部会话）→ global（整个数据源）
- 每条消息含 role（user / assistant，assistant 为 TTS 播报的 AI 回复）、content（OpenAI 范式）、timestamp、extra
- 数据来源是 ASR-LLM-TTS 三段式语音系统，因此可能存在 ASR 误识别、打断、TTS 延迟、兜底话术等语音特有问题
- 分析结果最终会渲染为一份可下探的单页 HTML 可视化报告

你会拿到：数据源的业务描述、extra 字段 schema、以及三个层级的真实抽样数据。你必须据此设计出针对性强、可直接执行的提示词。`;

  const user = `# 数据源
名称：${input.dataSourceName}
业务描述（用户撰写，是本次分析的总纲）：
"""
${input.businessDesc || "（未填写，请从抽样数据中推断业务场景，并在 rationale 中说明你的推断）"}
"""

# extra 字段 schema
${describeExtraSchema(input.extraSchema)}

# 真实抽样数据
${input.samplesText}

${input.audioNote}
${input.focus ? `# 用户本次额外强调\n${input.focus}\n` : ""}
# 你的任务
输出一个 JSON 对象，字段如下：

{
  "rationale": "你从抽样数据中读到的业务场景、数据特征、值得挖掘的分析角度，以及为什么这样设计提示词（200-400 字）",
  "detected_business": "一句话说明你判断这是什么业务",
  "session_prompt": "交给「会话层分析」的完整提示词。它每次接收单个 session 的完整转录（含时间戳、role、extra、可选音频），必须要求模型只输出 JSON，且严格符合下面给出的 SESSION 输出契约。提示词里要包含：角色设定、业务背景、需要重点判断的维度、如何使用 extra 字段（严格按 schema 的 metric/segment/context/filter 口径）、需要产出哪些 metrics（给出确切的 key 列表与计算口径）、如何给 quality_score / risk_level 打分（给出评分锚点）、evidence 的引用要求、禁止编造的约束。",
  "user_prompt": "交给「用户层汇总」的完整提示词。它接收该用户所有 session 的结构化结果（JSON 数组）与会话数统计，需要跨会话总结画像、诉求、行为模式、指标与风险，只输出 JSON，严格符合 USER 输出契约。",
  "global_prompt": "交给「全局层汇总」的完整提示词。它接收所有用户的汇总结果与全局分布统计，需要输出决策级结论、findings、全局 metrics、distributions（用于图表，必须给出真实的分类与数值）与 recommendations，只输出 JSON，严格符合 GLOBAL 输出契约。",
  "metric_schema": {
    "session": [{ "key": "英文键", "label": "中文名", "unit": "单位", "desc": "计算口径" }],
    "user": [{ "key": "", "label": "", "unit": "", "desc": "" }],
    "global": [{ "key": "", "label": "", "unit": "", "desc": "" }]
  },
  "report_prompt": "交给「报告生成」的完整提示词。它接收 global 结论、user 汇总列表、session 统计与分布，需要规划一份多章节单页报告，只输出 JSON，严格符合 REPORT 输出契约。提示词里要明确：报告标题与叙事结构（先结论后论据）、必须包含哪些章节（给出章节清单与每章目的）、每个章节适合用什么图表类型（bar/hbar/line/pie/radar/table/kpis/callout）、哪些 user_key 要出现在 drill.users 以便下探、语言与语气要求。",
  "report_outline": [{ "title": "章节标题", "purpose": "该章要回答的问题", "chart": "建议图表类型" }]
}

SESSION 输出契约（session_prompt 中必须原样要求模型输出这个结构）：
${SESSION_JSON_CONTRACT}

USER 输出契约：
${USER_JSON_CONTRACT}

GLOBAL 输出契约：
${GLOBAL_JSON_CONTRACT}

REPORT 输出契约：
${REPORT_SPEC_CONTRACT}

硬性要求：
1. 所有提示词都用中文书写（业务字段名保留英文键）。
2. 提示词必须自包含：接收方看不到本对话，需要把你写的背景、口径、契约完整传达。
   其中出现的 JSON 示例必须自身可以被 JSON.parse 解析：键名带双引号，不要 {a,b,c} 简写，
   不要把「数字」「可选」这类说明写在值的位置——这些说明放在示例外面单独列。
3. metrics 的 key 必须在三层之间保持一致的命名风格；user 与 global 层的 metrics 应能从 session 层聚合得到。
4. 只输出 JSON 对象本身，不要 Markdown 代码块、不要额外解释。`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return messages;
}

/* ---------------------------------------------------- 按建议定点修改模板 */

/**
 * The cheap half of the feedback loop: apply the reviewer's notes to the
 * template that is already there, instead of planning one again from scratch.
 *
 * Nothing is re-sampled and no audio is played, so the model is told plainly
 * that it cannot see the data — its only inputs are the existing prompts and
 * the note. That is also why every untouched prompt is carried over verbatim
 * by the caller rather than rewritten here: a model asked to "keep the rest"
 * will still quietly paraphrase it.
 */
export function buildRefineMessages(input: {
  dataSourceName: string;
  businessDesc: string;
  extraSchema: ExtraFieldDef[];
  feedback: string;
  previous: {
    version: number;
    session_prompt: string;
    user_prompt: string;
    global_prompt: string;
    report_prompt: string;
    metric_schema?: unknown;
    rationale?: string;
  };
}) {
  const system = `你是一名精通提示工程的对话数据分析专家，正在维护一个「语音对话数据分析平台」的分析提示词模板。

这一次你做的是**定点修改**，不是重新规划：
- 平台没有重新抽样，也没有重新试听音频，你看不到任何原始对话数据。
- 你手上只有现有模板的全文和用户的修改建议，请只依据这两者作答，不要凭空引入新的数据事实。
- 与建议无关的部分一律保持原样，改动范围越小越好。`;

  const user = `# 数据源
名称：${input.dataSourceName}
业务描述：
"""
${input.businessDesc || "（未填写）"}
"""

# extra 字段 schema（修改指标口径时必须遵守）
${describeExtraSchema(input.extraSchema)}

# 现有模板 v${input.previous.version}
${input.previous.rationale ? `## 当初的规划说明
${truncate(input.previous.rationale, 1200)}
` : ""}
## metric_schema
${JSON.stringify(input.previous.metric_schema ?? {}, null, 1)}

## session_prompt（会话层）
"""
${input.previous.session_prompt}
"""

## user_prompt（用户层）
"""
${input.previous.user_prompt}
"""

## global_prompt（全局层）
"""
${input.previous.global_prompt}
"""

## report_prompt（报告生成）
"""
${input.previous.report_prompt}
"""

# 用户在看过预览报告后提出的修改建议
"""
${input.feedback}
"""

# 你的任务
判断这条建议要落到哪几段提示词上，只改这几段，输出一个 JSON 对象：

{
  "change_note": "你改了什么、为什么这样改，以及建议里有哪些部分你无法只靠改提示词实现（120-300 字）",
  "changed": ["session_prompt"],
  "session_prompt": "改动后的完整提示词全文；没改这一段就省略这个键",
  "user_prompt": "同上",
  "global_prompt": "同上",
  "report_prompt": "同上",
  "metric_schema": {
    "session": [{ "key": "英文键", "label": "中文名", "unit": "单位", "desc": "计算口径" }],
    "user": [{ "key": "", "label": "", "unit": "", "desc": "" }],
    "global": [{ "key": "", "label": "", "unit": "", "desc": "" }]
  }
}

硬性要求：
1. changed 只列出你实际改动的键名，取值范围是 session_prompt | user_prompt | global_prompt | report_prompt。
   至少要改动一段——如果建议完全落不到提示词上，也要挑出最接近的一段做出可执行的调整，并在 change_note 里说明。
2. 被改动的提示词必须输出**完整全文**，不得输出 diff、省略号、「（其余同上）」这类占位写法；
   没有改动的提示词直接省略该键，平台会原样沿用旧版本。
3. 原模板里的 JSON 输出契约、字段取值范围、"只输出 JSON"这类纪律条款必须原样保留，不得删改。
4. 建议涉及新增/删除/改口径的指标时，要同步更新 metric_schema 与相关层的提示词，
   并保证 session / user / global 三层的 metric key 命名一致、可自底向上聚合。
   metric_schema 只在确实需要调整时输出；输出时给出完整的三层结构。
5. 提示词用中文书写（业务字段名保留英文键）。
6. 只输出 JSON 对象本身，不要 Markdown 代码块、不要额外解释。`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return messages;
}

/* ---------------------------------------------------------- 报告生成提示词 */

export function buildReportMessages(input: {
  reportPrompt: string;
  title: string;
  scopeNote: string;
  globalResult: JsonObject;
  userResults: { user_key: string; result: JsonObject }[];
  sessionStats: JsonObject;
  distributions: { key: string; values: { name: string; value: number }[] }[];
  /** Pre-computed by SQL; the model must reuse these values verbatim. */
  groundTruth?: string;
  language: string;
  includeEvidence: boolean;
  tone?: string;
  targetSections?: number;
  evidence: { session_key: string; user_key: string; problems: string[]; highlights: string[]; quotes: string[] }[];
}) {
  const system = `${input.reportPrompt}

你是这个平台的报告生成器。严格输出一个 JSON 对象，符合 REPORT 输出契约；不要 Markdown 代码块，不要任何解释文字。

JSON 语法纪律（写错一个字符整份报告就作废）：
- 每个键名都必须用双引号包起来，禁止 {label,value,unit} 这种简写。
- } 或 ] 前面不能有多余的逗号。
- 说明文字不是值：该填数字的位置就填数字，没有值就填 null 或省略这个键，不要写「数字」「可选」「环比数字」。

REPORT 输出契约：
${REPORT_SPEC_CONTRACT}

图表纪律（非常重要）：
- 所有 categories / series.data 里的数值必须来自下面给你的真实统计数据，禁止编造或估算。
- 每个 chart block 的 series 数组长度必须与 categories 长度一致。
- 优先使用你已知的真实分布；只有确实有数据支撑时才画该图。

指标口径纪律（硬性要求，不可协商）：
- 下面 C 部分是平台用 SQL 预先算好的确定性数值。凡是与其中某项同名的指标（KPI、图表、正文结论），
  都必须原样使用该数值，hint 里注明分子分母；不得替换、不得四舍五入到其他口径、不得改用你自己对该字段的判断。
- 严禁编造任何未发生的核验动作来为改写数值辩护，例如「经人工复核」「多为误标」「采用更严格口径」——
  你没有做任何复核，也没有资格否决数据库字段。
- 你认为业务上应该区分的另一种口径，只能作为**补充说明**并列写出，主数值仍必须是 C 部分给的值。
`;

  const user = `# 报告基本信息
标题：${input.title}
数据范围：${input.scopeNote}
报告语言：${input.language === "en" ? "English" : "中文"}
是否包含原文证据：${input.includeEvidence ? "是（可在 callout / markdown / table block 中引用原话）" : "否"}
期望章节数：${input.targetSections ?? 6}（上下浮动 1-2 个，按内容重要性取舍）
报告基调：${input.tone || "客观、数据驱动、结论先行，指出问题也给出可执行建议"}

用词纪律：结论的强度必须与证据强度匹配。样本量小、置信度不足时使用「样本显示」「初步迹象」这类措辞，
不要使用「灾难性」「全面溃败」等超出数据支撑的判断；反之，确有明确量化证据时才用强结论。

# A. 全局层分析结果（global_prompt 的产出）
${JSON.stringify(input.globalResult, null, 1)}

# B. 由平台从 session 层结果聚合出的真实统计
${JSON.stringify(input.sessionStats, null, 1)}

# C. 平台预先算好的确定性统计（SQL 直接聚合，必须原样引用）
${input.groundTruth ?? "（未提供）"}

# C2. extra 字段的完整取值分布（可直接用于 bar/pie/hbar 图表）
${JSON.stringify(input.distributions, null, 1)}

# D. 用户层分析结果（前 ${input.userResults.length} 个用户，key 可用于 drill.users）
${JSON.stringify(input.userResults.map((u) => ({ user_key: u.user_key, ...u.result })), null, 1).slice(0, 60000)}

# E. 典型证据片段（可用于 callout 或表格）
${JSON.stringify(input.evidence.slice(0, 60), null, 1).slice(0, 30000)}

请据此生成报告 JSON。`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return messages;
}

/* ------------------------------------------------- 分模式的会话层提示词 */

/**
 * `audio_first`: the omni model hears the clips with no transcript in front of
 * it, so what it reports is what the audio alone carries. Keeping the
 * transcript out is the whole point of the mode — the multimodal model gets the
 * transcript in the second pass, and mixing the two here would just reproduce
 * `omni_for_audio` at twice the price.
 */
export const AUDIO_OBSERVATION_PROMPT = `你是一名语音对话质量分析专家。现在只给你一段或多段音频，没有文字转录。
请仅根据你听到的内容作答，禁止猜测对话的具体业务内容或转录文本。

请分点输出（中文，250 字以内，不要寒暄、不要 Markdown 代码块）：
1. 说话人情绪与语气：双方各自的情绪走向、是否有不耐烦/焦虑/愤怒/满意的迹象。
2. 交互节奏：语速、停顿、静音、抢话与打断，TTS 播报是否被中途打断。
3. 音质与可懂度：背景噪音、断音、音量异常，以及可能导致 ASR 误识别的片段。
4. 仅凭音频可得的风险信号：如长时间静音、重复兜底话术的语调、情绪骤变。
如果某一项在音频中听不出来，直接写「未听出」，不要编造。`;

/** The `audio_first` hand-off: audio findings above, transcript below. */
export function renderAudioObservation(observation: string): string {
  return `# 音频独立分析结论（由 omni 模型仅听音频得出，不含转录信息）
以下结论来自对本会话原始音频的独立试听。你看不到音频本身，请把它当作可信的听觉证据来源，
与下面的转录文本结合判断；当两者冲突时以转录的事实内容为准，以音频结论的情绪/节奏判断为准。

${observation.trim() || "（未获得音频结论）"}`;
}

/**
 * `omni_then_refine`: the second pass. The omni model has already produced a
 * full result with the audio in hand; the multimodal model re-reads it against
 * the transcript and tightens it. It is told not to invent audio detail,
 * because it cannot hear anything — the first pass's claims are all it has.
 */
export const REFINE_PROMPT = `# 二次优化说明
上面的 JSON 是 omni 模型结合原始音频与转录做出的第一版分析。你现在拿到的是同一个会话的完整转录（没有音频）。
请在第一版的基础上产出一份更准确的最终结果：

1. 核对第一版的每条结论是否被转录文本支撑；无法支撑且明显属于臆测的，改写或删除。
2. 第一版中依赖音频得出的判断（语气、情绪、打断、停顿、噪音），你听不到音频，必须原样保留，不得推翻，也不得自行新增同类判断。
3. 补齐第一版遗漏的事实性内容：意图、关键节点、可量化指标、可引用的原文证据。
4. evidence 中的引用必须逐字来自转录，不得改写。
5. 输出结构与第一版完全一致的 JSON，不要输出 diff、不要解释你改了什么。`;
