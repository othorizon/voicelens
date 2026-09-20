import { callJson, execute, maybeOne, query } from "@/lib/db";
import { generateReport } from "./analyze";
import { buildDrillData, collectEvidence, computeStats, extraHistogramForSessions } from "./plan";
import { deriveGroundTruth, type GroundTruth } from "./ground-truth";
import { renderReportHtml } from "./report-html";
import { buildDataProfile } from "./report-profile";
import { generateReportPage } from "./report-generate";
import { composeReportDocument, type ReportPayload, type ReportSessionRow, type ReportUserRow } from "./report-runtime";
import type { ValidationResult } from "./report-validate";
import type { AnalysisRuntime } from "@/lib/models/registry";
import type { WorkflowConfig } from "@/lib/workflow/definition";
import type {
  AudioUsage,
  ExtraFieldDef,
  GlobalAnalysis,
  JsonObject,
  ReportSpec,
  SessionAnalysis,
  UserAnalysis,
} from "@/lib/types";

/**
 * The report stage, on its own.
 *
 * It used to be the tail of `runTask`, holding everything it needed in local
 * variables — which meant a page that failed to generate took hours of
 * completed three-layer analysis down with it. Everything it reads is already
 * in the database by the time it runs, so it reads from there instead, and a
 * rerun is the same call with nothing else repeated.
 *
 * Both paths load identically on purpose. A rerun that assembled its inputs
 * differently from the original would eventually disagree with it, and the
 * disagreement would surface as a report nobody could explain.
 */

export interface ReportStageInputs {
  task: {
    id: string;
    name: string;
    scope_type: string;
    range_start: string | null;
    range_end: string | null;
    created_by: string | null;
    data_source_id: string;
    template_id: string | null;
  };
  brief: string;
  templateVersion: number | null;
  extraSchema: ExtraFieldDef[];
  sessionResults: { session_pk: string; session_key: string; user_key: string; result: SessionAnalysis }[];
  userResults: { user_key: string; result: UserAnalysis }[];
  globalResult: GlobalAnalysis;
}

export interface ReportStageResult {
  /** What was stored and will be served. */
  document: string;
  /** Which path produced it: the generated page, or the block renderer. */
  engine: "page" | "spec";
  spec: ReportSpec | null;
  validation?: ValidationResult;
  attempts: number;
  tokens: number;
  /** Ground-truth corrections, only meaningful on the spec path. */
  overrides: number;
  screenshot?: Buffer;
}

/* ------------------------------------------------------------------- load */

export async function loadReportStageInputs(taskId: string): Promise<ReportStageInputs> {
  const task = await maybeOne<ReportStageInputs["task"]>(
    `select id, name, scope_type, range_start, range_end, created_by, data_source_id, template_id
     from analysis_tasks where id = $1`,
    [taskId],
  );
  if (!task) throw new Error("任务不存在");

  const tpl = task.template_id
    ? await maybeOne<{ version: number; report_prompt: string }>(
        `select version, report_prompt from analysis_templates where id = $1`,
        [task.template_id],
      )
    : null;

  const source = await maybeOne<{ extra_schema: JsonObject }>(
    `select extra_schema from data_sources where id = $1`,
    [task.data_source_id],
  );

  const sessionResults = await query<{ session_pk: string; session_key: string; user_key: string; result: SessionAnalysis }>(
    `select session_pk, session_key, user_key, result
     from task_session_results
     where task_id = $1 and status = 'success' and result is not null
     order by session_key`,
    [taskId],
  );

  const userResults = await query<{ user_key: string; result: UserAnalysis }>(
    `select user_key, result
     from task_user_results
     where task_id = $1 and status in ('success', 'degraded') and result is not null
     order by session_count desc, user_key`,
    [taskId],
  );

  const global = await maybeOne<{ result: GlobalAnalysis }>(
    `select result from task_global_result where task_id = $1 and result is not null`,
    [taskId],
  );

  if (!sessionResults.length) throw new Error("该任务没有成功的会话层结果，无法生成报告");
  if (!global?.result) throw new Error("该任务缺少全局层结论，无法生成报告");

  return {
    task,
    brief: tpl?.report_prompt ?? "",
    templateVersion: tpl?.version ?? null,
    extraSchema: (source?.extra_schema as ExtraFieldDef[]) ?? [],
    sessionResults,
    userResults,
    globalResult: global.result,
  };
}

/* ---------------------------------------------------------------- payload */

function userRow(u: { user_key: string; result: UserAnalysis }): ReportUserRow {
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

function sessionRow(s: { session_key: string; user_key: string; result: SessionAnalysis }): ReportSessionRow {
  return {
    session_key: s.session_key,
    user_key: s.user_key,
    started_at: null,
    turn_count: s.result.metrics?.find((m) => m.key === "turns")?.value ?? 0,
    summary: s.result.summary ?? "",
    intent: s.result.intent ?? "",
    outcome: s.result.outcome ?? "",
    sentiment: s.result.sentiment ?? "",
    quality_score: typeof s.result.quality_score === "number" ? s.result.quality_score : null,
    risk_level: s.result.risk_level ?? "none",
    tags: s.result.tags ?? [],
  };
}

/** How many detail rows ride along in the page itself. */
const INLINE_USERS = 100;
const INLINE_SESSIONS = 100;

export async function buildReportPayload(input: {
  inputs: ReportStageInputs;
  config: WorkflowConfig;
  scopeNote: string;
  stats: JsonObject;
  distributions: { key: string; label: string; unit?: string; items: { name: string; value: number }[] }[];
  groundTruth: GroundTruth | null;
  audio?: AudioUsage;
  models?: JsonObject;
}): Promise<ReportPayload> {
  const { inputs, config } = input;
  const messages = inputs.sessionResults.reduce(
    (n, r) => n + (r.result.metrics?.find((m) => m.key === "turns")?.value ?? 0),
    0,
  );

  return {
    meta: {
      title: inputs.task.name || "分析报告",
      scopeNote: input.scopeNote,
      generatedAt: new Date().toISOString(),
      taskName: inputs.task.name,
      templateVersion: inputs.templateVersion,
      language: config.report.language,
      tone: config.report.tone,
      includeEvidence: config.report.includeEvidence,
      audio: input.audio as JsonObject | undefined,
      models: input.models,
    },
    profile: buildDataProfile({
      sessionResults: inputs.sessionResults,
      userResults: inputs.userResults,
      messages,
      available: { users: inputs.userResults.length, sessions: inputs.sessionResults.length },
    }),
    groundTruth: input.groundTruth,
    global: inputs.globalResult,
    stats: input.stats,
    distributions: input.distributions,
    evidence: config.report.includeEvidence ? collectEvidence(inputs.sessionResults) : [],
    users: {
      rows: inputs.userResults.slice(0, INLINE_USERS).map(userRow),
      total: inputs.userResults.length,
    },
    sessions: {
      rows: inputs.sessionResults.slice(0, INLINE_SESSIONS).map(sessionRow),
      total: inputs.sessionResults.length,
    },
  };
}

/* -------------------------------------------------------------------- run */

export async function runReportStage(input: {
  taskId: string;
  runtime: AnalysisRuntime;
  config: WorkflowConfig;
  audio?: AudioUsage;
  models?: JsonObject;
  onStep?: (message: string) => void;
  /** Persist the result onto the task row and task_reports. */
  persist?: boolean;
}): Promise<ReportStageResult> {
  const step = input.onStep ?? (() => {});
  const inputs = await loadReportStageInputs(input.taskId);

  step("汇总报告输入");
  const sessionStats = await callJson<JsonObject>("task_session_stats", [input.taskId, "all", null]);
  const distributions = await extraHistogramForSessions(inputs.sessionResults.map((r) => r.session_pk));
  const stats = Object.assign({}, computeStats(inputs.sessionResults), { from_db: sessionStats ?? null });

  const messages = inputs.sessionResults.reduce(
    (n, r) => n + (r.result.metrics?.find((m) => m.key === "turns")?.value ?? 0),
    0,
  );
  const groundTruth = deriveGroundTruth(distributions, inputs.extraSchema, {
    sessions: inputs.sessionResults.length,
    messages,
  });

  const scopeNote = describeScope(inputs, inputs.sessionResults.length, inputs.userResults.length);
  const payload = await buildReportPayload({
    inputs,
    config: input.config,
    scopeNote,
    stats,
    distributions: distributions.map((d) => ({
      key: d.key,
      label: d.key,
      items: d.values,
    })),
    groundTruth,
    audio: input.audio,
    models: input.models,
  });

  const generated = await generateReportPage({
    runtime: input.runtime,
    brief: inputs.brief,
    payload,
    onStep: step,
  });

  let result: ReportStageResult;
  if (generated.validation.ok) {
    result = {
      document: generated.document,
      engine: "page",
      spec: null,
      validation: generated.validation,
      attempts: generated.attempts,
      tokens: generated.tokens,
      overrides: 0,
      screenshot: generated.screenshot,
    };
  } else {
    // Generation had its tries and the page still does not render. The block
    // renderer is not as good a report, but it is a report.
    step("页面生成未通过校验，回退到内置渲染器");
    result = await renderWithSpecEngine({
      inputs,
      runtime: input.runtime,
      config: input.config,
      scopeNote,
      stats,
      distributions,
      groundTruth,
      audio: input.audio,
      extraTokens: generated.tokens,
    });
    result.validation = generated.validation;
    result.attempts = generated.attempts;
  }

  if (input.persist !== false) {
    await execute(
      `insert into task_reports (task_id, kind, title, report, html, created_by)
       values ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        input.taskId,
        result.engine === "page" ? "final" : "final-fallback",
        payload.meta.title,
        result.spec ? JSON.stringify(result.spec) : null,
        result.document,
        inputs.task.created_by,
      ],
    );
    await execute(
      `update analysis_tasks set report = $2::jsonb, report_html = $3 where id = $1`,
      [input.taskId, result.spec ? JSON.stringify(result.spec) : null, result.document],
    );
  }

  return result;
}

/* --------------------------------------------------------------- fallback */

async function renderWithSpecEngine(input: {
  inputs: ReportStageInputs;
  runtime: AnalysisRuntime;
  config: WorkflowConfig;
  scopeNote: string;
  stats: JsonObject;
  distributions: { key: string; values: { name: string; value: number }[] }[];
  groundTruth: GroundTruth;
  audio?: AudioUsage;
  extraTokens: number;
}): Promise<ReportStageResult> {
  const { inputs, config } = input;
  const topUsers = inputs.userResults.slice(0, Math.max(1, config.report.topUsers));

  const { spec, tokens, overrides } = await generateReport({
    template: { report_prompt: inputs.brief } as never,
    runtime: input.runtime,
    title: inputs.task.name || "分析报告",
    scopeNote: input.scopeNote,
    globalResult: inputs.globalResult as unknown as JsonObject,
    userResults: topUsers.map((u) => ({ user_key: u.user_key, result: u.result as unknown as JsonObject })),
    sessionStats: input.stats,
    distributions: input.distributions,
    groundTruth: input.groundTruth,
    language: config.report.language,
    includeEvidence: config.report.includeEvidence,
    tone: config.report.tone,
    targetSections: config.report.sections,
    evidence: collectEvidence(inputs.sessionResults),
  });

  const sessions = await query<{
    session_key: string;
    user_key: string;
    started_at: string | null;
    turn_count: number;
    digest: string | null;
  }>(
    `select session_key, user_key, started_at, turn_count, digest
     from sessions where id = any($1::uuid[]) limit 400`,
    [inputs.sessionResults.slice(0, 400).map((r) => r.session_pk)],
  );

  const drill = buildDrillData(
    sessions.map((s) => ({ ...s, digest: s.digest ?? "" })),
    inputs.sessionResults.map((r) => ({ session_key: r.session_key, user_key: r.user_key, result: r.result })),
    topUsers,
  );
  drill.users = drill.users.filter((u) => topUsers.some((t) => t.user_key === u.user_key));

  const html = renderReportHtml({
    spec,
    drill,
    generatedAt: new Date().toISOString(),
    scopeNote: input.scopeNote,
    templateVersion: inputs.templateVersion,
    taskName: inputs.task.name,
    audio: input.audio,
  });

  return {
    document: html,
    engine: "spec",
    spec,
    attempts: 0,
    tokens: tokens + input.extraTokens,
    overrides: overrides.length,
  };
}

/* ---------------------------------------------------------------- helpers */

function describeScope(inputs: ReportStageInputs, sessions: number, users: number): string {
  const t = inputs.task;
  const mode = t.scope_type === "range" ? "时间范围" : "增量未分析";
  const range =
    t.scope_type === "range" && (t.range_start || t.range_end)
      ? ` ${(t.range_start ?? "—").slice(0, 10)} ~ ${(t.range_end ?? "—").slice(0, 10)}`
      : "";
  return `${mode}${range} · ${sessions} 会话 · ${users} 用户`;
}

/** Re-export so callers do not need to know how a document is assembled. */
export { composeReportDocument };
