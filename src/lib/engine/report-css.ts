/** Embedded stylesheet for the generated single-page report. No external deps. */
export const REPORT_CSS = `
:root{
  --paper:#fbfbfd; --surface:#ffffff; --ink:#14161c; --ink-2:#3d4351; --muted:#6b7280;
  --line:#e7e8ee; --line-2:#f0f1f6; --accent:#5b6cff; --accent-soft:#eef0ff;
  --good:#12996b; --warn:#c07a12; --bad:#d6403f; --info:#0f7fa8;
  --r:14px; --maxw:1180px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
  font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased;}
.bg-decor{position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:linear-gradient(to right,rgba(20,22,28,.035) 1px,transparent 1px),linear-gradient(to bottom,rgba(20,22,28,.035) 1px,transparent 1px);
  background-size:34px 34px;mask-image:linear-gradient(to bottom,#000 0,transparent 620px);}
.masthead,.hero,.toc,.main,.foot{position:relative;z-index:1;max-width:var(--maxw);margin:0 auto;padding-left:28px;padding-right:28px}

/* masthead */
.masthead{padding-top:40px;padding-bottom:26px;border-bottom:1px solid var(--line)}
.mast-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:26px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:-.01em;font-size:14px}
.brand em{font-style:normal;font-weight:500;color:var(--muted)}
.brand-mark{width:20px;height:20px;border-radius:6px;background:linear-gradient(135deg,var(--accent),#22b8cf);display:inline-block}
.mast-actions{display:flex;gap:8px}
.ghost-btn{appearance:none;border:1px solid var(--line);background:var(--surface);color:var(--ink-2);
  border-radius:999px;padding:6px 14px;font-size:12.5px;cursor:pointer;text-decoration:none;font-family:inherit}
.ghost-btn:hover{border-color:var(--accent);color:var(--accent)}
.masthead h1{margin:0;font-size:clamp(28px,4.2vw,44px);line-height:1.16;letter-spacing:-.028em;font-weight:700}
.subtitle{margin:14px 0 0;font-size:16px;color:var(--ink-2);max-width:62ch}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--surface);
  border-radius:999px;padding:5px 13px;font-size:12.5px;color:var(--ink-2)}
.chip b{font-weight:600;color:var(--muted);font-size:11.5px;letter-spacing:.02em}

/* hero */
.hero{margin-top:30px;background:linear-gradient(160deg,#12141b 0%,#1b1f2e 58%,#232a44 100%);color:#f4f5fb;
  border-radius:20px;padding:34px 34px 30px;box-shadow:0 24px 60px -28px rgba(20,22,40,.55)}
.hero-tag{display:inline-block;font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:#a9b2ff;border:1px solid rgba(169,178,255,.32);border-radius:999px;padding:4px 11px;margin-bottom:16px}
.hero-hl{margin:0;font-size:clamp(20px,2.6vw,28px);line-height:1.35;letter-spacing:-.02em;font-weight:650}
.hero-sum{margin:14px 0 24px;color:rgba(244,245,251,.74);max-width:78ch;font-size:14.5px}
.hero .kpi-grid{--kpi-cols:4}
.hero .kpi{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.12)}
.hero .kpi-label{color:rgba(244,245,251,.6)}
.hero .kpi-value{color:#fff}
.hero .kpi-hint{color:rgba(244,245,251,.5)}

/* toc */
.toc{display:flex;flex-wrap:wrap;gap:8px;margin-top:26px;padding-bottom:6px}
.toc a{display:inline-flex;align-items:center;gap:7px;text-decoration:none;border:1px solid var(--line);
  background:var(--surface);border-radius:999px;padding:6px 14px;font-size:12.5px;color:var(--ink-2);transition:.15s}
.toc a i{font-style:normal;font-family:ui-monospace,Menlo,monospace;color:var(--accent);font-size:11px}
.toc a:hover{border-color:var(--accent);color:var(--accent)}

/* sections */
.main{padding-top:36px;padding-bottom:20px}
.sec{margin-bottom:44px;scroll-margin-top:20px}
.sec-head{display:flex;gap:16px;align-items:flex-start;margin-bottom:20px}
.sec-no{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--accent);
  background:var(--accent-soft);border-radius:8px;padding:5px 9px;margin-top:4px;letter-spacing:.04em}
.sec-head h2{margin:0;font-size:22px;letter-spacing:-.018em;font-weight:650;line-height:1.3}
.sec-sum{margin:7px 0 0;color:var(--muted);font-size:13.8px;max-width:76ch}
.sec-body{display:grid;gap:18px;grid-template-columns:repeat(12,minmax(0,1fr))}
.sec-body>*{grid-column:span 12}
.sec-body>.kpi-grid{grid-column:span 12}
.sec-body>.chart-block+.chart-block{grid-column:span 6}
@media(max-width:900px){.sec-body>.chart-block+.chart-block{grid-column:span 12}}
.sec-drill{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:16px;padding-top:14px;border-top:1px dashed var(--line)}
.drill-lab{font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-right:4px}
.drill-btn{appearance:none;border:1px solid var(--line);background:var(--surface);border-radius:8px;
  padding:5px 11px;font-size:12.5px;color:var(--ink-2);cursor:pointer;font-family:ui-monospace,Menlo,monospace}
.drill-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.drill-more{font-size:12px;color:var(--muted)}

/* cards */
.card-block{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:20px 22px}
.blk-title{margin:0 0 14px;font-size:14.5px;font-weight:650;letter-spacing:-.01em;color:var(--ink)}
.cap{font-size:12.5px;color:var(--muted);margin-top:10px}
.chart{width:100%}
.chart svg{width:100%;height:auto;display:block}
.chart .grid{stroke:var(--line-2);stroke-width:1}
.chart .axis{stroke:var(--line);stroke-width:1.2}
.chart .ring{fill:none;stroke:var(--line-2);stroke-width:1}
.chart .track{fill:#f2f3f7}
.chart .slice{stroke:#fff;stroke-width:1.5}
.chart .xlab,.chart .ylab{fill:var(--muted);font-size:11px;font-family:ui-monospace,Menlo,monospace}
.chart .xlab-rot{font-size:10.5px}
.chart .vlab{fill:var(--ink-2);font-size:11.5px;font-family:ui-monospace,Menlo,monospace}
.chart .donut-num{fill:var(--ink);font-size:22px;font-weight:700}
.chart .donut-lab{fill:var(--muted);font-size:11px}
.chart .leg{fill:var(--ink-2);font-size:11.5px}
.chart .leg-r{text-anchor:end;font-family:ui-monospace,Menlo,monospace}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px;color:var(--ink-2)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2.5px;margin-right:6px;vertical-align:middle}

/* kpi */
.kpi-grid{display:grid;grid-template-columns:repeat(var(--kpi-cols,4),minmax(0,1fr));gap:12px}
@media(max-width:860px){.kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px 16px;position:relative;overflow:hidden}
.kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
.kpi.tone-good::before{background:var(--good)} .kpi.tone-warn::before{background:var(--warn)}
.kpi.tone-bad::before{background:var(--bad)} .kpi.tone-default::before{background:var(--accent)}
.kpi-label{font-size:12px;color:var(--muted);margin-bottom:7px}
.kpi-value{font-size:26px;font-weight:700;letter-spacing:-.03em;font-family:ui-monospace,Menlo,monospace;line-height:1.1}
.kpi-unit{font-size:13px;font-weight:600;color:var(--muted);margin-left:3px}
.kpi-foot{display:flex;gap:8px;align-items:center;margin-top:7px;min-height:16px}
.kpi-hint{font-size:11.5px;color:var(--muted)}
.delta{font-size:11.5px;font-weight:600} .delta.up{color:var(--good)} .delta.down{color:var(--bad)}

/* callout / lists / tables */
.callout{border-radius:12px;padding:15px 18px;border:1px solid var(--line);background:var(--surface)}
.callout-title{font-size:13.5px;font-weight:650;margin-bottom:6px;display:flex;align-items:center;gap:8px}
.callout-title::before{content:"";width:8px;height:8px;border-radius:99px;background:var(--accent)}
.callout-body{font-size:13.8px;color:var(--ink-2)}
.callout-body p{margin:0 0 6px} .callout-body p:last-child{margin:0}
.tone-warning{background:#fffaf0;border-color:#f5e0b6} .tone-warning .callout-title::before{background:var(--warn)}
.tone-critical{background:#fff5f5;border-color:#f3c9c9} .tone-critical .callout-title::before{background:var(--bad)}
.tone-success{background:#f2fbf7;border-color:#c4e8d8} .tone-success .callout-title::before{background:var(--good)}
.tone-info{background:#f4f9fd;border-color:#cfe4f0} .tone-info .callout-title::before{background:var(--info)}
.plain-ul,.md-ul{margin:0;padding-left:18px;font-size:13.8px;color:var(--ink-2)}
.plain-ul li,.md-ul li{margin-bottom:6px}
.md p{margin:0 0 10px;font-size:13.8px;color:var(--ink-2)} .md p:last-child{margin:0}
.md-h{font-size:14.5px;margin:16px 0 8px;letter-spacing:-.01em}
.md code,.dp code{background:#f3f4f8;border-radius:4px;padding:1px 5px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace}
pre.code{background:#14161c;color:#e8eaf2;border-radius:10px;padding:14px 16px;overflow-x:auto;font-size:12.5px}
pre.code code{background:none;color:inherit;padding:0}
.sep{border:none;border-top:1px solid var(--line);margin:6px 0}
.tbl-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--line)}
.md-table{width:100%;border-collapse:collapse;font-size:13px}
.md-table th{text-align:left;background:#f7f8fb;color:var(--muted);font-weight:600;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.md-table td{padding:9px 12px;border-bottom:1px solid var(--line-2);color:var(--ink-2)}
.md-table tbody tr:last-child td{border-bottom:none}
.md-table tbody tr:hover{background:#fafbff}

/* user drill index */
.drill-search{width:100%;max-width:380px;padding:9px 14px;border:1px solid var(--line);border-radius:10px;
  background:var(--surface);font-size:13.5px;font-family:inherit;color:var(--ink);margin-bottom:16px}
.drill-search:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.user-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:12px}
.user-card{text-align:left;appearance:none;background:var(--surface);border:1px solid var(--line);border-radius:12px;
  padding:14px 15px;cursor:pointer;font-family:inherit;color:inherit;transition:.15s;position:relative;overflow:hidden}
.user-card:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 10px 24px -18px rgba(20,22,40,.5)}
.user-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--line)}
.user-card.rk-med::before{background:var(--warn)} .user-card.rk-high::before{background:var(--bad)} .user-card.rk-low::before{background:#9aa3b2}
.uc-top{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:7px}
.uc-key{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:600;color:var(--ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%}
.uc-n{font-size:11.5px;color:var(--muted);white-space:nowrap}
.uc-persona{font-size:12.8px;color:var(--accent);margin-bottom:6px;font-weight:550}
.uc-sum{font-size:12.3px;color:var(--muted);line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.uc-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}

/* panel */
.drill-mask{position:fixed;inset:0;background:rgba(15,17,24,.42);backdrop-filter:blur(2px);z-index:60}
.drill-panel{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);background:var(--paper);z-index:61;
  display:flex;flex-direction:column;transform:translateX(100%);transition:transform .24s cubic-bezier(.32,.72,.28,1);
  border-left:1px solid var(--line);box-shadow:-24px 0 60px -30px rgba(15,17,24,.4)}
.drill-panel.open{transform:translateX(0)}
.dp{display:flex;flex-direction:column;height:100%}
.dp-head{display:flex;gap:14px;align-items:flex-start;padding:20px 22px;border-bottom:1px solid var(--line);background:var(--surface)}
.dp-head h3{margin:2px 0 0;font-size:17px;letter-spacing:-.015em;word-break:break-all;font-family:ui-monospace,Menlo,monospace}
.dp-eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.dp-sub{font-size:12.8px;color:var(--muted);margin-top:5px}
.dp-close{appearance:none;margin-left:auto;border:1px solid var(--line);background:var(--surface);border-radius:9px;
  width:30px;height:30px;cursor:pointer;color:var(--muted);font-size:14px;flex-shrink:0}
.dp-close:hover{color:var(--ink);border-color:var(--ink)}
.dp-body{flex:1;overflow-y:auto;padding:18px 22px 40px}
.dp-back{appearance:none;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:5px 13px;
  font-size:12.5px;color:var(--ink-2);cursor:pointer;margin-bottom:14px;font-family:inherit}
.dp-back:hover{border-color:var(--accent);color:var(--accent)}
.dp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-bottom:16px}
.dp-stats>div{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 11px;text-align:center}
.dp-stats b{display:block;font-size:16px;font-family:ui-monospace,Menlo,monospace;letter-spacing:-.02em}
.dp-stats span{display:block;font-size:11px;color:var(--muted);margin-top:3px}
.dp-stats .risk-high b{color:var(--bad)} .dp-stats .risk-med b{color:var(--warn)} .dp-stats .risk-low b{color:var(--muted)}
.dp-sum{font-size:13.5px;color:var(--ink-2);background:var(--surface);border:1px solid var(--line);
  border-radius:10px;padding:13px 15px;margin:0 0 16px}
.dp-sec{margin-bottom:18px}
.dp-sec h4{margin:0 0 9px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600}
.dp-ul{margin:0;padding-left:17px;font-size:13.2px;color:var(--ink-2)}
.dp-ul li{margin-bottom:5px}
.dp-ul.good li::marker{color:var(--good)} .dp-ul.bad li::marker{color:var(--bad)}
.dp-chips{display:flex;flex-wrap:wrap;gap:6px}
.dp-chip{font-size:11.8px;background:var(--accent-soft);color:#4150e8;border-radius:999px;padding:3px 10px}
.dp-metrics{display:grid;gap:9px}
.dp-m-h{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;color:var(--ink-2)}
.dp-m-h b{font-family:ui-monospace,Menlo,monospace}
.dp-m-track{height:5px;background:#eef0f5;border-radius:99px;overflow:hidden}
.dp-m-track i{display:block;height:100%;border-radius:99px}
.dp-empty{font-size:12.8px;color:var(--muted);padding:8px 0}
.dp-sessions{display:grid;gap:7px}
.dp-sess{appearance:none;display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto;gap:2px 8px;
  text-align:left;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:9px;
  padding:9px 12px;cursor:pointer;font-family:inherit;color:inherit}
.dp-sess:hover{border-color:var(--accent)}
.dp-sess-key{font-family:ui-monospace,Menlo,monospace;font-size:12.2px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dp-sess-meta{grid-column:1;font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dp-score{grid-row:1/3;align-self:center;font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:700;color:var(--muted)}
.dp-score.sc-good{color:var(--good)} .dp-score.sc-mid{color:var(--accent)}
.dp-score.sc-low{color:var(--warn)} .dp-score.sc-bad{color:var(--bad)}
.dp-ev blockquote{margin:0 0 8px;padding:9px 13px;border-left:3px solid var(--accent);background:var(--surface);
  border-radius:0 9px 9px 0;font-size:12.8px;color:var(--ink-2)}
.dp-ev blockquote span{display:block;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:3px}
.dp-transcript{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;max-height:420px;overflow-y:auto}
.dp-line{display:flex;gap:9px;font-size:12.6px;padding:5px 0;border-bottom:1px dashed var(--line-2)}
.dp-line:last-child{border-bottom:none}
.dp-role{flex-shrink:0;width:88px;color:var(--muted);font-size:11px;padding-top:2px;font-family:ui-monospace,Menlo,monospace}
.dp-line.r-user .dp-text{color:#12355f} .dp-line.r-assistant .dp-text{color:var(--ink-2)}
.dp-text{flex:1;word-break:break-word}

/* footer + print */
.foot{border-top:1px solid var(--line);margin-top:20px;padding-top:20px;padding-bottom:40px;
  font-size:12px;color:var(--muted);display:grid;gap:5px}
@media print{
  .bg-decor,.mast-actions,.toc,.drill-mask,.drill-panel{display:none!important}
  body{background:#fff}
  .hero{background:#12141b!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sec{break-inside:avoid;page-break-inside:avoid}
  .card-block,.kpi,.user-card{break-inside:avoid}
}
@media(max-width:640px){
  .masthead,.hero,.toc,.main,.foot{padding-left:16px;padding-right:16px}
  .hero{padding:24px 20px;border-radius:16px}
  .dp-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
}
`;
