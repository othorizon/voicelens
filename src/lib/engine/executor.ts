import { callJson, execute, scalar } from "@/lib/db";
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
  AudioUsage,
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
  taskId: string,
  level: string,
  stage: string | null,
  message: string,
  payload?: JsonObject,
) {
  await execute(
    `insert into task_logs (task_id, level, stage, message, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [taskId, level, stage, message.slice(0, 1900), payload ? JSON.stringify(payload) : null],
  );
}

export async function heartbeat(taskId: string, progress?: JsonObject) {
  await execute(
    `update analysis_tasks
     set heartbeat_at = now(), progress = coalesce($2::jsonb, progress)
     where id = $1`,
    [taskId, progress ? JSON.stringify(progress) : null],
  );
}

/** Full pipeline: collect → session → user → global → report. */
export async function runTask(task: TaskRow, config: WorkflowConfig): Promise<void> {
  const taskId = task.id;
  const startedAt = new Date().toISOString();
  await execute(
    `update analysis_tasks
     set status = 'running', stage = 'collect', started_at = $2, heartbeat_at = $2
     where id = $1`,
    [taskId, startedAt],
  );
  await log(taskId, "info", "collect", "任务开始执行");

  try {
    /* ------------------------------------------------------- 1. scope */
    // The scope chosen when the task was launched wins over the workflow
    // default: the same flow can be run incrementally or over a time window.
    const mode = task.scope_type === "range" ? "range" : task.scope_type === "incremental" ? "incremental" : config.scope.mode;
    const scope = await resolveScope(task.data_source_id, {
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

    await execute(`update analysis_tasks set progress = $2::jsonb where id = $1`, [
      taskId,
      JSON.stringify({ total: scope.sessionIds.length, done: 0, stage: "collect", mode: scope.mode }),
    ]);
    await log(taskId, "info", "collect", `范围确定：${scope.sessionIds.length} 个会话（${scope.mode}）`, {
      mode: scope.mode,
      count: scope.sessionIds.length,
    });

    const extraHint = describeExtraSchema(task.dataSource.extra_schema as ExtraFieldDef[]);

    /* --------------------------------------------- 2. session 层分析 */
    await execute(`update analysis_tasks set stage = 'session_analysis' where id = $1`, [taskId]);

    let done = 0;
    let succeeded = 0;
    let failed = 0;
    let tokens = 0;
    // Audio degrades silently, so count what actually reached the model rather
    // than trusting the switch. See AudioUsage.
    const audioUse = { sessionsWithAudio: 0, clipsAttached: 0, clipsUnavailable: 0 };
    const results: { session_key: string; user_key: string; result: SessionAnalysis; session: SessionRecord }[] = [];

    const CHUNK = 40;
    for (let i = 0; i < scope.sessionIds.length; i += CHUNK) {
      await assertNotCancelled(taskId);
      const slice = scope.sessionIds.slice(i, i + CHUNK);
      const sessions = await loadSessions(slice, { maxDigestChars: config.session.maxDigestChars });

      const chunkResults = await mapLimit(sessions, config.session.concurrency, async (s) => {
        const session = s as unknown as SessionRecord;
        let lastError = "";
        for (let attempt = 0; attempt <= config.session.retries; attempt++) {
          try {
            const { result, tokens: used, audio } = await analyzeSession({
              session,
              template: task.template,
              useAudio: config.session.useAudio,
              maxAudiosPerSession: config.session.maxAudiosPerSession,
              extraSchemaHint: extraHint,
            });
            tokens += used;
            if (audio.attached > 0) audioUse.sessionsWithAudio++;
            audioUse.clipsAttached += audio.attached;
            audioUse.clipsUnavailable += audio.requested - audio.attached;
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

      try {
        await execute(
          `insert into task_session_results
             (task_id, session_pk, session_key, user_key, status, result, error, tokens)
           select $1, t.session_pk, t.session_key, t.user_key, t.status, t.result, t.error, t.tokens
           from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::text[], $8::int[])
             as t(session_pk, session_key, user_key, status, result, error, tokens)
           on conflict (task_id, session_pk) do update
             set session_key = excluded.session_key,
                 user_key = excluded.user_key,
                 status = excluded.status,
                 result = excluded.result,
                 error = excluded.error,
                 tokens = excluded.tokens,
                 updated_at = now()`,
          [
            taskId,
            rows.map((r) => r.session_pk),
            rows.map((r) => r.session_key),
            rows.map((r) => r.user_key),
            rows.map((r) => r.status),
            rows.map((r) => (r.result === null ? null : JSON.stringify(r.result))),
            rows.map((r) => r.error),
            rows.map((r) => r.tokens),
          ],
        );
      } catch (err) {
        await log(taskId, "warn", "session_analysis", `写入结果失败: ${(err as Error).message}`);
      }

      for (const r of chunkResults) {
        done++;
        if (r.ok) {
          succeeded++;
          results.push({ session_key: r.session.session_key, user_key: r.session.user_key, result: r.result, session: r.session });
        } else {
          failed++;
          if (failed <= 5) {
            await log(taskId, "warn", "session_analysis", `会话 ${r.session.session_key} 分析失败`, {
              error: (r.error ?? "").slice(0, 400),
            });
          }
        }
      }

      await heartbeat(taskId, {
        total: scope.sessionIds.length,
        done,
        succeeded,
        failed,
        tokens,
        stage: "session_analysis",
      });
      await log(
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
    await execute(`update analysis_tasks set stage = 'user_aggregation' where id = $1`, [taskId]);
    await log(taskId, "info", "user_aggregation", "开始用户层汇总");

    const byUser = new Map<string, { session_key: string; result: SessionAnalysis }[]>();
    for (const r of results) {
      byUser.set(r.user_key, [...(byUser.get(r.user_key) ?? []), { session_key: r.session_key, result: r.result }]);
    }

    const userKeys = [...byUser.keys()];
    await execute(
      `insert into task_user_results (task_id, user_key, session_count, status)
       select $1, t.user_key, t.session_count, 'pending'
       from unnest($2::text[], $3::int[]) as t(user_key, session_count)
       on conflict (task_id, user_key) do update
         set session_count = excluded.session_count, updated_at = now()`,
      [taskId, userKeys, userKeys.map((k) => (byUser.get(k) ?? []).length)],
    );

    let uDone = 0;
    const userAgg: { user_key: string; result: UserAnalysis }[] = [];
    const USER_CHUNK = 30;
    for (let i = 0; i < userKeys.length; i += USER_CHUNK) {
      await assertNotCancelled(taskId);
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
      await execute(
        `insert into task_user_results (task_id, user_key, session_count, status, result, error, updated_at)
         select $1, t.user_key, t.session_count, t.status, t.result, t.error, now()
         from unnest($2::text[], $3::int[], $4::text[], $5::jsonb[], $6::text[])
           as t(user_key, session_count, status, result, error)
         on conflict (task_id, user_key) do update
           set session_count = excluded.session_count,
               status = excluded.status,
               result = excluded.result,
               error = excluded.error,
               updated_at = now()`,
        [
          taskId,
          rows.map((r) => r.user_key),
          rows.map((r) => r.session_count),
          rows.map((r) => r.status),
          rows.map((r) => JSON.stringify(r.result)),
          rows.map((r) => r.error),
        ],
      );

      for (const c of chunk) userAgg.push({ user_key: c.key, result: c.result });
      uDone += chunk.length;
      await heartbeat(taskId, {
        total: scope.sessionIds.length,
        done,
        succeeded,
        failed,
        tokens,
        userTotal: userKeys.length,
        userDone: uDone,
        stage: "user_aggregation",
      });
      await log(taskId, "info", "user_aggregation", `用户层汇总进度 ${uDone}/${userKeys.length}`);
    }

    /* --------------------------------------------- 4. global 层汇总 */
    await execute(`update analysis_tasks set stage = 'global_aggregation' where id = $1`, [taskId]);
    await log(taskId, "info", "global_aggregation", "开始全局层汇总");

    const sessionStats = await callJson<JsonObject>("task_session_stats", [taskId, "all", null]);
    const userStats = await callJson<JsonObject>("task_user_stats", [taskId]);
    const distributions = await extraHistogramForSessions(results.map((r) => r.session.id));

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

    await execute(
      `insert into task_global_result (task_id, status, result, error, updated_at)
       values ($1, 'success', $2::jsonb, null, now())
       on conflict (task_id) do update
         set status = excluded.status,
             result = excluded.result,
             error = excluded.error,
             updated_at = now()`,
      [taskId, JSON.stringify(globalResult)],
    );

    await heartbeat(taskId, {
      total: scope.sessionIds.length,
      done,
      succeeded,
      failed,
      tokens,
      userTotal: userKeys.length,
      userDone: uDone,
      stage: "global_aggregation",
    });
    await log(taskId, "info", "global_aggregation", "全局层汇总完成");

    /* ------------------------------------------------ 5. 报告生成 */
    await execute(`update analysis_tasks set stage = 'report_generation' where id = $1`, [taskId]);
    await log(taskId, "info", "report", "开始生成报告");

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
      await log(taskId, "warn", "report", `指标口径校正：覆盖 ${overrides.length} 个 KPI`, {
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

    const audio: AudioUsage = {
      enabled: config.session.useAudio,
      maxPerSession: config.session.maxAudiosPerSession,
      sessionsTotal: scope.sessionIds.length,
      ...audioUse,
    };

    const html = renderReportHtml({
      spec,
      drill,
      generatedAt: new Date().toISOString(),
      scopeNote: describeScope(task, results.length, userKeys.length),
      templateVersion: task.template.version,
      taskName: task.name,
      audio,
    });

    await execute(
      `insert into task_reports (task_id, kind, title, report, html, created_by)
       values ($1, 'final', $2, $3::jsonb, $4, $5)`,
      [taskId, spec.title ?? task.name, JSON.stringify(spec), html, task.createdBy],
    );

    await execute(
      `update analysis_tasks
       set status = 'completed', stage = 'done', report = $2::jsonb, report_html = $3,
           stats = $4::jsonb, progress = $5::jsonb, heartbeat_at = now(), finished_at = now()
       where id = $1`,
      [
        taskId,
        JSON.stringify(spec),
        html,
        JSON.stringify({
          sessions_total: scope.sessionIds.length,
          sessions_ok: succeeded,
          sessions_failed: failed,
          users: userKeys.length,
          tokens,
          duration_ms: Date.now() - Date.parse(startedAt),
          model: process.env.AI_MODEL ?? "qwen3.8-omni-flash",
          metric_overrides: overrides.length,
          audio,
        }),
        JSON.stringify({
          total: scope.sessionIds.length,
          done,
          succeeded,
          failed,
          tokens,
          userTotal: userKeys.length,
          userDone: uDone,
          stage: "done",
        }),
      ],
    );

    await log(taskId, "info", "report", `报告生成完成，共 ${spec.sections.length} 个章节`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await execute(
      `update analysis_tasks
       set status = $2, error = $3, finished_at = now(), heartbeat_at = now()
       where id = $1`,
      [taskId, message.includes("cancelled") ? "cancelled" : "failed", message.slice(0, 1500)],
    );
    await log(taskId, "error", null, `任务失败: ${message.slice(0, 1500)}`);
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

async function assertNotCancelled(taskId: string) {
  const status = await scalar<string>(`select status from analysis_tasks where id = $1`, [taskId]);
  if (status === "cancelled") throw new Error("task cancelled by user");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

