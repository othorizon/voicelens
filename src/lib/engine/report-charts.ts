/**
 * ReportSpec -> self-contained, dependency-free single-page HTML.
 * Charts are hand-rendered SVG so the artifact works offline; drill-down data
 * is embedded as JSON and rendered client-side by a small vanilla renderer.
 */
import type { ReportBlock, ReportSpec, JsonObject } from "@/lib/types";

export const PALETTE = [
  "#5b6cff", "#22b8cf", "#37c281", "#f5a524", "#ef5b5b",
  "#9b6cff", "#0ea5e9", "#14b8a6", "#f472b6", "#84cc16",
];

export interface DrillPayload {
  users: Record<string, JsonObject>;
  sessions: Record<string, JsonObject>;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const fmtNum = (n: number, unit?: string): string => {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  let s: string;
  if (abs >= 1e8) s = (n / 1e8).toFixed(2) + "亿";
  else if (abs >= 1e4) s = (n / 1e4).toFixed(2) + "万";
  else if (abs >= 100 || Number.isInteger(n)) s = String(Math.round(n * 100) / 100);
  else s = String(Math.round(n * 1000) / 1000);
  return unit ? `${s}${unit}` : s;
};

/* ---------------------------------------------------------------- charts */

type LabelStrategy = "flat" | "rotate";

/** Decide per chart: short labels wrap, long ones rotate instead of breaking mid-word. */
function labelStrategy(cats: string[]): LabelStrategy {
  const hasCjk = cats.some((c) => /[\u4e00-\u9fa5]/.test(c));
  const limit = hasCjk ? 6 : 9;
  const longest = Math.max(0, ...cats.map((c) => [...String(c ?? "")].length));
  return longest > limit ? "rotate" : "flat";
}

function padBottomFor(strategy: LabelStrategy): number {
  return strategy === "rotate" ? 104 : 60;
}

/** Break only at separators — never inside a word. */
function softWrap(text: string, max: number): [string, string?] {
  const t = String(text ?? "").trim();
  if ([...t].length <= max) return [t];
  const parts = t.split(/(?<=[\s_\-/，,、])|(?=[\s_\-/，,、])/).filter((x) => x.length);
  if (parts.length >= 2) {
    const mid = Math.ceil(parts.length / 2);
    const a = parts.slice(0, mid).join("").trim();
    const b = parts.slice(mid).join("").trim();
    if (a && b) return [clip(a, max + 3), clip(b, max + 3)];
  }
  return [clip(t, max + 4)];
}

function xAxisLabels(x: number, y: number, text: string, strategy: LabelStrategy) {
  if (strategy === "rotate") {
    return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" class="xlab xlab-rot" text-anchor="end" transform="rotate(-35 ${x.toFixed(1)} ${(y + 4).toFixed(1)})">${esc(clip(String(text), 24))}</text>`;
  }
  const [l1, l2] = softWrap(text, 8);
  let out = `<text x="${x.toFixed(1)}" y="${y}" class="xlab" text-anchor="middle">${esc(l1)}</text>`;
  if (l2) out += `<text x="${x.toFixed(1)}" y="${y + 14}" class="xlab" text-anchor="middle">${esc(l2)}</text>`;
  return out;
}

interface Axes {
  max: number;
  ticks: number[];
}

function niceAxes(values: number[]): Axes {
  const max = Math.max(0, ...values.map((v) => (Number.isFinite(v) ? v : 0)));
  if (max <= 0) return { max: 1, ticks: [0, 0.5, 1] };
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / exp;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * exp;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, ticks };
}

function gridAndYLabels(axes: Axes, x0: number, x1: number, y0: number, y1: number, horizontal = true) {
  const parts: string[] = [];
  for (const t of axes.ticks) {
    const y = y1 - ((t / (axes.max || 1)) * (y1 - y0));
    parts.push(
      `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" class="grid"/>`,
    );
    parts.push(
      `<text x="${x0 - 8}" y="${(y + 3.5).toFixed(1)}" class="ylab" text-anchor="end">${esc(fmtNum(t))}</text>`,
    );
  }
  if (!horizontal) parts.push("");
  return parts.join("");
}

export function svgBar(block: ReportBlock): string {
  const cats = block.categories ?? [];
  const series = block.series ?? [];
  if (!cats.length || !series.length) return empty();
  const strategy = labelStrategy(cats);
  const W = 720, padL = 52, padR = 16, padT = 22, padB = padBottomFor(strategy);
  const H = 300 + (padB - 56);
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  const axes = niceAxes(series.flatMap((s) => s.data));
  const groupW = (x1 - x0) / cats.length;
  const barW = Math.max(3, Math.min(34, (groupW * 0.68) / series.length));
  let out = gridAndYLabels(axes, x0, x1, y0, y1);

  cats.forEach((c, i) => {
    const cx = x0 + groupW * i + groupW / 2;
    series.forEach((s, si) => {
      const v = s.data[i] ?? 0;
      const h = Math.max(0, (v / (axes.max || 1)) * (y1 - y0));
      const bx = cx - (series.length * barW + (series.length - 1) * 3) / 2 + si * (barW + 3);
      out += `<rect x="${bx.toFixed(1)}" y="${(y1 - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${PALETTE[si % PALETTE.length]}"><title>${esc(c)} · ${esc(s.name)} = ${esc(fmtNum(v, block.unit))}</title></rect>`;
    });
    out += xAxisLabels(cx, y1 + 18, c, strategy);
  });

  out += `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" class="axis"/>`;
  return svgWrap(W, H, out, legend(series, padL, 12));
}

export function svgHBar(block: ReportBlock): string {
  const cats = block.categories ?? [];
  const series = block.series ?? [];
  const data = (series[0]?.data ?? []).map((v, i) => ({ name: cats[i] ?? `#${i + 1}`, value: v }));
  if (!data.length) return empty();
  const rowH = 26, padL = Math.min(214, Math.max(70, ...data.map((d) => d.name.length * 7.2 + 24)));
  const rows = data.slice(0, 18);
  const W = 720, H = rows.length * rowH + 30, x0 = padL, x1 = W - 90, y0 = 14;
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  let out = "";
  rows.forEach((r, i) => {
    const y = y0 + i * rowH;
    const w = Math.max(0, (r.value / max) * (x1 - x0));
    const c = PALETTE[i % PALETTE.length];
    out += `<text x="${x0 - 10}" y="${y + 16}" class="xlab" text-anchor="end">${esc(clip(r.name, 22))}</text>`;
    out += `<rect x="${x0}" y="${y + 4}" width="${(x1 - x0).toFixed(1)}" height="14" rx="7" class="track"/>`;
    out += `<rect x="${x0}" y="${y + 4}" width="${w.toFixed(1)}" height="14" rx="7" fill="${c}"><title>${esc(r.name)} = ${esc(fmtNum(r.value, block.unit))}</title></rect>`;
    out += `<text x="${(x1 + 10).toFixed(1)}" y="${y + 16}" class="vlab">${esc(fmtNum(r.value, block.unit))}</text>`;
  });
  return svgWrap(W, H, out);
}

export function svgLine(block: ReportBlock): string {
  const cats = block.categories ?? [];
  const series = block.series ?? [];
  if (!cats.length || !series.length) return empty();
  const strategy = labelStrategy(cats);
  const W = 720, padL = 52, padR = 18, padT = 22, padB = padBottomFor(strategy);
  const H = 300 + (padB - 58);
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  const axes = niceAxes(series.flatMap((s) => s.data));
  let out = gridAndYLabels(axes, x0, x1, y0, y1);
  const stepX = cats.length > 1 ? (x1 - x0) / (cats.length - 1) : 0;

  series.forEach((s, si) => {
    const color = PALETTE[si % PALETTE.length];
    const pts = s.data.map((v, i) => [x0 + stepX * i, y1 - ((v ?? 0) / (axes.max || 1)) * (y1 - y0)] as const);
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const area = `${d} L${pts[pts.length - 1]?.[0].toFixed(1)},${y1} L${pts[0]?.[0].toFixed(1)},${y1} Z`;
    if (series.length === 1 && pts.length > 1) {
      out += `<path d="${area}" fill="${color}" opacity="0.11"/>`;
    }
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (pts.length <= 40) {
      pts.forEach((p, i) => {
        out += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.8" fill="${color}"><title>${esc(cats[i])} · ${esc(s.name)} = ${esc(fmtNum(s.data[i], block.unit))}</title></circle>`;
      });
    }
  });

  const labEvery = Math.max(1, Math.ceil(cats.length / 9));
  cats.forEach((c, i) => {
    if (i % labEvery !== 0 && i !== cats.length - 1) return;
    const x = x0 + stepX * i;
    out += xAxisLabels(x, y1 + 18, c, strategy);
  });
  out += `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" class="axis"/>`;
  return svgWrap(W, H, out, legend(series, padL, 12));
}

export function svgPie(block: ReportBlock): string {
  const cats = block.categories ?? [];
  const data = (block.series?.[0]?.data ?? []).map((v, i) => ({ name: cats[i] ?? `#${i + 1}`, value: v }));
  const filtered = data.filter((d) => d.value > 0);
  if (!filtered.length) return empty();
  const W = 720, H = 300, cx = 150, cy = 150, R = 104, r = 60;
  const total = filtered.reduce((s, d) => s + d.value, 0) || 1;
  let angle = -Math.PI / 2;
  let out = "";

  filtered.slice(0, 10).forEach((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const a0 = angle, a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`;
    const path = sweep >= Math.PI * 2 - 1e-6
      ? `M${cx - R},${cy} A${R},${R} 0 1 1 ${cx + R},${cy} A${R},${R} 0 1 1 ${cx - R},${cy} Z M${cx - r},${cy} A${r},${r} 0 1 0 ${cx + r},${cy} A${r},${r} 0 1 0 ${cx - r},${cy} Z`
      : `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
    out += `<path d="${path}" fill="${PALETTE[i % PALETTE.length]}" class="slice"><title>${esc(d.name)} = ${esc(fmtNum(d.value, block.unit))}（${((d.value / total) * 100).toFixed(1)}%）</title></path>`;
  });

  out += `<text x="${cx}" y="${cy - 4}" class="donut-num" text-anchor="middle">${esc(fmtNum(total, block.unit))}</text>`;
  out += `<text x="${cx}" y="${cy + 16}" class="donut-lab" text-anchor="middle">合计</text>`;

  const items = filtered.slice(0, 10);
  const lx = 300;
  items.forEach((d, i) => {
    const y = 46 + i * 24;
    out += `<rect x="${lx}" y="${y - 9}" width="10" height="10" rx="2.5" fill="${PALETTE[i % PALETTE.length]}"/>`;
    out += `<text x="${lx + 18}" y="${y}" class="leg">${esc(clip(d.name, 20))}</text>`;
    out += `<text x="${W - 20}" y="${y}" class="leg leg-r">${esc(fmtNum(d.value, block.unit))} · ${((d.value / total) * 100).toFixed(1)}%</text>`;
  });
  return svgWrap(W, H, out);
}

export function svgRadar(block: ReportBlock): string {
  const cats = block.categories ?? [];
  const series = block.series ?? [];
  if (cats.length < 3 || !series.length) return empty();
  const W = 720, H = 320, cx = 210, cy = 165, R = 120;
  const axes = niceAxes(series.flatMap((s) => s.data));
  let out = "";
  for (let ring = 1; ring <= 4; ring++) {
    const rr = (R * ring) / 4;
    const pts = cats
      .map((_, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / cats.length;
        return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
      })
      .join(" ");
    out += `<polygon points="${pts}" class="ring"/>`;
  }
  cats.forEach((c, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / cats.length;
    out += `<line x1="${cx}" y1="${cy}" x2="${(cx + R * Math.cos(a)).toFixed(1)}" y2="${(cy + R * Math.sin(a)).toFixed(1)}" class="grid"/>`;
    const lx = cx + (R + 20) * Math.cos(a), ly = cy + (R + 20) * Math.sin(a);
    const anchor = Math.abs(lx - cx) < 8 ? "middle" : lx > cx ? "start" : "end";
    const [rl1, rl2] = softWrap(c, 7);
    out += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" class="xlab" text-anchor="${anchor}">${esc(rl1)}</text>`;
    if (rl2) out += `<text x="${lx.toFixed(1)}" y="${(ly + 18).toFixed(1)}" class="xlab" text-anchor="${anchor}">${esc(rl2)}</text>`;
  });
  series.forEach((s, si) => {
    const color = PALETTE[si % PALETTE.length];
    const pts = cats.map((_, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / cats.length;
      const rr = (Math.min(Math.max(s.data[i] ?? 0, 0), axes.max) / (axes.max || 1)) * R;
      return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
    });
    out += `<polygon points="${pts.join(" ")}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2"/>`;
  });
  return svgWrap(W, H, out, legend(series, 420, 60));
}

export function svgScatter(block: ReportBlock): string {
  const cats = block.categories ?? [];
  const ys = block.series?.[0]?.data ?? [];
  if (!cats.length || !ys.length) return empty();
  const strategy = labelStrategy(cats);
  const W = 720, padL = 52, padR = 20, padT = 22, padB = padBottomFor(strategy);
  const H = 300 + (padB - 56);
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  const axes = niceAxes(ys);
  let out = gridAndYLabels(axes, x0, x1, y0, y1);
  const stepX = cats.length > 1 ? (x1 - x0) / (cats.length - 1) : 0;
  ys.forEach((v, i) => {
    const x = x0 + stepX * i;
    const y = y1 - ((v ?? 0) / (axes.max || 1)) * (y1 - y0);
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${PALETTE[0]}" fill-opacity="0.72"><title>${esc(cats[i])} = ${esc(fmtNum(v, block.unit))}</title></circle>`;
  });
  const labEvery = Math.max(1, Math.ceil(cats.length / 8));
  cats.forEach((c, i) => {
    if (i % labEvery !== 0) return;
    out += xAxisLabels(x0 + stepX * i, y1 + 18, c, strategy);
  });
  out += `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" class="axis"/>`;
  return svgWrap(W, H, out, block.caption ? `<div class="cap">${esc(block.caption)}</div>` : "");
}

function legend(series: { name: string }[], x: number, _y: number) {
  if (series.length < 2) return "";
  return `<div class="legend" style="padding-left:${Math.max(0, x - 40)}px">` +
    series
      .map((s, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(s.name)}</span>`)
      .join("") +
    `</div>`;
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function empty() {
  return `<div class="cap">该图表没有可用数据</div>`;
}

function svgWrap(w: number, h: number, inner: string, extra = "") {
  return `<div class="chart"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">${inner}</svg>${extra}</div>`;
}

/* --------------------------------------------------------------- markdown */

export function mdToHtml(md: string): string {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false, inTable = false, inCode = false;

  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  const closeTable = () => { if (inTable) { out.push("</tbody></table>"); inTable = false; } };

  const inline = (t: string) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("```")) {
      if (inCode) { out.push("</code></pre>"); inCode = false; }
      else { closeList(); closeTable(); out.push('<pre class="code"><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(raw) + "\n"); continue; }

    if (!line.trim()) { closeList(); closeTable(); continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); closeTable(); out.push(`<h${Math.min(6, h[1].length + 2)} class="md-h">${inline(h[2])}</h${Math.min(6, h[1].length + 2)}>`); continue; }

    if (line.split("|").filter((c) => c.trim()).length >= 2 && !/^\s*[-:|\s]+$/.test(line)) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (!inTable) {
        closeList();
        out.push('<div class="tbl-wrap"><table class="md-table"><thead><tr>');
        for (const c of cells) out.push(`<th>${inline(c)}</th>`);
        out.push("</tr></thead><tbody>");
        inTable = true;
      } else {
        out.push("<tr>");
        for (const c of cells) out.push(`<td>${inline(c)}</td>`);
        out.push("</tr>");
      }
      continue;
    }
    if (/^\s*[-:|\s]+$/.test(line) && inTable) continue;

    const bullets = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullets) {
      closeTable();
      if (!inList) { out.push('<ul class="md-ul">'); inList = true; }
      out.push(`<li>${inline(bullets[1])}</li>`);
      continue;
    }
    closeList(); closeTable();
    out.push(`<p class="md-p">${inline(line)}</p>`);
  }
  closeList(); closeTable();
  if (inCode) out.push("</code></pre>");
  return out.join("");
}

/* ----------------------------------------------------------------- blocks */

export function renderBlock(block: ReportBlock, ctx: { hasDrill: boolean; taskId?: string }): string {
  switch (block.kind) {
    case "kpis":
      return renderKpis(block);
    case "bar":
      return chartFrame(block, svgBar(block));
    case "hbar":
      return chartFrame(block, svgHBar(block));
    case "line":
      return chartFrame(block, svgLine(block));
    case "pie":
      return chartFrame(block, svgPie(block));
    case "radar":
      return chartFrame(block, svgRadar(block));
    case "scatter":
      return chartFrame(block, svgScatter(block));
    case "table":
      return renderTable(block);
    case "callout":
      return `<aside class="callout tone-${esc(block.tone ?? "info")}"><div class="callout-title">${esc(block.title ?? "提示")}</div><div class="callout-body">${mdToHtml(block.text ?? "")}</div></aside>`;
    case "list":
      return `<div class="card-block">${block.title ? `<h4 class="blk-title">${esc(block.title)}</h4>` : ""}<ul class="plain-ul">${(block.items ?? []).map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`;
    case "divider":
      return `<hr class="sep"/>`;
    case "markdown":
      return `<div class="card-block">${block.title ? `<h4 class="blk-title">${esc(block.title)}</h4>` : ""}<div class="md">${mdToHtml(block.text ?? "")}</div></div>`;
    default: {
      // Specs written before block-kind coercion may still carry an unknown kind.
      // Render whatever payload is there instead of dropping the analysis.
      const b = block as unknown as Record<string, unknown>;
      const items = Array.isArray(b.items) ? (b.items as unknown[]).map(String) : [];
      const quotes = Array.isArray(b.quotes)
        ? (b.quotes as Record<string, unknown>[]).map((q) => String(q.quote ?? q.text ?? q))
        : [];
      const body = String(b.text ?? "") || (items.length ? `- ${items.join("\n- ")}` : "") || (quotes.length ? quotes.map((q) => `> ${q}`).join("\n\n") : "");
      if (!body && !b.table && !b.categories) return "";
      return `<div class="card-block">${block.title ? `<h4 class="blk-title">${esc(block.title)}</h4>` : ""}<div class="md">${mdToHtml(body || "（内容见原文）")}</div></div>`;
    }
  }
}

function chartFrame(block: ReportBlock, svg: string) {
  return `<figure class="card-block chart-block">${block.title ? `<h4 class="blk-title">${esc(block.title)}</h4>` : ""}${svg}${block.caption ? `<figcaption class="cap">${esc(block.caption)}</figcaption>` : ""}</figure>`;
}

export function renderKpis(block: ReportBlock): string {
  const kpis = block.kpis ?? [];
  if (!kpis.length) return "";
  const n = kpis.length;
  const cols = n >= 5 ? 5 : n;
  return `<div class="kpi-grid" style="--kpi-cols:${cols}">` +
    kpis
      .map((k) => {
        const delta =
          typeof k.delta === "number"
            ? `<span class="delta ${k.delta >= 0 ? "up" : "down"}">${k.delta >= 0 ? "▲" : "▼"} ${Math.abs(k.delta).toFixed(1)}%</span>`
            : "";
        return `<div class="kpi tone-${esc(k.tone ?? "default")}">
  <div class="kpi-label">${esc(k.label)}</div>
  <div class="kpi-value">${esc(typeof k.value === "number" ? fmtNum(k.value) : k.value)}${k.unit ? `<span class="kpi-unit">${esc(k.unit)}</span>` : ""}</div>
  <div class="kpi-foot">${delta}${k.hint ? `<span class="kpi-hint">${esc(k.hint)}</span>` : ""}</div>
</div>`;
      })
      .join("") +
    "</div>";
}

function renderTable(block: ReportBlock): string {
  const t = block.table;
  if (!t?.columns?.length) return "";
  return `<div class="card-block">
  ${block.title ? `<h4 class="blk-title">${esc(block.title)}</h4>` : ""}
  <div class="tbl-wrap"><table class="md-table"><thead><tr>${t.columns
    .map((c) => `<th>${esc(c)}</th>`)
    .join("")}</tr></thead><tbody>${t.rows
    .slice(0, 60)
    .map((r) => `<tr>${r.map((c) => `<td>${esc(typeof c === "number" ? fmtNum(c) : c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>
</div>`;
}
