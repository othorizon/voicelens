import { execute, maybeOne, query, type Executor } from "@/lib/db";
import { decryptSecret, describeSecret, type SecretState } from "./secret";
import {
  applyPatch,
  applyStagePatch,
  asMode,
  asPatch,
  DEFAULT_MODE,
  DEFAULT_STAGE_PARAMS,
  EMPTY_PATCH,
  MODEL_KIND_LABEL,
  type AnalysisMode,
  type AnalysisSelection,
  type AnalysisSelectionPatch,
  type AnalysisStage,
  type ModelKind,
  type StageParams,
} from "./mode";

/**
 * Reading side of the model registry: the rows the owner configured, the
 * workspace default, each data source's override, and the resolution of the
 * three into the runtime the engine executes against.
 *
 * Writes live in `@/lib/actions/models` behind the owner guard. Everything here
 * is server-only — it decrypts API keys.
 */

export const SETTINGS_KEY = "analysis_defaults";

/* ------------------------------------------------------------------ rows */

interface ModelRecord {
  id: string;
  name: string;
  kind: ModelKind;
  base_url: string;
  model: string;
  api_key_cipher: string;
  enable_thinking: boolean;
  enabled: boolean;
  note: string;
  created_at: string;
  updated_at: string;
}

/** A model as the UI sees it: no ciphertext, no plaintext, just its state. */
export interface ModelSummary {
  id: string;
  name: string;
  kind: ModelKind;
  baseUrl: string;
  model: string;
  enableThinking: boolean;
  enabled: boolean;
  note: string;
  key: SecretState;
  createdAt: string;
  updatedAt: string;
}

/** Everything one model needs to issue a call. */
export interface ModelRuntime {
  id: string;
  name: string;
  kind: ModelKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  thinking: boolean;
}

const COLUMNS = `id, name, kind, base_url, model, api_key_cipher, enable_thinking, enabled, note, created_at, updated_at`;

function toSummary(row: ModelRecord): ModelSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    model: row.model,
    enableThinking: row.enable_thinking,
    enabled: row.enabled,
    note: row.note,
    key: describeSecret(row.api_key_cipher),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listModels(): Promise<ModelSummary[]> {
  const rows = await query<ModelRecord>(
    `select ${COLUMNS} from ai_models order by kind, lower(name)`,
  );
  return rows.map(toSummary);
}

export async function getModel(id: string): Promise<ModelSummary | null> {
  const row = await maybeOne<ModelRecord>(`select ${COLUMNS} from ai_models where id = $1`, [id]);
  return row ? toSummary(row) : null;
}

/** The stored ciphertext, for the update path that keeps an unchanged key. */
export async function getModelCipher(id: string): Promise<string | null> {
  return maybeOne<{ api_key_cipher: string }>(
    `select api_key_cipher from ai_models where id = $1`,
    [id],
  ).then((row) => row?.api_key_cipher ?? null);
}

/**
 * Decrypt one model into something callable. Returns null when the row is gone;
 * throws when the row is there but unusable, because "configured but broken" and
 * "not configured" call for different fixes and the caller reports them apart.
 */
export async function runtimeFor(id: string): Promise<ModelRuntime | null> {
  const row = await maybeOne<ModelRecord>(`select ${COLUMNS} from ai_models where id = $1`, [id]);
  if (!row) return null;
  if (!row.enabled) throw new Error(`模型「${row.name}」已被停用，请在「设置 → 分析模型」中启用或改选其他模型`);
  if (!row.base_url || !row.model) throw new Error(`模型「${row.name}」缺少接口地址或模型 id`);
  let apiKey = "";
  try {
    apiKey = decryptSecret(row.api_key_cipher);
  } catch {
    throw new Error(
      `模型「${row.name}」的 API Key 无法解密（MODEL_SECRET / AUTH_SECRET 可能已轮换），请在「设置 → 分析模型」中重新填写`,
    );
  }
  if (!apiKey) throw new Error(`模型「${row.name}」还没有填写 API Key`);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKey,
    model: row.model,
    thinking: row.enable_thinking,
  };
}

/* ------------------------------------------------------------- selection */

/**
 * The workspace patch as stored, before the built-in defaults are applied —
 * what the settings page edits, so a stage nobody has touched keeps saying
 * "内置默认" rather than freezing today's number into the row.
 */
export async function readDefaultsPatch(): Promise<AnalysisSelectionPatch> {
  const value = await maybeOne<{ value: unknown }>(`select value from app_settings where key = $1`, [
    SETTINGS_KEY,
  ]);
  return asPatch(value?.value);
}

/** The workspace default. Missing or junk rows read as the built-in default. */
export async function readDefaults(): Promise<AnalysisSelection> {
  const patch = await readDefaultsPatch();
  return {
    mode: patch.mode ?? DEFAULT_MODE,
    omniModelId: patch.omniModelId,
    multimodalModelId: patch.multimodalModelId,
    // The workspace row is a patch over the built-in params, so a stage the
    // owner never touched keeps following the code rather than freezing at
    // whatever the defaults happened to be the day it was saved.
    stages: applyStagePatch(DEFAULT_STAGE_PARAMS, patch.stages),
  };
}

export async function writeDefaults(selection: AnalysisSelectionPatch, userId: string): Promise<void> {
  await execute(
    `insert into app_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update
       set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [SETTINGS_KEY, JSON.stringify(selection), userId],
  );
}

export async function readSourcePatch(dataSourceId: string): Promise<AnalysisSelectionPatch> {
  const row = await maybeOne<{ model_config: unknown }>(
    `select model_config from data_sources where id = $1`,
    [dataSourceId],
  );
  return asPatch(row?.model_config);
}

/**
 * Drop every stored reference to a model, in `data_sources.model_config` and in
 * the workspace default. Dropping the key is the same as storing null — both
 * read as "inherit" / "not configured" — and `jsonb - ''` removes a key that
 * cannot exist, so the untouched slot passes through unchanged.
 *
 * Returns the number of data sources that had to be rewritten.
 */
export async function clearModelReferences(id: string, exec?: Executor): Promise<number> {
  const cleared = await execute(
    `update data_sources
     set model_config =
           model_config
           - (case when model_config ->> 'omniModelId' = $1 then 'omniModelId' else '' end)
           - (case when model_config ->> 'multimodalModelId' = $1 then 'multimodalModelId' else '' end),
         updated_at = now()
     where model_config ->> 'omniModelId' = $1
        or model_config ->> 'multimodalModelId' = $1`,
    [id],
    exec,
  );

  await execute(
    `update app_settings
     set value =
           value
           - (case when value ->> 'omniModelId' = $1 then 'omniModelId' else '' end)
           - (case when value ->> 'multimodalModelId' = $1 then 'multimodalModelId' else '' end),
         updated_at = now()
     where key = $2
       and (value ->> 'omniModelId' = $1 or value ->> 'multimodalModelId' = $1)`,
    [id, SETTINGS_KEY],
    exec,
  );

  return cleared;
}

export async function writeSourcePatch(
  dataSourceId: string,
  patch: AnalysisSelectionPatch,
): Promise<void> {
  await execute(
    `update data_sources set model_config = $2::jsonb, updated_at = now() where id = $1`,
    [dataSourceId, JSON.stringify(patch)],
  );
}

/**
 * What a data source actually runs with, plus the two layers it came from — the
 * UI shows "继承自全局" against each field, so it needs all three.
 */
export interface ResolvedSelection {
  effective: AnalysisSelection;
  defaults: AnalysisSelection;
  override: AnalysisSelectionPatch;
}

export async function resolveSelection(dataSourceId: string | null): Promise<ResolvedSelection> {
  const defaults = await readDefaults();
  const override = dataSourceId ? await readSourcePatch(dataSourceId) : EMPTY_PATCH;
  return { effective: applyPatch(defaults, override), defaults, override };
}

/* --------------------------------------------------------------- runtime */

/**
 * The engine's view: a mode plus whichever models it may need. Both slots are
 * loaded up front — a run that switches models per session should not be
 * issuing a database read and a decrypt on every one.
 */
export interface AnalysisRuntime {
  mode: AnalysisMode;
  omni: ModelRuntime | null;
  multimodal: ModelRuntime | null;
  /** Per-stage thinking and max_tokens, already resolved through both layers. */
  stages: Record<AnalysisStage, StageParams>;
  /**
   * Why a slot is empty although a model was selected for it — a disabled row,
   * an undecryptable key, a kind that no longer matches. Held rather than
   * thrown so a run that never touches that slot still goes through: a broken
   * omni model must not fail a data source that has no audio in it.
   */
  problems: Partial<Record<ModelKind, string>>;
}

async function loadSlot(
  id: string | null,
  kind: ModelKind,
): Promise<{ model: ModelRuntime | null; problem?: string }> {
  if (!id) return { model: null };
  try {
    const model = await runtimeFor(id);
    // A model selected and then deleted reads the same as never selected.
    if (!model) return { model: null };
    if (model.kind !== kind) {
      return {
        model: null,
        problem: `模型「${model.name}」的类型是${MODEL_KIND_LABEL[model.kind]}，不能用在${MODEL_KIND_LABEL[kind]}的位置`,
      };
    }
    return { model };
  } catch (err) {
    return { model: null, problem: err instanceof Error ? err.message : String(err) };
  }
}

export async function resolveRuntime(dataSourceId: string | null): Promise<AnalysisRuntime> {
  const { effective } = await resolveSelection(dataSourceId);
  const [omni, multimodal] = await Promise.all([
    loadSlot(effective.omniModelId, "omni"),
    loadSlot(effective.multimodalModelId, "multimodal"),
  ]);
  const problems: Partial<Record<ModelKind, string>> = {};
  if (omni.problem) problems.omni = omni.problem;
  if (multimodal.problem) problems.multimodal = multimodal.problem;
  return {
    mode: asMode(effective.mode),
    omni: omni.model,
    multimodal: multimodal.model,
    stages: effective.stages,
    problems,
  };
}

export function pickModel(runtime: AnalysisRuntime, kind: ModelKind): ModelRuntime | null {
  return kind === "omni" ? runtime.omni : runtime.multimodal;
}

/**
 * The model for `kind`, or a failure that says what to configure. Every engine
 * call goes through here, so an unconfigured workspace fails with one clear
 * message instead of an OpenAI client error about a missing base URL.
 */
export function requireModel(runtime: AnalysisRuntime, kind: ModelKind, purpose: string): ModelRuntime {
  const picked = pickModel(runtime, kind);
  if (picked) return picked;
  // A model was chosen but could not be loaded: report why, since "fix this
  // model" and "choose a model" are different jobs for whoever reads this.
  const problem = runtime.problems[kind];
  if (problem) throw new Error(`${purpose}需要${MODEL_KIND_LABEL[kind]}，但${problem}`);
  throw new Error(
    `尚未配置可用的${MODEL_KIND_LABEL[kind]}（${purpose}需要）。请让所有者在「设置 → 分析模型」中配置模型，并在全局默认或该数据源的「分析模型」中选中它。`,
  );
}

/** A compact record of what ran, for `analysis_tasks.stats` and the report. */
export interface RuntimeDigest {
  mode: AnalysisMode;
  omni: string | null;
  multimodal: string | null;
}

export function describeRuntime(runtime: AnalysisRuntime): RuntimeDigest {
  return {
    mode: runtime.mode,
    omni: runtime.omni ? `${runtime.omni.name}（${runtime.omni.model}）` : null,
    multimodal: runtime.multimodal ? `${runtime.multimodal.name}（${runtime.multimodal.model}）` : null,
  };
}
