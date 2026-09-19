import type { SupabaseClient } from "@supabase/supabase-js";
import { chatJson } from "./ai";
import { describeExtraSchema } from "./prompts";
import { resolveScope, loadSessions, loadSessionAudio } from "./sampler";
import {
  aggregateGlobal,
  aggregateUser,
  analyzeSession,
  generateReport,
  mapLimit,
  normalizeSessionResult,
  signedAudioUrls,
} from "./analyze";
import {
  buildDrillData,
  collectEvidence,
  computeStats,
  computeUserStats,
  type DataSourceLike,
} from "./plan";
import { renderReportHtml } from "./report-html";
import { deriveGroundTruth } from "./ground-truth";
import { extraHistogramForSessions } from "./plan";
import type {
  ExtraFieldDef,
  GlobalAnalysis,
  JsonObject,
  ReportSpec,
  SessionAnalysis,
  UserAnalysis,
} from "@/lib/types";
import type { WorkflowConfig } from "@/lib/workflow/definition";

export interface TaskRow {
  id: string;
  name: string;
  data_source_id: string;
  scope_type: string;
  range_start: string | null;
  range_end: string | null;
  config: JsonObject;
  template: {
    version: number;
    session_prompt: string;
    user_prompt: string;
    global_prompt: string;
    report_prompt: string;
  };
  dataSource: DataSourceLike;
  createdBy: string | null;
}

export interface RunOptions {
  workflowConfig: WorkflowConfig;
  onStage?: (stage: string, progress: JsonObject) => void;
}

export async function log(
  supabase: SupabaseClient,
  taskId: string,
  level: string,
  stage: string | null,
  message: string,
  payload?: JsonObject,
) {
  await supabase.from("task_logs").insert({
    task_id: taskId,
    level,
    stage,
    message: message.slice(0, 1900),
    payload: payload ?? null,
  });
}

export async function heartbeat(supabase: SupabaseClient, taskId: string, progress?: JsonObject) {
  await supabase
    .from("analysis_tasks")
    .update({ heartbeat_at: new Date().toISOString(), ...(progress ? { progress } : {}) })
    .eq("id", taskId);
}

/** Full pipeline: collect → session → user → global → report. */
export async function runTask(
  supabase: SupabaseClient,
  task: TaskRow,
  config: WorkflowConfig,
): Promise<void> {
  const taskId = task.id;
  const startedAt = new Date().toISOString();
  await supabase
    .from("analysis_tasks")
    .update({ status: "running", stage: "collect", started_at: startedAt, heartbeat_at: startedAt })
    .eq("id", taskId);
  await log(supabase, taskId, "info", "collect", "任务开始执行");

  try {
    /* ------------------------------------------------------- 1. scope */
    // The scope chosen when the task was launched wins over the workflow
    // default: the same flow can be run incrementally or over a time window.
    const mode = task.scope_type === "range" ? "range" : task.scope_type === "incremental" ? "incremental" : config.scope.mode;
    const scope = await resolveScope(supabase, task.data_source_id, {
      mode,
      rangeStart: task.range_start,
      rangeEnd: task.range_end,
      limit: config.scope.maxSessions,
    });

    if (!scope.sessionIds.length) {
      throw new Error(
        config.scope.mode === "incremental"
          ? "没有待分析的增量会话（所有会话都已在已完成的任务中分析过）"
          : "所选时间范围内没有会话数据",
      );
    }

    await supabase
      .from("analysis_tasks")
      .update({
        progress: { total: scope.sessionIds.length, done: 0, stage: "collect", mode: scope.mode },
      })
      .eq("id", taskId);
    await log(supabase, taskId, "info", "collect", `范围确定：${scope.sessionIds.length} 个会话（${scope.mode}）`, {
      mode: scope.mode,
      count: scope.sessionIds.length,
    });

    const extraHint = describeExtraSchema(task.dataSource.extra_schema as ExtraFieldDef[]);

    /* --------------------------------------------- 2. session 层分析 */
    await supabase.from("analysis_tasks").update({ stage: "session_analysis" } as never).eq("id", taskId);

    let done = 0;
    let succeeded = 0;
    let failed = 0;
    let tokens = 0;
    const results: { session_key: string; user_key: string; result: SessionAnalysis; session: SessionRecord }[] = [];

    const CHUNK = 40;
    for (let i = 0; i < scope.sessionIds.length; i += CHUNK) {
      await assertNotCancelled(supabase, taskId);
      const slice = scope.sessionIds.slice(i, i + CHUNK);
      const sessions = await loadSessions(supabase, slice, { maxDigestChars: config.session.maxDigestChars });

      const chunkResults = await mapLimit(sessions, config.session.concurrency, async (s) => {
        const session = s as unknown as SessionRecord;
        let lastError = "";
        for (let attempt = 0; attempt <= config.session.retries; attempt++) {
          try {
            const { result, tokens: used } = await analyzeSession({
              supabase,
              session,
              template: task.template,
              useAudio: config.session.useAudio,
              maxAudiosPerSession: config.session.maxAudiosPerSession,
              extraSchemaHint: extraHint,
            });
            tokens += used;
            return { ok: true as const, session, result, tokens: used };
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            await sleep(700 * (attempt + 1));
          }
        }
        return { ok: false as const, session, error: lastError };
      });

      const rows = chunkResults.map((r) => ({
        task_id: taskId,
        session_pk: r.session.id,
        session_key: r.session.session_key,
        user_key: r.session.user_key,
        status: r.ok ? "success" : "failed",
        result: r.ok ? (r.result as unknown as JsonObject) : null,
        error: r.ok ? null : (r.error ?? "unknown").slice(0, 800),
        tokens: r.ok ? r.tokens : 0,
      }));

      const { error: insErr } = await supabase.from("task_session_results").upsert(rows as never, {
        onConflict: "task_id,session_pk",
      });
      if (insErr) await log(supabase, taskId, "warn", "session_analysis", `写入结果失败: ${insErr.message}`);

      for (const r of chunkResults) {
        done++;
        if (r.ok) {
          succeeded++;
          results.push({ session_key: r.session.session_key, user_key: r.session.user_key, result: r.result, session: r.session });
        } else {
          failed++;
          if (failed <= 5) {
            await log(supabase, taskId, "warn", "session_analysis", `会话 ${r.session.session_key} 分析失败`, {
              error: (r.error ?? "").slice(0, 400),
            });
          }
        }
      }

      await heartbeat(supabase, taskId, {
        total: scope.sessionIds.length,
        done,
        succeeded,
        failed,
        tokens,
        stage: "session_analysis",
      });
      await log(
        supabase,
        taskId,
        "info",
        "session_analysis",
        `会话分析进度 ${done}/${scope.sessionIds.length}（成功 ${succeeded}，失败 ${failed}）`,
      );
    }

    if (!results.length) {
      throw new Error(`所有会话分析均失败（${failed} 个），请检查模型配置或提示词模板`);
    }

    /* ------------------------------------------------ 3. user 层汇总 */
    await supabase.from("analysis_tasks").update({ stage: "user_aggregation" } as never).eq("id", taskId);
    await log(supabase, taskId, "info", "user_aggregation", "开始用户层汇总");

    const byUser = new Map<string, { session_key: string; result: SessionAnalysis }[]>();
    for (const r of results) {
      byUser.set(r.user_key, [...(byUser.get(r.user_key) ?? []), { session_key: r.session_key, result: r.result }]);
    }

    const userKeys = [...byUser.keys()];
    await supabase
      .from("task_user_results")
      .upsert(
        userKeys.map((k) => ({
          task_id: taskId,
          user_key: k,
          session_count: (byUser.get(k) ?? []).length,
          status: "pending",
        })) as never,
        { onConflict: "task_id,user_key" },
      );

    let uDone = 0;
    const userAgg: { user_key: string; result: UserAnalysis }[] = [];
    const USER_CHUNK = 30;
    for (let i = 0; i < userKeys.length; i += USER_CHUNK) {
      await assertNotCancelled(supabase, taskId);
      const slice = userKeys.slice(i, i + USER_CHUNK);
      const chunk = await mapLimit(slice, config.user.concurrency, async (key) => {
        const all = byUser.get(key)!;
        const used = all.slice(0, config.user.maxSessionsPerUser);
        try {
          const { result } = await aggregateUser({ user_key: key, sessions: used }, task.template);
          return { key, result, error: null as string | null, n: all.length };
        } catch (e) {
          return {
            key,
            result: fallbackUser(key, used) as UserAnalysis,
            error: e instanceof Error ? e.message : String(e),
            n: all.length,
          };
        }
      });

      const rows = chunk.map((c) => ({
        task_id: taskId,
        user_key: c.key,
        session_count: c.n,
        status: c.error ? "degraded" : "success",
        result: c.result as unknown as JsonObject,
        error: c.error?.slice(0, 600) ?? null,
        updated_at: new Date().toISOString(),
      }));
      await supabase.from("task_user_results").upsert(rows as never, { onConflict: "task_id,user_key" });

      for (const c of chunk) userAgg.push({ user_key: c.key, result: c.result });
      uDone += chunk.length;
      await heartbeat(supabase, taskId, {
        total: scope.sessionIds.length,
        done,
        succeeded,
        failed,
        tokens,
        userTotal: userKeys.length,
        userDone: uDone,
        stage: "user_aggregation",
      });
      await log(supabase, taskId, "info", "user_aggregation", `用户层汇总进度 ${uDone}/${userKeys.length}`);
    }

    /* --------------------------------------------- 4. global 层汇总 */
    await supabase
      .from("analysis_tasks")
      .update({ stage: "global_aggregation" } as never)
      .eq("id", taskId);
    await log(supabase, taskId, "info", "global_aggregation", "开始全局层汇总");

    const { data: sessionStats } = await supabase.rpc("task_session_stats", {
      p_task_id: taskId,
      p_scope: "all",
      p_user_key: null,
    });
    const { data: userStats } = await supabase.rpc("task_user_stats", { p_task_id: taskId });
    const distributions = await extraHistogramForSessions(
      supabase,
      results.map((r) => r.session.id),
    );

    const overview = computeStats(results);
    const stats = Object.assign({}, overview, { from_db: sessionStats ?? null }) as JsonObject;

    const { result: globalResult } = await aggregateGlobal(
      {
        userResults: userAgg,
        sessionStats: stats,
        userStats: (userStats ?? {}) as JsonObject,
        distributions,
        sessionCount: results.length,
        userCount: userAgg.length,
      },
      task.template,
      config.global.maxUsersInPrompt,
    );

    await supabase
      .from("task_global_result")
      .upsert({
        task_id: taskId,
        status: "success",
        result: globalResult as unknown as JsonObject,
        error: null,
        updated_at: new Date().toISOString(),
      } as never, { onConflict: "task_id" });

    await heartbeat(supabase, taskId, {
      total: scope.sessionIds.length,
      done,
      succeeded,
      failed,
      tokens,
      userTotal: userKeys.length,
      userDone: uDone,
      stage: "global_aggregation",
    });
    await log(supabase, taskId, "info", "global_aggregation", "全局层汇总完成");

    /* ------------------------------------------------ 5. 报告生成 */
    await supabase
      .from("analysis_tasks")
      .update({ stage: "report_generation" } as never)
      .eq("id", taskId);
    await log(supabase, taskId, "info", "report", "开始生成报告");

    const topUsers = [...userAgg]
      .sort((a, b) => b.result.session_count - a.result.session_count)
      .slice(0, Math.max(1, config.report.topUsers));

    const evidence = collectEvidence(results);
    const groundTruth = deriveGroundTruth(
      distributions,
      (task.dataSource.extra_schema as ExtraFieldDef[]) ?? [],
      {
        sessions: results.length,
        messages: results.reduce((n, r) => n + (r.session.turn_count ?? 0), 0),
      },
    );
    const { spec, overrides } = await generateReport({
      template: task.template,
      title: task.name || `${task.dataSource.name} 分析报告`,
      scopeNote: describeScope(task, scope.sessionIds.length, userKeys.length),
      globalResult: globalResult as unknown as JsonObject,
      userResults: topUsers.map((u) => ({ user_key: u.user_key, result: u.result as unknown as JsonObject })),
      sessionStats: stats,
      distributions,
      groundTruth,
      language: config.report.language,
      includeEvidence: config.report.includeEvidence,
      tone: config.report.tone,
      targetSections: config.report.sections,
      evidence,
    });

    if (overrides.length) {
      await log(supabase, taskId, "warn", "report", `指标口径校正：覆盖 ${overrides.length} 个 KPI`, {
        overrides: overrides.map((o) => ({ label: o.label, field: o.field, was: o.was, now: o.now })),
      });
    }

    const sessionsForDrill = results.slice(0, 400).map((r) => r.session as SessionRecordForDrill);
    const drill = buildDrillData(
      sessionsForDrill,
      results.map((r) => ({ session_key: r.session_key, user_key: r.user_key, result: r.result })),
      topUsers,
    );
    drill.users = topUsers.length
      ? drill.users.filter((u) => topUsers.some((t) => t.user_key === u.user_key))
      : drill.users;

    const html = renderReportHtml({
      spec,
      drill,
      generatedAt: new Date().toISOString(),
      scopeNote: describeScope(task, results.length, userKeys.length),
      templateVersion: task.template.version,
      taskName: task.name,
    });

    await supabase.from("task_reports").insert({
      task_id: taskId,
      kind: "final",
      title: spec.title ?? task.name,
      report: spec as unknown as JsonObject,
      html,
      created_by: task.createdBy,
    } as never);

    await supabase
      .from("analysis_tasks")
      .update({
        status: "completed",
        stage: "done",
        report: spec as unknown as JsonObject,
        report_html: html,
        stats: {
          sessions_total: scope.sessionIds.length,
          sessions_ok: succeeded,
          sessions_failed: failed,
          users: userKeys.length,
          tokens,
          duration_ms: Date.now() - Date.parse(startedAt),
          model: process.env.AI_MODEL ?? "qwen3.8-omni-flash",
          metric_overrides: overrides.length,
        },
        heartbeat_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        progress: {
          total: scope.sessionIds.length,
          done,
          succeeded,
          failed,
          tokens,
          userTotal: userKeys.length,
          userDone: uDone,
          stage: "done",
        },
      })
      .eq("id", taskId);

    await log(supabase, taskId, "info", "report", `报告生成完成，共 ${spec.sections.length} 个章节`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("analysis_tasks")
      .update({
        status: message.includes("cancelled") ? "cancelled" : "failed",
        error: message.slice(0, 1500),
        finished_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      })
      .eq("id", taskId);
    await log(supabase, taskId, "error", null, `任务失败: ${message.slice(0, 1500)}`);
    throw err;
  }
}

/* -------------------------------------------------------------- helpers */

interface SessionRecord {
  id: string;
  session_key: string;
  user_key: string;
  started_at: string | null;
  ended_at: string | null;
  turn_count: number;
  audio_count: number;
  digest: string;
  extra: JsonObject;
}

type SessionRecordForDrill = SessionRecord;

function describeScope(task: TaskRow, sessions: number, users: number): string {
  const mode = task.scope_type === "range" ? "时间范围" : "增量未分析";
  const range =
    task.scope_type === "range" && (task.range_start || task.range_end)
      ? ` ${formatDate(task.range_start)} ~ ${formatDate(task.range_end)}`
      : "";
  return `${mode}${range} · ${sessions} 会话 · ${users} 用户`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function fallbackUser(key: string, sessions: { session_key: string; result: SessionAnalysis }[]) {
  const quality = sessions.map((s) => s.result.quality_score).filter((v) => Number.isFinite(v));
  const risky = sessions.filter((s) => ["medium", "high"].includes(s.result.risk_level)).length;
  return {
    summary: `${key} 共 ${sessions.length} 个会话（模型汇总失败，展示统计兜底结果）`,
    session_count: sessions.length,
    persona: "未归纳",
    needs: [],
    behaviour: [
      `平均质量分 ${quality.length ? (quality.reduce((a, b) => a + b, 0) / quality.length).toFixed(1) : "—"}`,
      `风险会话占比 ${sessions.length ? Math.round((risky / sessions.length) * 100) : 0}%`,
    ],
    metrics: [],
    risk_level: risky / Math.max(1, sessions.length) > 0.4 ? "high" : risky > 0 ? "medium" : "none",
    tags: [...new Set(sessions.flatMap((s) => s.result.tags ?? []))].slice(0, 8),
    key_sessions: sessions.slice(0, 3).map((s) => s.session_key),
  };
}

async function assertNotCancelled(supabase: SupabaseClient, taskId: string) {
  const { data } = await supabase.from("analysis_tasks").select("status").eq("id", taskId).single();
  if ((data as { status?: string } | null)?.status === "cancelled") {
    throw new Error("task cancelled by user");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

