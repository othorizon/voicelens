import { NextResponse } from "next/server";
import { count as countRows, maybeOne, query } from "@/lib/db";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";
import { digestToTranscript } from "@/lib/engine/plan";
import type { JsonObject } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 50;

/**
 * GET /api/tasks/[id]/results
 *   ?level=users|sessions|session&user=<user_key>&key=<session_key>&q=&page=
 * Powers the three-layer drill-down explorer in the task detail page.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Every query below is keyed on this task, so clearing it clears them all.
  if (!(await resolveOwnedRow(viewer, "analysis_tasks", id))) {
    return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  }

  const url = new URL(req.url);
  const level = url.searchParams.get("level") ?? "users";
  const q = (url.searchParams.get("q") ?? "").trim();
  const userKey = url.searchParams.get("user") ?? "";
  const sessionKey = url.searchParams.get("key") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));

  if (level === "session") {
    const result = await maybeOne<JsonObject>(
      `select session_pk, session_key, user_key, status, result, tokens, duration_ms
       from task_session_results
       where task_id = $1 and session_key = $2`,
      [id, sessionKey],
    );

    let transcript: ReturnType<typeof digestToTranscript> = [];
    let meta: JsonObject | null = null;
    if (result?.session_pk) {
      const [session, msgs] = await Promise.all([
        maybeOne<JsonObject>(
          `select session_key, user_key, started_at, ended_at, turn_count, audio_count, extra, digest
           from sessions where id = $1`,
          [result.session_pk],
        ),
        query<JsonObject>(
          `select seq, role, content_text, occurred_at, audio_path, extra
           from messages
           where session_id = $1
           order by seq
           limit 800`,
          [result.session_pk],
        ),
      ]);
      meta = session;
      transcript = msgs.length
        ? msgs.map((m) => ({
            role: String(m.role),
            text: String(m.content_text ?? ""),
            at: (m.occurred_at as string | null) ?? undefined,
            seq: Number(m.seq),
            audio_path: (m.audio_path as string | null) ?? undefined,
            extra: (m.extra as JsonObject) ?? undefined,
          }))
        : digestToTranscript(String(session?.digest ?? ""));
    }

    return NextResponse.json({ result, meta, transcript });
  }

  if (level === "sessions") {
    // Both filters are optional; `q` matches either key. Values stay bound as
    // parameters so a search string can never reach the statement text.
    const where = `task_id = $1
         and ($2::text is null or user_key = $2)
         and ($3::text is null or session_key ilike '%' || $3 || '%' or user_key ilike '%' || $3 || '%')`;
    const filters = [id, userKey || null, q || null];
    const [rows, total] = await Promise.all([
      query<JsonObject>(
        `select session_key, user_key, status, result, tokens
         from task_session_results
         where ${where}
         order by session_key
         limit $4 offset $5`,
        [...filters, PAGE, (page - 1) * PAGE],
      ),
      countRows(`select count(*) from task_session_results where ${where}`, filters),
    ]);
    return NextResponse.json({
      rows: rows.map((r) => {
        const res = (r.result ?? {}) as JsonObject;
        return {
          session_key: r.session_key,
          user_key: r.user_key,
          status: r.status,
          summary: res.summary ?? "",
          intent: res.intent ?? "",
          outcome: res.outcome ?? "",
          sentiment: res.sentiment ?? "",
          quality_score: res.quality_score ?? null,
          risk_level: res.risk_level ?? "none",
          tags: res.tags ?? [],
        };
      }),
      total,
      page,
    });
  }

  // level === "users"
  const userWhere = `task_id = $1 and ($2::text is null or user_key ilike '%' || $2 || '%')`;
  const userFilters = [id, q || null];
  const [rows, total] = await Promise.all([
    query<JsonObject>(
      `select user_key, session_count, status, result
       from task_user_results
       where ${userWhere}
       order by session_count desc
       limit $3 offset $4`,
      [...userFilters, PAGE, (page - 1) * PAGE],
    ),
    countRows(`select count(*) from task_user_results where ${userWhere}`, userFilters),
  ]);

  return NextResponse.json({
    rows: rows.map((r) => {
      const res = (r.result ?? {}) as JsonObject;
      return {
        user_key: r.user_key,
        session_count: r.session_count,
        status: r.status,
        summary: res.summary ?? "",
        persona: res.persona ?? "",
        risk_level: res.risk_level ?? "none",
        tags: res.tags ?? [],
        needs: res.needs ?? [],
        metrics: res.metrics ?? [],
      };
    }),
    total,
    page,
  });
}
