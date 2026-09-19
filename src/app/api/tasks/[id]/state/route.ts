import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tasks/[id]/state — live status polling (task row, recent logs, result tallies). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const after = new URL(req.url).searchParams.get("after");

  let logQuery = supabase
    .from("task_logs")
    .select("id, level, stage, message, created_at")
    .eq("task_id", id)
    .order("id", { ascending: false })
    .limit(60);
  if (after) logQuery = logQuery.gt("id", Number(after));

  const tallyCount = async (status: string) => {
    const { count } = await supabase
      .from("task_session_results")
      .select("id", { count: "exact", head: true })
      .eq("task_id", id)
      .eq("status", status);
    return count ?? 0;
  };

  const [{ data: task }, { data: logs }, success, failed] = await Promise.all([
    supabase
      .from("analysis_tasks")
      .select("id, name, status, stage, progress, stats, error, started_at, finished_at, heartbeat_at")
      .eq("id", id)
      .maybeSingle(),
    logQuery,
    tallyCount("success"),
    tallyCount("failed"),
  ]);

  return NextResponse.json({
    task,
    logs: (logs ?? []).reverse(),
    resultCounts: { success, failed, total: success + failed },
  });
}
