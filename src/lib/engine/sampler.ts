import { callJson, count as countRows, query } from "@/lib/db";
import { truncate } from "./normalize";
import type { ExtraFieldDef, JsonObject } from "@/lib/types";

export interface ScopeSelection {
  sessionIds: string[];
  mode: "incremental" | "range";
  totalAvailable: number;
}

export interface ScopeOptions {
  mode: "incremental" | "range";
  rangeStart?: string | null;
  rangeEnd?: string | null;
  limit: number;
}

/** Decide which sessions this run should cover. */
export async function resolveScope(
  dataSourceId: string,
  options: ScopeOptions,
): Promise<ScopeSelection> {
  const limit = options.limit > 0 ? options.limit : 100000;

  if (options.mode === "range") {
    // A null bound means "unbounded on that side".
    const rows = await query<{ id: string }>(
      `select id from sessions
       where data_source_id = $1
         and ($2::timestamptz is null or started_at >= $2)
         and ($3::timestamptz is null or started_at <= $3)
       order by started_at
       limit $4`,
      [dataSourceId, options.rangeStart ?? null, options.rangeEnd ?? null, limit],
    );
    const ids = rows.map((r) => r.id);
    return { sessionIds: ids, mode: "range", totalAvailable: ids.length };
  }

  const rows = await query<{ id: string }>(`select id from unanalyzed_session_ids($1, $2)`, [
    dataSourceId,
    limit,
  ]);
  const ids = rows.map((r) => r.id);
  const total = await countRows(`select count(*) from sessions where data_source_id = $1`, [
    dataSourceId,
  ]);
  return { sessionIds: ids, mode: "incremental", totalAvailable: total || ids.length };
}

export interface SessionLike {
  id: string;
  session_key: string;
  user_key: string;
  started_at: string | null;
  ended_at: string | null;
  turn_count: number;
  audio_count: number;
  digest: string | null;
  extra: JsonObject;
}

/**
 * Evenly-spaced pick over the turn-count distribution, preferring a user that
 * has not been sampled yet. Deterministic, so re-running a preview is stable.
 */
export function stratifiedPick<T extends SessionLike>(rows: T[], n: number): T[] {
  if (rows.length <= n) return [...rows];
  const ordered = [...rows].sort((a, b) => a.turn_count - b.turn_count || a.session_key.localeCompare(b.session_key));
  const picked: T[] = [];
  const seenUsers = new Set<string>();
  const seenIds = new Set<string>();

  for (let pass = 0; pass < 2 && picked.length < n; pass++) {
    for (let k = 0; k < n && picked.length < n; k++) {
      const idx = Math.min(ordered.length - 1, Math.floor(((k + 0.5) * ordered.length) / n));
      const cand = ordered[idx];
      if (!cand || seenIds.has(cand.id)) continue;
      if (pass === 0 && seenUsers.has(cand.user_key)) continue;
      picked.push(cand);
      seenIds.add(cand.id);
      seenUsers.add(cand.user_key);
    }
  }

  // Last resort when there are fewer distinct users than requested samples.
  for (const row of ordered) {
    if (picked.length >= n) break;
    if (!seenIds.has(row.id)) {
      picked.push(row);
      seenIds.add(row.id);
    }
  }
  return picked;
}

/* ------------------------------------------------------------------ layers */

export interface SampledSession {
  id: string;
  session_key: string;
  user_key: string;
  started_at: string | null;
  turn_count: number;
  audio_count: number;
  digest: string;
  extra: JsonObject;
}

/** Shape consumed by `renderSamples` in prompts.ts. */
export interface PlanningSamples {
  sessions: {
    session_key: string;
    user_key: string;
    started_at: string | null;
    turn_count: number;
    digest: string;
    extra: JsonObject;
    audios?: number;
  }[];
  users: { user_key: string; session_count: number; digests: string[] }[];
  global: {
    session_count: number;
    user_count: number;
    message_count: number;
    audio_count: number;
    extra_histogram: { key: string; values: { name: string; value: number }[] }[];
    [k: string]: unknown;
  };
}

export interface SampleLayers extends PlanningSamples {
  rawSessions: SampledSession[];
  usersDetail: { user_key: string; session_count: number; digests: string[]; session_keys: string[] }[];
  histogram: { key: string; values: { name: string; value: number }[] }[];
  overview: JsonObject & Record<string, unknown>;
}

/**
 * Stratified sampling for the planning stage: pull a spread of sessions
 * (short / long / high-risk proxies), a few multi-session users, and global
 * statistics computed in Postgres.
 */
export async function sampleForPlanning(
  dataSourceId: string,
  opts: { sessionSamples: number; userSamples: number },
): Promise<SampleLayers> {
  const want = Math.max(3, Math.min(opts.sessionSamples, 12));

  const pool = await query<SessionLike>(
    `select id, session_key, user_key, started_at, ended_at, turn_count, audio_count, digest, extra
     from sessions
     where data_source_id = $1
     order by started_at desc nulls last
     limit $2`,
    [dataSourceId, Math.max(want * 8, 120)],
  );

  // Representative spread over session length and distinct users, plus the two
  // longest sessions, which usually carry the most signal for prompt design.
  const picked: SessionLike[] = stratifiedPick(pool, Math.max(1, want - 2));
  const taken = new Set(picked.map((p) => p.id));
  for (const cand of [...pool].sort((a, b) => b.turn_count - a.turn_count)) {
    if (picked.length >= want) break;
    if (!taken.has(cand.id)) {
      picked.push(cand);
      taken.add(cand.id);
    }
  }

  // Fill digests for any session that does not have one stored yet.
  const missing = picked.filter((p) => !p.digest).map((p) => p.id);
  if (missing.length) {
    const msgs = await query<TranscriptRow>(
      `select session_id, seq, role, content_text, occurred_at, extra
       from messages
       where session_id = any($1::uuid[])
       order by seq`,
      [missing],
    );
    const bySession = new Map<string, TranscriptRow[]>();
    for (const m of msgs) {
      const arr = bySession.get(m.session_id) ?? [];
      arr.push(m);
      bySession.set(m.session_id, arr);
    }
    for (const s of picked) {
      if (!s.digest) s.digest = buildDigest(bySession.get(s.id) ?? []);
    }
  }

  // -------- user layer: prefer users with several sessions
  const counted = await query<{ user_key: string; n: number }>(
    `select user_key, count(*)::int as n
     from sessions
     where data_source_id = $1
     group by user_key
     order by n desc, user_key
     limit $2`,
    [dataSourceId, Math.max(opts.userSamples, 2)],
  );
  const topUsers = counted.map((r) => r.user_key);

  const usersDetail: SampleLayers["usersDetail"] = [];
  if (topUsers.length) {
    const userSessions = await query<{
      user_key: string;
      session_key: string;
      digest: string | null;
      turn_count: number;
      started_at: string | null;
    }>(
      `select user_key, session_key, digest, turn_count, started_at
       from sessions
       where data_source_id = $1 and user_key = any($2::text[])
       order by started_at
       limit 400`,
      [dataSourceId, topUsers],
    );

    for (const key of topUsers) {
      const rows = userSessions.filter((r) => r.user_key === key);
      const sessionKeys = rows.map((r) => r.session_key);
      const sampled =
        rows.length > 4
          ? [rows[0], rows[Math.floor(rows.length / 3)], rows[Math.floor((rows.length * 2) / 3)], rows[rows.length - 1]]
          : rows;
      const digests = sampled
        .map((r) => `(${r.session_key}) ${truncate(String(r.digest ?? ""), 1600)}`)
        .filter((d) => d.length > 8);
      usersDetail.push({ user_key: key, session_count: sessionKeys.length, digests, session_keys: sessionKeys });
    }
  }

  const [overview, hist] = await Promise.all([
    callJson<JsonObject>("source_overview", [dataSourceId]),
    callJson<{ key: string; values: { name: string; value: number }[] }[]>("extra_histogram", [
      dataSourceId,
      20,
    ]),
  ]);

  const histogram = (hist ?? []).map((h) => ({
    key: h.key,
    values: (h.values ?? []).slice(0, 16),
  }));

  const o = (overview ?? {}) as JsonObject & Record<string, unknown>;

  const withDigest: SampledSession[] = picked.map((s) => ({
    id: s.id,
    session_key: s.session_key,
    user_key: s.user_key,
    started_at: s.started_at,
    turn_count: s.turn_count,
    audio_count: s.audio_count,
    digest: s.digest ?? "",
    extra: (s.extra ?? {}) as JsonObject,
  }));

  return {
    rawSessions: withDigest,
    sessions: withDigest.map((s) => ({
      session_key: s.session_key,
      user_key: s.user_key,
      started_at: s.started_at,
      turn_count: s.turn_count,
      digest: s.digest,
      extra: s.extra ?? {},
      audios: s.audio_count,
    })),
    users: usersDetail.map((u) => ({
      user_key: u.user_key,
      session_count: u.session_count,
      digests: u.digests,
    })),
    usersDetail,
    global: {
      session_count: num(o.session_count ?? o.sessions),
      user_count: num(o.users),
      message_count: num(o.messages),
      audio_count: num(o.audios),
      extra_histogram: histogram,
    },
    histogram,
    overview: o,
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function buildDigest(rows: { seq: number; role: string; content_text: string; occurred_at: string | null; extra?: JsonObject }[]): string {
  const t0 = rows.find((r) => r.occurred_at)?.occurred_at;
  return rows
    .map((r) => {
      const speaker = r.role === "user" ? "用户" : r.role === "assistant" ? "AI" : r.role;
      const offset =
        t0 && r.occurred_at
          ? `[${fmtOffset(Date.parse(r.occurred_at) - Date.parse(t0))}] `
          : "";
      return `${offset}${speaker}: ${truncate(r.content_text ?? "", 400)}`;
    })
    .join("\n");
}

function fmtOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Load full transcripts for an explicit set of session ids. */
export async function loadSessions(sessionIds: string[], opts: { maxDigestChars?: number } = {}) {
  if (!sessionIds.length) return [];
  const rows = await query<Omit<SampledSession, "digest"> & { digest: string | null }>(
    `select id, data_source_id, session_key, user_key, started_at, ended_at, turn_count,
            audio_count, extra, digest
     from sessions
     where id = any($1::uuid[])`,
    [sessionIds],
  );

  const needDigest = rows.filter((r) => !r.digest).map((r) => r.id);
  const bySession = new Map<string, TranscriptRow[]>();
  if (needDigest.length) {
    const msgs = await query<TranscriptRow>(
      `select session_id, seq, role, content_text, occurred_at, extra
       from messages
       where session_id = any($1::uuid[])
       order by seq`,
      [needDigest.slice(0, 500)],
    );
    for (const m of msgs) {
      const arr = bySession.get(m.session_id) ?? [];
      arr.push(m);
      bySession.set(m.session_id, arr);
    }
  }

  const max = opts.maxDigestChars ?? 24000;
  return rows.map((r) => ({
    ...r,
    digest: r.digest ? r.digest.slice(0, max) : buildDigest(bySession.get(r.id) ?? []).slice(0, max),
    extra: (r.extra ?? {}) as JsonObject,
  }));
}

export interface TranscriptRow {
  session_id: string;
  seq: number;
  role: string;
  content_text: string;
  occurred_at: string | null;
  extra?: JsonObject;
}

/** Audio objects (path + format) attached to a session, for multimodal input. */
export async function loadSessionAudio(sessionId: string, limit: number) {
  return query<{
    seq: number;
    role: string;
    audio_path: string;
    audio_format: string | null;
    content_text: string;
  }>(
    `select seq, role, audio_path, audio_format, content_text
     from messages
     where session_id = $1 and audio_path is not null
     order by seq
     limit $2`,
    [sessionId, limit],
  );
}

export type { ExtraFieldDef };
