"use server";

import { revalidatePath } from "next/cache";
import { requireSession, ActionError } from "./common";
import { execute, maybeOne, one } from "@/lib/db";
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
  const { userId } = await requireSession();

  const source = await maybeOne<{ id: string; name: string }>(
    `select id, name from data_sources where id = $1`,
    [input.dataSourceId],
  );
  if (!source) throw new ActionError("数据源不存在");

  // Resolve which template to run with: explicit -> confirmed -> latest.
  type TemplateRef = { id: string; version: number; status: string };
  let template: TemplateRef | null = null;
  if (input.templateId) {
    template = await maybeOne<TemplateRef>(
      `select id, version, status from analysis_templates where id = $1`,
      [input.templateId],
    );
  }

  if (!template) {
    template = await maybeOne<TemplateRef>(
      `select id, version, status from analysis_templates
       where data_source_id = $1 and status = 'confirmed'
       order by version desc limit 1`,
      [input.dataSourceId],
    );
  }
  if (!template) {
    template = await maybeOne<TemplateRef>(
      `select id, version, status from analysis_templates
       where data_source_id = $1
       order by version desc limit 1`,
      [input.dataSourceId],
    );
  }
  if (!template) throw new ActionError("还没有可用的执行模板，请先在「分析工作台」完成规划与预览");

  const scopeType = input.scopeType === "range" ? "range" : "incremental";
  if (scopeType === "range" && !input.rangeStart && !input.rangeEnd) {
    throw new ActionError("按时间范围分析时请至少设置一个时间边界");
  }

  const name =
    input.name?.trim() ||
    `${source.name} · ${scopeType === "range" ? "时间范围" : "增量"}分析 ${new Date().toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-")}`;

  let created: { id: string };
  try {
    created = await one<{ id: string }>(
      `insert into analysis_tasks
         (data_source_id, template_id, workflow_id, name, scope_type, range_start, range_end,
          status, stage, config, progress, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'pending', 'queued', $8::jsonb, $9::jsonb, $10)
       returning id`,
      [
        input.dataSourceId,
        template.id,
        input.workflowId,
        name,
        scopeType,
        input.rangeStart ?? null,
        input.rangeEnd ?? null,
        JSON.stringify(input.config ?? {}),
        JSON.stringify({ stage: "queued", total: 0, done: 0 }),
        userId,
      ],
    );
  } catch (err) {
    throw new ActionError(`创建任务失败：${(err as Error).message}`);
  }

  revalidatePath("/tasks");
  revalidatePath(`/sources/${input.dataSourceId}`);
  revalidatePath("/dashboard");
  return { taskId: created.id };
}

export async function cancelTask(taskId: string): Promise<void> {
  await requireSession();
  try {
    // Only an in-flight task can be cancelled; a finished one is left alone.
    await execute(
      `update analysis_tasks
       set status = 'cancelled', error = '用户手动取消'
       where id = $1 and status in ('pending', 'running', 'aggregating', 'reporting')`,
      [taskId],
    );
  } catch (err) {
    throw new ActionError(`取消失败：${(err as Error).message}`);
  }
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/tasks");
}

export async function rerunTask(taskId: string): Promise<{ taskId: string }> {
  const { userId } = await requireSession();
  const exists = await maybeOne<{ id: string }>(`select id from analysis_tasks where id = $1`, [taskId]);
  if (!exists) throw new ActionError("任务不存在");

  try {
    // Copy the source task's scope and config in one statement so a rerun can
    // never drift from what it is rerunning.
    const created = await one<{ id: string }>(
      `insert into analysis_tasks
         (data_source_id, workflow_id, template_id, scope_type, range_start, range_end,
          config, name, status, stage, progress, stats, created_by)
       select data_source_id, workflow_id, template_id, scope_type, range_start, range_end,
              coalesce(config, '{}'::jsonb), name || '（重跑）', 'pending', 'queued',
              $2::jsonb, '{}'::jsonb, $3
       from analysis_tasks where id = $1
       returning id`,
      [taskId, JSON.stringify({ stage: "queued", total: 0, done: 0 }), userId],
    );
    revalidatePath("/tasks");
    return { taskId: created.id };
  } catch (err) {
    throw new ActionError(`重跑失败：${(err as Error).message}`);
  }
}

export async function deleteTask(taskId: string): Promise<void> {
  await requireSession();
  try {
    // Logs, per-session/user results, the global result and reports cascade.
    await execute(`delete from analysis_tasks where id = $1`, [taskId]);
  } catch (err) {
    throw new ActionError(`删除失败：${(err as Error).message}`);
  }
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
}
