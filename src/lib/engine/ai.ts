import OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  const baseURL = process.env.AI_BASE_URL;
  const apiKey = process.env.AI_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error("AI_BASE_URL / AI_API_KEY are not configured on the server");
  }
  client = new OpenAI({
    baseURL,
    apiKey,
    timeout: 1000 * 60 * 4,
    maxRetries: 1,
  });
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
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * qwen3.8-omni-flash supports a reasoning mode. It measurably improves prompt
   * design and report writing, but is ~3x slower, so it is off by default and
   * only enabled for the two low-volume, high-value calls (planning, report).
   */
  thinking?: boolean;
  /** qwen-omni only streams; the SDK accumulates chunks for us. */
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
 * Text-only chat completion against qwen3.8-omni-flash.
 * The Omni family requires `stream: true`, so every call streams and is
 * accumulated server-side; callers only ever see the final text.
 */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResult> {
  const openai = getClient();
  const model = options.model ?? process.env.AI_MODEL ?? "qwen3.8-omni-flash";

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
    options.thinking ?? process.env.AI_ENABLE_THINKING === "true";

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
  options: ChatOptions = {},
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
