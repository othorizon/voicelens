import { chat, type ChatMessage, type ContentPart } from "./ai";
import { requireModel, type AnalysisRuntime } from "@/lib/models/registry";
import { stageOptions, textModelKind } from "@/lib/models/mode";
import {
  applyEdits,
  parseActions,
  readPath,
  renderEditFailures,
  renderValue,
} from "./report-edit";
import { composeReportDocument, type ReportPayload, type ReportSnapshot } from "./report-runtime";
import {
  NoBrowserError,
  ReportSession,
  describeShots,
  renderIssues,
  staticChecks,
  type ReportShot,
  type ValidationIssue,
  type ValidationResult,
} from "./report-validate";

/**
 * Writing the report page as a conversation with the browser.
 *
 * The stage used to be three shots at a whole document: write it, load it, and
 * if it broke, paste the failures back and write the whole thing again. That
 * loop could only ever fix what a text verdict can describe. It could not fix
 * a legend sitting on a title, because nothing in it ever looked at the page —
 * the screenshot was taken, carried up two call frames, and dropped.
 *
 * So the page is built against a browser that stays open. Each turn the model
 * may rewrite the document, patch it, ask to see it at another size or in dark
 * mode, ask what the browser computed for a selector, or ask whether a value it
 * wants to render actually exists in the payload. Every render comes back as
 * the issue list *and* the frames — desktop, further down, dark, phone — so the
 * model is finally looking at its own output.
 *
 * Three properties are deliberate:
 *
 * - **One code path.** A model that ignores the protocol and just writes a
 *   document behaves exactly as it did before, because "a reply that is only a
 *   document" is the write action. There is no second generator to drift.
 * - **Bounded context.** Only the current page and the latest observation are
 *   carried, plus a one-line-per-turn digest of what has already been tried.
 *   Turn 6 costs what turn 2 costs; a growing transcript of thousand-line
 *   documents would not survive the budget.
 * - **Bounded ambition.** A page that validates clean is returned at once. The
 *   loop spends extra turns only on the visual warnings a browser can measure
 *   but not fix, and at most one of them, because a polish turn that regresses
 *   a working page is the expensive mistake here.
 */

/** Raised when the caller asked the loop to stop — a cancelled task, usually. */
export class ReportAgentStopped extends Error {}

/** A page runs to a few thousand lines, which the JSON-era budget cuts off. */
const HTML_TOKEN_FLOOR = 64000;

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};

/**
 * Turns, and whether the model is shown its own renders.
 *
 * Environment rather than workflow parameters on purpose: both apply to the
 * preview path as much as to the full run, and the preview never sees a
 * `WorkflowConfig`. A knob that silently only worked on one of the two would be
 * worse than no knob.
 *
 * Six is enough for write → fix → polish with room for a look or two, and is
 * the point past which a model that has not converged is usually going in
 * circles. Vision goes off for an endpoint whose model is text-only; every
 * model kind this platform routes the report stage to accepts images, so it is
 * on by default.
 */
const MAX_TURNS = () => num("VOICELENS_REPORT_MAX_TURNS", 6);
const VISION_ON = () => !/^(0|off|false|no)$/i.test(process.env.VOICELENS_REPORT_VISION ?? "");

/** Renders the model is shown per turn. Four frames is already ~0.5MB of JPEG. */
const MAX_IMAGES = 4;

/**
 * Warnings worth one more turn: each one is a page that renders and still
 * reads as broken to a person. The rest (an unreachable CDN, a blocked
 * request) are not the model's to fix.
 */
const POLISH_KINDS = new Set(["overflow", "print-overflow", "invisible-text", "clipped-text", "tiny-text"]);

export interface AgentSeed {
  /** Role, brief, data contract and protocol — everything constant. */
  system: string;
  /** The job, as the first user message. */
  task: string;
  /**
   * An existing page to work from and why. Present for a revision, absent
   * when the page is being written from nothing.
   */
  base?: { page: string; note: string };
}

export interface RunAgentInput {
  runtime: AnalysisRuntime;
  payload: ReportPayload;
  snapshot?: ReportSnapshot | null;
  seed: AgentSeed;
  /** Turns including the first; each one is one model call. */
  maxTurns?: number;
  /** Show the model its own renders. Off only for a text-only endpoint. */
  vision?: boolean;
  /** Appears in error messages, e.g. 报告页面生成. */
  label?: string;
  onStep?: (message: string) => void;
  /**
   * Checked between turns. A loop that may run for many minutes has to be
   * stoppable: without this, cancelling a task during the report stage sets a
   * flag nobody reads and the model keeps spending.
   */
  shouldStop?: () => Promise<string | null>;
}

export interface AgentTurnNote {
  turn: number;
  /** What the model did, in the words the next turn will read. */
  did: string;
  errors: number;
  warnings: number;
}

export interface RunAgentResult {
  /** The model's document, before the runtime is injected. */
  page: string;
  /** What gets stored and served. */
  document: string;
  validation: ValidationResult;
  turns: number;
  tokens: number;
  /** The frames of the page being returned. */
  shots: ReportShot[];
  history: AgentTurnNote[];
}

/* ------------------------------------------------------------- the protocol */

/**
 * The action vocabulary, as the model reads it. It sits next to the parser for
 * the same reason `VL_API_DOC` sits next to the runtime: a contract documented
 * somewhere else drifts from the code, and the model is the one who pays.
 */
export const PROTOCOL_DOC = `你不是一次性交付。你写出页面后，平台会在真实浏览器里渲染它，并把**渲染校验结果和页面截图**发回给你 —— 你能看到自己写的页面长什么样。然后你可以继续修，直到它合格。

每一轮你可以使用下面这些动作，可以一次用多个（按你书写的顺序执行）：

## 写整份页面
\`\`\`
<vl:write>
<!doctype html>
…完整 HTML…
</vl:write>
\`\`\`
第一轮必须用它。也可以直接输出裸的 HTML 文档（不带标签），等价。

## 局部修改（推荐用于改一处小问题）
\`\`\`
<vl:patch>
<<<<<<< SEARCH
（页面里逐字符一致的原文，含缩进）
=======
（替换成什么）
>>>>>>> REPLACE
</vl:patch>
\`\`\`
- SEARCH 必须在页面里**恰好出现一次**：太短会撞到多处，把上下各一两行一起带上就唯一了。
- 一个 \`<vl:patch>\` 里可以放多个 SEARCH/REPLACE 块。
- 改一两处就用 patch，不要整份重写 —— 重写一份几千行的页面经常写不完就被截断。

## 再看一眼
\`\`\`
<vl:look theme="dark"/>            深色模式首屏
<vl:look size="390x844"/>          手机宽度
<vl:look scroll="1600"/>           向下滚动 1600px 处
\`\`\`

## 问浏览器
\`\`\`
<vl:inspect selector=".kpi-row"/>  返回该选择器命中元素的实际盒模型与计算样式
\`\`\`

## 问数据
\`\`\`
<vl:data path="global.findings"/>   读取 VL 里的真实值（你看不到数据，只看到画像）
\`\`\`
用它确认你要渲染的字段真的存在、真的有值 —— 渲染一个不存在的字段就是一张空卡片。

## 收尾
\`\`\`
<vl:done/>
\`\`\`
只在页面已经通过校验、且你认为剩下的问题不值得再改时使用。

**不要输出解释性文字。** 每一轮的回答就是动作本身。`;

/* -------------------------------------------------------------------- run */

export async function runReportAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const step = input.onStep ?? (() => {});
  const maxTurns = Math.max(1, input.maxTurns ?? MAX_TURNS());
  const vision = input.vision ?? VISION_ON();
  const label = input.label ?? "报告页面生成";

  const stage = stageOptions(input.runtime.stages, "report");
  const options = {
    model: requireModel(input.runtime, textModelKind(input.runtime.mode), label),
    temperature: 0.6,
    label,
    ...stage,
    // Only raise a budget that was left at the JSON-era default; an explicit
    // 0 means the operator wants the model to stop where it stops.
    ...(stage.maxTokens !== undefined && stage.maxTokens < HTML_TOKEN_FLOOR ? { maxTokens: HTML_TOKEN_FLOOR } : {}),
  };

  const compose = (page: string) => composeReportDocument(page, input.payload, input.snapshot);

  let session: ReportSession | null = null;
  try {
    session = await ReportSession.open();
  } catch (e) {
    if (!(e instanceof NoBrowserError)) throw e;
    // No browser is a platform fault, not a bad page. The loop still runs —
    // the model simply works blind, on static checks alone.
    step(`无法启动校验浏览器，本次不做渲染校验与截图：${e.message}`);
  }

  try {
    return await drive({ ...input, step, maxTurns, vision, options, compose, session });
  } finally {
    await session?.close();
  }
}

interface DriveInput extends RunAgentInput {
  step: (message: string) => void;
  maxTurns: number;
  vision: boolean;
  options: Parameters<typeof chat>[1];
  compose: (page: string) => string;
  session: ReportSession | null;
}

async function drive(input: DriveInput): Promise<RunAgentResult> {
  const { step, seed, session, compose } = input;

  let page = seed.base?.page ?? "";
  let document = page ? compose(page) : "";
  let validation: ValidationResult | null = null;
  let shots: ReportShot[] = [];
  let tokens = 0;
  let polished = false;
  let idle = 0;

  const history: AgentTurnNote[] = [];
  /** The last page that validated clean; what we return rather than a regression. */
  let good: { page: string; document: string; validation: ValidationResult; shots: ReportShot[] } | null = null;
  /** The closest miss, for when nothing ever validates. */
  let best: { page: string; document: string; validation: ValidationResult; shots: ReportShot[] } | null = null;

  const remember = (v: ValidationResult) => {
    const snap = { page, document, validation: v, shots };
    if (v.ok) good = snap;
    const errors = countErrors(v);
    if (!best || errors < countErrors(best.validation)) best = snap;
  };

  /**
   * Load the current page and judge it.
   *
   * `candidate` is what keeps a revision honest. The page a revision starts
   * from is rendered so the model can see it, but it must never be a thing this
   * run can return: if it were, a revision whose every attempt broke the page
   * would hand back the page it started with and report success — a version
   * that changed nothing, stored as though the note had been applied.
   */
  const render = async (opts: { candidate?: boolean } = {}): Promise<string> => {
    document = compose(page);
    if (session) {
      step("在浏览器里渲染并校验页面");
      validation = await session.load(document);
      shots = validation.shots;
    } else {
      validation = staticOnly(document);
      shots = [];
    }
    if (opts.candidate !== false) remember(validation);
    const errors = countErrors(validation);
    step(errors ? `校验发现 ${errors} 个错误` : "校验通过");
    return renderIssues(validation.issues) || "渲染校验没有发现任何问题。";
  };

  // A revision starts by looking at what it inherited: the model is about to
  // be asked to change a page, and it has never seen it either.
  const opening: string[] = [];
  if (page) {
    opening.push(await render({ candidate: false }));
    opening.push(`\n# 本次要处理的问题\n${seed.base?.note ?? ""}`);
  }
  let observation = opening.join("\n\n");

  for (let turn = 1; turn <= input.maxTurns; turn++) {
    const stop = input.shouldStop ? await input.shouldStop() : null;
    if (stop) throw new ReportAgentStopped(stop);
    const last = turn === input.maxTurns;
    step(turn === 1 ? (page ? "按建议修改报告页面" : "设计报告页面") : `继续修改报告页面（第 ${turn} 轮）`);

    const messages = buildMessages({
      seed,
      page,
      observation: composeObservation({ observation, history, turn, validation, page, last }),
      shots,
      vision: input.vision,
    });

    const res = await chat(messages, input.options);
    tokens += res.usage.total_tokens;

    const actions = parseActions(res.text);
    const notes: string[] = [];
    const did: string[] = [];
    let changed = false;
    let declaredDone = false;
    /** Frames taken this turn by an explicit `look`, shown alongside a render. */
    const extra: ReportShot[] = [];

    for (const action of actions) {
      switch (action.kind) {
        case "write": {
          const cut = truncationIssue(action.page, res.finishReason);
          page = action.page;
          changed = true;
          did.push(`重写整页（${action.page.length} 字符）`);
          if (cut) {
            // Kept as a last-resort candidate, so `page` and `document` stay
            // two views of the same thing even when that thing is a fragment.
            document = compose(page);
            validation = { ...emptyValidation(), issues: [cut] };
            shots = [];
            remember(validation);
            notes.push(renderIssues(validation.issues));
          } else {
            notes.push(await render());
          }
          break;
        }
        case "patch": {
          if (!page) {
            notes.push("现在还没有页面可以修改，请先输出完整的 HTML 文档。");
            did.push("试图在没有页面时打补丁");
            break;
          }
          const result = applyEdits(page, action.edits);
          if (action.errors.length) notes.push(`编辑块格式有问题：\n${action.errors.join("\n")}`);
          if (result.applied) {
            page = result.text;
            changed = true;
            did.push(`应用了 ${result.applied} 处编辑`);
          }
          if (result.failures.length) {
            notes.push(renderEditFailures(result.failures));
            did.push(`${result.failures.length} 处编辑未能应用`);
          }
          if (!result.applied) {
            notes.push("没有任何编辑被应用，页面没有变化。");
          } else {
            notes.push(await render());
          }
          break;
        }
        case "look": {
          if (!session || !page) {
            notes.push(session ? "还没有页面可以截图。" : "本次运行没有浏览器，无法截图。");
            break;
          }
          const shot = await session.shoot({
            id: action.id,
            theme: action.theme,
            width: action.width,
            height: action.height,
            scroll: action.scroll,
          });
          extra.push(shot);
          did.push(`看了 ${shot.label}`);
          notes.push(`已按你的要求渲染：${shot.label}（见下方图片）`);
          break;
        }
        case "inspect": {
          if (!session || !page) {
            notes.push(session ? "还没有页面可以检查。" : "本次运行没有浏览器，无法检查元素。");
            break;
          }
          did.push(`检查了 ${action.selector}`);
          try {
            const nodes = await session.inspect(action.selector);
            notes.push(
              nodes.length
                ? `\`${action.selector}\` 命中 ${nodes.length} 个元素：\n${renderValue(nodes)}`
                : `\`${action.selector}\` 没有命中任何元素。`,
            );
          } catch (e) {
            notes.push(`检查 \`${action.selector}\` 失败：${e instanceof Error ? e.message : String(e)}`);
          }
          break;
        }
        case "data": {
          did.push(`查了 ${action.path}`);
          const found = readPath(input.payload, action.path);
          notes.push(
            found.ok
              ? `\`${action.path}\` 的真实值：\n${renderValue(found.value)}`
              : `\`${action.path}\` 取不到：${found.reason}`,
          );
          break;
        }
        case "done": {
          declaredDone = true;
          did.push("声明完成");
          if (action.note) notes.push(`你的说明已记录：${action.note}`);
          break;
        }
      }
    }

    if (!actions.length) {
      did.push("没有可解析的动作");
      notes.push(
        "这一轮没有解析到任何动作。请用 <vl:write>…</vl:write> 输出完整页面，" +
          "或用 <vl:patch> 提交编辑块，或用 <vl:look/> / <vl:inspect/> / <vl:data/> 继续查看，" +
          "或用 <vl:done/> 收尾。不要只输出解释文字。",
      );
    }

    shots = mergeShots(shots, extra);
    observation = notes.join("\n\n");
    history.push({
      turn,
      did: did.join("；") || "无动作",
      errors: validation ? countErrors(validation) : 0,
      warnings: validation ? validation.issues.filter((i) => i.level === "warn").length : 0,
    });

    idle = changed ? 0 : idle + 1;

    // Only a page this run produced can settle it. Otherwise a revision whose
    // base page was already clean would return at turn one having changed
    // nothing, which is the same bug as the one `candidate` guards.
    if (validation?.ok && (good || best)) {
      const polishable = validation.issues.filter((i) => i.level === "warn" && POLISH_KINDS.has(i.kind));
      const settled = declaredDone || !polishable.length || polished || idle >= 2 || last;
      if (settled) {
        step(
          `页面已通过校验（第 ${turn} 轮${polishable.length ? `，仍有 ${polishable.length} 项可改善未处理` : ""}）`,
        );
        return done(good ?? best, { turns: turn, tokens, history });
      }
      // One turn, on the defects a browser can measure but not repair. If it
      // comes back worse, `good` is what gets returned.
      polished = true;
      observation = `${observation}\n\n页面已经通过校验，但下面这些显示问题仍然存在。这是最后一轮修改：只修这些，不要重构页面，改完直接输出 <vl:done/>。\n${renderIssues(polishable)}`;
      continue;
    }

    if (declaredDone && validation && !validation.ok) {
      observation = `${observation}\n\n页面仍然没有通过校验，不能收尾。请先修掉上面的「必须修复」项。`;
    }
  }

  step(`用尽 ${input.maxTurns} 轮仍未产出通过校验的页面`);
  return done(good ?? best, { turns: input.maxTurns, tokens, history });
}

/* ---------------------------------------------------------------- messages */

/**
 * Only the current page and the latest observation travel, so a sixth turn
 * costs what the second did. What the model loses — its own earlier
 * reasoning — comes back as the digest, which is the part that stops it
 * looking at dark mode three times.
 */
function buildMessages(input: {
  seed: AgentSeed;
  page: string;
  observation: string;
  shots: ReportShot[];
  vision: boolean;
}): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: input.seed.system },
    { role: "user", content: input.seed.task },
  ];
  if (!input.page) {
    if (input.observation) messages.push({ role: "user", content: input.observation });
    return messages;
  }

  messages.push({ role: "assistant", content: input.page });

  const images = input.vision ? input.shots.slice(0, MAX_IMAGES) : [];
  if (!images.length) {
    messages.push({ role: "user", content: input.observation });
    return messages;
  }

  const parts: ContentPart[] = [
    { type: "text", text: `${input.observation}\n\n# 页面现在的样子\n${describeShots(images)}` },
  ];
  for (const shot of images) {
    parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot.bytes.toString("base64")}` } });
  }
  messages.push({ role: "user", content: parts });
  return messages;
}

/** The observation, with the digest of what has already been tried. */
function composeObservation(input: {
  observation: string;
  history: AgentTurnNote[];
  turn: number;
  validation: ValidationResult | null;
  page: string;
  last: boolean;
}): string {
  if (!input.page && !input.observation) return "";

  const parts: string[] = [];
  if (input.history.length) {
    parts.push(
      `# 已经做过的事\n${input.history
        .map((h) => `第 ${h.turn} 轮：${h.did} → ${h.errors ? `${h.errors} 个错误` : "无错误"}${h.warnings ? `、${h.warnings} 项可改善` : ""}`)
        .join("\n")}`,
    );
  }
  if (input.observation) {
    parts.push(`${input.history.length ? `# 上一轮（第 ${input.turn - 1} 轮）的结果` : "# 页面现在的状态"}\n${input.observation}`);
  }
  parts.push(
    input.last
      ? "# 这是最后一轮\n只做必要的修复，确保这一轮结束时页面是可用的。"
      : "# 接下来\n还有「必须修复」项就先修掉；只剩可改善项且你认为够好了，就输出 <vl:done/>。改一两处请用 <vl:patch>，不要整份重写。",
  );
  return parts.join("\n\n");
}

/* ----------------------------------------------------------------- helpers */

const countErrors = (v: ValidationResult) => v.issues.filter((i) => i.level === "error").length;

/** A page cut off mid-tag fails every other check for confusing reasons. */
export function truncationIssue(page: string, finishReason: string | null): ValidationIssue | null {
  const complete = /<\/html\s*>$/i.test(page.trim());
  if (complete) return null;
  return {
    level: "error",
    kind: "truncated",
    message:
      finishReason === "length"
        ? "回答在写完之前达到了长度上限，页面不完整。别整份重写 —— 用 <vl:patch> 只改需要改的那几行。"
        : "输出不是一个完整的 HTML 文档（缺少结尾的 </html>）。",
  };
}

const emptyValidation = (): ValidationResult => ({
  ok: false,
  issues: [],
  stats: { textChars: 0, domNodes: 0, scrollHeight: 0, overflowPx: 0, printOverflowPx: 0, durationMs: 0 },
  shots: [],
});

function staticOnly(doc: string): ValidationResult {
  const issues = staticChecks(doc);
  issues.push({
    level: "warn",
    kind: "no-browser",
    message: "无法启动校验浏览器，已跳过运行时校验与截图。",
  });
  return { ...emptyValidation(), ok: !issues.some((i) => i.level === "error"), issues };
}

/** A frame taken by name replaces the one it was taken instead of. */
function mergeShots(current: ReportShot[], extra: ReportShot[]): ReportShot[] {
  if (!extra.length) return current;
  const byId = new Map(current.map((s) => [s.id, s]));
  for (const shot of extra) byId.set(shot.id, shot);
  return [...byId.values()];
}

function done(
  state: { page: string; document: string; validation: ValidationResult; shots: ReportShot[] } | null,
  meta: { turns: number; tokens: number; history: AgentTurnNote[] },
): RunAgentResult {
  const fallback = state ?? {
    page: "",
    document: "",
    validation: {
      ...emptyValidation(),
      issues: [{ level: "error" as const, kind: "no-output", message: "模型没有产出可用页面。" }],
    },
    shots: [],
  };
  return { ...fallback, ...meta };
}
