import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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
  const supabase = await createClient();
  const {
    data: { user: auth },
  } = await supabase.auth.getUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const level = url.searchParams.get("level") ?? "users";
  const q = (url.searchParams.get("q") ?? "").trim();
  const userKey = url.searchParams.get("user") ?? "";
  const sessionKey = url.searchParams.get("key") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));

  if (level === "session") {
    const { data: result } = await supabase
      .from("task_session_results")
      .select("session_pk, session_key, user_key, status, result, tokens, duration_ms")
      .eq("task_id", id)
      .eq("session_key", sessionKey)
      .maybeSingle();

    let transcript: ReturnType<typeof digestToTranscript> = [];
    let meta: JsonObject | null = null;
    if (result?.session_pk) {
      const [{ data: session }, { data: msgs }] = await Promise.all([
        supabase
          .from("sessions")
          .select("session_key, user_key, started_at, ended_at, turn_count, audio_count, extra, digest")
          .eq("id", result.session_pk)
          .maybeSingle(),
        supabase
          .from("messages")
          .select("seq, role, content_text, occurred_at, audio_path, extra")
          .eq("session_id", result.session_pk)
          .order("seq", { ascending: true })
          .limit(800),
      ]);
      meta = (session ?? null) as JsonObject | null;
      transcript = msgs?.length
        ? (msgs as JsonObject[]).map((m) => ({
            role: String(m.role),
            text: String(m.content_text ?? ""),
            at: (m.occurred_at as string | null) ?? undefined,
            seq: Number(m.seq),
            audio_path: (m.audio_path as string | null) ?? undefined,
            extra: (m.extra as JsonObject) ?? undefined,
          }))
        : digestToTranscript(String((session as JsonObject | null)?.digest ?? ""));
    }

    return NextResponse.json({ result, meta, transcript });
  }

  if (level === "sessions") {
    let query = supabase
      .from("task_session_results")
      .select("session_key, user_key, status, result, tokens", { count: "exact" })
      .eq("task_id", id)
      .order("session_key", { ascending: true })
      .range((page - 1) * PAGE, page * PAGE - 1);
    if (userKey) query = query.eq("user_key", userKey);
    if (q) query = query.or(`session_key.ilike.%${q}%,user_key.ilike.%${q}%`);
    const { data, count } = await query;
    const rows = (data ?? []) as JsonObject[];
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
      total: count ?? rows.length,
      page,
    });
  }

  // level === "users"
  let query = supabase
    .from("task_user_results")
    .select("user_key, session_count, status, result", { count: "exact" })
    .eq("task_id", id)
    .order("session_count", { ascending: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (q) query = query.ilike("user_key", `%${q}%`);
  const { data, count } = await query;
  const rows = (data ?? []) as JsonObject[];

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
    total: count ?? rows.length,
    page,
  });
}
