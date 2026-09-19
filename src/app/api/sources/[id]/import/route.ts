import { NextResponse } from "next/server";
import { canAccessSource, currentViewer } from "@/lib/auth/access";
import { createImportBatch } from "@/lib/engine/import";
import { storageConfigured } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * POST /api/sources/[id]/import
 * JSON: { key: string, fileName?: string }
 *
 * Queues an import of an archive the browser has already uploaded to the
 * bucket (see /api/sources/[id]/uploads). The request carries only the object
 * key, so neither the size of the archive nor the length of the import is a
 * property of this request.
 *
 * This only writes the 'pending' batch row. The Worker claims it and does the
 * unpacking, which is what keeps an import alive across a deploy or a restart
 * of the web process.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: dataSourceId } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await canAccessSource(viewer, dataSourceId))) {
    return NextResponse.json({ error: "data source not found" }, { status: 404 });
  }
  if (!storageConfigured()) {
    return NextResponse.json({ error: "对象存储未配置，无法导入" }, { status: 503 });
  }

  let body: { key?: unknown; fileName?: unknown; mode?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON，字段名为 key" }, { status: 400 });
  }

  const key = String(body.key ?? "");
  if (!key.startsWith(`imports/${dataSourceId}/`) || key.includes("..")) {
    return NextResponse.json({ error: "对象路径不属于该数据源" }, { status: 403 });
  }

  const fileName = String(body.fileName ?? key.split("/").pop() ?? "upload.zip");
  if (!/\.zip$/i.test(fileName)) {
    return NextResponse.json({ error: "仅支持 .zip 压缩包（内含 JSONL 与音频文件）" }, { status: 400 });
  }

  try {
    const batchId = await createImportBatch(dataSourceId, fileName, viewer.userId, {
      status: "pending",
      sourceObject: key,
    });
    return NextResponse.json({ batchId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
