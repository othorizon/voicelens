"use server";

import { revalidatePath } from "next/cache";
import { requireSession, ActionError } from "./common";
import { execute, maybeOne, one } from "@/lib/db";
import { configFromGraph, normalizeGraph, validateGraph, type WfGraph } from "@/lib/workflow/graph";

export async function saveWorkflow(
  workflowId: string,
  graph: WfGraph,
  name?: string,
): Promise<{ config: ReturnType<typeof configFromGraph> }> {
  await requireSession();
  const problems = validateGraph(graph);
  if (problems.length) throw new ActionError(`工作流配置不完整：${problems.join("；")}`);

  const config = configFromGraph(graph);
  try {
    await execute(
      `update workflows
       set graph = $2::jsonb, config = $3::jsonb, name = coalesce($4, name), updated_at = now()
       where id = $1`,
      [workflowId, JSON.stringify(graph), JSON.stringify(config), name?.trim() || null],
    );
  } catch (err) {
    throw new ActionError(`保存工作流失败：${(err as Error).message}`);
  }
  revalidatePath("/workflows");
  return { config };
}

export async function resetWorkflow(workflowId: string): Promise<WfGraph> {
  await requireSession();
  const graph = normalizeGraph(null);
  try {
    await execute(
      `update workflows set graph = $2::jsonb, config = $3::jsonb, updated_at = now() where id = $1`,
      [workflowId, JSON.stringify(graph), JSON.stringify(configFromGraph(graph))],
    );
  } catch (err) {
    throw new ActionError(`重置失败：${(err as Error).message}`);
  }
  revalidatePath("/workflows");
  return graph;
}

export async function createWorkflow(dataSourceId: string, name: string): Promise<{ id: string }> {
  const { userId } = await requireSession();
  const graph = normalizeGraph(null);
  let created: { id: string };
  try {
    created = await one<{ id: string }>(
      `insert into workflows (data_source_id, name, graph, config, created_by)
       values ($1, $2, $3::jsonb, $4::jsonb, $5)
       returning id`,
      [dataSourceId, name || "新建分析流", JSON.stringify(graph), JSON.stringify(configFromGraph(graph)), userId],
    );
  } catch (err) {
    throw new ActionError(`创建工作流失败：${(err as Error).message}`);
  }
  revalidatePath(`/sources/${dataSourceId}`);
  revalidatePath("/workflows");
  return { id: created.id };
}

export async function duplicateWorkflow(workflowId: string): Promise<{ id: string }> {
  const { userId } = await requireSession();
  const src = await maybeOne<{ id: string }>(`select id from workflows where id = $1`, [workflowId]);
  if (!src) throw new ActionError("工作流不存在");
  let created: { id: string };
  try {
    created = await one<{ id: string }>(
      `insert into workflows (data_source_id, name, graph, config, created_by)
       select data_source_id, name || '（副本）', graph, config, $2
       from workflows where id = $1
       returning id`,
      [workflowId, userId],
    );
  } catch (err) {
    throw new ActionError(`复制失败：${(err as Error).message}`);
  }
  revalidatePath("/workflows");
  return { id: created.id };
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  await requireSession();
  try {
    await execute(`delete from workflows where id = $1`, [workflowId]);
  } catch (err) {
    throw new ActionError(`删除失败：${(err as Error).message}`);
  }
  revalidatePath("/workflows");
}
