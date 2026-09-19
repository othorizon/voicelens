import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";

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
export const UPLOAD_URL_TTL = 3600; // 1 hour per batch of part URLs; re-signed as the upload advances

/**
 * Multipart sizing. S3 and OSS both cap an upload at 10000 parts and require
 * every part except the last to be at least 5MiB; 8MiB parts keep a single
 * retry cheap and still reach ~76GiB before the part count matters.
 */
export const MIN_PART_SIZE = 8 * 1024 * 1024;
export const MAX_PARTS = 10_000;

/** Part size for an upload of `totalBytes`, always a whole number of MiB. */
export function partSizeFor(totalBytes: number): number {
  // Leave headroom under MAX_PARTS so a rounding-up never crosses the cap.
  const needed = Math.ceil(Math.max(totalBytes, 1) / (MAX_PARTS - 500));
  const mib = Math.ceil(needed / (1024 * 1024)) * 1024 * 1024;
  return Math.max(MIN_PART_SIZE, mib);
}

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

/** Byte length of one object, for readers that need to seek in it. */
export async function objectSize(path: string): Promise<number> {
  const head = await client().send(
    new HeadObjectCommand({ Bucket: storageBucket(), Key: path }),
  );
  const size = head.ContentLength;
  if (typeof size !== "number") throw new Error(`对象 ${path} 没有返回 Content-Length`);
  return size;
}

/** One byte range of an object, `end` inclusive — the HTTP Range convention. */
export async function getObjectRange(
  path: string,
  start: number,
  end: number,
): Promise<Readable> {
  const res = await client().send(
    new GetObjectCommand({
      Bucket: storageBucket(),
      Key: path,
      Range: `bytes=${start}-${end}`,
    }),
  );
  if (!res.Body) throw new Error(`对象 ${path} 的 ${start}-${end} 区间为空`);
  return res.Body as Readable;
}

/** Drop one object. Missing keys are not an error. */
export async function deleteObject(path: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: storageBucket(), Key: path }));
}

/* ------------------------------------------------------- multipart uploads */

/**
 * Browser-direct uploads. The bytes go straight from the browser to the
 * bucket over presigned PUT URLs, one per part; the server only ever holds
 * the small JSON that arranges them.
 *
 * Multipart is also what makes an interrupted upload resumable: parts that
 * landed stay on the server until the upload is completed or aborted, so
 * `listUploadedParts` answers "where did we get to" after a refresh, a lost
 * connection or a closed laptop.
 */

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export async function createMultipartUpload(
  path: string,
  contentType: string,
): Promise<string> {
  const res = await client().send(
    new CreateMultipartUploadCommand({
      Bucket: storageBucket(),
      Key: path,
      ContentType: contentType,
    }),
  );
  if (!res.UploadId) throw new Error("对象存储没有返回 uploadId");
  return res.UploadId;
}

/** Presigned PUT URL for one part. The browser PUTs the slice to it as-is. */
export function signPartUpload(
  path: string,
  uploadId: string,
  partNumber: number,
  expiresIn: number = UPLOAD_URL_TTL,
): Promise<string> {
  return getSignedUrl(
    client(),
    new UploadPartCommand({
      Bucket: storageBucket(),
      Key: path,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn },
  );
}

/**
 * Every part the bucket has accepted so far, ascending. This is the resume
 * point *and* the ETag source for completing the upload — the browser never
 * has to read an ETag back, so the bucket's CORS rules do not need to expose
 * that header.
 */
export async function listUploadedParts(
  path: string,
  uploadId: string,
): Promise<UploadedPart[]> {
  const parts: UploadedPart[] = [];
  let marker: string | undefined;

  do {
    const res = await client().send(
      new ListPartsCommand({
        Bucket: storageBucket(),
        Key: path,
        UploadId: uploadId,
        PartNumberMarker: marker,
      }),
    );
    for (const p of res.Parts ?? []) {
      if (typeof p.PartNumber !== "number" || !p.ETag) continue;
      parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0 });
    }
    marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
  } while (marker);

  parts.sort((a, b) => a.partNumber - b.partNumber);
  return parts;
}

/** Stitch the uploaded parts into the final object. */
export async function completeMultipartUpload(
  path: string,
  uploadId: string,
  parts: UploadedPart[],
): Promise<void> {
  await client().send(
    new CompleteMultipartUploadCommand({
      Bucket: storageBucket(),
      Key: path,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

/** Throw away an unfinished upload and the parts it is holding. */
export async function abortMultipartUpload(path: string, uploadId: string): Promise<void> {
  await client().send(
    new AbortMultipartUploadCommand({
      Bucket: storageBucket(),
      Key: path,
      UploadId: uploadId,
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
