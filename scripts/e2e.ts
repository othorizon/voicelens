/**
 * End-to-end smoke test for the analysis pipeline.
 * Run: npx tsx --env-file=.env.local scripts/e2e.ts [--step plan|preview|run]
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildDemoZip, DEMO_BUSINESS_DESC, DEMO_EXTRA_SCHEMA, generateDemoDataset } from "../src/lib/demo/generate";
import { importZip } from "../src/lib/engine/import";
import { defaultGraph, configFromGraph } from "../src/lib/workflow/graph";

const log = (m: string, extra?: unknown) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`, extra ?? "");

function client(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signIn(): Promise<SupabaseClient> {
  const anon = client();
  const { data, error } = await anon.auth.signInWithPassword({
    email: "demo@voicelens.ai",
    password: "voicelens123",
  });
  if (error) throw error;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${data.session!.access_token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function ensureSource(supabase: SupabaseClient, userId: string) {
  const { data: existing } = await supabase
    .from("data_sources")
    .select("id, name")
    .ilike("name", "%车机语音助手%")
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data, error } = await supabase
    .from("data_sources")
    .insert({
      name: "智能车机语音助手 · 示例数据源",
      description: DEMO_BUSINESS_DESC,
      extra_schema: DEMO_EXTRA_SCHEMA,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) throw error;
  const graph = defaultGraph();
  const { error: wfErr } = await supabase.from("workflows").insert({
    data_source_id: data.id,
    name: "车机语音助手 · 默认分析流",
    graph,
    config: configFromGraph(graph),
    created_by: userId,
  } as never);
  if (wfErr) throw wfErr;
  return data.id as string;
}

async function waitFor(
  supabase: SupabaseClient,
  label: string,
  fn: () => PromiseLike<{ data: unknown }>,
  check: (row: unknown) => boolean,
  timeoutMs = 15 * 60 * 1000,
): Promise<unknown> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { data } = await fn();
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const row = rows[0];
    if (row && check(row)) return row;
    const status = (row as { status?: string; progress?: unknown }) ?? {};
    log(`${label} … ${JSON.stringify(status.status ?? "?")} ${shorten(status.progress)}`);
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`${label} timed out`);
}

function shorten(v: unknown) {
  const s = JSON.stringify(v ?? "");
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

async function main() {
  const step = process.argv[2] ?? "all";
  const supabase = await signIn();
  const { data: me } = await supabase.auth.getUser();
  const userId = me.user!.id;
  log("signed in", userId);

  const sourceId = await ensureSource(supabase, userId);
  log("data source", sourceId);

  /* ------------------------------------------------------------ import */
  if (step === "all" || step === "import") {
    const { count } = await supabase.from("sessions").select("id", { count: "exact", head: true }).eq("data_source_id", sourceId);
    if (!count) {
      const dataset = generateDemoDataset({ sessions: 60, users: 26, seed: 42 });
      log("demo dataset", { sessions: dataset.sessions, records: dataset.records.length, audios: dataset.audios });
      const zip = await buildDemoZip(dataset);
      log("zip built", `${(zip.byteLength / 1024).toFixed(0)} KB`);
      const res = await importZip(supabase, sourceId, zip.buffer as ArrayBuffer, "demo.zip", userId, (m, e) => log(`import: ${m}`, e));
      log("import done", res);
    } else {
      log("data already imported, skipping", { sessions: count });
    }
  }

  const { data: wf } = await supabase.from("workflows").select("id, graph").eq("data_source_id", sourceId).limit(1).maybeSingle();
  const workflowId = wf?.id as string;

  /* ------------------------------------------------------------- plan */
  let templateId: string | null = null;
  const { data: tpl } = await supabase
    .from("analysis_templates")
    .select("id, version")
    .eq("data_source_id", sourceId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  templateId = (tpl?.id as string) ?? null;

  if (!templateId && (step === "all" || step === "plan")) {
    const { data: job, error } = await supabase
      .from("planning_jobs")
      .insert({
        data_source_id: sourceId,
        workflow_id: workflowId,
        kind: "create",
        status: "pending",
        params: { sessionSamples: 5, userSamples: 4, includeAudio: true, focus: "" },
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw error;
    log("planning job created", job.id);
    const done = (await waitFor(
      supabase,
      "planning",
      () => supabase.from("planning_jobs").select("*").eq("id", job.id).maybeSingle(),
      (r) => ["completed", "failed"].includes(String((r as { status: string }).status)),
    )) as { status: string; error: string | null; template_id: string | null };
    if (done.status !== "completed") throw new Error(`planning failed: ${done.error}`);
    templateId = done.template_id;
    log("template ready", templateId);
  }

  /* ---------------------------------------------------------- confirm */
  if (templateId) {
    await supabase.from("analysis_templates").update({ status: "archived" } as never).eq("data_source_id", sourceId).eq("status", "confirmed");
    await supabase.from("analysis_templates").update({ status: "confirmed" } as never).eq("id", templateId);
    log("template confirmed", templateId);
  }

  /* ----------------------------------------------------------- preview */
  if (step === "all" || step === "preview") {
    if (!templateId) throw new Error("no template, cannot preview");
    const { data: pv, error } = await supabase
      .from("template_previews")
      .insert({
        template_id: templateId,
        data_source_id: sourceId,
        status: "pending",
        params: { sessions: 8, useAudio: false, concurrency: 3 },
        progress: { stage: "queued", done: 0, total: 8 },
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw error;
    log("preview created", pv.id);
    const done = (await waitFor(
      supabase,
      "preview",
      () => supabase.from("template_previews").select("id, status, progress, error, html, stats").eq("id", pv.id).maybeSingle(),
      (r) => ["completed", "failed"].includes(String((r as { status: string }).status)),
    )) as { status: string; error: string | null; html: string | null };
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

    const { data: task, error } = await supabase
      .from("analysis_tasks")
      .insert({
        data_source_id: sourceId,
        template_id: templateId,
        workflow_id: workflowId,
        name: "E2E 冒烟测试 · 增量分析",
        scope_type: "incremental",
        status: "pending",
        stage: "queued",
        config,
        progress: { stage: "queued", total: 0, done: 0 },
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw error;
    log("task created", task.id);

    const done = (await waitFor(
      supabase,
      "task",
      () => supabase.from("analysis_tasks").select("id, status, stage, progress, error, stats").eq("id", task.id).maybeSingle(),
      (r) => ["completed", "failed", "cancelled"].includes(String((r as { status: string }).status)),
      30 * 60 * 1000,
    )) as { status: string; error: string | null; stats: unknown };
    if (done.status !== "completed") throw new Error(`task failed: ${done.error}`);
    log("task completed", done.stats);

    const { data: full } = await supabase
      .from("analysis_tasks")
      .select("report_html, report")
      .eq("id", task.id)
      .single();
    log("report html bytes", (full?.report_html as string | null)?.length ?? 0);
    log("report sections", ((full?.report as { sections?: unknown[] } | null)?.sections ?? []).length);
  }

  log("E2E OK");
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
