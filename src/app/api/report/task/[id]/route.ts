import { notFound } from "next/navigation";
import { maybeOne } from "@/lib/db";
import { currentViewer, resolveOwnedRow } from "@/lib/auth/access";
import { REPORT_SANDBOX } from "@/lib/engine/report-runtime";

export const runtime = "nodejs";

/**
 * Host page for a report.
 *
 * The report itself is now written by a model for the data at hand, so it is
 * never served on this origin. It runs in a frame with no origin of its own —
 * no cookies, no access to this app's API — and asks for drill-down data by
 * message. This page holds the session and answers on its behalf, which keeps
 * every query authorized where it always was.
 *
 * The reason for the ceremony is that transcripts are user speech: whatever
 * ends up in a generated page has passed through text that someone outside
 * this system wrote. The frame is what makes that harmless.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentViewer();
  if (!viewer) notFound();
  if (!(await resolveOwnedRow(viewer, "analysis_tasks", id))) notFound();

  const task = await maybeOne<{ id: string; name: string; report_html: string | null }>(
    `select id, name, report_html from analysis_tasks where id = $1`,
    [id],
  );
  if (!task?.report_html) notFound();

  const safeName = (task.name ?? "report").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);

  // A download is the document on its own. Overview data is inlined so it
  // still reads offline; drill-down needs the host and degrades to a message.
  if (new URL(req.url).searchParams.get("download") === "1") {
    return new Response(task.report_html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="voicelens-${safeName}.html"; filename*=UTF-8''${encodeURIComponent(`voicelens-${safeName}.html`)}`,
      },
    });
  }

  return new Response(hostPage(id, task.name ?? "分析报告"), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function hostPage(taskId: string, title: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} · VoiceLens</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d12}
  iframe{border:0;width:100%;height:100%;display:block;background:#fff}
  #boot{position:fixed;inset:0;display:grid;place-items:center;color:#93a0b8;
        font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
  @media (prefers-color-scheme: light){html,body{background:#f6f7fb}}
</style>
</head>
<body>
<div id="boot">正在载入报告…</div>
<script>
(function () {
  var TASK = ${JSON.stringify(taskId)};
  var boot = document.getElementById('boot');
  var frame = null;

  function api(method, args) {
    return fetch('/api/report/task/' + TASK + '/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ method: method, args: args || {} }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j.data;
      });
    });
  }

  /* The frame has no credentials, so audio is fetched here and the bytes are
     handed over; its CSP then only has to allow blob:. */
  function audio(args) {
    return api('audioClip', args).then(function (clip) {
      if (!clip) return null;
      return fetch('/api/audio?path=' + encodeURIComponent(clip.path), { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('音频读取失败'); return r.arrayBuffer(); })
        .then(function (buf) { return { bytes: buf, mime: 'audio/' + (clip.format || 'wav') }; });
    });
  }

  function reply(id, data, error) {
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ __vl: 'res', id: id, data: data, error: error }, '*');
  }

  window.addEventListener('message', function (ev) {
    if (!frame || ev.source !== frame.contentWindow) return;
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.__vl === 'error') { console.warn('[report]', d.detail); return; }
    if (d.__vl !== 'req') return;
    var work = d.method === 'audioClip' ? audio(d.args) : api(d.method, d.args);
    work.then(function (data) { reply(d.id, data, null); },
              function (e) { reply(d.id, null, String((e && e.message) || e)); });
  });

  fetch('/api/report/task/' + TASK + '/page', { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function (doc) {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', ${JSON.stringify(REPORT_SANDBOX)});
      frame.setAttribute('title', ${JSON.stringify(title)});
      frame.srcdoc = doc;
      frame.addEventListener('load', function () { if (boot) boot.remove(); });
      document.body.appendChild(frame);
    })
    .catch(function (e) {
      if (boot) boot.textContent = '报告载入失败：' + ((e && e.message) || e);
    });
})();
</script>
</body>
</html>`;
}
