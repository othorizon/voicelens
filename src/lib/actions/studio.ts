"use server";

import { revalidatePath } from "next/cache";
import { requireSession, ActionError } from "./common";
import type { JsonObject } from "@/lib/types";

export interface PlanningParams {
  sessionSamples?: number;
  userSamples?: number;
  includeAudio?: boolean;
  focus?: string;
}

/** Create a v1 template by asking the model to plan prompts from real samples. */
export async function startPlanning(
  dataSourceId: string,
  workflowId: string | null,
  params: PlanningParams = {},
): Promise<{ jobId: string }> {
  const { supabase, userId } = await requireSession();
  const { data: source } = await supabase
    .from("data_sources")
    .select("id, name")
    .eq("id", dataSourceId)
    .maybeSingle();
  if (!source) throw new ActionError("数据源不存在");

  const { count } = await supabase
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .eq("data_source_id", dataSourceId);
  if (!count) throw new ActionError("该数据源还没有数据，请先导入 JSONL + 音频压缩包");

  const { data, error } = await supabase
    .from("planning_jobs")
    .insert({
      data_source_id: dataSourceId,
      workflow_id: workflowId,
      kind: "create",
      status: "pending",
      params: {
        sessionSamples: params.sessionSamples ?? 5,
        userSamples: params.userSamples ?? 4,
        includeAudio: params.includeAudio ?? true,
        focus: params.focus ?? "",
      } as unknown as JsonObject,
      created_by: userId,
    } as never)
    .select("id")
    .single();

  if (error || !data) throw new ActionError(`创建规划任务失败：${error?.message ?? "unknown"}`);
  revalidatePath(`/sources/${dataSourceId}/studio`);
  return { jobId: data.id as string };
}

/** Iterate: the user reviewed the preview and asked for changes. */
export async function startReplanning(
  parentTemplateId: string,
  feedback: string,
  params: PlanningParams = {},
): Promise<{ jobId: string }> {
  const { supabase, userId } = await requireSession();
  if (!feedback.trim()) throw new ActionError("请填写修改建议");

  const { data: parent } = await supabase
    .from("analysis_templates")
    .select("id, data_source_id, workflow_id")
    .eq("id", parentTemplateId)
    .maybeSingle();
  if (!parent) throw new ActionError("模板不存在");

  const { data, error } = await supabase
    .from("planning_jobs")
    .insert({
      data_source_id: parent.data_source_id,
      workflow_id: parent.workflow_id,
      kind: "revise",
      status: "pending",
      params: {
        sessionSamples: params.sessionSamples ?? 5,
        userSamples: params.userSamples ?? 4,
        includeAudio: params.includeAudio ?? true,
        focus: params.focus ?? "",
      } as unknown as JsonObject,
      feedback: feedback.trim(),
      parent_template_id: parentTemplateId,
      created_by: userId,
    } as never)
    .select("id")
    .single();

  if (error || !data) throw new ActionError(`创建规划任务失败：${error?.message ?? "unknown"}`);
  revalidatePath(`/sources/${parent.data_source_id}/studio`);
  return { jobId: data.id as string };
}

export async function confirmTemplate(templateId: string): Promise<void> {
  const { supabase } = await requireSession();
  const { data: tpl } = await supabase
    .from("analysis_templates")
    .select("id, data_source_id")
    .eq("id", templateId)
    .maybeSingle();
  if (!tpl) throw new ActionError("模板不存在");

  const { error: demote } = await supabase
    .from("analysis_templates")
    .update({ status: "archived" } as never)
    .eq("data_source_id", tpl.data_source_id)
    .eq("status", "confirmed");
  if (demote) throw new ActionError(`更新模板状态失败：${demote.message}`);

  const { error } = await supabase
    .from("analysis_templates")
    .update({ status: "confirmed" } as never)
    .eq("id", templateId);
  if (error) throw new ActionError(`确认模板失败：${error.message}`);

  revalidatePath(`/sources/${tpl.data_source_id}/studio`);
  revalidatePath(`/sources/${tpl.data_source_id}`);
}

export async function updateTemplatePrompt(
  templateId: string,
  patch: {
    session_prompt?: string;
    user_prompt?: string;
    global_prompt?: string;
    report_prompt?: string;
  },
): Promise<{ id: string; version: number }> {
  const { supabase, userId } = await requireSession();
  const { data: tpl } = await supabase
    .from("analysis_templates")
    .select("*")
    .eq("id", templateId)
    .maybeSingle();
  if (!tpl) throw new ActionError("模板不存在");

  const { data: last } = await supabase
    .from("analysis_templates")
    .select("version")
    .eq("data_source_id", tpl.data_source_id)
    .order("version", { ascending: false })
    .limit(1);
  const version = ((last?.[0]?.version as number) ?? 0) + 1;

  const { data: created, error } = await supabase
    .from("analysis_templates")
    .insert({
      data_source_id: tpl.data_source_id,
      workflow_id: tpl.workflow_id,
      version,
      status: "draft",
      session_prompt: patch.session_prompt ?? tpl.session_prompt,
      user_prompt: patch.user_prompt ?? tpl.user_prompt,
      global_prompt: patch.global_prompt ?? tpl.global_prompt,
      report_prompt: patch.report_prompt ?? tpl.report_prompt,
      metric_schema: tpl.metric_schema as never,
      business_desc: tpl.business_desc,
      extra_schema: tpl.extra_schema as never,
      samples: tpl.samples as never,
      rationale: `基于 v${tpl.version} 手工编辑生成`,
      parent_id: tpl.id,
      created_by: userId,
    } as never)
    .select("id, version")
    .single();

  if (error || !created) throw new ActionError(`保存失败：${error?.message ?? "unknown"}`);
  revalidatePath(`/sources/${tpl.data_source_id}/studio`);
  return { id: created.id as string, version: created.version as number };
}

export async function startPreview(
  templateId: string,
  params: { sessions?: number; useAudio?: boolean; concurrency?: number } = {},
): Promise<{ previewId: string }> {
  const { supabase, userId } = await requireSession();
  const { data: tpl } = await supabase
    .from("analysis_templates")
    .select("id, data_source_id")
    .eq("id", templateId)
    .maybeSingle();
  if (!tpl) throw new ActionError("模板不存在");

  const { data, error } = await supabase
    .from("template_previews")
    .insert({
      template_id: templateId,
      data_source_id: tpl.data_source_id,
      status: "pending",
      params: {
        sessions: params.sessions ?? 12,
        useAudio: params.useAudio ?? false,
        concurrency: params.concurrency ?? 3,
      } as unknown as JsonObject,
      progress: { stage: "queued", done: 0, total: params.sessions ?? 12 } as unknown as JsonObject,
      created_by: userId,
    } as never)
    .select("id")
    .single();

  if (error || !data) throw new ActionError(`创建预览失败：${error?.message ?? "unknown"}`);
  revalidatePath(`/sources/${tpl.data_source_id}/studio`);
  return { previewId: data.id as string };
}
