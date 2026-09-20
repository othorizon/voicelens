import { notFound } from "next/navigation";
import { maybeOne } from "@/lib/db";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";

export const runtime = "nodejs";

/**
 * The preview document itself, fetched only by its host page and handed to a
 * sandboxed frame from there. Serving it into a frame directly would put
 * generated code on this origin, which the sandbox exists to prevent.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) notFound();
  if (!(await resolveOwnedRow(viewer, "template_previews", id))) notFound();

  const preview = await maybeOne<{ html: string | null }>(
    `select html from template_previews where id = $1`,
    [id],
  );
  if (!preview?.html) notFound();

  return new Response(preview.html, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    },
  });
}
