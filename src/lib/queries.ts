import { callJson, maybeOne, query } from "@/lib/db";
import type { ExtraFieldDef, JsonObject } from "@/lib/types";

/**
 * Read paths shared by the pages. The joins that used to be PostgREST embedded
 * resources (`profiles(display_name, email)`) are plain left joins now, shaped
 * back into the nested objects the components already read.
 *
 * Anything that spans data sources takes an `ownerId` scope: null for an
 * owner/admin (no filter), a user id for a member, which keeps them to the
 * sources they created. Build it with `ownerScope()` from the caller's session
 * rather than by hand. The per-source readers below take no scope — their
 * caller has already cleared the source with `requireSourceAccess()`, and that
 * one check covers every row hanging off it.
 */

export interface DataSourceWithStats {
  id: string;
  name: string;
  description: string;
  extra_schema: ExtraFieldDef[];
  status: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  stats: {
    session_count: number;
    user_count: number;
    message_count: number;
    audio_count: number;
    first_seen: string | null;
    last_seen: string | null;
  };
  creator?: { display_name: string | null; email: string } | null;
}

interface SourceOverview {
  sessions?: number;
  users?: number;
  messages?: number;
  audios?: number;
  first_seen?: string | null;
  last_seen?: string | null;
}

/** Wrap a joined author into the `{ display_name, email }` shape components expect. */
function creatorOf(row: JsonObject): { display_name: string | null; email: string } | null {
  return row.creator_email
    ? { display_name: (row.creator_name as string | null) ?? null, email: row.creator_email as string }
    : null;
}

export async function listDataSources(ownerId: string | null): Promise<DataSourceWithStats[]> {
  const rows = await query<JsonObject>(
    `select d.id, d.name, d.description, d.extra_schema, d.status, d.created_at, d.updated_at,
            d.created_by, p.display_name as creator_name, p.email as creator_email
     from data_sources d
     left join profiles p on p.id = d.created_by
     where ($1::uuid is null or d.created_by = $1)
     order by d.created_at desc`,
    [ownerId],
  );
  if (!rows.length) return [];

  const overviews = await Promise.all(
    rows.map((r) => callJson<SourceOverview>("source_overview", [r.id])),
  );

  return rows.map((r, i) => {
    const o = overviews[i] ?? {};
    return {
      id: r.id as string,
      name: r.name as string,
      description: (r.description as string) ?? "",
      extra_schema: (r.extra_schema as ExtraFieldDef[]) ?? [],
      status: (r.status as string) ?? "active",
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
      created_by: (r.created_by as string | null) ?? null,
      stats: {
        session_count: Number(o.sessions ?? 0),
        user_count: Number(o.users ?? 0),
        message_count: Number(o.messages ?? 0),
        audio_count: Number(o.audios ?? 0),
        first_seen: o.first_seen ?? null,
        last_seen: o.last_seen ?? null,
      },
      creator: creatorOf(r),
    };
  });
}

export async function sourceStats(
  dataSourceId: string,
): Promise<JsonObject & { sessions: number; users: number; messages: number; audios: number }> {
  const data = await callJson<SourceOverview>("source_overview", [dataSourceId]);
  return {
    sessions: 0,
    users: 0,
    messages: 0,
    audios: 0,
    ...((data as JsonObject) ?? {}),
  } as JsonObject & { sessions: number; users: number; messages: number; audios: number };
}

/** Returns null when the source does not exist *or* is not the viewer's. */
export async function getDataSource(id: string, ownerId: string | null) {
  const row = await maybeOne<JsonObject>(
    `select d.id, d.name, d.description, d.extra_schema, d.status, d.created_at, d.updated_at,
            d.created_by, p.display_name as creator_name, p.email as creator_email
     from data_sources d
     left join profiles p on p.id = d.created_by
     where d.id = $1 and ($2::uuid is null or d.created_by = $2)`,
    [id, ownerId],
  );
  if (!row) return null;
  return { ...row, profiles: creatorOf(row) } as JsonObject & {
    id: string;
    name: string;
    description: string;
    extra_schema: ExtraFieldDef[];
    profiles?: { display_name: string | null; email: string } | null;
  };
}

export async function listWorkflows(ownerId: string | null, dataSourceId?: string) {
  const rows = await query<JsonObject>(
    `select w.id, w.data_source_id, w.name, w.graph, w.config, w.is_active,
            w.created_at, w.updated_at, d.name as source_name
     from workflows w
     join data_sources d on d.id = w.data_source_id
     where ($1::uuid is null or w.data_source_id = $1)
       and ($2::uuid is null or d.created_by = $2)
     order by w.updated_at desc`,
    [dataSourceId ?? null, ownerId],
  );
  return rows.map((r) => ({
    ...r,
    data_sources: r.source_name ? { name: r.source_name as string } : null,
  })) as unknown as (JsonObject & { id: string; name: string; data_source_id: string })[];
}

export async function listTemplates(dataSourceId: string) {
  return query<JsonObject>(
    `select id, version, status, rationale, feedback, created_at, created_by, metric_schema,
            samples, parent_id, session_prompt, user_prompt, global_prompt, report_prompt
     from analysis_templates
     where data_source_id = $1
     order by version desc`,
    [dataSourceId],
  );
}

export async function listTasks(ownerId: string | null, limit = 50, dataSourceId?: string) {
  const rows = await query<JsonObject>(
    `select t.id, t.name, t.status, t.stage, t.progress, t.stats, t.error, t.created_at,
            t.started_at, t.finished_at, t.data_source_id, t.template_id, t.scope_type,
            t.range_start, t.range_end, d.name as source_name, p.display_name as creator_name
     from analysis_tasks t
     join data_sources d on d.id = t.data_source_id
     left join profiles p on p.id = t.created_by
     where ($2::uuid is null or t.data_source_id = $2)
       and ($3::uuid is null or d.created_by = $3)
     order by t.created_at desc
     limit $1`,
    [limit, dataSourceId ?? null, ownerId],
  );
  return rows.map((r) => ({
    ...r,
    data_sources: r.source_name ? { name: r.source_name as string } : null,
    profiles: { display_name: (r.creator_name as string | null) ?? null },
  })) as unknown as TaskRow[];
}

export interface TaskRow extends JsonObject {
  id: string;
  name: string;
  status: string;
  stage: string;
  progress: JsonObject;
  stats: JsonObject;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  data_source_id: string;
  template_id: string | null;
  scope_type: string;
  range_start: string | null;
  range_end: string | null;
  data_sources?: { name: string } | null;
  profiles?: { display_name: string | null } | null;
}

export async function listPreviews(dataSourceId: string) {
  return query<JsonObject>(
    `select id, template_id, status, progress, error, created_at, finished_at, stats
     from template_previews
     where data_source_id = $1
     order by created_at desc
     limit 20`,
    [dataSourceId],
  );
}

export async function listPlanningJobs(dataSourceId: string) {
  return query<JsonObject>(
    `select id, status, kind, params, feedback, error, created_at, finished_at, progress,
            template_id, parent_template_id
     from planning_jobs
     where data_source_id = $1
     order by created_at desc
     limit 20`,
    [dataSourceId],
  );
}

export async function listBatches(dataSourceId: string) {
  return query<JsonObject>(
    `select id, data_source_id, file_name, status, total_entries, created_sessions,
            created_messages, uploaded_audios, failed_audios, skipped, error,
            progress_detail, source_object, created_by, created_at, finished_at
     from import_batches
     where data_source_id = $1
     order by created_at desc`,
    [dataSourceId],
  );
}
