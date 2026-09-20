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
}

/** As stored — on `app_settings.analysis_defaults` or `data_sources.model_config`. */
export interface AnalysisSelectionPatch {
  mode: AnalysisMode | null;
  omniModelId: string | null;
  multimodalModelId: string | null;
}

export const EMPTY_PATCH: AnalysisSelectionPatch = {
  mode: null,
  omniModelId: null,
  multimodalModelId: null,
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
  };
}

/** Field-by-field inheritance: a null in the override keeps the base's value. */
export function applyPatch(base: AnalysisSelection, patch: AnalysisSelectionPatch): AnalysisSelection {
  return {
    mode: patch.mode ?? base.mode,
    omniModelId: patch.omniModelId ?? base.omniModelId,
    multimodalModelId: patch.multimodalModelId ?? base.multimodalModelId,
  };
}
