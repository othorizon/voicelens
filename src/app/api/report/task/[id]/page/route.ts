import { notFound } from "next/navigation";
import { maybeOne } from "@/lib/db";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";

export const runtime = "nodejs";

/**
 * The report document itself.
 *
 * Only the host page fetches this, same-origin and with credentials, and then
 * hands it to a sandboxed frame through `srcdoc`. Serving it into a frame
 * directly would put generated code on this origin, which is exactly what the
 * sandbox exists to prevent — hence the deny headers.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) notFound();
  if (!(await resolveOwnedRow(viewer, "analysis_tasks", id))) notFound();

  const task = await maybeOne<{ report_html: string | null }>(
    `select report_html from analysis_tasks where id = $1`,
    [id],
  );
  if (!task?.report_html) notFound();

  return new Response(task.report_html, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    },
  });
}
