import { NextResponse } from "next/server";
import { maybeOne, query } from "@/lib/db";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";
import type { JsonObject } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tasks/[id]/state — live status polling (task row, recent logs, result tallies). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await resolveOwnedRow(viewer, "analysis_tasks", id))) {
    return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  }

  const after = new URL(req.url).searchParams.get("after");
  const afterId = after !== null && Number.isFinite(Number(after)) ? Number(after) : null;

  const [task, logs, tallies] = await Promise.all([
    maybeOne<JsonObject>(
      `select id, name, status, stage, progress, stats, error, started_at, finished_at, heartbeat_at
       from analysis_tasks where id = $1`,
      [id],
    ),
    query<JsonObject>(
      `select id, level, stage, message, created_at
       from task_logs
       where task_id = $1 and ($2::bigint is null or id > $2)
       order by id desc
       limit 60`,
      [id, afterId],
    ),
    // Both tallies in one pass over the task's rows.
    query<{ status: string; n: number }>(
      `select status, count(*)::int as n
       from task_session_results
       where task_id = $1 and status in ('success', 'failed')
       group by status`,
      [id],
    ),
  ]);

  const success = tallies.find((t) => t.status === "success")?.n ?? 0;
  const failed = tallies.find((t) => t.status === "failed")?.n ?? 0;

  return NextResponse.json({
    task,
    logs: logs.reverse(),
    resultCounts: { success, failed, total: success + failed },
  });
}
