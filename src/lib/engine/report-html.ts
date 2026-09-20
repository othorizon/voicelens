import { describeAudioUsage, type AudioUsage, type ReportSpec, type JsonObject } from "@/lib/types";
import { esc as _esc } from "./report-html-utils";
import { renderBlock, renderKpis, PALETTE } from "./report-charts";
import { REPORT_CSS } from "./report-css";

const esc = _esc;

export interface RenderOptions {
  spec: ReportSpec;
  drill?: DrillData;
  generatedAt?: string;
  backHref?: string;
  scopeNote?: string;
  templateVersion?: number | null;
  taskName?: string;
  standalone?: boolean;
  /** Whether this run actually listened to anything; rendered as a header chip. */
  audio?: AudioUsage;
}

export interface DrillUser {
  user_key: string;
  persona?: string;
  summary?: string;
  session_count?: number;
  risk_level?: string;
  tags?: string[];
  needs?: string[];
  behaviour?: string[];
  metrics?: { key: string; label: string; value: number; unit?: string }[];
  sessions?: string[];
}

export interface DrillSession {
  session_key: string;
  user_key?: string;
  started_at?: string | null;
  turn_count?: number;
  summary?: string;
  intent?: string;
  outcome?: string;
  sentiment?: string;
  quality_score?: number;
  risk_level?: string;
  tags?: string[];
  metrics?: { key: string; label: string; value: number; unit?: string }[];
  highlights?: string[];
  problems?: string[];
  evidence?: { quote: string; role?: string; seq?: number }[];
  transcript?: { role: string; text: string; at?: string | null; extra?: JsonObject }[];
}

export interface DrillData {
  users: DrillUser[];
  sessions: DrillSession[];
}

const fmt = (n: number, unit?: string) => {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const s = abs >= 1e8 ? (n / 1e8).toFixed(2) + "亿" : abs >= 1e4 ? (n / 1e4).toFixed(2) + "万" : abs >= 100 || Number.isInteger(n) ? String(Math.round(n * 100) / 100) : String(Math.round(n * 1000) / 1000);
  return unit ? `${s}${unit}` : s;
};

/** Build the complete single-page HTML report. */
/** Flag the one case that looks fine but is not: switch on, nothing delivered. */
function audioChipClass(u: AudioUsage): string {
  return u.enabled && u.clipsAttached === 0 && u.clipsUnavailable > 0 ? " chip-warn" : "";
}

export function renderReportHtml(opts: RenderOptions): string {
  const { spec, drill, generatedAt = new Date().toISOString(), backHref, scopeNote, templateVersion, taskName, audio } = opts;
  const drillUsers = drill?.users ?? [];
  const hasDrill = drillUsers.length > 0;

  const sections = spec.sections.map((s, i) => {
    const body = (s.blocks ?? []).map((b) => renderBlock(b, { hasDrill, taskId: spec.title })).join("\n");
    const drills = drillLinks(s.drill, drillUsers);
    return `<section class="sec" id="${esc(s.id || `sec-${i + 1}`)}">
  <div class="sec-head">
    <span class="sec-no">${String(i + 1).padStart(2, "0")}</span>
    <div><h2>${esc(s.title)}</h2>${s.summary ? `<p class="sec-sum">${esc(s.summary)}</p>` : ""}</div>
  </div>
  <div class="sec-body">${body || `<div class="cap">本章暂无内容</div>`}</div>
  ${drills}
</section>`;
  }).join("\n");

  const userIndex = hasDrill
    ? `<section class="sec" id="drill-index">
  <div class="sec-head"><span class="sec-no">${String(spec.sections.length + 1).padStart(2, "0")}</span>
  <div><h2>用户下探</h2><p class="sec-sum">按会话数排序的 ${drillUsers.length} 位用户，点击任意用户查看其画像与全部会话明细。</p></div></div>
  <div class="sec-body">
    <input class="drill-search" id="drillSearch" type="search" placeholder="搜索 user_key / 画像 / 标签…" />
    <div class="user-grid" id="userGrid"></div>
  </div>
</section>`
    : "";

  const toc = spec.sections
    .map((s, i) => `<a href="#${esc(s.id || `sec-${i + 1}`)}"><i>${String(i + 1).padStart(2, "0")}</i>${esc(s.title)}</a>`)
    .join("") + (hasDrill ? `<a href="#drill-index"><i>${String(spec.sections.length + 1).padStart(2, "0")}</i>用户下探</a>` : "");

  return `<!doctype html>
<html lang="${spec.sections.length && /[a-z]/i.test(spec.title) ? "zh-CN" : "zh-CN"}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(spec.title)} · VoiceLens</title>
<meta name="generator" content="VoiceLens"/>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="bg-decor" aria-hidden="true"></div>

<header class="masthead">
  <div class="mast-row">
    <div class="brand"><span class="brand-mark"></span>VoiceLens <em>分析报告</em></div>
    <div class="mast-actions">
      ${backHref ? `<a class="ghost-btn" href="${esc(backHref)}">← 返回平台</a>` : ""}
      <button class="ghost-btn" onclick="window.print()">打印 / 导出 PDF</button>
    </div>
  </div>
  <h1>${esc(spec.title)}</h1>
  ${spec.subtitle ? `<p class="subtitle">${esc(spec.subtitle)}</p>` : ""}
  <div class="chips">
    ${(spec.meta ?? []).map((m) => `<span class="chip"><b>${esc(m.label)}</b>${esc(m.value)}</span>`).join("")}
    ${scopeNote ? `<span class="chip"><b>范围</b>${esc(scopeNote)}</span>` : ""}
    ${audio ? `<span class="chip${audioChipClass(audio)}"><b>音频</b>${esc(describeAudioUsage(audio))}</span>` : ""}
    ${templateVersion ? `<span class="chip"><b>模板</b>v${templateVersion}</span>` : ""}
    ${taskName ? `<span class="chip"><b>任务</b>${esc(taskName)}</span>` : ""}
    <span class="chip"><b>生成时间</b>${esc(new Date(generatedAt).toLocaleString("zh-CN", { hour12: false }))}</span>
  </div>
</header>

${spec.hero ? `<section class="hero">
  <div class="hero-tag">核心结论</div>
  <h2 class="hero-hl">${esc(spec.hero.headline)}</h2>
  <p class="hero-sum">${esc(spec.hero.summary)}</p>
  ${spec.hero.kpis ? renderKpis({ kind: "kpis", kpis: spec.hero.kpis }) : ""}
</section>` : ""}

<nav class="toc">${toc}</nav>

<main class="main">
${sections}
${userIndex}
</main>

<footer class="foot">
  <div>本报告由 VoiceLens 三层分析流水线自动生成 · 模型 qwen3.8-omni-flash</div>
  <div>数据口径以报告顶部说明为准；所有数值均来自平台真实统计，未经人工修改。</div>
</footer>

<div class="drill-mask" id="drillMask" hidden></div>
<aside class="drill-panel" id="drillPanel" hidden></aside>

<script type="application/json" id="drillData">${JSON.stringify({ users: drillUsers, sessions: drill?.sessions ?? [] }).replace(/</g, "\\u003c")}</script>
<script>${DRILL_JS}</script>
</body>
</html>`;
}

function drillLinks(drill: ReportSpec["sections"][number]["drill"], users: DrillUser[]) {
  if (!drill) return "";
  const keys = [...(drill.users ?? []), ...(drill.sessions ?? []).map((s) => `session:${s}`)];
  if (!keys.length) return "";
  const valid = keys.filter((k) => k.startsWith("session:") || users.some((u) => u.user_key === k));
  if (!valid.length) return "";
  const shown = valid.slice(0, 12);
  const rest = Math.max(0, valid.length - shown.length);
  return `<div class="sec-drill"><span class="drill-lab">下探</span>${shown
    .map((k) =>
      k.startsWith("session:")
        ? `<button class="drill-btn" data-session="${esc(k.slice(8))}">${esc(k.slice(8))}</button>`
        : `<button class="drill-btn" data-user="${esc(k)}">${esc(k)}</button>`,
    )
    .join("")}${rest > 0 ? `<span class="drill-more">+${rest} 个可下探对象，见「用户下探」章节</span>` : ""}</div>`;
}

const DRILL_JS = `(() => {
const raw = document.getElementById('drillData');
const DATA = raw ? JSON.parse(raw.textContent || '{"users":[],"sessions":[]}') : {users:[],sessions:[]};
const userMap = Object.fromEntries((DATA.users||[]).map(u => [u.user_key, u]));
const secMap = Object.fromEntries((DATA.sessions||[]).map(s => [s.session_key, s]));
const panel = document.getElementById('drillPanel');
const mask = document.getElementById('drillMask');
const e = s => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = (n,u) => { if(!isFinite(n)) return '—'; const a=Math.abs(n);
  const s = a>=1e8?(n/1e8).toFixed(2)+'亿':a>=1e4?(n/1e4).toFixed(2)+'万':a>=100||Number.isInteger(n)?String(Math.round(n*100)/100):String(Math.round(n*1000)/1000);
  return u? s+u : s; };
const PALETTE = ${JSON.stringify(PALETTE)};

function open(html){ panel.innerHTML = html; panel.hidden = false; mask.hidden = false; document.body.style.overflow='hidden'; requestAnimationFrame(()=>panel.classList.add('open')); }
function close(){ panel.classList.remove('open'); mask.hidden = true; document.body.style.overflow=''; setTimeout(()=>{ panel.hidden=true; },220); }
mask.addEventListener('click', close);
document.addEventListener('keydown', ev => { if(ev.key==='Escape' && !panel.hidden) close(); });

function metricBars(metrics, unit){
  if(!metrics || !metrics.length) return '<div class="dp-empty">无指标</div>';
  const max = Math.max(...metrics.map(m => Math.abs(m.value)||0), 1e-9);
  return '<div class="dp-metrics">' + metrics.slice(0,12).map((m,i) => {
    const w = Math.max(2, Math.abs(m.value)/max*100);
    return '<div class="dp-m"><div class="dp-m-h"><span>'+e(m.label||m.key)+'</span><b>'+fmt(m.value, m.unit||unit||'')+'</b></div>'
      + '<div class="dp-m-track"><i style="width:'+w.toFixed(1)+'%;background:'+PALETTE[i%PALETTE.length]+'"></i></div></div>';
  }).join('') + '</div>';
}
function chips(arr){ return (arr||[]).map(t => '<span class="dp-chip">'+e(t)+'</span>').join(''); }
function bullets(arr, cls){ return (arr||[]).length ? '<ul class="'+cls+'">'+arr.map(t=>'<li>'+e(t)+'</li>').join('')+'</ul>' : ''; }

function openUser(key){
  const u = userMap[key]; if(!u) return;
  const secs = (u.sessions||[]).map(k => secMap[k]).filter(Boolean);
  const risks = {'high':'risk-high','medium':'risk-med','low':'risk-low','none':''};
  open('<div class="dp"><header class="dp-head"><div><div class="dp-eyebrow">用户下探 · user_key</div>'
    + '<h3>'+e(u.user_key)+'</h3><div class="dp-sub">'+e(u.persona||'')+'</div></div>'
    + '<button class="dp-close" data-close>✕</button></header>'
    + '<div class="dp-body">'
    + '<div class="dp-stats"><div><b>'+fmt(u.session_count||0)+'</b><span>会话数</span></div>'
    + '<div class="'+(risks[u.risk_level]||'')+'"><b>'+e(u.risk_level||'none')+'</b><span>风险等级</span></div>'
    + '<div><b>'+fmt(secs.length)+'</b><span>可下探会话</span></div></div>'
    + (u.summary ? '<p class="dp-sum">'+e(u.summary)+'</p>' : '')
    + '<div class="dp-sec"><h4>核心诉求</h4>'+bullets(u.needs,'dp-ul')+'</div>'
    + '<div class="dp-sec"><h4>行为模式</h4>'+bullets(u.behaviour,'dp-ul')+'</div>'
    + '<div class="dp-sec"><h4>指标</h4>'+metricBars(u.metrics)+'</div>'
    + (u.tags&&u.tags.length ? '<div class="dp-sec"><h4>标签</h4><div class="dp-chips">'+chips(u.tags)+'</div></div>' : '')
    + '<div class="dp-sec"><h4>会话列表</h4>'
    + (secs.length ? '<div class="dp-sessions">'+secs.map(s => sessionRow(s)).join('')+'</div>' : '<div class="dp-empty">未附带会话明细</div>')
    + '</div></div></div>');
  bind();
}

function sessionRow(s){
  const score = typeof s.quality_score === 'number' ? s.quality_score : null;
  const tone = score==null ? '' : score>=80?'sc-good':score>=60?'sc-mid':score>=40?'sc-low':'sc-bad';
  return '<button class="dp-sess" data-session="'+e(s.session_key)+'">'
    + '<span class="dp-sess-key">'+e(s.session_key)+'</span>'
    + '<span class="dp-sess-meta">'+fmt(s.turn_count||0)+' 轮 · '+e(s.intent||'未标注意图')+' · '+e(s.outcome||'')+'</span>'
    + (score!=null ? '<span class="dp-score '+tone+'">'+score+'</span>' : '')
    + '</button>';
}

function openSession(key){
  const s = secMap[key]; if(!s){ return; }
  const back = s.user_key && userMap[s.user_key] ? '<button class="dp-back" data-user="'+e(s.user_key)+'">← 返回用户 '+e(s.user_key)+'</button>' : '';
  const transcript = (s.transcript||[]).map(t => '<div class="dp-line r-'+e(t.role)+'"><span class="dp-role">'+(t.role==='user'?'用户':'AI')+(t.at?' · '+e(String(t.at).slice(11,19)):'')+'</span><span class="dp-text">'+e(t.text)+'</span></div>').join('');
  const ev = (s.evidence||[]).map(q => '<blockquote><span>'+e(q.role==='user'?'用户':'AI')+'</span>'+e(q.quote)+'</blockquote>').join('');
  open('<div class="dp"><header class="dp-head"><div><div class="dp-eyebrow">会话下探 · session_key</div><h3>'+e(s.session_key)+'</h3>'
    + '<div class="dp-sub">'+fmt(s.turn_count||0)+' 轮 · '+e(s.started_at||'')+'</div></div><button class="dp-close" data-close>✕</button></header>'
    + '<div class="dp-body">'+back
    + '<div class="dp-stats"><div><b>'+fmt(s.quality_score==null?'—':s.quality_score)+'</b><span>质量分</span></div>'
    + '<div><b>'+e(s.outcome||'unknown')+'</b><span>结果</span></div>'
    + '<div><b>'+e(s.sentiment||'neutral')+'</b><span>情绪</span></div>'
    + '<div class="risk-'+(s.risk_level==='high'?'high':s.risk_level==='medium'?'med':'low')+'"><b>'+e(s.risk_level||'none')+'</b><span>风险</span></div></div>'
    + (s.summary?'<p class="dp-sum">'+e(s.summary)+'</p>':'')
    + '<div class="dp-sec"><h4>指标</h4>'+metricBars(s.metrics)+'</div>'
    + ((s.highlights||[]).length?'<div class="dp-sec"><h4>做得好</h4>'+bullets(s.highlights,'dp-ul good')+'</div>':'')
    + ((s.problems||[]).length?'<div class="dp-sec"><h4>问题</h4>'+bullets(s.problems,'dp-ul bad')+'</div>':'')
    + ((s.tags||[]).length?'<div class="dp-sec"><h4>标签</h4><div class="dp-chips">'+chips(s.tags)+'</div></div>':'')
    + (ev?'<div class="dp-sec"><h4>原文证据</h4><div class="dp-ev">'+ev+'</div></div>':'')
    + (transcript?'<div class="dp-sec"><h4>完整转录</h4><div class="dp-transcript">'+transcript+'</div></div>':'')
    + '</div></div>');
  bind();
}

function bind(){
  panel.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  panel.querySelectorAll('[data-user]').forEach(b => b.addEventListener('click', () => openUser(b.getAttribute('data-user'))));
  panel.querySelectorAll('[data-session]').forEach(b => b.addEventListener('click', () => openSession(b.getAttribute('data-session'))));
}

document.addEventListener('click', ev => {
  const t = ev.target.closest('[data-user],[data-session]');
  if(!t || panel.contains(t)) return;
  if(t.hasAttribute('data-user')) openUser(t.getAttribute('data-user'));
  else openSession(t.getAttribute('data-session'));
});

const grid = document.getElementById('userGrid');
const search = document.getElementById('drillSearch');
function renderGrid(q){
  const term = (q||'').trim().toLowerCase();
  const list = DATA.users.filter(u => !term || [u.user_key,u.persona,u.summary,(u.tags||[]).join(' ')].join(' ').toLowerCase().includes(term));
  if(!grid) return;
  grid.innerHTML = list.length ? list.map(u => {
    const risk = u.risk_level==='high'?'rk-high':u.risk_level==='medium'?'rk-med':u.risk_level==='low'?'rk-low':'';
    return '<button class="user-card '+risk+'" data-user="'+e(u.user_key)+'">'
      + '<div class="uc-top"><span class="uc-key">'+e(u.user_key)+'</span><span class="uc-n">'+fmt(u.session_count||0)+' 会话</span></div>'
      + '<div class="uc-persona">'+e(u.persona||'')+'</div>'
      + '<div class="uc-sum">'+e(u.summary||'')+'</div>'
      + '<div class="uc-tags">'+chips((u.tags||[]).slice(0,4))+'</div></button>';
  }).join('') : '<div class="dp-empty">没有匹配的用户</div>';
  grid.querySelectorAll('[data-user]').forEach(b => b.addEventListener('click', () => openUser(b.getAttribute('data-user'))));
}
if(grid) renderGrid('');
if(search) search.addEventListener('input', () => renderGrid(search.value));
})();`;

