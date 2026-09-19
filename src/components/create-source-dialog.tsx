"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { createDataSource } from "@/lib/actions/sources";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function CreateSourceDialog({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("请填写数据源名称");
      return;
    }
    startTransition(async () => {
      try {
        const { id } = await createDataSource({ name, description });
        toast.success("数据源已创建，接下来可以导入数据");
        setOpen(false);
        setName("");
        setDescription("");
        router.push(`/sources/${id}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "创建失败");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm">
            <Plus className="size-4" />
            新建数据源
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>新建数据源</DialogTitle>
          <DialogDescription>
            数据源对应一段语音对话业务。业务描述会作为提示词进入 AI 规划与报告生成，
            写得越具体，分析口径越准。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ds-name">名称</Label>
            <Input
              id="ds-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：智能客服语音坐席 / 车机语音助手"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ds-desc">业务描述</Label>
            <Textarea
              id="ds-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={7}
              placeholder={
                "描述这批数据是什么业务、对话双方是谁、用户来完成什么任务。\n\n例如：\n这是新能源汽车车机语音助手的真实用户对话。用户通过语音控制导航、音乐、空调、车窗，也会闲聊。系统为 ASR-LLM-TTS 三段式，常见问题是 ASR 把车内噪音误识别、TTS 播报被用户打断、多轮指代消解失败。我们希望了解：用户最常用哪些技能、哪些指令容易失败、打断率高不高、整体体验如何。"
              }
            />
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              AI 会依据这段描述决定分析维度、指标口径与报告叙事，后续可随时修改（修改后需重新规划模板）。
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              创建数据源
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
