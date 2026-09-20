import OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import type { ModelRuntime } from "@/lib/models/registry";

/**
 * One client per endpoint. Models are configured in the database now and a
 * single run can talk to two of them (an omni model for audio, a multimodal one
 * for everything else), so the old module-level singleton would have pinned the
 * whole process to whichever endpoint happened to be used first.
 *
 * The key includes the API key so rotating a model's credential in the settings
 * page takes effect on the next call rather than on the next restart.
 */
const clients = new Map<string, OpenAI>();

function getClient(model: ModelRuntime): OpenAI {
  if (!model.baseUrl || !model.apiKey) {
    throw new Error(`模型「${model.name}」缺少接口地址或 API Key`);
  }
  const cacheKey = `${model.baseUrl}\u0000${model.apiKey}`;
  const existing = clients.get(cacheKey);
  if (existing) return existing;
  const client = new OpenAI({
    baseURL: model.baseUrl,
    apiKey: model.apiKey,
    timeout: 1000 * 60 * 4,
    maxRetries: 1,
  });
  clients.set(cacheKey, client);
  return client;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatOptions {
  /** Which configured model runs this call. Required — there is no ambient default. */
  model: ModelRuntime;
  temperature?: number;
  maxTokens?: number;
  /**
   * Reasoning mode. It measurably improves prompt design and report writing but
   * is ~3x slower, so it is enabled per call for the two low-volume, high-value
   * ones (planning, report) and otherwise follows the model's own setting.
   */
  thinking?: boolean;
  /** The Omni family only streams; the SDK accumulates chunks for us. */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  /**
   * What this call is for, in Chinese, e.g. "报告生成". It only shows up in
   * error messages — which is exactly where a failure three layers down in a
   * preview needs it, because "did not return valid JSON" on its own tells the
   * operator nothing about which of the five model calls broke.
   */
  label?: string;
}

export interface ChatResult {
  text: string;
  reasoning: string;
  usage: CompletionUsage;
  model: string;
  /**
   * `stop` / `length` / `content_filter` …, or null when the stream ended
   * without one — which means the response was cut off in transit rather than
   * finished by the model, and the accumulated text is a fragment.
   */
  finishReason: string | null;
}

/** Human-readable "why did the model stop", for error messages. */
function describeFinish(finishReason: string | null): string {
  switch (finishReason) {
    case "stop":
      return "正常结束";
    case "length":
      return "达到 max_tokens 上限，输出被截断";
    case "content_filter":
      return "被内容安全策略拦截";
    case null:
      return "流在收到结束标记前中断（网关/网络断开），输出是半截的";
    default:
      return finishReason;
  }
}

/** One line describing a finished call: model, why it stopped, how much it wrote. */
export function describeCall(model: ModelRuntime, res: ChatResult): string {
  return [
    `模型「${model.name}」(${res.model})`,
    `结束原因=${describeFinish(res.finishReason)}`,
    `输出 ${res.usage.completion_tokens} tokens / ${res.text.length} 字`,
    res.reasoning ? `思考 ${res.reasoning.length} 字` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** V8 puts the offset in the message; it is the only place the fault's location is. */
function positionOf(reason: string): number | null {
  const m = /at position (\d+)/.exec(reason);
  return m ? Number(m[1]) : null;
}

/**
 * The text around a parse fault. A head-and-tail excerpt is useless when the
 * defect is in the middle of ten thousand characters — "position 4409" needs
 * the characters at position 4409, which is the one thing that says whether the
 * model wrote a trailing comma, a bare key, or a Chinese word where a number
 * belongs.
 */
export function faultWindow(text: string, reason: string, span = 90): string {
  const pos = positionOf(reason);
  if (pos === null || pos > text.length) return "";
  const from = Math.max(0, pos - span);
  const to = Math.min(text.length, pos + span);
  return `${from > 0 ? "…" : ""}${text.slice(from, pos)}⟪出错在这里⟫${text.slice(pos, to)}${to < text.length ? "…" : ""}`;
}

/** Head + tail of the model's own words, short enough to fit in a stored error. */
export function excerpt(text: string, head = 260, tail = 160): string {
  const t = text.trim();
  if (!t) return "（空）";
  if (t.length <= head + tail + 20) return t;
  return `${t.slice(0, head)} …（省略 ${t.length - head - tail} 字）… ${t.slice(-tail)}`;
}

/**
 * Chat completion against one configured OpenAI-compatible endpoint. Every call
 * streams and is accumulated server-side — the Omni models require
 * `stream: true` — so callers only ever see the final text.
 */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<ChatResult> {
  const openai = getClient(options.model);
  const model = options.model.model;

  const params: ChatCompletionCreateParamsStreaming = {
    model,
    messages: messages as never,
    stream: true,
    stream_options: { include_usage: true },
    temperature: options.temperature ?? 0.4,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
  };
  // `enable_thinking` is a Model Studio extension of the OpenAI-compatible API.
  (params as unknown as Record<string, unknown>).enable_thinking =
    options.thinking ?? options.model.thinking;

  const stream = await openai.chat.completions.create(
    params,
    options.signal ? { signal: options.signal } : undefined,
  );

  let text = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: CompletionUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta as
      | { content?: string; reasoning_content?: string }
      | undefined;
    if (delta?.reasoning_content) reasoning += delta.reasoning_content;
    if (delta?.content) {
      text += delta.content;
      options.onDelta?.(delta.content);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
      };
    }
  }

  const result: ChatResult = { text, reasoning, usage, model, finishReason };

  // Nothing at all came back. Failing here with the endpoint's own reason beats
  // letting an empty string travel on and blow up as "not parseable as JSON".
  if (!text.trim() && !reasoning.trim()) {
    throw new Error(
      `${options.label ?? "模型调用"}失败：${describeCall(options.model, result)}，没有返回任何内容。` +
        (finishReason === "content_filter"
          ? "请检查提示词或样本中是否含有被拦截的内容。"
          : "请检查该模型是否支持当前请求（音频 / enable_thinking / max_tokens）。"),
    );
  }
  if (finishReason === null) {
    console.warn(
      `[ai] ${options.label ?? "模型调用"}：${describeCall(options.model, result)}（响应未正常结束）`,
    );
  }

  return result;
}

/**
 * Structured-output helper: asks for JSON, tolerates fences / 思考前缀 / 尾巴上的
 * 解释 / 小的语法毛病, and retries once with the failure surfaced back to the
 * model — including the text around the fault, which is what makes the retry
 * about the actual defect rather than a generic "please return JSON".
 *
 * When the retry also comes back truncated, a best-effort repair of the
 * fragment is accepted rather than losing a call that may have taken minutes —
 * the callers all normalize whatever they get.
 */
export async function chatJson<T>(
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<{ data: T; usage: CompletionUsage; raw: string }> {
  const label = options.label ?? "模型调用";
  const attempts = 2;
  let lastDetail = "";
  let lastFault = "";
  let lastCall = "";
  let lastRaw = "";
  let attemptMessages = messages;
  /** The best partial answer seen so far, used if no attempt comes back whole. */
  let salvaged: { data: T; usage: CompletionUsage; raw: string; call: string } | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await chat(attemptMessages, options);
    const parsed = tryParseJson<T>(res.text);
    const cutShort = res.finishReason === "length" || res.finishReason === null;
    const isLast = attempt === attempts - 1;

    // Only a truncation actually loses content, and only that is worth another
    // call: a trailing comma corrected in place costs nothing and asking the
    // model again would just spend three more minutes for the same report.
    const lossy = parsed.ok && parsed.fix === "truncated";
    if (parsed.ok && (!lossy || isLast)) {
      if (parsed.fix !== "clean") {
        console.warn(
          `[ai] ${label}：模型输出${parsed.fix === "relaxed" ? "有语法瑕疵，已就地修正" : "不完整，已按截断修复"}解析 — ` +
            describeCall(options.model, res),
        );
      }
      return { data: parsed.value, usage: res.usage, raw: res.text };
    }

    if (parsed.ok) {
      // Truncated but salvageable: keep it in case the retry comes back worse.
      salvaged = { data: parsed.value, usage: res.usage, raw: res.text, call: describeCall(options.model, res) };
    }
    lastDetail = parsed.ok ? "输出在 JSON 闭合前就结束了" : parsed.reason;
    lastFault = parsed.ok ? "" : parsed.fault;
    lastCall = describeCall(options.model, res);
    lastRaw = res.text;

    if (isLast) break;

    if (cutShort || parsed.ok) {
      // Truncation: echoing the half-finished answer back would only eat more
      // of the same budget that ran out, so ask for a shorter one instead.
      attemptMessages = [
        ...messages,
        {
          role: "user",
          content:
            `你上一次的输出没有完整闭合就结束了（${describeFinish(res.finishReason)}）。` +
            `请重新输出完整的 JSON：大幅精简文字（每段 2-3 句）、减少条目数量，` +
            `确保所有括号都闭合。只返回 JSON 对象本身，不要 Markdown 代码块与解释。`,
        },
      ];
    } else {
      attemptMessages = [
        ...messages,
        { role: "assistant", content: excerpt(res.text, 1200, 600) },
        {
          role: "user",
          content:
            `你上一次返回的内容无法解析为 JSON：${lastDetail}。` +
            (lastFault ? `出错位置附近的原文：${lastFault}\n` : "") +
            `请只返回严格合法的 JSON 对象：每个键名都带双引号、} 与 ] 前不要多余逗号、` +
            `该填数字的位置填数字，不要 Markdown 代码块、不要解释性文字、不要多余字段。`,
        },
      ];
    }
  }

  if (salvaged) {
    console.warn(`[ai] ${label}：重试后仍未拿到完整 JSON，沿用上一次的截断修复结果 — ${salvaged.call}`);
    return { data: salvaged.data, usage: salvaged.usage, raw: salvaged.raw };
  }

  throw new Error(
    `${label}未返回合法 JSON：${lastDetail}。${lastCall}。` +
      (lastFault ? `出错位置附近：${lastFault}。` : "") +
      `模型原文：${excerpt(lastRaw)}`,
  );
}

/**
 * How much the answer had to be bent to parse:
 * - `clean`     as written (possibly after unwrapping a fence or prose);
 * - `relaxed`   a syntax defect was corrected — trailing comma, bare key, NaN —
 *               losing nothing of what the model said;
 * - `truncated` the tail was cut off at the last complete value, so content is
 *               genuinely missing.
 */
export type JsonFix = "clean" | "relaxed" | "truncated";

export type JsonParseResult<T> =
  | { ok: true; value: T; fix: JsonFix }
  | { ok: false; reason: string; fault: string };

/**
 * Parse whatever the model said into JSON, in order of how much it distorts the
 * answer: the text as-is, then unwrapped (code fence / <think> prefix / prose
 * around it), then the first balanced JSON value inside it, and finally — only
 * as a last resort, and flagged — a repair of a fragment that was cut off.
 *
 * The reported reason always comes from the unwrapped text, never from one of
 * the salvage candidates: a slice from the first "[" to the last "]" of a
 * truncated object parses the first array and then complains about the comma
 * after it, and reporting *that* ("Unexpected non-whitespace character after
 * JSON at position 125") sent operators looking for a syntax bug when the real
 * story was "the answer never finished".
 */
export function tryParseJson<T>(input: string): JsonParseResult<T> {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "模型没有返回任何内容", fault: "" };

  const direct = parseJson<T>(raw);
  if (direct.ok) return { ok: true, value: direct.value, fix: "clean" };

  const unwrapped = unwrap(raw);
  const cleaned = unwrapped === raw ? direct : parseJson<T>(unwrapped);
  if (cleaned.ok) return { ok: true, value: cleaned.value, fix: "clean" };

  const fragment = firstJsonValue(unwrapped) ?? unwrapped;
  if (fragment !== unwrapped) {
    const embedded = parseJson<T>(fragment);
    if (embedded.ok) return { ok: true, value: embedded.value, fix: "clean" };
  }

  // Cheap syntax defects first: they cost nothing to undo, so a report with a
  // stray comma in its middle should never be thrown away over it.
  const relaxed = relaxJson(fragment);
  if (relaxed) {
    const loosened = parseJson<T>(relaxed);
    if (loosened.ok) return { ok: true, value: loosened.value, fix: "relaxed" };
  }

  // Only then the lossy one.
  const repaired = repairTruncated(relaxed ?? fragment);
  if (repaired) {
    const salvaged = parseJson<T>(repaired);
    if (salvaged.ok) return { ok: true, value: salvaged.value, fix: "truncated" };
  }

  return { ok: false, reason: cleaned.reason, fault: faultWindow(unwrapped, cleaned.reason) };
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;
/** Bare words a model writes where a value belongs; none of them are JSON. */
const BAD_LITERALS = new Set(["NaN", "Infinity", "undefined", "None", "nan"]);

/**
 * Correct the JSON-ish syntax models actually produce, string-aware so nothing
 * inside a quoted sentence is touched:
 *
 *   {"a":1,}          trailing comma before } or ]
 *   {"a":1,b:2}       bare key after a comma
 *   {label,value}     the contract's own shorthand, copied literally
 *   {"a":NaN}         a non-number where a number was computed
 *
 * Returns null when there was nothing to correct, so the caller can tell a
 * repair apart from a no-op.
 */
function relaxJson(text: string): string | null {
  let out = "";
  let changed = false;
  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "{" || c === "[") {
      stack.push(c);
      out += c;
      continue;
    }
    if (c === "}" || c === "]") {
      stack.pop();
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      // a comma with nothing after it, or another comma, or a closing bracket
      if (j >= text.length || text[j] === "}" || text[j] === "]" || text[j] === ",") {
        changed = true;
        continue;
      }
      out += c;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < text.length && IDENT.test(text[j])) j++;
      const token = text.slice(i, j);
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      const prev = out.trimEnd().slice(-1);
      const inObject = stack[stack.length - 1] === "{";
      const atKey = inObject && (prev === "{" || prev === ",");

      if (atKey && text[k] === ":") {
        out += `"${token}"`;
        changed = true;
      } else if (atKey && (text[k] === "," || text[k] === "}")) {
        // `{label,value,unit}` — a key with no value at all.
        out += `"${token}":null`;
        changed = true;
      } else if (BAD_LITERALS.has(token) && (prev === ":" || prev === "," || prev === "[")) {
        out += "null";
        changed = true;
      } else {
        out += token;
      }
      i = j - 1;
      continue;
    }
    // A bare word where a value belongs — `"value": 数字`, `"data":[数字]` —
    // which is what a model does when it copies a placeholder out of a
    // contract. Whatever it is, it is not JSON, and null is the honest reading.
    if (!/[\s\-0-9]/.test(c)) {
      const prev = out.trimEnd().slice(-1);
      const inArray = stack[stack.length - 1] === "[";
      const atValue = prev === ":" || prev === "[" || (prev === "," && inArray);
      if (atValue) {
        let j = i;
        while (j < text.length && !/[,}\]]/.test(text[j]) && text[j] !== '"') j++;
        out += "null";
        changed = true;
        i = j - 1;
        continue;
      }
    }
    out += c;
  }

  return changed ? out : null;
}

function parseJson<T>(text: string): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Strip the two wrappers models keep adding: a reasoning prefix (`<think>…`,
 * which some endpoints put in `content` instead of `reasoning_content`) and a
 * Markdown code fence. Only applied after a direct parse failed, so JSON that
 * legitimately contains a fence inside a Markdown block is never touched.
 */
function unwrap(raw: string): string {
  let text = raw;
  const thinkEnd = text.lastIndexOf("</think>");
  if (thinkEnd >= 0) text = text.slice(thinkEnd + "</think>".length).trim();
  else if (text.startsWith("<think>")) text = text.slice("<think>".length).trim();

  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)(?:```|$)/.exec(text);
  if (fenced && fenced[1].trim()) text = fenced[1].trim();
  return text.trim();
}

/**
 * The first balanced `{…}` / `[…]` in the text, string-aware so a brace inside a
 * quoted sentence does not close it. Returns the fragment from the opening
 * bracket to the end when it never closes — that is what the repair works on.
 */
function firstJsonValue(text: string): string | null {
  const start = firstIndexOfEither(text, "{", "[");
  if (start < 0) return null;

  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return text.slice(start);
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function firstIndexOfEither(text: string, a: string, b: string): number {
  const ia = text.indexOf(a);
  const ib = text.indexOf(b);
  if (ia < 0) return ib;
  if (ib < 0) return ia;
  return Math.min(ia, ib);
}

/**
 * Best-effort rescue of a fragment that stopped mid-value: walk back to the last
 * point where every value so far was complete (a comma, or a closing bracket)
 * and close the containers that are still open. What survives is everything the
 * model managed to say before it was cut off.
 */
function repairTruncated(fragment: string): string | null {
  const start = firstIndexOfEither(fragment, "{", "[");
  if (start < 0) return null;
  const text = fragment.slice(start);

  // Where the parser gave up. Walking back from the end of a 10k-character
  // answer whose defect sits at character 4409 would need thousands of
  // attempts; starting at the fault needs one.
  let faultPos: number | null = null;
  try {
    JSON.parse(text);
    return text;
  } catch (e) {
    faultPos = positionOf(e instanceof Error ? e.message : String(e));
  }

  const cuts: { end: number; closers: string }[] = [];
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      stack.pop();
      // everything up to and including this bracket is a complete value
      cuts.push({ end: i + 1, closers: [...stack].reverse().join("") });
    } else if (c === ",") {
      // everything before the comma is a complete value
      cuts.push({ end: i, closers: [...stack].reverse().join("") });
    }
  }

  let from = cuts.length - 1;
  if (faultPos !== null) {
    while (from >= 0 && cuts[from].end > faultPos) from--;
  }

  for (let i = from, tried = 0; i >= 0 && tried < 200; i--, tried++) {
    const candidate = text.slice(0, cuts[i].end) + cuts[i].closers;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* walk further back */
    }
  }
  return null;
}
