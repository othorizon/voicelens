import { callJson, query } from "@/lib/db";
import { chat, chatJson, type ContentPart } from "./ai";
import {
  describeExtraSchema,
  buildPlanningMessages,
  renderSamples,
  GLOBAL_JSON_CONTRACT,
  REPORT_SPEC_CONTRACT,
  SESSION_JSON_CONTRACT,
  USER_JSON_CONTRACT,
} from "./prompts";
import {
  sampleForPlanning,
  loadSessions,
  resolveScope,
  loadSessionAudio,
  stratifiedPick,
  type SessionLike,
} from "./sampler";
import { signedAudioUrls } from "./analyze";
import type {
  ExtraFieldDef,
  GlobalAnalysis,
  JsonObject,
  ReportSpec,
  SessionAnalysis,
  UserAnalysis,
} from "@/lib/types";
import { normalizeSessionResult, mapLimit, aggregateUser, aggregateGlobal, generateReport } from "./analyze";
import type { DrillData, DrillSession, DrillUser } from "./report-html";
import { renderReportHtml } from "./report-html";
import { deriveGroundTruth, type HistogramEntry } from "./ground-truth";

export interface DataSourceLike {
  id: string;
  name: string;
  description: string;
  extra_schema: ExtraFieldDef[];
}

/* ------------------------------------------------------------ planning */

export interface PlanInput {
  dataSource: DataSourceLike;
  sessionSamples: number;
  userSamples: number;
  includeAudio: boolean;
  focus?: string;
  feedback?: string;
  previous?: {
    session_prompt: string;
    user_prompt: string;
    global_prompt: string;
    report_prompt: string;
    rationale?: string;
  } | null;
}

export interface PlanOutput {
  session_prompt: string;
  user_prompt: string;
  global_prompt: string;
  report_prompt: string;
  metric_schema: { session: unknown[]; user: unknown[]; global: unknown[] };
  rationale: string;
  detected_business: string;
  report_outline: unknown[];
  samples: SampleSnapshot;
}

export interface SampleSnapshot {
  sessions: { session_key: string; user_key: string; turn_count: number; digest_prefix: string }[];
  users: { user_key: string; session_count: number }[];
  global: JsonObject;
  audio_impression?: string;
  generated_at: string;
}

interface PlannerResult {
  rationale: string;
  detected_business: string;
  session_prompt: string;
  user_prompt: string;
  global_prompt: string;
  metric_schema: { session: unknown[]; user: unknown[]; global: unknown[] };
  report_prompt: string;
  report_outline: unknown[];
}

/** Ask the multimodal model what the audio adds, so planning can rely on it. */
async function audioImpression(
  dataSource: DataSourceLike,
  sessionIds: string[],
  maxClips = 6,
): Promise<string> {
  const clips: { path: string; format: string | null; role: string }[] = [];
  for (const id of sessionIds) {
    if (clips.length >= maxClips) break;
    const audios = await loadSessionAudio(id, 2);
    clips.push(...audios.map((a) => ({ path: a.audio_path, format: a.audio_format, role: a.role })));
  }
  if (!clips.length) return "";

  const urls = await signedAudioUrls(clips.slice(0, maxClips).map((c) => c.path));
  const parts = [
    {
      type: "text" as const,
      text: `这是语音对话系统（ASR-LLM-TTS）中的 ${urls.size} 段真实音频片段，每段对应一次用户发言或 AI 语音回复。请从「数据分析」角度回答：
1. 音频里有哪些文本转录看不出来、但对分析有价值的信号（语气/情绪/语速/停顿/打断/背景噪音/ASR 可能的误识别）？
2. 建议在会话层分析中补充哪些由音频才能得到的指标（给出英文 snake_case key + 中文名 + 口径）？
3. 有哪些语音系统特有的质量问题值得单独统计（例如 TTS 播报被打断、兜底话术、长静音）？
用 150-350 字中文分点作答，直接输出结论，不要寒暄。`,
    },
    ...[...urls.entries()]
      .slice(0, maxClips)
      .map(([, url]) => ({
        type: "input_audio" as const,
        input_audio: { data: url, format: url.toLowerCase().includes(".mp3") ? "mp3" : "wav" },
      })),
  ];

  try {
    const res = await chat(
      [
        { role: "system", content: `你是一名语音对话数据分析专家。数据源业务背景：${dataSource.description || dataSource.name}` },
        { role: "user", content: parts as never },
      ],
      { temperature: 0.4, maxTokens: 2000 },
    );
    return res.text.trim();
  } catch {
    return "";
  }
}

export async function planTemplate(input: PlanInput): Promise<PlanOutput> {
  const samples = await sampleForPlanning(input.dataSource.id, {
    sessionSamples: input.sessionSamples,
    userSamples: input.userSamples,
  });

  const samplesText = renderSamples(samples as never, 3500);

  let impression = "";
  if (input.includeAudio && samples.rawSessions.length) {
    impression = await audioImpression(
      input.dataSource,
      samples.rawSessions.slice(0, 4).map((s) => s.id),
    );
  }

  const audioNote = impression
    ? `# 音频试听结论（模型已实际听过样本音频，请把这些可听信号纳入分析口径与 metrics 设计）\n${impression}\n`
    : `# 音频说明\n本次规划未试听音频。若数据含有音频，请在提示词中允许模型在音频可用时补充语气/情绪/打断类判断，但不要假设一定能拿到音频。`;

  const messages = buildPlanningMessages({
    dataSourceName: input.dataSource.name,
    businessDesc: input.dataSource.description,
    extraSchema: input.dataSource.extra_schema ?? [],
    samplesText,
    focus: input.focus ?? "",
    audioNote,
  });

  if (input.previous) {
    messages.push({
      role: "assistant" as const,
      content: JSON.stringify({
        rationale: input.previous.rationale ?? "",
        session_prompt: input.previous.session_prompt,
        user_prompt: input.previous.user_prompt,
        global_prompt: input.previous.global_prompt,
        report_prompt: input.previous.report_prompt,
      }),
    });
    messages.push({
      role: "user" as const,
      content: `上一版模板如上。用户对预览报告提出了以下修改意见：\n"""\n${input.feedback}\n"""\n\n请在保持原模板结构优点的前提下，针对这些意见进行调整并输出新的完整 JSON（同样的字段与约束）。不要输出 diff，直接输出完整新版本。`,
    });
  }

  const { data, usage } = await chatJson<PlannerResult>(messages, {
    temperature: 0.5,
    maxTokens: 14000,
    thinking: true,
  });

  if (!data.session_prompt || !data.user_prompt || !data.global_prompt || !data.report_prompt) {
    throw new Error("规划失败：模型没有返回完整的四段提示词");
  }

  return {
    session_prompt: data.session_prompt,
    user_prompt: data.user_prompt,
    global_prompt: data.global_prompt,
    report_prompt: data.report_prompt,
    metric_schema: {
      session: Array.isArray(data.metric_schema?.session) ? data.metric_schema.session : [],
      user: Array.isArray(data.metric_schema?.user) ? data.metric_schema.user : [],
      global: Array.isArray(data.metric_schema?.global) ? data.metric_schema.global : [],
    },
    rationale: data.rationale ?? "",
    detected_business: data.detected_business ?? "",
    report_outline: Array.isArray(data.report_outline) ? data.report_outline : [],
    samples: {
      sessions: samples.sessions.map((s) => ({
        session_key: s.session_key,
        user_key: s.user_key,
        turn_count: s.turn_count,
        digest_prefix: s.digest.slice(0, 900),
      })),
      users: samples.users.map((u) => ({ user_key: u.user_key, session_count: u.session_count })),
      global: samples.overview as JsonObject,
      audio_impression: impression || undefined,
      generated_at: new Date().toISOString(),
      ...(usage ? {} : {}),
    },
  };
}

/* ------------------------------------------------------- fallback prompts */

export function fallbackTemplate(dataSource: DataSourceLike, extraHint: string): PlanOutput {
  const business = dataSource.description || dataSource.name;
  return {
    session_prompt: `你是一名资深的语音客服/语音助手对话质量分析专家。当前数据源业务背景：
"""
${business}
"""

${extraHint}

你将收到单个 session 的完整转录（含相对时间戳、说话人 role、extra 字段）以及可选的音频。请从以下维度分析：
1. 用户意图与最终结果（是否解决）
2. 对话质量：AI 回答的准确性、完整性、话术自然度、是否答非所问
3. 用户情绪与满意度信号（含音频里的语气、打断、重复追问）
4. 语音系统特有问题：ASR 误识别、TTS 被打断、长静音、兜底话术、重复播报
5. 关键证据：引用原文片段支撑每一个结论

quality_score 评分锚点：
90-100 用户诉求一次性解决、无负面情绪、无系统问题
75-89 基本解决但存在轻微摩擦（如一次澄清、略慢）
60-74 部分解决或明显摩擦（重复追问、话术生硬、一次打断）
40-59 未解决或出现明显负面情绪 / 系统问题
0-39 严重失败：投诉、愤怒、多次系统故障或用户中途放弃`,
    user_prompt: `你是一名用户研究专家。你将收到某一位用户（user_key）名下所有 session 的结构化分析结果 JSON 数组，以及会话数统计。
业务背景：${business}

请跨会话归纳：
1. 用户画像（persona）：用「标签 · 标签 · 标签」的组合表述
2. 反复出现的核心诉求（needs）
3. 交互行为模式与习惯（behaviour），包含使用频率、时段倾向、是否容易被打断、是否倾向重复追问
4. 该用户的量化指标（metrics）：从 session 层 metrics 聚合，如平均质量分、解决率、负面占比、平均轮次
5. 风险等级与标签
6. 最能代表该用户的 session_key（key_sessions）

所有结论必须由给出的 session 结果支撑，不得编造。`,
    global_prompt: `你是一名数据洞察负责人。你将收到：数据规模、平台从 session 层聚合出的真实统计、用户层统计、extra 字段真实分布，以及用户层结论列表。
业务背景：${business}

请输出决策级全局洞察：
1. summary：结论先行，4-8 句，包含最关键的量化事实
2. findings：每条要有标题、量化依据、严重程度（info/warning/critical）
3. metrics：全局层面的指标（解决率、平均质量分、高风险占比、平均轮次等）
4. distributions：适合画图的分布（结果分布、情绪分布、风险分布、意图 Top、标签 Top、问题 Top），items 必须来自真实统计
5. recommendations：可执行建议，含优先级与预期影响

严格禁止编造未在输入中出现的数值。${GLOBAL_JSON_CONTRACT}`,
    report_prompt: `你是一名资深数据可视化编辑。请基于提供的全局结论、真实统计与用户层结果，规划一份单页 HTML 分析报告。
业务背景：${business}

要求：
1. 结构：核心结论（hero）→ 整体表现 → 会话质量与结果 → 用户分层洞察 → 语音系统专项问题 → 风险与建议
2. 每个章节先给结论（summary），再用图表和文字支撑
3. 图表选型：占比用 pie，排名用 hbar，趋势用 line，多维对比用 radar，明细用 table，重点提醒用 callout
4. 所有数值必须来自输入的真实统计
5. 在合适的章节填写 drill.users，便于读者下探到具体用户
6. 语言：中文，客观、数据驱动、结论先行${REPORT_SPEC_CONTRACT}`,
    metric_schema: {
      session: [
        { key: "quality_score", label: "质量分", unit: "分", desc: "0-100" },
        { key: "turns", label: "对话轮次", unit: "轮", desc: "会话内消息数" },
        { key: "resolve", label: "是否解决", unit: "", desc: "outcome=resolved 记 1 否则 0" },
      ],
      user: [
        { key: "session_count", label: "会话数", unit: "个", desc: "该用户会话总数" },
        { key: "avg_quality", label: "平均质量分", unit: "分", desc: "会话质量分均值" },
      ],
      global: [
        { key: "resolve_rate", label: "解决率", unit: "%", desc: "resolved 会话占比" },
        { key: "avg_quality", label: "平均质量分", unit: "分", desc: "全部会话质量分均值" },
        { key: "high_risk_rate", label: "高风险占比", unit: "%", desc: "risk_level in (medium,high)" },
      ],
    },
    rationale: "兜底模板：在模型规划失败时使用，覆盖通用语音对话质量分析口径。",
    detected_business: business,
    report_outline: [],
    samples: { sessions: [], users: [], global: {}, generated_at: new Date().toISOString() },
  };
}

/* ------------------------------------------------------------ preview */

export interface PreviewInput {
  dataSource: DataSourceLike;
  template: {
    session_prompt: string;
    user_prompt: string;
    global_prompt: string;
    report_prompt: string;
  };
  sessions: number;
  useAudio: boolean;
  concurrency?: number;
  onProgress?: (p: { stage: string; done: number; total: number; message?: string }) => void;
}

export interface PreviewOutput {
  sessionResults: { session_key: string; user_key: string; result: SessionAnalysis }[];
  userResults: { user_key: string; result: UserAnalysis }[];
  globalResult: JsonObject;
  stats: JsonObject;
  spec: ReportSpec;
  html: string;
}

export async function buildPreview(input: PreviewInput): Promise<PreviewOutput> {
  const { dataSource, template } = input;
  const total = input.sessions;
  const progress = input.onProgress ?? (() => {});

  progress({ stage: "collect", done: 0, total, message: "选取预览样本" });
  const rows = await query<SessionLike>(
    `select id, session_key, user_key, started_at, ended_at, turn_count, audio_count, extra, digest
     from sessions
     where data_source_id = $1
     order by started_at desc nulls last
     limit $2`,
    [dataSource.id, Math.max(total * 8, 160)],
  );

  // Representative sample: spread evenly over session length AND over distinct
  // users. Picking the longest sessions first biased early previews toward the
  // worst conversations and produced over-alarmist report wording.
  const picked = stratifiedPick(rows, total);

  const ids = picked.slice(0, total).map((r) => r.id);
  const sessions = await loadSessions(ids, { maxDigestChars: 20000 });
  progress({ stage: "session_analysis", done: 0, total: sessions.length, message: `分析 ${sessions.length} 个会话` });

  const extraHint = describeExtraSchema(dataSource.extra_schema);
  let done = 0;
  const results = await mapLimit(sessions, input.concurrency ?? 3, async (s) => {
    try {
      const parsed = await chatJson<SessionAnalysis>(
        [
          { role: "system", content: template.session_prompt },
          { role: "user", content: await sessionPayloadContent(s, extraHint, input.useAudio) },
        ],
        { temperature: 0.3 },
      );
      return { session: s, result: normalizeSessionResult(parsed.data, s as never) };
    } catch (err) {
      return {
        session: s,
        result: normalizeSessionResult(
          { summary: `分析失败: ${err instanceof Error ? err.message : String(err)}` } as SessionAnalysis,
          s as never,
        ),
      };
    } finally {
      progress({ stage: "session_analysis", done: ++done, total: sessions.length });
    }
  });

  const sessionResults = results.map((r) => ({
    session_key: r.session.session_key,
    user_key: r.session.user_key,
    result: r.result,
  }));

  // group by user
  progress({ stage: "user_aggregation", done: 0, total: sessionResults.length, message: "用户层汇总" });
  const byUser = new Map<string, { session_key: string; result: SessionAnalysis }[]>();
  for (const r of sessionResults) {
    const arr = byUser.get(r.user_key) ?? [];
    arr.push({ session_key: r.session_key, result: r.result });
    byUser.set(r.user_key, arr);
  }
  const userKeys = [...byUser.keys()];
  let uDone = 0;
  const userAgg = await mapLimit(userKeys, input.concurrency ?? 3, async (key) => {
    try {
      const { result } = await aggregateUser({ user_key: key, sessions: byUser.get(key)! }, template);
      return { user_key: key, result };
    } catch {
      const list = byUser.get(key)!;
      return {
        user_key: key,
        result: {
          summary: `${key} 共 ${list.length} 个会话（预览聚合失败，使用统计兜底）`,
          session_count: list.length,
          persona: "未归纳",
          needs: [],
          behaviour: [],
          metrics: [],
          risk_level: "none",
          tags: [],
          key_sessions: list.slice(0, 3).map((s) => s.session_key),
        } satisfies UserAnalysis,
      };
    } finally {
      progress({ stage: "user_aggregation", done: ++uDone, total: userKeys.length });
    }
  });

  progress({ stage: "global_aggregation", done: 0, total: 1, message: "全局汇总" });
  const stats = computeStats(sessionResults);
  const userStats = computeUserStats(userAgg);
  const histograms = await extraHistogramForSessions(sessions.map((s) => s.id));
  const { result: globalResult } = await aggregateGlobal(
    {
      userResults: userAgg,
      sessionStats: stats,
      userStats,
      distributions: histograms,
      sessionCount: sessionResults.length,
      userCount: userAgg.length,
    },
    template,
    200,
  );
  progress({ stage: "global_aggregation", done: 1, total: 1 });

  progress({ stage: "report", done: 0, total: 1, message: "生成预览报告" });
  const evidence = collectEvidence(sessionResults);
  const groundTruth = deriveGroundTruth(histograms, dataSource.extra_schema ?? [], {
    sessions: sessionResults.length,
    messages: sessions.reduce((n, s) => n + (s.turn_count ?? 0), 0),
  });
  const { spec } = await generateReport({
    template,
    title: `${dataSource.name} · 预览报告`,
    scopeNote: `预览样本 ${sessionResults.length} 个会话 / ${userAgg.length} 位用户（非全量）`,
    globalResult: globalResult as JsonObject,
    userResults: userAgg as unknown as { user_key: string; result: JsonObject }[],
    sessionStats: stats,
    distributions: histograms,
    groundTruth,
    language: "zh",
    includeEvidence: true,
    tone: "客观、数据驱动、结论先行；这是预览报告，样本量较小，措辞需要保守，不要使用超出证据强度的判断",
    targetSections: 6,
    evidence,
  });
  progress({ stage: "report", done: 1, total: 1 });

  const drill = buildDrillData(sessions as never, sessionResults, userAgg);
  const html = renderReportHtml({
    spec,
    drill,
    generatedAt: new Date().toISOString(),
    scopeNote: `预览样本 ${sessionResults.length} 个会话 / ${userAgg.length} 位用户`,
  });

  return {
    sessionResults,
    userResults: userAgg,
    globalResult: globalResult as JsonObject,
    stats,
    spec,
    html,
  };
}

async function sessionPayloadContent(
  session: { id: string; session_key: string; user_key: string; started_at: string | null; ended_at?: string | null; turn_count: number; audio_count: number; digest: string; extra: JsonObject },
  extraHint: string,
  useAudio: boolean,
) {
  const text = [
    `# 会话元信息`,
    `session_key: ${session.session_key}`,
    `user_key: ${session.user_key}`,
    `开始时间: ${session.started_at ?? "未知"}`,
    `轮次: ${session.turn_count}，含音频片段: ${session.audio_count}`,
    Object.keys(session.extra ?? {}).length ? `会话级 extra: ${JSON.stringify(session.extra)}` : "",
    extraHint ? `\n# extra 字段口径\n${extraHint}` : "",
    `\n# 完整对话转录\n${session.digest || "（无转录）"}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (!useAudio || !session.audio_count) return text;
  const audios = await loadSessionAudio(session.id, 6);
  if (!audios.length) return text;
  const urls = await signedAudioUrls(audios.map((a) => a.audio_path));
  const parts: ContentPart[] = [
    { type: "text", text: `随附 ${urls.size} 段原始音频，顺序与转录一致。若音频可用请结合语气/情绪/打断/停顿判断；不可用则仅依据转录，不要臆测。` },
    { type: "text", text },
  ];
  for (const [path, url] of urls) {
    const meta = audios.find((a) => a.audio_path === path);
    parts.push({
      type: "input_audio",
      input_audio: { data: url, format: (meta?.audio_format ?? "wav").toLowerCase() },
    });
  }
  return parts;
}

/* ------------------------------------------------------------- stats */

export function computeStats(
  results: { session_key: string; result: SessionAnalysis }[],
): JsonObject {
  const n = results.length || 1;
  const count = (pick: (r: SessionAnalysis) => string) => {
    const m = new Map<string, number>();
    for (const r of results) {
      const k = pick(r.result) || "unknown";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  };
  const tally = (pick: (r: SessionAnalysis) => string[]) => {
    const m = new Map<string, number>();
    for (const r of results) for (const t of pick(r.result) ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, value]) => ({ name, value }));
  };

  const quality = results.map((r) => r.result.quality_score).filter((v) => Number.isFinite(v));
  const risky = results.filter((r) => ["medium", "high"].includes(r.result.risk_level)).length;
  const resolved = results.filter((r) => r.result.outcome === "resolved").length;

  const metricAgg = new Map<string, { label: string; unit?: string; sum: number; n: number }>();
  for (const r of results) {
    for (const m of r.result.metrics ?? []) {
      const e = metricAgg.get(m.key) ?? { label: m.label, unit: m.unit, sum: 0, n: 0 };
      e.sum += m.value;
      e.n++;
      metricAgg.set(m.key, e);
    }
  }

  const buckets = [
    { lo: 0, hi: 40, name: "低 (<40)" },
    { lo: 40, hi: 60, name: "偏低 (40-59)" },
    { lo: 60, hi: 80, name: "良好 (60-79)" },
    { lo: 80, hi: 101, name: "优秀 (80+)" },
  ];

  return {
    session_count: results.length,
    avg_quality: quality.length ? Math.round((quality.reduce((a, b) => a + b, 0) / quality.length) * 100) / 100 : 0,
    risky_count: risky,
    risky_ratio: Math.round((risky / n) * 10000) / 100,
    resolve_rate: Math.round((resolved / n) * 10000) / 100,
    quality_buckets: buckets.map((b) => ({
      name: b.name,
      value: quality.filter((q) => q >= b.lo && q < b.hi).length,
    })),
    distributions: {
      outcome: count((r) => r.outcome),
      sentiment: count((r) => r.sentiment),
      risk_level: count((r) => r.risk_level),
      intent: count((r) => r.intent).slice(0, 15),
      tags: tally((r) => r.tags),
      problems: tally((r) => r.problems),
      highlights: tally((r) => r.highlights),
    },
    metrics: [...metricAgg.entries()].map(([key, v]) => ({
      key,
      label: v.label,
      avg: Math.round((v.sum / v.n) * 10000) / 10000,
      sum: Math.round(v.sum * 10000) / 10000,
      unit: v.unit,
      samples: v.n,
    })),
    top_problems: tally((r) => r.problems).slice(0, 20),
    top_tags: tally((r) => r.tags).slice(0, 20),
  };
}

export function computeUserStats(users: { user_key: string; result: UserAnalysis }[]): JsonObject {
  const risky = users.filter((u) => ["medium", "high"].includes(u.result.risk_level)).length;
  const tags = new Map<string, number>();
  const needs = new Map<string, number>();
  for (const u of users) {
    for (const t of u.result.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
    for (const t of u.result.needs ?? []) needs.set(t, (needs.get(t) ?? 0) + 1);
  }
  const metricAgg = new Map<string, { label: string; unit?: string; sum: number; n: number }>();
  for (const u of users) {
    for (const m of u.result.metrics ?? []) {
      const e = metricAgg.get(m.key) ?? { label: m.label, unit: m.unit, sum: 0, n: 0 };
      e.sum += m.value;
      e.n++;
      metricAgg.set(m.key, e);
    }
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, value]) => ({ name, value }));

  return {
    user_count: users.length,
    session_total: users.reduce((s, u) => s + (u.result.session_count ?? 0), 0),
    risk_count: risky,
    top_tags: top(tags),
    top_needs: top(needs),
    metrics: [...metricAgg.entries()].map(([key, v]) => ({
      key,
      label: v.label,
      avg: Math.round((v.sum / v.n) * 10000) / 10000,
      sum: Math.round(v.sum * 10000) / 10000,
      unit: v.unit,
      samples: v.n,
    })),
    persona_index: users.slice(0, 400).map((u) => ({
      key: u.user_key,
      label: u.result.persona || u.user_key,
      summary: u.result.summary || "",
    })),
  };
}

/** Histogram restricted to an explicit set of sessions, so a sample reports on itself. */
export async function extraHistogramForSessions(
  sessionIds: string[],
): Promise<HistogramEntry[]> {
  if (!sessionIds.length) return [];
  const data = await callJson<{ key: string; values: { name: string; value: number }[] }[]>(
    "extra_histogram_for_sessions",
    [sessionIds, 16],
  );
  return ((data ?? []) as HistogramEntry[]).map((r) => ({
    key: r.key,
    values: (r.values ?? []).slice(0, 16),
    kind: r.kind,
  }));
}

export function collectEvidence(
  results: { session_key: string; user_key?: string; result: SessionAnalysis }[],
) {
  return results
    .filter((r) => (r.result.problems?.length || r.result.evidence?.length))
    .slice(0, 60)
    .map((r) => ({
      session_key: r.session_key,
      user_key: r.user_key ?? "",
      problems: (r.result.problems ?? []).slice(0, 3),
      highlights: (r.result.highlights ?? []).slice(0, 2),
      quotes: (r.result.evidence ?? []).slice(0, 3).map((e) => `${e.role === "user" ? "用户" : "AI"}：${e.quote}`),
    }));
}

/* ---------------------------------------------------------------- drill */

export function buildDrillData(
  sessions: {
    session_key: string;
    user_key: string;
    started_at: string | null;
    turn_count: number;
    digest: string;
  }[],
  sessionResults: { session_key: string; user_key: string; result: SessionAnalysis }[],
  userResults: { user_key: string; result: UserAnalysis }[],
): DrillData {
  const byKey = new Map(sessionResults.map((r) => [r.session_key, r]));

  const drillSessions: DrillSession[] = sessions.map((s) => {
    const r = byKey.get(s.session_key);
    return {
      session_key: s.session_key,
      user_key: s.user_key,
      started_at: s.started_at,
      turn_count: s.turn_count,
      summary: r?.result.summary,
      intent: r?.result.intent,
      outcome: r?.result.outcome,
      sentiment: r?.result.sentiment,
      quality_score: r?.result.quality_score,
      risk_level: r?.result.risk_level,
      tags: r?.result.tags,
      metrics: r?.result.metrics,
      highlights: r?.result.highlights,
      problems: r?.result.problems,
      evidence: r?.result.evidence,
      transcript: digestToTranscript(s.digest),
    };
  });

  const sessionsByUser = new Map<string, string[]>();
  for (const s of sessions) {
    sessionsByUser.set(s.user_key, [...(sessionsByUser.get(s.user_key) ?? []), s.session_key]);
  }

  const users: DrillUser[] = userResults.map((u) => ({
    user_key: u.user_key,
    persona: u.result.persona,
    summary: u.result.summary,
    session_count: u.result.session_count,
    risk_level: u.result.risk_level,
    tags: u.result.tags,
    needs: u.result.needs,
    behaviour: u.result.behaviour,
    metrics: u.result.metrics,
    sessions: sessionsByUser.get(u.user_key) ?? u.result.key_sessions ?? [],
  }));

  users.sort((a, b) => (b.session_count ?? 0) - (a.session_count ?? 0));
  return { users, sessions: drillSessions };
}

export function digestToTranscript(digest: string) {
  if (!digest) return [];
  return digest
    .split("\n")
    .map((line) => {
      const m = /^\[(\d{2}:\d{2})\]\s*(用户|AI|system|tool)(?:\(([^)]*)\))?[:：]\s*(.*)$/.exec(line.trim());
      if (m) {
        return {
          role: m[2] === "用户" ? "user" : m[2] === "AI" ? "assistant" : m[2],
          text: m[4] + (m[3] ? ` ⟦${m[3]}⟧` : ""),
          at: m[1],
        };
      }
      const m2 = /^(用户|AI|system|tool)[:：]\s*(.*)$/.exec(line.trim());
      if (m2) {
        return { role: m2[1] === "用户" ? "user" : m2[1] === "AI" ? "assistant" : m2[1], text: m2[2] };
      }
      return null;
    })
    .filter(Boolean) as { role: string; text: string; at?: string }[];
}

