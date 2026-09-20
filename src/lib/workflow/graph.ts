import { NODE_DEFS, type NodeKind, resolveConfig, type WorkflowConfig } from "./definition";

export interface WfNodeData extends Record<string, unknown> {
  kind: NodeKind;
  label: string;
  stage: string;
  params: Record<string, unknown>;
  note?: string;
  disabled?: boolean;
}

export interface WfNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: WfNodeData;
}

export interface WfEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  type?: string;
  animated?: boolean;
  style?: Record<string, string | number>;
  markerEnd?: unknown;
}

export interface WfGraph {
  nodes: WfNode[];
  edges: WfEdge[];
}

const STEP = 268;
const TOP_Y = 40;
const BOTTOM_Y = 268;

function def(kind: NodeKind): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of NODE_DEFS[kind].params) out[p.key] = p.default;
  return out;
}

/**
 * Default pipeline: 数据源 → 范围 → 规划 → 模板 → 预览 → 会话分析 →
 * 用户汇总 → 全局汇总 → 报告 → 结果。Both rows run left-to-right: every node
 * takes its edge on the left and hands it off on the right, so a row laid out
 * the other way draws each step pointing backwards. Only the wrap from the end
 * of row 1 to the start of row 2 travels right-to-left, as a line rather than
 * as the whole row.
 */
export function defaultGraph(): WfGraph {
  const top: { id: string; kind: NodeKind; label: string; stage: string }[] = [
    { id: "source", kind: "source", label: "数据源", stage: "输入" },
    { id: "scope", kind: "scope", label: "分析范围", stage: "输入" },
    { id: "plan", kind: "plan", label: "智能规划", stage: "规划" },
    { id: "template", kind: "template", label: "执行模板", stage: "规划" },
    { id: "preview", kind: "preview", label: "预览报告", stage: "规划" },
  ];
  const bottom: { id: string; kind: NodeKind; label: string; stage: string }[] = [
    { id: "session", kind: "session_analysis", label: "会话层分析", stage: "执行" },
    { id: "user", kind: "user_aggregation", label: "用户层汇总", stage: "执行" },
    { id: "global", kind: "global_aggregation", label: "全局层汇总", stage: "执行" },
    { id: "report", kind: "report", label: "报告生成", stage: "输出" },
    { id: "output", kind: "output", label: "任务结果", stage: "输出" },
  ];

  const nodes: WfNode[] = top.map((n, i) => ({
    id: n.id,
    type: "wf",
    position: { x: i * STEP, y: TOP_Y },
    data: { kind: n.kind, label: n.label, stage: n.stage, params: def(n.kind) },
  }));

  nodes.push(
    ...bottom.map((n, i) => ({
      id: n.id,
      type: "wf",
      position: { x: i * STEP, y: BOTTOM_Y },
      data: { kind: n.kind, label: n.label, stage: n.stage, params: def(n.kind) },
    })),
  );

  const chain = [...top.map((n) => n.id), ...bottom.map((n) => n.id)];
  const edges: WfEdge[] = chain.slice(0, -1).map((id, i) => ({
    id: `e-${id}-${chain[i + 1]}`,
    source: id,
    target: chain[i + 1],
    type: "smoothstep",
    animated: false,
  }));

  edges.push({
    id: "e-feedback",
    source: "preview",
    target: "plan",
    type: "smoothstep",
    label: "修改建议",
    style: { strokeDasharray: "6 4" },
  });

  return { nodes, edges };
}

/** Turn a stored graph into the flat engine config. */
export function configFromGraph(graph: WfGraph | null | undefined): WorkflowConfig {
  if (!graph?.nodes?.length) return resolveConfig({});
  const map: Record<string, Record<string, unknown>> = {};
  for (const node of graph.nodes as WfNode[]) {
    if (node.data?.disabled) continue;
    const kind = node.data?.kind;
    if (!kind) continue;
    const base = def(kind);
    map[node.id] = { ...base, ...(node.data.params ?? {}) };
  }
  return resolveConfig(map);
}

export function nodeById(graph: WfGraph, kind: NodeKind): WfNode | undefined {
  return graph.nodes.find((n) => n.data?.kind === kind);
}

export function paramsFor(graph: WfGraph, kind: NodeKind): Record<string, unknown> {
  const node = nodeById(graph, kind);
  return { ...def(kind), ...(node?.data?.params ?? {}) };
}

/** Topological order of the *enabled* nodes following real edges. */
export function executionOrder(graph: WfGraph): string[] {
  const nodes = graph.nodes.filter((n) => !n.data?.disabled);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.id !== "e-feedback");
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  // Keep any node unreachable in the reduced graph at the end, in canvas order.
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);
  return order;
}

export function validateGraph(graph: WfGraph): string[] {
  const problems: string[] = [];
  const enabled = graph.nodes.filter((n) => !n.data?.disabled);
  const kinds = new Set(enabled.map((n) => n.data?.kind));
  const required: NodeKind[] = ["scope", "plan", "template", "session_analysis", "user_aggregation", "global_aggregation", "report"];
  for (const need of required) {
    if (!kinds.has(need)) problems.push(`缺少必要节点：${NODE_DEFS[need].label}`);
  }
  const ids = new Set(enabled.map((n) => n.id));
  for (const e of graph.edges) {
    if (!ids.has(e.source)) problems.push(`连线 ${e.id} 的起点已被禁用或删除`);
    if (!ids.has(e.target)) problems.push(`连线 ${e.id} 的终点已被禁用或删除`);
  }
  return problems;
}

/** Where row 2 sat back when it was laid out right-to-left. */
const LEGACY_BOTTOM_X: Record<string, number> = {
  session: 4 * STEP,
  user: 3 * STEP,
  global: 2 * STEP,
  report: 1 * STEP,
  output: 0,
};

/**
 * Graphs stored before row 2 was turned around still carry the old positions,
 * and nothing rewrites them — so lay that row out again on read. Only a row
 * still sitting exactly where the old default put it qualifies: once anyone has
 * dragged a node, the arrangement is theirs and stays untouched.
 */
function straightenLegacyRow(nodes: WfNode[]): WfNode[] {
  const legacy = nodes.filter(
    (n) => n.position?.y === BOTTOM_Y && LEGACY_BOTTOM_X[n.id] === n.position?.x,
  );
  if (legacy.length !== Object.keys(LEGACY_BOTTOM_X).length) return nodes;

  const order = Object.keys(LEGACY_BOTTOM_X);
  return nodes.map((n) =>
    n.id in LEGACY_BOTTOM_X
      ? { ...n, position: { ...n.position, x: order.indexOf(n.id) * STEP } }
      : n,
  );
}

export function normalizeGraph(raw: unknown): WfGraph {
  if (!raw || typeof raw !== "object") return defaultGraph();
  const g = raw as Partial<WfGraph>;
  if (!Array.isArray(g.nodes) || g.nodes.length === 0) return defaultGraph();
  return {
    nodes: straightenLegacyRow(g.nodes as WfNode[]),
    edges: Array.isArray(g.edges) ? (g.edges as WfEdge[]) : [],
  };
}
