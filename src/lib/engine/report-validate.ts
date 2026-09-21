import type { Browser, BrowserContext, Page } from "playwright";

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
 *
 * It also looks. A text-only verdict can say a page rendered and still miss
 * every reason a human calls it broken — a legend over a title, unreadable
 * text in dark mode, a KPI row wrapped into five lines — so each load comes
 * back with screenshots of the four ways the page will actually be seen
 * (desktop, further down the page, dark, phone). They exist to be handed to
 * the model that wrote the page: it has never once seen its own output.
 *
 * `ReportSession` holds the browser open across turns. The old loop launched
 * Chromium per attempt, which is seconds of the budget spent on process
 * startup, and made "show me that again after this patch" impossible.
 */

export interface ValidationIssue {
  level: "error" | "warn";
  kind: string;
  message: string;
}

/** One rendering of the page, for the model and for the human. */
export interface ReportShot {
  /** Stable name the model can ask for again, e.g. `dark`. */
  id: string;
  /** What is being looked at, in the language of the issue list. */
  label: string;
  width: number;
  height: number;
  theme: "light" | "dark";
  /** Vertical offset in CSS pixels, 0 for the first screen. */
  scroll: number;
  /** JPEG bytes — a PNG of the same frame is three to five times the tokens. */
  bytes: Buffer;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  stats: {
    textChars: number;
    domNodes: number;
    scrollHeight: number;
    overflowPx: number;
    printOverflowPx: number;
    durationMs: number;
  };
  /** Every rendering taken during this load, in the order they were taken. */
  shots: ReportShot[];
}

export interface ShotRequest {
  id?: string;
  label?: string;
  width?: number;
  height?: number;
  theme?: "light" | "dark";
  /** CSS pixels from the top; clamped to what the page actually has. */
  scroll?: number;
}

/** What `inspect` answers with: geometry and the styles that break layouts. */
export interface InspectedNode {
  selector: string;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  overflow: { x: number; y: number };
  styles: Record<string, string>;
}

const CDN_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

const isCdn = (url: string) => CDN_HOSTS.some((h) => url.includes(h));

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
/** A4 at 96dpi, which is what `@media print` is judged against. */
const PRINT = { width: 794, height: 1123 };

/** Enough to read a layout, small enough that four of them fit in a prompt. */
const SHOT_QUALITY = 68;

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

/* --------------------------------------------------------------- in-page */

interface VisualFindings {
  invisible: string[];
  clipped: string[];
  tiny: string[];
}

/**
 * The visual defects a text verdict cannot see, measured in the page itself.
 *
 * Every rule here is one that makes a rendered page wrong while leaving it
 * technically alive, and each is written to under-report rather than over-:
 * a contrast floor low enough that only genuinely invisible text trips it,
 * clipping that excludes the two properties people truncate text with on
 * purpose. A false alarm costs a regeneration of a page that was fine, which
 * is worse than missing one.
 *
 * It is serialized into the page, so it is written in the subset that survives
 * that trip: no spread, no optional chaining, no imports, nothing the ES2017
 * target would rewrite into a helper that does not exist over there.
 */
function visualProbe(): VisualFindings {
  const out: VisualFindings = { invisible: [], clipped: [], tiny: [] };
  const LIMIT = 4000;
  const SAMPLES = 4;

  interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
  }

  function rgba(text: string): Rgba | null {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(text || "");
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }
  function lum(c: Rgba): number {
    function f(v: number) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a: Rgba, b: Rgba): number {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  /* The colour actually behind the text: the first ancestor that paints
     something opaque, falling back to the canvas. */
  function backdrop(el: Element): Rgba {
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.85) return c;
    }
    const root = rgba(getComputedStyle(document.documentElement).backgroundColor);
    return root && root.a >= 0.85 ? root : { r: 255, g: 255, b: 255, a: 1 };
  }
  function describe(el: Element): string {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.className && typeof el.className === "string") {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".");
      if (cls) s += "." + cls;
    }
    const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return t ? s + "「" + t + "」" : s;
  }
  /* Text this element itself paints, not what its children do — otherwise a
     wrapper is reported for the colour of a child it never styled. */
  function ownText(el: Element): string {
    let text = "";
    for (let i = 0; i < el.childNodes.length; i++) {
      const node = el.childNodes[i];
      if (node.nodeType === 3) text += node.nodeValue || "";
    }
    return text.trim();
  }

  const all = document.body ? document.body.querySelectorAll("*") : [];
  for (let i = 0; i < all.length && i < LIMIT; i++) {
    const el = all[i];
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;

    const own = ownText(el);
    if (own.length < 8) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    if (parseFloat(cs.opacity || "1") > 0.1) {
      const fg = rgba(cs.color);
      if (fg && fg.a >= 0.5) {
        const r = ratio(fg, backdrop(el));
        /* 1.6 is far below any legibility standard on purpose: this is here to
           catch text painted onto its own background, not to grade contrast. */
        if (r < 1.6 && out.invisible.length < SAMPLES) {
          out.invisible.push(describe(el) + "（对比度 " + r.toFixed(2) + "，前景 " + cs.color + "）");
        }
      }
      const size = parseFloat(cs.fontSize || "16");
      if (size > 0 && size < 10 && own.length >= 20 && out.tiny.length < SAMPLES) {
        out.tiny.push(describe(el) + "（字号 " + size.toFixed(1) + "px）");
      }
    }

    if (out.clipped.length < SAMPLES) {
      /* Deliberate truncation is not a defect: a line clamp or an ellipsis
         says the author meant to cut the text off. */
      const clamp = cs.getPropertyValue("-webkit-line-clamp");
      const intentional = cs.textOverflow === "ellipsis" || (clamp !== "" && clamp !== "none");
      const hidden = cs.overflow === "hidden";
      const cutY = (hidden || cs.overflowY === "hidden") && el.scrollHeight - el.clientHeight > 4;
      const cutX = (hidden || cs.overflowX === "hidden") && el.scrollWidth - el.clientWidth > 4;
      if (!intentional && (cutY || cutX)) {
        out.clipped.push(
          describe(el) +
            "（" +
            (cutY ? "纵向" : "横向") +
            "被裁掉 " +
            (cutY ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth) +
            "px）",
        );
      }
    }
  }
  return out;
}

/** Scale, content and the runtime's own error banner, read in one round trip. */
function statProbe() {
  const de = document.documentElement;
  const err = document.getElementById("__vl_err__");
  return {
    textChars: ((document.body && document.body.innerText) || "").trim().length,
    domNodes: document.getElementsByTagName("*").length,
    scrollHeight: de.scrollHeight,
    runtimeError: err ? (err.textContent || "").slice(0, 600) : "",
  };
}

/**
 * Geometry and the handful of computed properties that break report layouts.
 *
 * Same constraints as `visualProbe`: it is serialized into the page, so plain
 * constructs only.
 */
function inspectProbe(arg: { selector: string; limit: number }) {
  let found: NodeListOf<Element>;
  try {
    found = document.querySelectorAll(arg.selector);
  } catch (e) {
    throw new Error("选择器不合法：" + (e instanceof Error ? e.message : String(e)));
  }
  const keys = [
    "display",
    "position",
    "width",
    "height",
    "fontSize",
    "lineHeight",
    "color",
    "backgroundColor",
    "overflow",
    "overflowX",
    "overflowY",
    "flexWrap",
    "gridTemplateColumns",
    "whiteSpace",
    "textOverflow",
  ];
  const out = [];
  for (let i = 0; i < found.length && out.length < arg.limit; i++) {
    const el = found[i];
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    let path = el.tagName.toLowerCase();
    if (el.id) path += "#" + el.id;
    else if (el.className && typeof el.className === "string") {
      const cls = el.className.trim().split(/\s+/).slice(0, 3).join(".");
      if (cls) path += "." + cls;
    }
    const styles: Record<string, string> = {};
    for (let k = 0; k < keys.length; k++) {
      styles[keys[k]] = cs.getPropertyValue(camelToKebab(keys[k])) || "";
    }
    out.push({
      selector: path,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      overflow: { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight },
      styles: styles,
    });
  }
  return out;

  function camelToKebab(name: string): string {
    return name.replace(/[A-Z]/g, function (c) {
      return "-" + c.toLowerCase();
    });
  }
}

/** Horizontal overflow at whatever viewport and media is currently emulated. */
function overflowProbe(): number {
  const de = document.documentElement;
  return Math.max(0, de.scrollWidth - de.clientWidth);
}

/* ----------------------------------------------------------------- runtime */

async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright");
  // Deployments pin their own Chromium; the env var keeps this working when
  // the bundled build number does not match what is on disk.
  const executablePath = process.env.VOICELENS_CHROMIUM_PATH || undefined;
  return chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

/** Thrown when there is no browser at all — a platform fault, not a bad page. */
export class NoBrowserError extends Error {}

/**
 * One browser, many loads.
 *
 * A page is loaded, judged, patched and judged again within one session, so
 * the process cost is paid once and "look at this again" is a screenshot
 * rather than a relaunch. Each load gets a fresh tab: console and pageerror
 * listeners are per page, and a reused one would carry the previous
 * document's failures into the next verdict.
 */
export class ReportSession {
  private page: Page | null = null;

  private constructor(
    private readonly browser: Browser,
    private readonly ctx: BrowserContext,
  ) {}

  static async open(): Promise<ReportSession> {
    let browser: Browser;
    try {
      browser = await launch();
    } catch (e) {
      throw new NoBrowserError(e instanceof Error ? e.message : String(e));
    }
    const ctx = await browser.newContext({ viewport: { ...DESKTOP }, colorScheme: "light" });
    return new ReportSession(browser, ctx);
  }

  /** The document currently loaded, for `shoot` and `inspect`. */
  get loaded(): boolean {
    return this.page !== null;
  }

  async load(doc: string, opts: { timeoutMs?: number; shots?: boolean } = {}): Promise<ValidationResult> {
    const started = Date.now();
    const issues = staticChecks(doc);
    const timeout = opts.timeoutMs ?? 30000;

    const previous = this.page;
    const page = await this.ctx.newPage();
    this.page = page;
    if (previous) await previous.close().catch(() => {});

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

    await page.setViewportSize({ ...DESKTOP });
    await page.emulateMedia({ colorScheme: "light", media: "screen" });
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

    const probe = await page.evaluate(statProbe);

    const shots: ReportShot[] = [];
    const wantShots = opts.shots !== false;

    if (wantShots) shots.push(await this.shoot({ id: "desktop", label: "桌面 1440×900 首屏（浅色）" }));

    // One more frame further down, where the charts usually are. A report that
    // is two screens tall has its whole second half unseen otherwise.
    if (wantShots && probe.scrollHeight > DESKTOP.height * 1.6) {
      shots.push(
        await this.shoot({
          id: "desktop-lower",
          label: "桌面 1440×900 向下一屏（浅色）",
          scroll: Math.min(DESKTOP.height, probe.scrollHeight - DESKTOP.height),
        }),
      );
    }

    const visualLight = await this.visualProbe(page);

    // Dark mode is where "it rendered" and "it is readable" come apart most
    // often, so it is measured as well as photographed.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(250);
    if (wantShots) shots.push(await this.shoot({ id: "dark", label: "桌面 1440×900 首屏（深色）", theme: "dark" }));
    const visualDark = await this.visualProbe(page);
    await page.emulateMedia({ colorScheme: "light" });

    await page.setViewportSize({ ...PHONE });
    await page.waitForTimeout(300);
    const overflowPx = await page.evaluate(overflowProbe);
    if (wantShots) shots.push(await this.shoot({ id: "mobile", label: "手机 390×844 首屏（浅色）", ...PHONE }));

    await page.emulateMedia({ media: "print" });
    await page.setViewportSize({ ...PRINT });
    await page.waitForTimeout(250);
    const printOverflowPx = await page.evaluate(overflowProbe);
    await page.emulateMedia({ media: "screen", colorScheme: "light" });
    await page.setViewportSize({ ...DESKTOP });

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
    if (printOverflowPx > 8) {
      issues.push({
        level: "warn",
        kind: "print-overflow",
        message: `@media print（A4 794px）下横向溢出 ${printOverflowPx}px，打印/导出 PDF 会切掉右侧内容。`,
      });
    }
    issues.push(...describeVisual("浅色", visualLight), ...describeVisual("深色", visualDark));

    return {
      ok: !issues.some((i) => i.level === "error"),
      issues,
      stats: {
        textChars: probe.textChars,
        domNodes: probe.domNodes,
        scrollHeight: probe.scrollHeight,
        overflowPx,
        printOverflowPx,
        durationMs: Date.now() - started,
      },
      shots,
    };
  }

  /** One frame of the loaded page. Leaves the viewport as it found it. */
  async shoot(req: ShotRequest = {}): Promise<ReportShot> {
    const page = this.require();
    const width = req.width ?? DESKTOP.width;
    const height = req.height ?? DESKTOP.height;
    const theme = req.theme ?? "light";
    const scroll = Math.max(0, Math.round(req.scroll ?? 0));

    const before = page.viewportSize();
    await page.setViewportSize({ width, height });
    if (req.theme) await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((y: number) => window.scrollTo(0, y), scroll);
    await page.waitForTimeout(scroll ? 250 : 120);

    const bytes = await page.screenshot({ fullPage: false, type: "jpeg", quality: SHOT_QUALITY });

    await page.evaluate(() => window.scrollTo(0, 0));
    if (before && (before.width !== width || before.height !== height)) await page.setViewportSize(before);

    return {
      id: req.id ?? `${theme}-${width}x${height}${scroll ? `@${scroll}` : ""}`,
      label: req.label ?? `${width}×${height}${theme === "dark" ? " 深色" : ""}${scroll ? ` 偏移 ${scroll}px` : ""}`,
      width,
      height,
      theme,
      scroll,
      bytes,
    };
  }

  /**
   * What the browser computed for the nodes a selector matches.
   *
   * The model asking "why is this row taller than I meant" cannot read the
   * layout out of its own source: the answer is in the box the browser built.
   */
  async inspect(selector: string, limit = 5): Promise<InspectedNode[]> {
    const page = this.require();
    return page.evaluate(inspectProbe, { selector, limit });
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => {});
    this.page = null;
  }

  private require(): Page {
    if (!this.page) throw new Error("报告校验会话尚未载入任何页面");
    return this.page;
  }

  private async visualProbe(page: Page): Promise<VisualFindings> {
    try {
      return await page.evaluate(visualProbe);
    } catch {
      // A probe that cannot run must not fail the page it was measuring.
      return { invisible: [], clipped: [], tiny: [] };
    }
  }
}

function describeVisual(theme: string, found: VisualFindings): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (found.invisible.length) {
    issues.push({
      level: "warn",
      kind: "invisible-text",
      message: `${theme}模式下有文字与背景几乎同色，看不见：${found.invisible.join("；")}`,
    });
  }
  if (found.clipped.length) {
    issues.push({
      level: "warn",
      kind: "clipped-text",
      message: `${theme}模式下有文字被容器裁掉（既没有省略号也没有 line-clamp）：${found.clipped.join("；")}`,
    });
  }
  if (found.tiny.length) {
    issues.push({
      level: "warn",
      kind: "tiny-text",
      message: `${theme}模式下有正文小于 10px，难以阅读：${found.tiny.join("；")}`,
    });
  }
  return issues;
}

/**
 * Validate one document and let go of the browser.
 *
 * The loop keeps a `ReportSession` open instead; this is for the callers with
 * a single page to judge — the test script, and a rerender checked after the
 * fact.
 */
export async function validateReportDocument(
  doc: string,
  opts: { timeoutMs?: number; screenshot?: boolean } = {},
): Promise<ValidationResult> {
  const started = Date.now();
  let session: ReportSession;
  try {
    session = await ReportSession.open();
  } catch (e) {
    // No browser available is a platform problem, not a bad page: say so
    // rather than rejecting work that may be fine.
    const issues = staticChecks(doc);
    issues.push({
      level: "warn",
      kind: "no-browser",
      message: `无法启动校验浏览器，已跳过运行时校验：${e instanceof Error ? e.message : String(e)}`,
    });
    return {
      ok: !issues.some((i) => i.level === "error"),
      issues,
      stats: {
        textChars: 0,
        domNodes: 0,
        scrollHeight: 0,
        overflowPx: 0,
        printOverflowPx: 0,
        durationMs: Date.now() - started,
      },
      shots: [],
    };
  }
  try {
    return await session.load(doc, { timeoutMs: opts.timeoutMs, shots: opts.screenshot !== false });
  } finally {
    await session.close();
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

/** One line per rendering, so the model knows which image is which. */
export function describeShots(shots: ReportShot[]): string {
  if (!shots.length) return "";
  return shots.map((s, n) => `图 ${n + 1}（${s.id}）：${s.label}`).join("\n");
}
