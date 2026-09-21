/**
 * The report loop, end to end, without a model provider.
 *
 * A tiny OpenAI-compatible endpoint on localhost plays the model: it streams
 * back scripted turns, and records what it was sent. That exercises the real
 * path — real SSE accumulation in `chat`, real Chromium through
 * `ReportSession`, real patching — and answers the questions that matter about
 * the loop rather than about its pieces:
 *
 *   - does a page that validates clean stop the loop at one turn;
 *   - does a broken page come back as issues and get fixed by a patch;
 *   - does the model actually receive the screenshots of its own output;
 *   - does a revision start from the page it was given;
 *   - does a regression lose to the version it started from.
 *
 * Needs a browser: run with VOICELENS_CHROMIUM_PATH pointing at one if
 * playwright's own build is not installed. Without a browser it says so and
 * skips, rather than passing vacuously.
 * Run: npm run test:agent
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runReportAgent } from "../src/lib/engine/report-agent";
import { reviseReportPage } from "../src/lib/engine/report-revise";
import { buildReportPayload } from "../src/lib/engine/report-payload";
import { NoBrowserError, ReportSession } from "../src/lib/engine/report-validate";
import type { ReportPayload } from "../src/lib/engine/report-runtime";
import { DEFAULT_STAGE_PARAMS } from "../src/lib/models/mode";
import type { AnalysisRuntime } from "../src/lib/models/registry";
import type { SessionAnalysis, UserAnalysis } from "../src/lib/types";

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

/* ------------------------------------------------------------ the fake model */

interface Recorded {
  /** Every message of the request, as the endpoint received it. */
  messages: { role: string; content: unknown }[];
  /** How many image parts the last user message carried. */
  images: number;
}

interface FakeModel {
  runtime: AnalysisRuntime;
  calls: Recorded[];
  close: () => Promise<void>;
}

async function fakeModel(replies: string[]): Promise<FakeModel> {
  const calls: Recorded[] = [];
  let n = 0;

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { messages?: { role: string; content: unknown }[] };
      const messages = parsed.messages ?? [];
      const last = messages[messages.length - 1];
      const images = Array.isArray(last?.content)
        ? (last.content as { type: string }[]).filter((p) => p.type === "image_url").length
        : 0;
      calls.push({ messages, images });

      const text = replies[Math.min(n, replies.length - 1)] ?? "";
      n++;

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Two chunks plus a usage frame: the same shape the SDK accumulates from
      // a real endpoint, including a split mid-document.
      const half = Math.ceil(text.length / 2);
      for (const piece of [text.slice(0, half), text.slice(half)]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const model = {
    id: "fake",
    name: "本地假模型",
    kind: "multimodal" as const,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test",
    model: "fake-1",
    thinking: false,
  };

  return {
    runtime: {
      mode: "omni_for_audio",
      omni: null,
      multimodal: model,
      stages: DEFAULT_STAGE_PARAMS,
      problems: {},
    },
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ----------------------------------------------------------------- fixtures */

function payload(): ReportPayload {
  const sessionResults = Array.from({ length: 24 }, (_, i) => ({
    session_key: `s-${i}`,
    user_key: `u-${i % 6}`,
    started_at: `2026-09-0${(i % 9) + 1}T08:00:00.000Z`,
    turn_count: 3 + (i % 6),
    result: {
      summary: `用户咨询套餐变更，坐席在第 ${i % 7} 轮给出方案，用户确认后结束。`,
      intent: ["套餐变更", "账单查询", "故障报修"][i % 3],
      outcome: ["resolved", "escalated", "abandoned"][i % 3],
      sentiment: ["positive", "neutral", "negative"][i % 3],
      quality_score: 50 + (i % 40),
      risk_level: (["none", "low", "medium", "high"] as const)[i % 4],
      tags: [`tag-${i % 5}`],
      metrics: [{ key: "turns", label: "对话轮次", value: 3 + (i % 6), unit: "轮" }],
      highlights: [],
      problems: [],
      evidence: [],
    } as SessionAnalysis,
  }));
  const userResults = Array.from({ length: 6 }, (_, i) => ({
    user_key: `u-${i}`,
    result: {
      summary: "反复围绕套餐与账单咨询，对等待时间敏感。",
      persona: "高频咨询 · 对等待敏感",
      session_count: 4,
      needs: ["快速给出方案"],
      behaviour: ["经常在播报中打断"],
      metrics: [{ key: "avg_quality", label: "平均质量分", value: 60 + i, unit: "分" }],
      risk_level: "low" as const,
      tags: [`ut-${i}`],
      key_sessions: [`s-${i}`],
    } as UserAnalysis,
  }));

  // The same builder the engine uses, so the page under test sees the field
  // names and shapes it will see in a real run.
  return buildReportPayload({
    title: "语音质量分析",
    taskName: "测试",
    templateVersion: 1,
    scopeNote: "测试范围",
    language: "zh",
    tone: "客观",
    includeEvidence: false,
    sessionResults,
    userResults,
    globalResult: {
      summary: "总体可用，升级率偏高：三分之一的会话最终被升级，集中在套餐变更这一意图上。",
      findings: [
        { title: "升级率偏高", detail: "三分之一的会话被升级，集中在套餐变更。", severity: "warning" },
        { title: "负面情绪集中在长等待", detail: "负面情绪会话的平均轮次高于整体。", severity: "info" },
      ],
      metrics: [{ key: "resolve_rate", label: "解决率", value: 33.3, unit: "%" }],
      distributions: [],
      recommendations: [{ title: "把套餐变更做成引导流程", detail: "减少来回确认。", priority: "high", impact: "中" }],
    },
    stats: {},
    distributions: [],
    groundTruth: {
      population: { sessions: 24, messages: 160 },
      metrics: [
        {
          key: "resolve_rate",
          field: "outcome",
          label: "解决率",
          value: 33.3,
          unit: "%",
          formula: "outcome = resolved 的会话 / 全部会话",
          stat: "rate",
          declared: true,
        },
        {
          key: "avg_turns",
          field: "turns",
          label: "平均轮次",
          value: 5.5,
          unit: "轮",
          formula: "所有会话轮次的算术平均",
          stat: "mean",
          declared: true,
        },
      ],
      distributions: [],
    },
    evidence: [],
    messages: 160,
  });
}

/** A page that renders, reads its numbers from VL, and signals completion. */
const goodPage = (marker: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>报告</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.7 system-ui, sans-serif; background: #fff; color: #111; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
  .kpi { display: flex; flex-wrap: wrap; gap: 12px; }
  .card { flex: 1 1 200px; border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border-bottom: 1px solid #eee; padding: 6px 8px; text-align: left; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0d12; color: #e8ecf4; }
    .card { border-color: #2a3140; }
    td, th { border-color: #222836; }
  }
</style></head>
<body><div class="wrap">
  <h1 id="title">${marker}</h1>
  <p id="summary"></p>
  <div class="kpi" id="kpi"></div>
  <div id="findings"></div>
  <h2>用户</h2>
  <table><tbody id="users"></tbody></table>
  <h2>会话</h2>
  <table><tbody id="sessions"></tbody></table>
</div>
<script>
  VL.ready(function () {
    document.getElementById('summary').textContent = VL.global.summary || '';

    var kpi = document.getElementById('kpi');
    ((VL.groundTruth && VL.groundTruth.metrics) || []).forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'card';
      d.innerHTML = '<div>' + VL.escape(m.label) + '</div><div>' + VL.escape(String(m.value)) +
                    VL.escape(m.unit || '') + '</div><div>' + VL.escape(m.formula || '') + '</div>';
      kpi.appendChild(d);
    });

    var f = document.getElementById('findings');
    (VL.global.findings || []).forEach(function (x) {
      var p = document.createElement('p');
      p.textContent = x.title + '：' + x.detail;
      f.appendChild(p);
    });

    var ub = document.getElementById('users');
    (VL.users || []).forEach(function (u) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + VL.escape(u.user_key) + '</td><td>' + VL.escape(u.persona) +
                     '</td><td>' + VL.escape(u.summary) + '</td>';
      ub.appendChild(tr);
    });

    var sb = document.getElementById('sessions');
    (VL.sessions || []).slice(0, 20).forEach(function (x) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + VL.escape(x.session_key) + '</td><td>' + VL.escape(x.intent) +
                     '</td><td>' + VL.escape(x.outcome) + '</td><td>' + VL.escape(x.summary) + '</td>';
      sb.appendChild(tr);
    });

    var pad = document.createElement('p');
    pad.textContent = '本页共覆盖 ' + VL.sessionTotal + ' 个会话与 ' + VL.userTotal +
      ' 位用户；上方指标均由平台用 SQL 直算，口径写在每张卡片下方，不由模型复述。';
    document.querySelector('.wrap').appendChild(pad);

    VL.done();
  });
</script>
</body></html>`;

/** Renders, but never signals completion: the loop must reject it. */
const brokenPage = goodPage("坏页面").replace("    VL.done();\n", "");

async function main() {
  try {
    const probe = await ReportSession.open();
    await probe.close();
  } catch (e) {
    if (e instanceof NoBrowserError) {
      console.log(`\n跳过：本机没有可用的浏览器（${e.message.split("\n")[0]}）。`);
      console.log("装一个 Chromium 并用 VOICELENS_CHROMIUM_PATH 指向它后再跑。\n");
      process.exit(0);
    }
    throw e;
  }

  const p = payload();

  console.log("\n[1] 一次就合格的页面：一轮结束，并且带回截图");
  {
    const model = await fakeModel([goodPage("一次就好")]);
    try {
      const out = await runReportAgent({
        runtime: model.runtime,
        payload: p,
        seed: { system: "你是测试用的模型。", task: "写一份报告。" },
      });
      check("校验通过", out.validation.ok, out.validation.issues.map((i) => i.message).join(" / "));
      check("只花了一轮", out.turns === 1, `turns=${out.turns}`);
      check("只调用了模型一次", model.calls.length === 1, `calls=${model.calls.length}`);
      check("页面就是模型写的那份", out.page.includes("一次就好"));
      check("文档注入了运行时", out.document.includes("__VL_PAYLOAD__") && out.document.includes("VL.done"));
      check("四个视角都截到了图", out.shots.length >= 3, `shots=${out.shots.map((s) => s.id).join(",")}`);
      check(
        "深色与手机视角在其中",
        out.shots.some((s) => s.id === "dark") && out.shots.some((s) => s.id === "mobile"),
      );
      check("截图是 JPEG", out.shots.every((s) => s.bytes.length > 1000 && s.bytes[0] === 0xff));
      check("token 计入", out.tokens === 300, `tokens=${out.tokens}`);
    } finally {
      await model.close();
    }
  }

  console.log("\n[2] 坏页面 → 校验结果与截图回传 → 用 patch 修好");
  {
    // The second turn patches the page the loop is holding, which is only
    // possible if the loop showed it that page.
    const patch = `<vl:patch>
<<<<<<< SEARCH
    var pad = document.createElement('p');
=======
    VL.done();
    var pad = document.createElement('p');
>>>>>>> REPLACE
</vl:patch>`;
    const model = await fakeModel([brokenPage, patch]);
    try {
      const out = await runReportAgent({
        runtime: model.runtime,
        payload: p,
        seed: { system: "你是测试用的模型。", task: "写一份报告。" },
      });
      check("两轮之后通过校验", out.validation.ok, out.validation.issues.map((i) => i.message).join(" / "));
      check("确实花了两轮", out.turns === 2, `turns=${out.turns}`);
      check("补丁真的改了页面", out.page.includes("VL.done();\n    var pad"));

      const second = model.calls[1];
      const text = JSON.stringify(second.messages);
      check("第二轮把上一版页面作为 assistant 消息带上", second.messages.some((m) => m.role === "assistant"));
      check("第二轮告诉了模型失败原因", /VL\.done/.test(text) && /no-done|等待/.test(text));
      check("第二轮附上了页面截图", second.images >= 3, `images=${second.images}`);
      check("截图是 data URL 形式的 JPEG", /data:image\/jpeg;base64,/.test(text));
      check("历史里记下了两轮各做了什么", out.history.length === 2 && out.history[1].did.includes("应用了"));
    } finally {
      await model.close();
    }
  }

  console.log("\n[3] 补丁打不上时，失败原因回给模型，页面不变");
  {
    const wrong = `<vl:patch>
<<<<<<< SEARCH
这段原文页面里根本没有
=======
x
>>>>>>> REPLACE
</vl:patch>`;
    const model = await fakeModel([goodPage("原始设计"), wrong]);
    try {
      const out = await runReportAgent({
        runtime: model.runtime,
        payload: p,
        seed: { system: "s", task: "t" },
        // A clean first page would stop at one turn, so force a second.
        maxTurns: 2,
      });
      check("页面仍然是原来那份", out.page.includes("原始设计"));
      check("最终仍然可用", out.validation.ok);
    } finally {
      await model.close();
    }
  }

  console.log("\n[4] 按建议修改：从给定页面出发，只改被指到的地方");
  {
    const patch = `<vl:patch>
<<<<<<< SEARCH
  <h1 id="title">上一版</h1>
=======
  <h1 id="title">改过的标题</h1>
>>>>>>> REPLACE
</vl:patch>
<vl:done/>`;
    const model = await fakeModel([patch]);
    try {
      const out = await reviseReportPage({
        runtime: model.runtime,
        brief: "设计要求原文",
        payload: p,
        page: goodPage("上一版"),
        feedback: "标题改成「改过的标题」",
      });
      check("标题改了", out.page.includes("改过的标题"));
      check("其余部分没动", out.page.includes("本页共覆盖 ") && out.validation.ok);
      check("记录为局部修改", out.mode === "patch", out.mode);

      const first = model.calls[0];
      const text = JSON.stringify(first.messages);
      check("第一轮就带上了要改的那份页面", first.messages.some((m) => m.role === "assistant"));
      check("第一轮带上了用户的建议原文", text.includes("标题改成"));
      check("第一轮就让模型看到了当前页面的样子", first.images >= 3, `images=${first.images}`);
    } finally {
      await model.close();
    }
  }

  console.log("\n[5] 改坏了的修订会失败，而不是把坏页面交出去");
  {
    const breakIt = `<vl:patch>
<<<<<<< SEARCH
    VL.done();
=======
    /* 故意不再收尾 */
>>>>>>> REPLACE
</vl:patch>`;
    const model = await fakeModel([breakIt]);
    try {
      const out = await reviseReportPage({
        runtime: model.runtime,
        brief: "设计要求原文",
        payload: p,
        page: goodPage("上一版"),
        feedback: "随便改点什么",
        maxAttempts: 1,
      });
      check("结果被判定为不可用", !out.validation.ok);
      check("失败原因指向 VL.done()", out.validation.issues.some((i) => i.kind === "no-done"));
    } finally {
      await model.close();
    }
  }

  console.log("\n[6] 看一眼 / 问数据 / 问浏览器，都能得到回答");
  {
    const ask = `<vl:look theme="dark" id="再看深色"/>
<vl:data path="global.findings[0].title"/>
<vl:inspect selector="#title"/>`;
    const fix = `<vl:patch>
<<<<<<< SEARCH
    var pad = document.createElement('p');
=======
    VL.done();
    var pad = document.createElement('p');
>>>>>>> REPLACE
</vl:patch>`;
    // The page has to still be broken for the loop to reach a second turn at
    // all, so the questions are asked before the fix rather than after.
    const model = await fakeModel([brokenPage, ask, fix]);
    try {
      const out = await runReportAgent({
        runtime: model.runtime,
        payload: p,
        seed: { system: "s", task: "t" },
        maxTurns: 4,
      });
      const third = JSON.stringify(model.calls[2]?.messages ?? []);
      check("data 返回了真实值", third.includes("升级率偏高"), third.slice(0, 160));
      // `third` is the request body re-stringified, so the inner JSON arrives escaped.
      check("inspect 返回了盒模型与计算样式", third.includes("rect") && third.includes("fontSize"));
      check("look 要的那张图也带上了", (model.calls[2]?.images ?? 0) >= 1);
      check("三轮内结束且页面可用", out.turns === 3 && out.validation.ok, `turns=${out.turns}`);
      check(
        "历史记下了查看动作",
        out.history[1].did.includes("看了") && out.history[1].did.includes("查了"),
        out.history[1].did,
      );
    } finally {
      await model.close();
    }
  }

  console.log("\n[7] 不认识协议的模型（只会输出整页）行为不变");
  {
    const model = await fakeModel([brokenPage, goodPage("整页重写")]);
    try {
      const out = await runReportAgent({
        runtime: model.runtime,
        payload: p,
        seed: { system: "s", task: "t" },
      });
      check("靠整页重写也能修好", out.validation.ok && out.page.includes("整页重写"));
      check("历史里记的是重写", out.history[1].did.includes("重写整页"));
    } finally {
      await model.close();
    }
  }

  console.log("\n[8] 一轮都说不出动作时，用尽轮数并说明");
  {
    const model = await fakeModel(["我觉得不用改了。"]);
    try {
      const out = await runReportAgent({
        runtime: model.runtime,
        payload: p,
        seed: { system: "s", task: "t" },
        maxTurns: 2,
      });
      check("没有产出可用页面", !out.validation.ok);
      check("说明了模型没有产出页面", out.validation.issues.some((i) => i.kind === "no-output"));
      check("第二轮提示了协议", JSON.stringify(model.calls[1]?.messages ?? []).includes("vl:write"));
    } finally {
      await model.close();
    }
  }

  console.log("\n[9] shouldStop 能在轮次之间中止");
  {
    const model = await fakeModel([goodPage("会被中止")]);
    try {
      let stopped = false;
      await runReportAgent({
        runtime: model.runtime,
        payload: p,
        seed: { system: "s", task: "t" },
        shouldStop: async () => "任务已被取消",
      }).catch((e: unknown) => {
        stopped = e instanceof Error && e.message.includes("任务已被取消");
      });
      check("循环被中止", stopped);
      check("一次模型调用都没发生", model.calls.length === 0, `calls=${model.calls.length}`);
    } finally {
      await model.close();
    }
  }

  console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
