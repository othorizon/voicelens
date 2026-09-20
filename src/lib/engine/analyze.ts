import { MODEL_URL_TTL, signedUrls } from "@/lib/storage";
import { chat, chatJson, type ChatMessage, type ContentPart } from "./ai";
import {
  requireModel,
  type AnalysisRuntime,
  type ModelRuntime,
} from "@/lib/models/registry";
import { sessionStrategy, textModelKind, type SessionStrategy } from "@/lib/models/mode";
import type {
  GlobalAnalysis,
  JsonObject,
  ReportBlock,
  ReportSpec,
  SessionAnalysis,
  UserAnalysis,
} from "@/lib/types";
import { loadSessionAudio } from "./sampler";
import {
  AUDIO_OBSERVATION_PROMPT,
  REFINE_PROMPT,
  buildReportMessages,
  renderAudioObservation,
} from "./prompts";
import {
  buildGroundTruthSection,
  reconcileWithGroundTruth,
  renderGroundTruth,
  type GroundTruth,
  type MetricOverride,
} from "./ground-truth";

export interface Template {
  session_prompt: string;
  user_prompt: string;
  global_prompt: string;
  report_prompt: string;
}

/* ------------------------------------------------------------- concurrency */

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------- audio */

export async function signedAudioUrls(
  paths: string[],
  expiresIn = MODEL_URL_TTL,
): Promise<Map<string, string>> {
  // The model service fetches these URLs itself, so they have to stay valid for
  // the whole analysis call, and the bucket stays private.
  return signedUrls([...new Set(paths.filter(Boolean))].slice(0, 200), expiresIn);
}

/* ---------------------------------------------------------- session 层分析 */

export interface SessionInput {
  id: string;
  session_key: string;
  user_key: string;
  started_at: string | null;
  ended_at: string | null;
  turn_count: number;
  audio_count: number;
  digest: string;
  extra: JsonObject;
}

export interface AnalyzeSessionOptions {
  session: SessionInput;
  template: Template;
  /** Which models run this session, and under which analysis mode. */
  runtime: AnalysisRuntime;
  useAudio: boolean;
  maxAudiosPerSession: number;
  extraSchemaHint: string;
}

const JSON_RULE = `\n\n# 输出硬性约束\n只输出一个 JSON 对象，严格按上面的字段结构，不要 Markdown 代码块、不要注释、不要解释文字。metrics 必须是数组，key 使用英文 snake_case。所有结论必须能被提供的对话内容支撑，无法判断时使用保守值（outcome=unknown、risk_level=none、quality_score 取中间值）。`;

/** What one session contributed to the run's audio tally. */
export interface SessionAudioUsage {
  /** Clips the database had a path for, after the per-session cap. */
  requested: number;
  /** Clips that were signed and attached to the prompt. */
  attached: number;
}

export interface SessionAnalysisRun {
  result: SessionAnalysis;
  tokens: number;
  audio: SessionAudioUsage;
  /** Which of the four routings actually ran, for the run's tally. */
  strategy: SessionStrategy;
}

/**
 * Analyse one session under the configured analysis mode.
 *
 * Both callers — the full run and the workbench preview — come through here, so
 * a preview can never disagree with the task it is previewing about which model
 * saw what. The mode decides the routing; `@/lib/models/mode` owns that table.
 */
export async function analyzeSession(opts: AnalyzeSessionOptions): Promise<SessionAnalysisRun> {
  const { session, template, runtime, extraSchemaHint } = opts;
  const payload = renderSessionPayload(session, extraSchemaHint);
  const { clips, audio } = await loadAudioParts(opts);
  // Audio "reaching the model" is what routes, not the switch: a session with
  // no clips, or whose clips all failed to sign, is a text-only session.
  const strategy = sessionStrategy(runtime.mode, clips.length > 0);
  const system = `${template.session_prompt}${JSON_RULE}`;

  const done = (result: SessionAnalysis, tokens: number): SessionAnalysisRun => ({
    result: normalizeSessionResult(result, session),
    tokens,
    audio,
    strategy,
  });

  switch (strategy) {
    case "omni_single":
    case "multimodal_single": {
      const kind = strategy === "omni_single" ? "omni" : "multimodal";
      const model = requireModel(runtime, kind, "会话层分析");
      // Keyed on the kind, not merely on having clips: a multimodal endpoint
      // rejects an `input_audio` part, so this must stay true even if the
      // routing table in @/lib/models/mode is changed later.
      const content = kind === "omni" && clips.length ? withAudio(payload, clips) : payload;
      const pass = await sessionJson([sys(system), user(content)], model);
      return done(pass.result, pass.tokens);
    }

    case "omni_then_refine": {
      const omni = requireModel(runtime, "omni", "会话层音频分析");
      const multimodal = requireModel(runtime, "multimodal", "会话层二次优化");
      const first = await sessionJson([sys(system), user(withAudio(payload, clips))], omni);
      // The refine pass gets the transcript and v1 but no audio, so the prompt
      // tells it to keep v1's audio-derived claims rather than second-guess
      // what it cannot hear.
      const second = await sessionJson(
        [
          sys(system),
          user(payload),
          { role: "assistant", content: JSON.stringify(first.result) },
          user(REFINE_PROMPT),
        ],
        multimodal,
      );
      return done(second.result, first.tokens + second.tokens);
    }

    case "audio_then_multimodal": {
      const omni = requireModel(runtime, "omni", "音频独立分析");
      const multimodal = requireModel(runtime, "multimodal", "会话层分析");
      const heard = await chat(
        [
          sys(AUDIO_OBSERVATION_PROMPT),
          user([
            {
              type: "text",
              text: `以下是同一个会话中按轮次顺序排列的 ${clips.length} 段原始音频，没有转录。`,
            },
            ...clips,
          ]),
        ],
        { model: omni, temperature: 0.4, maxTokens: 1500 },
      );
      const pass = await sessionJson(
        [sys(system), user(`${renderAudioObservation(heard.text)}\n\n${payload}`)],
        multimodal,
      );
      return done(pass.result, heard.usage.total_tokens + pass.tokens);
    }
  }
}

function sys(content: string): ChatMessage {
  return { role: "system", content };
}

function user(content: string | ContentPart[]): ChatMessage {
  return { role: "user", content };
}

async function sessionJson(
  messages: ChatMessage[],
  model: ModelRuntime,
): Promise<{ result: SessionAnalysis; tokens: number }> {
  const res = await chatJson<SessionAnalysis>(messages, { model, temperature: 0.3 });
  return { result: res.data, tokens: res.usage.total_tokens };
}

/** Transcript first, clips after, with the note about what they are on top. */
function withAudio(payload: string, clips: ContentPart[]): ContentPart[] {
  if (!clips.length) return [{ type: "text", text: payload }];
  return [
    {
      type: "text",
      text: `随附 ${clips.length} 段本次会话的原始音频，顺序与转录轮次一致。请结合音频中的语气、语速、停顿、打断与情绪判断；若音频不可用，仅依据转录文本分析，不要臆测音频内容。`,
    },
    { type: "text", text: payload },
    ...clips,
  ];
}

async function loadAudioParts(
  opts: AnalyzeSessionOptions,
): Promise<{ clips: ContentPart[]; audio: SessionAudioUsage }> {
  const none: SessionAudioUsage = { requested: 0, attached: 0 };
  if (!opts.useAudio || opts.maxAudiosPerSession <= 0 || opts.session.audio_count <= 0) {
    return { clips: [], audio: none };
  }

  const audios = await loadSessionAudio(opts.session.id, opts.maxAudiosPerSession);
  if (!audios.length) return { clips: [], audio: none };

  // `signedUrls` drops whatever it cannot sign, so requested - attached is the
  // count that quietly never reached the model.
  const urls = await signedAudioUrls(audios.map((a) => a.audio_path));
  const clips: ContentPart[] = [];
  for (const a of audios) {
    const url = urls.get(a.audio_path);
    if (!url) continue;
    clips.push({
      type: "input_audio",
      input_audio: { data: url, format: normalizeFormat(a.audio_format) },
    });
  }
  return { clips, audio: { requested: audios.length, attached: clips.length } };
}

function normalizeFormat(fmt?: string | null): string {
  const f = (fmt ?? "wav").toLowerCase();
  if (f === "m4a") return "mp4";
  if (f === "opus") return "ogg";
  return f;
}

export function renderSessionPayload(session: SessionInput, extraSchemaHint: string): string {
  const rows: string[] = [
    `# 会话元信息`,
    `session_key: ${session.session_key}`,
    `user_key: ${session.user_key}`,
    `开始时间: ${session.started_at ?? "未知"}`,
    `结束时间: ${sessionended(session)}`,
    `对话轮次: ${session.turn_count}（转录中每行已带相对时间戳）`,
    `含音频片段: ${session.audio_count}`,
    session.extra && Object.keys(session.extra).length
      ? `会话级 extra: ${JSON.stringify(session.extra)}`
      : "",
    extraSchemaHint ? `\n# extra 字段口径\n${extraSchemaHint}` : "",
    `\n# 完整对话转录\n${session.digest || "（无转录）"}`,
  ];
  return rows.filter(Boolean).join("\n");
}

function sessionended(s: SessionInput) {
  if (!s.ended_at) return "未知";
  if (s.started_at) {
    const ms = Date.parse(s.ended_at) - Date.parse(s.started_at);
    if (Number.isFinite(ms) && ms >= 0) return `${s.ended_at}（时长 ${(ms / 1000).toFixed(0)}s）`;
  }
  return s.ended_at;
}

export function normalizeSessionResult(raw: SessionAnalysis, session: SessionInput): SessionAnalysis {
  const out: SessionAnalysis = {
    summary: str(raw?.summary) || `${session.session_key} 的会话共 ${session.turn_count} 轮`,
    intent: str(raw?.intent) || "未标注",
    outcome: oneOf(raw?.outcome, ["resolved", "partial", "unresolved", "abandoned", "unknown"], "unknown"),
    sentiment: oneOf(raw?.sentiment, ["positive", "neutral", "mixed", "negative"], "neutral"),
    quality_score: clampNum(raw?.quality_score, 0, 100, 50),
    risk_level: oneOf(raw?.risk_level, ["none", "low", "medium", "high"], "none"),
    tags: strArr(raw?.tags).slice(0, 12),
    metrics: normalizeMetrics(raw?.metrics),
    highlights: strArr(raw?.highlights).slice(0, 10),
    problems: strArr(raw?.problems).slice(0, 10),
    evidence: Array.isArray(raw?.evidence)
      ? raw.evidence
          .filter((e) => e && typeof e === "object")
          .slice(0, 8)
          .map((e) => ({
            quote: truncateString(str((e as JsonObject).quote), 300),
            role: str((e as JsonObject).role) || undefined,
            seq: typeof (e as JsonObject).seq === "number" ? ((e as JsonObject).seq as number) : undefined,
          }))
      : [],
  };
  return out;
}

/* ------------------------------------------------------------ user 层汇总 */

export interface UserAggInput {
  user_key: string;
  sessions: { session_key: string; result: SessionAnalysis }[];
}

export async function aggregateUser(
  input: UserAggInput,
  template: Template,
  runtime: AnalysisRuntime,
): Promise<{ result: UserAnalysis; tokens: number }> {
  const compact = input.sessions.map((s) => ({
    session_key: s.session_key,
    summary: s.result.summary,
    intent: s.result.intent,
    outcome: s.result.outcome,
    sentiment: s.result.sentiment,
    quality_score: s.result.quality_score,
    risk_level: s.result.risk_level,
    tags: s.result.tags,
    metrics: s.result.metrics,
    problems: s.result.problems.slice(0, 4),
    highlights: s.result.highlights.slice(0, 3),
  }));

  const payload = [
    `# 用户标识\nuser_key: ${input.user_key}`,
    `# 该用户的会话数\n${input.sessions.length}`,
    `# 会话层结构化分析结果（JSON 数组）\n${JSON.stringify(compact)}`,
  ].join("\n\n");

  const res = await chatJson<UserAnalysis>(
    [
      {
        role: "system",
        content: `${template.user_prompt}\n\n只输出一个 JSON 对象，严格符合结构要求，不要 Markdown 代码块与解释。key_sessions 必须从上面给出的 session_key 中选取。`,
      },
      { role: "user", content: payload },
    ],
    { model: requireModel(runtime, textModelKind(runtime.mode), "用户层汇总"), temperature: 0.3 },
  );

  const known = new Set(input.sessions.map((s) => s.session_key));
  const result: UserAnalysis = {
    summary: str(res.data?.summary) || `${input.user_key} 共 ${input.sessions.length} 个会话`,
    session_count: input.sessions.length,
    persona: str(res.data?.persona) || "未归纳",
    needs: strArr(res.data?.needs).slice(0, 8),
    behaviour: strArr(res.data?.behaviour ?? res.data?.behavior).slice(0, 8),
    metrics: normalizeMetrics(res.data?.metrics),
    risk_level: oneOf(res.data?.risk_level, ["none", "low", "medium", "high"], "none"),
    tags: strArr(res.data?.tags).slice(0, 12),
    key_sessions: strArr(res.data?.key_sessions)
      .filter((k) => known.has(k))
      .slice(0, 5),
  };
  return { result, tokens: res.usage.total_tokens };
}

/* ---------------------------------------------------------- global 层汇总 */

export async function aggregateGlobal(
  input: {
    userResults: { user_key: string; result: UserAnalysis }[];
    sessionStats: JsonObject;
    userStats: JsonObject;
    distributions: { key: string; values: { name: string; value: number }[] }[];
    sessionCount: number;
    userCount: number;
  },
  template: Template,
  runtime: AnalysisRuntime,
  maxUsers = 300,
): Promise<{ result: GlobalAnalysis; tokens: number }> {
  const users = input.userResults.slice(0, maxUsers).map((u) => ({
    user_key: u.user_key,
    session_count: u.result.session_count,
    persona: u.result.persona,
    risk_level: u.result.risk_level,
    tags: u.result.tags,
    needs: u.result.needs.slice(0, 4),
    metrics: u.result.metrics.slice(0, 8),
  }));

  const payload = [
    `# 数据规模\n会话数=${input.sessionCount}，用户数=${input.userCount}`,
    `# 平台从 session 层聚合出的真实统计\n${JSON.stringify(input.sessionStats)}`,
    `# 平台从 user 层聚合出的真实统计\n${JSON.stringify(input.userStats)}`,
    `# extra 字段真实分布\n${JSON.stringify(input.distributions)}`,
    `# 用户层结论（${users.length} 个用户）\n${JSON.stringify(users)}`,
  ].join("\n\n");

  const res = await chatJson<GlobalAnalysis>(
    [
      {
        role: "system",
        content: `${template.global_prompt}\n\n只输出一个 JSON 对象，严格符合结构要求，不要 Markdown 代码块与解释。distributions 中每一项的 items 必须是真实统计里存在的分类与数值，禁止编造。`,
      },
      { role: "user", content: payload },
    ],
    {
      model: requireModel(runtime, textModelKind(runtime.mode), "全局层汇总"),
      temperature: 0.35,
      maxTokens: 12000,
    },
  );

  const g = res.data ?? ({} as GlobalAnalysis);
  return {
    result: {
      summary: str(g.summary) || "（模型未返回全局摘要）",
      findings: (Array.isArray(g.findings) ? g.findings : []).slice(0, 14).map((f) => ({
        title: str((f as JsonObject).title) || "发现",
        detail: str((f as JsonObject).detail),
        severity: oneOf((f as JsonObject).severity, ["info", "warning", "critical"], "info") as
          | "info"
          | "warning"
          | "critical",
        metric: str((f as JsonObject).metric) || undefined,
      })),
      metrics: normalizeMetrics(g.metrics),
      distributions: (Array.isArray(g.distributions) ? g.distributions : []).slice(0, 16).map((d) => ({
        key: str((d as JsonObject).key) || "dist",
        label: str((d as JsonObject).label) || "分布",
        unit: str((d as JsonObject).unit) || undefined,
        items: (Array.isArray((d as JsonObject).items) ? ((d as JsonObject).items as JsonObject[]) : [])
          .slice(0, 30)
          .map((it) => ({ name: str(it.name) || "未命名", value: Number(it.value) || 0 })),
      })),
      recommendations: (Array.isArray(g.recommendations) ? g.recommendations : []).slice(0, 12).map((r) => ({
        title: str((r as JsonObject).title) || "建议",
        detail: str((r as JsonObject).detail),
        priority: oneOf((r as JsonObject).priority, ["high", "medium", "low"], "medium") as
          | "high"
          | "medium"
          | "low",
        impact: str((r as JsonObject).impact) || undefined,
      })),
    },
    tokens: res.usage.total_tokens,
  };
}

/* ------------------------------------------------------------- 报告生成 */

export async function generateReport(input: {
  template: Template;
  runtime: AnalysisRuntime;
  title: string;
  scopeNote: string;
  globalResult: JsonObject;
  userResults: { user_key: string; result: JsonObject }[];
  sessionStats: JsonObject;
  distributions: { key: string; values: { name: string; value: number }[] }[];
  groundTruth?: GroundTruth;
  language: string;
  includeEvidence: boolean;
  tone?: string;
  targetSections?: number;
  evidence: { session_key: string; user_key: string; problems: string[]; highlights: string[]; quotes: string[] }[];
}): Promise<{ spec: ReportSpec; tokens: number; overrides: MetricOverride[] }> {
  const messages = buildReportMessages({
    reportPrompt: input.template.report_prompt,
    title: input.title,
    scopeNote: input.scopeNote,
    globalResult: input.globalResult,
    userResults: input.userResults,
    sessionStats: input.sessionStats,
    distributions: input.distributions,
    groundTruth: input.groundTruth ? renderGroundTruth(input.groundTruth) : undefined,
    language: input.language,
    includeEvidence: input.includeEvidence,
    tone: input.tone,
    targetSections: input.targetSections,
    evidence: input.evidence,
  });
  // thinking is left off here: the report contract is already precise, and a
  // multi-thousand-token reasoning prefix makes the call take many minutes.
  const res = await chatJson<ReportSpec>(messages, {
    model: requireModel(input.runtime, textModelKind(input.runtime.mode), "报告生成"),
    temperature: 0.45,
    maxTokens: 8000,
  });
  const base = normalizeReportSpec(res.data, input.title);
  const { spec, overrides } = reconcileWithGroundTruth(base, input.groundTruth);

  // Always lead with numbers the platform measured itself.
  const truthSection = buildGroundTruthSection(input.groundTruth);
  if (truthSection) spec.sections = [truthSection, ...spec.sections];

  return { spec, tokens: res.usage.total_tokens, overrides };
}

export function normalizeReportSpec(raw: ReportSpec, fallbackTitle: string): ReportSpec {
  const spec = (raw ?? {}) as ReportSpec;
  const sections = (Array.isArray(spec.sections) ? spec.sections : []).slice(0, 14).map((s, i) => ({
    id: str((s as JsonObject).id) || `sec-${i + 1}`,
    title: str((s as JsonObject).title) || `章节 ${i + 1}`,
    summary: str((s as JsonObject).summary) || undefined,
    drill: (s as JsonObject).drill as ReportSpec["sections"][number]["drill"],
    blocks: (Array.isArray((s as JsonObject).blocks) ? ((s as JsonObject).blocks as JsonObject[]) : []).map(
      normalizeBlock,
    ) as unknown as ReportBlock[],
  }));

  return {
    title: str(spec.title) || fallbackTitle,
    subtitle: str(spec.subtitle) || undefined,
    meta: Array.isArray(spec.meta)
      ? spec.meta.slice(0, 8).map((m) => ({ label: str((m as JsonObject).label), value: str((m as JsonObject).value) }))
      : [],
    hero: spec.hero
      ? {
          headline: str((spec.hero as JsonObject).headline),
          summary: str((spec.hero as JsonObject).summary),
          kpis: normalizeKpis((spec.hero as JsonObject).kpis),
        }
      : undefined,
    sections: sections.length ? sections : [{ id: "empty", title: "报告为空", blocks: [] }],
    level: oneOf(spec.level, ["global", "user", "session"], "global") as "global",
  };
}

const KNOWN_KINDS = new Set([
  "kpis", "markdown", "bar", "line", "pie", "radar", "hbar", "scatter",
  "table", "callout", "list", "divider",
]);

/** Models occasionally invent block kinds; map the common aliases onto ours. */
const KIND_ALIASES: Record<string, string> = {
  kpi: "kpis", metric: "kpis", metrics: "kpis", cards: "kpis", stat: "kpis",
  donut: "pie", doughnut: "pie", donutchart: "pie", column: "bar", columns: "bar",
  horizontal_bar: "hbar", horizontalbar: "hbar", h_bar: "hbar", ranked_bar: "hbar",
  area: "line", areaspline: "line", trend: "line", timeseries: "line",
  note: "callout", alert: "callout", highlight: "callout", warning: "callout", insight: "callout",
  paragraph: "markdown", md: "markdown", text: "markdown", textblock: "markdown", rich_text: "markdown",
  quote: "markdown", quote_block: "markdown", quotes: "markdown", evidence: "markdown", blockquote: "markdown",
  bullets: "list", bulletlist: "list", ordered: "list", items: "list", checklist: "list",
  hr: "divider", separator: "divider", section_break: "divider",
};

/**
 * Coerce whatever the model emitted into a renderable block. Unknown kinds fall
 * back based on the payload they carry, so no analysis content is silently lost.
 */
function normalizeBlock(b: JsonObject) {
  const requested = str(b.kind).toLowerCase().replace(/[\s-]/g, "_");
  let kind: string = KNOWN_KINDS.has(requested)
    ? requested
    : KIND_ALIASES[requested] ?? "";

  if (!kind) {
    if (b.table) kind = "table";
    else if (Array.isArray(b.categories) && Array.isArray(b.series)) kind = "bar";
    else if (Array.isArray(b.kpis)) kind = "kpis";
    else if (Array.isArray(b.items) || Array.isArray(b.quotes)) kind = "list";
    else kind = "markdown";
  }

  // Fold quote-style payloads into markdown so the citations stay visible.
  let text = str(b.text) || str(b.content) || str(b.body);
  if (!text && Array.isArray(b.quotes) && (b.quotes as unknown[]).length) {
    text = (b.quotes as JsonObject[])
      .map((q) => {
        const body = str(q.quote ?? q.text ?? q);
        const who = str(q.role ?? q.source ?? q.speaker);
        const key = str(q.session_key ?? q.session);
        const cite = [who && (who === "user" ? "用户" : who === "assistant" ? "AI" : who), key]
          .filter(Boolean)
          .join(" · ");
        return `> ${body}${cite ? `\n>\n> — ${cite}` : ""}`;
      })
      .join("\n\n");
    kind = "markdown";
  }
  if (!text && Array.isArray(b.points)) {
    text = (b.points as unknown[]).map((p) => `- ${str(p) || JSON.stringify(p)}`).join("\n");
    kind = "markdown";
  }

  const block: JsonObject = {
    id: str(b.id) || undefined,
    kind,
    title: str(b.title) || undefined,
    caption: str(b.caption) || str(b.description) || undefined,
    unit: str(b.unit) || undefined,
    text: text || undefined,
    tone: str(b.tone) || str(b.severity) || undefined,
  };

  if (kind === "list") {
    block.items = strArr(b.items?.length ? b.items : b.bullets ?? b.points);
    if (!block.items.length && text) block.items = text.split("\n").map((l) => l.replace(/^[-*]\s*/, "")).filter(Boolean);
    if (!block.items.length && !block.text) block.text = "（模型未提供内容）";
  }
  if (kind === "kpis") {
    block.kpis = normalizeKpis(b.kpis ?? b.items ?? b.cards);
    if (!block.kpis?.length) block.kind = "markdown";
  }
  if (["bar", "hbar", "line", "pie", "radar", "scatter"].includes(kind)) {
    block.categories = strArr(b.categories ?? b.labels ?? b.x);
    const rawSeries = Array.isArray(b.series)
      ? (b.series as JsonObject[])
      : Array.isArray(b.data)
        ? [{ name: str(b.name) || "数值", data: b.data }]
        : [];
    block.series = rawSeries.slice(0, 6).map((s) => ({
      name: str(s.name ?? s.label) || "数值",
      data: (Array.isArray(s.data ?? s.values) ? ((s.data ?? s.values) as unknown[]) : []).map(
        (v) => Number((v as JsonObject)?.value ?? v) || 0,
      ),
    }));
    if (!block.categories.length && Array.isArray(b.items)) {
      block.categories = strArr((b.items as JsonObject[]).map((i) => i.name ?? i.label));
      block.series = [{ name: "数值", data: (b.items as JsonObject[]).map((i) => Number(i.value) || 0) }];
    }
    const width = Math.max(...block.series.map((s: { data: number[] }) => s.data.length), 0);
    if (!block.categories.length || !width) {
      // No plottable numbers: keep the intent as prose rather than drop it.
      block.kind = "markdown";
      block.text =
        block.text ??
        [
          block.title ? `**${block.title}**` : "",
          block.categories.length ? block.categories.join(" · ") : "",
          "（该图表缺少可绘制的数值，已降级为文字说明）",
        ]
          .filter(Boolean)
          .join("\n\n");
      delete block.categories;
      delete block.series;
    }
  }
  if (kind === "table") {
    const t = (b.table ?? {}) as JsonObject;
    const columns = strArr(t.columns ?? t.headers ?? b.columns ?? b.headers);
    const rows = (Array.isArray(t.rows) ? t.rows : Array.isArray(b.rows) ? b.rows : []) as unknown[];
    if (columns.length && rows.length) {
      block.table = {
        columns,
        rows: rows.map((r) =>
          (Array.isArray(r) ? r : Object.values((r ?? {}) as JsonObject)).map((c) =>
            typeof c === "number" ? c : str(c ?? ""),
          ) as (string | number)[],
        ),
      };
    } else {
      block.kind = "markdown";
      block.text = block.text ?? JSON.stringify(b).slice(0, 800);
    }
  }

  return block;
}

function normalizeKpis(raw: unknown) {
  if (!Array.isArray(raw)) return undefined;
  return (raw as JsonObject[]).slice(0, 12).map((k) => ({
    label: str(k.label) || "指标",
    value: typeof k.value === "number" ? k.value : str(k.value),
    unit: str(k.unit) || undefined,
    delta: typeof k.delta === "number" ? k.delta : null,
    hint: str(k.hint) || undefined,
    tone: oneOf(k.tone, ["default", "good", "warn", "bad"], "default") as "default" | "good" | "warn" | "bad",
    source_field: str(k.source_field) || undefined,
  }));
}

/* ---------------------------------------------------------------- metrics */

function normalizeMetrics(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return (raw as JsonObject[])
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      key: str(m.key) || `metric_${Math.random().toString(36).slice(2, 7)}`,
      label: str(m.label) || str(m.key) || "指标",
      value: Number(m.value),
      unit: str(m.unit) || undefined,
    }))
    .filter((m) => Number.isFinite(m.value))
    .slice(0, 24);
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : str(x))).filter((x) => x.length > 0);
}

function oneOf<T extends string>(v: unknown, allowed: readonly string[], fallback: T): T {
  const s = str(v).trim();
  return (allowed.includes(s) ? s : fallback) as T;
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function truncateString(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

