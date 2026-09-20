/**
 * Unit tests for the model-output JSON parser. Pure functions, no model calls.
 * Run: npx tsx scripts/test-json-parse.ts
 *
 * The cases are the real shapes Model Studio endpoints produced in production:
 * pretty-printed JSON cut off mid-sentence (max_tokens, or the SSE stream
 * dropping before the finish chunk), a fence, prose around the object, and a
 * <think> prefix that ends up in `content` instead of `reasoning_content`.
 */
import { tryParseJson, excerpt, faultWindow } from "../src/lib/engine/ai";

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
  check("直接解析", r.ok && r.value.title === "报告" && r.fix === "clean");
}

console.log("\n[2] 包装：代码块 / 前后解释 / <think> 前缀");
{
  const fenced = tryParseJson<Spec>('```json\n{"title":"报告"}\n```');
  check("去掉 Markdown 代码块", fenced.ok && fenced.value.title === "报告" && fenced.fix === "clean");

  const prose = tryParseJson<Spec>('好的，以下是结果：\n{"title":"报告"}\n希望对你有帮助。');
  check("忽略前后解释文字", prose.ok && prose.value.title === "报告" && prose.fix === "clean");

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
  check("标记为 truncated，让调用方知道内容有损", r.ok && r.fix === "truncated");
  check("救回的内容本身合法", r.ok && r.value.sections?.[1]?.title === "问题诊断");
  // 半截的句子会被补成一个完整字符串留下来 —— 报告里看得见，但比整章丢掉好
  check("半截的文字被保留成完整字符串", r.ok && JSON.stringify(r.value).includes("风险提"));
}

console.log("\n[4] 模型写出的 JSON 语法瑕疵");
{
  // 线上真实报错：Expected double-quoted property name at position 4409，
  // 出现在一万字回答的中间，收尾括号完好 —— 不是截断，是逗号/裸键。
  const trailing = tryParseJson<Spec>('{"title":"报告","sections":[{"id":"a","title":"概览"},]}');
  check("} 或 ] 前的多余逗号", trailing.ok && trailing.value.sections?.length === 1, JSON.stringify(trailing));
  check("多余逗号标记为 relaxed（无内容损失）", trailing.ok && trailing.fix === "relaxed");

  const bareKey = tryParseJson<{ kpis: { label: string; value: number }[] }>(
    '{"kpis":[{"label":"解决率",value:61.25,"unit":"%"}]}',
  );
  check("逗号后的裸键", bareKey.ok && bareKey.value.kpis?.[0]?.value === 61.25, JSON.stringify(bareKey));

  // 契约里 {label,value,unit,...} 的简写被模型原样抄了下来
  const shorthand = tryParseJson<{ kpis: Record<string, unknown>[] }>(
    '{"kpis":[{label,value,unit,delta,hint,tone,source_field}]}',
  );
  check("契约简写被原样抄写时也能解析", shorthand.ok && "label" in (shorthand.value.kpis?.[0] ?? {}),
    JSON.stringify(shorthand));

  // 旧契约写着 "value": 数字或字符串 / "data":[数字]，模型照抄进回答里
  const placeholder = tryParseJson<{ value: unknown; data: unknown[] }>(
    '{"value": 数字或字符串, "data":[数字]}',
  );
  check("占位说明被当成 null", placeholder.ok && placeholder.value.value === null, JSON.stringify(placeholder));

  // 下面四种由 jsonrepair 兜底：手写规则不去追这些，但它见得多
  const quotes = tryParseJson<{ a: number }>("{'a':1}");
  check("单引号", quotes.ok && quotes.value.a === 1 && quotes.fix === "relaxed", JSON.stringify(quotes));
  const smart = tryParseJson<{ a: number }>('{“a”:1}');
  check("中文全角引号", smart.ok && smart.value.a === 1, JSON.stringify(smart));
  const missing = tryParseJson<{ a: number; b: number }>('{"a":1 "b":2}');
  check("漏掉逗号", missing.ok && missing.value.b === 2, JSON.stringify(missing));
  const comment = tryParseJson<{ a: number }>('{"a":1 // 说明\n}');
  check("JSON 里写了注释", comment.ok && comment.value.a === 1, JSON.stringify(comment));

  const nan = tryParseJson<{ value: number | null }>('{"value":NaN}');
  check("NaN 当作 null", nan.ok && nan.value.value === null, JSON.stringify(nan));

  // 字符串内部的逗号、花括号、裸词都不能被动到
  const inner = tryParseJson<{ text: string }>('{"text":"数组写成 {a,b,}，值是 NaN，都只是正文"}');
  check("正文里的同款字符不被改动", inner.ok && inner.value.text === "数组写成 {a,b,}，值是 NaN，都只是正文");
  const literals = tryParseJson<{ flags: unknown[] }>('{"flags":[true,false,null]}');
  check("数组里的 true/false/null 不被当成键", literals.ok && literals.value.flags?.length === 3);
}

console.log("\n[5] 兜底修复不能越界");
{
  // jsonrepair 单独用时，这两种输入会被"修"成合法 JSON：
  //   '我无法完成这个请求。'  -> "我无法完成这个请求。"（一个合法的 JSON 字符串）
  //   '好的：{"a":1}以上。'   -> ["好的：", {"a":1}, "以上。"]（数组）
  // 两种都会作为"解析成功"流到调用方，变成一份空报告，所以都必须挡住。
  const refusal = tryParseJson<Spec>("抱歉，我不能生成该报告。");
  check("模型的拒绝回复不会变成合法 JSON 字符串", !refusal.ok, JSON.stringify(refusal));

  const withProse = tryParseJson<Spec>('好的：\n{"title":"报告"}\n以上。');
  check(
    "前后有解释时拿到的是对象而不是数组",
    withProse.ok && !Array.isArray(withProse.value) && withProse.value.title === "报告",
    JSON.stringify(withProse),
  );

  const scalar = tryParseJson<Spec>("42 分");
  check("标量/散文不会被当成修复结果", !scalar.ok);
}

console.log("\n[6] 失败时报告的原因");
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

console.log("\n[7] excerpt / faultWindow — 存进 error 字段的原文摘录");
{
  const long = "甲".repeat(5000);
  const e = excerpt(long);
  check("长文本被裁剪", e.length < 600, String(e.length));
  check("保留开头与结尾", e.startsWith("甲") && e.endsWith("甲") && e.includes("省略"));
  check("短文本原样返回", excerpt("短") === "短");

  // 头尾摘录对「错在中间」毫无帮助：线上那次的缺陷在第 4409 个字符，
  // 头 260 字 + 尾 160 字恰好把它漏掉了。失败时必须带上出错位置的上下文。
  const failed = tryParseJson<Spec>('{"a":1],"b":2}');
  check("结构彻底对不上时仍然失败", !failed.ok, JSON.stringify(failed));
  check(
    "失败时带出错位置的上下文",
    !failed.ok && failed.fault.includes("⟪出错在这里⟫]"),
    failed.ok ? "" : failed.fault,
  );

  // 中段有缺陷但前面是完整的：宁可截断保住已经写出来的部分，也不要整份丢掉
  const filler = "甲".repeat(2000);
  const midway = tryParseJson<{ head: string; bad?: unknown }>(
    `{"head":"${filler}","bad":{"x":1,,,`,
  );
  check("中段坏掉时保住前面完整的部分", midway.ok && midway.value.head?.length === 2000,
    midway.ok ? "" : midway.reason);
  const w = faultWindow('{"a":1,}', "Expected double-quoted property name in JSON at position 7");
  check("窗口标出了出错的字符", w.includes("⟪出错在这里⟫}"), w);
  check("没有位置信息时返回空串", faultWindow("{}", "some other error") === "");
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
