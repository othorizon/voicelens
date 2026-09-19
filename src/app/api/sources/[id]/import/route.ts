import { NextResponse } from "next/server";
import { maybeOne } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { importZip, createImportBatch } from "@/lib/engine/import";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/sources/[id]/import
 * multipart/form-data: { file: <zip>, mode: "background" | "sync" }
 *
 * Creates the batch row, then runs the parse + storage upload in the background
 * and returns the batch id immediately so the UI can poll for progress.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: dataSourceId } = await ctx.params;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const source = await maybeOne<{ id: string }>(`select id from data_sources where id = $1`, [
    dataSourceId,
  ]);
  if (!source) return NextResponse.json({ error: "data source not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "请求必须是 multipart/form-data，字段名为 file" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "缺少 file 字段" }, { status: 400 });
  }
  if (!/\.zip$/i.test(file.name)) {
    return NextResponse.json({ error: "仅支持上传 .zip 压缩包（内含 JSONL 与音频文件）" }, { status: 400 });
  }
  if (file.size > 800 * 1024 * 1024) {
    return NextResponse.json({ error: "压缩包超过 800MB 上限，请拆分后再导入" }, { status: 413 });
  }

  const mode = String(form.get("mode") ?? "background");

  try {
    const buffer = await file.arrayBuffer();
    const batchId = await createImportBatch(dataSourceId, file.name, user.id);

    if (mode === "sync") {
      const result = await importZip(dataSourceId, buffer, file.name, user.id, () => {}, batchId);
      return NextResponse.json({ ...result, batchId });
    }

    // The connection pool is process-wide, so this keeps running after the
    // response is sent; progress lands on the batch row for the UI to poll.
    void importZip(dataSourceId, buffer, file.name, user.id, () => {}, batchId).catch((e: unknown) => {
      console.error("[import] background failure:", e instanceof Error ? e.message : e);
    });

    return NextResponse.json({ batchId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
