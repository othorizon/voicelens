import { query, scalar } from "@/lib/db";
import type { ReportSnapshot } from "./report-runtime";
import type { JsonObject, SessionAnalysis, UserAnalysis } from "@/lib/types";

/**
 * Detail rows for a report that is leaving the platform.
 *
 * A served report asks its host for drill-down. The same file downloaded has
 * no host, so whatever it can carry is written into it on the way out. It
 * cannot carry everything — transcripts for a large run are gigabytes — so it
 * carries a coherent slice and says so: the users it holds are the users whose
 * sessions it also holds, which is what keeps the export from being a page of
 * dead ends.
 *
 * What it left behind is stated in `meta`, not left to be discovered. A file
 * that quietly holds a tenth of the run and presents itself as the whole one
 * is the failure this is written to avoid.
 */

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};

/** Deliberately conservative: an export is a file someone has to open. */
const MAX_USERS = () => num("VOICELENS_EXPORT_MAX_USERS", 300);
const MAX_SESSIONS = () => num("VOICELENS_EXPORT_MAX_SESSIONS", 400);
const MAX_TURNS = () => num("VOICELENS_EXPORT_MAX_TURNS", 80);

export async function buildTaskSnapshot(taskId: string): Promise<ReportSnapshot> {
  const maxUsers = MAX_USERS();
  const maxSessions = MAX_SESSIONS();
  const maxTurns = MAX_TURNS();

  const [userTotal, sessionTotal] = await Promise.all([
    scalar<number>(
      `select count(*)::int from task_user_results
       where task_id = $1 and status in ('success', 'degraded') and result is not null`,
      [taskId],
    ),
    scalar<number>(
      `select count(*)::int from task_session_results
       where task_id = $1 and status = 'success' and result is not null`,
      [taskId],
    ),
  ]);

  const users = await query<{ user_key: string; result: UserAnalysis; session_keys: string[] | null }>(
    `select u.user_key, u.result,
            (select array_agg(r.session_key order by r.session_key)
               from task_session_results r
              where r.task_id = u.task_id and r.user_key = u.user_key and r.status = 'success') as session_keys
     from task_user_results u
     where u.task_id = $1 and u.status in ('success', 'degraded') and u.result is not null
     order by u.session_count desc, u.user_key
     limit $2`,
    [taskId, maxUsers],
  );

  // Sessions are taken from the users that made it in, so every user the file
  // shows can actually be opened.
  const keys = users.map((u) => u.user_key);
  const sessions = keys.length
    ? await query<{
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
         where r.task_id = $1 and r.status = 'success' and r.result is not null
           and r.user_key = any($2::text[])
         order by r.user_key, r.session_key
         limit $3`,
        [taskId, keys, maxSessions],
      )
    : [];

  // One query for every transcript: a row number per session caps the turns
  // without a round trip each.
  const turns = sessions.length
    ? await query<{
        session_id: string;
        seq: number;
        role: string;
        content_text: string;
        occurred_at: string | null;
        audio_path: string | null;
      }>(
        `select session_id, seq, role, content_text, occurred_at, audio_path
         from (
           select m.session_id, m.seq, m.role, m.content_text, m.occurred_at, m.audio_path,
                  row_number() over (partition by m.session_id order by m.seq) as rn
           from messages m
           where m.session_id = any($1::uuid[])
         ) t
         where rn <= $2
         order by session_id, seq`,
        [sessions.map((s) => s.session_pk), maxTurns],
      )
    : [];

  const bySession = new Map<string, JsonObject[]>();
  for (const t of turns) {
    const list = bySession.get(t.session_id) ?? [];
    list.push({
      seq: t.seq,
      role: t.role,
      text: t.content_text,
      at: t.occurred_at,
      has_audio: !!t.audio_path,
    });
    bySession.set(t.session_id, list);
  }

  const held = new Set(sessions.map((s) => s.session_key));

  return {
    users: users.map((u) => ({
      user_key: u.user_key,
      ...u.result,
      session_keys: (u.session_keys ?? []).filter((k) => held.has(k)),
    })),
    sessions: sessions.map((s) => ({
      session_key: s.session_key,
      user_key: s.user_key,
      started_at: s.started_at,
      turn_count: s.turn_count,
      ...s.result,
      transcript: bySession.get(s.session_pk) ?? [],
      transcript_truncated: (bySession.get(s.session_pk)?.length ?? 0) >= maxTurns,
    })),
    meta: {
      offline: true,
      offline_note: describe(users.length, userTotal ?? 0, sessions.length, sessionTotal ?? 0),
      offline_users: users.length,
      offline_sessions: sessions.length,
      total_users: userTotal ?? users.length,
      total_sessions: sessionTotal ?? sessions.length,
    },
  };
}

function describe(users: number, userTotal: number, sessions: number, sessionTotal: number): string {
  const partial = users < userTotal || sessions < sessionTotal;
  if (!partial) return `离线文件，包含全部 ${users} 位用户 / ${sessions} 个会话的明细。`;
  return (
    `离线文件，包含 ${users} / ${userTotal} 位用户、${sessions} / ${sessionTotal} 个会话的明细。` +
    `未包含的记录在下探时会提示「不在离线文件中」，请回到平台查看完整报告。`
  );
}
