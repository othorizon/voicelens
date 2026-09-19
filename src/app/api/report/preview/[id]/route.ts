import { notFound } from "next/navigation";
import { maybeOne } from "@/lib/db";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await currentUser())) notFound();

  const preview = await maybeOne<{ id: string; html: string | null }>(
    `select id, html from template_previews where id = $1`,
    [id],
  );
  if (!preview?.html) notFound();

  return new Response(preview.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
