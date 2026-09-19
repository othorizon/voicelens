"use server";

import { revalidatePath } from "next/cache";
import {
  requireSession,
  requireSourceAccess,
  requireBatchAccess,
  ActionError,
  fail,
} from "./common";
import { callJson, execute, one, scalar } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { defaultGraph } from "@/lib/workflow/graph";
import type { ExtraFieldDef } from "@/lib/types";

export interface DataSourceInput {
  name: string;
  description: string;
  extra_schema?: ExtraFieldDef[];
}

export async function createDataSource(input: DataSourceInput): Promise<{ id: string }> {
  const { userId } = await requireSession();
  const name = input.name?.trim();
  if (!name) throw new ActionError("请填写数据源名称");

  try {
    const created = await one<{ id: string }>(
      `insert into data_sources (name, description, extra_schema, created_by)
       values ($1, $2, $3::jsonb, $4)
       returning id`,
      [name, input.description?.trim() ?? "", JSON.stringify(input.extra_schema ?? []), userId],
    );

    const graph = defaultGraph();
    await execute(
      `insert into workflows (data_source_id, name, graph, config, is_active, created_by)
       values ($1, $2, $3::jsonb, '{}'::jsonb, true, $4)`,
      [created.id, `${name} · 默认分析流`, JSON.stringify(graph), userId],
    );

    revalidatePath("/sources");
    revalidatePath("/dashboard");
    return { id: created.id };
  } catch (err) {
    if (err instanceof ActionError) throw err;
    throw new ActionError(`创建数据源失败：${(err as Error).message}`);
  }
}

export async function updateDataSource(
  id: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  await requireSourceAccess(id);
  if (patch.name === undefined && patch.description === undefined) return;

  try {
    // coalesce leaves a column untouched when its parameter is null.
    await execute(
      `update data_sources
       set name = coalesce($2, name),
           description = coalesce($3, description),
           updated_at = now()
       where id = $1`,
      [id, patch.name?.trim() ?? null, patch.description ?? null],
    );
  } catch (err) {
    throw new ActionError(`保存失败：${(err as Error).message}`);
  }
  revalidatePath(`/sources/${id}`);
  revalidatePath("/sources");
  revalidatePath("/dashboard");
}

export async function saveExtraSchema(id: string, schema: ExtraFieldDef[]): Promise<void> {
  await requireSourceAccess(id);
  for (const f of schema) {
    if (!f.name?.trim()) throw new ActionError("存在未命名的 extra 字段");
  }
  const names = schema.map((f) => f.name);
  if (new Set(names).size !== names.length) throw new ActionError("extra 字段名不可重复");

  try {
    await execute(
      `update data_sources set extra_schema = $2::jsonb, updated_at = now() where id = $1`,
      [id, JSON.stringify(schema)],
    );
  } catch (err) {
    throw new ActionError(`保存 schema 失败：${(err as Error).message}`);
  }
  revalidatePath(`/sources/${id}`);
}

export async function inferSchemaFromData(id: string): Promise<ExtraFieldDef[]> {
  await requireSourceAccess(id);
  let data: { key: string; values: { name: string; value: number }[] }[] | null;
  try {
    data = await callJson<{ key: string; values: { name: string; value: number }[] }[]>(
      "extra_histogram",
      [id, 20],
    );
  } catch (err) {
    throw new ActionError(`读取字段分布失败：${(err as Error).message}`);
  }

  const rows = data ?? [];
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

// Private helper; every caller has already cleared `id` with requireSourceAccess.
async function getExtraSchema(id: string): Promise<ExtraFieldDef[]> {
  const schema = await scalar<ExtraFieldDef[]>(
    `select extra_schema from data_sources where id = $1`,
    [id],
  );
  return schema ?? [];
}

export async function deleteDataSource(id: string): Promise<void> {
  await requireSourceAccess(id);
  try {
    // Sessions, messages, workflows, templates and tasks cascade from here.
    await execute(`delete from data_sources where id = $1`, [id]);
  } catch (err) {
    throw new ActionError(`删除失败：${(err as Error).message}`);
  }
  revalidatePath("/sources");
  revalidatePath("/dashboard");
}

export async function deleteBatch(batchId: string): Promise<{ messages: number; sessions: number }> {
  const { dataSourceId } = await requireBatchAccess(batchId);

  // Read the staged archive's key before the row goes; a failed batch still
  // holds one, and nothing else would ever clean it up.
  const staged = await scalar<string | null>(
    `select source_object from import_batches where id = $1`,
    [batchId],
  );

  let result: { deleted_messages?: number; deleted_sessions?: number };
  try {
    result =
      (await callJson<{ deleted_messages?: number; deleted_sessions?: number }>(
        "delete_import_batch",
        [batchId],
      )) ?? {};
  } catch (err) {
    throw new ActionError(`删除批次失败：${(err as Error).message}`);
  }

  if (staged) await deleteObject(staged).catch(() => {});

  revalidatePath(`/sources/${dataSourceId}`);
  revalidatePath(`/sources/${dataSourceId}/data`);
  revalidatePath("/sources");
  return { messages: result.deleted_messages ?? 0, sessions: result.deleted_sessions ?? 0 };
}

/**
 * Re-queue a failed import against the archive it already uploaded.
 *
 * The failed batch may have written some of its rows before it died, and
 * message seq numbers are unique per session, so a plain re-run would collide.
 * `delete_import_batch` clears what it wrote (and the batch row), then the
 * same object is queued as a fresh batch — no re-upload.
 */
export async function retryBatch(batchId: string): Promise<{ batchId: string }> {
  const { dataSourceId } = await requireBatchAccess(batchId);

  const row = await one<{ status: string; source_object: string | null; file_name: string | null }>(
    `select status, source_object, file_name from import_batches where id = $1`,
    [batchId],
  );
  if (!row.source_object) fail("这个批次没有保留压缩包，无法重试，请重新上传");
  if (row.status === "pending" || row.status === "processing") fail("这个批次还在进行中");

  const { userId } = await requireSession();

  try {
    await callJson("delete_import_batch", [batchId]);
    const created = await one<{ id: string }>(
      `insert into import_batches
         (data_source_id, file_name, status, created_by, progress_detail, source_object, heartbeat_at)
       values ($1, $2, 'pending', $3, $4::jsonb, $5, now())
       returning id`,
      [
        dataSourceId,
        row.file_name,
        userId,
        JSON.stringify({ step: "queued" }),
        row.source_object,
      ],
    );

    revalidatePath(`/sources/${dataSourceId}`);
    revalidatePath(`/sources/${dataSourceId}/import`);
    return { batchId: created.id };
  } catch (err) {
    if (err instanceof ActionError) throw err;
    throw new ActionError(`重试导入失败：${(err as Error).message}`);
  }
}
