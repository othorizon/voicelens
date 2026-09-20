"use server";

import { revalidatePath } from "next/cache";
import { requireSourceAccess, requireWorkflowAccess, ActionError } from "./common";
import { execute, one } from "@/lib/db";
import { configFromGraph, normalizeGraph, validateGraph, type WfGraph } from "@/lib/workflow/graph";

export async function saveWorkflow(
  workflowId: string,
  graph: WfGraph,
  name?: string,
): Promise<{ config: ReturnType<typeof configFromGraph> }> {
  await requireWorkflowAccess(workflowId);
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

/**
 * Patch one node's params in place.
 *
 * The analysis workbench shows the same switches the canvas does (听音频、样本
 * 数…). Before this they were local component state seeded with hardcoded
 * defaults, so the two pages could disagree about the same setting and the
 * workbench silently won for the run it started. Now the workbench reads the
 * graph and writes its choice back here, which keeps the canvas the single
 * source of truth.
 *
 * Deliberately no `validateGraph`: this only ever changes parameter values, it
 * cannot break the topology, and refusing to save a switch because some other
 * node is half-wired would be its own trap.
 */
export async function updateNodeParams(
  workflowId: string,
  kind: string,
  params: Record<string, unknown>,
): Promise<void> {
  const { dataSourceId } = await requireWorkflowAccess(workflowId);

  const stored = await one<{ graph: unknown }>(`select graph from workflows where id = $1`, [
    workflowId,
  ]);
  const graph = normalizeGraph(stored.graph);
  const node = graph.nodes.find((n) => n.data.kind === kind);
  if (!node) return; // a graph without this node has nothing to keep in sync

  node.data.params = { ...(node.data.params ?? {}), ...params };

  try {
    await execute(
      `update workflows set graph = $2::jsonb, config = $3::jsonb, updated_at = now() where id = $1`,
      [workflowId, JSON.stringify(graph), JSON.stringify(configFromGraph(graph))],
    );
  } catch (err) {
    throw new ActionError(`保存参数失败：${(err as Error).message}`);
  }
  revalidatePath(`/sources/${dataSourceId}/workflow`);
}

export async function resetWorkflow(workflowId: string): Promise<WfGraph> {
  await requireWorkflowAccess(workflowId);
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
  const { userId } = await requireSourceAccess(dataSourceId);
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
  const { session } = await requireWorkflowAccess(workflowId);
  const userId = session.userId;
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
  await requireWorkflowAccess(workflowId);
  try {
    await execute(`delete from workflows where id = $1`, [workflowId]);
  } catch (err) {
    throw new ActionError(`删除失败：${(err as Error).message}`);
  }
  revalidatePath("/workflows");
}
