/**
 * Unit tests for「按建议直接改配置」的合并规则。Pure functions, no model calls.
 * Run: npx tsx scripts/test-refine.ts
 */
import { applyRefineResult, type RefineResult, type TemplateConfig } from "../src/lib/engine/plan";

const PARENT: TemplateConfig = {
  version: 3,
  session_prompt: "会话层提示词原文",
  user_prompt: "用户层提示词原文",
  global_prompt: "全局层提示词原文",
  report_prompt: "报告提示词原文",
  metric_schema: {
    session: [{ key: "quality_score", label: "质量分" }],
    user: [{ key: "avg_quality", label: "平均质量分" }],
    global: [{ key: "resolve_rate", label: "解决率" }],
  },
  rationale: "v3 的规划说明",
};

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

function threw(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

console.log("\n[1] 只改一段：其余三段原样沿用");
{
  const data: RefineResult = {
    change_note: "报告加了语音链路专项章节",
    changed: ["report_prompt"],
    report_prompt: "报告提示词新版：先讲 ASR 误识别与 TTS 打断",
  };
  const out = applyRefineResult(PARENT, data);
  check("report_prompt 用新版", out.report_prompt.startsWith("报告提示词新版"));
  check("session_prompt 原样", out.session_prompt === PARENT.session_prompt);
  check("user_prompt 原样", out.user_prompt === PARENT.user_prompt);
  check("global_prompt 原样", out.global_prompt === PARENT.global_prompt);
  check("changed 只记一段", JSON.stringify(out.changed) === '["report_prompt"]', JSON.stringify(out.changed));
  check("metric_schema 沿用父版本", out.metric_schema.session.length === 1 && out.metric_schema.global.length === 1);
  check("change_note 透传", out.change_note.includes("语音链路"));
}

console.log("\n[2] changed 是模型的说法，以正文为准");
{
  const data: RefineResult = {
    // 声称改了会话层，但正文与父版本逐字相同；同时偷偷改了用户层却没声明。
    changed: ["session_prompt"],
    session_prompt: "  会话层提示词原文  ",
    user_prompt: "用户层提示词新版：补一条跨会话重复来访的口径",
  };
  const out = applyRefineResult(PARENT, data);
  check("空改动不记入 changed", !out.changed.includes("session_prompt"), JSON.stringify(out.changed));
  check("未声明但确实改了的记入 changed", out.changed.includes("user_prompt"));
  check("session_prompt 保留父版本原文", out.session_prompt === PARENT.session_prompt);
}

console.log("\n[3] 一段都没改：拒绝生成空版本");
{
  const msg = threw(() =>
    applyRefineResult(PARENT, { change_note: "我觉得已经很好了", changed: [] }),
  );
  check("抛出可读错误", Boolean(msg && msg.includes("没有对任何一段提示词做出改动")), String(msg));

  const echoed = threw(() =>
    applyRefineResult(PARENT, {
      changed: ["session_prompt", "report_prompt"],
      session_prompt: PARENT.session_prompt,
      report_prompt: PARENT.report_prompt,
    }),
  );
  check("原样回显四段也算没改", Boolean(echoed), String(echoed));
}

console.log("\n[4] metric_schema 逐层合并");
{
  const out = applyRefineResult(PARENT, {
    report_prompt: "报告提示词新版",
    metric_schema: { session: [{ key: "tts_p90", label: "TTS P90" }] },
  });
  check("给了的层用新值", (out.metric_schema.session[0] as { key: string }).key === "tts_p90");
  check("没给的层沿用父版本", (out.metric_schema.user[0] as { key: string }).key === "avg_quality");

  const cleared = applyRefineResult(PARENT, {
    report_prompt: "报告提示词新版",
    metric_schema: { user: [] },
  });
  check("显式清空某一层是有效改动", cleared.metric_schema.user.length === 0);
}

console.log("\n[5] 父版本缺 metric_schema 也不炸");
{
  const out = applyRefineResult(
    { ...PARENT, metric_schema: undefined },
    { global_prompt: "全局层提示词新版" },
  );
  check("三层都回落为空数组", out.metric_schema.session.length === 0 && out.metric_schema.global.length === 0);
  check("change_note 缺省为空串", out.change_note === "");
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
