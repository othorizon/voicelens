/**
 * Re-render a finished task's report HTML from its stored spec and results.
 * Nothing is sent to the model: the spec plus the three layers of results are all
 * persisted, so the artefact can be rebuilt whenever the renderer changes.
 *
 * Run: npx tsx --env-file=.env.local scripts/rerender-report.ts <taskId>
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { closePool, execute, maybeOne, one, query, scalar } from "../src/lib/db";
import { renderReportHtml } from "../src/lib/engine/report-html";
import { buildDrillData } from "../src/lib/engine/plan";
import type { JsonObject, ReportSpec } from "../src/lib/types";

const taskId = process.argv[2];
if (!taskId) {
  console.error("usage: rerender-report.ts <taskId>");
  process.exit(1);
}

async function main() {
  const task = await maybeOne<{
    id: string;
    name: string;
    status: string;
    report: ReportSpec | null;
    scope_type: string;
    range_start: string | null;
    range_end: string | null;
    data_source_id: string;
    template_id: string | null;
  }>(
    `select id, name, status, report, scope_type, range_start, range_end, data_source_id, template_id
     from analysis_tasks where id = $1`,
    [taskId],
  );
  if (!task) throw new Error(`task ${taskId} not found`);
  if (!task.report) throw new Error("task has no stored report spec");

  const templateVersion = task.template_id
    ? await scalar<number>(`select version from analysis_templates where id = $1`, [task.template_id])
    : null;

  const [sessRes, userRes] = await Promise.all([
    query<{ session_pk: string; session_key: string; user_key: string; result: JsonObject }>(
      `select session_pk, session_key, user_key, result
       from task_session_results
       where task_id = $1 and status = 'success'`,
      [taskId],
    ),
    query<{ user_key: string; session_count: number; result: JsonObject }>(
      `select user_key, session_count, result
       from task_user_results
       where task_id = $1 and status = 'success'`,
      [taskId],
    ),
  ]);

  const keys = sessRes.map((r) => r.session_pk);
  const sessions = keys.length
    ? await query<JsonObject>(
        `select id, session_key, user_key, started_at, turn_count, digest
         from sessions where id = any($1::uuid[])`,
        [keys],
      )
    : [];
  const byId = new Map(sessions.map((s) => [s.id as string, s]));

  const sessionResults = sessRes.map((r) => ({
    session_key: r.session_key,
    user_key: r.user_key,
    result: r.result as never,
  }));

  const drillSessions = sessRes.map((r) => {
    const meta = byId.get(r.session_pk);
    return {
      session_key: r.session_key,
      user_key: r.user_key,
      started_at: (meta?.started_at as string | null) ?? null,
      turn_count: Number(meta?.turn_count ?? 0),
      digest: String(meta?.digest ?? ""),
    };
  });

  const userResults = userRes.map((u) => ({
    user_key: u.user_key,
    result: u.result as never,
  }));

  const drill = buildDrillData(drillSessions as never, sessionResults as never, userResults as never);

  const rangeNote =
    task.scope_type === "range" && (task.range_start || task.range_end)
      ? `时间范围 ${String(task.range_start ?? "").slice(0, 10)} ~ ${String(task.range_end ?? "").slice(0, 10)}`
      : "增量未分析";

  const html = renderReportHtml({
    spec: task.report,
    drill,
    generatedAt: new Date().toISOString(),
    scopeNote: `${rangeNote} · ${sessionResults.length} 会话 · ${userResults.length} 用户`,
    templateVersion: templateVersion ?? null,
    taskName: task.name,
  });

  await execute(`update analysis_tasks set report_html = $2 where id = $1`, [taskId, html]);

  console.log(
    `re-rendered ${taskId}: ${html.length} bytes · ${sessionResults.length} sessions · ${drill.users.length} drill users · ${
      task.report.sections?.length
    } sections`,
  );
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    await closePool().catch(() => {});
    process.exit(1);
  });
