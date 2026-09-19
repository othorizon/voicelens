"use server";

import { revalidatePath } from "next/cache";
import { requireSession, ActionError } from "./common";
import { configFromGraph, normalizeGraph, validateGraph, type WfGraph } from "@/lib/workflow/graph";
import type { JsonObject } from "@/lib/types";

export async function saveWorkflow(
  workflowId: string,
  graph: WfGraph,
  name?: string,
): Promise<{ config: ReturnType<typeof configFromGraph> }> {
  const { supabase } = await requireSession();
  const problems = validateGraph(graph);
  if (problems.length) throw new ActionError(`工作流配置不完整：${problems.join("；")}`);

  const config = configFromGraph(graph);
  const patch: JsonObject = {
    graph: graph as unknown as JsonObject,
    config: config as unknown as JsonObject,
  };
  if (name?.trim()) patch.name = name.trim();

  const { error } = await supabase.from("workflows").update(patch as never).eq("id", workflowId);
  if (error) throw new ActionError(`保存工作流失败：${error.message}`);
  revalidatePath("/workflows");
  return { config };
}

export async function resetWorkflow(workflowId: string): Promise<WfGraph> {
  const { supabase } = await requireSession();
  const graph = normalizeGraph(null);
  const { error } = await supabase
    .from("workflows")
    .update({ graph: graph as unknown as JsonObject, config: configFromGraph(graph) as unknown as JsonObject } as never)
    .eq("id", workflowId);
  if (error) throw new ActionError(`重置失败：${error.message}`);
  revalidatePath("/workflows");
  return graph;
}

export async function createWorkflow(dataSourceId: string, name: string): Promise<{ id: string }> {
  const { supabase, userId } = await requireSession();
  const graph = normalizeGraph(null);
  const { data, error } = await supabase
    .from("workflows")
    .insert({
      data_source_id: dataSourceId,
      name: name || "新建分析流",
      graph: graph as unknown as JsonObject,
      config: configFromGraph(graph) as unknown as JsonObject,
      created_by: userId,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new ActionError(`创建工作流失败：${error?.message ?? "unknown"}`);
  revalidatePath(`/sources/${dataSourceId}`);
  revalidatePath("/workflows");
  return { id: data.id as string };
}

export async function duplicateWorkflow(workflowId: string): Promise<{ id: string }> {
  const { supabase, userId } = await requireSession();
  const { data: src } = await supabase.from("workflows").select("*").eq("id", workflowId).maybeSingle();
  if (!src) throw new ActionError("工作流不存在");
  const { data, error } = await supabase
    .from("workflows")
    .insert({
      data_source_id: src.data_source_id,
      name: `${src.name}（副本）`,
      graph: src.graph as never,
      config: src.config as never,
      created_by: userId,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new ActionError(`复制失败：${error?.message ?? "unknown"}`);
  revalidatePath("/workflows");
  return { id: data.id as string };
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  const { supabase } = await requireSession();
  const { error } = await supabase.from("workflows").delete().eq("id", workflowId);
  if (error) throw new ActionError(`删除失败：${error.message}`);
  revalidatePath("/workflows");
}
