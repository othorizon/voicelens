import { NextResponse } from "next/server";
import { maybeOne } from "@/lib/db";
import { canAccessSource, currentViewer } from "@/lib/auth/access";
import { loadStudioState } from "@/lib/queries";
import type { JsonObject } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sources/[id]/studio-state
 * Lightweight poll payload for the analysis studio (planning jobs, templates,
 * previews) so the UI can refresh without re-rendering the whole page.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await canAccessSource(viewer, id))) {
    return NextResponse.json({ error: "数据源不存在" }, { status: 404 });
  }

  const [state, source] = await Promise.all([
    loadStudioState(id),
    maybeOne<JsonObject>(
      `select id, name, description, extra_schema from data_sources where id = $1`,
      [id],
    ),
  ]);

  return NextResponse.json({ source, ...state });
}
