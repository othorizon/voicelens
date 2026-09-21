import { maybeOne, query } from "@/lib/db";
import type { JsonObject } from "@/lib/types";

/**
 * A task's reports, as a chain rather than a single document.
 *
 * A report can be regenerated or revised, and both land as new rows in
 * `task_reports` with the previous one left intact. That makes "the report" the
 * newest row — which is also what `analysis_tasks.report_html` holds — and makes
 * every earlier one still reachable, because comparing a revision against what
 * it came from is the reason to keep them.
 *
 * Shared by the two routes that serve a report and by the task page that lists
 * the versions, so all three agree on what a version is.
 */

export interface ReportVersion {
  id: string;
  version: number | null;
  kind: string;
  /** 'page' for the AI-designed page, 'spec' for the block renderer. */
  engine: string | null;
  /** The note that asked for this version. Empty on a fresh one. */
  feedback: string;
  parent_id: string | null;
  created_at: string;
  /** Whether a further revision can start from this version. */
  revisable: boolean;
  /** The browser's verdict, without the frames. */
  validation: JsonObject;
}

export async function listReportVersions(taskId: string, limit = 20): Promise<ReportVersion[]> {
  return query<ReportVersion>(
    `select id, version, kind, engine, feedback, parent_id, created_at,
            (page is not null and page <> '') as revisable,
            validation
     from task_reports
     where task_id = $1
     order by version desc nulls last, created_at desc
     limit $2`,
    [taskId, limit],
  );
}

/**
 * One version's document, or the current report.
 *
 * The version is always read with its task id in the predicate, so an id
 * belonging to another task cannot be served through a task the caller does
 * happen to own.
 */
export async function loadReportHtml(taskId: string, reportId: string | null): Promise<string | null> {
  if (reportId) {
    const row = await maybeOne<{ html: string | null }>(
      `select html from task_reports where task_id = $1 and id = $2`,
      [taskId, reportId],
    );
    return row?.html ?? null;
  }
  const task = await maybeOne<{ report_html: string | null }>(
    `select report_html from analysis_tasks where id = $1`,
    [taskId],
  );
  return task?.report_html ?? null;
}
