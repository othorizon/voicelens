/**
 * Browser-direct multipart upload.
 *
 * The archive goes from the file picker straight to the bucket: the app server
 * only ever sees the small JSON that mints the upload, hands out presigned PUT
 * URLs and stitches the parts together. Nothing here is bounded by the
 * server's memory or by a request body limit.
 *
 * Resuming (断点续传) falls out of the same mechanism. Parts the bucket has
 * accepted stay there until the upload is completed or aborted, so the handle
 * below is written to localStorage as soon as the upload is minted and the
 * next attempt on the same file asks the bucket what already landed and
 * uploads only the gaps — across a paused upload, a reload or a closed tab.
 */

export interface UploadProgress {
  /** Bytes confirmed at the bucket, including parts carried over from a resume. */
  loaded: number;
  total: number;
  /** True while replaying an interrupted upload rather than starting one. */
  resumed: boolean;
}

export interface UploadOptions {
  sourceId: string;
  file: File;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

interface Handle {
  key: string;
  uploadId: string;
  partSize: number;
}

/** Concurrent part PUTs. Enough to fill a fat pipe, few enough to stay polite. */
const CONCURRENCY = 3;
/** Attempts per part before the whole upload gives up. */
const PART_RETRIES = 3;

export class UploadAbortedError extends Error {
  constructor() {
    super("上传已取消");
    this.name = "UploadAbortedError";
  }
}

/**
 * Put `file` in the bucket and return its object key, resuming a previous
 * attempt on the same file when one is still open.
 */
export async function uploadArchive(opts: UploadOptions): Promise<string> {
  const { sourceId, file, signal, onProgress } = opts;
  const storeKey = resumeKey(sourceId, file);

  let handle = readHandle(storeKey);
  let done = new Map<number, number>();
  let resumed = false;

  if (handle) {
    const parts = await fetchParts(sourceId, handle, signal);
    if (parts) {
      done = new Map(parts.map((p) => [p.partNumber, p.size]));
      resumed = done.size > 0;
    } else {
      // Expired or aborted upstream — forget it and start clean.
      clearHandle(storeKey);
      handle = null;
    }
  }

  if (!handle) {
    handle = await createUpload(sourceId, file, signal);
    writeHandle(storeKey, handle);
  }

  const { partSize } = handle;
  const partCount = Math.max(1, Math.ceil(file.size / partSize));

  // A part that is already up but the wrong length is from a stale attempt
  // with a different part size; re-upload it rather than trust it.
  for (const [number, size] of done) {
    if (number > partCount || size !== sliceLength(file, number, partSize)) done.delete(number);
  }

  const pending: number[] = [];
  for (let n = 1; n <= partCount; n++) if (!done.has(n)) pending.push(n);

  let loaded = [...done.values()].reduce((a, b) => a + b, 0);
  const inFlight = new Map<number, number>();
  const report = () => {
    const live = [...inFlight.values()].reduce((a, b) => a + b, 0);
    onProgress?.({ loaded: Math.min(loaded + live, file.size), total: file.size, resumed });
  };
  report();

  const urls = new Map<number, string>();
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (signal?.aborted) throw new UploadAbortedError();
      const index = cursor++;
      if (index >= pending.length) return;
      const number = pending[index];

      if (!urls.has(number)) {
        // Sign in blocks ahead of the cursor so URLs never sit around long
        // enough to expire on a slow connection.
        const block = pending.slice(index, index + 50).filter((n) => !urls.has(n));
        for (const { part, url } of await signParts(sourceId, handle!, block, signal)) {
          urls.set(part, url);
        }
      }

      const blob = file.slice((number - 1) * partSize, number * partSize);
      await putPart(urls.get(number)!, blob, signal, (sent) => {
        inFlight.set(number, sent);
        report();
      });

      inFlight.delete(number);
      loaded += blob.size;
      report();
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  const key = await completeUpload(sourceId, handle, signal);
  clearHandle(storeKey);
  return key;
}

/** Drop an interrupted upload and the parts the bucket is holding for it. */
export async function discardUpload(sourceId: string, file: File): Promise<void> {
  const storeKey = resumeKey(sourceId, file);
  const handle = readHandle(storeKey);
  clearHandle(storeKey);
  if (!handle) return;
  await call(sourceId, { action: "abort", key: handle.key, uploadId: handle.uploadId }).catch(
    () => {},
  );
}

/** Bytes already at the bucket for this file, for a "继续上传" hint in the UI. */
export function pendingUpload(sourceId: string, file: File): boolean {
  return readHandle(resumeKey(sourceId, file)) !== null;
}

/* ------------------------------------------------------------- server calls */

async function call(
  sourceId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`/api/sources/${sourceId}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function json<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data;
}

async function createUpload(sourceId: string, file: File, signal?: AbortSignal): Promise<Handle> {
  const res = await call(
    sourceId,
    { action: "create", fileName: file.name, size: file.size },
    signal,
  );
  const data = await json<Handle>(res);
  return { key: data.key, uploadId: data.uploadId, partSize: data.partSize };
}

async function fetchParts(
  sourceId: string,
  handle: Handle,
  signal?: AbortSignal,
): Promise<{ partNumber: number; size: number }[] | null> {
  const res = await call(
    sourceId,
    { action: "status", key: handle.key, uploadId: handle.uploadId },
    signal,
  );
  if (res.status === 410 || res.status === 404) return null;
  const data = await json<{ parts: { partNumber: number; size: number }[] }>(res);
  return data.parts ?? [];
}

async function signParts(
  sourceId: string,
  handle: Handle,
  parts: number[],
  signal?: AbortSignal,
): Promise<{ part: number; url: string }[]> {
  if (parts.length === 0) return [];
  const res = await call(
    sourceId,
    { action: "sign", key: handle.key, uploadId: handle.uploadId, parts },
    signal,
  );
  const data = await json<{ urls: { part: number; url: string }[] }>(res);
  return data.urls;
}

async function completeUpload(
  sourceId: string,
  handle: Handle,
  signal?: AbortSignal,
): Promise<string> {
  const res = await call(
    sourceId,
    { action: "complete", key: handle.key, uploadId: handle.uploadId },
    signal,
  );
  const data = await json<{ key: string }>(res);
  return data.key;
}

/**
 * PUT one slice straight at the bucket.
 *
 * XHR rather than fetch: it is the only way to get upload progress, and the
 * only way to cancel a transfer that is already streaming.
 */
function putPart(
  url: string,
  blob: Blob,
  signal: AbortSignal | undefined,
  onProgress: (sent: number) => void,
): Promise<void> {
  return retry(
    () =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new UploadAbortedError());

        const xhr = new XMLHttpRequest();
        const cancel = () => xhr.abort();
        signal?.addEventListener("abort", cancel, { once: true });

        const settle = (fn: () => void) => {
          signal?.removeEventListener("abort", cancel);
          fn();
        };

        xhr.open("PUT", url, true);
        xhr.upload.onprogress = (e) => onProgress(e.loaded);
        xhr.onload = () =>
          settle(() =>
            xhr.status >= 200 && xhr.status < 300
              ? resolve()
              : reject(new Error(`分片上传失败（${xhr.status}）`)),
          );
        // The browser hides the reason for a cross-origin failure, and a
        // missing CORS rule on the bucket is by far the likeliest one.
        xhr.onerror = () =>
          settle(() =>
            reject(
              new Error(
                "分片上传失败：浏览器无法直传到对象存储。请检查 Bucket 的跨域（CORS）规则是否允许本站点的 PUT 请求。",
              ),
            ),
          );
        xhr.onabort = () => settle(() => reject(new UploadAbortedError()));
        xhr.send(blob);
      }),
    PART_RETRIES,
    signal,
  );
}

async function retry<T>(fn: () => Promise<T>, attempts: number, signal?: AbortSignal): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UploadAbortedError || signal?.aborted) throw err;
      last = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/* ------------------------------------------------------------ resume state */

function resumeKey(sourceId: string, file: File): string {
  // Name + size + mtime is what identifies "the same file" to a browser; the
  // File API gives nothing stronger without reading the whole thing.
  return `voicelens:upload:${sourceId}:${file.name}:${file.size}:${file.lastModified}`;
}

function readHandle(storeKey: string): Handle | null {
  try {
    const raw = localStorage.getItem(storeKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Handle>;
    if (!parsed.key || !parsed.uploadId || !parsed.partSize) return null;
    return { key: parsed.key, uploadId: parsed.uploadId, partSize: parsed.partSize };
  } catch {
    return null;
  }
}

function writeHandle(storeKey: string, handle: Handle): void {
  try {
    localStorage.setItem(storeKey, JSON.stringify(handle));
  } catch {
    // Private mode or a full quota: the upload still works, it just cannot resume.
  }
}

function clearHandle(storeKey: string): void {
  try {
    localStorage.removeItem(storeKey);
  } catch {
    /* nothing to clean up */
  }
}

function sliceLength(file: File, partNumber: number, partSize: number): number {
  return Math.min(partSize, file.size - (partNumber - 1) * partSize);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) || rounded >= 10 ? Math.round(rounded) : rounded.toFixed(1)}${units[unit]}`;
}
