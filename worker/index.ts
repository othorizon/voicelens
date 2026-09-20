/**
 * Background worker.
 *
 * Polls Postgres for four kinds of jobs and runs them out-of-band so the web
 * app never holds a long HTTP request:
 *   1. import_batches     -> 解压对象存储里的压缩包并入库
 *   2. planning_jobs      -> AI 规划（create/revise）或按建议改配置（refine），
 *                            两者都产出 analysis_templates 的新版本
 *   3. template_previews  -> 基于模板 + 抽样数据生成预览报告
 *   4. analysis_tasks     -> 全量三层分析与报告输出
 *
 * It connects to the database directly with the same credentials as the web
 * app, so there is no service account to provision.
 */
import "dotenv/config";
import { closePool, execute, maybeOne, one, query, scalar } from "../src/lib/db";
import {
  planTemplate,
  buildPreview,
  fallbackTemplate,
  refinePlan,
  PROMPT_LABEL,
  type DataSourceLike,
  type TemplateConfig,
} from "../src/lib/engine/plan";
import { runTask, log } from "../src/lib/engine/executor";
import { importZip } from "../src/lib/engine/import";
import { configFromGraph, normalizeGraph } from "../src/lib/workflow/graph";
import type { WorkflowConfig } from "../src/lib/workflow/definition";
import { resolveRuntime } from "../src/lib/models/registry";
import { MODE_LABEL } from "../src/lib/models/mode";
import type { ExtraFieldDef, JsonObject } from "../src/lib/types";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2500);

let stopping = false;
const active = new Set<string>();

/**
 * Atomic claim: `for update skip locked` hands the row to exactly one worker,
 * so several workers can share a queue without claiming the same job.
 */
async function claim<T extends { id: string }>(
  table: string,
  setClause: string,
  params: unknown[] = [],
  from = "pending",
  to = "running",
  where = "",
): Promise<T | null> {
  const rows = await query<T>(
    `update ${table}
     set status = '${to}'${setClause ? `, ${setClause}` : ""}
     where id = (
       select id from ${table}
       where status = $1${where ? ` and ${where}` : ""}
       order by created_at
       for update skip locked
       limit 1
     )
     returning *`,
    [from, ...params],
  );
  return rows[0] ?? null;
}

async function loadSource(id: string): Promise<DataSourceLike | null> {
  const row = await maybeOne<{
    id: string;
    name: string;
    description: string | null;
    extra_schema: ExtraFieldDef[] | null;
  }>(`select id, name, description, extra_schema from data_sources where id = $1`, [id]);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    extra_schema: row.extra_schema ?? [],
  };
}

async function loadConfig(workflowId: string | null): Promise<WorkflowConfig> {
  if (!workflowId) return configFromGraph(null);
  const graph = await scalar<unknown>(`select graph from workflows where id = $1`, [workflowId]);
  return configFromGraph(normalizeGraph(graph) as never);
}

/* --------------------------------------------------------------- import */

interface ImportBatch extends JsonObject {
  id: string;
  data_source_id: string;
  file_name: string | null;
  source_object: string | null;
  created_by: string | null;
}

/**
 * A 'processing' batch is only abandoned once its heartbeat has gone quiet —
 * a live import bumps it every few seconds. Checking the heartbeat rather
 * than "was running when I booted" is what lets several Workers share the
 * queue without one declaring another's in-flight import dead.
 */
const IMPORT_STALE_AFTER = "5 minutes";

async function claimImport(): Promise<ImportBatch | null> {
  return claim<ImportBatch>(
    "import_batches",
    "heartbeat_at = now(), progress_detail = $2::jsonb",
    [JSON.stringify({ step: "claimed" })],
    "pending",
    "processing",
    // A batch with no object is one the web process is running itself (the
    // e2e script); the Worker has nothing to read.
    "source_object is not null",
  );
}

async function handleImport(batch: ImportBatch) {
  if (!batch.source_object) throw new Error("批次没有记录对象存储路径");
  const result = await importZip(
    batch.data_source_id,
    { kind: "object", path: batch.source_object },
    batch.file_name ?? "upload.zip",
    batch.created_by,
    (m, extra) => console.log(`[worker] import ${batch.id}: ${m}`, extra ?? ""),
    batch.id,
  );
  console.log(
    `[worker] import ${batch.id}: ${result.sessions} 会话 / ${result.messages} 消息 / ${result.audios} 音频`,
  );
}

/**
 * Fail the imports whose Worker died mid-unpack. Re-running one is not safe —
 * the batch has already written some of its rows, and message seq numbers are
 * unique per session — so the batch is marked failed with its archive left in
 * the bucket, and the import page offers a retry that clears the half-written
 * rows first.
 */
async function sweepStaleImports() {
  const n = await execute(
    `update import_batches
     set status = 'failed',
         error = 'Worker 在导入过程中中断。压缩包仍保留在对象存储中，可在导入页点「重试」继续。',
         finished_at = now()
     where status = 'processing'
       and source_object is not null
       and heartbeat_at < now() - interval '${IMPORT_STALE_AFTER}'`,
  );
  if (n) console.log(`[worker] marked ${n} stalled import(s) as failed`);
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
  // Two ways into this queue: plan the template again from freshly sampled
  // data, or edit the one that is already there. They share the row and the
  // claim, and nothing below applies to the second.
  if (job.kind === "refine") return handleRefine(job);

  const source = await loadSource(job.data_source_id);
  if (!source) throw new Error("数据源不存在");

  // The models and mode this source is configured with. Resolved per job, so a
  // change in the settings page takes effect on the next job rather than on the
  // next Worker restart.
  const runtime = await resolveRuntime(job.data_source_id);
  const params = (job.params ?? {}) as Record<string, unknown>;
  const includeAudio = params.includeAudio !== false;
  const focus = String(params.focus ?? "");

  let previous = null;
  if (job.parent_template_id) {
    previous =
      (await maybeOne<JsonObject>(
        `select session_prompt, user_prompt, global_prompt, report_prompt, rationale
         from analysis_templates where id = $1`,
        [job.parent_template_id],
      )) ?? null;
  }

  await execute(`update planning_jobs set progress = $2::jsonb where id = $1`, [
    job.id,
    JSON.stringify({ step: "sampling" }),
  ]);

  let plan;
  try {
    plan = await planTemplate({
      dataSource: source,
      runtime,
      sessionSamples: Number(params.sessionSamples ?? 5),
      userSamples: Number(params.userSamples ?? 4),
      includeAudio,
      focus,
      feedback: job.feedback || undefined,
      previous: previous as never,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (previous) throw e;
    const fb = fallbackTemplate(source, describeExtra(source.extra_schema as ExtraFieldDef[]));
    plan = { ...fb, rationale: `模型规划失败（${message.slice(0, 160)}），已使用兜底模板，可重新规划。` };
  }

  let tpl: { id: string; version: number };
  try {
    // The version is taken inside the insert, so a concurrent planning job
    // cannot pick the same number.
    tpl = await one<{ id: string; version: number }>(
      `insert into analysis_templates
         (data_source_id, workflow_id, version, status, session_prompt, user_prompt,
          global_prompt, report_prompt, metric_schema, business_desc, extra_schema, samples,
          rationale, feedback, parent_id, created_by)
       values ($1, $2,
               (select coalesce(max(version), 0) + 1 from analysis_templates where data_source_id = $1),
               'draft', $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14)
       returning id, version`,
      [
        source.id,
        job.workflow_id,
        plan.session_prompt,
        plan.user_prompt,
        plan.global_prompt,
        plan.report_prompt,
        JSON.stringify(plan.metric_schema ?? {}),
        source.description,
        JSON.stringify(source.extra_schema ?? []),
        JSON.stringify(plan.samples ?? {}),
        `${plan.rationale}\n\n识别到的业务：${plan.detected_business}`,
        job.feedback || "",
        job.parent_template_id,
        job.created_by,
      ],
    );
  } catch (err) {
    throw new Error(`保存模板失败: ${(err as Error).message}`);
  }

  await execute(
    `update planning_jobs
     set status = 'completed', template_id = $2, finished_at = now(), progress = $3::jsonb
     where id = $1`,
    [job.id, tpl.id, JSON.stringify({ step: "done", version: tpl.version })],
  );
}

/**
 * `kind = 'refine'`: carry the feedback into the parent template's prompts and
 * save the result as the next version. No sampling, no audio, no full rewrite —
 * one text call against prompts we already have.
 *
 * Everything the parent recorded about the data it was planned from
 * (business_desc, extra_schema, the sampling snapshot) is carried over as-is,
 * because this run did not look at the data and has nothing newer to say about
 * it.
 */
async function handleRefine(job: PlanningJob) {
  if (!job.parent_template_id) throw new Error("按建议修改配置缺少来源模板");

  const source = await loadSource(job.data_source_id);
  if (!source) throw new Error("数据源不存在");

  const parent = await maybeOne<TemplateConfig>(
    `select version, session_prompt, user_prompt, global_prompt, report_prompt,
            metric_schema, rationale
     from analysis_templates where id = $1`,
    [job.parent_template_id],
  );
  if (!parent) throw new Error("来源模板不存在");
  if (!job.feedback?.trim()) throw new Error("按建议修改配置缺少修改建议");

  const runtime = await resolveRuntime(job.data_source_id);

  await execute(`update planning_jobs set progress = $2::jsonb where id = $1`, [
    job.id,
    JSON.stringify({ step: "refining" }),
  ]);

  const out = await refinePlan({
    dataSource: source,
    runtime,
    feedback: job.feedback,
    previous: parent,
  });

  const touched = out.changed.map((k) => PROMPT_LABEL[k]).join("、");
  const rationale = [
    `基于 v${parent.version} 按修改建议直接修改配置（未重新抽样、未重新试听音频）。`,
    `改动范围：${touched}提示词。`,
    out.change_note ? `\n\n${out.change_note}` : "",
  ].join("");

  let tpl: { id: string; version: number };
  try {
    tpl = await one<{ id: string; version: number }>(
      `insert into analysis_templates
         (data_source_id, workflow_id, version, status, session_prompt, user_prompt,
          global_prompt, report_prompt, metric_schema, business_desc, extra_schema, samples,
          rationale, feedback, parent_id, created_by)
       select t.data_source_id, coalesce($2::uuid, t.workflow_id),
              (select coalesce(max(version), 0) + 1 from analysis_templates
                where data_source_id = t.data_source_id),
              'draft', $3, $4, $5, $6, $7::jsonb,
              t.business_desc, t.extra_schema, t.samples,
              $8, $9, t.id, $10
       from analysis_templates t where t.id = $1
       returning id, version`,
      [
        job.parent_template_id,
        job.workflow_id,
        out.session_prompt,
        out.user_prompt,
        out.global_prompt,
        out.report_prompt,
        JSON.stringify(out.metric_schema ?? {}),
        rationale,
        job.feedback,
        job.created_by,
      ],
    );
  } catch (err) {
    throw new Error(`保存模板失败: ${(err as Error).message}`);
  }

  await execute(
    `update planning_jobs
     set status = 'completed', template_id = $2, finished_at = now(), progress = $3::jsonb
     where id = $1`,
    [job.id, tpl.id, JSON.stringify({ step: "done", version: tpl.version, changed: out.changed })],
  );
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
  const tpl = await maybeOne<{
    session_prompt: string;
    user_prompt: string;
    global_prompt: string;
    report_prompt: string;
  }>(
    `select session_prompt, user_prompt, global_prompt, report_prompt
     from analysis_templates where id = $1`,
    [job.template_id],
  );
  const source = await loadSource(job.data_source_id);
  if (!tpl || !source) throw new Error("模板或数据源不存在");

  const params = (job.params ?? {}) as Record<string, unknown>;

  const out = await buildPreview({
    dataSource: source,
    runtime: await resolveRuntime(job.data_source_id),
    template: tpl,
    sessions: Number(params.sessions ?? 12),
    useAudio: params.useAudio === true,
    concurrency: Number(params.concurrency ?? 3),
    onProgress: async (p) => {
      await execute(`update template_previews set progress = $2::jsonb where id = $1`, [
        job.id,
        JSON.stringify(p),
      ]);
    },
  });

  await execute(
    `update template_previews
     set status = 'completed', session_results = $2::jsonb, user_results = $3::jsonb,
         global_result = $4::jsonb, report = $5::jsonb, html = $6, stats = $7::jsonb,
         finished_at = now(), progress = $8::jsonb
     where id = $1`,
    [
      job.id,
      JSON.stringify(out.sessionResults),
      JSON.stringify(out.userResults),
      JSON.stringify(out.globalResult),
      JSON.stringify(out.spec),
      out.html,
      JSON.stringify(out.stats),
      JSON.stringify({ stage: "done", done: 1, total: 1 }),
    ],
  );
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
  const source = await loadSource(job.data_source_id);
  if (!source) throw new Error("数据源不存在");

  const runtime = await resolveRuntime(job.data_source_id);

  const config = await loadConfig(job.workflow_id);
  const overrides = (job.config ?? {}) as Partial<{ scope: unknown; session: unknown; report: unknown }>;
  const merged = { ...config, ...(overrides as object) } as WorkflowConfig;

  const tpl = job.template_id
    ? await maybeOne<JsonObject>(
        `select version, session_prompt, user_prompt, global_prompt, report_prompt, status
         from analysis_templates where id = $1`,
        [job.template_id],
      )
    : null;

  if (!tpl) throw new Error("分析任务缺少可用的执行模板，请先在「分析工作台」完成规划");

  await runTask(
    {
      id: job.id,
      name: job.name,
      data_source_id: job.data_source_id,
      scope_type: job.scope_type,
      range_start: job.range_start,
      range_end: job.range_end,
      config: (job.config ?? {}) as JsonObject,
      template: tpl as never,
      dataSource: source,
      createdBy: (job.created_by as string | null) ?? null,
    },
    merged,
    runtime,
  );
}

/* ---------------------------------------------------------------- loop */

async function tick() {
  await sweepStaleImports();

  const batch = await claimImport();
  if (batch) {
    active.add(batch.id);
    void run("import", batch.id, () => handleImport(batch), async (err) => {
      // importZip already records its own failures; this covers a throw on the
      // way in, before it owns the row.
      await execute(
        `update import_batches
         set status = 'failed', error = coalesce(error, $2), finished_at = now()
         where id = $1 and status <> 'failed'`,
        [batch.id, err.slice(0, 1000)],
      );
    });
  }

  const planning = await claim<PlanningJob>("planning_jobs", "started_at = now()");
  if (planning) {
    active.add(planning.id);
    void run("planning", planning.id, () => handlePlanning(planning), async (err) => {
      await execute(
        `update planning_jobs set status = 'failed', error = $2, finished_at = now() where id = $1`,
        [planning.id, err.slice(0, 4000)],
      );
    });
  }

  const preview = await claim<PreviewJob>("template_previews", "progress = $2::jsonb", [
    JSON.stringify({ step: "claimed" }),
  ]);
  if (preview) {
    active.add(preview.id);
    void run("preview", preview.id, () => handlePreview(preview), async (err) => {
      await execute(
        `update template_previews set status = 'failed', error = $2, finished_at = now() where id = $1`,
        [preview.id, err.slice(0, 4000)],
      );
    });
  }

  const task = await claim<TaskRow>("analysis_tasks", "started_at = now()");
  if (task) {
    active.add(task.id);
    void run("task", task.id, () => handleTask(task), async (err) => {
      await execute(
        `update analysis_tasks set status = 'failed', error = $2, finished_at = now() where id = $1`,
        [task.id, err.slice(0, 4000)],
      );
      await log(task.id, "error", null, `任务失败: ${err.slice(0, 600)}`);
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
    // The stack goes to the container log too: the message alone is what the UI
    // shows, and when a job dies three layers down the operator needs the frame
    // it died in to know which of them it was.
    console.error(`[worker] ${kind} ${id} failed:`, msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
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
  // Fail fast, with a clear message, if the database is unreachable.
  const probe = await scalar<number>(`select 1 as ok`);
  // Models live in the database and resolve per data source, so the banner
  // reports the workspace default rather than a process-wide model.
  const defaults = await resolveRuntime(null).catch(() => null);
  const models = defaults
    ? [defaults.omni && `omni=${defaults.omni.model}`, defaults.multimodal && `多模态=${defaults.multimodal.model}`]
        .filter(Boolean)
        .join(" · ") || "未选择模型"
    : "模型配置不可读";
  console.log(
    `[worker] connected · 默认模式=${defaults ? MODE_LABEL[defaults.mode] : "?"} · ${models} · poll=${POLL_MS}ms · probe=${probe === 1 ? "ok" : "n/a"}`,
  );

  await recoverStaleJobs();

  const shutdown = () => {
    if (stopping) return; // SIGINT and SIGTERM can both arrive
    stopping = true;
    console.log("[worker] stopping…");
    void closePool().finally(() => setTimeout(() => process.exit(0), 200));
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
async function recoverStaleJobs() {
  const [tasks, plans, previews] = await Promise.all([
    execute(
      `update analysis_tasks
       set status = 'pending', stage = 'queued', started_at = null, heartbeat_at = now()
       where status = 'running'`,
    ),
    execute(`update planning_jobs set status = 'pending', started_at = null where status = 'running'`),
    execute(
      `update template_previews set status = 'pending', progress = $1::jsonb where status = 'running'`,
      [JSON.stringify({ step: "requeued" })],
    ),
  ]);
  console.log(
    `[worker] recovered orphaned jobs: tasks=${tasks} planning=${plans} previews=${previews}`,
  );
}

void main();
