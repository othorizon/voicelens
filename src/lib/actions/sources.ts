"use server";

import { revalidatePath } from "next/cache";
import { requireSession, ActionError } from "./common";
import { defaultGraph } from "@/lib/workflow/graph";
import type { ExtraFieldDef, JsonObject } from "@/lib/types";

export interface DataSourceInput {
  name: string;
  description: string;
  extra_schema?: ExtraFieldDef[];
}

export async function createDataSource(input: DataSourceInput): Promise<{ id: string }> {
  const { supabase, userId } = await requireSession();
  const name = input.name?.trim();
  if (!name) throw new ActionError("请填写数据源名称");

  const { data, error } = await supabase
    .from("data_sources")
    .insert({
      name,
      description: input.description?.trim() ?? "",
      extra_schema: (input.extra_schema ?? []) as unknown as JsonObject,
      created_by: userId,
    })
    .select("id")
    .single();

  if (error) throw new ActionError(`创建数据源失败：${error.message}`);

  const graph = defaultGraph();
  const { error: wfError } = await supabase.from("workflows").insert({
    data_source_id: data.id as string,
    name: `${name} · 默认分析流`,
    graph: graph as unknown as JsonObject,
    config: {} as JsonObject,
    is_active: true,
    created_by: userId,
  } as never);
  if (wfError) throw new ActionError(`创建默认工作流失败：${wfError.message}`);

  revalidatePath("/sources");
  revalidatePath("/dashboard");
  return { id: data.id as string };
}

export async function updateDataSource(
  id: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  const { supabase } = await requireSession();
  const updates: JsonObject = {};
  if (patch.name !== undefined) updates.name = patch.name.trim();
  if (patch.description !== undefined) updates.description = patch.description;
  if (!Object.keys(updates).length) return;

  const { error } = await supabase.from("data_sources").update(updates as never).eq("id", id);
  if (error) throw new ActionError(`保存失败：${error.message}`);
  revalidatePath(`/sources/${id}`);
  revalidatePath("/sources");
  revalidatePath("/dashboard");
}

export async function saveExtraSchema(id: string, schema: ExtraFieldDef[]): Promise<void> {
  const { supabase } = await requireSession();
  for (const f of schema) {
    if (!f.name?.trim()) throw new ActionError("存在未命名的 extra 字段");
  }
  const names = schema.map((f) => f.name);
  if (new Set(names).size !== names.length) throw new ActionError("extra 字段名不可重复");

  const { error } = await supabase
    .from("data_sources")
    .update({ extra_schema: schema as unknown as JsonObject })
    .eq("id", id);
  if (error) throw new ActionError(`保存 schema 失败：${error.message}`);
  revalidatePath(`/sources/${id}`);
}

export async function inferSchemaFromData(id: string): Promise<ExtraFieldDef[]> {
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("extra_histogram", {
    p_data_source_id: id,
    p_max_values: 20,
  });
  if (error) throw new ActionError(`读取字段分布失败：${error.message}`);

  const rows = (data ?? []) as { key: string; values: { name: string; value: number }[] }[];
  const current = await getExtraSchema(id);
  const existing = new Map(current.map((c) => [c.name, c]));

  return rows.map((r) => {
    const isNumeric = (r.values ?? []).some((v) => ["均值", "中位数", "P90", "最大值"].includes(v.name));
    const isBool = (r.values ?? []).every((v) => v.name === "true" || v.name === "false");
    const prev = existing.get(r.key);
    const sentiment = /emotion|sentiment|mood|情绪|feel/i.test(r.key);
    const base: ExtraFieldDef = {
      name: r.key,
      label: prev?.label ?? pretty(r.key),
      kind: sentiment ? "sentiment" : isBool ? "boolean" : isNumeric ? "number" : (r.values ?? []).length <= 16 ? "enum" : "text",
      scope: prev?.scope ?? "message",
      options: isNumeric || kind0(r.values) === "number" ? undefined : (r.values ?? []).map((v) => v.name).slice(0, 20),
      description: prev?.description ?? "",
      usage: prev?.usage ?? (sentiment || isBool || !isNumeric ? "segment" : "metric"),
      positive: prev?.positive,
    };
    return base;
  });
}

function kind0(values?: { name: string; value: number }[]) {
  if (!values?.length) return "enum";
  return values.some((v) => ["均值", "中位数", "P90", "最大值", "样本数"].includes(v.name)) ? "number" : "enum";
}

function pretty(key: string) {
  return key.replace(/[_-]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

async function getExtraSchema(id: string): Promise<ExtraFieldDef[]> {
  const { supabase } = await requireSession();
  const { data } = await supabase.from("data_sources").select("extra_schema").eq("id", id).maybeSingle();
  return ((data?.extra_schema as ExtraFieldDef[] | null) ?? []) as ExtraFieldDef[];
}

export async function deleteDataSource(id: string): Promise<void> {
  const { supabase } = await requireSession();
  const { error } = await supabase.from("data_sources").delete().eq("id", id);
  if (error) throw new ActionError(`删除失败：${error.message}`);
  revalidatePath("/sources");
  revalidatePath("/dashboard");
}

export async function deleteBatch(batchId: string): Promise<{ messages: number; sessions: number }> {
  const { supabase } = await requireSession();
  const { data: batch } = await supabase
    .from("import_batches")
    .select("id, data_source_id")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) throw new ActionError("批次不存在");

  const { data, error } = await supabase.rpc("delete_import_batch", { p_batch_id: batchId });
  if (error) throw new ActionError(`删除批次失败：${error.message}`);
  const result = (data ?? {}) as { deleted_messages?: number; deleted_sessions?: number };

  revalidatePath(`/sources/${batch.data_source_id}`);
  revalidatePath(`/sources/${batch.data_source_id}/data`);
  revalidatePath("/sources");
  return { messages: result.deleted_messages ?? 0, sessions: result.deleted_sessions ?? 0 };
}
