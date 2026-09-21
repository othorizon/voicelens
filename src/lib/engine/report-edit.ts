/**
 * What the model is allowed to say, and how an edit it asks for is applied.
 *
 * Rewriting a whole document to move a legend costs the same as writing it in
 * the first place, and on a page that runs to thousands of lines it regularly
 * costs more than the budget has left — `truncated` is a failure the loop
 * already knows by name. So the model may also send edits: a search block that
 * must match the page exactly once, and what to put there instead.
 *
 * The protocol is tags rather than tool calls on purpose. Tool calling is not
 * evenly implemented across the OpenAI-compatible endpoints this platform is
 * pointed at — and every call here streams, which is where support frays
 * first. Tags cost one parser and work on every endpoint that can produce
 * text. The degenerate case is the old contract exactly: a reply that is
 * nothing but a complete HTML document is read as "write this page", so a
 * model that ignores the protocol entirely still behaves the way it used to.
 *
 * Everything in this file is pure. The loop that executes these actions is in
 * `report-agent.ts`; keeping the parsing and the patching separate is what
 * makes both testable without a browser or a model (`npm run test:edit`).
 */

/* ------------------------------------------------------------------- edits */

export interface EditBlock {
  search: string;
  replace: string;
}

export interface EditFailure {
  /** 1-based position in the list the model sent, as the message refers to it. */
  index: number;
  reason: string;
  /** The head of the SEARCH text, so the model can see which block failed. */
  excerpt: string;
}

export interface EditResult {
  text: string;
  applied: number;
  failures: EditFailure[];
}

const MARK_SEARCH = /^<{5,9} *SEARCH\s*$/;
const MARK_SPLIT = /^={5,9}\s*$/;
const MARK_REPLACE = /^>{5,9} *REPLACE\s*$/;

/**
 * Pull the search/replace pairs out of one patch block.
 *
 * Written as a line scanner rather than a regex because the payload is HTML
 * and JavaScript: any delimiter expressive enough to survive that is also one
 * a model gets wrong. A malformed block is reported, not guessed at.
 */
export function parseEditBlocks(body: string): { edits: EditBlock[]; errors: string[] } {
  const lines = body.split("\n");
  const edits: EditBlock[] = [];
  const errors: string[] = [];

  let state: "idle" | "search" | "replace" = "idle";
  let search: string[] = [];
  let replace: string[] = [];

  const flush = () => {
    edits.push({ search: search.join("\n"), replace: replace.join("\n") });
    search = [];
    replace = [];
    state = "idle";
  };

  for (const line of lines) {
    if (state === "idle") {
      if (MARK_SEARCH.test(line)) state = "search";
      else if (MARK_SPLIT.test(line) || MARK_REPLACE.test(line)) {
        errors.push(`出现了没有对应 "<<<<<<< SEARCH" 的分隔行：${line.trim()}`);
      }
      continue;
    }
    if (state === "search") {
      if (MARK_SPLIT.test(line)) state = "replace";
      else if (MARK_REPLACE.test(line)) {
        errors.push("SEARCH 段后面缺少 ======= 分隔行。");
        search = [];
        state = "idle";
      } else if (MARK_SEARCH.test(line)) {
        errors.push("上一个 SEARCH 段还没闭合就开始了新的 SEARCH 段。");
        search = [];
      } else search.push(line);
      continue;
    }
    if (MARK_REPLACE.test(line)) flush();
    else if (MARK_SEARCH.test(line)) {
      errors.push("REPLACE 段后面缺少 >>>>>>> REPLACE 行。");
      search = [];
      replace = [];
      state = "search";
    } else replace.push(line);
  }

  if (state !== "idle") errors.push("最后一个编辑块没有以 >>>>>>> REPLACE 结束，已丢弃。");
  return { edits, errors };
}

const head = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Trailing whitespace is the one difference never worth failing a patch over. */
const loosen = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Apply the edits in order, each one to the result of the last.
 *
 * A block that does not match exactly once is refused rather than
 * approximated. The alternative — patching the first of several matches —
 * silently edits the wrong chart, and the model has no way to find out: it
 * would be told the patch applied. Refusing gives it the one thing it can act
 * on, which is that the anchor was not unique.
 */
export function applyEdits(source: string, edits: EditBlock[]): EditResult {
  let text = source;
  let applied = 0;
  const failures: EditFailure[] = [];

  edits.forEach((edit, i) => {
    const index = i + 1;
    if (!edit.search.trim()) {
      failures.push({ index, reason: "SEARCH 段是空的，无法定位要改的位置。", excerpt: "" });
      return;
    }
    if (edit.search === edit.replace) {
      failures.push({ index, reason: "SEARCH 与 REPLACE 完全相同，这个编辑没有任何效果。", excerpt: head(edit.search) });
      return;
    }

    const exact = countOccurrences(text, edit.search);
    if (exact === 1) {
      text = text.replace(edit.search, () => edit.replace);
      applied++;
      return;
    }
    if (exact > 1) {
      failures.push({
        index,
        reason: `SEARCH 段在页面里出现了 ${exact} 次，无法确定改哪一处。请把它写长一些（把上下各一两行一起带上），确保唯一。`,
        excerpt: head(edit.search),
      });
      return;
    }

    // Nothing matched. Trailing whitespace is a difference the model cannot
    // see in its own output, so it is the one thing forgiven — and only when
    // forgiving it still leaves exactly one place to edit.
    const loose = loosen(text);
    const target = loosen(edit.search);
    if (countOccurrences(loose, target) === 1) {
      const at = loose.indexOf(target);
      text = text.slice(0, at) + edit.replace + text.slice(at + target.length);
      applied++;
      return;
    }
    failures.push({
      index,
      reason:
        "SEARCH 段在页面里找不到。它必须是页面里逐字符一致的原文（含缩进），不能是你记忆中的版本，也不能省略中间部分。",
      excerpt: head(edit.search),
    });
  });

  return { text, applied, failures };
}

/** The failures as the model should read them before trying again. */
export function renderEditFailures(failures: EditFailure[]): string {
  return failures
    .map((f) => `编辑 ${f.index} 未应用：${f.reason}${f.excerpt ? `\n  SEARCH 开头：${f.excerpt}` : ""}`)
    .join("\n");
}

/* ----------------------------------------------------------------- actions */

export type ReportAction =
  | { kind: "write"; page: string }
  | { kind: "patch"; edits: EditBlock[]; errors: string[] }
  | { kind: "look"; id?: string; theme?: "light" | "dark"; width?: number; height?: number; scroll?: number }
  | { kind: "inspect"; selector: string }
  | { kind: "data"; path: string }
  | { kind: "done"; note: string };

const TAG = /<vl:(patch|write|look|inspect|data|done)\b([^>]*?)(\/?)>/gi;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

const int = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

/**
 * Models wrap output in fences even when told not to, and occasionally add a
 * sentence before it. Take the document and drop the rest.
 */
export function extractHtml(text: string): string {
  let s = text.trim();

  const fence = s.match(/```(?:html?)?\s*\n([\s\S]*?)(?:\n```|$)/i);
  if (fence && /<(?:!doctype|html)/i.test(fence[1])) s = fence[1].trim();

  const start = s.search(/<!doctype\s+html|<html[\s>]/i);
  if (start > 0) s = s.slice(start);

  const end = s.toLowerCase().lastIndexOf("</html>");
  if (end !== -1) s = s.slice(0, end + "</html>".length);

  return s.trim();
}

/**
 * Read one turn from the model into the actions it asked for, in the order it
 * asked for them — a patch followed by a look means patch, then look.
 *
 * A reply with no tags at all but a whole document in it is a `write`. That is
 * not a fallback bolted on; it is the contract the report stage had before
 * this protocol existed, and keeping it exact is what lets a model that never
 * learned the tags still produce a report.
 */
export function parseActions(reply: string): ReportAction[] {
  const actions: ReportAction[] = [];
  const consumed: [number, number][] = [];

  TAG.lastIndex = 0;
  for (let m = TAG.exec(reply); m; m = TAG.exec(reply)) {
    const kind = m[1].toLowerCase();
    const a = attrs(m[2] ?? "");
    const selfClosing = m[3] === "/";
    const closeTag = `</vl:${kind}>`;
    const bodyStart = m.index + m[0].length;
    const closeAt = selfClosing ? -1 : reply.toLowerCase().indexOf(closeTag, bodyStart);
    const body = closeAt === -1 ? (selfClosing ? "" : reply.slice(bodyStart)) : reply.slice(bodyStart, closeAt);
    const end = closeAt === -1 ? (selfClosing ? bodyStart : reply.length) : closeAt + closeTag.length;
    consumed.push([m.index, end]);

    if (kind === "patch") {
      const { edits, errors } = parseEditBlocks(body);
      actions.push({ kind: "patch", edits, errors });
    } else if (kind === "write") {
      const page = extractHtml(body);
      if (page) actions.push({ kind: "write", page });
    } else if (kind === "look") {
      const size = a.size ? /^(\d+)\s*[x×]\s*(\d+)$/i.exec(a.size.trim()) : null;
      actions.push({
        kind: "look",
        id: a.id || undefined,
        theme: a.theme === "dark" ? "dark" : a.theme === "light" ? "light" : undefined,
        width: int(a.width) ?? (size ? Number(size[1]) : undefined),
        height: int(a.height) ?? (size ? Number(size[2]) : undefined),
        scroll: int(a.scroll),
      });
    } else if (kind === "inspect") {
      const selector = (a.selector || body).trim();
      if (selector) actions.push({ kind: "inspect", selector });
    } else if (kind === "data") {
      const path = (a.path || body).trim();
      if (path) actions.push({ kind: "data", path });
    } else if (kind === "done") {
      actions.push({ kind: "done", note: body.trim() });
    }
    TAG.lastIndex = end;
  }

  // A document written outside any tag. Only considered when the reply did not
  // already contain a write, so a model that used both does not get two.
  if (!actions.some((x) => x.kind === "write")) {
    let rest = reply;
    for (const [from, to] of [...consumed].reverse()) rest = rest.slice(0, from) + rest.slice(to);
    const page = extractHtml(rest);
    if (/<\/html\s*>/i.test(page) || /<!doctype\s+html/i.test(page)) {
      // Before any look/inspect the model asked for in the same turn: the page
      // it wants to see is this one.
      actions.unshift({ kind: "write", page });
    }
  }

  return actions;
}

/**
 * Read a dotted path out of the payload the page will be given.
 *
 * The model never receives the data — only its profile — which is what keeps a
 * report over 80k sessions affordable. But "does `global.findings[2].metric`
 * actually exist" is a question it cannot answer from the profile, and getting
 * it wrong renders an empty card. So it may ask, one path at a time.
 */
export function readPath(root: unknown, path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const cleaned = path.trim().replace(/^VL\./i, "").replace(/^payload\./i, "");
  if (!cleaned) return { ok: false, reason: "路径是空的。" };

  const steps = cleaned
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let node: unknown = root;
  const walked: string[] = [];
  for (const step of steps) {
    if (node === null || node === undefined) {
      return { ok: false, reason: `${walked.join(".") || "根"} 是 ${node === null ? "null" : "undefined"}，无法继续取 ${step}。` };
    }
    if (Array.isArray(node)) {
      const i = Number(step);
      if (!Number.isInteger(i)) return { ok: false, reason: `${walked.join(".")} 是数组，下标必须是整数，收到 "${step}"。` };
      node = node[i];
    } else if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (!(step in obj)) {
        const keys = Object.keys(obj).slice(0, 12).join(", ");
        return { ok: false, reason: `${walked.join(".") || "根"} 下没有 "${step}"。可用的键：${keys || "（无）"}` };
      }
      node = obj[step];
    } else {
      return { ok: false, reason: `${walked.join(".")} 是 ${typeof node}，不能再往下取 ${step}。` };
    }
    walked.push(step);
  }
  return { ok: true, value: node };
}

/** A value the model asked for, short enough to hand back in a message. */
export function renderValue(value: unknown, maxChars = 2400): string {
  if (value === undefined) return "undefined";
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "（无法序列化）";
  }
  if (text.length <= maxChars) return text;
  const note = Array.isArray(value) ? `（共 ${value.length} 项，以下为截断）` : "（已截断）";
  return `${note}\n${text.slice(0, maxChars)}…`;
}
