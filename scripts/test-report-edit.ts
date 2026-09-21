/**
 * Unit tests for the report editing protocol: what the model is allowed to say,
 * and what happens to the page when it says it. Pure functions, no model calls
 * and no browser.
 * Run: npm run test:edit
 */
import {
  applyEdits,
  parseActions,
  parseEditBlocks,
  readPath,
  renderValue,
  extractHtml,
} from "../src/lib/engine/report-edit";

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

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head><style>
  .kpi { display: flex; gap: 12px; }
  .card { padding: 8px; }
</style></head>
<body>
  <h1 id="title">语音质量分析</h1>
  <div class="kpi"><div class="card">A</div><div class="card">B</div></div>
  <script>VL.ready(function () { VL.done(); });</script>
</body>
</html>`;

const block = (search: string, replace: string) =>
  `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

console.log("\n[1] 编辑块解析");
{
  const { edits, errors } = parseEditBlocks(`${block("a", "b")}\n${block("c", "d")}`);
  check("两个块都解析出来", edits.length === 2 && edits[1].search === "c" && edits[1].replace === "d");
  check("没有报错", errors.length === 0, errors.join(" / "));

  const multiline = parseEditBlocks(block("  .kpi { display: flex; }\n  x", "  .kpi { display: grid; }\n  y"));
  check("多行原文保留缩进与换行", multiline.edits[0].search === "  .kpi { display: flex; }\n  x");

  const empty = parseEditBlocks(block("a", ""));
  check("REPLACE 可以为空（表示删除）", empty.edits.length === 1 && empty.edits[0].replace === "");

  const noSplit = parseEditBlocks("<<<<<<< SEARCH\na\n>>>>>>> REPLACE");
  check("缺 ======= 时报错而不是猜", noSplit.edits.length === 0 && noSplit.errors.length === 1, noSplit.errors.join());

  const unclosed = parseEditBlocks("<<<<<<< SEARCH\na\n=======\nb");
  check("没闭合的块被丢弃并报错", unclosed.edits.length === 0 && unclosed.errors.length === 1);

  const stray = parseEditBlocks("=======\nb\n");
  check("孤立的分隔行被报出来", stray.errors.length === 1);
}

console.log("\n[2] 应用编辑");
{
  const one = applyEdits(PAGE, [{ search: "display: flex", replace: "display: grid" }]);
  check("唯一匹配被替换", one.applied === 1 && one.text.includes("display: grid"));
  check(
    "其余内容一字未动",
    one.text === PAGE.replace("display: flex", "display: grid") && one.failures.length === 0,
  );

  const many = applyEdits(PAGE, [{ search: `<div class="card">`, replace: `<div class="tile">` }]);
  check("出现多次时拒绝而不是改第一处", many.applied === 0 && many.failures.length === 1);
  check("拒绝理由说明了出现几次", /出现了 2 次/.test(many.failures[0].reason), many.failures[0].reason);
  check("页面保持原样", many.text === PAGE);

  const missing = applyEdits(PAGE, [{ search: "display: block", replace: "display: grid" }]);
  check("找不到就报告找不到", missing.applied === 0 && /找不到/.test(missing.failures[0].reason));

  const sequential = applyEdits(PAGE, [
    { search: "display: flex", replace: "display: grid" },
    { search: "display: grid; gap: 12px", replace: "display: grid; gap: 16px" },
  ]);
  check("后一个编辑作用在前一个的结果上", sequential.applied === 2 && sequential.text.includes("gap: 16px"));

  const partial = applyEdits(PAGE, [
    { search: "display: flex", replace: "display: grid" },
    { search: "不存在的原文", replace: "x" },
  ]);
  check("一个成功一个失败时两者都被报告", partial.applied === 1 && partial.failures.length === 1);
  check("成功的那个仍然生效", partial.text.includes("display: grid"));

  const noop = applyEdits(PAGE, [{ search: "display: flex", replace: "display: flex" }]);
  check("SEARCH 与 REPLACE 相同算无效编辑", noop.applied === 0 && /完全相同/.test(noop.failures[0].reason));

  const blank = applyEdits(PAGE, [{ search: "   \n  ", replace: "x" }]);
  check("空 SEARCH 被拒", blank.applied === 0 && /空的/.test(blank.failures[0].reason));

  // Trailing whitespace is the one difference the model cannot see in its own
  // output, so it is forgiven — but only when it still leaves one match.
  const loose = applyEdits(PAGE, [{ search: "  .card { padding: 8px; }   ", replace: "  .card { padding: 10px; }" }]);
  check("行尾空白差异被宽容处理", loose.applied === 1 && loose.text.includes("padding: 10px"));
}

console.log("\n[3] 动作解析");
{
  const bare = parseActions(PAGE);
  check("裸文档等价于 write（旧契约不变）", bare.length === 1 && bare[0].kind === "write");

  const tagged = parseActions(`<vl:write>\n${PAGE}\n</vl:write>`);
  check("带标签的整页也是 write", tagged.length === 1 && tagged[0].kind === "write");
  check("write 里拿到的是完整文档", tagged[0].kind === "write" && tagged[0].page.endsWith("</html>"));

  const fenced = parseActions("这是你要的页面：\n```html\n" + PAGE + "\n```\n");
  check("代码块与前言被剥掉", fenced.length === 1 && fenced[0].kind === "write");

  const patch = parseActions(`<vl:patch>\n${block("display: flex", "display: grid")}\n</vl:patch>`);
  check("patch 被解析", patch.length === 1 && patch[0].kind === "patch");
  check("patch 里带着编辑块", patch[0].kind === "patch" && patch[0].edits.length === 1);

  const look = parseActions(`<vl:look theme="dark"/><vl:look size="390x844"/><vl:look scroll="1600" id="mid"/>`);
  check("三个 look 都解析出来", look.length === 3);
  check("theme 解析正确", look[0].kind === "look" && look[0].theme === "dark");
  check("size 解析成宽高", look[1].kind === "look" && look[1].width === 390 && look[1].height === 844);
  check("scroll 与 id 解析正确", look[2].kind === "look" && look[2].scroll === 1600 && look[2].id === "mid");

  const rest = parseActions(
    `<vl:inspect selector=".kpi .card"/><vl:data path="global.findings"/><vl:done>已按意见改完</vl:done>`,
  );
  check("inspect / data / done 都解析出来", rest.length === 3);
  check("选择器保留原样", rest[0].kind === "inspect" && rest[0].selector === ".kpi .card");
  check("data 路径保留原样", rest[1].kind === "data" && rest[1].path === "global.findings");
  check("done 带上说明", rest[2].kind === "done" && rest[2].note === "已按意见改完");

  const order = parseActions(`<vl:patch>\n${block("A", "AA")}\n</vl:patch>\n<vl:look theme="dark"/>`);
  check("动作按书写顺序返回（先改再看）", order[0].kind === "patch" && order[1].kind === "look");

  const prose = parseActions("我觉得这个页面已经挺好了，没什么要改的。");
  check("纯解释文字解析不出动作", prose.length === 0);

  // A patch block's payload is HTML: nothing in it may be mistaken for a tag.
  const htmlInPatch = parseActions(
    `<vl:patch>\n${block("<div class=\"card\">A</div>", "<div class=\"card\">A<vl:done/></div>")}\n</vl:patch>`,
  );
  check(
    "patch 内容里的类标签文本不被当成动作",
    htmlInPatch.length === 1 && htmlInPatch[0].kind === "patch",
    htmlInPatch.map((a) => a.kind).join(","),
  );
}

console.log("\n[4] 读取 payload 路径");
{
  const payload = {
    meta: { title: "语音质量分析" },
    global: { findings: [{ title: "打断率偏高", severity: "warning" }], summary: "总体可用" },
    users: { rows: [{ user_key: "u-1" }], total: 12043 },
    groundTruth: null,
  };

  const ok = readPath(payload, "global.findings[0].title");
  check("下标与字段混合路径", ok.ok && ok.value === "打断率偏高");

  const vlPrefix = readPath(payload, "VL.users.total");
  check("允许带 VL. 前缀", vlPrefix.ok && vlPrefix.value === 12043);

  const dotted = readPath(payload, "global.findings.0.severity");
  check("点号下标等价于方括号", dotted.ok && dotted.value === "warning");

  const missing = readPath(payload, "global.nope");
  check("字段不存在时说明有哪些键", !missing.ok && /可用的键/.test(missing.reason), !missing.ok ? missing.reason : "");

  const throughNull = readPath(payload, "groundTruth.metrics");
  check("穿过 null 时明确说 null", !throughNull.ok && /null/.test(throughNull.reason));

  const tooDeep = readPath(payload, "meta.title.length");
  check("在标量上继续下钻被拒", !tooDeep.ok && /string/.test(tooDeep.reason));

  const badIndex = readPath(payload, "global.findings.x");
  check("数组下标不是整数时被拒", !badIndex.ok && /下标/.test(badIndex.reason));

  const empty = readPath(payload, "  ");
  check("空路径被拒", !empty.ok);

  const long = renderValue(Array.from({ length: 400 }, (_, i) => ({ i })), 200);
  check("过长的值被截断并注明共几项", long.includes("共 400 项") && long.length < 400);
}

console.log("\n[5] 文档提取");
{
  check("不完整的文档原样返回（由校验去判定截断）", extractHtml("<!doctype html><html><body>x").endsWith("x"));
  check("结尾多余内容被丢掉", extractHtml(`${PAGE}\n\n希望这份报告符合要求！`).endsWith("</html>"));
  check("非文档回答提取不出文档", !/<html/i.test(extractHtml("没有页面，只有说明。")));
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
