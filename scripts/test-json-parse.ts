/**
 * Unit tests for the model-output JSON parser. Pure functions, no model calls.
 * Run: npx tsx scripts/test-json-parse.ts
 *
 * The cases are the real shapes Model Studio endpoints produced in production:
 * pretty-printed JSON cut off mid-sentence (max_tokens, or the SSE stream
 * dropping before the finish chunk), a fence, prose around the object, and a
 * <think> prefix that ends up in `content` instead of `reasoning_content`.
 */
import { tryParseJson, excerpt } from "../src/lib/engine/ai";

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

interface Spec {
  title?: string;
  sections?: { id: string; title: string }[];
}

console.log("\n[1] 正常输出");
{
  const r = tryParseJson<Spec>(`{"title":"报告","sections":[{"id":"a","title":"概览"}]}`);
  check("直接解析", r.ok && r.value.title === "报告" && r.repaired === false);
}

console.log("\n[2] 包装：代码块 / 前后解释 / <think> 前缀");
{
  const fenced = tryParseJson<Spec>('```json\n{"title":"报告"}\n```');
  check("去掉 Markdown 代码块", fenced.ok && fenced.value.title === "报告" && !fenced.repaired);

  const prose = tryParseJson<Spec>('好的，以下是结果：\n{"title":"报告"}\n希望对你有帮助。');
  check("忽略前后解释文字", prose.ok && prose.value.title === "报告" && !prose.repaired);

  const think = tryParseJson<Spec>('<think>我需要输出 {"title": ...} 这样的结构</think>\n{"title":"报告"}');
  check("跳过 <think> 段（其中也有花括号）", think.ok && think.value.title === "报告");

  const inner = tryParseJson<Spec>('{"title":"用 ```json 包起来的示例"}');
  check("正文里的 ``` 不被当成代码块", inner.ok && inner.value.title === "用 ```json 包起来的示例");
}

console.log("\n[3] 被截断的输出");
// Exactly the shape that failed in production: pretty-printed, cut mid-string.
const TRUNCATED = `{
  "title": "预览报告",
  "sections": [
    { "id": "overview", "title": "整体概览" },
    { "id": "issues", "title": "问题诊断" },
    { "id": "risk", "title": "风险提`;
{
  const r = tryParseJson<Spec>(TRUNCATED);
  // The rescue walks back to the last point where every value was complete, so
  // the half-written section survives only up to its last finished field.
  check("能救回已经说完的部分", r.ok && (r.value.sections?.length ?? 0) >= 2, JSON.stringify(r));
  check("标记为 repaired，让调用方知道内容有损", r.ok && r.repaired === true);
  check("救回的内容本身合法", r.ok && r.value.sections?.[1]?.title === "问题诊断");
  check("半截的字段被丢掉，不会留下残缺文本", r.ok && !JSON.stringify(r.value).includes("风险提"));
}

console.log("\n[4] 失败时报告的原因");
{
  const r = tryParseJson<Spec>("我无法完成这个请求。");
  check("完全不是 JSON 时失败", !r.ok);
  // The old parser sliced from the first "[" to the last "]" and reported that
  // slice's error — "Unexpected non-whitespace character after JSON at
  // position 125" — which described a fragment nobody ever sent.
  const cut = tryParseJson<Spec>(`{
  "title": "预览报告",
  "kpis": [
    { "label": "会话数", "value": 12 }
  ],
  "sections": [
    { "id": "overview"`);
  const reason = cut.ok ? "" : cut.reason;
  check(
    "截断时不再报告尾括号切片的假错误",
    cut.ok || !reason.includes("after JSON"),
    reason,
  );

  const empty = tryParseJson<Spec>("   ");
  check("空输出有专门的说法", !empty.ok && empty.reason.includes("没有返回任何内容"));
}

console.log("\n[5] excerpt — 存进 error 字段的原文摘录");
{
  const long = "甲".repeat(5000);
  const e = excerpt(long);
  check("长文本被裁剪", e.length < 600, String(e.length));
  check("保留开头与结尾", e.startsWith("甲") && e.endsWith("甲") && e.includes("省略"));
  check("短文本原样返回", excerpt("短") === "短");
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
