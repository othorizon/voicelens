"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AudioLines,
  CheckCircle2,
  CircleAlert,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Trash2,
} from "lucide-react";
import {
  createModel,
  deleteModel,
  saveAnalysisDefaults,
  testModel,
  updateModel,
  type ModelInput,
} from "@/lib/actions/models";
import {
  ANALYSIS_MODES,
  DEFAULT_STAGE_PARAMS,
  MODEL_KIND_LABEL,
  MODE_HINT,
  MODE_LABEL,
  describeModeCost,
  type AnalysisMode,
  type AnalysisSelection,
  type ModelKind,
  type StagePatchMap,
} from "@/lib/models/mode";
import { StageParamsEditor } from "@/components/stage-params";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModePicker, ModelPicker, type ModelOption } from "@/components/model-pickers";

/**
 * The owner's model registry, on the settings page.
 *
 * Everyone signed in can see which models exist — a member needs the names to
 * pick between them on their own data source — but only the owner gets the
 * editing affordances, matching `requireOwnerSession` on the server. The API
 * key never arrives here in any form: `keyMasked` is computed server-side and
 * `keyReadable` is how a stale MODEL_SECRET surfaces.
 */

export interface ModelCard {
  id: string;
  name: string;
  kind: ModelKind;
  baseUrl: string;
  model: string;
  enableThinking: boolean;
  enabled: boolean;
  note: string;
  keyPresent: boolean;
  keyReadable: boolean;
  keyMasked: string;
}

const KIND_ICON = { multimodal: ImageIcon, omni: AudioLines } as const;

export function ModelSettings({
  models,
  defaults,
  stagePatch,
  canManage,
}: {
  models: ModelCard[];
  defaults: AnalysisSelection;
  stagePatch: StagePatchMap;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState<ModelCard | "new" | null>(null);

  return (
    <div className="space-y-5">
      <DefaultsPanel
        models={models}
        defaults={defaults}
        stagePatch={stagePatch}
        canManage={canManage}
      />

      <Separator />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">模型列表</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            每个模型是一个 OpenAI 兼容的 Chat Completions 端点。omni 模型是唯一可以接收音频输入的一类。
          </div>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            新增模型
          </Button>
        )}
      </div>

      {models.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-[12.5px] text-muted-foreground">
          还没有配置任何模型。
          {canManage
            ? "点「新增模型」填入接口地址、模型 id 与 API Key 即可，规划与分析任务在此之前无法运行。"
            : "请联系所有者在此配置，规划与分析任务在此之前无法运行。"}
        </div>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {models.map((m) => (
            <ModelRow key={m.id} model={m} canManage={canManage} onEdit={() => setEditing(m)} />
          ))}
        </div>
      )}

      {canManage && (
        <ModelDialog
          key={editing === "new" ? "new" : (editing?.id ?? "closed")}
          target={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------- one model */

function ModelRow({
  model,
  canManage,
  onEdit,
}: {
  model: ModelCard;
  canManage: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const Icon = KIND_ICON[model.kind];
  const host = model.baseUrl.replace(/^https?:\/\//, "").split("/")[0];

  function test() {
    startTransition(async () => {
      const res = await testModel(model.id);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    });
  }

  function remove() {
    startTransition(async () => {
      try {
        const { clearedSources } = await deleteModel(model.id);
        toast.success(
          clearedSources > 0
            ? `已删除「${model.name}」，并清除了 ${clearedSources} 个数据源上对它的选择`
            : `已删除「${model.name}」`,
        );
        setConfirming(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "删除失败");
      }
    });
  }

  return (
    <div className="rounded-lg border border-border/70 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border/70 text-muted-foreground">
          <Icon className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{model.name}</span>
            <Badge variant="outline" className="shrink-0 py-0 text-[10px]">
              {MODEL_KIND_LABEL[model.kind]}
            </Badge>
            {!model.enabled && (
              <Badge variant="secondary" className="shrink-0 py-0 text-[10px]">
                已停用
              </Badge>
            )}
            {model.enableThinking && (
              <Badge variant="outline" className="shrink-0 py-0 text-[10px]">
                深度思考
              </Badge>
            )}
          </div>
          <div className="num mt-0.5 truncate text-[11.5px] text-muted-foreground" title={model.baseUrl}>
            {model.model} · {host}
          </div>
          <div className="mt-1 flex items-center gap-1 text-[11px]">
            {model.keyReadable ? (
              <>
                <CheckCircle2 className="size-3 text-[var(--success)]" />
                <span className="num text-muted-foreground">{model.keyMasked || "未填写 API Key"}</span>
              </>
            ) : (
              <>
                <CircleAlert className="size-3 text-destructive" />
                <span className="text-destructive">API Key 无法解密，请重新填写</span>
              </>
            )}
          </div>
          {model.note && (
            <div className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{model.note}</div>
          )}
        </div>

        {canManage && (
          <div className="flex shrink-0 items-center gap-0.5">
            {pending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title="测试连通性"
              disabled={pending}
              onClick={test}
            >
              <Plug className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7" title="编辑" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-destructive hover:text-destructive"
              title="删除"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除模型「{model.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              已经选中它的数据源会退回「未配置」，相关的规划与分析任务在改选之前会失败。
              已完成的任务与报告不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                remove();
              }}
              disabled={pending}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* --------------------------------------------------------- create/edit */

const BLANK: ModelInput = {
  name: "",
  kind: "omni",
  baseUrl: "",
  model: "",
  apiKey: "",
  enableThinking: false,
  enabled: true,
  note: "",
};

function ModelDialog({ target, onClose }: { target: ModelCard | "new" | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const existing = target && target !== "new" ? target : null;
  const [form, setForm] = useState<ModelInput>(
    existing
      ? {
          name: existing.name,
          kind: existing.kind,
          baseUrl: existing.baseUrl,
          model: existing.model,
          // Empty means "keep the stored key"; the placeholder says so.
          apiKey: "",
          enableThinking: existing.enableThinking,
          enabled: existing.enabled,
          note: existing.note,
        }
      : BLANK,
  );

  const set = <K extends keyof ModelInput>(key: K, value: ModelInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        if (existing) {
          await updateModel(existing.id, form);
          toast.success("模型已保存");
        } else {
          await createModel(form);
          toast.success("模型已新增");
        }
        onClose();
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "保存失败");
      }
    });
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{existing ? `编辑「${existing.name}」` : "新增模型"}</DialogTitle>
          <DialogDescription>
            只支持 OpenAI 兼容的 Chat Completions 接口。接口地址填到 `/v1` 为止，模型 id 填服务端认的那个名字。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3.5">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="m-name">名称</Label>
              <Input
                id="m-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="例如：Qwen Omni Flash"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-kind">类型</Label>
              <Select value={form.kind} onValueChange={(v) => set("kind", v as ModelKind)}>
                <SelectTrigger id="m-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["omni", "multimodal"] as ModelKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {MODEL_KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="m-base">接口地址</Label>
            <Input
              id="m-base"
              value={form.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
              required
            />
          </div>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="m-model">模型 id</Label>
              <Input
                id="m-model"
                value={form.model}
                onChange={(e) => set("model", e.target.value)}
                placeholder="qwen3.8-omni-flash"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-key">API Key</Label>
              <Input
                id="m-key"
                type="password"
                autoComplete="off"
                value={form.apiKey ?? ""}
                onChange={(e) => set("apiKey", e.target.value)}
                placeholder={existing ? "留空表示不修改" : "sk-…"}
                required={!existing}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="m-note">备注（可选）</Label>
            <Textarea
              id="m-note"
              value={form.note}
              onChange={(e) => set("note", e.target.value)}
              placeholder="例如：按量计费，限流 20 QPS"
              rows={2}
            />
          </div>

          <div className="space-y-2 rounded-lg border border-border/70 p-3">
            <label className="flex items-start justify-between gap-3 text-[12.5px]">
              <span>
                <span className="font-medium">启用</span>
                <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                  停用后不可被选用，已经选中它的数据源会在运行时报错。
                </span>
              </span>
              <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
            </label>
            <Separator />
            <label className="flex items-start justify-between gap-3 text-[12.5px]">
              <span>
                <span className="font-medium">默认开启深度思考</span>
                <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                  仅对支持 enable_thinking 的服务有效。更准但慢 3 倍，引擎在规划环节会单独开启。
                </span>
              </span>
              <Switch checked={form.enableThinking} onCheckedChange={(v) => set("enableThinking", v)} />
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------- the default */

function DefaultsPanel({
  models,
  defaults,
  stagePatch,
  canManage,
}: {
  models: ModelCard[];
  defaults: AnalysisSelection;
  stagePatch: StagePatchMap;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState({
    mode: defaults.mode,
    omniModelId: defaults.omniModelId,
    multimodalModelId: defaults.multimodalModelId,
    // Stages are edited as the stored patch, not as resolved values: a stage
    // left alone keeps following the built-in default as it changes.
    stages: stagePatch,
  });
  const options: ModelOption[] = models.map((m) => ({
    id: m.id,
    name: m.name,
    kind: m.kind,
    model: m.model,
    enabled: m.enabled,
  }));

  const dirty =
    draft.mode !== defaults.mode ||
    draft.omniModelId !== defaults.omniModelId ||
    draft.multimodalModelId !== defaults.multimodalModelId ||
    JSON.stringify(draft.stages) !== JSON.stringify(stagePatch);

  function save() {
    startTransition(async () => {
      try {
        await saveAnalysisDefaults(draft);
        toast.success("默认分析配置已保存");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存失败");
      }
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold">默认分析配置</div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">
          所有数据源默认继承这里的模式、模型与各阶段调用参数；单个数据源可以在它自己的「分析模型」页签里覆盖。
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <ModePicker
          label="分析模式"
          value={draft.mode}
          disabled={!canManage || pending}
          onChange={(mode) => setDraft((d) => ({ ...d, mode: mode as AnalysisMode }))}
          modes={ANALYSIS_MODES as readonly AnalysisMode[]}
        />
        <ModelPicker
          label={MODEL_KIND_LABEL.omni}
          kind="omni"
          value={draft.omniModelId}
          options={options}
          disabled={!canManage || pending}
          onChange={(id) => setDraft((d) => ({ ...d, omniModelId: id }))}
        />
        <ModelPicker
          label={MODEL_KIND_LABEL.multimodal}
          kind="multimodal"
          value={draft.multimodalModelId}
          options={options}
          disabled={!canManage || pending}
          onChange={(id) => setDraft((d) => ({ ...d, multimodalModelId: id }))}
        />
      </div>

      <div className="space-y-1.5">
        <div className="text-[12px] text-muted-foreground">各阶段调用参数</div>
        <StageParamsEditor
          value={draft.stages}
          base={DEFAULT_STAGE_PARAMS}
          baseLabel="内置默认"
          disabled={!canManage || pending}
          onChange={(stages) => setDraft((d) => ({ ...d, stages }))}
        />
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-[12px] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{MODE_LABEL[draft.mode]}</span>
        <span className="mx-1.5">·</span>
        {MODE_HINT[draft.mode]}
        <div className="mt-1 text-[11.5px]">开销：{describeModeCost(draft.mode)}</div>
      </div>

      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={!dirty || pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            保存默认配置
          </Button>
        </div>
      )}
    </div>
  );
}
