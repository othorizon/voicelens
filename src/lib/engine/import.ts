import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bundleSessions, normalizeLine, type NormalizedMessage, type SessionBundle } from "./normalize";

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
}

export interface ImportLogger {
  (message: string, extra?: Record<string, unknown>): void;
}

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|opus|webm|amr|pcm)$/i;
const CHUNK = 400;

function sanitizePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\\/g, "/").replace(/[^\w./\-\u4e00-\u9fa5]+/g, "_");
}

function audioFormat(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const ext = (m?.[1] ?? "").toLowerCase();
  return ext === "m4a" ? "mp4" : ext;
}

export async function createImportBatch(
  supabase: SupabaseClient,
  dataSourceId: string,
  fileName: string,
  userId: string | null,
): Promise<string> {
  const { data, error } = await supabase
    .from("import_batches")
    .insert({
      data_source_id: dataSourceId,
      file_name: fileName,
      status: "processing",
      created_by: userId,
      progress_detail: { step: "queued" },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`无法创建导入批次: ${error?.message ?? "unknown"}`);
  return data.id as string;
}

export async function importZip(
  supabase: SupabaseClient,
  dataSourceId: string,
  zipBuffer: ArrayBuffer,
  fileName: string,
  userId: string | null,
  log: ImportLogger = () => {},
  existingBatchId?: string,
): Promise<ImportResult> {
  const batchId = existingBatchId ?? (await createImportBatch(supabase, dataSourceId, fileName, userId));

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
  };

  try {
    const zip = await JSZip.loadAsync(zipBuffer);
    log("解压完成", { files: Object.keys(zip.files).length });

    const jsonlEntries: { path: string; file: JSZip.JSZipObject }[] = [];
    const audioEntries = new Map<string, JSZip.JSZipObject>();

    zip.forEach((path, file) => {
      if (file.dir) return;
      if (/\.(jsonl|ndjson|json)$/i.test(path)) jsonlEntries.push({ path, file });
      else if (AUDIO_EXT.test(path)) {
        audioEntries.set(path.split("/").pop()!.toLowerCase(), file);
        audioEntries.set(sanitizePath(path).toLowerCase(), file);
      }
    });

    if (jsonlEntries.length === 0) throw new Error("压缩包内没有找到 .jsonl 文件");
    result.jsonlFiles = jsonlEntries.length;

    // ------------------------------------------------------------ 1. parse
    const all: NormalizedMessage[] = [];
    for (const entry of jsonlEntries) {
      const text = await entry.file.async("string");
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

    await supabase
      .from("import_batches")
      .update({ total_entries: all.length, progress_detail: { step: "bundle" } })
      .eq("id", batchId);

    // ---------------------------------------------------------- 2. bundle
    const bundles = bundleSessions(all);
    log("按 session 归并完成", { sessions: bundles.length });

    // existing sessions (multi-batch append)
    const sessionKeys = bundles.map((b) => b.sessionKey);
    const { data: existing } = await supabase
      .from("sessions")
      .select("id, session_key, turn_count, human_turn_count, ai_turn_count, audio_count, char_count, digest, started_at, ended_at")
      .eq("data_source_id", dataSourceId)
      .in("session_key", sessionKeys.slice(0, 3000));

    const existingMap = new Map(
      (existing ?? []).map((r) => [r.session_key as string, r as ExistingSession]),
    );

    // ------------------------------------------------------------ 3. audio
    const uploads = await uploadAudios(supabase, dataSourceId, batchId, bundles, audioEntries, log);
    result.audios = uploads.ok;
    result.failedAudios = uploads.failed;
    errors.push(...uploads.errors.slice(0, 10));

    // ------------------------------------------------------ 4. persist rows
  const sessionPkByKey = new Map<string, string>();
  const messageRows: MessageRowInsert[] = [];


    await supabase
      .from("import_batches")
      .update({ progress_detail: { step: "write" } })
      .eq("id", batchId);

    // Insert new sessions / update existing ones, then read back their uuids.
    for (const slice of chunk(bundles, 200)) {
      const inserts: SessionRowInsert[] = [];
      const touchedKeys: string[] = [];

      for (const b of slice) {
        const prev = existingMap.get(b.sessionKey);
        touchedKeys.push(b.sessionKey);
        const counters = {
          started_at: prev?.started_at && earlier(prev.started_at, b.startedAt) ? prev.started_at : b.startedAt,
          ended_at: prev?.ended_at && later(prev.ended_at, b.endedAt) ? prev.ended_at : b.endedAt,
          turn_count: (prev?.turn_count ?? 0) + b.messages.length,
          human_turn_count: (prev?.human_turn_count ?? 0) + b.messages.filter((m) => m.role === "user").length,
          ai_turn_count: (prev?.ai_turn_count ?? 0) + b.messages.filter((m) => m.role === "assistant").length,
          audio_count: (prev?.audio_count ?? 0) + b.messages.filter((m) => uploads.pathOf.has(m)).length,
          char_count: (prev?.char_count ?? 0) + b.messages.reduce((s, m) => s + m.contentText.length, 0),
          extra: b.extra,
          digest: prev?.digest ? `${prev.digest}\n${b.digest}` : b.digest,
          last_import_batch_id: batchId,
        };

        if (prev) {
          const { error } = await supabase.from("sessions").update(counters as never).eq("id", prev.id);
          if (error) throw new Error(`更新 session 失败: ${error.message}`);
          continue;
        }

        inserts.push({
          data_source_id: dataSourceId,
          session_key: b.sessionKey,
          user_key: b.userKey,
          ...counters,
        } satisfies SessionRowInsert);
      }

      // Rows are kept homogeneous so PostgREST never fills a missing column with NULL.
      if (inserts.length) {
        const { error } = await supabase.from("sessions").insert(inserts as never);
        if (error) throw new Error(`写入 session 失败: ${error.message}`);
      }

      const { data: inserted, error: readErr } = await supabase
        .from("sessions")
        .select("id, session_key")
        .eq("data_source_id", dataSourceId)
        .in("session_key", touchedKeys);
      if (readErr) throw new Error(`回读 session 失败: ${readErr.message}`);
      for (const row of inserted ?? []) sessionPkByKey.set(String(row.session_key), String(row.id));
      result.sessions += slice.length;
    }

    for (const bundle of bundles) {
      const sessionPk = sessionPkByKey.get(bundle.sessionKey);
      if (!sessionPk) continue;
      const offset = existingMap.get(bundle.sessionKey)?.turn_count ?? 0;
      for (const m of bundle.messages) {
        messageRows.push({
          data_source_id: dataSourceId,
          session_id: sessionPk,
          seq: offset + m.seq,
          role: m.role,
          content: m.content ?? m.contentText,
          content_text: m.contentText,
          occurred_at: m.occurredAt,
          audio_path: uploads.pathOf.get(m) ?? null,
          audio_format: uploads.pathOf.has(m) ? audioFormat(m.audio ?? "") : null,
          audio_size: uploads.sizeOf.get(m) ?? null,
          extra: m.extra ?? {},
          import_batch_id: batchId,
        });
      }
    }

    await supabase
      .from("import_batches")
      .update({ progress_detail: { step: "messages" }, created_sessions: result.sessions })
      .eq("id", batchId);

    for (const rows of chunk(messageRows, CHUNK)) {
      const { error } = await supabase.from("messages").insert(rows as never);
      if (error) throw new Error(`写入 message 失败: ${error.message}`);
      result.messages += rows.length;
      await supabase
        .from("import_batches")
        .update({ created_messages: result.messages })
        .eq("id", batchId);
    }

    await supabase
      .from("import_batches")
      .update({
        status: "completed",
        created_sessions: result.sessions,
        created_messages: result.messages,
        uploaded_audios: result.audios,
        failed_audios: result.failedAudios,
        skipped: result.skipped,
        error: errors.length ? errors.slice(0, 10).join("; ").slice(0, 900) : null,
        finished_at: new Date().toISOString(),
        progress_detail: { step: "done" },
      })
      .eq("id", batchId);

    log("导入完成", { sessions: result.sessions, messages: result.messages, audios: result.audios });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("import_batches")
      .update({ status: "failed", error: message.slice(0, 1000), finished_at: new Date().toISOString() })
      .eq("id", batchId);
    throw err;
  }
}

type SessionRowInsert = Record<string, unknown>;
type MessageRowInsert = Record<string, unknown>;
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
  supabase: SupabaseClient,
  dataSourceId: string,
  batchId: string,
  bundles: SessionBundle[],
  audioEntries: Map<string, JSZip.JSZipObject>,
  log: ImportLogger,
) {
  const pathOf = new Map<NormalizedMessage, string>();
  const sizeOf = new Map<NormalizedMessage, number>();
  const errors: string[] = [];
  let ok = 0;
  let failed = 0;

  const jobs: { msg: NormalizedMessage; entry: JSZip.JSZipObject; objectPath: string }[] = [];
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
      const base = entry.name.split("/").pop()!;
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
        const buffer = await job.entry.async("uint8array");
        const contentType = mimeOf(job.entry.name);
        const { error } = await supabase.storage.from("audio").upload(job.objectPath, buffer, {
          contentType,
          upsert: true,
        });
        if (error) throw new Error(error.message);
        pathOf.set(job.msg, job.objectPath);
        sizeOf.set(job.msg, buffer.byteLength);
        ok++;
      } catch (e) {
        failed++;
        if (errors.length < 10) errors.push(`音频上传失败 ${job.entry.name}: ${(e as Error).message}`);
      }
      done++;
      if (done % 25 === 0) log(`音频上传进度`, { done, total: jobs.length });
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
