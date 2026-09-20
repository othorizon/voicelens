import { notFound } from "next/navigation";
import { maybeOne } from "@/lib/db";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";
import { renderHostPage } from "@/lib/engine/report-host";

export const runtime = "nodejs";

/** Serves a task's report: the sandboxed host, or the document as a download. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) notFound();
  if (!(await resolveOwnedRow(viewer, "analysis_tasks", id))) notFound();

  const task = await maybeOne<{ id: string; name: string; report_html: string | null }>(
    `select id, name, report_html from analysis_tasks where id = $1`,
    [id],
  );
  if (!task?.report_html) notFound();

  const safeName = (task.name ?? "report").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);

  // A download is the document on its own. Overview data is inlined so it
  // still reads offline; drill-down needs the host and degrades to a message.
  if (new URL(req.url).searchParams.get("download") === "1") {
    return new Response(task.report_html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="voicelens-${safeName}.html"; filename*=UTF-8''${encodeURIComponent(`voicelens-${safeName}.html`)}`,
      },
    });
  }

  const page = renderHostPage({
    title: task.name || "分析报告",
    docUrl: `/api/report/task/${id}/page`,
    dataUrl: `/api/report/task/${id}/data`,
  });

  return new Response(page, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
