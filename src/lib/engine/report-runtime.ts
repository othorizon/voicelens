import type { GlobalAnalysis, JsonObject } from "@/lib/types";
import type { GroundTruth } from "./ground-truth";
import type { DataProfile } from "./report-profile";

/**
 * The one thing the platform still writes by hand: how a generated report page
 * gets its data.
 *
 * The model designs everything visible — markup, styling, charts, interaction.
 * It never receives the data itself, and it never writes a number into the
 * page. It calls `VL`, which the platform injects ahead of any generated code.
 * Two reasons this line is not negotiable: re-emitting the dataset as literals
 * would dwarf the page it is embedded in, and a model that retypes numbers
 * mistypes them.
 *
 * Overview data is inlined and read synchronously, so the report renders on
 * first paint with no async plumbing for the model to get wrong. Only
 * drill-down — one user, one session, one audio clip — crosses to the host,
 * because transcripts for 80k sessions can never be inlined.
 */

/* ------------------------------------------------------------------ payload */

export interface ReportUserRow {
  user_key: string;
  persona: string;
  summary: string;
  session_count: number;
  risk_level: string;
  tags: string[];
  metrics: { key: string; label: string; value: number; unit?: string }[];
}

export interface ReportSessionRow {
  session_key: string;
  user_key: string;
  started_at: string | null;
  turn_count: number;
  summary: string;
  intent: string;
  outcome: string;
  sentiment: string;
  quality_score: number | null;
  risk_level: string;
  tags: string[];
}

export interface ReportPayload {
  meta: {
    title: string;
    scopeNote: string;
    generatedAt: string;
    taskName: string;
    templateVersion: number | null;
    language: string;
    tone: string;
    includeEvidence: boolean;
    audio?: JsonObject;
    models?: JsonObject;
  };
  profile: DataProfile;
  groundTruth: GroundTruth | null;
  global: GlobalAnalysis | JsonObject;
  stats: JsonObject;
  distributions: { key: string; label: string; unit?: string; items: { name: string; value: number }[] }[];
  evidence: { session_key: string; user_key: string; problems: string[]; highlights: string[]; quotes: string[] }[];
  /** First page, inlined so a user list renders without waiting. */
  users: { rows: ReportUserRow[]; total: number };
  sessions: { rows: ReportSessionRow[]; total: number };
}

/* ---------------------------------------------------------------------- CSP */

const CDN = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";

/**
 * Libraries from the public CDNs are allowed — the point of generating the
 * page is that the model can reach for whatever visualisation the data calls
 * for. `connect-src 'none'` is what makes that safe: transcripts are user
 * speech and therefore an injection surface, so the page may pull code in but
 * can never send anything out. Remote images are blocked for the same reason
 * (an <img> src is an exfiltration channel); charts are drawn, not fetched.
 */
export const REPORT_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDN}`,
  `style-src 'unsafe-inline' ${CDN} https://fonts.googleapis.com`,
  `font-src data: ${CDN} https://fonts.gstatic.com`,
  "img-src data: blob:",
  "media-src blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Sandbox tokens for the host's <iframe>. `allow-same-origin` is never one. */
export const REPORT_SANDBOX = "allow-scripts allow-popups allow-modals";

/* ------------------------------------------------------------- runtime code */

export const VL_RUNTIME_JS = String.raw`
(function () {
  var P = window.__VL_PAYLOAD__ || {};
  var SNAP = window.__VL_SNAPSHOT__ || null;
  var seq = 0, pending = {};

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__vl !== 'res') return;
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    if (d.error) p.reject(new Error(d.error)); else p.resolve(d.data);
  });

  /* A report whose data travels with it — a preview, or an exported file —
     answers the same calls locally. Filtering and sorting are reimplemented
     rather than ignored: a search box that works in the preview and quietly
     does nothing in the real report is worse than no preview at all. */
  function fromSnapshot(method, a) {
    a = a || {};
    var asc = String(a.order).toLowerCase() === 'asc';

    function match(row, fields) {
      if (!a.q) return true;
      var q = String(a.q).toLowerCase();
      for (var i = 0; i < fields.length; i++) {
        if (String(row[fields[i]] == null ? '' : row[fields[i]]).toLowerCase().indexOf(q) !== -1) return true;
      }
      return false;
    }
    function sort(rows, key, fallback) {
      var k = key || fallback;
      return rows.slice().sort(function (x, y) {
        var a1 = x[k], b1 = y[k];
        if (typeof a1 === 'number' && typeof b1 === 'number') return asc ? a1 - b1 : b1 - a1;
        a1 = String(a1 == null ? '' : a1); b1 = String(b1 == null ? '' : b1);
        return asc ? (a1 < b1 ? -1 : a1 > b1 ? 1 : 0) : (a1 > b1 ? -1 : a1 < b1 ? 1 : 0);
      });
    }
    function page(rows) {
      var size = Math.min(200, Math.max(1, a.size || 50));
      var p = Math.max(1, a.page || 1);
      return { rows: rows.slice((p - 1) * size, (p - 1) * size + size), total: rows.length, page: p, size: size };
    }

    if (method === 'listUsers') {
      var users = (SNAP.users || []).filter(function (u) { return match(u, ['user_key', 'persona', 'summary']); });
      return page(sort(users, a.sort, 'session_count'));
    }
    if (method === 'listSessions') {
      var rows = (SNAP.sessions || []).filter(function (s) {
        return (!a.userKey || s.user_key === a.userKey) && match(s, ['session_key', 'summary']);
      });
      return page(sort(rows, a.sort, 'session_key'));
    }
    if (method === 'getUser') return (SNAP.users || []).filter(function (u) { return u.user_key === a.userKey; })[0] || null;
    if (method === 'getSession') return (SNAP.sessions || []).filter(function (s) { return s.session_key === a.sessionKey; })[0] || null;
    if (method === 'audioClip') return null;
    throw new Error('VL: 这份报告不支持 ' + method);
  }

  function call(method, args) {
    if (SNAP) { try { return Promise.resolve(fromSnapshot(method, args || {})); } catch (e) { return Promise.reject(e); } }
    if (window.parent === window) return Promise.reject(new Error('VL: 报告未运行在宿主页面中'));
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ __vl: 'req', id: id, method: method, args: args || {} }, '*');
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error('VL: ' + method + ' 请求超时')); }
      }, 30000);
    });
  }

  function report(kind, detail) {
    try { window.parent !== window && window.parent.postMessage({ __vl: kind, detail: String(detail).slice(0, 2000) }, '*'); } catch (e) {}
  }

  var VL = {
    meta: P.meta || {},
    profile: P.profile || {},
    groundTruth: P.groundTruth || null,
    global: P.global || {},
    stats: P.stats || {},
    distributions: P.distributions || [],
    evidence: P.evidence || [],
    users: (P.users && P.users.rows) || [],
    userTotal: (P.users && P.users.total) || 0,
    sessions: (P.sessions && P.sessions.rows) || [],
    sessionTotal: (P.sessions && P.sessions.total) || 0,

    listUsers: function (args) { return call('listUsers', args); },
    getUser: function (userKey) { return call('getUser', { userKey: userKey }); },
    listSessions: function (args) { return call('listSessions', args); },
    getSession: function (sessionKey) { return call('getSession', { sessionKey: sessionKey }); },

    /* Bytes over postMessage, turned into a blob here: the host holds the
       credentials, and media-src never has to be opened up to the internet. */
    audioUrl: function (sessionKey, seqNo) {
      return call('audioClip', { sessionKey: sessionKey, seq: seqNo }).then(function (res) {
        if (!res || !res.bytes) return null;
        return URL.createObjectURL(new Blob([new Uint8Array(res.bytes)], { type: res.mime || 'audio/wav' }));
      });
    },

    escape: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },

    ready: function (fn) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
      else fn();
    },

    /** Marks the page as fully rendered; validation waits for this. */
    done: function () { window.__VL_DONE__ = true; report('done', 'ok'); },
  };

  window.VL = VL;

  /* A thrown error must not leave a blank page: say so on screen, and tell the
     host, which is how the generation loop learns the page is broken. */
  function fail(msg) {
    report('error', msg);
    try {
      var box = document.getElementById('__vl_err__');
      if (!box) {
        box = document.createElement('div');
        box.id = '__vl_err__';
        box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#7f1d1d;color:#fff;font:13px/1.6 ui-monospace,monospace;padding:10px 14px;max-height:40vh;overflow:auto';
        (document.body || document.documentElement).appendChild(box);
      }
      box.appendChild(document.createTextNode('报告脚本出错：' + msg + '\n'));
    } catch (e) {}
  }
  window.addEventListener('error', function (e) { fail((e && e.message) || 'unknown'); });
  window.addEventListener('unhandledrejection', function (e) {
    fail('未处理的 Promise 拒绝：' + ((e && e.reason && e.reason.message) || e.reason || 'unknown'));
  });
})();
`;

/* ----------------------------------------------------------------- assembly */

const HEAD_INJECT = /<head[^>]*>/i;

/**
 * Put the CSP and the runtime ahead of anything the model wrote. The page is
 * handed to the browser through `srcdoc`, which carries no response headers,
 * so the policy has to travel inside the document.
 */
export function composeReportDocument(
  html: string,
  payload: ReportPayload,
  snapshot?: ReportSnapshot | null,
): string {
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP.replace(/"/g, "&quot;")}">`,
    `<script>window.__VL_PAYLOAD__=${serialize(payload)};</script>`,
    ...(snapshot ? [`<script>window.__VL_SNAPSHOT__=${serialize(snapshot)};</script>`] : []),
    `<script>${VL_RUNTIME_JS}</script>`,
  ].join("\n");

  if (HEAD_INJECT.test(html)) return html.replace(HEAD_INJECT, (m) => `${m}\n${head}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>\n${head}\n</head>`);
  return `<!doctype html><html lang="zh-CN"><head>\n${head}\n</head><body>\n${html}\n</body></html>`;
}

/**
 * Detail rows carried by the document itself, for a report small enough not
 * to need a host: `VL`'s async methods then resolve from here.
 */
export interface ReportSnapshot {
  users: JsonObject[];
  sessions: JsonObject[];
}

/** `</script>` inside the JSON would close the tag it lives in. */
function serialize(payload: ReportPayload | ReportSnapshot): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/* ------------------------------------------------------- contract, as prose */

/**
 * The API description handed to the model. It lives beside the implementation
 * on purpose: a contract documented somewhere else drifts from the code and
 * the model is the one who pays.
 */
export const VL_API_DOC = `页面通过全局对象 \`VL\` 取数据。平台会在你的代码之前注入它，你不需要自己实现，也无法修改。

## 同步属性（页面加载即可用，直接读，不要 await）
- \`VL.meta\` —— { title, scopeNote, generatedAt, taskName, templateVersion, language, tone, includeEvidence, audio, models }
- \`VL.groundTruth\` —— 平台用 SQL 直算的权威指标：{ population:{sessions,messages}, metrics:[{key,field,label,value,unit,formula,stat,declared}], distributions:[{key,label,items:[{name,value}]}] }
- \`VL.global\` —— 全局层分析结论：{ summary, findings:[{title,detail,severity,metric}], metrics:[{key,label,value,unit}], distributions:[{key,label,unit,items:[{name,value}]}], recommendations:[{title,detail,priority,impact}] }
- \`VL.stats\` —— 平台从会话层聚合出的统计
- \`VL.distributions\` —— extra 字段的真实分布，已按 Top-N 归约，可直接画图
- \`VL.evidence\` —— 可引用的原文片段 [{session_key,user_key,problems,highlights,quotes}]
- \`VL.profile\` —— 你在下方看到的那份数据画像，页面可用它做自适应（例如按 cardinality 决定图表形态）
- \`VL.users\` / \`VL.userTotal\` —— 用户列表首页（已内联）与总行数
- \`VL.sessions\` / \`VL.sessionTotal\` —— 会话列表首页（已内联）与总行数

## 异步方法（返回 Promise，用于下探）
- \`await VL.listUsers({ page, size, sort, order, q })\` → { rows, total, page, size }；size 上限 200
- \`await VL.getUser(userKey)\` → 用户完整记录，含其 session_keys
- \`await VL.listSessions({ userKey, page, size, sort, order, q })\` → { rows, total, page, size }
- \`await VL.getSession(sessionKey)\` → 会话完整记录，含 transcript 与 evidence
- \`await VL.audioUrl(sessionKey, seq)\` → 可直接喂给 <audio> 的 blob URL，没有音频时返回 null

## 工具
- \`VL.escape(s)\` —— HTML 转义。往 innerHTML 里放任何来自数据的文本前必须调用
- \`VL.ready(fn)\` —— DOM 就绪回调
- \`VL.done()\` —— **首屏渲染完成后必须调用一次**，平台据此判断页面渲染成功

## 硬性规则
1. **页面里不得出现任何来自数据的字面量数字或结论**。所有数值、所有判断都必须从 \`VL.*\` 读出来渲染。写死 "解决率 62%" 一律视为错误。
2. **首屏只用同步属性渲染**，异步方法只用于用户主动触发的下探。不要在首屏 await 任何东西。
3. **不要使用 localStorage / sessionStorage / cookie / fetch / XMLHttpRequest**：页面运行在无源沙箱里，这些要么抛异常，要么被 CSP 拦截。
4. 可以从 cdnjs / jsdelivr / unpkg 引入任意前端库（图表、动画、字体均可）。**不要引用远程图片**，CSP 只允许 data: 和 blob:。
5. 引入外部库时必须处理加载失败：库没加载出来时页面要退化成可读的静态内容，而不是白屏。
6. 渲染完成后调用 \`VL.done()\`。`;
