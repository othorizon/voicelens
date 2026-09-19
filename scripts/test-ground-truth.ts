/**
 * Unit tests for the numeric-integrity layer. Pure functions, no model calls.
 * Run: npx tsx scripts/test-ground-truth.ts
 */
import {
  deriveGroundTruth,
  reconcileWithGroundTruth,
  buildGroundTruthSection,
  type HistogramEntry,
} from "../src/lib/engine/ground-truth";
import type { ExtraFieldDef, ReportSpec } from "../src/lib/types";

const SCHEMA: ExtraFieldDef[] = [
  { name: "resolved", label: "本会话是否解决", kind: "boolean", scope: "session", usage: "metric", description: "", options: [] },
  { name: "interrupted", label: "打断", kind: "boolean", scope: "message", usage: "metric", description: "", options: [] },
  { name: "retry", label: "重复追问", kind: "boolean", scope: "message", usage: "metric", description: "", options: [] },
  { name: "tts_latency_ms", label: "TTS 首包延迟", kind: "number", scope: "message", usage: "metric", description: "", options: [] },
  { name: "asr_confidence", label: "ASR 置信度", kind: "number", scope: "message", usage: "metric", description: "", options: [] },
];

// Counts mirror the real demo dataset: 49 resolved / 31 not, 113 interrupted / 994.
const HISTOGRAM: HistogramEntry[] = [
  { key: "resolved", values: [{ name: "true", value: 49 }, { name: "false", value: 31 }] },
  { key: "resolve_hint", values: [{ name: "true", value: 67 }, { name: "false", value: 33 }] },
  { key: "interrupted", values: [{ name: "false", value: 881 }, { name: "true", value: 113 }] },
  { key: "retry", values: [{ name: "false", value: 917 }, { name: "true", value: 77 }] },
  {
    key: "tts_latency_ms",
    values: [
      { name: "均值", value: 504.0775 },
      { name: "中位数", value: 180.5 },
      { name: "P90", value: 1330.4 },
      { name: "最大值", value: 1805 },
      { name: "样本数", value: 994 },
    ],
  },
  {
    key: "asr_confidence",
    values: [
      { name: "均值", value: 0.8386 },
      { name: "中位数", value: 0.995 },
      { name: "P90", value: 1 },
      { name: "最大值", value: 1 },
      { name: "样本数", value: 994 },
    ],
  },
];

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const gt = deriveGroundTruth(HISTOGRAM, SCHEMA, { sessions: 80, messages: 994 });

console.log("\n[1] deriveGroundTruth");
const metric = (field: string, stat: string) =>
  gt.metrics.find((m) => m.field === field && m.stat === stat);

check("resolved 率 = 61.25%", metric("resolved", "rate")?.value === 61.25, String(metric("resolved", "rate")?.value));
check("interrupted 率 = 11.37%", metric("interrupted", "rate")?.value === 11.37, String(metric("interrupted", "rate")?.value));
check("retry 率 = 7.75%", metric("retry", "rate")?.value === 7.75, String(metric("retry", "rate")?.value));
check("tts P90 = 1330.4 且单位 ms", metric("tts_latency_ms", "p90")?.value === 1330.4 && metric("tts_latency_ms", "p90")?.unit === "ms");
check("asr 均值 = 0.8386", metric("asr_confidence", "mean")?.value === 0.8386);
check("resolve_hint 标记为未声明", metric("resolve_hint", "rate")?.declared === false);
check("解决率标签去掉了「本会话是否」前缀", metric("resolved", "rate")?.label === "解决率", metric("resolved", "rate")?.label);

console.log("\n[2] reconcileWithGroundTruth — 只在显式绑定且无矛盾时覆盖");

function specWith(heroKpis: ReportSpec["hero"] extends infer H ? (H extends { kpis?: infer K } ? K : never) : never, headline = "") {
  return {
    title: "T",
    level: "global",
    hero: { headline, summary: "", kpis: heroKpis },
    sections: [{ id: "s1", title: "总览", blocks: [] }],
  } as ReportSpec;
}

const kpiOf = (spec: ReportSpec, label: string) =>
  (spec.hero?.kpis ?? []).find((k) => k.label === label);

{
  const spec = specWith([{ label: "会话解决率", value: 5, unit: "%", source_field: "resolved" }]);
  const { spec: out, overrides } = reconcileWithGroundTruth(spec, gt);
  const v = kpiOf(out, "会话解决率")?.value;
  check("绑定 resolved 的错误值 5 被改为 61.25", v === 61.25, String(v));
  check("记录了一条 override", overrides.length === 1, `got ${overrides.length}`);
  check("hint 写明来源与模型原值", /resolved=true 的 49 条/.test(String(kpiOf(out, "会话解决率")?.hint)) && /模型原值 5/.test(String(kpiOf(out, "会话解决率")?.hint)));
}

{
  const spec = specWith([{ label: "解决率", value: 5, unit: "%", source_field: "resolve_hint" }]);
  const { spec: out, overrides } = reconcileWithGroundTruth(spec, gt);
  check("未声明字段 resolve_hint 不产生覆盖", overrides.length === 0 && kpiOf(out, "解决率")?.value === 5);
}

{
  const spec = specWith([{ label: "TTS P90首包延迟", value: 999, unit: "ms", source_field: "asr_confidence" }]);
  const { spec: out, overrides } = reconcileWithGroundTruth(spec, gt);
  check("标题说 TTS 却绑定 asr_confidence 时拒绝覆盖", overrides.length === 0 && kpiOf(out, "TTS P90首包延迟")?.value === 999);
}

{
  const spec = specWith([{ label: "TTS P90 首包延迟", value: 999, unit: "ms", source_field: "tts_latency_ms" }]);
  const { spec: out, overrides } = reconcileWithGroundTruth(spec, gt);
  check("绑定 tts_latency_ms 时按 P90 口径覆盖为 1330.4", kpiOf(out, "TTS P90 首包延迟")?.value === 1330.4, String(kpiOf(out, "TTS P90 首包延迟")?.value));
  check("override 字段为 tts_latency_ms", overrides[0]?.field === "tts_latency_ms");
}

{
  const spec = specWith([{ label: "TTS 首包延迟均值", value: 999, unit: "ms", source_field: "tts_latency_ms" }]);
  const { spec: out } = reconcileWithGroundTruth(spec, gt);
  check("均值口径覆盖为 504.0775（不被 P90 混淆）", kpiOf(out, "TTS 首包延迟均值")?.value === 504.0775, String(kpiOf(out, "TTS 首包延迟均值")?.value));
}

{
  const spec = specWith([
    { label: "打断率", value: 11.37, unit: "%", source_field: "interrupted" },
    { label: "平均质量分", value: 30.54 },
    { label: "ASR低置信占比", value: 29.99, unit: "%", source_field: "asr_confidence" },
  ]);
  const { spec: out, overrides } = reconcileWithGroundTruth(spec, gt);
  check("已经正确的打断率不产生 override", overrides.every((o) => o.field !== "interrupted") && kpiOf(out, "打断率")?.value === 11.37);
  check("无 source_field 的平均质量分不被改动", kpiOf(out, "平均质量分")?.value === 30.54);
  check("ASR 低置信占比（与均值不同口径）不被 asr 均值覆盖", kpiOf(out, "ASR低置信占比")?.value === 29.99, String(kpiOf(out, "ASR低置信占比")?.value));
}

{
  const spec = specWith([{ label: "会话解决率", value: 5, unit: "%", source_field: "resolved" }], "整体解决率仅5%，意图理解是核心瓶颈。");
  const { spec: out } = reconcileWithGroundTruth(spec, gt);
  check("正文中与错误 KPI 同句的 5% 被改为 61.25%", /解决率仅61\.25%/.test(String(out.hero?.headline)), String(out.hero?.headline));
}

{
  const spec = specWith([{ label: "会话解决率", value: 5, unit: "%", source_field: "resolved" }], "另有指标显示转化率仅5%，需要关注。");
  const { spec: out } = reconcileWithGroundTruth(spec, gt);
  check("不含该字段名词的句子不被误改", String(out.hero?.headline).includes("转化率仅5%"), String(out.hero?.headline));
}

{
  const before = specWith([{ label: "会话解决率", value: 5, unit: "%", source_field: "resolved" }]);
  reconcileWithGroundTruth(before, gt);
  check("输入 spec 不被原地修改", kpiOf(before, "会话解决率")?.value === 5);
}

console.log("\n[3] buildGroundTruthSection — 平台自算章节");
{
  const sec = buildGroundTruthSection(gt);
  check("生成了平台真值章节", Boolean(sec) && sec?.origin === "platform");
  const kpis = sec?.blocks.find((b) => b.kind === "kpis")?.kpis ?? [];
  const find = (label: string) => kpis.find((k) => k.label === label);
  check("含解决率 61.25%", find("解决率")?.value === 61.25, String(find("解决率")?.value));
  check("含打断率 11.37%", find("打断率")?.value === 11.37, String(find("打断率")?.value));
  check("含重复追问率 7.75%", find("重复追问率")?.value === 7.75, String(find("重复追问率")?.value));
  check("含 TTS 首包延迟 P90 = 1330.4", find("TTS 首包延迟 P90")?.value === 1330.4, String(find("TTS 首包延迟 P90")?.value));
  check("未声明的 resolve_hint 不出现在权威 KPI 里", !kpis.some((k) => k.source_field === "resolve_hint"));
  check("每个 KPI 都带 source_field，便于追溯", kpis.every((k) => Boolean(k.source_field)));
  check("附带确定性分布图表", (sec?.blocks ?? []).some((b) => b.kind === "bar"));
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
