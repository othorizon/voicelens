import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createStandaloneClient } from "@/lib/supabase/standalone";
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    sourceId?: string;
    sessions?: number;
    autoSchema?: boolean;
    fillDescription?: boolean;
  };
  const sourceId = body.sourceId;
  if (!sourceId) return NextResponse.json({ error: "缺少 sourceId" }, { status: 400 });

  const { data: source } = await supabase
    .from("data_sources")
    .select("id, name, description, extra_schema")
    .eq("id", sourceId)
    .maybeSingle();
  if (!source) return NextResponse.json({ error: "数据源不存在" }, { status: 404 });

  const dataset = generateDemoDataset({
    sessions: Math.min(500, Math.max(10, Number(body.sessions ?? 90))),
    users: Math.max(6, Math.round(Number(body.sessions ?? 90) / 2.5)),
  });
  const zip = await buildDemoZip(dataset);

  if (body.autoSchema !== false && body.fillDescription !== false) {
    const { DEMO_BUSINESS_DESC } = await import("@/lib/demo/generate");
    await supabase
      .from("data_sources")
      .update({
        extra_schema: DEMO_EXTRA_SCHEMA,
        description: (source.description as string)?.trim() ? source.description : DEMO_BUSINESS_DESC,
      })
      .eq("id", sourceId);
  }

  const batchId = await createImportBatch(supabase, sourceId, `demo-car-assistant-${dataset.sessions}s.zip`, user.id);
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const standalone = createStandaloneClient(session?.access_token ?? null);

  void importZip(
    standalone,
    sourceId,
    zip.buffer as ArrayBuffer,
    `demo-car-assistant-${dataset.sessions}s.zip`,
    user.id,
    () => {},
    batchId,
  ).catch((e: unknown) => console.error("[demo import] failed:", e instanceof Error ? e.message : e));

  return NextResponse.json({
    batchId,
    stats: { sessions: dataset.sessions, users: dataset.users, records: dataset.records.length, audios: dataset.audios },
  });
}
