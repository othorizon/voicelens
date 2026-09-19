"use server";

import { revalidatePath } from "next/cache";
import { requireSession, ActionError } from "./common";
import { count, execute, maybeOne, one, tx } from "@/lib/db";

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
  const { userId } = await requireSession();
  const source = await maybeOne<{ id: string }>(`select id from data_sources where id = $1`, [
    dataSourceId,
  ]);
  if (!source) throw new ActionError("数据源不存在");

  const sessions = await count(`select count(*) from sessions where data_source_id = $1`, [
    dataSourceId,
  ]);
  if (!sessions) throw new ActionError("该数据源还没有数据，请先导入 JSONL + 音频压缩包");

  let created: { id: string };
  try {
    created = await one<{ id: string }>(
      `insert into planning_jobs (data_source_id, workflow_id, kind, status, params, created_by)
       values ($1, $2, 'create', 'pending', $3::jsonb, $4)
       returning id`,
      [
        dataSourceId,
        workflowId,
        JSON.stringify({
          sessionSamples: params.sessionSamples ?? 5,
          userSamples: params.userSamples ?? 4,
          includeAudio: params.includeAudio ?? true,
          focus: params.focus ?? "",
        }),
        userId,
      ],
    );
  } catch (err) {
    throw new ActionError(`创建规划任务失败：${(err as Error).message}`);
  }
  revalidatePath(`/sources/${dataSourceId}/studio`);
  return { jobId: created.id };
}

/** Iterate: the user reviewed the preview and asked for changes. */
export async function startReplanning(
  parentTemplateId: string,
  feedback: string,
  params: PlanningParams = {},
): Promise<{ jobId: string }> {
  const { userId } = await requireSession();
  if (!feedback.trim()) throw new ActionError("请填写修改建议");

  const parent = await maybeOne<{ data_source_id: string; workflow_id: string | null }>(
    `select data_source_id, workflow_id from analysis_templates where id = $1`,
    [parentTemplateId],
  );
  if (!parent) throw new ActionError("模板不存在");

  let created: { id: string };
  try {
    created = await one<{ id: string }>(
      `insert into planning_jobs
         (data_source_id, workflow_id, kind, status, params, feedback, parent_template_id, created_by)
       values ($1, $2, 'revise', 'pending', $3::jsonb, $4, $5, $6)
       returning id`,
      [
        parent.data_source_id,
        parent.workflow_id,
        JSON.stringify({
          sessionSamples: params.sessionSamples ?? 5,
          userSamples: params.userSamples ?? 4,
          includeAudio: params.includeAudio ?? true,
          focus: params.focus ?? "",
        }),
        feedback.trim(),
        parentTemplateId,
        userId,
      ],
    );
  } catch (err) {
    throw new ActionError(`创建规划任务失败：${(err as Error).message}`);
  }
  revalidatePath(`/sources/${parent.data_source_id}/studio`);
  return { jobId: created.id };
}

export async function confirmTemplate(templateId: string): Promise<void> {
  await requireSession();
  const tpl = await maybeOne<{ data_source_id: string }>(
    `select data_source_id from analysis_templates where id = $1`,
    [templateId],
  );
  if (!tpl) throw new ActionError("模板不存在");

  try {
    // Exactly one template per source may be `confirmed`, so archive the
    // incumbent and promote this one together.
    await tx(async (client) => {
      await execute(
        `update analysis_templates set status = 'archived'
         where data_source_id = $1 and status = 'confirmed'`,
        [tpl.data_source_id],
        client,
      );
      await execute(`update analysis_templates set status = 'confirmed' where id = $1`, [templateId], client);
    });
  } catch (err) {
    throw new ActionError(`确认模板失败：${(err as Error).message}`);
  }

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
  const { userId } = await requireSession();
  const tpl = await maybeOne<{ data_source_id: string; version: number }>(
    `select data_source_id, version from analysis_templates where id = $1`,
    [templateId],
  );
  if (!tpl) throw new ActionError("模板不存在");

  try {
    // Carry every unedited field over from the parent row, and take the next
    // version number in the same statement so two concurrent saves cannot pick
    // the same one (the unique index on (data_source_id, version) is the
    // backstop).
    const created = await one<{ id: string; version: number }>(
      `insert into analysis_templates
         (data_source_id, workflow_id, version, status, session_prompt, user_prompt,
          global_prompt, report_prompt, metric_schema, business_desc, extra_schema, samples,
          rationale, parent_id, created_by)
       select t.data_source_id, t.workflow_id,
              (select coalesce(max(version), 0) + 1 from analysis_templates
                where data_source_id = t.data_source_id),
              'draft',
              coalesce($2, t.session_prompt), coalesce($3, t.user_prompt),
              coalesce($4, t.global_prompt), coalesce($5, t.report_prompt),
              t.metric_schema, t.business_desc, t.extra_schema, t.samples,
              '基于 v' || t.version || ' 手工编辑生成', t.id, $6
       from analysis_templates t where t.id = $1
       returning id, version`,
      [
        templateId,
        patch.session_prompt ?? null,
        patch.user_prompt ?? null,
        patch.global_prompt ?? null,
        patch.report_prompt ?? null,
        userId,
      ],
    );
    revalidatePath(`/sources/${tpl.data_source_id}/studio`);
    return { id: created.id, version: created.version };
  } catch (err) {
    throw new ActionError(`保存失败：${(err as Error).message}`);
  }
}

export async function startPreview(
  templateId: string,
  params: { sessions?: number; useAudio?: boolean; concurrency?: number } = {},
): Promise<{ previewId: string }> {
  const { userId } = await requireSession();
  const tpl = await maybeOne<{ data_source_id: string }>(
    `select data_source_id from analysis_templates where id = $1`,
    [templateId],
  );
  if (!tpl) throw new ActionError("模板不存在");

  const sessions = params.sessions ?? 12;
  let created: { id: string };
  try {
    created = await one<{ id: string }>(
      `insert into template_previews
         (template_id, data_source_id, status, params, progress, created_by)
       values ($1, $2, 'pending', $3::jsonb, $4::jsonb, $5)
       returning id`,
      [
        templateId,
        tpl.data_source_id,
        JSON.stringify({
          sessions,
          useAudio: params.useAudio ?? false,
          concurrency: params.concurrency ?? 3,
        }),
        JSON.stringify({ stage: "queued", done: 0, total: sessions }),
        userId,
      ],
    );
  } catch (err) {
    throw new ActionError(`创建预览失败：${(err as Error).message}`);
  }
  revalidatePath(`/sources/${tpl.data_source_id}/studio`);
  return { previewId: created.id };
}
