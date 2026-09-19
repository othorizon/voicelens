import type { SupabaseClient } from "@supabase/supabase-js";
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
  supabase: SupabaseClient,
  dataSourceId: string,
  options: ScopeOptions,
): Promise<ScopeSelection> {
  const limit = options.limit > 0 ? options.limit : 100000;

  if (options.mode === "range") {
    let query = supabase
      .from("sessions")
      .select("id")
      .eq("data_source_id", dataSourceId)
      .order("started_at", { ascending: true })
      .limit(limit);
    if (options.rangeStart) query = query.gte("started_at", options.rangeStart);
    if (options.rangeEnd) query = query.lte("started_at", options.rangeEnd);
    const { data } = await query;
    const ids = (data ?? []).map((r) => r.id as string);
    return { sessionIds: ids, mode: "range", totalAvailable: ids.length };
  }

  const { data } = await supabase.rpc("unanalyzed_session_ids", {
    p_data_source_id: dataSourceId,
    p_limit: limit,
  });
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  const { count } = await supabase
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .eq("data_source_id", dataSourceId);
  return { sessionIds: ids, mode: "incremental", totalAvailable: count ?? ids.length };
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
  supabase: SupabaseClient,
  dataSourceId: string,
  opts: { sessionSamples: number; userSamples: number },
): Promise<SampleLayers> {
  const want = Math.max(3, Math.min(opts.sessionSamples, 12));

  const { data: head } = await supabase
    .from("sessions")
    .select("id, session_key, user_key, started_at, ended_at, turn_count, audio_count, digest, extra")
    .eq("data_source_id", dataSourceId)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(Math.max(want * 8, 120));

  const pool = (head ?? []) as SessionLike[];

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
    const { data: msgs } = await supabase
      .from("messages")
      .select("session_id, seq, role, content_text, occurred_at, extra")
      .in("session_id", missing)
      .order("seq", { ascending: true });
    const bySession = new Map<string, typeof msgs>();
    for (const m of msgs ?? []) {
      const arr = bySession.get(m.session_id as string) ?? [];
      arr.push(m);
      bySession.set(m.session_id as string, arr);
    }
    for (const s of picked) {
      if (!s.digest) s.digest = buildDigest(bySession.get(s.id) ?? []);
    }
  }

  // -------- user layer: prefer users with several sessions
  const { data: userRows } = await supabase
    .from("sessions")
    .select("user_key")
    .eq("data_source_id", dataSourceId);

  const counts = new Map<string, number>();
  for (const r of userRows ?? []) {
    const k = r.user_key as string;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const topUsers = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(opts.userSamples, 2))
    .map(([k]) => k);

  const usersDetail: SampleLayers["usersDetail"] = [];
  if (topUsers.length) {
    const { data: userSessions } = await supabase
      .from("sessions")
      .select("user_key, session_key, digest, turn_count, started_at")
      .eq("data_source_id", dataSourceId)
      .in("user_key", topUsers)
      .order("started_at", { ascending: true })
      .limit(400);

    for (const key of topUsers) {
      const rows = (userSessions ?? []).filter((r) => r.user_key === key);
      const sessionKeys = rows.map((r) => r.session_key as string);
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

  const [{ data: overview }, { data: hist }] = await Promise.all([
    supabase.rpc("source_overview", { p_data_source_id: dataSourceId }),
    supabase.rpc("extra_histogram", { p_data_source_id: dataSourceId, p_max_values: 20 }),
  ]);

  const histogram = ((hist ?? []) as { key: string; values: { name: string; value: number }[] }[]).map(
    (h) => ({ key: h.key, values: (h.values ?? []).slice(0, 16) }),
  );

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
export async function loadSessions(
  supabase: SupabaseClient,
  sessionIds: string[],
  opts: { maxDigestChars?: number } = {},
) {
  if (!sessionIds.length) return [];
  const { data } = await supabase
    .from("sessions")
    .select("id, data_source_id, session_key, user_key, started_at, ended_at, turn_count, audio_count, extra, digest")
    .in("id", sessionIds);
  const rows = (data ?? []) as (Omit<SampledSession, "digest"> & { digest: string | null })[];

  const needDigest = rows.filter((r) => !r.digest).map((r) => r.id);
  let bySession = new Map<string, TranscriptRow[]>();
  if (needDigest.length) {
    const { data: msgs } = await supabase
      .from("messages")
      .select("session_id, seq, role, content_text, occurred_at, extra")
      .in("session_id", needDigest.slice(0, 500))
      .order("seq", { ascending: true });
    for (const m of msgs ?? []) {
      const arr = bySession.get(m.session_id as string) ?? [];
      arr.push(m as TranscriptRow);
      bySession.set(m.session_id as string, arr);
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
export async function loadSessionAudio(
  supabase: SupabaseClient,
  sessionId: string,
  limit: number,
) {
  const { data } = await supabase
    .from("messages")
    .select("seq, role, audio_path, audio_format, content_text")
    .eq("session_id", sessionId)
    .not("audio_path", "is", null)
    .order("seq", { ascending: true })
    .limit(limit);
  return (data ?? []) as {
    seq: number;
    role: string;
    audio_path: string;
    audio_format: string | null;
    content_text: string;
  }[];
}

export type { ExtraFieldDef };
