import { callJson, execute, maybeOne, one, query } from "@/lib/db";
import { generateReport } from "./analyze";
import { buildDrillData, collectEvidence, computeStats, extraHistogramForSessions } from "./plan";
import { deriveGroundTruth, type GroundTruth } from "./ground-truth";
import { renderReportHtml } from "./report-html";
import { generateReportPage } from "./report-generate";
import { reviseReportPage } from "./report-revise";
import { buildReportPayload } from "./report-payload";
import { composeReportDocument } from "./report-runtime";
import { renderIssues, type ValidationResult } from "./report-validate";
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
  /**
   * The model's page before the runtime was injected — what a later revision
   * starts from. Null on the block-renderer path, which has no page source.
   */
  page: string | null;
  /** Which path produced it: the generated page, or the block renderer. */
  engine: "page" | "spec";
  spec: ReportSpec | null;
  validation?: ValidationResult;
  attempts: number;
  tokens: number;
  /** Ground-truth corrections, only meaningful on the spec path. */
  overrides: number;
  /** How a revision changed the page, when this run was one. */
  mode?: "patch" | "rewrite" | "mixed" | "none";
  /** The row in `task_reports`, when this run persisted one. */
  reportId?: string;
  /** Its number in the task's report history. */
  version?: number;
}

/** A note asking for a specific change to the report that already exists. */
export interface ReportRevision {
  feedback: string;
  /** The page to change, as stored on `task_reports.page`. */
  basePage: string;
  /** Which version it came from, recorded as the new version's parent. */
  baseReportId: string | null;
}

/**
 * The newest stored version that can actually be revised.
 *
 * A report from the block renderer has no page source, and so does any report
 * produced before migration 006 — both have to be regenerated rather than
 * revised, and saying so up front beats failing three minutes into a model
 * call. `reportId` is returned even when the page is missing, so the caller can
 * name the version it could not use.
 */
export async function loadRevisionBase(
  taskId: string,
  reportId?: string | null,
): Promise<{ id: string; version: number | null; page: string | null; engine: string | null } | null> {
  return maybeOne<{ id: string; version: number | null; page: string | null; engine: string | null }>(
    reportId
      ? `select id, version, page, engine from task_reports where task_id = $1 and id = $2`
      : `select id, version, page, engine from task_reports
         where task_id = $1 order by version desc nulls last, created_at desc limit 1`,
    reportId ? [taskId, reportId] : [taskId],
  );
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
  /**
   * Change the report that exists instead of writing another one. The three
   * analysis layers are read the same way either way — a revision differs only
   * in where the page starts from.
   */
  revise?: ReportRevision;
  /**
   * Checked between the report loop's turns. The stage can now run for many
   * minutes, so whoever owns the task needs a way to say "stop".
   */
  shouldStop?: () => Promise<string | null>;
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
  const payload = buildReportPayload({
    title: inputs.task.name || "分析报告",
    taskName: inputs.task.name,
    templateVersion: inputs.templateVersion,
    scopeNote,
    language: input.config.report.language,
    tone: input.config.report.tone,
    includeEvidence: input.config.report.includeEvidence,
    sessionResults: inputs.sessionResults,
    userResults: inputs.userResults,
    globalResult: inputs.globalResult,
    stats,
    distributions: distributions.map((d) => ({ key: d.key, label: d.key, items: d.values })),
    groundTruth,
    evidence: collectEvidence(inputs.sessionResults),
    messages,
    audio: input.audio,
    models: input.models,
  });

  const revised = input.revise
    ? await reviseReportPage({
        runtime: input.runtime,
        brief: inputs.brief,
        payload,
        page: input.revise.basePage,
        feedback: input.revise.feedback,
        onStep: step,
        shouldStop: input.shouldStop,
      })
    : null;
  const generated =
    revised ??
    (await generateReportPage({
      runtime: input.runtime,
      brief: inputs.brief,
      payload,
      onStep: step,
      shouldStop: input.shouldStop,
    }));

  let result: ReportStageResult;
  if (generated.validation.ok) {
    result = {
      document: generated.document,
      page: generated.page,
      engine: "page",
      spec: null,
      validation: generated.validation,
      attempts: generated.attempts,
      tokens: generated.tokens,
      overrides: 0,
      mode: revised?.mode,
    };
  } else if (input.revise) {
    // A revision that could not be made to render must not silently become a
    // block-rendered report: the reviewer asked for a change to a page they
    // were otherwise keeping, and replacing it with a different report
    // altogether answers a question nobody asked.
    throw new Error(
      `按建议修改报告失败：改出来的页面没有通过渲染校验（${generated.attempts} 轮）。` +
        `原报告未被替换。${renderIssues(generated.validation.issues).slice(0, 600)}`,
    );
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
    // The version number is computed in the insert rather than read first, which
    // keeps it to one statement; `task_reports_task_version_key` is what
    // actually makes a duplicate impossible, because max + 1 under READ
    // COMMITTED would happily hand two concurrent inserts the same number.
    const stored = await one<{ id: string; version: number }>(
      `insert into task_reports
         (task_id, kind, title, report, html, page, engine, feedback, parent_id, validation, version, created_by)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb,
               (select coalesce(max(version), 0) + 1 from task_reports where task_id = $1), $11)
       returning id, version`,
      [
        input.taskId,
        reportKind(result.engine, Boolean(input.revise)),
        payload.meta.title,
        result.spec ? JSON.stringify(result.spec) : null,
        result.document,
        result.page,
        result.engine,
        input.revise?.feedback ?? "",
        input.revise?.baseReportId ?? null,
        JSON.stringify(summarizeValidation(result.validation)),
        inputs.task.created_by,
      ],
    );
    result.reportId = stored.id;
    result.version = stored.version;

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
    // The block renderer assembles a document from a spec; there is no model
    // page underneath it, so there is nothing a revision could start from.
    page: null,
    engine: "spec",
    spec,
    attempts: 0,
    tokens: tokens + input.extraTokens,
    overrides: overrides.length,
  };
}

/* ---------------------------------------------------------------- helpers */

/** What the row is called, so the history reads without decoding flags. */
function reportKind(engine: "page" | "spec", revised: boolean): string {
  if (engine === "spec") return "final-fallback";
  return revised ? "revision" : "final";
}

/**
 * The verdict, without the frames.
 *
 * `ValidationResult` carries the screenshots, which are megabytes of JPEG and
 * derived from the page stored beside it. What is worth keeping is why the
 * version was accepted.
 */
function summarizeValidation(validation: ValidationResult | undefined): JsonObject {
  if (!validation) return {};
  return {
    ok: validation.ok,
    stats: validation.stats as unknown as JsonObject,
    issues: validation.issues.map((i) => ({ level: i.level, kind: i.kind, message: i.message })),
  };
}

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
