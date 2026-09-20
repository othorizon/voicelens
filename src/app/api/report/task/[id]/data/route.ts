import { NextResponse } from "next/server";
import { maybeOne, query } from "@/lib/db";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";
import type { JsonObject, SessionAnalysis, UserAnalysis } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Drill-down for a generated report page.
 *
 * The page itself runs in a sandbox with no origin and no credentials, so it
 * cannot reach this route: it asks its host, and the host — which does hold
 * the session — asks here. Every request is therefore authorized here as
 * usual, and the page never gains access it could misuse.
 *
 * Paging is not a courtesy. It is what stops a generated page from trying to
 * render eighty thousand rows because the model that wrote it only ever saw
 * forty.
 */

const MAX_SIZE = 200;

const USER_SORTS: Record<string, string> = {
  session_count: "session_count",
  user_key: "user_key",
};
const SESSION_SORTS: Record<string, string> = {
  session_key: "r.session_key",
  quality_score: "(r.result->>'quality_score')::numeric",
  started_at: "s.started_at",
  turn_count: "s.turn_count",
};

interface Args {
  page?: number;
  size?: number;
  sort?: string;
  order?: string;
  q?: string;
  userKey?: string;
  sessionKey?: string;
  seq?: number;
}

const clampPage = (a: Args) => {
  const size = Math.min(MAX_SIZE, Math.max(1, Math.floor(Number(a.size) || 50)));
  const page = Math.max(1, Math.floor(Number(a.page) || 1));
  return { size, offset: (page - 1) * size, page };
};

const direction = (o?: string) => (String(o).toLowerCase() === "asc" ? "asc" : "desc");

async function listUsers(taskId: string, a: Args) {
  const { size, offset, page } = clampPage(a);
  const sort = USER_SORTS[a.sort ?? ""] ?? "session_count";
  const like = a.q ? `%${a.q}%` : null;

  const rows = await query<{ user_key: string; result: UserAnalysis; total: number }>(
    `select user_key, result, count(*) over ()::int as total
     from task_user_results
     where task_id = $1 and status in ('success', 'degraded') and result is not null
       and ($2::text is null or user_key ilike $2 or result->>'persona' ilike $2 or result->>'summary' ilike $2)
     order by ${sort} ${direction(a.order)}, user_key
     limit $3 offset $4`,
    [taskId, like, size, offset],
  );

  return {
    rows: rows.map((r) => ({ user_key: r.user_key, ...r.result })),
    total: rows[0]?.total ?? 0,
    page,
    size,
  };
}

async function getUser(taskId: string, a: Args) {
  if (!a.userKey) return null;
  const row = await maybeOne<{ user_key: string; result: UserAnalysis }>(
    `select user_key, result from task_user_results
     where task_id = $1 and user_key = $2 and result is not null`,
    [taskId, a.userKey],
  );
  if (!row) return null;
  const sessions = await query<{ session_key: string }>(
    `select session_key from task_session_results
     where task_id = $1 and user_key = $2 and status = 'success'
     order by session_key`,
    [taskId, a.userKey],
  );
  return { user_key: row.user_key, ...row.result, session_keys: sessions.map((s) => s.session_key) };
}

async function listSessions(taskId: string, a: Args) {
  const { size, offset, page } = clampPage(a);
  const sort = SESSION_SORTS[a.sort ?? ""] ?? "r.session_key";
  const like = a.q ? `%${a.q}%` : null;

  const rows = await query<{
    session_key: string;
    user_key: string;
    started_at: string | null;
    turn_count: number;
    result: SessionAnalysis;
    total: number;
  }>(
    `select r.session_key, r.user_key, s.started_at, s.turn_count, r.result,
            count(*) over ()::int as total
     from task_session_results r
     join sessions s on s.id = r.session_pk
     where r.task_id = $1 and r.status = 'success' and r.result is not null
       and ($2::text is null or r.user_key = $2)
       and ($3::text is null or r.session_key ilike $3 or r.result->>'summary' ilike $3)
     order by ${sort} ${direction(a.order)}, r.session_key
     limit $4 offset $5`,
    [taskId, a.userKey ?? null, like, size, offset],
  );

  return {
    rows: rows.map((r) => ({
      session_key: r.session_key,
      user_key: r.user_key,
      started_at: r.started_at,
      turn_count: r.turn_count,
      ...r.result,
    })),
    total: rows[0]?.total ?? 0,
    page,
    size,
  };
}

/** Transcripts are the reason drill-down cannot be inlined. */
const TRANSCRIPT_LIMIT = 600;

async function getSession(taskId: string, a: Args) {
  if (!a.sessionKey) return null;
  const row = await maybeOne<{
    session_pk: string;
    session_key: string;
    user_key: string;
    started_at: string | null;
    turn_count: number;
    result: SessionAnalysis;
  }>(
    `select r.session_pk, r.session_key, r.user_key, s.started_at, s.turn_count, r.result
     from task_session_results r
     join sessions s on s.id = r.session_pk
     where r.task_id = $1 and r.session_key = $2 and r.result is not null`,
    [taskId, a.sessionKey],
  );
  if (!row) return null;

  const transcript = await query<{
    seq: number;
    role: string;
    content_text: string;
    occurred_at: string | null;
    audio_path: string | null;
    extra: JsonObject;
  }>(
    `select seq, role, content_text, occurred_at, audio_path, extra
     from messages where session_id = $1 order by seq limit $2`,
    [row.session_pk, TRANSCRIPT_LIMIT],
  );

  return {
    session_key: row.session_key,
    user_key: row.user_key,
    started_at: row.started_at,
    turn_count: row.turn_count,
    ...row.result,
    transcript: transcript.map((m) => ({
      seq: m.seq,
      role: m.role,
      text: m.content_text,
      at: m.occurred_at,
      has_audio: !!m.audio_path,
      extra: m.extra,
    })),
  };
}

/**
 * Only the object path is returned. The bytes are fetched by the host through
 * the existing authorized audio proxy, so a storage credential never travels
 * anywhere near the generated page.
 */
async function audioClip(taskId: string, a: Args) {
  if (!a.sessionKey) return null;
  const row = await maybeOne<{ audio_path: string | null; audio_format: string | null }>(
    `select m.audio_path, m.audio_format
     from task_session_results r
     join messages m on m.session_id = r.session_pk
     where r.task_id = $1 and r.session_key = $2 and m.audio_path is not null
       and ($3::int is null or m.seq = $3)
     order by m.seq
     limit 1`,
    [taskId, a.sessionKey, Number.isFinite(Number(a.seq)) ? Number(a.seq) : null],
  );
  return row?.audio_path ? { path: row.audio_path, format: row.audio_format ?? "wav" } : null;
}

const METHODS: Record<string, (taskId: string, args: Args) => Promise<unknown>> = {
  listUsers,
  getUser,
  listSessions,
  getSession,
  audioClip,
};

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await resolveOwnedRow(viewer, "analysis_tasks", id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let body: { method?: string; args?: Args };
  try {
    body = (await req.json()) as { method?: string; args?: Args };
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const fn = METHODS[body.method ?? ""];
  if (!fn) return NextResponse.json({ error: `未知的方法：${body.method}` }, { status: 400 });

  try {
    return NextResponse.json({ data: await fn(id, body.args ?? {}) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
