"use server";

import { revalidatePath } from "next/cache";
import { ActionError, requireOwnerSession, requireSourceAccess } from "./common";
import { execute, maybeOne, one, query, tx } from "@/lib/db";
import { chat } from "@/lib/engine/ai";
import { encryptSecret, sameSecret } from "@/lib/models/secret";
import {
  clearModelReferences,
  getModelCipher,
  readDefaults,
  readSourcePatch,
  runtimeFor,
  writeDefaults,
  writeSourcePatch,
} from "@/lib/models/registry";
import {
  ANALYSIS_MODES,
  MODEL_KIND_LABEL,
  type AnalysisMode,
  type AnalysisSelectionPatch,
  type ModelKind,
} from "@/lib/models/mode";

/**
 * Writes against the model registry.
 *
 * Creating and editing a model is owner-only — it means handling the API key.
 * Pointing a data source at an already-configured model is not, and goes
 * through the ordinary data-source guard: a member choosing between two models
 * the owner set up never sees a credential.
 */

export interface ModelInput {
  name: string;
  kind: ModelKind;
  baseUrl: string;
  model: string;
  /** Null on an update leaves the stored key untouched. Required on create. */
  apiKey: string | null;
  enableThinking: boolean;
  enabled: boolean;
  note: string;
}

function clean(input: ModelInput) {
  const name = input.name?.trim() ?? "";
  const baseUrl = input.baseUrl?.trim() ?? "";
  const model = input.model?.trim() ?? "";

  if (!name) throw new ActionError("请填写模型名称");
  if (input.kind !== "multimodal" && input.kind !== "omni") throw new ActionError("未知的模型类型");
  if (!model) throw new ActionError("请填写模型 id");
  if (!baseUrl) throw new ActionError("请填写接口地址");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ActionError("接口地址不是合法的 URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ActionError("接口地址必须是 http 或 https");
  }

  return {
    name,
    kind: input.kind,
    // A trailing slash makes the SDK build `…/v1//chat/completions` on some
    // gateways; strip it once here rather than at every call site.
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    enableThinking: Boolean(input.enableThinking),
    enabled: Boolean(input.enabled),
    note: (input.note ?? "").trim().slice(0, 500),
  };
}

/** Unique index violations read as a duplicate name rather than a raw SQL error. */
function wrap(err: unknown, what: string): never {
  if (err instanceof ActionError) throw err;
  const message = (err as Error)?.message ?? String(err);
  if (message.includes("ai_models_name_key")) throw new ActionError("已存在同名模型，请换一个名称");
  throw new ActionError(`${what}：${message}`);
}

export async function createModel(input: ModelInput): Promise<{ id: string }> {
  const session = await requireOwnerSession();
  const fields = clean(input);
  const apiKey = input.apiKey?.trim() ?? "";
  if (!apiKey) throw new ActionError("请填写 API Key");

  try {
    const created = await one<{ id: string }>(
      `insert into ai_models
         (name, kind, base_url, model, api_key_cipher, enable_thinking, enabled, note, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        fields.name,
        fields.kind,
        fields.baseUrl,
        fields.model,
        encryptSecret(apiKey),
        fields.enableThinking,
        fields.enabled,
        fields.note,
        session.userId,
      ],
    );
    revalidatePath("/settings");
    return { id: created.id };
  } catch (err) {
    wrap(err, "新增模型失败");
  }
}

export async function updateModel(id: string, input: ModelInput): Promise<void> {
  await requireOwnerSession();
  const fields = clean(input);

  const current = await getModelCipher(id);
  if (current === null) throw new ActionError("模型不存在");

  // An empty key field means "leave it alone"; re-encrypting an unchanged key
  // would only churn the ciphertext.
  const submitted = input.apiKey?.trim() ?? "";
  const cipher = !submitted || sameSecret(current, submitted) ? current : encryptSecret(submitted);
  if (!cipher) throw new ActionError("请填写 API Key");

  try {
    await execute(
      `update ai_models
       set name = $2, kind = $3, base_url = $4, model = $5, api_key_cipher = $6,
           enable_thinking = $7, enabled = $8, note = $9
       where id = $1`,
      [
        id,
        fields.name,
        fields.kind,
        fields.baseUrl,
        fields.model,
        cipher,
        fields.enableThinking,
        fields.enabled,
        fields.note,
      ],
    );
  } catch (err) {
    wrap(err, "保存模型失败");
  }
  revalidatePath("/settings");
}

/**
 * Delete a model and drop every reference to it in the same transaction, so a
 * data source can never point at an id that is gone. Both places read a missing
 * selection as "not configured", which is exactly what this leaves behind.
 */
export async function deleteModel(id: string): Promise<{ clearedSources: number }> {
  await requireOwnerSession();
  const model = await maybeOne<{ name: string }>(`select name from ai_models where id = $1`, [id]);
  if (!model) throw new ActionError("模型不存在");

  try {
    return await tx(async (client) => {
      const clearedSources = await clearModelReferences(id, client);
      await execute(`delete from ai_models where id = $1`, [id], client);
      return { clearedSources };
    });
  } catch (err) {
    wrap(err, "删除模型失败");
  }
}

/**
 * Smoke-test one model with a minimal completion. This is the only way to find
 * out that a base URL or a key is wrong without launching a real analysis job.
 */
export async function testModel(id: string): Promise<{ ok: boolean; message: string }> {
  await requireOwnerSession();
  let runtime;
  try {
    runtime = await runtimeFor(id);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  if (!runtime) return { ok: false, message: "模型不存在" };

  try {
    const res = await chat([{ role: "user", content: "回复两个字：可用" }], {
      model: runtime,
      temperature: 0,
      maxTokens: 16,
      thinking: false,
    });
    const reply = res.text.trim().slice(0, 40) || "（空响应）";
    return { ok: true, message: `连通正常 · ${runtime.model} 回复「${reply}」` };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return { ok: false, message: message.slice(0, 300) };
  }
}

/* ------------------------------------------------------------ selection */

function cleanPatch(raw: {
  mode?: string | null;
  omniModelId?: string | null;
  multimodalModelId?: string | null;
}): AnalysisSelectionPatch {
  const mode = raw.mode ?? null;
  if (mode !== null && !(ANALYSIS_MODES as readonly string[]).includes(mode)) {
    throw new ActionError("未知的分析模式");
  }
  return {
    mode: (mode as AnalysisMode | null) ?? null,
    omniModelId: raw.omniModelId || null,
    multimodalModelId: raw.multimodalModelId || null,
  };
}

/** Each chosen id must exist and be of the kind the slot expects. */
async function assertKinds(patch: AnalysisSelectionPatch): Promise<void> {
  const wanted: { id: string; kind: ModelKind }[] = [];
  if (patch.omniModelId) wanted.push({ id: patch.omniModelId, kind: "omni" });
  if (patch.multimodalModelId) wanted.push({ id: patch.multimodalModelId, kind: "multimodal" });
  if (!wanted.length) return;

  const rows = await query<{ id: string; kind: ModelKind; enabled: boolean; name: string }>(
    `select id, kind, enabled, name from ai_models where id = any($1::uuid[])`,
    [wanted.map((w) => w.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const w of wanted) {
    const row = byId.get(w.id);
    if (!row) throw new ActionError("所选模型不存在，请刷新后重试");
    if (row.kind !== w.kind) {
      throw new ActionError(`「${row.name}」不是${MODEL_KIND_LABEL[w.kind]}，不能选在这里`);
    }
    if (!row.enabled) throw new ActionError(`「${row.name}」已被停用，请先启用或改选其他模型`);
  }
}

/** The workspace default every data source inherits from. */
export async function saveAnalysisDefaults(raw: {
  mode?: string | null;
  omniModelId?: string | null;
  multimodalModelId?: string | null;
}): Promise<void> {
  const session = await requireOwnerSession();
  const patch = cleanPatch(raw);
  await assertKinds(patch);

  // The workspace default is the bottom of the inheritance chain, so it always
  // names a mode — only a data source may say "inherit".
  const current = await readDefaults();
  try {
    await writeDefaults({ ...patch, mode: patch.mode ?? current.mode }, session.userId);
  } catch (err) {
    wrap(err, "保存默认分析配置失败");
  }
  revalidatePath("/settings");
}

/**
 * One data source's override. Any field left null inherits the workspace
 * default, which is why this takes the whole patch rather than merging.
 */
export async function saveSourceModelConfig(
  dataSourceId: string,
  raw: { mode?: string | null; omniModelId?: string | null; multimodalModelId?: string | null },
): Promise<void> {
  await requireSourceAccess(dataSourceId);
  const patch = cleanPatch(raw);
  await assertKinds(patch);

  try {
    await writeSourcePatch(dataSourceId, patch);
  } catch (err) {
    wrap(err, "保存分析模型配置失败");
  }
  revalidatePath(`/sources/${dataSourceId}/models`);
  revalidatePath(`/sources/${dataSourceId}`);
}

/** Drop the override entirely, so the source follows the workspace default. */
export async function resetSourceModelConfig(dataSourceId: string): Promise<void> {
  await requireSourceAccess(dataSourceId);
  const current = await readSourcePatch(dataSourceId);
  if (!current.mode && !current.omniModelId && !current.multimodalModelId) return;
  try {
    await writeSourcePatch(dataSourceId, { mode: null, omniModelId: null, multimodalModelId: null });
  } catch (err) {
    wrap(err, "重置分析模型配置失败");
  }
  revalidatePath(`/sources/${dataSourceId}/models`);
  revalidatePath(`/sources/${dataSourceId}`);
}
