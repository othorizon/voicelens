import { execute, one, query, scalar } from "@/lib/db";
import { deleteObject, uploadObject } from "@/lib/storage";
import { openZipBuffer, openZipObject, type ZipArchive, type ZipEntry } from "./zip";
import { bundleSessions, normalizeLine, type NormalizedMessage, type SessionBundle } from "./normalize";
import {
  isSchemaFilePath,
  mergeSchemaFields,
  parseSchemaFile,
  pickSchemaFile,
  type SchemaFileMode,
} from "@/lib/schema-file";
import type { ExtraFieldDef } from "@/lib/types";

export interface ImportResult {
  batchId: string;
  jsonlFiles: number;
  lines: number;
  sessions: number;
  messages: number;
  audios: number;
  failedAudios: number;
  skipped: number;
  errors: string[];
  /** Set when the archive carried an extra-schema description file. */
  schema: AppliedSchema | null;
}

export interface AppliedSchema {
  /** Path of the file inside the archive. */
  file: string;
  /** Fields the file described. */
  fields: number;
  /** Fields the data source ended up with. */
  total: number;
  mode: SchemaFileMode;
}

export interface ImportLogger {
  (message: string, extra?: Record<string, unknown>): void;
}

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|opus|webm|amr|pcm)$/i;
const CHUNK = 400;

/**
 * Ceiling on one uploaded archive.
 *
 * The bytes go browser -> bucket now, and the importer reads the archive out
 * of the bucket one entry at a time, so this is no longer a memory ceiling —
 * it is a sanity guard against a mis-picked file. What still scales with the
 * archive is the *record* side: every parsed message is held in memory while
 * the batch is written. Audio dominates a realistic archive, so 5GB of zip is
 * a comfortably large single batch; raise `IMPORT_MAX_ZIP_MB` if your data
 * says otherwise.
 */
const DEFAULT_MAX_ZIP_MB = 5120;

export function maxZipBytes(): number {
  const raw = Number(process.env.IMPORT_MAX_ZIP_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_ZIP_MB;
  return Math.round(mb) * 1024 * 1024;
}

/**
 * Where the importer reads the archive from: `buffer` for the generated demo
 * dataset, `object` for anything the browser uploaded to the bucket.
 */
export type ZipSource =
  | { kind: "buffer"; data: ArrayBuffer }
  | { kind: "object"; path: string };

function sanitizePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\\/g, "/").replace(/[^\w./\-\u4e00-\u9fa5]+/g, "_");
}

function audioFormat(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const ext = (m?.[1] ?? "").toLowerCase();
  return ext === "m4a" ? "mp4" : ext;
}

/**
 * Create the batch row.
 *
 * `pending` with a `sourceObject` is the normal path: the archive is in the
 * bucket and the Worker picks the job up from the queue. `processing` is for a
 * caller that is about to run the import itself in-process (the e2e script).
 */
export async function createImportBatch(
  dataSourceId: string,
  fileName: string,
  userId: string | null,
  options: { status?: "pending" | "processing"; sourceObject?: string | null } = {},
): Promise<string> {
  const status = options.status ?? "processing";
  try {
    const row = await one<{ id: string }>(
      `insert into import_batches
         (data_source_id, file_name, status, created_by, progress_detail, source_object, heartbeat_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, now())
       returning id`,
      [
        dataSourceId,
        fileName,
        status,
        userId,
        JSON.stringify({ step: "queued" }),
        options.sourceObject ?? null,
      ],
    );
    return row.id;
  } catch (err) {
    throw new Error(`无法创建导入批次: ${(err as Error).message}`);
  }
}

export async function importZip(
  dataSourceId: string,
  source: ZipSource,
  fileName: string,
  userId: string | null,
  log: ImportLogger = () => {},
  existingBatchId?: string,
): Promise<ImportResult> {
  const batchId = existingBatchId ?? (await createImportBatch(dataSourceId, fileName, userId));

  const errors: string[] = [];
  const result: ImportResult = {
    batchId,
    jsonlFiles: 0,
    lines: 0,
    sessions: 0,
    messages: 0,
    audios: 0,
    failedAudios: 0,
    skipped: 0,
    errors,
    schema: null,
  };

  // Held outside the try so the finally can close it, opened inside so a bad
  // archive is recorded on the batch row like any other failure.
  let archive: ZipArchive | null = null;

  try {
    const opened =
      source.kind === "buffer" ? await openZipBuffer(source.data) : await openZipObject(source.path);
    archive = opened;
    log("读取压缩包目录", { files: opened.entries.length });

    const jsonlEntries: ZipEntry[] = [];
    const audioEntries = new Map<string, ZipEntry>();

    for (const entry of opened.entries) {
      // Checked before the .json test below: the schema file describes the
      // data, it is not data, and parsing it as dialogue would count every
      // one of its lines as skipped.
      if (isSchemaFilePath(entry.path)) continue;
      if (/\.(jsonl|ndjson|json)$/i.test(entry.path)) jsonlEntries.push(entry);
      else if (AUDIO_EXT.test(entry.path)) {
        audioEntries.set(entry.path.split("/").pop()!.toLowerCase(), entry);
        audioEntries.set(sanitizePath(entry.path).toLowerCase(), entry);
      }
    }

    if (jsonlEntries.length === 0) throw new Error("压缩包内没有找到 .jsonl 文件");
    result.jsonlFiles = jsonlEntries.length;

    result.schema = await applySchemaFile(dataSourceId, opened.entries, log, errors);

    // ------------------------------------------------------------ 1. parse
    const all: NormalizedMessage[] = [];
    for (const entry of jsonlEntries) {
      const text = await entry.text();
      const stem = entry.path.split("/").pop()!.replace(/\.(jsonl|ndjson|json)$/i, "");
      const lines = text.split(/\r?\n/);
      let parsedHere = 0;
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const msgs = normalizeLine(trimmed, stem, i);
        if (msgs.length === 0) {
          result.skipped++;
          if (errors.length < 20) errors.push(`${entry.path}:${i + 1} 无法解析`);
          return;
        }
        all.push(...msgs);
        parsedHere += msgs.length;
      });
      result.lines += lines.length;
      log(`解析 ${entry.path}`, { messages: parsedHere });
    }
    if (all.length === 0) throw new Error("没有解析出任何对话记录");

    await execute(
      `update import_batches
       set total_entries = $2, progress_detail = $3::jsonb, heartbeat_at = now()
       where id = $1`,
      [batchId, all.length, JSON.stringify({ step: "bundle" })],
    );

    // ---------------------------------------------------------- 2. bundle
    const bundles = bundleSessions(all);
    log("按 session 归并完成", { sessions: bundles.length });

    // existing sessions (multi-batch append)
    const sessionKeys = bundles.map((b) => b.sessionKey);
    const existing = await query<ExistingSession>(
      `select id, session_key, turn_count, human_turn_count, ai_turn_count, audio_count,
              char_count, digest, started_at, ended_at
       from sessions
       where data_source_id = $1 and session_key = any($2::text[])`,
      [dataSourceId, sessionKeys.slice(0, 3000)],
    );

    const existingMap = new Map(existing.map((r) => [r.session_key, r]));

    // ------------------------------------------------------------ 3. audio
    const uploads = await uploadAudios(dataSourceId, batchId, bundles, audioEntries, log);
    result.audios = uploads.ok;
    result.failedAudios = uploads.failed;
    errors.push(...uploads.errors.slice(0, 10));

    // ------------------------------------------------------ 4. persist rows
  const sessionPkByKey = new Map<string, string>();
  const messageRows: MessageRowInsert[] = [];


    await execute(
      `update import_batches set progress_detail = $2::jsonb, heartbeat_at = now() where id = $1`,
      [batchId, JSON.stringify({ step: "write" })],
    );

    // One statement per slice: new sessions are inserted, sessions seen by an
    // earlier batch take the recomputed counters, and both come back with their
    // uuid, so no separate read-back is needed.
    for (const slice of chunk(bundles, 200)) {
      const rows = slice.map((b) => {
        const prev = existingMap.get(b.sessionKey);
        return {
          session_key: b.sessionKey,
          user_key: b.userKey,
          started_at: prev?.started_at && earlier(prev.started_at, b.startedAt) ? prev.started_at : b.startedAt,
          ended_at: prev?.ended_at && later(prev.ended_at, b.endedAt) ? prev.ended_at : b.endedAt,
          turn_count: (prev?.turn_count ?? 0) + b.messages.length,
          human_turn_count: (prev?.human_turn_count ?? 0) + b.messages.filter((m) => m.role === "user").length,
          ai_turn_count: (prev?.ai_turn_count ?? 0) + b.messages.filter((m) => m.role === "assistant").length,
          audio_count: (prev?.audio_count ?? 0) + b.messages.filter((m) => uploads.pathOf.has(m)).length,
          char_count: (prev?.char_count ?? 0) + b.messages.reduce((acc, m) => acc + m.contentText.length, 0),
          extra: JSON.stringify(b.extra ?? {}),
          digest: prev?.digest ? `${prev.digest}\n${b.digest}` : b.digest,
        };
      });

      let written: { id: string; session_key: string }[];
      try {
        written = await query<{ id: string; session_key: string }>(
          `insert into sessions
             (data_source_id, session_key, user_key, started_at, ended_at, turn_count,
              human_turn_count, ai_turn_count, audio_count, char_count, extra, digest,
              last_import_batch_id)
           select $1, t.session_key, t.user_key, t.started_at, t.ended_at, t.turn_count,
                  t.human_turn_count, t.ai_turn_count, t.audio_count, t.char_count, t.extra,
                  t.digest, $2
           from unnest($3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[], $7::int[],
                       $8::int[], $9::int[], $10::int[], $11::int[], $12::jsonb[], $13::text[])
             as t(session_key, user_key, started_at, ended_at, turn_count, human_turn_count,
                  ai_turn_count, audio_count, char_count, extra, digest)
           on conflict (data_source_id, session_key) do update
             set started_at = excluded.started_at,
                 ended_at = excluded.ended_at,
                 turn_count = excluded.turn_count,
                 human_turn_count = excluded.human_turn_count,
                 ai_turn_count = excluded.ai_turn_count,
                 audio_count = excluded.audio_count,
                 char_count = excluded.char_count,
                 extra = excluded.extra,
                 digest = excluded.digest,
                 last_import_batch_id = excluded.last_import_batch_id
           returning id, session_key`,
          [
            dataSourceId,
            batchId,
            rows.map((r) => r.session_key),
            rows.map((r) => r.user_key),
            rows.map((r) => r.started_at),
            rows.map((r) => r.ended_at),
            rows.map((r) => r.turn_count),
            rows.map((r) => r.human_turn_count),
            rows.map((r) => r.ai_turn_count),
            rows.map((r) => r.audio_count),
            rows.map((r) => r.char_count),
            rows.map((r) => r.extra),
            rows.map((r) => r.digest),
          ],
        );
      } catch (err) {
        throw new Error(`写入 session 失败: ${(err as Error).message}`);
      }

      for (const row of written) sessionPkByKey.set(row.session_key, row.id);
      result.sessions += slice.length;
    }

    for (const bundle of bundles) {
      const sessionPk = sessionPkByKey.get(bundle.sessionKey);
      if (!sessionPk) continue;
      const offset = existingMap.get(bundle.sessionKey)?.turn_count ?? 0;
      for (const m of bundle.messages) {
        messageRows.push({
          session_id: sessionPk,
          seq: offset + m.seq,
          role: m.role,
          // content is NOT NULL: fall back to the extracted text, then to "".
          content: JSON.stringify(m.content ?? m.contentText ?? ""),
          content_text: m.contentText,
          occurred_at: m.occurredAt,
          audio_path: uploads.pathOf.get(m) ?? null,
          audio_format: uploads.pathOf.has(m) ? audioFormat(m.audio ?? "") : null,
          audio_size: uploads.sizeOf.get(m) ?? null,
          extra: JSON.stringify(m.extra ?? {}),
        });
      }
    }

    await execute(
      `update import_batches
       set progress_detail = $2::jsonb, created_sessions = $3, heartbeat_at = now()
       where id = $1`,
      [batchId, JSON.stringify({ step: "messages" }), result.sessions],
    );

    for (const rows of chunk(messageRows, CHUNK)) {
      try {
        await execute(
          `insert into messages
             (data_source_id, session_id, seq, role, content, content_text, occurred_at,
              audio_path, audio_format, audio_size, extra, import_batch_id)
           select $1, t.session_id, t.seq, t.role, t.content, t.content_text, t.occurred_at,
                  t.audio_path, t.audio_format, t.audio_size, t.extra, $2
           from unnest($3::uuid[], $4::int[], $5::text[], $6::jsonb[], $7::text[],
                       $8::timestamptz[], $9::text[], $10::text[], $11::bigint[], $12::jsonb[])
             as t(session_id, seq, role, content, content_text, occurred_at, audio_path,
                  audio_format, audio_size, extra)`,
          [
            dataSourceId,
            batchId,
            rows.map((r) => r.session_id),
            rows.map((r) => r.seq),
            rows.map((r) => r.role),
            rows.map((r) => r.content),
            rows.map((r) => r.content_text),
            rows.map((r) => r.occurred_at),
            rows.map((r) => r.audio_path),
            rows.map((r) => r.audio_format),
            rows.map((r) => r.audio_size),
            rows.map((r) => r.extra),
          ],
        );
      } catch (err) {
        throw new Error(`写入 message 失败: ${(err as Error).message}`);
      }
      result.messages += rows.length;
      await execute(
        `update import_batches set created_messages = $2, heartbeat_at = now() where id = $1`,
        [batchId, result.messages],
      );
    }

    await execute(
      `update import_batches
       set status = 'completed', created_sessions = $2, created_messages = $3,
           uploaded_audios = $4, failed_audios = $5, skipped = $6, error = $7,
           finished_at = now(), progress_detail = $8::jsonb, heartbeat_at = now()
       where id = $1`,
      [
        batchId,
        result.sessions,
        result.messages,
        result.audios,
        result.failedAudios,
        result.skipped,
        errors.length ? errors.slice(0, 10).join("; ").slice(0, 900) : null,
        JSON.stringify({ step: "done", schema: result.schema }),
      ],
    );

    log("导入完成", { sessions: result.sessions, messages: result.messages, audios: result.audios });

    // The archive has been unpacked into the bucket entry by entry, so the
    // staged copy is now dead weight. A failed import keeps it, so a retry can
    // reuse the object instead of making the user upload it again.
    if (source.kind === "object" && process.env.IMPORT_KEEP_SOURCE_ZIP !== "true") {
      try {
        await deleteObject(source.path);
      } catch (err) {
        log("暂存压缩包清理失败", { path: source.path, error: (err as Error).message });
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await execute(
      `update import_batches set status = 'failed', error = $2, finished_at = now() where id = $1`,
      [batchId, message.slice(0, 1000)],
    );
    throw err;
  } finally {
    await archive?.close().catch(() => {});
  }
}

/**
 * Read the optional schema description file and configure the data source from it.
 *
 * Never fatal: an archive whose schema file is malformed still imports its
 * conversations, with the reason recorded on the batch — the data is the point,
 * and a rejected import would be a disproportionate answer to a typo in a file
 * that is optional in the first place.
 *
 * Defaults to `merge` because an import is not necessarily the whole dataset:
 * a later batch that describes three new fields should not wipe the twenty a
 * human configured. A file that means to start over says `"mode": "replace"`.
 */
async function applySchemaFile(
  dataSourceId: string,
  entries: ZipEntry[],
  log: ImportLogger,
  errors: string[],
): Promise<AppliedSchema | null> {
  const entry = pickSchemaFile(entries);
  if (!entry) return null;

  const found = entries.filter((e) => isSchemaFilePath(e.path));
  if (found.length > 1) {
    log("压缩包内有多个 schema 文件，只应用一个", { picked: entry.path, found: found.length });
    errors.push(`压缩包内有 ${found.length} 个 schema 文件，只应用了 ${entry.path}`);
  }

  try {
    const parsed = parseSchemaFile(await entry.text());
    const mode = parsed.mode ?? "merge";
    const current = (await scalar<ExtraFieldDef[]>(
      `select extra_schema from data_sources where id = $1`,
      [dataSourceId],
    )) ?? [];
    const next = mergeSchemaFields(current, parsed.fields, mode);

    await execute(
      `update data_sources set extra_schema = $2::jsonb, updated_at = now() where id = $1`,
      [dataSourceId, JSON.stringify(next)],
    );

    for (const w of parsed.warnings.slice(0, 5)) errors.push(`schema 文件：${w}`);
    log("已应用 schema 描述文件", {
      file: entry.path,
      mode,
      fields: parsed.fields.length,
      total: next.length,
      warnings: parsed.warnings.length,
    });
    return { file: entry.path, fields: parsed.fields.length, total: next.length, mode };
  } catch (err) {
    const message = (err as Error).message;
    log("schema 描述文件解析失败，已跳过", { file: entry.path, error: message });
    errors.push(`schema 文件 ${entry.path} 未生效：${message}`);
    return null;
  }
}

interface MessageRowInsert {
  session_id: string;
  seq: number;
  role: string;
  content: string;
  content_text: string;
  occurred_at: string | null;
  audio_path: string | null;
  audio_format: string | null;
  audio_size: number | null;
  extra: string;
}

interface ExistingSession {
  id: string;
  session_key: string;
  turn_count: number;
  human_turn_count: number;
  ai_turn_count: number;
  audio_count: number;
  char_count: number;
  digest: string | null;
  started_at: string | null;
  ended_at: string | null;
}

async function uploadAudios(
  dataSourceId: string,
  batchId: string,
  bundles: SessionBundle[],
  audioEntries: Map<string, ZipEntry>,
  log: ImportLogger,
) {
  const pathOf = new Map<NormalizedMessage, string>();
  const sizeOf = new Map<NormalizedMessage, number>();
  const errors: string[] = [];
  let ok = 0;
  let failed = 0;

  const jobs: { msg: NormalizedMessage; entry: ZipEntry; objectPath: string }[] = [];
  const usedPaths = new Set<string>();

  for (const bundle of bundles) {
    for (const msg of bundle.messages) {
      if (!msg.audio) continue;
      const key = msg.audio.split("/").pop()!.toLowerCase();
      const entry =
        audioEntries.get(key) ?? audioEntries.get(sanitizePath(msg.audio).toLowerCase());
      if (!entry) {
        failed++;
        if (errors.length < 10) errors.push(`音频缺失: ${msg.audio}`);
        continue;
      }
      const base = entry.path.split("/").pop()!;
      let objectPath = sanitizePath(`${dataSourceId}/${batchId}/${base}`);
      if (usedPaths.has(objectPath)) {
        objectPath = sanitizePath(`${dataSourceId}/${batchId}/${bundle.sessionKey}-${msg.seq}-${base}`);
      }
      usedPaths.add(objectPath);
      jobs.push({ msg, entry, objectPath });
    }
  }

  if (jobs.length === 0) return { pathOf, sizeOf, errors, ok, failed };

  log("开始上传音频", { count: jobs.length });
  const concurrency = 6;
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        const buffer = await job.entry.bytes();
        await uploadObject(job.objectPath, buffer, mimeOf(job.entry.path));
        pathOf.set(job.msg, job.objectPath);
        sizeOf.set(job.msg, buffer.byteLength);
        ok++;
      } catch (e) {
        failed++;
        if (errors.length < 10) errors.push(`音频上传失败 ${job.entry.path}: ${(e as Error).message}`);
      }
      done++;
      if (done % 25 === 0) {
        log(`音频上传进度`, { done, total: jobs.length });
        // The long phase. Without this the batch would look abandoned to the
        // stale sweep while it is in fact working.
        await execute(
          `update import_batches
           set heartbeat_at = now(), progress_detail = $2::jsonb, uploaded_audios = $3
           where id = $1`,
          [batchId, JSON.stringify({ step: "audio", done, total: jobs.length }), ok],
        ).catch(() => {});
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  log("音频上传完成", { ok, failed });
  return { pathOf, sizeOf, errors, ok, failed };
}

function mimeOf(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return (
    {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      flac: "audio/flac",
      ogg: "audio/ogg",
      opus: "audio/ogg",
      webm: "audio/webm",
      amr: "audio/amr",
      pcm: "audio/pcm",
    } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function earlier(a: string | null, b: string | null): boolean {
  if (!a) return false;
  if (!b) return true;
  return Date.parse(a) <= Date.parse(b);
}
function later(a: string | null, b: string | null): boolean {
  if (!a) return false;
  if (!b) return true;
  return Date.parse(a) >= Date.parse(b);
}

export { audioFormat, mimeOf, chunk, sanitizePath };
