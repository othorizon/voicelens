import type { ExtraFieldDef } from "@/lib/types";

/**
 * Deterministic metrics computed in code from the database, not by the model.
 *
 * The report prompt asks for numbers; models will substitute their own caliper
 * (and invent a justification for it) whenever the wording leaves room. Anything
 * the user declared in the extra schema is therefore measured here and handed
 * over as a value that must be reused verbatim — and any KPI that still
 * contradicts it is overwritten after generation.
 */
export interface HistogramEntry {
  key: string;
  values: { name: string; value: number }[];
  /** 1 = categorical counts, 2 = numeric summary. */
  kind?: number;
  /** Values excluded because they did not match the field's chosen type. */
  mixed_count?: number;
}

export interface GroundTruthMetric {
  key: string;
  /** Raw extra field this metric is computed from. */
  field: string;
  /** Only schema-declared fields are authoritative enough to override a report. */
  declared: boolean;
  label: string;
  value: string | number;
  unit: string;
  formula: string;
  /** Statistic identity, so a mean never overwrites a P90. */
  stat: "rate" | "mean" | "p50" | "p90" | "max";
}

export interface GroundTruth {
  population: { sessions: number; messages: number };
  metrics: GroundTruthMetric[];
  distributions: { key: string; label: string; items: { name: string; value: number }[] }[];
}

const STATS_NAMES = ["均值", "中位数", "P90", "最大值", "样本数"];

export function deriveGroundTruth(
  histogram: HistogramEntry[],
  schema: ExtraFieldDef[],
  population: { sessions: number; messages: number },
): GroundTruth {
  const defs = new Map((schema ?? []).map((f) => [f.name, f]));
  const metrics: GroundTruthMetric[] = [];
  const distributions: GroundTruth["distributions"] = [];

  for (const entry of histogram ?? []) {
    const def = defs.get(entry.key);
    const declared = Boolean(def);
    const label = def?.label ?? entry.key;
    const items = entry.values ?? [];
    if (!items.length) continue;

    const isNumericAgg = items.some((v) => STATS_NAMES.includes(v.name));

    if (isNumericAgg) {
      const at = (n: string) => items.find((v) => v.name === n)?.value;
      const n = at("样本数") ?? 0;
      const add = (stat: GroundTruthMetric["stat"], statLabel: string, value: number | undefined, formula: string) => {
        if (value === undefined) return;
        metrics.push({
          key: `${entry.key}_${stat}`,
          field: entry.key,
          declared,
          label: `${label} ${statLabel}`,
          value,
          unit: unitFor(entry.key),
          formula,
          stat,
        });
      };
      add("mean", "均值", at("均值"), `数据库对 ${n} 条记录的 ${entry.key} 求平均`);
      add("p50", "中位数", at("中位数"), `percentile_cont(0.5) over ${entry.key}`);
      add("p90", "P90", at("P90"), `percentile_cont(0.9) over ${entry.key}（${n} 条记录）`);
      add("max", "最大值", at("最大值"), `max(${entry.key})`);
      continue;
    }

    const names = items.map((i) => i.name);
    const total = items.reduce((s, i) => s + i.value, 0);
    const isBool = names.every((nm) => nm === "true" || nm === "false");

    if (isBool) {
      const trueCount = items.find((i) => i.name === "true")?.value ?? 0;
      metrics.push({
        key: `${entry.key}_rate`,
        field: entry.key,
        declared,
        label: rateLabel(label),
        value: total ? Math.round((trueCount / total) * 10000) / 100 : 0,
        unit: "%",
        formula: `${entry.key}=true 的 ${trueCount} 条 / 全部 ${total} 条（${def?.scope === "session" ? "会话级" : "消息级"}）`,
        stat: "rate",
      });
    }

    distributions.push({ key: entry.key, label, items });
  }

  // Declared fields first: they are the ones a report is allowed to be judged by.
  metrics.sort((a, b) => Number(b.declared) - Number(a.declared) || a.key.localeCompare(b.key));
  return { population, metrics, distributions };
}

/** "本会话是否解决" -> "解决率"; "打断" -> "打断率". */
function rateLabel(label: string): string {
  const base = label
    .replace(/^(本会话|本消息|该会话|该消息|消息级|会话级)/, "")
    .replace(/^是否(已经|已|被|发生)?/, "")
    .replace(/标记$/, "")
    .trim();
  const core = base || label;
  return /率$/.test(core) ? core : `${core}率`;
}

function unitFor(key: string): string {
  return /latency|delay|_ms$|ms$/i.test(key) ? "ms" : "";
}

/** Plain-text block for the report prompt; values are asserted, not suggested. */
export function renderGroundTruth(gt: GroundTruth): string {
  const authoritative = gt.metrics.filter((m) => m.declared);
  const informational = gt.metrics.filter((m) => !m.declared);
  if (!authoritative.length && !informational.length) return "（本数据源没有可用的 extra 真值字段）";

  const lines = authoritative.map((m) => `- ${m.label} = ${m.value}${m.unit}   [${m.formula}]`);
  const extra = informational.map((m) => `- ${m.label} = ${m.value}${m.unit}   [${m.formula}]`);
  const dists = gt.distributions.map(
    (d) => `- ${d.label}(${d.key})：${d.items.map((i) => `${i.name}=${i.value}`).join(", ")}`,
  );

  return [
    `统计口径：${gt.population.sessions} 个会话 / ${gt.population.messages} 条消息`,
    "",
    "【权威指标 — schema 已声明的字段，由 SQL 直接算出，同名指标必须原样使用】",
    lines.join("\n") || "（无）",
    "",
    "【参考指标 — 数据里存在但 schema 未声明，可引用但需注明来源字段】",
    extra.join("\n") || "（无）",
    "",
    "【取值分布 — 可直接用于 bar/pie/hbar 图表】",
    dists.join("\n") || "（无）",
  ].join("\n");
}

/* ------------------------------------------------------------ reconciliation */

import type { ReportBlock, ReportSpec } from "@/lib/types";

export interface MetricOverride {
  where: string;
  label: string;
  field: string;
  was: string | number | null;
  now: string | number;
  formula: string;
}

interface KpiLike {
  label?: string;
  hint?: string;
  value?: string | number;
  unit?: string;
}

function statOf(text: string): GroundTruthMetric["stat"] | null {
  if (/p90|90\s*分位/i.test(text)) return "p90";
  if (/p50|中位数/.test(text)) return "p50";
  if (/均值|平均/.test(text)) return "mean";
  if (/最大值|峰值/.test(text)) return "max";
  if (/率|占比|比例/.test(text)) return "rate";
  return null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function material(a: number | null, b: number): boolean {
  if (a === null) return false;
  const denom = Math.max(Math.abs(b), 1e-9);
  return Math.abs(a - b) / denom > 0.03 && Math.abs(a - b) > 0.01;
}

interface BoundKpi extends KpiLike {
  source_field?: string;
}

/** Tokens that identify a field in prose: Latin/digit runs and CJK runs. */
function labelTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(/[A-Za-z][A-Za-z0-9_]{1,}|[\u4e00-\u9fa5]{2,}/g) ?? []) {
    const t = m.toLowerCase();
    if (t.length >= 2) out.add(t);
  }
  // Split camel/snake identifiers so "tts_latency_ms" also yields "tts".
  for (const t of [...out]) {
    for (const part of t.split(/[_\s]+/)) {
      if (part.length >= 2) out.add(part);
    }
  }
  return [...out];
}

/**
 * A KPI may cite one field in `source_field` while its label talks about a
 * different declared field. That binding is contradictory, so it is not trusted —
 * overwriting it is how an ASR mean ended up replacing a TTS latency P90.
 */
function isContradictory(kpi: BoundKpi, metric: GroundTruthMetric, gt: GroundTruth): boolean {
  const label = String(kpi.label ?? "");
  if (!label) return false;
  const own = new Set(labelTokens(metric.label).concat(labelTokens(metric.field)));
  const otherFields = new Set(gt.metrics.filter((m) => m.declared && m.field !== metric.field).map((m) => m.field));

  for (const field of otherFields) {
    const other = gt.metrics.find((m) => m.field === field && m.declared);
    if (!other) continue;
    for (const token of labelTokens(other.label).concat(labelTokens(field))) {
      if (token.length < 2 || own.has(token)) continue;
      if (labelTokens(label).includes(token)) return true;
    }
  }
  return false;
}

/**
 * Match only on the model's explicit `source_field` binding. Inferring the
 * intended field from free-text labels and hints was tried twice and corrupted
 * numbers both times: once a fuzzy Chinese alias bound an undeclared
 * `resolve_hint` rate onto the declared `resolved` KPI, then a hint that cited
 * the wrong field bound an ASR mean onto a TTS-latency P90.
 */
function findAuthority(kpi: BoundKpi, gt: GroundTruth): GroundTruthMetric | undefined {
  const field = (kpi.source_field ?? "").trim().toLowerCase();
  if (!field) return undefined;
  const candidates = gt.metrics.filter((m) => m.declared && m.field.toLowerCase() === field);
  if (!candidates.length) return undefined;

  const metric = candidates.length === 1 ? candidates[0] : pickByStat(kpi, candidates);
  if (!metric) return undefined;
  return isContradictory(kpi, metric, gt) ? undefined : metric;
}

function pickByStat(kpi: BoundKpi, candidates: GroundTruthMetric[]): GroundTruthMetric | undefined {
  const stat = statOf(`${kpi.label ?? ""} ${kpi.hint ?? ""}`);
  const narrowed = stat ? candidates.filter((m) => m.stat === stat) : [];
  return narrowed.length === 1 ? narrowed[0] : undefined;
}

/**
 * Enforce numeric integrity. Returns the overrides so the caller can log them and
 * the report can disclose them instead of silently disagreeing with itself.
 */
export function reconcileWithGroundTruth(
  inputSpec: ReportSpec,
  gt: GroundTruth | undefined,
): { spec: ReportSpec; overrides: MetricOverride[] } {
  if (!gt?.metrics.some((m) => m.declared)) return { spec: inputSpec, overrides: [] };

  // Work on a copy so a failed run cannot leave a half-edited spec behind.
  const spec: ReportSpec = JSON.parse(JSON.stringify(inputSpec)) as ReportSpec;
  const overrides: MetricOverride[] = [];

  const fixKpis = (kpis: BoundKpi[] | undefined, where: string) => {
    for (const kpi of kpis ?? []) {
      const metric = findAuthority(kpi, gt);
      if (!metric || typeof metric.value !== "number") continue;
      const current = toNumber(kpi.value);
      if (!material(current, metric.value)) continue;

      const previous = kpi.value ?? "无";
      overrides.push({
        where,
        label: String(kpi.label ?? ""),
        field: metric.field,
        was: previous,
        now: metric.value,
        formula: metric.formula,
      });
      kpi.value = metric.value;
      kpi.unit = metric.unit || kpi.unit;
      kpi.hint = `分子/分母：${metric.formula}。平台按 SQL 真值校正（模型原值 ${previous}）。`;
    }
  };

  if (spec.hero) fixKpis(spec.hero.kpis as BoundKpi[] | undefined, "hero");
  (spec.sections ?? []).forEach((s, i) => {
    for (const b of s.blocks ?? []) {
      if (b.kind === "kpis") fixKpis(b.kpis as BoundKpi[] | undefined, `章节${i + 1}:${s.title}`);
    }
  });

  // A corrected KPI may also be quoted in prose. Only rewrite an exact
  // "<wrong>%" that sits in the same sentence as the field's own label noun.
  const uniq = new Map<string, MetricOverride>();
  for (const o of overrides) uniq.set(`${o.field}|${o.now}`, o);
  for (const o of uniq.values()) {
    const metric = gt.metrics.find((m) => m.field === o.field && m.value === o.now);
    if (!metric) continue;
    const wrongNum = toNumber(o.was);
    if (wrongNum === null) continue;
    const noun = metric.label.replace(/(均值|中位数|P90|最大值)$/, "").trim();
    if (noun.length < 2) continue;

    const fix = (text: string | undefined): string | undefined => {
      if (!text) return text;
      let out = text;
      for (const sentence of out.split(/(?<=[。；\n])/)) {
        if (!sentence.includes(noun) || !sentence.includes(`${wrongNum}%`)) continue;
        out = out.replace(sentence, sentence.split(`${wrongNum}%`).join(`${o.now}%`));
      }
      return out;
    };

    if (spec.hero) {
      spec.hero.headline = fix(spec.hero.headline) ?? spec.hero.headline;
      spec.hero.summary = fix(spec.hero.summary) ?? spec.hero.summary;
    }
    for (const sec of spec.sections ?? []) {
      sec.summary = fix(sec.summary) ?? sec.summary;
      for (const b of sec.blocks ?? []) {
        if (typeof b.text === "string") b.text = fix(b.text) ?? b.text;
      }
    }
  }

  if (overrides.length) {
    const rows = [...uniq.values()]
      .map((o) => `- **${o.label || o.field}**：模型给出 \`${o.was}\`，schema 字段 \`${o.field}\` 的 SQL 真值为 \`${o.now}\`（${o.formula}）`)
      .join("\n");
    const note: ReportBlock = {
      id: "ground-truth-reconciliation",
      kind: "callout",
      title: "指标口径校正",
      tone: "warning",
      text: `以下 KPI 的数值已由平台用数据库聚合真值覆盖模型输出；报告其余结论仍以模型分析为准。\n\n${rows}`,
    };
    if (spec.sections?.length) {
      spec.sections[0].blocks = [note, ...(spec.sections[0].blocks ?? [])];
    }
  }

  return { spec, overrides };
}

/* -------------------------------------------------- platform-computed section */

import type { ReportSection } from "@/lib/types";

const STAT_PRIORITY: Record<GroundTruthMetric["stat"], number> = {
  rate: 0, p90: 1, mean: 2, p50: 3, max: 4,
};

/**
 * A section built entirely from SQL aggregates — never routed through the model.
 * It guarantees the report always carries one authoritative copy of every
 * declared extra field, so a mis-stated model KPI can never be the only number
 * a reader sees.
 */
export function buildGroundTruthSection(gt: GroundTruth | undefined): ReportSection | null {
  if (!gt) return null;
  const declared = gt.metrics.filter((m) => m.declared && typeof m.value === "number");
  if (!declared.length) return null;

  const ordered = [...declared].sort(
    (a, b) =>
      STAT_PRIORITY[a.stat] - STAT_PRIORITY[b.stat] ||
      a.field.localeCompare(b.field) ||
      Number(a.value) - Number(b.value as number),
  );
  const kpis = ordered.slice(0, 12).map((m) => ({
    label: m.label,
    value: m.value as number,
    unit: m.unit || undefined,
    delta: null,
    hint: m.formula,
    tone: "default" as const,
    source_field: m.field,
  }));

  const distributions = gt.distributions
    .filter((d) => declared.some((m) => m.field === d.key))
    .slice(0, 4)
    .map((d) => ({
      id: `gt-dist-${d.key}`,
      kind: "bar" as const,
      title: `${d.label} 取值分布`,
      caption: `按消息条数统计，来自 extra.${d.key}`,
      categories: d.items.map((i) => i.name),
      series: [{ name: "消息数", data: d.items.map((i) => i.value) }],
    }));

  return {
    id: "platform-metrics",
    origin: "platform",
    title: "平台真值指标（SQL 直算）",
    summary: `以下指标由平台直接对数据库聚合，不经过模型，是本报告中所有同名字段的唯一权威口径。统计范围：${gt.population.sessions} 个会话 / ${gt.population.messages} 条消息。`,
    blocks: [
      { id: "gt-kpis", kind: "kpis", title: "确定性指标", kpis },
      ...distributions,
    ],
  };
}
