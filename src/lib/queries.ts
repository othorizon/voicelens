import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtraFieldDef, JsonObject } from "@/lib/types";

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

const STATS_SELECT =
  "id, name, description, extra_schema, status, created_at, updated_at, created_by";

export async function listDataSources(supabase: SupabaseClient): Promise<DataSourceWithStats[]> {
  const { data } = await supabase
    .from("data_sources")
    .select(`${STATS_SELECT}, profiles(display_name, email)`)
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as JsonObject[];
  if (!rows.length) return [];

  const overviews = await Promise.all(
    rows.map((r) => supabase.rpc("source_overview", { p_data_source_id: r.id as string })),
  );

  return rows.map((r, i) => {
    const o = (overviews[i]?.data ?? {}) as JsonObject;
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
        first_seen: (o.first_seen as string | null) ?? null,
        last_seen: (o.last_seen as string | null) ?? null,
      },
      creator: (r.profiles as DataSourceWithStats["creator"]) ?? null,
    };
  });
}

export async function sourceStats(
  supabase: SupabaseClient,
  dataSourceId: string,
): Promise<JsonObject & { sessions: number; users: number; messages: number; audios: number }> {
  const { data } = await supabase.rpc("source_overview", { p_data_source_id: dataSourceId });
  return {
    sessions: 0,
    users: 0,
    messages: 0,
    audios: 0,
    ...((data as JsonObject) ?? {}),
  } as JsonObject & { sessions: number; users: number; messages: number; audios: number };
}

export async function getDataSource(supabase: SupabaseClient, id: string) {
  const { data } = await supabase
    .from("data_sources")
    .select("id, name, description, extra_schema, status, created_at, updated_at, created_by, profiles(display_name, email)")
    .eq("id", id)
    .maybeSingle();
  return data as
    | (JsonObject & {
        id: string;
        name: string;
        description: string;
        extra_schema: ExtraFieldDef[];
        profiles?: { display_name: string | null; email: string } | null;
      })
    | null;
}

export async function listWorkflows(supabase: SupabaseClient, dataSourceId?: string) {
  let query = supabase
    .from("workflows")
    .select("id, data_source_id, name, graph, config, is_active, created_at, updated_at, data_sources(name)")
    .order("updated_at", { ascending: false });
  if (dataSourceId) query = query.eq("data_source_id", dataSourceId);
  const { data } = await query;
  return (data ?? []) as (JsonObject & { id: string; name: string; data_source_id: string })[];
}

export async function listTemplates(supabase: SupabaseClient, dataSourceId: string) {
  const { data } = await supabase
    .from("analysis_templates")
    .select(
      "id, version, status, rationale, feedback, created_at, created_by, metric_schema, samples, parent_id, session_prompt, user_prompt, global_prompt, report_prompt",
    )
    .eq("data_source_id", dataSourceId)
    .order("version", { ascending: false });
  return (data ?? []) as JsonObject[];
}

export async function listTasks(supabase: SupabaseClient, limit = 50, dataSourceId?: string) {
  let query = supabase
    .from("analysis_tasks")
    .select(
      "id, name, status, stage, progress, stats, error, created_at, started_at, finished_at, data_source_id, template_id, scope_type, range_start, range_end, data_sources(name), profiles(display_name)",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (dataSourceId) query = query.eq("data_source_id", dataSourceId);
  const { data } = await query;
  return (data ?? []) as unknown as TaskRow[];
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

export async function listPreviews(supabase: SupabaseClient, dataSourceId: string) {
  const { data } = await supabase
    .from("template_previews")
    .select("id, template_id, status, progress, error, created_at, finished_at, stats")
    .eq("data_source_id", dataSourceId)
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []) as JsonObject[];
}

export async function listPlanningJobs(supabase: SupabaseClient, dataSourceId: string) {
  const { data } = await supabase
    .from("planning_jobs")
    .select("id, status, kind, params, feedback, error, created_at, finished_at, progress, template_id, parent_template_id")
    .eq("data_source_id", dataSourceId)
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []) as JsonObject[];
}

export async function listBatches(supabase: SupabaseClient, dataSourceId: string) {
  const { data } = await supabase
    .from("import_batches")
    .select("*")
    .eq("data_source_id", dataSourceId)
    .order("created_at", { ascending: false });
  return (data ?? []) as JsonObject[];
}
