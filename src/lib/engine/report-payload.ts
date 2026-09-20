import { buildDataProfile } from "./report-profile";
import type { ReportPayload, ReportSessionRow, ReportUserRow } from "./report-runtime";
import type { GroundTruth } from "./ground-truth";
import type { AudioUsage, GlobalAnalysis, JsonObject, SessionAnalysis, UserAnalysis } from "@/lib/types";

/**
 * Everything a report page is handed, assembled the same way for a preview
 * and for a full run.
 *
 * Keeping one builder is what makes a preview worth looking at: the page sees
 * the same field names, the same shapes and the same profile in both, so a
 * design that works on the sample is a design that works on the run. It lives
 * apart from the stage that calls it only because the stage reaches into the
 * database and a preview never does.
 */

/** How many detail rows ride along inside the page itself. */
export const INLINE_USERS = 100;
export const INLINE_SESSIONS = 100;

export function toUserRow(u: { user_key: string; result: UserAnalysis }): ReportUserRow {
  return {
    user_key: u.user_key,
    persona: u.result.persona ?? "",
    summary: u.result.summary ?? "",
    session_count: u.result.session_count ?? 0,
    risk_level: u.result.risk_level ?? "none",
    tags: u.result.tags ?? [],
    metrics: u.result.metrics ?? [],
  };
}

export function toSessionRow(s: {
  session_key: string;
  user_key: string;
  started_at?: string | null;
  turn_count?: number;
  result: SessionAnalysis;
}): ReportSessionRow {
  return {
    session_key: s.session_key,
    user_key: s.user_key,
    started_at: s.started_at ?? null,
    turn_count: s.turn_count ?? s.result.metrics?.find((m) => m.key === "turns")?.value ?? 0,
    summary: s.result.summary ?? "",
    intent: s.result.intent ?? "",
    outcome: s.result.outcome ?? "",
    sentiment: s.result.sentiment ?? "",
    quality_score: typeof s.result.quality_score === "number" ? s.result.quality_score : null,
    risk_level: s.result.risk_level ?? "none",
    tags: s.result.tags ?? [],
  };
}

export interface BuildPayloadInput {
  title: string;
  taskName: string;
  templateVersion: number | null;
  scopeNote: string;
  language: string;
  tone: string;
  includeEvidence: boolean;
  sessionResults: {
    session_key: string;
    user_key: string;
    started_at?: string | null;
    turn_count?: number;
    result: SessionAnalysis;
  }[];
  userResults: { user_key: string; result: UserAnalysis }[];
  globalResult: GlobalAnalysis | JsonObject;
  stats: JsonObject;
  distributions: { key: string; label: string; unit?: string; items: { name: string; value: number }[] }[];
  groundTruth: GroundTruth | null;
  evidence: ReportPayload["evidence"];
  messages: number;
  audio?: AudioUsage;
  models?: JsonObject;
  /** Rows reachable by paging, when that is more than what is inlined. */
  available?: { users?: number; sessions?: number };
}

export function buildReportPayload(input: BuildPayloadInput): ReportPayload {
  return {
    meta: {
      title: input.title,
      scopeNote: input.scopeNote,
      generatedAt: new Date().toISOString(),
      taskName: input.taskName,
      templateVersion: input.templateVersion,
      language: input.language,
      tone: input.tone,
      includeEvidence: input.includeEvidence,
      audio: input.audio as JsonObject | undefined,
      models: input.models,
    },
    profile: buildDataProfile({
      sessionResults: input.sessionResults,
      userResults: input.userResults,
      messages: input.messages,
      available: {
        users: input.available?.users ?? input.userResults.length,
        sessions: input.available?.sessions ?? input.sessionResults.length,
      },
    }),
    groundTruth: input.groundTruth,
    global: input.globalResult,
    stats: input.stats,
    distributions: input.distributions,
    evidence: input.includeEvidence ? input.evidence : [],
    users: {
      rows: input.userResults.slice(0, INLINE_USERS).map(toUserRow),
      total: input.available?.users ?? input.userResults.length,
    },
    sessions: {
      rows: input.sessionResults.slice(0, INLINE_SESSIONS).map(toSessionRow),
      total: input.available?.sessions ?? input.sessionResults.length,
    },
  };
}
