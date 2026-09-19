/**
 * Re-render a finished task's report HTML from its stored spec and results.
 * Nothing is sent to the model: the spec plus the three layers of results are all
 * persisted, so the artefact can be rebuilt whenever the renderer changes.
 *
 * Run: npx tsx --env-file=.env.local scripts/rerender-report.ts <taskId>
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { renderReportHtml } from "../src/lib/engine/report-html";
import { buildDrillData } from "../src/lib/engine/plan";
import type { JsonObject, ReportSpec } from "../src/lib/types";

const taskId = process.argv[2];
if (!taskId) {
  console.error("usage: rerender-report.ts <taskId>");
  process.exit(1);
}

async function main() {
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
  const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({
    email: process.env.SUPABASE_SERVICE_EMAIL!,
    password: process.env.SUPABASE_SERVICE_PASSWORD!,
  });
  if (signErr) throw signErr;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${signIn.session!.access_token}` } },
    auth: { persistSession: false },
  });

  const { data: task } = await sb
    .from("analysis_tasks")
    .select("id, name, status, report, scope_type, range_start, range_end, data_source_id, template_id")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) throw new Error(`task ${taskId} not found`);
  if (!task.report) throw new Error("task has no stored report spec");

  const { data: tpl } = await sb.from("analysis_templates").select("version").eq("id", task.template_id).maybeSingle();

  const [{ data: sessRes }, { data: userRes }] = await Promise.all([
    sb.from("task_session_results").select("session_pk, session_key, user_key, result").eq("task_id", taskId).eq("status", "success"),
    sb.from("task_user_results").select("user_key, session_count, result").eq("task_id", taskId).eq("status", "success"),
  ]);

  const keys = (sessRes ?? []).map((r) => r.session_pk as string);
  const { data: sessions } = keys.length
    ? await sb.from("sessions").select("id, session_key, user_key, started_at, turn_count, digest").in("id", keys)
    : { data: [] };
  const byId = new Map((sessions ?? []).map((s) => [s.id as string, s as JsonObject]));

  const sessionResults = (sessRes ?? []).map((r) => ({
    session_key: r.session_key as string,
    user_key: r.user_key as string,
    result: r.result as never,
  }));

  const drillSessions = (sessRes ?? []).map((r) => {
    const meta = byId.get(r.session_pk as string);
    return {
      session_key: r.session_key as string,
      user_key: r.user_key as string,
      started_at: (meta?.started_at as string | null) ?? null,
      turn_count: Number(meta?.turn_count ?? 0),
      digest: String(meta?.digest ?? ""),
    };
  });

  const userResults = (userRes ?? []).map((u) => ({
    user_key: u.user_key as string,
    result: u.result as never,
  }));

  const drill = buildDrillData(drillSessions as never, sessionResults as never, userResults as never);

  const rangeNote =
    task.scope_type === "range" && (task.range_start || task.range_end)
      ? `时间范围 ${String(task.range_start ?? "").slice(0, 10)} ~ ${String(task.range_end ?? "").slice(0, 10)}`
      : "增量未分析";

  const html = renderReportHtml({
    spec: task.report as ReportSpec,
    drill,
    generatedAt: new Date().toISOString(),
    scopeNote: `${rangeNote} · ${sessionResults.length} 会话 · ${userResults.length} 用户`,
    templateVersion: (tpl?.version as number | undefined) ?? null,
    taskName: task.name as string,
  });

  const { error } = await sb.from("analysis_tasks").update({ report_html: html }).eq("id", taskId);
  if (error) throw error;

  console.log(
    `re-rendered ${taskId}: ${html.length} bytes · ${sessionResults.length} sessions · ${drill.users.length} drill users · ${
      (task.report as ReportSpec).sections?.length
    } sections`,
  );
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
