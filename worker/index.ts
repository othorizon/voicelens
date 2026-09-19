/**
 * Background analysis worker.
 *
 * Polls Supabase for three kinds of jobs and runs them out-of-band so the web
 * app never holds a long HTTP request:
 *   1. planning_jobs      -> AI 规划，产出 analysis_templates 新版本
 *   2. template_previews  -> 基于模板 + 抽样数据生成预览报告
 *   3. analysis_tasks     -> 全量三层分析与报告输出
 */
import "dotenv/config";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "../src/lib/engine/supabase-service";
import { planTemplate, buildPreview, fallbackTemplate, type DataSourceLike } from "../src/lib/engine/plan";
import { runTask, log } from "../src/lib/engine/executor";
import { configFromGraph, normalizeGraph } from "../src/lib/workflow/graph";
import type { WorkflowConfig } from "../src/lib/workflow/definition";
import type { ExtraFieldDef, JsonObject } from "../src/lib/types";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2500);

let stopping = false;
const active = new Set<string>();

async function client(): Promise<SupabaseClient> {
  return getServiceClient();
}

/** Atomic claim: only succeeds when the row is still in the expected state. */
async function claim<T extends { id: string }>(
  supabase: SupabaseClient,
  table: string,
  patch: JsonObject,
  from = "pending",
): Promise<T | null> {
  const { data } = await supabase
    .from(table)
    .select("*")
    .eq("status", from)
    .order("created_at", { ascending: true })
    .limit(4);

  for (const row of ((data ?? []) as T[]).filter((r) => !active.has(r.id))) {
    const { data: claimed, error } = await supabase
      .from(table)
      .update({ ...patch, status: "running" } as never)
      .eq("id", row.id)
      .eq("status", from)
      .select("*");
    if (!error && claimed?.length) return claimed[0] as T;
  }
  return null;
}

async function loadSource(supabase: SupabaseClient, id: string): Promise<DataSourceLike | null> {
  const { data } = await supabase
    .from("data_sources")
    .select("id, name, description, extra_schema")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    name: data.name as string,
    description: (data.description as string) ?? "",
    extra_schema: (data.extra_schema as ExtraFieldDef[]) ?? [],
  };
}

async function loadConfig(supabase: SupabaseClient, workflowId: string | null): Promise<WorkflowConfig> {
  if (!workflowId) return configFromGraph(null);
  const { data } = await supabase.from("workflows").select("graph").eq("id", workflowId).maybeSingle();
  return configFromGraph(normalizeGraph(data?.graph as unknown) as never);
}

async function nextVersion(supabase: SupabaseClient, dataSourceId: string): Promise<number> {
  const { data } = await supabase
    .from("analysis_templates")
    .select("version")
    .eq("data_source_id", dataSourceId)
    .order("version", { ascending: false })
    .limit(1);
  return ((data?.[0]?.version as number) ?? 0) + 1;
}

/* ------------------------------------------------------------ planning */

interface PlanningJob extends JsonObject {
  id: string;
  data_source_id: string;
  workflow_id: string | null;
  kind: string;
  params: JsonObject;
  feedback: string;
  parent_template_id: string | null;
  created_by: string | null;
}

async function handlePlanning(job: PlanningJob) {
  const supabase = await client();
  const source = await loadSource(supabase, job.data_source_id);
  if (!source) throw new Error("数据源不存在");

  const params = (job.params ?? {}) as Record<string, unknown>;
  const includeAudio = params.includeAudio !== false;
  const focus = String(params.focus ?? "");

  let previous = null;
  if (job.parent_template_id) {
    const { data } = await supabase
      .from("analysis_templates")
      .select("session_prompt, user_prompt, global_prompt, report_prompt, rationale")
      .eq("id", job.parent_template_id)
      .maybeSingle();
    previous = (data as never) ?? null;
  }

  await supabase
    .from("planning_jobs")
    .update({ progress: { step: "sampling" } as never })
    .eq("id", job.id);

  let plan;
  try {
    plan = await planTemplate({
      supabase,
      dataSource: source,
      sessionSamples: Number(params.sessionSamples ?? 5),
      userSamples: Number(params.userSamples ?? 4),
      includeAudio,
      focus,
      feedback: job.feedback || undefined,
      previous,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (previous) throw e;
    const fb = fallbackTemplate(source, describeExtra(source.extra_schema));
    plan = { ...fb, rationale: `模型规划失败（${message.slice(0, 160)}），已使用兜底模板，可重新规划。` };
  }

  const version = await nextVersion(supabase, source.id);
  const { data: tpl, error } = await supabase
    .from("analysis_templates")
    .insert({
      data_source_id: source.id,
      workflow_id: job.workflow_id,
      version,
      status: "draft",
      session_prompt: plan.session_prompt,
      user_prompt: plan.user_prompt,
      global_prompt: plan.global_prompt,
      report_prompt: plan.report_prompt,
      metric_schema: plan.metric_schema as never,
      business_desc: source.description,
      extra_schema: source.extra_schema as never,
      samples: plan.samples as never,
      rationale: `${plan.rationale}\n\n识别到的业务：${plan.detected_business}`,
      feedback: job.feedback || "",
      parent_id: job.parent_template_id,
      created_by: job.created_by,
    } as never)
    .select("id, version")
    .single();

  if (error || !tpl) throw new Error(`保存模板失败: ${error?.message ?? "unknown"}`);

  await supabase
    .from("planning_jobs")
    .update({
      status: "completed",
      template_id: tpl.id as string,
      finished_at: new Date().toISOString(),
      progress: { step: "done", version: tpl.version } as never,
    })
    .eq("id", job.id);
}

function describeExtra(schema: ExtraFieldDef[]): string {
  if (!schema?.length) return "（未定义 extra schema）";
  return schema.map((f) => `- ${f.name}（${f.label}）类型=${f.kind} 用途=${f.usage}`).join("\n");
}

/* ------------------------------------------------------------- preview */

interface PreviewJob extends JsonObject {
  id: string;
  template_id: string;
  data_source_id: string;
  params: JsonObject;
  created_by: string | null;
}

async function handlePreview(job: PreviewJob) {
  const supabase = await client();
  const { data: tpl } = await supabase
    .from("analysis_templates")
    .select("*")
    .eq("id", job.template_id)
    .maybeSingle();
  const source = await loadSource(supabase, job.data_source_id);
  if (!tpl || !source) throw new Error("模板或数据源不存在");

  const params = (job.params ?? {}) as Record<string, unknown>;

  const out = await buildPreview({
    supabase,
    dataSource: source,
    template: {
      session_prompt: tpl.session_prompt as string,
      user_prompt: tpl.user_prompt as string,
      global_prompt: tpl.global_prompt as string,
      report_prompt: tpl.report_prompt as string,
    },
    sessions: Number(params.sessions ?? 12),
    useAudio: params.useAudio === true,
    concurrency: Number(params.concurrency ?? 3),
    onProgress: async (p) => {
      await supabase.from("template_previews").update({ progress: p as never }).eq("id", job.id);
    },
  });

  await supabase
    .from("template_previews")
    .update({
      status: "completed",
      session_results: out.sessionResults as never,
      user_results: out.userResults as never,
      global_result: out.globalResult as never,
      report: out.spec as never,
      html: out.html,
      stats: out.stats as never,
      finished_at: new Date().toISOString(),
      progress: { stage: "done", done: 1, total: 1 } as never,
    })
    .eq("id", job.id);
}

/* --------------------------------------------------------------- tasks */

interface TaskRow extends JsonObject {
  id: string;
  name: string;
  data_source_id: string;
  template_id: string | null;
  workflow_id: string | null;
  scope_type: string;
  range_start: string | null;
  range_end: string | null;
  config: JsonObject;
}

async function handleTask(job: TaskRow) {
  const supabase = await client();
  const source = await loadSource(supabase, job.data_source_id);
  if (!source) throw new Error("数据源不存在");

  const config = await loadConfig(supabase, job.workflow_id);
  const overrides = (job.config ?? {}) as Partial<{ scope: unknown; session: unknown; report: unknown }>;
  const merged = { ...config, ...(overrides as object) } as WorkflowConfig;

  const { data: tpl } = await supabase
    .from("analysis_templates")
    .select("version, session_prompt, user_prompt, global_prompt, report_prompt, status")
    .eq("id", job.template_id ?? "")
    .maybeSingle();

  if (!tpl) throw new Error("分析任务缺少可用的执行模板，请先在「分析工作台」完成规划");

  await runTask(
    supabase,
    {
      id: job.id,
      name: job.name as string,
      data_source_id: job.data_source_id,
      scope_type: job.scope_type as string,
      range_start: job.range_start as string | null,
      range_end: job.range_end as string | null,
      config: (job.config ?? {}) as JsonObject,
      template: tpl as never,
      dataSource: source,
      createdBy: job.created_by as string | null,
    },
    merged,
  );
}

/* ---------------------------------------------------------------- loop */

async function tick() {
  const supabase = await client();

  const planning = await claim<PlanningJob>(supabase, "planning_jobs", { started_at: new Date().toISOString() });
  if (planning) {
    active.add(planning.id);
    run("planning", planning.id, () => handlePlanning(planning), async (err) => {
      await supabase
        .from("planning_jobs")
        .update({ status: "failed", error: err.slice(0, 1500), finished_at: new Date().toISOString() })
        .eq("id", planning.id);
    });
  }

  const preview = await claim<PreviewJob>(supabase, "template_previews", {
    progress: { step: "claimed" } as never,
  });
  if (preview) {
    active.add(preview.id);
    run("preview", preview.id, () => handlePreview(preview), async (err) => {
      await supabase
        .from("template_previews")
        .update({ status: "failed", error: err.slice(0, 1500), finished_at: new Date().toISOString() })
        .eq("id", preview.id);
    });
  }

  const task = await claim<TaskRow>(supabase, "analysis_tasks", { started_at: new Date().toISOString() });
  if (task) {
    active.add(task.id);
    run("task", task.id, () => handleTask(task), async (err) => {
      await supabase
        .from("analysis_tasks")
        .update({ status: "failed", error: err.slice(0, 1500), finished_at: new Date().toISOString() })
        .eq("id", task.id);
      await log(supabase, task.id, "error", null, `任务失败: ${err.slice(0, 600)}`);
    });
  }
}

async function run(kind: string, id: string, fn: () => Promise<void>, onError: (msg: string) => Promise<void>) {
  console.log(`[worker] ${kind} ${id} start`);
  try {
    await fn();
    console.log(`[worker] ${kind} ${id} done`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[worker] ${kind} ${id} failed:`, msg);
    try {
      await onError(msg);
    } catch {
      /* ignore secondary failure */
    }
  } finally {
    active.delete(id);
  }
}

async function main() {
  // Fail fast if credentials are wrong, with a clear message.
  const supabase = await client();
  const { data } = await supabase.from("data_sources").select("id").limit(1);
  console.log(
    `[worker] connected · model=${process.env.AI_MODEL ?? "qwen3.8-omni-flash"} · poll=${POLL_MS}ms · probe=${Array.isArray(data) ? "ok" : "n/a"}`,
  );

  await recoverStaleJobs(supabase);

  const shutdown = () => {
    stopping = true;
    console.log("[worker] stopping…");
    setTimeout(() => process.exit(0), 400);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopping) {
    try {
      await tick();
    } catch (e) {
      console.error("[worker] tick error:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * A worker restart orphans anything it had claimed. Anything still marked
 * running at boot could not have a live owner, so put it back in the queue.
 */
async function recoverStaleJobs(supabase: SupabaseClient) {
  const now = new Date().toISOString();
  const [t, p, v] = await Promise.all([
    supabase
      .from("analysis_tasks")
      .update({ status: "pending", stage: "queued", started_at: null, heartbeat_at: now } as never)
      .eq("status", "running"),
    supabase.from("planning_jobs").update({ status: "pending", started_at: null } as never).eq("status", "running"),
    supabase.from("template_previews").update({ status: "pending", progress: { step: "requeued" } as never } as never).eq("status", "running"),
  ]);
  const count = [t.error, p.error, v.error].filter(Boolean).length ? null : "ok";
  console.log(`[worker] recovered orphaned jobs: ${count ?? "partial (see errors)"}`);
}

void main();
