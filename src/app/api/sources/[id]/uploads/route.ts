import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { canAccessSource, currentViewer } from "@/lib/auth/access";
import { maxZipBytes } from "@/lib/engine/import";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  listUploadedParts,
  partSizeFor,
  signPartUpload,
  storageConfigured,
} from "@/lib/storage";

export const runtime = "nodejs";

/**
 * POST /api/sources/[id]/uploads
 *
 * Arranges a browser-direct multipart upload. The archive's bytes never touch
 * this process: it hands out presigned PUT URLs, one per part, and the browser
 * PUTs slices straight to the bucket.
 *
 * Actions:
 *   create   { fileName, size }                  -> { key, uploadId, partSize, partCount }
 *   sign     { key, uploadId, parts: number[] }  -> { urls: [{ part, url }] }
 *   status   { key, uploadId }                   -> { parts: [{ partNumber, size }] }
 *   complete { key, uploadId }                   -> { key, parts }
 *   abort    { key, uploadId }                   -> { ok: true }
 *
 * `status` is the resume point: parts already accepted by the bucket survive a
 * refresh, a dropped connection or a closed laptop, and the browser skips them
 * on the next attempt. `complete` reads the part list (and its ETags) server
 * side, so the bucket's CORS rules never have to expose the ETag header.
 */

/** At most this many part URLs per `sign` call, so URLs stay fresh on a long upload. */
const SIGN_BATCH = 200;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: dataSourceId } = await ctx.params;

  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await canAccessSource(viewer, dataSourceId))) {
    return NextResponse.json({ error: "data source not found" }, { status: 404 });
  }
  if (!storageConfigured()) {
    return NextResponse.json(
      { error: "对象存储未配置，请先填写 S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY" },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const action = String(body.action ?? "");

  try {
    switch (action) {
      case "create":
        return await create(dataSourceId, body);
      case "sign":
        return await sign(dataSourceId, body);
      case "status":
        return await status(dataSourceId, body);
      case "complete":
        return await complete(dataSourceId, body);
      case "abort":
        return await abort(dataSourceId, body);
      default:
        return NextResponse.json({ error: `未知的 action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ actions */

async function create(dataSourceId: string, body: Record<string, unknown>) {
  const fileName = String(body.fileName ?? "");
  const size = Number(body.size);

  if (!/\.zip$/i.test(fileName)) {
    return NextResponse.json({ error: "仅支持上传 .zip 压缩包（内含 JSONL 与音频文件）" }, { status: 400 });
  }
  if (!Number.isFinite(size) || size <= 0) {
    return NextResponse.json({ error: "缺少有效的文件大小" }, { status: 400 });
  }

  const limit = maxZipBytes();
  if (size > limit) {
    return NextResponse.json(
      { error: `压缩包超过 ${Math.round(limit / 1024 / 1024)}MB 上限，请拆分后再导入` },
      { status: 413 },
    );
  }

  // The key is minted here, never taken from the client: every later action
  // checks it against this data source's prefix before touching the bucket.
  const key = `imports/${dataSourceId}/${randomUUID()}/${safeName(fileName)}`;
  const uploadId = await createMultipartUpload(key, "application/zip");
  const partSize = partSizeFor(size);

  return NextResponse.json({
    key,
    uploadId,
    partSize,
    partCount: Math.ceil(size / partSize),
    signBatch: SIGN_BATCH,
  });
}

async function sign(dataSourceId: string, body: Record<string, unknown>) {
  const target = resolve(dataSourceId, body);
  if ("error" in target) return target.error;

  const parts = Array.isArray(body.parts) ? body.parts : [];
  const numbers = parts
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10_000)
    .slice(0, SIGN_BATCH);

  if (numbers.length === 0) {
    return NextResponse.json({ error: "缺少要签名的分片编号" }, { status: 400 });
  }

  const urls = await Promise.all(
    numbers.map(async (part) => ({
      part,
      url: await signPartUpload(target.key, target.uploadId, part),
    })),
  );
  return NextResponse.json({ urls });
}

async function status(dataSourceId: string, body: Record<string, unknown>) {
  const target = resolve(dataSourceId, body);
  if ("error" in target) return target.error;

  // A missing upload means it expired or was aborted — the browser drops its
  // saved resume state and starts over rather than seeing a 500.
  try {
    const parts = await listUploadedParts(target.key, target.uploadId);
    return NextResponse.json({
      parts: parts.map((p) => ({ partNumber: p.partNumber, size: p.size })),
    });
  } catch {
    return NextResponse.json({ error: "上传会话已失效", expired: true }, { status: 410 });
  }
}

async function complete(dataSourceId: string, body: Record<string, unknown>) {
  const target = resolve(dataSourceId, body);
  if ("error" in target) return target.error;

  const parts = await listUploadedParts(target.key, target.uploadId);
  if (parts.length === 0) {
    return NextResponse.json({ error: "没有任何分片上传成功" }, { status: 400 });
  }

  await completeMultipartUpload(target.key, target.uploadId, parts);
  return NextResponse.json({ key: target.key, parts: parts.length });
}

async function abort(dataSourceId: string, body: Record<string, unknown>) {
  const target = resolve(dataSourceId, body);
  if ("error" in target) return target.error;

  // Already gone is the outcome the caller wanted.
  await abortMultipartUpload(target.key, target.uploadId).catch(() => {});
  return NextResponse.json({ ok: true });
}

/* ------------------------------------------------------------------ helpers */

/**
 * Read back the key and uploadId the browser is holding, and refuse anything
 * outside this data source's prefix — the access check above authorizes the
 * source, and the prefix is what ties the object to it.
 */
function resolve(
  dataSourceId: string,
  body: Record<string, unknown>,
): { key: string; uploadId: string } | { error: NextResponse } {
  const key = String(body.key ?? "");
  const uploadId = String(body.uploadId ?? "");

  if (!key || !uploadId) {
    return { error: NextResponse.json({ error: "缺少 key 或 uploadId" }, { status: 400 }) };
  }
  if (!key.startsWith(`imports/${dataSourceId}/`) || key.includes("..")) {
    return { error: NextResponse.json({ error: "对象路径不属于该数据源" }, { status: 403 }) };
  }
  return { key, uploadId };
}

/** Keep the original name recognisable in the bucket without trusting it. */
function safeName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "upload.zip";
  return base.replace(/[^\w.\-一-龥]+/g, "_").slice(-120) || "upload.zip";
}
