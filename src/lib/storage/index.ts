import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object storage for conversation audio, over the S3 API. Written against
 * Aliyun OSS's S3-compatible endpoint, but any S3-compatible service works
 * (AWS S3, MinIO, R2).
 *
 * Audio bytes never pass through the browser or the model client: the bucket
 * stays private and everything reads through a short-lived presigned URL.
 */

export const PLAYBACK_URL_TTL = 600; // 10 minutes, browser playback
export const MODEL_URL_TTL = 3600; // 1 hour, long enough for a model to fetch

let cached: S3Client | null = null;

export function storageBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET is not configured");
  return bucket;
}

export function storageConfigured(): boolean {
  return Boolean(
    process.env.S3_BUCKET &&
      process.env.S3_ENDPOINT &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY,
  );
}

function client(): S3Client {
  if (cached) return cached;

  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are not configured");
  }

  cached = new S3Client({
    endpoint,
    // OSS derives its region from the endpoint; the SDK still wants one for
    // signing, so `S3_REGION` defaults to something harmless.
    region: process.env.S3_REGION || "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    // OSS addresses buckets virtual-host style (bucket.oss-cn-….aliyuncs.com).
    // MinIO and some gateways need path style instead.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    // Recent SDK versions attach CRC32 checksum headers to every upload, which
    // OSS's S3 layer rejects. Only send them when the operation requires it.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return cached;
}

/** Store one object. Overwrites whatever is already at `path`. */
export async function uploadObject(
  path: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: storageBucket(),
      Key: path,
      Body: body,
      ContentType: contentType,
      ContentLength: body.byteLength,
    }),
  );
}

/**
 * Presigned GET URL, or null when signing fails. Callers treat null as "audio
 * unavailable" and carry on without it.
 */
export async function signedUrl(path: string, expiresIn: number): Promise<string | null> {
  if (!path) return null;
  try {
    return await getSignedUrl(
      client(),
      new GetObjectCommand({ Bucket: storageBucket(), Key: path }),
      { expiresIn },
    );
  } catch {
    return null;
  }
}

/** Presign many objects at once, skipping any that fail. */
export async function signedUrls(
  paths: string[],
  expiresIn: number,
  concurrency = 6,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(paths.filter(Boolean))];
  let cursor = 0;

  async function worker() {
    while (cursor < unique.length) {
      const path = unique[cursor++];
      const url = await signedUrl(path, expiresIn);
      if (url) out.set(path, url);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()),
  );
  return out;
}
