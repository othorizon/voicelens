import type { ExtraFieldDef, JsonObject } from "@/lib/types";

const ROLE_ALIASES: Record<string, string> = {
  user: "user",
  human: "user",
  customer: "user",
  client: "user",
  用户: "user",
  顾客: "user",
  assistant: "assistant",
  ai: "assistant",
  bot: "assistant",
  agent: "assistant",
  助手: "assistant",
  客服: "assistant",
  system: "system",
  tool: "tool",
  function: "tool",
};

const SESSION_KEYS = ["sessionId", "session_id", "sessionid", "sid", "conversationId", "conversation_id", "dialogId", "chatId"];
const USER_KEYS = ["userId", "user_id", "userid", "uid", "customerId", "customer_id"];
const TIME_KEYS = ["timestamp", "time", "createdAt", "created_at", "createTime", "create_time", "ts", "datetime", "date"];
const AUDIO_KEYS = ["audio", "audioFile", "audio_file", "audioPath", "audio_path", "audioUrl", "audio_url", "wav", "voice", "voiceFile", "file", "filename", "media"];
const EXTRA_KEYS = ["extra", "extras", "metadata", "meta", "attributes", "extend"];
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|opus|webm|amr|pcm)$/i;

function firstKey(obj: JsonObject, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

/** Deep search for any string that looks like an audio filename. */
function findAudioValue(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value == null) return undefined;
  if (typeof value === "string") return AUDIO_EXT.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAudioValue(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as JsonObject)) {
      if (AUDIO_KEYS.includes(k) && typeof v === "string") return v;
      const found = findAudioValue(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function normalizeRole(raw: unknown): string {
  const key = String(raw ?? "").toLowerCase().trim();
  return ROLE_ALIASES[key] ?? ROLE_ALIASES[key.replace(/[\s-]/g, "")] ?? key ?? "user";
}

/** OpenAI content can be a string or a list of typed parts. */
export function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as JsonObject;
          if (typeof p.text === "string") return p.text;
          if (p.type === "input_text" && typeof p.input_text === "string") return p.input_text;
          if (typeof p.content === "string") return p.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    const p = content as JsonObject;
    if (typeof p.text === "string") return p.text;
    if (typeof p.content === "string") return p.content;
  }
  return "";
}

export function parseTimestamp(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    // seconds vs milliseconds
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return parseTimestamp(Number(text));
  // "2026-09-01 10:00:00" is valid SQL but not ISO
  const isoish = text.replace(" ", "T");
  for (const candidate of [text, isoish, isoish.endsWith("Z") ? isoish : `${isoish}Z`]) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

export interface NormalizedMessage {
  sessionKey: string;
  userKey: string;
  role: string;
  content: unknown;
  contentText: string;
  occurredAt: string | null;
  audio: string | null;
  extra: JsonObject;
  seqHint?: number;
}

/** Flatten one JSONL line into 1..n normalized messages. */
export function normalizeLine(line: string, fallbackName: string, lineNo: number): NormalizedMessage[] {
  let obj: JsonObject;
  try {
    obj = JSON.parse(line) as JsonObject;
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object") return [];

  // Session-shaped record: { sessionId, userId, messages: [...] }
  const list = obj.messages ?? obj.dialogue ?? obj.turns ?? obj.history;
  if (Array.isArray(list)) {
    return list
      .map((entry, idx) => normalizeEntry(entry as JsonObject, obj, fallbackName, idx))
      .filter(Boolean) as NormalizedMessage[];
  }

  const single = normalizeEntry(obj, obj, fallbackName, obj.seq as number | undefined);
  if (!single) return [];
  if (!single.sessionKey) single.sessionKey = `${fallbackName}:${lineNo}`;
  return [single];
}

function normalizeEntry(
  entry: JsonObject,
  root: JsonObject,
  fallbackName: string,
  idx?: number,
): NormalizedMessage | null {
  const merged: JsonObject = { ...root, ...entry };
  const message = (merged.message ?? merged.msg) as JsonObject | undefined;
  const source: JsonObject = message && typeof message === "object" ? { ...merged, ...message } : merged;

  const role = normalizeRole(source.role ?? merged.role);
  let content = source.content !== undefined ? source.content : source.text ?? source.content_text;
  let contentText = extractText(content);

  // Some exports nest the payload one level deeper.
  if (!contentText && content && typeof content === "object") {
    contentText = extractText((content as JsonObject).text);
  }
  if (content === undefined || content === null) content = contentText;

  const sessionKey = String(
    firstKey(merged, SESSION_KEYS) ?? firstKey(source, SESSION_KEYS) ?? fallbackName,
  ).trim();
  const userKey = String(
    firstKey(merged, USER_KEYS) ?? firstKey(source, USER_KEYS) ?? "anonymous",
  ).trim();

  const occurredAt =
    parseTimestamp(firstKey(source, TIME_KEYS)) ?? parseTimestamp(firstKey(merged, TIME_KEYS));

  const extraRaw = (firstKey(merged, EXTRA_KEYS) ?? firstKey(source, EXTRA_KEYS) ?? {}) as unknown;
  const extra: JsonObject =
    extraRaw && typeof extraRaw === "object" && !Array.isArray(extraRaw)
      ? (extraRaw as JsonObject)
      : {};

  const audio =
    (firstKey(merged, AUDIO_KEYS) as string | undefined) ??
    (firstKey(source, AUDIO_KEYS) as string | undefined) ??
    findAudioValue(merged) ??
    null;

  const seqHint =
    typeof (source.seq as unknown) === "number"
      ? (source.seq as number)
      : typeof (source.index as unknown) === "number"
        ? (source.index as number)
        : idx;

  if (!role && !contentText && !audio) return null;

  return {
    sessionKey,
    userKey: userKey || "anonymous",
    role: role || "user",
    content: content ?? contentText,
    contentText,
    occurredAt,
    audio,
    extra,
    seqHint,
  };
}

export interface SessionBundle {
  sessionKey: string;
  userKey: string;
  messages: (NormalizedMessage & { seq: number })[];
  startedAt: string | null;
  endedAt: string | null;
  extra: JsonObject;
  digest: string;
}

/** Group flat messages into sessions and derive counters + transcript digest. */
export function bundleSessions(
  items: NormalizedMessage[],
): SessionBundle[] {
  const map = new Map<string, NormalizedMessage[]>();
  for (const item of items) {
    const arr = map.get(item.sessionKey) ?? [];
    arr.push(item);
    map.set(item.sessionKey, arr);
  }

  const out: SessionBundle[] = [];
  for (const [sessionKey, msgs] of map) {
    msgs.sort((a, b) => {
      const ta = a.occurredAt ? Date.parse(a.occurredAt) : 0;
      const tb = b.occurredAt ? Date.parse(b.occurredAt) : 0;
      if (ta !== tb) return ta - tb;
      return (a.seqHint ?? 0) - (b.seqHint ?? 0);
      });

    const withSeq = msgs.map((m, i) => ({ ...m, seq: i }));
    const times = withSeq.map((m) => (m.occurredAt ? Date.parse(m.occurredAt) : NaN)).filter((n) => !Number.isNaN(n));
    const startedAt = times.length ? new Date(Math.min(...times)).toISOString() : null;
    const endedAt = times.length ? new Date(Math.max(...times)).toISOString() : null;

    const userKeys = [...new Set(withSeq.map((m) => m.userKey))];
    const extra = withSeq.reduce<JsonObject>((acc, m) => ({ ...acc, ...m.extra }), {});

    const t0 = times.length ? Math.min(...times) : 0;
    const digest = withSeq
      .map((m) => {
        const offset = m.occurredAt && t0 ? fmtOffset(Date.parse(m.occurredAt) - t0) : "";
        const speaker = m.role === "user" ? "用户" : m.role === "assistant" ? "AI" : m.role;
        const flags = describeExtra(m.extra);
        return `${offset ? `[${offset}] ` : ""}${speaker}${flags ? `(${flags})` : ""}: ${truncate(m.contentText, 400)}`;
      })
      .join("\n");

    out.push({
      sessionKey,
      userKey: userKeys.length === 1 ? userKeys[0] : userKeys[0] ?? "anonymous",
      messages: withSeq,
      startedAt,
      endedAt,
      extra,
      digest,
    });
  }
  return out;
}

function fmtOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function describeExtra(extra: JsonObject): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (v === false || v === null || v === undefined || v === "") continue;
    if (typeof v === "boolean" && v) parts.push(EXTRA_LABEL[k] ?? k);
    else parts.push(`${EXTRA_LABEL[k] ?? k}=${String(v)}`);
  }
  return parts.slice(0, 4).join(",");
}

const EXTRA_LABEL: Record<string, string> = {
  interrupted: "打断",
  is_interrupted: "打断",
  interrupt: "打断",
  barge_in: "打断",
  emotion: "情绪",
  sentiment: "情绪",
  asr_confidence: "ASR置信",
  latency_ms: "延迟ms",
  tts_latency: "TTS延迟",
  fallback: "兜底",
  transferred: "转人工",
  resolved: "已解决",
};

/* ------------------------------------------------------- schema inference */

/** Suggest an extra schema from observed data — the user edits it afterwards. */
export function inferExtraSchema(msgs: NormalizedMessage[], limit = 2000): ExtraFieldDef[] {
  const stats = new Map<string, { values: Map<string, number>; numeric: boolean; count: number }>();

  for (const m of msgs.slice(0, limit)) {
    for (const [k, v] of Object.entries(m.extra)) {
      if (v === null || v === undefined) continue;
      const entry = stats.get(k) ?? { values: new Map(), numeric: true, count: 0 };
      entry.count++;
      if (typeof v === "number") {
        entry.values.set(String(v), (entry.values.get(String(v)) ?? 0) + 1);
      } else if (typeof v === "boolean") {
        entry.numeric = false;
        entry.values.set(String(v), (entry.values.get(String(v)) ?? 0) + 1);
      } else {
        entry.numeric = false;
        const key = String(v);
        if (entry.values.size < 60) entry.values.set(key, (entry.values.get(key) ?? 0) + 1);
      }
      stats.set(k, entry);
    }
  }

  const defs: ExtraFieldDef[] = [];
  for (const [name, s] of [...stats.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const distinct = [...s.values.keys()];
    const kind: ExtraFieldDef["kind"] =
      typeof [...s.values.keys()][0] === "string" && /^(true|false)$/.test([...s.values.keys()][0])
        ? "boolean"
        : s.numeric
          ? "number"
          : distinct.length <= 12
            ? "enum"
            : "text";

    const isSentiment = /emotion|sentiment|mood|情绪/i.test(name);
    defs.push({
      name,
      label: EXTRA_LABEL[name] ?? prettifyLabel(name),
      kind: isSentiment ? "sentiment" : kind,
      scope: "message",
      options: kind === "enum" || isSentiment ? distinct.slice(0, 24) : undefined,
      description: "",
      usage: isSentiment || kind === "boolean" || kind === "enum" ? "segment" : kind === "number" ? "metric" : "context",
      positive: undefined,
    });
  }
  return defs.slice(0, 30);
}

function prettifyLabel(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
