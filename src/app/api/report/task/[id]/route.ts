import { notFound } from "next/navigation";
import { maybeOne } from "@/lib/db";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";
import { renderHostPage } from "@/lib/engine/report-host";
import { acceptsSnapshot, injectSnapshot } from "@/lib/engine/report-runtime";
import { buildTaskSnapshot } from "@/lib/engine/report-export";
import { loadReportHtml } from "@/lib/report-history";

export const runtime = "nodejs";

/**
 * Serves a task's report: the sandboxed host, or the document as a download.
 *
 * `?report=<id>` picks one stored version instead of the current one, and is
 * carried into the host's document URL so the frame shows the version that was
 * asked for rather than the newest.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) notFound();
  if (!(await resolveOwnedRow(viewer, "analysis_tasks", id))) notFound();

  const task = await maybeOne<{ id: string; name: string }>(
    `select id, name from analysis_tasks where id = $1`,
    [id],
  );
  if (!task) notFound();

  const params = new URL(req.url).searchParams;
  const reportId = params.get("report");
  const html = await loadReportHtml(id, reportId);
  if (!html) notFound();

  const safeName = (task.name ?? "report").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);

  // A download has no host to ask, so it leaves with the detail rows written
  // into it — as many as a file can reasonably carry, and a note saying which
  // ones did not fit. Documents from the block renderer inline their own
  // drill-down and come back unchanged.
  if (params.get("download") === "1") {
    const doc = acceptsSnapshot(html) ? injectSnapshot(html, await buildTaskSnapshot(id)) : html;

    return new Response(doc, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="voicelens-${safeName}.html"; filename*=UTF-8''${encodeURIComponent(`voicelens-${safeName}.html`)}`,
      },
    });
  }

  const page = renderHostPage({
    title: task.name || "分析报告",
    docUrl: `/api/report/task/${id}/page${reportId ? `?report=${encodeURIComponent(reportId)}` : ""}`,
    dataUrl: `/api/report/task/${id}/data`,
  });

  return new Response(page, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
