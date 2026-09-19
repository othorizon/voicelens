"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { updateDataSource } from "@/lib/actions/sources";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function DescriptionEditor({
  sourceId,
  initialValue,
}: {
  sourceId: string;
  initialValue: string;
}) {
  const [editing, setEditing] = useState(!initialValue);
  const [value, setValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <div className="group relative rounded-lg border border-border/70 bg-muted/25 p-3.5">
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">{initialValue}</p>
        <Button
          size="sm"
          variant="ghost"
          className="absolute top-2 right-2 h-7 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3" />
          编辑
        </Button>
      </div>
    );
  }

  function save() {
    startTransition(async () => {
      try {
        await updateDataSource(sourceId, { description: value });
        toast.success("业务描述已保存");
        setEditing(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存失败");
      }
    });
  }

  return (
    <div className="space-y-2.5">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={9}
        className="text-[13px] leading-relaxed"
        placeholder="描述这段对话数据的业务背景：对话双方是谁、用户想完成什么任务、系统链路（ASR-LLM-TTS）有哪些已知问题、你最关心什么结论。"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          保存
        </Button>
        {initialValue && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setValue(initialValue);
              setEditing(false);
            }}
          >
            <X className="size-3.5" />
            取消
          </Button>
        )}
        <span className="num ml-auto text-[11.5px] text-muted-foreground">{value.length} 字</span>
      </div>
    </div>
  );
}
