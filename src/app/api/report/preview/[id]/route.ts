import { notFound } from "next/navigation";
import { maybeOne } from "@/lib/db";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";
import { renderHostPage } from "@/lib/engine/report-host";

export const runtime = "nodejs";

/**
 * Host page for a preview.
 *
 * Same frame and same rules as a task report — a preview is generated code
 * over the same user speech, so it gets no more trust. It needs no drill-down
 * endpoint: a preview is a dozen sessions, and its detail rows travel inside
 * the document.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) notFound();
  if (!(await resolveOwnedRow(viewer, "template_previews", id))) notFound();

  const preview = await maybeOne<{ id: string; html: string | null }>(
    `select id, html from template_previews where id = $1`,
    [id],
  );
  if (!preview?.html) notFound();

  return new Response(
    renderHostPage({ title: "预览报告", docUrl: `/api/report/preview/${id}/page` }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
