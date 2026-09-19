"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  BarChart3,
  Braces,
  Check,
  Database,
  Eye,
  FileText,
  Filter,
  Globe,
  Loader2,
  MessagesSquare,
  PackageCheck,
  RotateCcw,
  Save,
  Sparkles,
  UserRound,
} from "lucide-react";
import { NODE_DEFS, type NodeKind, type ParamDef } from "@/lib/workflow/definition";
import { configFromGraph, defaultGraph, validateGraph, type WfGraph, type WfNodeData } from "@/lib/workflow/graph";
import { saveWorkflow, resetWorkflow } from "@/lib/actions/workflow";
import { createAnalysisTask } from "@/lib/actions/tasks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  database: Database,
  filter: Filter,
  sparkles: Sparkles,
  "file-text": FileText,
  eye: Eye,
  "messages-square": MessagesSquare,
  "user-round": UserRound,
  globe: Globe,
  "bar-chart-3": BarChart3,
  "package-check": PackageCheck,
};

const STAGE_TONE: Record<string, string> = {
  输入: "text-[var(--chart-2)] bg-[color-mix(in_oklab,var(--chart-2)_13%,transparent)]",
  规划: "text-[var(--chart-1)] bg-[color-mix(in_oklab,var(--chart-1)_13%,transparent)]",
  执行: "text-[var(--chart-3)] bg-[color-mix(in_oklab,var(--chart-3)_13%,transparent)]",
  输出: "text-[var(--chart-5)] bg-[color-mix(in_oklab,var(--chart-5)_13%,transparent)]",
};

function WfNode({ data, selected }: NodeProps) {
  const d = data as unknown as WfNodeData;
  const def = NODE_DEFS[d.kind];
  const Icon = ICONS[def?.icon ?? "database"] ?? Database;
  const changed = d.params ? Object.keys(d.params).length : 0;

  return (
    <div
      className={cn(
        "vi-node w-[212px] rounded-xl border border-border/80 bg-card px-3 py-2.5 shadow-sm transition-shadow",
        selected && "shadow-md",
        d.disabled && "opacity-45",
      )}
    >
      <Handle type="target" position={Position.Left} className="!border-card !bg-muted-foreground" />
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg",
            STAGE_TONE[d.stage] ?? STAGE_TONE["输入"],
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] leading-tight font-semibold">{d.label}</div>
          <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground">
            {def?.description}
          </div>
        </div>
      </div>
      {changed > 0 && !d.disabled ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <Badge variant="outline" className="h-4 border-border/70 px-1.5 text-[9.5px] font-normal text-muted-foreground">
            {changed} 项参数
          </Badge>
          {d.kind === "session_analysis" && (d.params as Record<string, unknown>).useAudio ? (
            <Badge className="h-4 bg-primary/12 px-1.5 text-[9.5px] font-normal text-primary">音频</Badge>
          ) : null}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} className="!border-card !bg-muted-foreground" />
    </div>
  );
}

const nodeTypes = { wf: WfNode };

export function WorkflowCanvas({
  sourceId,
  workflowId,
  initialGraph,
  templateReady,
}: {
  sourceId: string;
  workflowId: string;
  initialGraph: WfGraph;
  templateReady: boolean;
}) {
  const router = useRouter();
  const [nodes, setNodes, onNodesChange] = useNodesState(initialGraph.nodes as unknown as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialGraph.edges as unknown as Edge[]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const { fitView } = useReactFlow();

  const selected = nodes.find((n) => n.id === selectedId);
  const selectedData = selected?.data as unknown as WfNodeData | undefined;
  const selectedDef = selectedData ? NODE_DEFS[selectedData.kind] : undefined;

  const graph = useMemo<WfGraph>(
    () => ({ nodes: nodes as unknown as WfGraph["nodes"], edges: edges as unknown as WfGraph["edges"] }),
    [nodes, edges],
  );
  const problems = useMemo(() => validateGraph(graph), [graph]);
  const config = useMemo(() => configFromGraph(graph), [graph]);

  const patchParams = useCallback(
    (nodeId: string, params: Record<string, unknown>) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: { ...(n.data as object), params: { ...((n.data as WfNodeData).params ?? {}), ...params } } as never,
              }
            : n,
        ),
      );
      setDirty(true);
    },
    [setNodes],
  );

  async function save(quiet = false) {
    if (problems.length) {
      toast.error(problems[0]);
      return false;
    }
    setSaving(true);
    try {
      await saveWorkflow(workflowId, graph);
      setDirty(false);
      if (!quiet) toast.success("工作流已保存");
      router.refresh();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    const g = await resetWorkflow(workflowId);
    setNodes(g.nodes as unknown as Node[]);
    setEdges(g.edges as unknown as Edge[]);
    setDirty(false);
    toast.success("已恢复默认流水线");
    router.refresh();
  }

  async function launch() {
    if (!(await save(true))) return;
    setLaunching(true);
    try {
      const { taskId } = await createAnalysisTask({
        dataSourceId: sourceId,
        workflowId,
        scopeType: config.scope.mode,
      });
      toast.success("分析任务已创建，Worker 正在执行");
      router.push(`/tasks/${taskId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "创建任务失败");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-152px)] min-h-[560px] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-background/70 px-4 py-2.5 backdrop-blur md:px-8">
        <div className="mr-auto flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 py-1 font-normal">
            <Braces className="size-3" />
            {graph.nodes.length} 节点 · {graph.edges.length} 连线
          </Badge>
          {dirty ? (
            <Badge className="gap-1.5 bg-[var(--warning)]/15 py-1 font-normal text-[var(--warning)]">未保存</Badge>
          ) : (
            <Badge variant="outline" className="gap-1.5 py-1 font-normal text-[var(--success)]">
              <Check className="size-3" />
              已保存
            </Badge>
          )}
        </div>
        <Button size="sm" variant="ghost" className="h-8" onClick={() => fitView({ padding: 0.2, duration: 300 })}>
          适应画布
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={reset}>
          <RotateCcw className="size-3.5" />
          重置
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          保存
        </Button>
        <Button size="sm" className="h-8" onClick={launch} disabled={launching || !templateReady}>
          {launching ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {templateReady ? "启动分析任务" : "需先完成规划"}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            onNodesDelete={() => setDirty(true)}
            fitView
            fitViewOptions={{ padding: 0.22 }}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: "smoothstep" }}
            minZoom={0.3}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap
              pannable
              zoomable
              className="!bg-card"
              maskColor="color-mix(in oklab, var(--background) 72%, transparent)"
              nodeColor={() => "var(--primary)"}
              nodeStrokeColor={() => "transparent"}
            />
          </ReactFlow>

          {problems.length > 0 && (
            <div className="absolute top-3 left-3 max-w-[300px] rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[12px] text-destructive">
              {problems.map((p) => (
                <div key={p}>· {p}</div>
              ))}
            </div>
          )}
        </div>

        <aside className="hidden w-[320px] shrink-0 overflow-y-auto border-l border-border/70 bg-card/50 scrollbar-thin lg:block">
          {selected && selectedData && selectedDef ? (
            <div className="p-4">
              <div className="mb-1 flex items-center gap-2">
                <Badge variant="outline" className="h-5 py-0 text-[10px] font-normal">
                  {selectedData.stage}
                </Badge>
                <span className="font-mono text-[10.5px] text-muted-foreground">{selected.id}</span>
              </div>
              <h3 className="text-[15px] font-semibold tracking-tight">{selectedData.label}</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{selectedDef.description}</p>

              <Separator className="my-4" />

              <div className="mb-3 flex items-center justify-between">
                <Label className="text-[12.5px]">启用该节点</Label>
                <Switch
                  checked={!selectedData.disabled}
                  onCheckedChange={(v) => {
                    setNodes((prev) =>
                      prev.map((n) =>
                        n.id === selected.id
                          ? { ...n, data: { ...(n.data as object), disabled: !v } as never }
                          : n,
                      ),
                    );
                    setDirty(true);
                  }}
                />
              </div>

              {!selectedDef.params.length ? (
                <p className="rounded-lg border border-dashed border-border/70 p-3 text-[12px] leading-relaxed text-muted-foreground">
                  该节点没有可调参数，它代表流水线中的一个阶段。
                </p>
              ) : (
                <div className="space-y-3.5">
                  {selectedDef.params.map((p) => (
                    <ParamControl
                      key={p.key}
                      param={p}
                      value={((selectedData.params ?? {})[p.key] ?? p.default) as string | number | boolean}
                      onChange={(v) => patchParams(selected.id, { [p.key]: v })}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="p-4">
              <h3 className="text-[13px] font-semibold">解析后的执行配置</h3>
              <p className="mt-1 mb-3 text-[11.5px] leading-relaxed text-muted-foreground">
                点击画布上的节点可编辑参数。下面是引擎实际读取到的配置。
              </p>
              <pre className="max-h-[52vh] overflow-auto rounded-lg border border-border/70 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground scrollbar-thin">
                {JSON.stringify(config, null, 2)}
              </pre>
              <div className="mt-4 rounded-lg border border-border/70 bg-muted/20 p-3 text-[11.5px] leading-relaxed text-muted-foreground">
                <div className="mb-1 font-medium text-foreground">流水线说明</div>
                规划阶段只在「分析工作台」触发；这里的节点参数决定任务启动后的抽样规模、并发数、
                是否送入音频、汇总批大小与报告风格。虚线连线表示预览报告不满意时可以回到规划重新生成模板。
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function ParamControl({
  param,
  value,
  onChange,
}: {
  param: ParamDef;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12px] font-medium">{param.label}</Label>
      {param.type === "select" ? (
        <Select value={String(value)} onValueChange={onChange}>
          <SelectTrigger className="h-8 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(param.options ?? []).map((o) => (
              <SelectItem key={o} value={o} className="text-[12px]">
                {SELECT_LABELS[o] ?? o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : param.type === "boolean" ? (
        <Switch checked={value === true} onCheckedChange={onChange} />
      ) : param.type === "textarea" ? (
        <Textarea
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="text-[12px]"
          placeholder={param.help}
        />
      ) : param.type === "number" ? (
        <Input
          type="number"
          value={Number(value)}
          min={param.min}
          max={param.max}
          step={param.step ?? 1}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-8 text-[12px]"
        />
      ) : (
        <Input
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 text-[12px]"
        />
      )}
      {param.help ? <p className="text-[11px] leading-relaxed text-muted-foreground">{param.help}</p> : null}
    </div>
  );
}

const SELECT_LABELS: Record<string, string> = {
  incremental: "增量未分析数据",
  range: "按时间范围",
  confirmed: "已确认的最新版本",
  latest: "任意状态的最新版本",
  zh: "中文",
  en: "English",
};
