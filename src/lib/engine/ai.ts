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
}

export interface ChatResult {
  text: string;
  reasoning: string;
  usage: CompletionUsage;
  model: string;
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
    if (chunk.usage) {
      usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
      };
    }
  }

  return { text, reasoning, usage, model };
}

/**
 * Structured-output helper: asks for JSON, strips code fences and retries once
 * with the failure surfaced back to the model.
 */
export async function chatJson<T>(
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<{ data: T; usage: CompletionUsage; raw: string }> {
  let lastError = "";
  let attemptMessages = messages;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat(attemptMessages, options);
    const parsed = tryParseJson<T>(res.text);
    if (parsed.ok) return { data: parsed.value, usage: res.usage, raw: res.text };
    lastError = parsed.reason;
    attemptMessages = [
      ...messages,
      { role: "assistant", content: res.text },
      {
        role: "user",
        content:
          `你上一次返回的内容无法解析为 JSON：${lastError}。` +
          `请只返回严格合法的 JSON 对象，不要 Markdown 代码块、不要解释性文字、不要多余字段。`,
      },
    ];
  }

  throw new Error(`model did not return valid JSON: ${lastError}`);
}

export function tryParseJson<T>(input: string): { ok: true; value: T } | { ok: false; reason: string } {
  const raw = input.trim();
  const withoutFence = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const candidates = [withoutFence];
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(withoutFence.slice(firstBrace, lastBrace + 1));
  }
  const firstBracket = withoutFence.indexOf("[");
  const lastBracket = withoutFence.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(withoutFence.slice(firstBracket, lastBracket + 1));
  }

  let reason = "not parseable as JSON";
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as T };
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, reason };
}
