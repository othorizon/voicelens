"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UploadCloud,
  FileArchive,
  Loader2,
  CheckCircle2,
  XCircle,
  Download,
  Wand2,
  Info,
  Music4,
  Ban,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/ui-kit";
import { cn, compactNumber, formatDate, relativeTime } from "@/lib/utils";
import {
  UploadAbortedError,
  discardUpload,
  formatBytes,
  pendingUpload,
  uploadArchive,
} from "@/lib/upload/multipart";
import { retryBatch } from "@/lib/actions/sources";
import type { JsonObject } from "@/lib/types";

interface Batch extends JsonObject {
  id: string;
  file_name: string | null;
  status: string;
  total_entries: number;
  created_sessions: number;
  created_messages: number;
  uploaded_audios: number;
  failed_audios: number;
  skipped: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  progress_detail: JsonObject | null;
  source_object: string | null;
}

const STAGE_NOTE: Record<string, string> = {
  queued: "等待 Worker 认领",
  claimed: "Worker 已认领",
  unzip: "解压压缩包",
  bundle: "按 session 归并",
  write: "写入会话记录",
  messages: "写入消息记录",
  audio: "上传音频到对象存储",
  done: "完成",
};

export function ImportPanel({
  sourceId,
  batches,
  autoRefresh,
  maxBytes,
}: {
  sourceId: string;
  batches: JsonObject[];
  autoRefresh: boolean;
  maxBytes: number;
}) {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [note, setNote] = useState("");
  const [seeding, setSeeding] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<File | null>(null);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [autoRefresh, router]);

  // The bytes go browser -> bucket over presigned part URLs; this app only
  // arranges the upload and then points the importer at the finished object.
  const upload = useCallback(
    async (file: File) => {
      if (!/\.zip$/i.test(file.name)) {
        toast.error("请上传 .zip 压缩包");
        return;
      }
      if (file.size > maxBytes) {
        toast.error(`压缩包 ${formatBytes(file.size)} 超过 ${formatBytes(maxBytes)} 上限，请拆分后再导入`);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      fileRef.current = file;
      setUploading(true);
      setPercent(0);
      setNote(pendingUpload(sourceId, file) ? "正在续传未完成的上传…" : "正在上传到对象存储…");

      try {
        const key = await uploadArchive({
          sourceId,
          file,
          signal: controller.signal,
          onProgress: ({ loaded, total, resumed }) => {
            setPercent(total ? Math.round((loaded / total) * 100) : 0);
            setNote(
              `${resumed ? "续传" : "上传"} ${formatBytes(loaded)} / ${formatBytes(total)}`,
            );
          },
        });

        setNote("上传完成，正在排队导入…");
        const res = await fetch(`/api/sources/${sourceId}/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key, fileName: file.name, mode: "background" }),
        });
        const json = (await res.json()) as { batchId?: string; error?: string };
        if (!res.ok || !json.batchId) throw new Error(json.error ?? "导入提交失败");

        toast.success("压缩包已上传，已排队等待 Worker 解析导入");
        setPercent(100);
        router.refresh();
      } catch (e) {
        if (e instanceof UploadAbortedError || controller.signal.aborted) {
          toast.info("上传已暂停，重新选择同一个文件即可从断点继续");
        } else {
          toast.error(e instanceof Error ? e.message : "上传失败");
        }
      } finally {
        abortRef.current = null;
        setTimeout(() => {
          setUploading(false);
          setPercent(0);
          setNote("");
        }, 700);
      }
    },
    [maxBytes, router, sourceId],
  );

  // Pause: in-flight PUTs stop, but the parts already accepted by the bucket
  // stay, so picking the same file again resumes instead of restarting.
  const pause = useCallback(() => abortRef.current?.abort(), []);

  // Cancel: also tell the bucket to throw the accepted parts away, so an
  // abandoned upload does not sit there billing for storage.
  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    const file = fileRef.current;
    if (file) await discardUpload(sourceId, file);
  }, [sourceId]);

  async function retry(batchId: string) {
    setRetrying(batchId);
    try {
      await retryBatch(batchId);
      toast.success("已重新排队，Worker 会用原来的压缩包再导入一次");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "重试失败");
    } finally {
      setRetrying(null);
    }
  }

  async function seedDemo() {
    setSeeding(true);
    try {
      const res = await fetch(`/api/demo/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId, sessions: 90 }),
      });
      const json = (await res.json()) as { batchId?: string; error?: string; stats?: JsonObject };
      if (!res.ok || !json.batchId) throw new Error(json.error ?? "生成示例数据失败");
      const s = (json.stats ?? {}) as JsonObject;
      toast.success(`示例数据已开始导入：${s.sessions} 会话 · ${s.records} 条消息 · ${s.audios} 段音频`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "生成示例数据失败");
    } finally {
      setSeeding(false);
    }
  }

  const list = batches as Batch[];

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 p-4 md:p-8">
      <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">上传压缩包</CardTitle>
            <CardDescription className="text-[12.5px]">
              一个 zip = 一个对话 JSONL + 若干音频文件。可多次多批导入，同一 sessionId 会自动追加到已有会话。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!uploading) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (uploading) return;
                const file = e.dataTransfer.files?.[0];
                if (file) void upload(file);
              }}
              onClick={() => {
                // One upload at a time: the picker would otherwise start a
                // second transfer on top of the one in flight.
                if (!uploading) inputRef.current?.click();
              }}
              className={cn(
                "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
                uploading
                  ? "cursor-default border-border/80 bg-muted/20"
                  : "cursor-pointer " +
                    (dragging
                      ? "border-primary bg-accent"
                      : "border-border/80 bg-muted/20 hover:border-primary/50"),
              )}
            >
              {uploading ? (
                <>
                  <Loader2 className="mb-3 size-8 animate-spin text-primary" />
                  <div className="num text-sm font-medium">{percent}%</div>
                  <div className="mt-1 text-[12px] text-muted-foreground">{note}</div>
                </>
              ) : (
                <>
                  <UploadCloud className="mb-3 size-8 text-muted-foreground" />
                  <div className="text-sm font-medium">拖拽 zip 到这里，或点击选择文件</div>
                  <div className="mt-1 text-[12px] text-muted-foreground">
                    浏览器直传对象存储 · 支持断点续传 · 单个压缩包上限 {formatBytes(maxBytes)}
                  </div>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                  e.target.value = "";
                }}
              />
            </div>

            {uploading && (
              <div className="space-y-2">
                <Progress value={percent} className="h-1.5" />
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={pause}>
                    暂停
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void cancel()}>
                    <Ban className="size-3.5" />
                    取消并丢弃
                  </Button>
                  <span className="text-[12px] text-muted-foreground">
                    暂停后重新选择同一个文件即可续传
                  </span>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
              <Button variant="outline" size="sm" onClick={seedDemo} disabled={seeding}>
                {seeding ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                导入示例数据（车机语音助手 · 90 会话）
              </Button>
              <Button asChild variant="ghost" size="sm">
                <a href="/api/demo/zip" download>
                  <Download className="size-3.5" />
                  下载示例 zip
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <Info className="size-3.5 text-muted-foreground" />
              数据格式约定
            </CardTitle>
            <CardDescription className="text-[12.5px]">JSONL 每行一条消息，音频可选。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-[12.5px] leading-relaxed">
            <div>
              <div className="mb-1.5 font-medium text-foreground">压缩包结构</div>
              <pre className="overflow-x-auto rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
{`my-data.zip
├─ dialogues.jsonl        # 对话数据（1 个，可任意层级）
├─ audio/                 # 音频目录（可选，层级不限）
│  ├─ sess_001_t000.wav
│  └─ sess_001_t004.wav
└─ README.txt              # 说明（可选）`}
              </pre>
            </div>

            <div>
              <div className="mb-1.5 font-medium text-foreground">JSONL 单行结构</div>
              <pre className="overflow-x-auto rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
{`{
  "sessionId": "sess_1001_01",
  "userId": "u_1001",
  "timestamp": "2026-09-01 08:12:04",
  "message": { "role": "user", "content": "导航去最近的充电站" },
  "audio": "sess_1001_01_t000.wav",
  "extra": {
    "skill": "navigation",
    "emotion": "neutral",
    "interrupted": false,
    "asr_confidence": 0.93,
    "tts_latency_ms": 720
  }
}`}
              </pre>
            </div>

            <ul className="space-y-1.5 text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
                <span>
                  兼容字段别名：<code className="font-mono text-[11.5px]">session_id / sid</code>、
                  <code className="font-mono text-[11.5px]"> user_id / uid</code>、
                  <code className="font-mono text-[11.5px]"> created_at / ts / time</code>、
                  <code className="font-mono text-[11.5px]"> audio_file / audio_path</code>，以及顶层直接写
                  <code className="font-mono text-[11.5px]"> role + content</code>。
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
                <span>
                  <code className="font-mono text-[11.5px]">message.content</code> 支持 OpenAI 范式的字符串或
                  content parts 数组。
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
                <span>
                  音频为<strong className="font-medium text-foreground">可选</strong>：缺失时仅按文本分析，不会报错。
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
                <span>
                  也支持「一行一个 session、内含 messages 数组」的导出格式，平台会自动展开。
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">导入批次</CardTitle>
          <CardDescription className="text-[12.5px]">
            每次上传生成一个批次，由后台 Worker 排队解析；状态每 2.5 秒自动刷新。
            失败的批次会保留压缩包，可直接重试，不用重新上传。删除批次会连带清理其写入的数据与压缩包。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {list.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/80 py-10 text-center text-[13px] text-muted-foreground">
              暂无导入记录
            </div>
          ) : (
            list.map((b) => {
              const active = ["pending", "processing"].includes(b.status);
              const stage = String((b.progress_detail as JsonObject | null)?.step ?? "");
              return (
                <div
                  key={b.id}
                  className="rounded-xl border border-border/70 bg-card p-3.5 transition-colors hover:border-border"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    {active ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                    ) : b.status === "completed" ? (
                      <CheckCircle2 className="size-4 shrink-0 text-[var(--success)]" />
                    ) : (
                      <XCircle className="size-4 shrink-0 text-destructive" />
                    )}
                    <FileArchive className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{b.file_name ?? "—"}</span>
                    <StatusBadge status={b.status} />
                    <span className="num text-[11.5px] text-muted-foreground">{formatDate(b.created_at)}</span>
                    {b.status === "failed" && b.source_object && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        disabled={retrying === b.id}
                        onClick={() => void retry(b.id)}
                      >
                        {retrying === b.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                        重试
                      </Button>
                    )}
                  </div>

                  {active && (
                    <div className="mt-2.5 flex items-center gap-2 pl-[26px] text-[12px] text-muted-foreground">
                      <Progress value={b.status === "pending" ? 8 : 60} className="h-1 flex-1" />
                      <span>{STAGE_NOTE[stage] ?? stage ?? "处理中"}</span>
                    </div>
                  )}

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-[26px] text-[12px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      会话 <b className="num font-semibold text-foreground">{compactNumber(b.created_sessions ?? 0)}</b>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      消息 <b className="num font-semibold text-foreground">{compactNumber(b.created_messages ?? 0)}</b>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Music4 className="size-3" />
                      音频 <b className="num font-semibold text-foreground">{compactNumber(b.uploaded_audios ?? 0)}</b>
                      {b.failed_audios ? (
                        <span className="text-destructive">（失败 {b.failed_audios}）</span>
                      ) : null}
                    </span>
                    {b.skipped ? <span className="text-[var(--warning)]">跳过 {b.skipped} 行</span> : null}
                    {b.finished_at ? <span className="ml-auto">{relativeTime(b.finished_at)}完成</span> : null}
                  </div>

                  {b.error && (
                    <div className="mt-2 rounded-lg bg-destructive/8 px-3 py-2 pl-[26px] text-[12px] leading-relaxed text-destructive">
                      {String(b.error)}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
