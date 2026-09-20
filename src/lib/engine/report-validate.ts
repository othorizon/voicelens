import type { Browser } from "playwright";

/**
 * A generated report is not accepted because it parsed — it is accepted
 * because it rendered. The page is loaded in a real browser with the same
 * policy it will run under, and what comes back here is what the generation
 * loop feeds to the model on the next attempt.
 *
 * Two failures are deliberately told apart. A page that throws is broken and
 * must be regenerated. A page whose CDN library did not load is not: the
 * contract requires generated pages to degrade to readable static content, so
 * an unreachable CDN is a warning as long as the page still rendered. Build
 * machines without egress would otherwise reject every page that reaches for
 * a chart library.
 */

export interface ValidationIssue {
  level: "error" | "warn";
  kind: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  stats: {
    textChars: number;
    domNodes: number;
    scrollHeight: number;
    overflowPx: number;
    durationMs: number;
  };
  /** PNG of the desktop viewport, for the human looking at the preview. */
  screenshot?: Buffer;
}

const CDN_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

const isCdn = (url: string) => CDN_HOSTS.some((h) => url.includes(h));

/* ------------------------------------------------------------------ static */

/**
 * Cheap checks worth running before paying for a browser. Only rules whose
 * violation is unambiguous — anything heuristic belongs in the runtime pass,
 * where the page either works or does not.
 */
export function staticChecks(doc: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const body = doc.replace(/<!--[\s\S]*?-->/g, "");

  if (!/VL\.done\s*\(/.test(body)) {
    issues.push({ level: "error", kind: "no-done", message: "页面从未调用 VL.done()，平台无法确认渲染完成。" });
  }
  for (const [re, kind, msg] of [
    [/\blocalStorage\b/, "storage", "使用了 localStorage —— 报告运行在无源沙箱里，访问会抛异常。"],
    [/\bsessionStorage\b/, "storage", "使用了 sessionStorage —— 同上，会抛异常。"],
    [/\bXMLHttpRequest\b/, "network", "使用了 XMLHttpRequest —— CSP connect-src 为 none，一定失败。"],
    [/(^|[^.\w])fetch\s*\(/, "network", "使用了 fetch —— CSP connect-src 为 none，一定失败。取数据请用 VL.*。"],
  ] as const) {
    if (re.test(body)) issues.push({ level: "error", kind, message: msg });
  }
  if (/<img[^>]+src\s*=\s*["']https?:/i.test(body)) {
    issues.push({ level: "error", kind: "remote-img", message: "引用了远程图片 —— CSP img-src 只允许 data: 和 blob:。" });
  }
  return issues;
}

/* ----------------------------------------------------------------- runtime */

async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright");
  // Deployments pin their own Chromium; the env var keeps this working when
  // the bundled build number does not match what is on disk.
  const executablePath = process.env.VOICELENS_CHROMIUM_PATH || undefined;
  return chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

export async function validateReportDocument(
  doc: string,
  opts: { timeoutMs?: number; screenshot?: boolean } = {},
): Promise<ValidationResult> {
  const started = Date.now();
  const issues = staticChecks(doc);
  const timeout = opts.timeoutMs ?? 30000;

  let browser: Browser | undefined;
  try {
    browser = await launch();
  } catch (e) {
    // No browser available is a platform problem, not a bad page: say so
    // rather than rejecting work that may be fine.
    issues.push({
      level: "warn",
      kind: "no-browser",
      message: `无法启动校验浏览器，已跳过运行时校验：${e instanceof Error ? e.message : String(e)}`,
    });
    return {
      ok: !issues.some((i) => i.level === "error"),
      issues,
      stats: { textChars: 0, domNodes: 0, scrollHeight: 0, overflowPx: 0, durationMs: Date.now() - started },
    };
  }

  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const cdnFailures = new Set<string>();

    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("requestfailed", (r) => {
      const url = r.url();
      if (isCdn(url)) cdnFailures.add(new URL(url).host);
      else if (!url.startsWith("data:") && !url.startsWith("blob:")) {
        issues.push({ level: "warn", kind: "blocked-request", message: `请求被拦截或失败：${url.slice(0, 120)}` });
      }
    });

    await page.setContent(doc, { waitUntil: "load", timeout });

    // The page signals its own completion; a page that never does is either
    // broken or ignored the contract, and both need regenerating.
    let done = false;
    try {
      await page.waitForFunction("window.__VL_DONE__ === true", undefined, { timeout: Math.min(timeout, 15000) });
      done = true;
    } catch {
      /* reported below */
    }

    const probe = await page.evaluate(() => {
      const de = document.documentElement;
      const err = document.getElementById("__vl_err__");
      return {
        textChars: (document.body?.innerText || "").trim().length,
        domNodes: document.getElementsByTagName("*").length,
        scrollHeight: de.scrollHeight,
        runtimeError: err ? (err.textContent || "").slice(0, 600) : "",
      };
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const overflowPx = await page.evaluate(() => {
      const de = document.documentElement;
      return Math.max(0, de.scrollWidth - de.clientWidth);
    });

    let screenshot: Buffer | undefined;
    if (opts.screenshot !== false) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(200);
      screenshot = await page.screenshot({ fullPage: false, type: "png" });
    }

    if (probe.runtimeError) {
      issues.push({ level: "error", kind: "runtime-error", message: `页面运行期报错：${probe.runtimeError}` });
    }
    for (const m of pageErrors.slice(0, 5)) {
      issues.push({ level: "error", kind: "page-error", message: `未捕获异常：${m.slice(0, 400)}` });
    }
    for (const m of consoleErrors.slice(0, 5)) {
      // A CDN that did not answer shows up here too; that case is covered by
      // the degradation check below, not counted as a broken page.
      if (isCdn(m)) continue;
      issues.push({ level: "error", kind: "console-error", message: `console.error：${m.slice(0, 400)}` });
    }
    if (cdnFailures.size) {
      issues.push({
        level: "warn",
        kind: "cdn-unreachable",
        message: `外部资源未能加载（${[...cdnFailures].join(", ")}）。若下方渲染检查通过，说明降级正常。`,
      });
    }
    // The static pass already says so when the call is missing outright;
    // repeating it just gives the model two lines to fix for one mistake.
    if (!done && !issues.some((i) => i.kind === "no-done")) {
      issues.push({ level: "error", kind: "no-done", message: "等待 VL.done() 超时：首屏未渲染完成，或渲染过程中断。" });
    }
    if (probe.textChars < 200) {
      issues.push({
        level: "error",
        kind: "blank",
        message: `页面几乎没有文字内容（${probe.textChars} 字），视为白屏。`,
      });
    }
    if (probe.domNodes < 40) {
      issues.push({ level: "error", kind: "empty-dom", message: `DOM 只有 ${probe.domNodes} 个节点，内容未渲染。` });
    }
    if (overflowPx > 8) {
      issues.push({
        level: "warn",
        kind: "overflow",
        message: `390px 宽度下横向溢出 ${overflowPx}px，窄屏会出现横向滚动条。`,
      });
    }

    return {
      ok: !issues.some((i) => i.level === "error"),
      issues,
      stats: {
        textChars: probe.textChars,
        domNodes: probe.domNodes,
        scrollHeight: probe.scrollHeight,
        overflowPx,
        durationMs: Date.now() - started,
      },
      screenshot,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** The issue list as the model should read it on a retry. */
export function renderIssues(issues: ValidationIssue[]): string {
  const errs = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  const lines: string[] = [];
  if (errs.length) {
    lines.push("必须修复（页面被判定为不可用）：");
    errs.forEach((i, n) => lines.push(`${n + 1}. [${i.kind}] ${i.message}`));
  }
  if (warns.length) {
    lines.push(lines.length ? "\n可以顺手改善：" : "可以顺手改善：");
    warns.forEach((i, n) => lines.push(`${n + 1}. [${i.kind}] ${i.message}`));
  }
  return lines.join("\n");
}
