/**
 * The four analysis modes, and every rule that derives from them.
 *
 * This file is the single source of truth for "which model runs which call".
 * The engine asks it, the settings UI labels from it, and the data-source tab
 * validates against it — so a mode can never mean one thing in the picker and
 * another at execution time.
 *
 * Kept free of server-only imports (no `pg`, no `node:crypto`) so a client
 * component can import the labels, exactly like `@/lib/auth/roles`.
 */

export const ANALYSIS_MODES = [
  "omni_all",
  "omni_for_audio",
  "omni_then_refine",
  "audio_first",
] as const;

export type AnalysisMode = (typeof ANALYSIS_MODES)[number];

/** The two kinds of model the registry holds. */
export type ModelKind = "multimodal" | "omni";

export const MODEL_KIND_LABEL: Record<ModelKind, string> = {
  multimodal: "多模态模型",
  omni: "omni 模型",
};

export const MODEL_KIND_HINT: Record<ModelKind, string> = {
  multimodal: "文本 + 图像。承担全部纯文本调用（用户层、全局层、报告）",
  omni: "文本 + 图像 + 音频。唯一可以接收音频输入的模型",
};

export const MODE_LABEL: Record<AnalysisMode, string> = {
  omni_all: "全部用 omni 统一分析",
  omni_for_audio: "涉及音频用 omni，其余用多模态",
  omni_then_refine: "omni 分析后多模态二次优化",
  audio_first: "音频独立分析后交多模态",
};

export const MODE_HINT: Record<AnalysisMode, string> = {
  omni_all: "每一次调用都交给 omni 模型，口径最统一，但纯文本的汇总与报告也按 omni 计费。",
  omni_for_audio:
    "带音频的会话交给 omni，没有音频的会话与所有汇总、报告交给多模态。成本与效果的默认折中。",
  omni_then_refine:
    "带音频的会话先由 omni 结合音频与转录分析，再把这份结果连同转录（不含音频）交给多模态做二次优化。",
  audio_first:
    "先由 omni 单独听音频产出「音频观察」，再把观察结论连同完整对话交给多模态做正式分析。",
};

/** Modes that issue two model calls per audio-bearing session. */
export const TWO_PASS_MODES: readonly AnalysisMode[] = ["omni_then_refine", "audio_first"];

export function isTwoPass(mode: AnalysisMode): boolean {
  return TWO_PASS_MODES.includes(mode);
}

/** Anything unrecognised reads as the default, never as a mode we cannot run. */
export const DEFAULT_MODE: AnalysisMode = "omni_for_audio";

export function asMode(value: string | null | undefined): AnalysisMode {
  return (ANALYSIS_MODES as readonly string[]).includes(value ?? "")
    ? (value as AnalysisMode)
    : DEFAULT_MODE;
}

/* ------------------------------------------------------- per-call routing */

/**
 * How one session is analysed. `hasAudio` means audio will actually reach the
 * prompt — the workflow switch is on, the session has clips, and they signed —
 * not merely that the data source contains audio somewhere.
 */
export type SessionStrategy =
  /** One call to the omni model, with the audio attached when there is any. */
  | "omni_single"
  /** One call to the multimodal model, transcript only. */
  | "multimodal_single"
  /** omni (audio + transcript) → multimodal (that result + transcript). */
  | "omni_then_refine"
  /** omni (audio alone) → multimodal (the audio observation + transcript). */
  | "audio_then_multimodal";

/** One line per routing, shared by the config UI and the run's own tally. */
export const STRATEGY_LABEL: Record<SessionStrategy, string> = {
  omni_single: "omni 一次调用",
  multimodal_single: "多模态一次调用",
  omni_then_refine: "omni（音频 + 转录）→ 多模态二次优化",
  audio_then_multimodal: "omni（仅音频）→ 多模态正式分析",
};

export function sessionStrategy(mode: AnalysisMode, hasAudio: boolean): SessionStrategy {
  if (mode === "omni_all") return "omni_single";
  if (!hasAudio) return "multimodal_single";
  switch (mode) {
    case "omni_for_audio":
      return "omni_single";
    case "omni_then_refine":
      return "omni_then_refine";
    case "audio_first":
      return "audio_then_multimodal";
  }
}

/**
 * Which model runs the text-only work: the user layer, the global layer, report
 * writing, and the planner's own prompt-writing call. Only `omni_all` routes
 * these to omni.
 */
export function textModelKind(mode: AnalysisMode): ModelKind {
  return mode === "omni_all" ? "omni" : "multimodal";
}

/**
 * Listening to sample audio during planning is always omni's job — it is the
 * only kind that accepts an audio part at all, in every mode.
 */
export const PLAN_AUDIO_KIND: ModelKind = "omni";

/* ------------------------------------------------------------- validation */

/** Kinds a mode cannot run at all without, audio or no audio. */
export function requiredKinds(mode: AnalysisMode): ModelKind[] {
  return mode === "omni_all" ? ["omni"] : ["multimodal"];
}

/** Kinds a mode additionally needs as soon as a call carries audio. */
export function audioKinds(mode: AnalysisMode): ModelKind[] {
  return mode === "omni_all" ? [] : ["omni"];
}

/** One line for a card or a tooltip: what this mode will cost to run. */
export function describeModeCost(mode: AnalysisMode): string {
  if (mode === "omni_all") return "每个会话 1 次 omni 调用；汇总与报告也走 omni";
  if (isTwoPass(mode)) return "带音频的会话 2 次调用（omni + 多模态），无音频会话 1 次";
  return "每个会话 1 次调用；汇总与报告走多模态";
}

/* ------------------------------------------------------- 各阶段调用参数 */

/**
 * The five JSON-returning model calls a run makes. Each one has its own budget
 * and its own answer to "is reasoning worth the wait here", so each is
 * configurable: a 会话层 call runs once per session and wants to be cheap, the
 * 报告 call runs once and has to fit a whole report in one answer.
 *
 * The audio-only sub-calls (planning's 试听, the audio-first observation) are
 * not here: they produce prose, not JSON, and their small fixed budgets are a
 * property of the prompt rather than something worth tuning.
 */
export const ANALYSIS_STAGES = ["plan", "session", "user", "global", "report"] as const;

export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

export const STAGE_LABEL: Record<AnalysisStage, string> = {
  plan: "规划 · 生成提示词",
  session: "会话层分析",
  user: "用户层汇总",
  global: "全局层汇总",
  report: "报告生成",
};

export const STAGE_HINT: Record<AnalysisStage, string> = {
  plan: "每次规划 1 次调用，产出四段提示词，值得思考",
  session: "每个会话 1-2 次调用，调用量最大，成本对这里最敏感",
  user: "每个用户 1 次调用，输入是该用户所有会话的结论",
  global: "整个任务 1 次调用，输入是全部用户层结论与真实统计",
  report: "整个任务 1 次调用，要在一次回答里写完整份报告",
};

/** 跟随模型自身的 enable_thinking 设置，或在这一步强制开关。 */
export type ThinkingChoice = "auto" | "on" | "off";

export const THINKING_LABEL: Record<ThinkingChoice, string> = {
  auto: "跟随模型配置",
  on: "开启思考",
  off: "关闭思考",
};

export interface StageParams {
  thinking: ThinkingChoice;
  /** 0 means "send no max_tokens at all" and let the model stop where it stops. */
  maxTokens: number;
}

/** Above this the value is almost certainly a typo, not a budget. */
export const MAX_TOKENS_CEILING = 100000;

/**
 * The built-in floor of the chain. The budgets are measured, not guessed:
 * against a Model Studio endpoint, an "write as much as you can" report prompt
 * stops on its own at ~12k (omni-flash) and ~15k (max) completion tokens, so
 * 16000 is a runaway guard that a real report never reaches — where the old
 * 8000 truncated a long one mid-sentence. Report writing keeps thinking off:
 * the same prompt took 431s with it and 105s without, and the contract it
 * follows is already precise.
 */
export const DEFAULT_STAGE_PARAMS: Record<AnalysisStage, StageParams> = {
  plan: { thinking: "on", maxTokens: 14000 },
  session: { thinking: "auto", maxTokens: 0 },
  user: { thinking: "auto", maxTokens: 0 },
  global: { thinking: "auto", maxTokens: 16000 },
  report: { thinking: "off", maxTokens: 16000 },
};

/** As stored: every field may be null, meaning "inherit the layer below". */
export interface StageParamsPatch {
  thinking: ThinkingChoice | null;
  maxTokens: number | null;
}

export type StagePatchMap = Partial<Record<AnalysisStage, StageParamsPatch>>;

const THINKING_CHOICES: readonly string[] = ["auto", "on", "off"];

function asStagePatch(value: unknown): StageParamsPatch {
  const raw = (value ?? {}) as Record<string, unknown>;
  const thinking = typeof raw.thinking === "string" && THINKING_CHOICES.includes(raw.thinking)
    ? (raw.thinking as ThinkingChoice)
    : null;
  const maxTokens =
    typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) && raw.maxTokens >= 0
      ? Math.min(Math.floor(raw.maxTokens), MAX_TOKENS_CEILING)
      : null;
  return { thinking, maxTokens };
}

export function asStagePatchMap(value: unknown): StagePatchMap {
  const raw = (value ?? {}) as Record<string, unknown>;
  const out: StagePatchMap = {};
  for (const stage of ANALYSIS_STAGES) {
    if (raw[stage] == null) continue;
    const patch = asStagePatch(raw[stage]);
    if (patch.thinking !== null || patch.maxTokens !== null) out[stage] = patch;
  }
  return out;
}

/** Field-by-field, stage-by-stage inheritance, same rule as the model slots. */
export function applyStagePatch(
  base: Record<AnalysisStage, StageParams>,
  patch: StagePatchMap,
): Record<AnalysisStage, StageParams> {
  const out = {} as Record<AnalysisStage, StageParams>;
  for (const stage of ANALYSIS_STAGES) {
    const over = patch[stage];
    out[stage] = {
      thinking: over?.thinking ?? base[stage].thinking,
      maxTokens: over?.maxTokens ?? base[stage].maxTokens,
    };
  }
  return out;
}

export function isEmptyStagePatch(patch: StagePatchMap): boolean {
  return !ANALYSIS_STAGES.some((s) => patch[s]?.thinking != null || patch[s]?.maxTokens != null);
}

/**
 * A stage's settings as `chat`/`chatJson` options. "auto" and 0 are expressed by
 * leaving the key out, which is what makes them mean "whatever the model says"
 * and "no max_tokens on the wire" rather than `false` and `0`.
 */
export function stageOptions(
  stages: Record<AnalysisStage, StageParams>,
  stage: AnalysisStage,
): { thinking?: boolean; maxTokens?: number } {
  const params = stages[stage] ?? DEFAULT_STAGE_PARAMS[stage];
  return {
    ...(params.thinking === "auto" ? {} : { thinking: params.thinking === "on" }),
    ...(params.maxTokens > 0 ? { maxTokens: params.maxTokens } : {}),
  };
}

/* ---------------------------------------------------------- the selection */

/**
 * A resolved choice of mode and models. Every field is nullable at the storage
 * layer, where null means "inherit"; by the time the engine sees one, the mode
 * has been resolved and the model ids are whatever the workspace has.
 */
export interface AnalysisSelection {
  mode: AnalysisMode;
  omniModelId: string | null;
  multimodalModelId: string | null;
  stages: Record<AnalysisStage, StageParams>;
}

/** As stored — on `app_settings.analysis_defaults` or `data_sources.model_config`. */
export interface AnalysisSelectionPatch {
  mode: AnalysisMode | null;
  omniModelId: string | null;
  multimodalModelId: string | null;
  stages: StagePatchMap;
}

export const EMPTY_PATCH: AnalysisSelectionPatch = {
  mode: null,
  omniModelId: null,
  multimodalModelId: null,
  stages: {},
};

/** Read a stored jsonb blob into a patch, tolerating absent and junk keys. */
export function asPatch(value: unknown): AnalysisSelectionPatch {
  const raw = (value ?? {}) as Record<string, unknown>;
  const mode = typeof raw.mode === "string" ? raw.mode : null;
  return {
    mode: mode && (ANALYSIS_MODES as readonly string[]).includes(mode) ? (mode as AnalysisMode) : null,
    omniModelId: typeof raw.omniModelId === "string" && raw.omniModelId ? raw.omniModelId : null,
    multimodalModelId:
      typeof raw.multimodalModelId === "string" && raw.multimodalModelId ? raw.multimodalModelId : null,
    stages: asStagePatchMap(raw.stages),
  };
}

/** Field-by-field inheritance: a null in the override keeps the base's value. */
export function applyPatch(base: AnalysisSelection, patch: AnalysisSelectionPatch): AnalysisSelection {
  return {
    mode: patch.mode ?? base.mode,
    omniModelId: patch.omniModelId ?? base.omniModelId,
    multimodalModelId: patch.multimodalModelId ?? base.multimodalModelId,
    stages: applyStagePatch(base.stages, patch.stages),
  };
}
