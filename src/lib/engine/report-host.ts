import { REPORT_SANDBOX } from "./report-runtime";

/**
 * The page that holds a report.
 *
 * A generated report is written by a model against text that users spoke, so
 * it never runs on this origin. It goes into a frame with no origin of its
 * own — no cookies, no reach into this app's API — and asks for anything it
 * could not be given up front by message. This page has the session and
 * answers on its behalf, which leaves every query authorized where it always
 * was.
 *
 * Reports whose data is small enough to travel with them, such as a preview
 * over a dozen sessions, carry it inline and never ask. They get the same
 * host anyway: one frame, one set of rules, and a preview that behaves like
 * the run it is previewing.
 */
export interface HostPageOptions {
  title: string;
  /** Same-origin URL returning the report document as text. */
  docUrl: string;
  /** Drill-down endpoint. Omitted for reports that carry their own data. */
  dataUrl?: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderHostPage(opts: HostPageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(opts.title)} · VoiceLens</title>
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
  var DOC = ${JSON.stringify(opts.docUrl)};
  var DATA = ${JSON.stringify(opts.dataUrl ?? null)};
  var boot = document.getElementById('boot');
  var frame = null;

  function api(method, args) {
    if (!DATA) return Promise.reject(new Error('这份报告不支持按需取数'));
    return fetch(DATA, {
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

  fetch(DOC, { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function (doc) {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', ${JSON.stringify(REPORT_SANDBOX)});
      frame.setAttribute('title', ${JSON.stringify(opts.title)});
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
