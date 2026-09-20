/**
 * Catalogue of workflow node types. The canvas renders these, and the engine
 * consumes the *resolved* config produced from the graph — the two stay in sync
 * through `defaultParams` / `resolveConfig`.
 */

export type NodeKind =
  | "source"
  | "scope"
  | "plan"
  | "template"
  | "preview"
  | "session_analysis"
  | "user_aggregation"
  | "global_aggregation"
  | "report"
  | "output";

export type ParamType = "number" | "text" | "boolean" | "select" | "textarea";

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  help?: string;
  default: string | number | boolean;
}

export interface NodeDef {
  kind: NodeKind;
  label: string;
  group: string;
  description: string;
  icon: string;
  accent: string;
  params: ParamDef[];
}

export const NODE_DEFS: Record<NodeKind, NodeDef> = {
  source: {
    kind: "source",
    label: "数据源",
    group: "输入",
    description: "绑定的数据源、业务描述与 extra 字段 schema",
    icon: "database",
    accent: "var(--chart-2)",
    params: [],
  },
  scope: {
    kind: "scope",
    label: "分析范围",
    group: "输入",
    description: "本次任务覆盖的数据范围与规模上限",
    icon: "filter",
    accent: "var(--chart-2)",
    params: [
      {
        key: "mode",
        label: "范围模式",
        type: "select",
        options: ["incremental", "range"],
        default: "incremental",
        help: "incremental = 仅未分析过的 session；range = 按对话时间范围",
      },
      {
        key: "maxSessions",
        label: "session 上限",
        type: "number",
        min: 1,
        max: 20000,
        default: 400,
        help: "单次任务最多处理的 session 数量，0 表示不限制",
      },
      {
        key: "samplePerLayer",
        label: "每层抽样数",
        type: "number",
        min: 1,
        max: 50,
        default: 6,
      },
    ],
  },
  plan: {
    kind: "plan",
    label: "智能规划",
    group: "规划",
    description: "三层抽样后由模型动态生成分析提示词与报告提示词",
    icon: "sparkles",
    accent: "var(--chart-1)",
    params: [
      {
        key: "sessionSamples",
        label: "会话层样本",
        type: "number",
        min: 1,
        max: 30,
        default: 5,
      },
      {
        key: "userSamples",
        label: "用户层样本",
        type: "number",
        min: 1,
        max: 30,
        default: 4,
      },
      {
        key: "includeAudio",
        label: "规划时听音频",
        type: "boolean",
        default: true,
        help: "开启后会把抽样会话的音频一并交给多模态模型，用于校准提示词",
      },
      {
        key: "focus",
        label: "规划侧重（可选）",
        type: "textarea",
        default: "",
        help: "临时补充指令，例如「重点看打断率和负面情绪」",
      },
    ],
  },
  template: {
    kind: "template",
    label: "执行模板",
    group: "规划",
    description: "规划产出的提示词模板，版本化保存并可回滚",
    icon: "file-text",
    accent: "var(--chart-1)",
    params: [
      {
        key: "versionMode",
        label: "版本选择",
        type: "select",
        options: ["confirmed", "latest"],
        default: "confirmed",
        help: "confirmed = 用户已确认的最新版本；latest = 任意状态的最新版本",
      },
    ],
  },
  preview: {
    kind: "preview",
    label: "预览报告",
    group: "规划",
    description: "用选中的模板版本跑抽样数据生成预览报告，支持反馈迭代",
    icon: "eye",
    accent: "var(--chart-1)",
    params: [
      {
        key: "sessions",
        label: "预览 session 数",
        type: "number",
        min: 1,
        max: 60,
        default: 12,
      },
      {
        key: "useAudio",
        label: "预览时听音频",
        type: "boolean",
        default: false,
      },
    ],
  },
  session_analysis: {
    kind: "session_analysis",
    label: "会话层分析",
    group: "执行",
    description: "逐 session 结构化分析，产出摘要 / 指标 / 标签 / 证据",
    icon: "messages-square",
    accent: "var(--chart-3)",
    params: [
      {
        key: "concurrency",
        label: "并发数",
        type: "number",
        min: 1,
        max: 16,
        default: 4,
      },
      {
        key: "useAudio",
        label: "送入音频",
        type: "boolean",
        default: false,
        help: "开启后每个 session 会附带音频（更慢、更准，用于识别语气与打断）",
      },
      {
        key: "maxAudiosPerSession",
        label: "每会话音频上限",
        type: "number",
        min: 0,
        max: 40,
        default: 8,
      },
      {
        key: "maxDigestChars",
        label: "转录截断字数",
        type: "number",
        min: 500,
        max: 100000,
        default: 24000,
      },
      {
        key: "retries",
        label: "失败重试",
        type: "number",
        min: 0,
        max: 5,
        default: 2,
      },
    ],
  },
  user_aggregation: {
    kind: "user_aggregation",
    label: "用户层汇总",
    group: "执行",
    description: "把 session 结果聚合为 user 画像与行为模式",
    icon: "user-round",
    accent: "var(--chart-4)",
    params: [
      {
        key: "concurrency",
        label: "并发数",
        type: "number",
        min: 1,
        max: 16,
        default: 4,
      },
      {
        key: "maxSessionsPerUser",
        label: "每用户最多输入 session",
        type: "number",
        min: 1,
        max: 500,
        default: 80,
        help: "超过则按时间/风险抽样后分批汇总",
      },
    ],
  },
  global_aggregation: {
    kind: "global_aggregation",
    label: "全局层汇总",
    group: "执行",
    description: "从用户层结论汇总为全局洞察、分布与风险",
    icon: "globe",
    accent: "var(--chart-5)",
    params: [
      {
        key: "maxUsersInPrompt",
        label: "单次提示最多用户数",
        type: "number",
        min: 5,
        max: 2000,
        default: 300,
        help: "超过则分批归并再总结",
      },
      {
        key: "includeSessionStats",
        label: "附带明细分布统计",
        type: "boolean",
        default: true,
      },
    ],
  },
  report: {
    kind: "report",
    label: "报告生成",
    group: "输出",
    description: "把三层结果渲染为可下探的单页 HTML 报告",
    icon: "bar-chart-3",
    accent: "var(--chart-1)",
    params: [
      {
        key: "sections",
        label: "章节数",
        type: "number",
        min: 3,
        max: 12,
        default: 6,
      },
      {
        key: "language",
        label: "报告语言",
        type: "select",
        options: ["zh", "en"],
        default: "zh",
      },
      {
        key: "includeEvidence",
        label: "包含原文证据",
        type: "boolean",
        default: true,
      },
      {
        key: "topUsers",
        label: "下探用户数",
        type: "number",
        min: 0,
        max: 200,
        default: 40,
      },
      {
        key: "tone",
        label: "报告基调",
        type: "textarea",
        default: "客观、数据驱动、结论先行，指出问题也给出可执行建议",
      },
    ],
  },
  output: {
    kind: "output",
    label: "任务结果",
    group: "输出",
    description: "三层结果与报告归档在任务对象上，可反复查看与下探",
    icon: "package-check",
    accent: "var(--chart-3)",
    params: [],
  },
};

export const NODE_KINDS = Object.keys(NODE_DEFS) as NodeKind[];

export interface WorkflowConfig {
  scope: { mode: "incremental" | "range"; maxSessions: number; samplePerLayer: number };
  plan: { sessionSamples: number; userSamples: number; includeAudio: boolean; focus: string };
  preview: { sessions: number; useAudio: boolean };
  session: {
    concurrency: number;
    useAudio: boolean;
    maxAudiosPerSession: number;
    maxDigestChars: number;
    retries: number;
  };
  user: { concurrency: number; maxSessionsPerUser: number };
  global: { maxUsersInPrompt: number; includeSessionStats: boolean };
  report: {
    sections: number;
    language: "zh" | "en";
    includeEvidence: boolean;
    topUsers: number;
    tone: string;
  };
  templateVersionMode: "confirmed" | "latest";
}

export function defaultConfig(): WorkflowConfig {
  return configFromParams({});
}

/** Merge every node's params into a flat, strongly typed engine config. */
export function resolveConfig(nodes: Record<string, Record<string, unknown>>): WorkflowConfig {
  return configFromParams(nodes);
}

function configFromParams(nodes: Record<string, Record<string, unknown>>): WorkflowConfig {
  const flat: Record<string, unknown> = {};
  for (const [, params] of Object.entries(nodes)) Object.assign(flat, params);

  const num = (kind: NodeKind, key: string): number => {
    const def = NODE_DEFS[kind].params.find((p) => p.key === key);
    const v = flat[`${kind}.${key}`] ?? flat[key] ?? def?.default;
    const n = Number(v);
    return Number.isFinite(n) ? n : Number(def?.default ?? 0);
  };
  const bool = (kind: NodeKind, key: string): boolean => {
    const def = NODE_DEFS[kind].params.find((p) => p.key === key);
    const v = flat[`${kind}.${key}`] ?? flat[key] ?? def?.default;
    return typeof v === "string" ? v === "true" : Boolean(v);
  };
  const str = (kind: NodeKind, key: string): string => {
    const def = NODE_DEFS[kind].params.find((p) => p.key === key);
    const v = flat[`${kind}.${key}`] ?? flat[key] ?? def?.default;
    return String(v ?? def?.default ?? "");
  };

  return {
    scope: {
      mode: str("scope", "mode") as "incremental" | "range",
      maxSessions: num("scope", "maxSessions"),
      samplePerLayer: num("scope", "samplePerLayer"),
    },
    plan: {
      sessionSamples: num("plan", "sessionSamples"),
      userSamples: num("plan", "userSamples"),
      includeAudio: bool("plan", "includeAudio"),
      focus: str("plan", "focus"),
    },
    preview: { sessions: num("preview", "sessions"), useAudio: bool("preview", "useAudio") },
    session: {
      concurrency: num("session_analysis", "concurrency"),
      useAudio: bool("session_analysis", "useAudio"),
      maxAudiosPerSession: num("session_analysis", "maxAudiosPerSession"),
      maxDigestChars: num("session_analysis", "maxDigestChars"),
      retries: num("session_analysis", "retries"),
    },
    user: {
      concurrency: num("user_aggregation", "concurrency"),
      maxSessionsPerUser: num("user_aggregation", "maxSessionsPerUser"),
    },
    global: {
      maxUsersInPrompt: num("global_aggregation", "maxUsersInPrompt"),
      includeSessionStats: bool("global_aggregation", "includeSessionStats"),
    },
    report: {
      sections: num("report", "sections"),
      language: str("report", "language") as "zh" | "en",
      includeEvidence: bool("report", "includeEvidence"),
      topUsers: num("report", "topUsers"),
      tone: str("report", "tone"),
    },
    templateVersionMode: str("template", "versionMode") as "confirmed" | "latest",
  };
}

/** Flatten a node's params into `{ "kind.key": value }` for `resolveConfig`. */
export function flattenParams(kind: NodeKind, params: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[`${kind}.${k}`] = v;
  return out;
}
