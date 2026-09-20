/**
 * Exercises the report page contract without spending a model call: compose a
 * document the way the pipeline does, run it through the real validator, and
 * check that a good page passes and a broken one is caught for the reasons we
 * expect. Run: npm run test:report
 */
import { buildDataProfile } from "../src/lib/engine/report-profile";
import {
  acceptsSnapshot,
  composeReportDocument,
  injectSnapshot,
  type ReportPayload,
  type ReportSnapshot,
} from "../src/lib/engine/report-runtime";
import { renderIssues, validateReportDocument } from "../src/lib/engine/report-validate";
import type { SessionAnalysis, UserAnalysis } from "../src/lib/types";

const OUTCOMES = ["resolved", "escalated", "abandoned", "partial", "transferred", "timeout", "unknown"];

function fakeSessions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    session_key: `s-${i}`,
    user_key: `u-${i % 40}`,
    result: {
      summary: i % 17 === 0 ? "" : `用户咨询了套餐变更的问题，坐席在第 ${i % 9} 轮给出方案。`.repeat(i % 5 === 0 ? 6 : 1),
      intent: ["套餐变更", "账单查询", "故障报修", "投诉"][i % 4],
      outcome: OUTCOMES[i % OUTCOMES.length],
      sentiment: ["positive", "neutral", "negative"][i % 3],
      quality_score: i % 23 === 0 ? (undefined as unknown as number) : 40 + (i % 60),
      risk_level: (["none", "low", "medium", "high"] as const)[i % 4],
      tags: [`tag-${i % 30}`, `tag-${(i * 7) % 30}`],
      metrics: [{ key: "turns", label: "对话轮次", value: 2 + (i % 12), unit: "轮" }],
      highlights: [],
      problems: i % 3 === 0 ? [`TTS 播报在第 ${i % 6} 轮被打断`] : [],
      evidence: [{ quote: "我已经说了三遍了", role: "user" }],
    } as SessionAnalysis,
  }));
}

function fakeUsers(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    user_key: `u-${i}`,
    result: {
      summary: `该用户主要围绕套餐与账单反复咨询。`,
      persona: "高频咨询 · 对等待敏感 · 倾向打断",
      session_count: 1 + (i % 9),
      needs: ["快速给出方案", "不要重复确认"],
      behaviour: ["经常在 TTS 播报中打断"],
      metrics: [{ key: "avg_quality", label: "平均质量分", value: 50 + (i % 45), unit: "分" }],
      risk_level: (["none", "low", "medium", "high"] as const)[i % 4],
      tags: [`ut-${i % 12}`],
      key_sessions: [`s-${i}`],
    } as UserAnalysis,
  }));
}

function payload(): ReportPayload {
  const sessionResults = fakeSessions(600);
  const userResults = fakeUsers(40);
  const profile = buildDataProfile({
    sessionResults,
    userResults,
    messages: 7200,
    available: { users: 12043, sessions: 81206 },
  });
  return {
    meta: {
      title: "语音客服质量分析",
      scopeNote: "2026-08-01 ~ 2026-08-31",
      generatedAt: new Date().toISOString(),
      taskName: "八月全量",
      templateVersion: 3,
      language: "zh",
      tone: "客观、数据驱动",
      includeEvidence: true,
    },
    profile,
    groundTruth: {
      population: { sessions: 600, messages: 7200 },
      metrics: [
        { key: "resolve_rate", field: "outcome", declared: true, label: "解决率", value: 61.4, unit: "%", formula: "resolved / 全部会话", stat: "rate" },
      ],
      distributions: [{ key: "outcome", label: "会话结果", items: OUTCOMES.map((n, i) => ({ name: n, value: 90 - i * 9 })) }],
    },
    global: {
      summary: "整体解决率 61.4%，低于目标线。",
      findings: [{ title: "TTS 打断集中在长播报", detail: "问题会话中 63% 出现打断。", severity: "warning" }],
      metrics: [{ key: "resolve_rate", label: "解决率", value: 61.4, unit: "%" }],
      distributions: [],
      recommendations: [{ title: "缩短首轮播报", detail: "控制在 12 秒内。", priority: "high" }],
    },
    stats: { sessions: 600 },
    distributions: [{ key: "outcome", label: "会话结果", items: OUTCOMES.map((n, i) => ({ name: n, value: 90 - i * 9 })) }],
    evidence: [{ session_key: "s-3", user_key: "u-3", problems: ["播报被打断"], highlights: [], quotes: ["用户：我已经说了三遍了"] }],
    users: { rows: fakeUsers(20).map((u) => ({ user_key: u.user_key, persona: u.result.persona, summary: u.result.summary, session_count: u.result.session_count, risk_level: u.result.risk_level, tags: u.result.tags, metrics: u.result.metrics })), total: 12043 },
    sessions: { rows: [], total: 81206 },
  };
}

/** A page of the kind we expect the model to produce. */
const GOOD_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>报告</title><style>body{font:15px/1.7 system-ui;margin:0;padding:32px;background:#0b0d12;color:#e8eaf0}
.kpi{display:inline-block;margin:0 18px 18px 0;padding:14px 18px;background:#161a23;border-radius:10px}
.bar{height:14px;background:#4f7cff;border-radius:3px}</style></head>
<body><main id="app"></main><script>
VL.ready(function () {
  var g = VL.groundTruth, app = document.getElementById('app');
  var h = '<h1>' + VL.escape(VL.meta.title) + '</h1><p>' + VL.escape(VL.meta.scopeNote) + '</p>';
  h += '<p>' + VL.escape(VL.global.summary) + '</p>';
  g.metrics.forEach(function (m) {
    h += '<div class="kpi"><b>' + VL.escape(m.label) + '</b><div>' + m.value + (m.unit || '') + '</div></div>';
  });
  var d = VL.distributions[0];
  if (d) {
    var max = Math.max.apply(null, d.items.map(function (i) { return i.value; }));
    h += '<h2>' + VL.escape(d.label) + '</h2>';
    d.items.forEach(function (i) {
      h += '<div>' + VL.escape(i.name) + '<div class="bar" style="width:' + (i.value / max * 60) + '%"></div></div>';
    });
  }
  h += '<h2>用户（共 ' + VL.userTotal + ' 位，先显示 ' + VL.users.length + ' 位）</h2>';
  VL.users.forEach(function (u) {
    h += '<div><b>' + VL.escape(u.user_key) + '</b> · ' + VL.escape(u.persona) + ' · ' + u.session_count + ' 会话</div>';
  });
  VL.global.recommendations.forEach(function (r) { h += '<p><b>' + VL.escape(r.title) + '</b> ' + VL.escape(r.detail) + '</p>'; });
  app.innerHTML = h;
  VL.done();
});
</script></body></html>`;

/**
 * Drill-down with no host, which is how a preview runs: the detail rows ride
 * inside the document and VL's async methods resolve from them. Validation
 * has no parent window either, so this is also the only way async calls can
 * be exercised at all.
 */
const SNAPSHOT_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>t</title></head>
<body><main id="app">载入中</main><script>
VL.ready(async function () {
  var app = document.getElementById('app'), out = '<h1>' + VL.escape(VL.meta.title) + '</h1>';
  out += '<p>' + VL.escape(VL.global.summary) + '</p>';

  var snap = window.__VL_SNAPSHOT__;
  if (snap && snap.meta && !VL.meta.offline) throw new Error('snapshot.meta 未合并进 VL.meta');
  if (VL.meta.offline) out += '<p class="offline">' + VL.escape(VL.meta.offline_note) + '</p>';

  var first = await VL.listUsers({ page: 1, size: 40, sort: 'session_count', order: 'desc' });
  out += '<h2>用户 ' + first.total + ' 位</h2>';
  first.rows.forEach(function (u) {
    out += '<div>' + VL.escape(u.user_key) + ' · ' + VL.escape(u.persona) + ' · '
         + u.session_count + ' 会话 · ' + VL.escape(u.summary) + '</div>';
  });

  var hit = await VL.listUsers({ q: 'u-1', size: 200 });
  out += '<p>搜索 u-1 命中 ' + hit.total + ' 位</p>';

  var one = await VL.getUser(first.rows[0].user_key);
  out += '<p>该用户会话数 ' + (one.session_keys || []).length + '</p>';

  var sess = await VL.getSession('s-0');
  out += '<h3>' + VL.escape(sess.session_key) + '</h3>';
  out += '<p>转录 ' + (sess.transcript || []).length + ' 条</p>';
  (sess.transcript || []).slice(0, 3).forEach(function (t) {
    out += '<blockquote>' + VL.escape(t.role) + '：' + VL.escape(t.text) + '</blockquote>';
  });

  app.innerHTML = out;
  VL.done();
});
</script></body></html>`;

function snapshot(): ReportSnapshot {
  return {
    users: fakeUsers(40).map((u) => ({
      user_key: u.user_key,
      ...u.result,
      session_keys: [`s-${u.user_key.slice(2)}`],
    })),
    sessions: fakeSessions(40).map((s) => ({
      session_key: s.session_key,
      user_key: s.user_key,
      ...s.result,
      transcript: [
        { role: "user", text: "我要改套餐" },
        { role: "assistant", text: "好的，正在为您查询" },
      ],
    })),
  };
}

/** Three separate contract violations in one page. */
const BAD_PAGE = `<!doctype html><html><head><title>x</title></head><body><div id="a"></div><script>
localStorage.setItem('k', '1');
document.getElementById('a').innerHTML = '<h1>解决率 62.4%</h1>';
missingFunction();
</script></body></html>`;

async function main() {
  const p = payload();
  let failures = 0;

  console.log("== 数据画像（模型看到的） ==");
  const { renderDataProfile } = await import("../src/lib/engine/report-profile");
  console.log(renderDataProfile(p.profile).slice(0, 1400));

  console.log("\n== 合格页面 ==");
  const good = await validateReportDocument(composeReportDocument(GOOD_PAGE, p), { screenshot: false });
  console.log("ok:", good.ok, "| stats:", JSON.stringify(good.stats));
  if (good.issues.length) console.log(renderIssues(good.issues));
  if (!good.ok) { failures++; console.log("!! 合格页面被误判为失败"); }

  console.log("\n== 自带数据的页面（预览形态：无宿主下探） ==");
  const snap = await validateReportDocument(composeReportDocument(SNAPSHOT_PAGE, p, snapshot()), {
    screenshot: false,
  });
  console.log("ok:", snap.ok, "| stats:", JSON.stringify(snap.stats));
  if (snap.issues.length) console.log(renderIssues(snap.issues));
  if (!snap.ok) { failures++; console.log("!! 自带数据的页面未通过校验"); }

  console.log("\n== 无数据时同一页面应当失败（证明上面确实走了 snapshot） ==");
  const nohost = await validateReportDocument(composeReportDocument(SNAPSHOT_PAGE, p), { screenshot: false });
  console.log("ok:", nohost.ok);
  if (nohost.ok) { failures++; console.log("!! 没有 snapshot 也通过了，下探并未真正执行"); }

  console.log("\n== 导出：给已发布的文档补上明细 ==");
  const served = composeReportDocument(SNAPSHOT_PAGE, p);
  if (!acceptsSnapshot(served)) { failures++; console.log("!! 文档没有留出 snapshot 注入点"); }

  const exported = injectSnapshot(served, {
    ...snapshot(),
    meta: { offline: true, offline_note: "离线文件，包含 40 / 12043 位用户的明细。" },
  });
  const off = await validateReportDocument(exported, { screenshot: false });
  console.log("ok:", off.ok, "| stats:", JSON.stringify(off.stats));
  if (off.issues.length) console.log(renderIssues(off.issues));
  if (!off.ok) { failures++; console.log("!! 导出后的文档未通过校验"); }

  const noSlot = "<!doctype html><html><head></head><body><p>内置渲染器的产物</p></body></html>";
  if (acceptsSnapshot(noSlot)) { failures++; console.log("!! 无注入点的文档被误判为可注入"); }
  if (injectSnapshot(noSlot, snapshot()) !== noSlot) {
    failures++;
    console.log("!! 无注入点的文档被改动了");
  }

  console.log("\n== 问题页面 ==");
  const bad = await validateReportDocument(composeReportDocument(BAD_PAGE, p), { screenshot: false });
  console.log("ok:", bad.ok);
  console.log(renderIssues(bad.issues));
  const kinds = new Set(bad.issues.map((i) => i.kind));
  for (const want of ["no-done", "storage", "page-error"]) {
    if (!kinds.has(want)) { failures++; console.log(`!! 没有检出预期问题：${want}`); }
  }
  if (bad.ok) { failures++; console.log("!! 问题页面被误判为通过"); }

  console.log(failures ? `\nFAILED (${failures})` : "\nPASSED");
  process.exit(failures ? 1 : 0);
}

main();
