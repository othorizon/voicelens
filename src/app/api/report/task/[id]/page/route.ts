import { notFound } from "next/navigation";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";
import { loadReportHtml } from "@/lib/report-history";

export const runtime = "nodejs";

/**
 * The report document itself.
 *
 * Only the host page fetches this, same-origin and with credentials, and then
 * hands it to a sandboxed frame through `srcdoc`. Serving it into a frame
 * directly would put generated code on this origin, which is exactly what the
 * sandbox exists to prevent — hence the deny headers.
 *
 * `?report=<id>` serves one stored version instead of the current one. A report
 * can be revised now, so "the report" is a chain rather than a single document,
 * and comparing a revision against what it came from is the whole reason to
 * keep the older ones.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) notFound();
  if (!(await resolveOwnedRow(viewer, "analysis_tasks", id))) notFound();

  const html = await loadReportHtml(id, new URL(req.url).searchParams.get("report"));
  if (!html) notFound();

  return new Response(html, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    },
  });
}
