import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { execute, maybeOne } from "@/lib/db";
import { canAccessSource, currentViewer } from "@/lib/auth/access";
import { buildDemoZip, DEMO_EXTRA_SCHEMA, generateDemoDataset } from "@/lib/demo/generate";
import { createImportBatch } from "@/lib/engine/import";
import { storageConfigured, uploadObject } from "@/lib/storage";

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
  if (!storageConfigured()) {
    return NextResponse.json({ error: "对象存储未配置，无法导入示例数据" }, { status: 503 });
  }

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

  // Staged in the bucket and queued like any other upload, so the sample data
  // exercises exactly the path a real import takes — and survives a restart.
  const fileName = `demo-car-assistant-${dataset.sessions}s.zip`;
  const key = `imports/${sourceId}/${randomUUID()}/${fileName}`;
  try {
    await uploadObject(key, zip, "application/zip");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `示例数据写入对象存储失败：${message}` }, { status: 500 });
  }

  const batchId = await createImportBatch(sourceId, fileName, viewer.userId, {
    status: "pending",
    sourceObject: key,
  });

  return NextResponse.json({
    batchId,
    stats: { sessions: dataset.sessions, users: dataset.users, records: dataset.records.length, audios: dataset.audios },
  });
}
