import { notFound, redirect } from "next/navigation";
import {
  canAccessSource,
  ownerScope as scopeOf,
  resolveOwnedRow,
  viewerState,
  type OwnedTable,
  type Viewer,
} from "@/lib/auth/access";

/**
 * Guards for server actions and pages, over the resolution logic in
 * @/lib/auth/access.
 *
 * Data is scoped per creator now, so being signed in is no longer the whole
 * check. `requireSession` is the floor every action still calls: an account
 * waiting to be activated (`none`) is bounced to the holding page and can
 * reach nothing. Anything that names a row goes through the `require*Access`
 * guards below.
 */

export type Session = Viewer;

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

export function fail(message: string): never {
  throw new ActionError(message);
}

export async function requireSession(): Promise<Session> {
  const state = await viewerState();
  if (state.kind === "anonymous") redirect("/login");
  if (state.kind === "inactive") redirect("/pending");
  return state.viewer;
}

/** Role assignment — owner and admin only. */
export async function requireAdminSession(): Promise<Session> {
  const session = await requireSession();
  if (!session.viewAll) fail("需要管理员权限");
  return session;
}

/** The creator filter for a list query that spans data sources. */
export function ownerScope(session: Session): string | null {
  return scopeOf(session);
}

/** Authorize the caller against one data source, the anchor every row hangs off. */
export async function requireSourceAccess(
  dataSourceId: string,
  session?: Session,
): Promise<Session> {
  const active = session ?? (await requireSession());
  if (!(await canAccessSource(active, dataSourceId))) fail("数据源不存在");
  return active;
}

async function requireOwnedRow(
  table: OwnedTable,
  id: string,
  missing: string,
  session?: Session,
): Promise<{ session: Session; dataSourceId: string }> {
  const active = session ?? (await requireSession());
  const dataSourceId = await resolveOwnedRow(active, table, id);
  if (!dataSourceId) fail(missing);
  return { session: active, dataSourceId };
}

/**
 * Page guards. A page is a navigation, so a source or task the caller may not
 * see renders as 404 — the same thing a stranger's id would render as, which
 * keeps the two indistinguishable here too.
 */
export async function requireSourcePage(dataSourceId: string): Promise<Session> {
  const session = await requireSession();
  if (!(await canAccessSource(session, dataSourceId))) notFound();
  return session;
}

export async function requireTaskPage(
  taskId: string,
): Promise<{ session: Session; dataSourceId: string }> {
  const session = await requireSession();
  const dataSourceId = await resolveOwnedRow(session, "analysis_tasks", taskId);
  if (!dataSourceId) notFound();
  return { session, dataSourceId };
}

export function requireTaskAccess(taskId: string, session?: Session) {
  return requireOwnedRow("analysis_tasks", taskId, "任务不存在", session);
}

export function requireWorkflowAccess(workflowId: string, session?: Session) {
  return requireOwnedRow("workflows", workflowId, "工作流不存在", session);
}

export function requireTemplateAccess(templateId: string, session?: Session) {
  return requireOwnedRow("analysis_templates", templateId, "模板不存在", session);
}

export function requirePreviewAccess(previewId: string, session?: Session) {
  return requireOwnedRow("template_previews", previewId, "预览不存在", session);
}

export function requireBatchAccess(batchId: string, session?: Session) {
  return requireOwnedRow("import_batches", batchId, "批次不存在", session);
}
