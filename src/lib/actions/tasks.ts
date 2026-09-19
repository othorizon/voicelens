"use server";

import { revalidatePath } from "next/cache";
import { requireSession, ActionError } from "./common";
import type { JsonObject } from "@/lib/types";

export interface CreateTaskInput {
  dataSourceId: string;
  workflowId: string | null;
  templateId?: string | null;
  name?: string;
  scopeType?: "incremental" | "range";
  rangeStart?: string | null;
  rangeEnd?: string | null;
  config?: JsonObject;
}

export async function createAnalysisTask(input: CreateTaskInput): Promise<{ taskId: string }> {
  const { supabase, userId } = await requireSession();

  const { data: source } = await supabase
    .from("data_sources")
    .select("id, name")
    .eq("id", input.dataSourceId)
    .maybeSingle();
  if (!source) throw new ActionError("数据源不存在");

  // Resolve which template to run with: explicit -> confirmed -> latest.
  type TemplateRef = { id: string; version: number; status: string };
  let template: TemplateRef | null = null;
  if (input.templateId) {
    const { data } = await supabase
      .from("analysis_templates")
      .select("id, version, status")
      .eq("id", input.templateId)
      .maybeSingle();
    template = (data as TemplateRef | null) ?? null;
  }

  if (!template) {
    const { data } = await supabase
      .from("analysis_templates")
      .select("id, version, status")
      .eq("data_source_id", input.dataSourceId)
      .eq("status", "confirmed")
      .order("version", { ascending: false })
      .limit(1);
    template = (data?.[0] as TemplateRef | undefined) ?? null;
    if (!template) {
      const { data: latest } = await supabase
        .from("analysis_templates")
        .select("id, version, status")
        .eq("data_source_id", input.dataSourceId)
        .order("version", { ascending: false })
        .limit(1);
      template = (latest?.[0] as TemplateRef | undefined) ?? null;
    }
  }
  if (!template) throw new ActionError("还没有可用的执行模板，请先在「分析工作台」完成规划与预览");

  const scopeType = input.scopeType === "range" ? "range" : "incremental";
  if (scopeType === "range" && !input.rangeStart && !input.rangeEnd) {
    throw new ActionError("按时间范围分析时请至少设置一个时间边界");
  }

  const name =
    input.name?.trim() ||
    `${source.name} · ${scopeType === "range" ? "时间范围" : "增量"}分析 ${new Date().toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-")}`;

  const { data, error } = await supabase
    .from("analysis_tasks")
    .insert({
      data_source_id: input.dataSourceId,
      template_id: template.id,
      workflow_id: input.workflowId,
      name,
      scope_type: scopeType,
      range_start: input.rangeStart ?? null,
      range_end: input.rangeEnd ?? null,
      status: "pending",
      stage: "queued",
      config: (input.config ?? {}) as JsonObject,
      progress: { stage: "queued", total: 0, done: 0 } as unknown as JsonObject,
      created_by: userId,
    } as never)
    .select("id")
    .single();

  if (error || !data) throw new ActionError(`创建任务失败：${error?.message ?? "unknown"}`);

  revalidatePath("/tasks");
  revalidatePath(`/sources/${input.dataSourceId}`);
  revalidatePath("/dashboard");
  return { taskId: data.id as string };
}

export async function cancelTask(taskId: string): Promise<void> {
  const { supabase } = await requireSession();
  const { error } = await supabase
    .from("analysis_tasks")
    .update({ status: "cancelled", error: "用户手动取消" } as never)
    .eq("id", taskId)
    .in("status", ["pending", "running", "aggregating", "reporting"]);
  if (error) throw new ActionError(`取消失败：${error.message}`);
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/tasks");
}

export async function rerunTask(taskId: string): Promise<{ taskId: string }> {
  const { supabase, userId } = await requireSession();
  const { data: src } = await supabase
    .from("analysis_tasks")
    .select("data_source_id, workflow_id, template_id, scope_type, range_start, range_end, config, name")
    .eq("id", taskId)
    .maybeSingle();
  if (!src) throw new ActionError("任务不存在");

  const { data, error } = await supabase
    .from("analysis_tasks")
    .insert({
      data_source_id: src.data_source_id,
      workflow_id: src.workflow_id,
      template_id: src.template_id,
      scope_type: src.scope_type,
      range_start: src.range_start,
      range_end: src.range_end,
      config: src.config ?? {},
      name: `${src.name}（重跑）`,
      status: "pending",
      stage: "queued",
      progress: { stage: "queued", total: 0, done: 0 },
      stats: {},
      created_by: userId,
    } as never)
    .select("id")
    .single();

  if (error || !data) throw new ActionError(`重跑失败：${error?.message ?? "unknown"}`);
  revalidatePath("/tasks");
  return { taskId: data.id as string };
}

export async function deleteTask(taskId: string): Promise<void> {
  const { supabase } = await requireSession();
  const { error } = await supabase.from("analysis_tasks").delete().eq("id", taskId);
  if (error) throw new ActionError(`删除失败：${error.message}`);
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
}
