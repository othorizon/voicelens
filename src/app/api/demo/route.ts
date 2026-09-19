import { NextResponse } from "next/server";
import { execute, maybeOne } from "@/lib/db";
import { canAccessSource, currentViewer } from "@/lib/auth/access";
import { buildDemoZip, DEMO_EXTRA_SCHEMA, generateDemoDataset } from "@/lib/demo/generate";
import { createImportBatch, importZip } from "@/lib/engine/import";

export const runtime = "nodejs";
export const maxDuration = 300;

/** GET /api/demo/zip — download the bundled sample dataset as an uploadable zip. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessions = Math.min(400, Math.max(10, Number(url.searchParams.get("sessions") ?? 90)));
  const dataset = generateDemoDataset({ sessions, users: Math.max(6, Math.round(sessions / 2.5)) });
  const zip = await buildDemoZip(dataset);

  return new Response(zip as unknown as BodyInit, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="voicelens-demo-car-assistant.zip"`,
      "cache-control": "no-store",
    },
  });
}

/**
 * POST /api/demo/import { sourceId, schema?, fillDescription? }
 * Generates the sample dataset and imports it into the given data source,
 * including the recommended extra schema.
 */
export async function POST(request: Request) {
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    sourceId?: string;
    sessions?: number;
    autoSchema?: boolean;
    fillDescription?: boolean;
  };
  const sourceId = body.sourceId;
  if (!sourceId) return NextResponse.json({ error: "缺少 sourceId" }, { status: 400 });

  if (!(await canAccessSource(viewer, sourceId))) {
    return NextResponse.json({ error: "数据源不存在" }, { status: 404 });
  }
  const source = await maybeOne<{ id: string; name: string; description: string }>(
    `select id, name, description from data_sources where id = $1`,
    [sourceId],
  );
  if (!source) return NextResponse.json({ error: "数据源不存在" }, { status: 404 });

  const dataset = generateDemoDataset({
    sessions: Math.min(500, Math.max(10, Number(body.sessions ?? 90))),
    users: Math.max(6, Math.round(Number(body.sessions ?? 90) / 2.5)),
  });
  const zip = await buildDemoZip(dataset);

  if (body.autoSchema !== false && body.fillDescription !== false) {
    const { DEMO_BUSINESS_DESC } = await import("@/lib/demo/generate");
    await execute(
      `update data_sources
       set extra_schema = $2::jsonb,
           description = case when coalesce(trim(description), '') = '' then $3 else description end,
           updated_at = now()
       where id = $1`,
      [sourceId, JSON.stringify(DEMO_EXTRA_SCHEMA), DEMO_BUSINESS_DESC],
    );
  }

  const batchId = await createImportBatch(
    sourceId,
    `demo-car-assistant-${dataset.sessions}s.zip`,
    viewer.userId,
  );

  void importZip(
    sourceId,
    zip.buffer as ArrayBuffer,
    `demo-car-assistant-${dataset.sessions}s.zip`,
    viewer.userId,
    () => {},
    batchId,
  ).catch((e: unknown) => console.error("[demo import] failed:", e instanceof Error ? e.message : e));

  return NextResponse.json({
    batchId,
    stats: { sessions: dataset.sessions, users: dataset.users, records: dataset.records.length, audios: dataset.audios },
  });
}
