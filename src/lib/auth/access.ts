import { maybeOne } from "@/lib/db";
import { currentUser, type AuthUser } from "@/lib/auth";
import { asRole, canUseApp, canViewAllData, type Role } from "./roles";

/**
 * Who may read which rows.
 *
 * Ownership is anchored on `data_sources.created_by`. Every other table hangs
 * off a data source, so clearing the source clears everything below it — the
 * helpers here resolve a child row to its source and answer in one place, and
 * `@/lib/actions/common` wraps them with the error handling each surface
 * wants (redirects for pages and actions, status codes for route handlers).
 *
 * "Not found" and "not yours" are deliberately indistinguishable so a member
 * cannot use these to probe which ids exist.
 */

export interface Viewer {
  userId: string;
  user: AuthUser;
  role: Role;
  /** owner/admin read and write every member's data; a member only their own. */
  viewAll: boolean;
}

export type ViewerState =
  | { kind: "anonymous" }
  | { kind: "inactive"; user: AuthUser }
  | { kind: "active"; viewer: Viewer };

export async function viewerState(): Promise<ViewerState> {
  const user = await currentUser();
  if (!user) return { kind: "anonymous" };

  const role = asRole(user.role);
  if (!canUseApp(role)) return { kind: "inactive", user };

  return {
    kind: "active",
    viewer: { userId: user.id, user, role, viewAll: canViewAllData(role) },
  };
}

/** The activated caller, or null when signed out *or* not activated yet. */
export async function currentViewer(): Promise<Viewer | null> {
  const state = await viewerState();
  return state.kind === "active" ? state.viewer : null;
}

/**
 * The creator filter for a query that spans data sources: null for an
 * owner/admin (no filter), the caller's id for a member.
 */
export function ownerScope(viewer: Viewer): string | null {
  return viewer.viewAll ? null : viewer.userId;
}

/** True when this viewer may read and manage the given data source. */
export async function canAccessSource(viewer: Viewer, dataSourceId: string): Promise<boolean> {
  const row = await maybeOne<{ created_by: string | null }>(
    `select created_by from data_sources where id = $1`,
    [dataSourceId],
  );
  if (!row) return false;
  // A source whose creator was deleted (created_by is null) is owner/admin only.
  return viewer.viewAll || row.created_by === viewer.userId;
}

/** Tables whose rows are owned through their data source. */
export type OwnedTable =
  | "analysis_tasks"
  | "workflows"
  | "analysis_templates"
  | "template_previews"
  | "planning_jobs"
  | "import_batches"
  | "sessions";

/**
 * Resolve a child row to the data source that owns it, or null when the row is
 * missing or belongs to someone else. `table` is a compile-time literal from
 * the union above — never request input.
 */
export async function resolveOwnedRow(
  viewer: Viewer,
  table: OwnedTable,
  id: string,
): Promise<string | null> {
  const row = await maybeOne<{ data_source_id: string; created_by: string | null }>(
    `select c.data_source_id, d.created_by
     from ${table} c
     join data_sources d on d.id = c.data_source_id
     where c.id = $1`,
    [id],
  );
  if (!row) return null;
  if (!viewer.viewAll && row.created_by !== viewer.userId) return null;
  return row.data_source_id;
}

/** The data source behind a stored audio object path, if the viewer may hear it. */
export async function resolveAudioSource(viewer: Viewer, audioPath: string): Promise<string | null> {
  const row = await maybeOne<{ data_source_id: string; created_by: string | null }>(
    `select m.data_source_id, d.created_by
     from messages m
     join data_sources d on d.id = m.data_source_id
     where m.audio_path = $1
     limit 1`,
    [audioPath],
  );
  if (!row) return null;
  if (!viewer.viewAll && row.created_by !== viewer.userId) return null;
  return row.data_source_id;
}
