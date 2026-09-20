import type { GlobalAnalysis, JsonObject, SessionAnalysis, UserAnalysis } from "@/lib/types";

/**
 * What the model designing the report is allowed to know about the data.
 *
 * It never sees the rows themselves: at 80k sessions that is neither
 * affordable nor useful. It sees scale, shape and edges — how many rows, how
 * many distinct values a field takes, how long the longest summary runs, how
 * many are null. A page designed against these numbers survives the real
 * data; a page designed against five sample rows does not.
 */

export interface NumericProfile {
  key: string;
  label: string;
  unit?: string;
  count: number;
  nulls: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
}

export interface CategoricalProfile {
  key: string;
  label: string;
  /** Distinct values across the whole population, not just the top ones. */
  cardinality: number;
  top: { name: string; value: number }[];
  /** Share of rows covered by `top` — tells the model whether a pie chart lies. */
  topCoverage: number;
  /** Values per row: 1 for a plain field, >1 for list fields such as tags. */
  perRow: number;
}

export interface TextProfile {
  key: string;
  label: string;
  empty: number;
  maxChars: number;
  medianChars: number;
}

export interface DataProfile {
  scale: {
    sessions: number;
    users: number;
    messages: number;
    /** Rows the report page can actually page through. */
    usersAvailable: number;
    sessionsAvailable: number;
  };
  numerics: NumericProfile[];
  categoricals: CategoricalProfile[];
  texts: TextProfile[];
  /** Real rows, kept few and short — shape reference, not data. */
  samples: { session: JsonObject[]; user: JsonObject[] };
  /** Edge cases the page has to survive, stated in plain language. */
  warnings: string[];
}

/* ------------------------------------------------------------------ helpers */

function numeric(key: string, label: string, raw: (number | null | undefined)[], unit?: string): NumericProfile | null {
  const vals = raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    key,
    label,
    unit,
    count: vals.length,
    nulls: raw.length - vals.length,
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(vals.reduce((a, b) => a + b, 0) / vals.length),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
  };
}

function categorical(
  key: string,
  label: string,
  rows: string[][],
  topN = 12,
): CategoricalProfile | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const values of rows) {
    for (const v of values) {
      const name = (v ?? "").trim() || "（空）";
      counts.set(name, (counts.get(name) ?? 0) + 1);
      total++;
    }
  }
  if (!total) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN).map(([name, value]) => ({ name, value }));
  return {
    key,
    label,
    cardinality: counts.size,
    top,
    topCoverage: Math.round((top.reduce((n, t) => n + t.value, 0) / total) * 1000) / 10,
    perRow: Math.round((total / Math.max(1, rows.length)) * 100) / 100,
  };
}

function text(key: string, label: string, raw: (string | null | undefined)[]): TextProfile | null {
  if (!raw.length) return null;
  const lens = raw.map((s) => (s ?? "").length).sort((a, b) => a - b);
  return {
    key,
    label,
    empty: lens.filter((n) => n === 0).length,
    maxChars: lens[lens.length - 1],
    medianChars: lens[Math.floor(lens.length / 2)],
  };
}

/** Metric keys are decided by the planner, so they have to be discovered. */
function metricProfiles(
  rows: { metrics?: { key: string; label: string; value: number; unit?: string }[] }[],
  prefix: string,
): NumericProfile[] {
  const byKey = new Map<string, { label: string; unit?: string; values: number[] }>();
  for (const r of rows) {
    for (const m of r.metrics ?? []) {
      if (!m?.key) continue;
      const e = byKey.get(m.key) ?? { label: m.label || m.key, unit: m.unit, values: [] };
      if (typeof m.value === "number" && Number.isFinite(m.value)) e.values.push(m.value);
      byKey.set(m.key, e);
    }
  }
  const out: NumericProfile[] = [];
  for (const [key, e] of byKey) {
    // A metric only some rows carry is a trap for a chart that assumes it is
    // always there, so the coverage gap is preserved as `nulls`.
    const p = numeric(`${prefix}.metrics.${key}`, e.label, [...e.values, ...Array(Math.max(0, rows.length - e.values.length)).fill(null)], e.unit);
    if (p) out.push(p);
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 24);
}

/** Shorten long strings in a sample row: shape is the point, prose is not. */
function trim(o: JsonObject, chars = 120): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string") out[k] = v.length > chars ? `${v.slice(0, chars)}…` : v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 4).map((x) => (typeof x === "string" && x.length > chars ? `${x.slice(0, chars)}…` : x));
    else out[k] = v;
  }
  return out;
}

/* -------------------------------------------------------------------- build */

export function buildDataProfile(input: {
  sessionResults: { session_key: string; user_key: string; result: SessionAnalysis }[];
  userResults: { user_key: string; result: UserAnalysis }[];
  globalResult?: GlobalAnalysis | null;
  messages: number;
  /** How many rows the drill endpoints can actually serve. */
  available?: { users?: number; sessions?: number };
}): DataProfile {
  const s = input.sessionResults;
  const u = input.userResults;

  const numerics = [
    numeric("session.quality_score", "会话质量分", s.map((r) => r.result?.quality_score), "分"),
    numeric("user.session_count", "用户会话数", u.map((r) => r.result?.session_count), "个"),
    ...metricProfiles(s.map((r) => r.result ?? {}), "session"),
    ...metricProfiles(u.map((r) => r.result ?? {}), "user"),
  ].filter((x): x is NumericProfile => !!x);

  const categoricals = [
    categorical("session.intent", "会话意图", s.map((r) => [r.result?.intent ?? ""])),
    categorical("session.outcome", "会话结果", s.map((r) => [r.result?.outcome ?? ""])),
    categorical("session.sentiment", "情绪", s.map((r) => [r.result?.sentiment ?? ""])),
    categorical("session.risk_level", "会话风险等级", s.map((r) => [r.result?.risk_level ?? ""])),
    categorical("session.tags", "会话标签", s.map((r) => r.result?.tags ?? []), 20),
    categorical("session.problems", "问题描述", s.map((r) => r.result?.problems ?? []), 20),
    categorical("user.risk_level", "用户风险等级", u.map((r) => [r.result?.risk_level ?? ""])),
    categorical("user.tags", "用户标签", u.map((r) => r.result?.tags ?? []), 20),
    categorical("user.needs", "用户诉求", u.map((r) => r.result?.needs ?? []), 20),
  ].filter((x): x is CategoricalProfile => !!x);

  const texts = [
    text("session.summary", "会话摘要", s.map((r) => r.result?.summary)),
    text("user.summary", "用户摘要", u.map((r) => r.result?.summary)),
    text("user.persona", "用户画像", u.map((r) => r.result?.persona)),
  ].filter((x): x is TextProfile => !!x);

  const warnings: string[] = [];
  for (const c of categoricals) {
    if (c.cardinality > 15) {
      warnings.push(
        `${c.label}(${c.key}) 有 ${c.cardinality} 个不同取值，Top${c.top.length} 只覆盖 ${c.topCoverage}% —— 饼图会失真，请用排序条形图 + “其他”合并，或允许用户展开。`,
      );
    }
  }
  for (const t of texts) {
    if (t.maxChars > 200) {
      warnings.push(`${t.label}(${t.key}) 最长 ${t.maxChars} 字（中位 ${t.medianChars} 字），卡片和表格里必须截断或折叠。`);
    }
    if (t.empty > 0) {
      warnings.push(`${t.label}(${t.key}) 有 ${t.empty} 行为空，需要空值占位而不是渲染成空白。`);
    }
  }
  for (const n of numerics) {
    if (n.nulls > 0) {
      warnings.push(`${n.label}(${n.key}) 有 ${n.nulls} 行缺失，图表要跳过而不是当 0 处理。`);
    }
  }
  if ((input.available?.users ?? u.length) > 500) {
    warnings.push(`用户共 ${input.available?.users ?? u.length} 位，禁止一次性渲染全部，必须分页或虚拟滚动。`);
  }

  return {
    scale: {
      sessions: s.length,
      users: u.length,
      messages: input.messages,
      usersAvailable: input.available?.users ?? u.length,
      sessionsAvailable: input.available?.sessions ?? s.length,
    },
    numerics,
    categoricals,
    texts,
    samples: {
      session: s.slice(0, 2).map((r) => trim({ session_key: r.session_key, user_key: r.user_key, ...r.result })),
      user: u.slice(0, 2).map((r) => trim({ user_key: r.user_key, ...r.result })),
    },
    warnings: warnings.slice(0, 20),
  };
}

/* ------------------------------------------------------------------- render */

/** Compact text form for the prompt — numbers the model can design against. */
export function renderDataProfile(p: DataProfile): string {
  const lines: string[] = [];

  lines.push(`## 规模`);
  lines.push(
    `会话 ${p.scale.sessions} 个 · 用户 ${p.scale.users} 位 · 消息 ${p.scale.messages} 条`,
  );
  lines.push(
    `页面可分页取到：用户 ${p.scale.usersAvailable} 行、会话 ${p.scale.sessionsAvailable} 行`,
  );

  if (p.numerics.length) {
    lines.push(`\n## 数值字段`);
    for (const n of p.numerics) {
      lines.push(
        `- ${n.key}（${n.label}${n.unit ? ` / ${n.unit}` : ""}）：${n.min} ~ ${n.max}，均值 ${n.mean}，中位 ${n.p50}，P90 ${n.p90}${n.nulls ? `，缺失 ${n.nulls} 行` : ""}`,
      );
    }
  }

  if (p.categoricals.length) {
    lines.push(`\n## 分类字段`);
    for (const c of p.categoricals) {
      const top = c.top.slice(0, 8).map((t) => `${t.name} ${t.value}`).join(" / ");
      lines.push(
        `- ${c.key}（${c.label}）：${c.cardinality} 个取值，${c.perRow > 1.05 ? `每行平均 ${c.perRow} 个，` : ""}Top${Math.min(8, c.top.length)} 覆盖 ${c.topCoverage}% → ${top}`,
      );
    }
  }

  if (p.texts.length) {
    lines.push(`\n## 文本字段`);
    for (const t of p.texts) {
      lines.push(`- ${t.key}（${t.label}）：最长 ${t.maxChars} 字，中位 ${t.medianChars} 字${t.empty ? `，${t.empty} 行为空` : ""}`);
    }
  }

  if (p.warnings.length) {
    lines.push(`\n## 必须处理的边界情况`);
    for (const w of p.warnings) lines.push(`- ${w}`);
  }

  lines.push(`\n## 真实样本（仅供了解字段形状，不要把这些值写进页面）`);
  lines.push("```json");
  lines.push(JSON.stringify(p.samples, null, 1).slice(0, 4000));
  lines.push("```");

  return lines.join("\n");
}
