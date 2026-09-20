/**
 * End-to-end smoke test for the analysis pipeline.
 * Run: npx tsx --env-file=.env.local scripts/e2e.ts [--step plan|preview|run]
 *
 * Talks to Postgres directly, so the background worker must be running for the
 * planning / preview / task steps to make progress.
 */
import { closePool, count as countRows, execute, maybeOne, one } from "../src/lib/db";
import { registerUser, verifyCredentials } from "../src/lib/auth";
import { buildDemoZip, DEMO_BUSINESS_DESC, DEMO_EXTRA_SCHEMA, generateDemoDataset } from "../src/lib/demo/generate";
import { importZip } from "../src/lib/engine/import";
import { defaultGraph, configFromGraph } from "../src/lib/workflow/graph";
import { resolveRuntime } from "../src/lib/models/registry";
import { MODE_LABEL, audioKinds, requiredKinds } from "../src/lib/models/mode";

const log = (m: string, extra?: unknown) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`, extra ?? "");

const E2E_EMAIL = process.env.E2E_EMAIL ?? "e2e@voicelens.local";
const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "";

/** Reuse the e2e account if it exists, otherwise create it. */
async function ensureUser(): Promise<string> {
  if (!E2E_PASSWORD) {
    throw new Error("E2E_PASSWORD is not set — pick one and export it before running the smoke test");
  }
  try {
    return (await verifyCredentials(E2E_EMAIL, E2E_PASSWORD)).id;
  } catch {
    return (await registerUser(E2E_EMAIL, E2E_PASSWORD, "E2E")).id;
  }
}

async function ensureSource(userId: string): Promise<string> {
  const existing = await maybeOne<{ id: string }>(
    `select id from data_sources where name ilike '%车机语音助手%' limit 1`,
  );
  if (existing) return existing.id;

  const created = await one<{ id: string }>(
    `insert into data_sources (name, description, extra_schema, created_by)
     values ($1, $2, $3::jsonb, $4)
     returning id`,
    ["智能车机语音助手 · 示例数据源", DEMO_BUSINESS_DESC, JSON.stringify(DEMO_EXTRA_SCHEMA), userId],
  );

  const graph = defaultGraph();
  await execute(
    `insert into workflows (data_source_id, name, graph, config, created_by)
     values ($1, $2, $3::jsonb, $4::jsonb, $5)`,
    [
      created.id,
      "车机语音助手 · 默认分析流",
      JSON.stringify(graph),
      JSON.stringify(configFromGraph(graph)),
      userId,
    ],
  );
  return created.id;
}

/** Poll a row until `check` passes, logging its status as it goes. */
async function waitFor<T extends { status?: string; progress?: unknown }>(
  label: string,
  fetch: () => Promise<T | null>,
  check: (row: T) => boolean,
  timeoutMs = 15 * 60 * 1000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await fetch();
    if (row && check(row)) return row;
    log(`${label} … ${JSON.stringify(row?.status ?? "?")} ${shorten(row?.progress)}`);
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`${label} timed out`);
}

function shorten(v: unknown) {
  const s = JSON.stringify(v ?? "");
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

const settled = (r: { status?: string }) => ["completed", "failed"].includes(String(r.status));

/**
 * Models are configured in the app now, not in the environment, so the smoke
 * test cannot conjure one. Check up front rather than letting the worker fail
 * a job twenty minutes in with the same message.
 */
async function assertModelsConfigured(sourceId: string): Promise<void> {
  const runtime = await resolveRuntime(sourceId);
  const missing = [...requiredKinds(runtime.mode), ...audioKinds(runtime.mode)].filter(
    (kind) => !(kind === "omni" ? runtime.omni : runtime.multimodal),
  );
  if (missing.length) {
    throw new Error(
      `模型未配置：模式「${MODE_LABEL[runtime.mode]}」还缺 ${missing.join(" / ")}。\n` +
        "请先用所有者账号登录，在「设置 → 分析模型」里添加模型并选为默认，再跑这个冒烟测试。" +
        (Object.values(runtime.problems).length
          ? `\n已选中但不可用：${Object.values(runtime.problems).join("；")}`
          : ""),
    );
  }
  log("models", {
    mode: MODE_LABEL[runtime.mode],
    omni: runtime.omni?.model ?? null,
    multimodal: runtime.multimodal?.model ?? null,
  });
}

async function main() {
  const step = process.argv[2] ?? "all";
  const userId = await ensureUser();
  log("e2e user", userId);

  const sourceId = await ensureSource(userId);
  log("data source", sourceId);

  // Import needs no model; everything after it does.
  if (step !== "import") await assertModelsConfigured(sourceId);

  /* ------------------------------------------------------------ import */
  if (step === "all" || step === "import") {
    const sessions = await countRows(`select count(*) from sessions where data_source_id = $1`, [sourceId]);
    if (!sessions) {
      const dataset = generateDemoDataset({ sessions: 60, users: 26, seed: 42 });
      log("demo dataset", { sessions: dataset.sessions, records: dataset.records.length, audios: dataset.audios });
      const zip = await buildDemoZip(dataset);
      log("zip built", `${(zip.byteLength / 1024).toFixed(0)} KB`);
      const res = await importZip(
        sourceId,
        { kind: "buffer", data: zip.buffer as ArrayBuffer },
        "demo.zip",
        userId,
        (m, e) => log(`import: ${m}`, e),
      );
      log("import done", res);
    } else {
      log("data already imported, skipping", { sessions });
    }
  }

  const wf = await maybeOne<{ id: string; graph: unknown }>(
    `select id, graph from workflows where data_source_id = $1 limit 1`,
    [sourceId],
  );
  const workflowId = wf?.id ?? null;

  /* ------------------------------------------------------------- plan */
  let templateId: string | null =
    (
      await maybeOne<{ id: string }>(
        `select id from analysis_templates where data_source_id = $1 order by version desc limit 1`,
        [sourceId],
      )
    )?.id ?? null;

  if (!templateId && (step === "all" || step === "plan")) {
    const job = await one<{ id: string }>(
      `insert into planning_jobs (data_source_id, workflow_id, kind, status, params, created_by)
       values ($1, $2, 'create', 'pending', $3::jsonb, $4)
       returning id`,
      [
        sourceId,
        workflowId,
        JSON.stringify({ sessionSamples: 5, userSamples: 4, includeAudio: true, focus: "" }),
        userId,
      ],
    );
    log("planning job created", job.id);

    const done = await waitFor<{ status: string; error: string | null; template_id: string | null }>(
      "planning",
      () =>
        maybeOne(`select status, error, template_id, progress from planning_jobs where id = $1`, [job.id]),
      settled,
    );
    if (done.status !== "completed") throw new Error(`planning failed: ${done.error}`);
    templateId = done.template_id;
    log("template ready", templateId);
  }

  /* ---------------------------------------------------------- confirm */
  if (templateId) {
    await execute(
      `update analysis_templates set status = 'archived'
       where data_source_id = $1 and status = 'confirmed'`,
      [sourceId],
    );
    await execute(`update analysis_templates set status = 'confirmed' where id = $1`, [templateId]);
    log("template confirmed", templateId);
  }

  /* ----------------------------------------------------------- preview */
  if (step === "all" || step === "preview") {
    if (!templateId) throw new Error("no template, cannot preview");
    const pv = await one<{ id: string }>(
      `insert into template_previews
         (template_id, data_source_id, status, params, progress, created_by)
       values ($1, $2, 'pending', $3::jsonb, $4::jsonb, $5)
       returning id`,
      [
        templateId,
        sourceId,
        JSON.stringify({ sessions: 8, useAudio: false, concurrency: 3 }),
        JSON.stringify({ stage: "queued", done: 0, total: 8 }),
        userId,
      ],
    );
    log("preview created", pv.id);

    const done = await waitFor<{ status: string; error: string | null; html: string | null }>(
      "preview",
      () =>
        maybeOne(`select status, error, html, progress from template_previews where id = $1`, [pv.id]),
      settled,
    );
    if (done.status !== "completed") throw new Error(`preview failed: ${done.error}`);
    log("preview html bytes", (done.html ?? "").length);
  }

  /* -------------------------------------------------------------- run */
  if (step === "all" || step === "run") {
    if (!templateId) throw new Error("no template, cannot run");
    const config = configFromGraph((wf?.graph ?? defaultGraph()) as never);
    config.scope.maxSessions = 40;
    config.session.concurrency = 5;
    config.report.topUsers = 30;

    const task = await one<{ id: string }>(
      `insert into analysis_tasks
         (data_source_id, template_id, workflow_id, name, scope_type, status, stage, config,
          progress, created_by)
       values ($1, $2, $3, $4, 'incremental', 'pending', 'queued', $5::jsonb, $6::jsonb, $7)
       returning id`,
      [
        sourceId,
        templateId,
        workflowId,
        "E2E 冒烟测试 · 增量分析",
        JSON.stringify(config),
        JSON.stringify({ stage: "queued", total: 0, done: 0 }),
        userId,
      ],
    );
    log("task created", task.id);

    const done = await waitFor<{ status: string; error: string | null; stats: unknown }>(
      "task",
      () =>
        maybeOne(`select status, error, stats, progress from analysis_tasks where id = $1`, [task.id]),
      (r) => ["completed", "failed", "cancelled"].includes(String(r.status)),
      30 * 60 * 1000,
    );
    if (done.status !== "completed") throw new Error(`task failed: ${done.error}`);
    log("task completed", done.stats);

    const full = await one<{ report_html: string | null; report: { sections?: unknown[] } | null }>(
      `select report_html, report from analysis_tasks where id = $1`,
      [task.id],
    );
    log("report html bytes", full.report_html?.length ?? 0);
    log("report sections", (full.report?.sections ?? []).length);
  }

  log("E2E OK");
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error("E2E FAILED:", e);
    await closePool().catch(() => {});
    process.exit(1);
  });
