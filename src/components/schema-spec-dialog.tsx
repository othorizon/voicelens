"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BookOpen, Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  PRIMARY_SCHEMA_FILE,
  SCHEMA_FILE_EXAMPLE,
  SCHEMA_FILE_SPEC,
} from "@/lib/schema-file";
import { copyText } from "@/lib/utils";

/**
 * 「schema 文件规范」: the spec, a copy button and a template download.
 *
 * The copy button is the feature, not the dialog — the spec is written to be
 * pasted into a chat with a model together with a few lines of real data, so
 * whoever produces the data can have the description file generated for them.
 */
export function SchemaSpecDialog({
  trigger,
  size = "sm",
  variant = "outline",
  label = "schema 文件规范",
}: {
  trigger?: React.ReactNode;
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "secondary";
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const ok = await copyText(SCHEMA_FILE_SPEC);
    if (!ok) {
      toast.error("复制失败，请手动选中下面的内容复制");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("规范已复制，可直接连同几行真实数据发给 AI，让它生成 schema 文件");
  }

  function download() {
    const blob = new Blob([`${SCHEMA_FILE_EXAMPLE}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = PRIMARY_SCHEMA_FILE;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant={variant} size={size}>
            <BookOpen className="size-3.5" />
            {label}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="grid max-h-[calc(100svh-4rem)] grid-rows-[auto_auto_minmax(0,1fr)] gap-4 overflow-hidden sm:max-w-[820px]">
        <DialogHeader>
          <DialogTitle>extra 字段 Schema 描述文件规范</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed">
            在导入的 zip 里放一个 <code className="font-mono">{PRIMARY_SCHEMA_FILE}</code>，
            导入时平台会直接按它配置好 extra 字段的 schema，不用再到页面上逐个字段填。
            把下面这份规范复制给写数据的同学或 AI，让他们照着生成即可。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void copy()}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "已复制" : "一键复制规范"}
          </Button>
          <Button variant="outline" size="sm" onClick={download}>
            <Download className="size-3.5" />
            下载示例文件
          </Button>
          <span className="text-[11.5px] text-muted-foreground">
            规范本身就是给 AI 的提示词，附上几行真实 JSONL 即可生成
          </span>
        </div>

        <div className="overflow-y-auto overscroll-contain rounded-lg border border-border/70 bg-muted/30 p-4">
          <pre className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {SCHEMA_FILE_SPEC}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}
