/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;
export type JsonObject = Record<string, any>;

/** Marker mixed into persisted shapes so they can be stored as jsonb. */
export interface Jsonish {
  [key: string]: any;
}

/* ------------------------------------------------------------- extra schema */

export type ExtraFieldKind = "enum" | "sentiment" | "boolean" | "number" | "text";
export type ExtraFieldUsage =
  | "metric"        // participate in aggregate statistics
  | "segment"       // used as a grouping dimension
  | "context"       // passed to the model as narrative context only
  | "filter";       // used to exclude/include records

export interface ExtraFieldDef {
  [key: string]: any;
  name: string;
  label: string;
  kind: ExtraFieldKind;
  scope: "message" | "session";
  /** Allowed values for enum/sentiment/boolean kinds. */
  options?: string[];
  description?: string;
  usage: ExtraFieldUsage;
  /** polarity mapping so charts can colour good vs bad */
  positive?: boolean;
}

/* ----------------------------------------------------------------- messages */

export interface SessionRow {
  id: string;
  data_source_id: string;
  session_key: string;
  user_key: string;
  started_at: string | null;
  ended_at: string | null;
  turn_count: number;
  human_turn_count: number;
  ai_turn_count: number;
  audio_count: number;
  char_count: number;
  extra: JsonObject;
  digest: string | null;
  created_at: string;
}

/* -------------------------------------------------------------- AI results */

export interface MetricPoint {
  [key: string]: any;
  key: string;
  label: string;
  value: number;
  unit?: string;
}

export interface SessionAnalysis {
  [key: string]: any;
  summary: string;
  intent: string;
  outcome: string;
  sentiment: string;
  quality_score: number;
  risk_level: "none" | "low" | "medium" | "high";
  tags: string[];
  metrics: MetricPoint[];
  highlights: string[];
  problems: string[];
  evidence: { quote: string; role?: string; seq?: number }[];
  extra?: JsonObject;
}

export interface UserAnalysis {
  [key: string]: any;
  summary: string;
  session_count: number;
  persona: string;
  needs: string[];
  behaviour: string[];
  metrics: MetricPoint[];
  risk_level: "none" | "low" | "medium" | "high";
  tags: string[];
  key_sessions: string[];
}

export interface GlobalAnalysis {
  [key: string]: any;
  summary: string;
  findings: { title: string; detail: string; severity: "info" | "warning" | "critical"; metric?: string }[];
  metrics: MetricPoint[];
  distributions: { key: string; label: string; unit?: string; items: { name: string; value: number }[] }[];
  recommendations: { title: string; detail: string; priority: "high" | "medium" | "low"; impact?: string }[];
}

/* ------------------------------------------------------------------- report */

export type BlockKind =
  | "kpis"
  | "markdown"
  | "bar"
  | "line"
  | "pie"
  | "radar"
  | "hbar"
  | "scatter"
  | "table"
  | "callout"
  | "list"
  | "divider";

export interface ChartSeries {
  name: string;
  data: number[];
}

export interface ReportBlock {
  [key: string]: any;
  id?: string;
  kind: BlockKind;
  title?: string;
  caption?: string;
  unit?: string;
  /** markdown for `markdown`; array of strings for `list`; text for `callout` */
  text?: string;
  items?: string[];
  categories?: string[];
  series?: ChartSeries[];
  kpis?: {
    label: string;
    value: string | number;
    unit?: string;
    delta?: number | null;
    hint?: string;
    tone?: "default" | "good" | "warn" | "bad";
    /** extra field this KPI is computed from; binds it to the SQL ground truth. */
    source_field?: string;
  }[];
  table?: { columns: string[]; rows: (string | number)[][] };
  tone?: "info" | "warning" | "critical" | "success";
  columns?: number;
}

export interface ReportSection {
  [key: string]: any;
  /** Set by the platform for sections it computes itself, not for model output. */
  origin?: "platform" | "model";
  id: string;
  title: string;
  summary?: string;
  blocks: ReportBlock[];
  /** Drill-down anchors: global -> users -> sessions */
  drill?: { users?: string[]; sessions?: string[] };
}

export interface ReportSpec {
  [key: string]: any;
  title: string;
  subtitle?: string;
  meta?: { label: string; value: string }[];
  hero?: { headline: string; summary: string; kpis?: ReportBlock["kpis"] };
  sections: ReportSection[];
  level: "global" | "user" | "session";
}

/* --------------------------------------------------------- templates/tasks */

export interface TemplateSnapshot {
  session_prompt: string;
  user_prompt: string;
  global_prompt: string;
  metric_schema: { session: string[]; user: string[]; global: string[] };
  report_prompt: string;
  report_spec: JsonObject;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "aggregating"
  | "reporting"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStage =
  | "queued"
  | "collect"
  | "session_analysis"
  | "user_aggregation"
  | "global_aggregation"
  | "report_generation"
  | "done";

/**
 * Whether a run actually listened to anything.
 *
 * Audio degrades silently by design — the prompt tells the model to fall back
 * to the transcript when a clip will not load — so "switch was off", "switch
 * was on but nothing reached the model" and "it listened to 1847 clips" all
 * produce a report that reads the same. These counters are what tells them
 * apart, and they are recorded whether the switch was on or off.
 */
export interface AudioUsage {
  /** The 「送入音频」 switch on the analysis node. */
  enabled: boolean;
  /** Per-session cap that was in force. */
  maxPerSession: number;
  /** Sessions that got at least one clip attached. */
  sessionsWithAudio: number;
  /** Sessions the run covered, for the denominator. */
  sessionsTotal: number;
  /** Clips actually attached to a prompt. */
  clipsAttached: number;
  /** Clips the database had a path for, but that could not be signed. */
  clipsUnavailable: number;
}

/** One-line rendering of {@link AudioUsage}, for a report chip or a task page. */
export function describeAudioUsage(u: AudioUsage): string {
  const n = (v: number) => v.toLocaleString("en-US");
  if (!u.enabled) return "未启用（纯文本分析）";
  if (u.clipsAttached === 0) {
    return u.clipsUnavailable > 0
      ? `已启用，但 ${n(u.clipsUnavailable)} 段全部未取到`
      : "已启用，但数据中没有音频";
  }
  const missing = u.clipsUnavailable > 0 ? `，${n(u.clipsUnavailable)} 段未取到` : "";
  return `已启用 · ${n(u.sessionsWithAudio)}/${n(u.sessionsTotal)} 会话 · ${n(u.clipsAttached)} 段${missing}`;
}
