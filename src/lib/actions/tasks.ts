"use server";

import { revalidatePath } from "next/cache";
import { requireSourceAccess, requireTaskAccess, ActionError } from "./common";
import { execute, maybeOne, one } from "@/lib/db";
import { countScope, resolveScope } from "@/lib/engine/sampler";
import { configFromGraph, normalizeGraph } from "@/lib/workflow/graph";
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
  const { userId } = await requireSourceAccess(input.dataSourceId);

  const source = await maybeOne<{ id: string; name: string }>(
    `select id, name from data_sources where id = $1`,
    [input.dataSourceId],
  );
  if (!source) throw new ActionError("数据源不存在");

  // The template and workflow must belong to the source the caller just
  // cleared, so neither id can be used to pull in another member's row.
  if (input.workflowId) {
    const workflow = await maybeOne<{ id: string }>(
      `select id from workflows where id = $1 and data_source_id = $2`,
      [input.workflowId, input.dataSourceId],
    );
    if (!workflow) throw new ActionError("工作流不存在");
  }

  // Resolve which template to run with: explicit -> confirmed -> latest.
  type TemplateRef = { id: string; version: number; status: string };
  let template: TemplateRef | null = null;
  if (input.templateId) {
    template = await maybeOne<TemplateRef>(
      `select id, version, status from analysis_templates
       where id = $1 and data_source_id = $2`,
      [input.templateId, input.dataSourceId],
    );
    if (!template) throw new ActionError("模板不存在");
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

interface ScopeTotals extends JsonObject {
  sessions: number;
  users: number;
  turns: number;
  chars: number;
  audio_clips: number;
  audio_clips_sent: number;
  first_at: string | null;
  last_at: string | null;
}

export interface ScopeEstimate {
  mode: "incremental" | "range";
  /** Sessions this run would actually take. */
  sessions: number;
  /** Sessions the scope matches; anything past `sessions` waits for a later run. */
  matched: number;
  /** The workflow's session cap, 0 when it is off. */
  limit: number;
  users: number;
  turns: number;
  chars: number;
  audioClips: number;
  /** Clips that would reach the model — 0 while the session node has audio off. */
  audioClipsSent: number;
  useAudio: boolean;
  firstAt: string | null;
  lastAt: string | null;
  /** One call per session, one per user, plus the global and report passes. */
  modelCalls: number;
}

/**
 * What a task launched right now would chew through. It resolves the scope with
 * the same `resolveScope` the executor runs, under the config the worker would
 * load from this workflow, so the numbers are the run's own rather than a
 * second guess at them.
 */
export async function estimateTaskScope(input: {
  dataSourceId: string;
  workflowId: string | null;
  scopeType?: "incremental" | "range";
  rangeStart?: string | null;
  rangeEnd?: string | null;
}): Promise<ScopeEstimate> {
  await requireSourceAccess(input.dataSourceId);

  let config = configFromGraph(null);
  if (input.workflowId) {
    const wf = await maybeOne<{ graph: unknown }>(
      `select graph from workflows where id = $1 and data_source_id = $2`,
      [input.workflowId, input.dataSourceId],
    );
    if (!wf) throw new ActionError("工作流不存在");
    config = configFromGraph(normalizeGraph(wf.graph));
  }

  // Same precedence as the executor: the scope picked at launch wins, and the
  // workflow's own mode only decides when the task carries neither.
  const mode =
    input.scopeType === "range"
      ? "range"
      : input.scopeType === "incremental"
        ? "incremental"
        : config.scope.mode === "range"
          ? "range"
          : "incremental";
  const rangeStart = input.rangeStart ?? null;
  const rangeEnd = input.rangeEnd ?? null;
  if (mode === "range" && !rangeStart && !rangeEnd) {
    throw new ActionError("按时间范围分析时请至少设置一个时间边界");
  }

  const [scope, matched] = await Promise.all([
    resolveScope(input.dataSourceId, { mode, rangeStart, rangeEnd, limit: config.scope.maxSessions }),
    countScope(input.dataSourceId, { mode, rangeStart, rangeEnd }),
  ]);

  const empty: ScopeTotals = {
    sessions: 0,
    users: 0,
    turns: 0,
    chars: 0,
    audio_clips: 0,
    audio_clips_sent: 0,
    first_at: null,
    last_at: null,
  };
  const totals = scope.sessionIds.length
    ? await one<ScopeTotals>(
        `select count(*)::int                                     as sessions,
                count(distinct user_key)::int                     as users,
                coalesce(sum(turn_count), 0)::int                 as turns,
                coalesce(sum(char_count), 0)::float8              as chars,
                coalesce(sum(audio_count), 0)::int                as audio_clips,
                coalesce(sum(least(audio_count, $2::int)), 0)::int as audio_clips_sent,
                min(started_at)                                   as first_at,
                max(started_at)                                   as last_at
         from sessions
         where id = any($1::uuid[])`,
        [scope.sessionIds, Math.max(0, config.session.maxAudiosPerSession)],
      )
    : empty;

  return {
    mode,
    sessions: Number(totals.sessions),
    matched,
    limit: config.scope.maxSessions,
    users: Number(totals.users),
    turns: Number(totals.turns),
    chars: Number(totals.chars),
    audioClips: Number(totals.audio_clips),
    audioClipsSent: config.session.useAudio ? Number(totals.audio_clips_sent) : 0,
    useAudio: config.session.useAudio,
    firstAt: totals.first_at ? new Date(totals.first_at).toISOString() : null,
    lastAt: totals.last_at ? new Date(totals.last_at).toISOString() : null,
    modelCalls: Number(totals.sessions) + Number(totals.users) + (Number(totals.sessions) ? 2 : 0),
  };
}

export async function cancelTask(taskId: string): Promise<void> {
  await requireTaskAccess(taskId);
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
  const { session } = await requireTaskAccess(taskId);
  const userId = session.userId;

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
  await requireTaskAccess(taskId);
  try {
    // Logs, per-session/user results, the global result and reports cascade.
    await execute(`delete from analysis_tasks where id = $1`, [taskId]);
  } catch (err) {
    throw new ActionError(`删除失败：${(err as Error).message}`);
  }
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
}
