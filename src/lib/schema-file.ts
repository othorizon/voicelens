/**
 * extra 字段 schema 描述文件：命名、解析、合并与规范文本。
 *
 * 这个文件是「写数据的人」与「分析平台」之间的契约：数据方在 zip 里放一个
 * JSON，说明 extra 里每个字段是什么意思、该怎么用；导入时平台直接读它，
 * 省掉在页面上逐个字段手工配置。
 *
 * Pure module by design — the importer (Node), Server Actions and the
 * browser-side schema editor all parse with exactly the same rules, so it must
 * not reach for db / storage / fs.
 */
import type { ExtraFieldDef, ExtraFieldKind, ExtraFieldUsage } from "@/lib/types";

export const SCHEMA_FILE_VERSION = 1;

/**
 * Accepted file names, matched on the base name, case-insensitively, at any
 * depth inside the archive. The first one is what the docs and the downloadable
 * template use; the rest are there because people will guess.
 */
export const SCHEMA_FILE_NAMES = [
  "voicelens.schema.json",
  "voicelens-schema.json",
  "schema.json",
  "extra-schema.json",
  "extra_schema.json",
  "extra.schema.json",
] as const;

export const PRIMARY_SCHEMA_FILE = SCHEMA_FILE_NAMES[0];

/**
 * How a file's fields meet the schema already configured on the data source.
 *
 * `merge` only touches the fields the file names; `replace` makes the schema
 * exactly what the file says. The file may declare its own mode; when it does
 * not, the caller decides (zip import merges, the editor's manual import
 * replaces — see `SCHEMA_FILE_SPEC`).
 */
export type SchemaFileMode = "merge" | "replace";

export interface ParsedSchemaFile {
  fields: ExtraFieldDef[];
  /** Mode declared by the file, or null when it left the choice to the caller. */
  mode: SchemaFileMode | null;
  /** Non-fatal problems: unknown values that were defaulted, dropped entries. */
  warnings: string[];
}

/** Thrown for a file that cannot be used at all. Message is user-facing. */
export class SchemaFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaFileError";
  }
}

const KINDS: ExtraFieldKind[] = ["enum", "sentiment", "boolean", "number", "text"];
const USAGES: ExtraFieldUsage[] = ["metric", "segment", "context", "filter"];

/** Tolerated spellings for `kind`, so a hand-written file is not rejected over a synonym. */
const KIND_ALIASES: Record<string, ExtraFieldKind> = {
  enum: "enum",
  category: "enum",
  categorical: "enum",
  string: "enum",
  枚举: "enum",
  sentiment: "sentiment",
  emotion: "sentiment",
  情绪: "sentiment",
  boolean: "boolean",
  bool: "boolean",
  布尔: "boolean",
  number: "number",
  numeric: "number",
  float: "number",
  int: "number",
  integer: "number",
  数值: "number",
  text: "text",
  free_text: "text",
  文本: "text",
};

const USAGE_ALIASES: Record<string, ExtraFieldUsage> = {
  metric: "metric",
  measure: "metric",
  kpi: "metric",
  指标: "metric",
  segment: "segment",
  dimension: "segment",
  group: "segment",
  分群: "segment",
  维度: "segment",
  context: "context",
  info: "context",
  上下文: "context",
  filter: "filter",
  过滤: "filter",
};

const SCOPE_ALIASES: Record<string, "message" | "session"> = {
  message: "message",
  msg: "message",
  turn: "message",
  消息: "message",
  消息级: "message",
  session: "session",
  conversation: "session",
  dialog: "session",
  会话: "session",
  会话级: "session",
};

export function isSchemaFilePath(path: string): boolean {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  return (SCHEMA_FILE_NAMES as readonly string[]).includes(base);
}

/**
 * Pick the schema file to use when an archive holds several.
 *
 * Shallowest path wins, then the canonical name, then alphabetical — the point
 * is only that the choice is stable, so a re-import applies the same file.
 */
export function pickSchemaFile<T extends { path: string }>(entries: T[]): T | null {
  const candidates = entries.filter((e) => isSchemaFilePath(e.path));
  if (candidates.length === 0) return null;
  const rank = (p: string) => {
    const base = p.split("/").pop()!.toLowerCase();
    const idx = (SCHEMA_FILE_NAMES as readonly string[]).indexOf(base);
    return idx < 0 ? SCHEMA_FILE_NAMES.length : idx;
  };
  return [...candidates].sort((a, b) => {
    const depth = a.path.split("/").length - b.path.split("/").length;
    if (depth) return depth;
    const named = rank(a.path) - rank(b.path);
    if (named) return named;
    return a.path.localeCompare(b.path);
  })[0];
}

/* ------------------------------------------------------------------ parse */

/**
 * Parse a schema description file.
 *
 * Deliberately forgiving about *shape* (a bare array, a `fields` array or an
 * object keyed by field name all work, as do a handful of synonyms per key)
 * and strict about *meaning*: an unknown `kind` or `usage` is defaulted and
 * reported as a warning rather than silently written into the schema, because
 * those two values decide how the analysis engine treats the field.
 */
export function parseSchemaFile(raw: string): ParsedSchemaFile {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) throw new SchemaFileError("schema 文件是空的");

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // Second chance for a hand-written file with // comments or trailing commas.
    try {
      doc = JSON.parse(relaxJson(text));
    } catch (err) {
      throw new SchemaFileError(`schema 文件不是合法 JSON：${(err as Error).message}`);
    }
  }

  const warnings: string[] = [];
  let mode: SchemaFileMode | null = null;
  let list: unknown[];

  if (Array.isArray(doc)) {
    list = doc;
  } else if (doc && typeof doc === "object") {
    const obj = doc as Record<string, unknown>;
    const rawMode = String(obj.mode ?? obj.apply ?? "").toLowerCase();
    if (rawMode === "merge" || rawMode === "replace") mode = rawMode;
    else if (rawMode) warnings.push(`mode="${rawMode}" 不认识，已忽略（只支持 merge / replace）`);

    const arr = firstArray(obj, ["fields", "extra", "extra_schema", "extraSchema", "schema", "columns"]);
    if (arr) {
      list = arr;
    } else {
      // Object keyed by field name: { "skill": { kind, usage, ... }, ... }
      const entries = Object.entries(obj).filter(
        ([k, v]) => v && typeof v === "object" && !Array.isArray(v) && !RESERVED_KEYS.has(k),
      );
      if (!entries.length) {
        throw new SchemaFileError("schema 文件里没有找到字段定义（需要 fields 数组，或以字段名为键的对象）");
      }
      list = entries.map(([name, def]) => ({ name, ...(def as Record<string, unknown>) }));
    }
  } else {
    throw new SchemaFileError("schema 文件的顶层必须是对象或数组");
  }

  const fields: ExtraFieldDef[] = [];
  const seen = new Set<string>();

  list.forEach((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      warnings.push(`第 ${i + 1} 条不是对象，已跳过`);
      return;
    }
    const parsed = parseField(item as Record<string, unknown>, i, warnings);
    if (!parsed) return;
    if (seen.has(parsed.name)) {
      warnings.push(`字段 ${parsed.name} 重复定义，保留第一条`);
      return;
    }
    seen.add(parsed.name);
    fields.push(parsed);
  });

  if (!fields.length) throw new SchemaFileError("schema 文件里没有解析出任何有效字段");
  if (fields.length > MAX_FIELDS) {
    warnings.push(`字段超过 ${MAX_FIELDS} 个，只取前 ${MAX_FIELDS} 个`);
    fields.length = MAX_FIELDS;
  }

  return { fields, mode, warnings };
}

const MAX_FIELDS = 200;
const RESERVED_KEYS = new Set(["version", "mode", "apply", "source", "generated_at", "generatedAt", "note", "notes", "$schema"]);

function firstArray(obj: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k] as unknown[];
  return null;
}

function parseField(
  src: Record<string, unknown>,
  index: number,
  warnings: string[],
): ExtraFieldDef | null {
  const name = String(pick(src, ["name", "key", "field", "field_name", "fieldName", "字段", "字段名"]) ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (!name) {
    warnings.push(`第 ${index + 1} 条没有 name，已跳过`);
    return null;
  }

  const rawKind = String(pick(src, ["kind", "type", "data_type", "dataType", "类型"]) ?? "").trim().toLowerCase();
  const rawUsage = String(pick(src, ["usage", "purpose", "role", "用途", "分析用途"]) ?? "").trim().toLowerCase();
  const rawScope = String(pick(src, ["scope", "level", "granularity", "层级"]) ?? "").trim().toLowerCase();

  const options = toOptions(pick(src, ["options", "values", "enum", "allowed", "可选值"]));

  let kind = KIND_ALIASES[rawKind];
  if (!kind) {
    if (rawKind) warnings.push(`字段 ${name} 的 kind="${rawKind}" 不认识（可选：${KINDS.join(" / ")}）`);
    kind = options.length ? "enum" : "text";
    if (rawKind) warnings.push(`字段 ${name} 的类型已按取值推断为 ${kind}`);
  }

  let usage = USAGE_ALIASES[rawUsage];
  if (!usage) {
    if (rawUsage) warnings.push(`字段 ${name} 的 usage="${rawUsage}" 不认识（可选：${USAGES.join(" / ")}）`);
    usage = defaultUsage(kind);
  }

  const scope = SCOPE_ALIASES[rawScope] ?? "message";
  if (rawScope && !SCOPE_ALIASES[rawScope]) {
    warnings.push(`字段 ${name} 的 scope="${rawScope}" 不认识，已按 message 处理`);
  }

  // label / description stay empty when unspecified: `mergeSchemaFields` keeps
  // whatever the page already had, and `finalizeSchemaFields` fills the rest.
  const label = String(pick(src, ["label", "display", "display_name", "displayName", "title", "cn", "显示名"]) ?? "").trim();
  const description = String(
    pick(src, ["description", "desc", "meaning", "comment", "note", "说明", "语义", "含义"]) ?? "",
  ).trim();

  const def: ExtraFieldDef = {
    name,
    label,
    kind,
    scope,
    description,
    usage,
  };

  if (options.length && kind !== "number" && kind !== "text") def.options = options;
  else if (options.length) warnings.push(`字段 ${name} 是 ${kind} 类型，已忽略它的 options`);

  const positive = pick(src, ["positive", "polarity", "极性"]);
  if (typeof positive === "boolean") def.positive = positive;
  else if (typeof positive === "string" && /^(true|false)$/i.test(positive)) {
    def.positive = positive.toLowerCase() === "true";
  }

  return def;
}

function pick(src: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function toOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") {
      // Tolerate [{ value, label }] — a shape models like to produce.
      const value = (v as Record<string, unknown>).value ?? (v as Record<string, unknown>).name;
      if (value !== undefined && value !== null) out.push(String(value));
      continue;
    }
    out.push(String(v));
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))].slice(0, 64);
}

function defaultUsage(kind: ExtraFieldKind): ExtraFieldUsage {
  if (kind === "number") return "metric";
  if (kind === "text") return "context";
  return "segment";
}

/** Drop JS-style comments and trailing commas, respecting string literals. */
function relaxJson(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/* ------------------------------------------------------------------ merge */

/**
 * Fold a parsed file into the schema a data source already has.
 *
 * `replace` takes the file as the whole truth. `merge` replaces the fields the
 * file names, in place, keeps the ones it does not mention, and appends what is
 * new — with one carve-out: a label or description the file leaves blank keeps
 * whatever a human typed on the schema page, because those two are exactly the
 * columns people hand-tune and an exporter tends to omit.
 */
export function mergeSchemaFields(
  current: ExtraFieldDef[],
  incoming: ExtraFieldDef[],
  mode: SchemaFileMode,
): ExtraFieldDef[] {
  if (mode === "replace") return finalizeSchemaFields(incoming);

  const byName = new Map(incoming.map((f) => [f.name, f]));
  const used = new Set<string>();

  const merged = current.map((old) => {
    const next = byName.get(old.name);
    if (!next) return old;
    used.add(old.name);
    return {
      ...next,
      label: next.label || old.label || "",
      description: next.description || old.description || "",
      options: next.options?.length ? next.options : old.options,
      positive: next.positive ?? old.positive,
    };
  });

  for (const f of incoming) if (!used.has(f.name)) merged.push(f);
  return finalizeSchemaFields(merged);
}

/** Fill in the values the parser left blank, right before the schema is used. */
export function finalizeSchemaFields(fields: ExtraFieldDef[]): ExtraFieldDef[] {
  return fields.map((f) => ({
    ...f,
    label: f.label?.trim() || prettifyName(f.name),
    description: f.description ?? "",
  }));
}

export function prettifyName(name: string): string {
  return name.replace(/[_.-]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/* --------------------------------------------------------------- serialize */

/** Render fields back out as a schema file — the download template and the demo zip. */
export function schemaFileJson(fields: ExtraFieldDef[], mode: SchemaFileMode = "merge"): string {
  return `${JSON.stringify(
    {
      version: SCHEMA_FILE_VERSION,
      mode,
      fields: fields.map((f) => {
        const out: Record<string, unknown> = {
          name: f.name,
          label: f.label || prettifyName(f.name),
          kind: f.kind,
          scope: f.scope,
          usage: f.usage,
          description: f.description ?? "",
        };
        if (f.options?.length) out.options = f.options;
        if (typeof f.positive === "boolean") out.positive = f.positive;
        return out;
      }),
    },
    null,
    2,
  )}\n`;
}

/* -------------------------------------------------------------------- spec */

/** The worked example, also the body of the downloadable template. */
export const SCHEMA_FILE_EXAMPLE = `{
  "version": 1,
  "mode": "merge",
  "fields": [
    {
      "name": "skill",
      "label": "技能域",
      "kind": "enum",
      "scope": "message",
      "usage": "segment",
      "options": ["navigation", "music", "hvac", "query", "chat", "fallback"],
      "description": "ASR-LLM 路由到的技能域；fallback 表示没有命中任何技能，走了兜底话术"
    },
    {
      "name": "emotion",
      "label": "用户情绪",
      "kind": "sentiment",
      "scope": "message",
      "usage": "segment",
      "options": ["neutral", "happy", "confused", "frustrated", "angry"],
      "description": "端侧情绪模型给出的用户情绪标签，frustrated / angry 视为负向",
      "positive": true
    },
    {
      "name": "asr_confidence",
      "label": "ASR 置信度",
      "kind": "number",
      "scope": "message",
      "usage": "metric",
      "description": "语音识别置信度，取值 0-1；低于 0.6 通常是噪声或口音导致的误识别"
    },
    {
      "name": "interrupted",
      "label": "被打断",
      "kind": "boolean",
      "scope": "message",
      "usage": "metric",
      "description": "TTS 播报过程中被用户语音打断（barge-in），true 表示这轮回复没有播完"
    },
    {
      "name": "vehicle_model",
      "label": "车型",
      "kind": "enum",
      "scope": "session",
      "usage": "segment",
      "options": ["M7", "M9", "S5"],
      "description": "会话所属车型，整个会话固定不变"
    },
    {
      "name": "raw_nlu",
      "label": "NLU 原始结果",
      "kind": "text",
      "scope": "message",
      "usage": "context",
      "description": "NLU 模块的原始输出，只用于帮助模型理解这轮为什么被这样处理，不要统计"
    }
  ]
}`;

/**
 * The copyable spec.
 *
 * Written to be pasted straight into a chat with a model, together with a few
 * lines of real data — that is the whole point of the copy button, so it opens
 * with the task, states the output contract, and closes with the rules that
 * decide whether the result is actually usable (no invented fields, units and
 * thresholds spelled out, enums listed in full).
 */
export const SCHEMA_FILE_SPEC = `# VoiceLens extra 字段 Schema 描述文件规范 v${SCHEMA_FILE_VERSION}

## 任务（给 AI）
你要根据下面的规范，为一份语音对话数据生成一个 extra 字段说明文件（JSON）。
请把这份规范连同若干行真实数据（JSONL 样例）一起给模型，让它只输出 JSON，不要输出解释文字。

## 1. 这个文件是干什么的
对话 JSONL 的每一行可以带一个 extra 对象，里面是业务自己的埋点字段
（技能域、情绪、置信度、延迟……）。平台并不知道这些字段的含义，
所以需要一份说明文件告诉它：每个字段是什么、什么类型、分析时该怎么用。

这份说明会随数据一起进入 AI 的分析提示词：
标记为「指标」的字段会被聚合成 KPI，「分群」字段会成为图表维度，
「上下文」只用于帮助模型理解语义，「过滤」用于判断样本取舍。
说明写得越具体（单位、阈值、异常值含义），分析口径就越准。

## 2. 放在哪、叫什么
- 放进导入用的 zip 里，任意层级都可以（和 dialogues.jsonl 放在一起最直观）。
- 文件名（不区分大小写）取以下之一：
  ${SCHEMA_FILE_NAMES.map((n) => (n === PRIMARY_SCHEMA_FILE ? `${n}（推荐）` : n)).join("、")}
- UTF-8 编码的 JSON。这个文件是**可选**的，没有它也能正常导入。
- 这个文件不会被当成对话数据解析，不影响导入的消息条数。

## 3. 文件结构
{
  "version": 1,                 // 可选，当前为 1
  "mode": "merge",              // 可选，merge（默认）或 replace，见第 6 节
  "fields": [ { 字段定义 }, ... ]
}

也支持两种简写：
- 顶层直接写字段数组：[ { 字段定义 }, ... ]
- 以字段名为键的对象：{ "skill": { "kind": "enum", ... }, "emotion": { ... } }

## 4. 字段定义
| 键 | 必填 | 取值 | 说明 |
|---|---|---|---|
| name | 是 | 字符串 | extra 里的键名，大小写敏感，必须和数据里完全一致 |
| kind | 是 | enum / sentiment / boolean / number / text | 字段类型，见下 |
| usage | 是 | metric / segment / context / filter | 分析用途，见下 |
| label | 否 | 字符串 | 中文显示名，不写则由 name 自动生成 |
| scope | 否 | message / session | 消息级（默认）还是会话级（整个会话固定不变） |
| options | 枚举建议必填 | 字符串数组 | 该字段全部可能取值 |
| description | 强烈建议 | 字符串 | 一句话说清口径：单位、取值范围、阈值、异常含义 |
| positive | 否 | true / false | 极性，true 表示值越「正面」越好，报告按此配色 |

kind（类型）：
- enum        有限取值的分类，例如技能域、渠道、错误码
- sentiment   情绪 / 满意度标签，报告里单独配色
- boolean     true / false，适合算发生率
- number      连续数值，会聚合成均值 / 分位数；description 里务必写清单位
- text        自由文本，只作上下文，不做统计

usage（分析用途）：
- metric      聚合成数值指标，进入 KPI 与图表（数值、布尔常用）
- segment     作为 group by 分群维度，产出分布类图表（枚举、情绪常用）
- context     只帮助模型理解语义，不单独统计
- filter      用于判断样本是否纳入分析或标记异常

## 5. 完整示例
${SCHEMA_FILE_EXAMPLE}

## 6. 覆盖还是合并（mode）
- merge：只更新文件里出现的字段，页面上已有、文件里没写的字段保持不变；
  文件里没写 label / description 时，保留页面上已填的值。
- replace：最终 schema 就是文件里的内容，页面上原有字段会被清掉。
- 不写 mode 时的默认行为：zip 导入按 merge；在「字段 Schema」页手工导入文件时按 replace（覆盖页面配置）。

## 7. 写作要求
1. 只描述数据里真实出现过的 extra 字段，不要臆造字段，也不要遗漏高频字段。
2. description 写口径而不是同义反复：
   写「语音识别置信度 0-1，低于 0.6 通常是噪声或口音导致的误识别」，
   不要写「这是 ASR 置信度字段」。
3. 数值字段必须写清单位（ms / 秒 / 元 / 0-1 比例）和正常区间。
4. 枚举字段的 options 要列全，包括 fallback、unknown、空值这类兜底取值。
5. 布尔字段说明 true 代表什么事件，不要只写字段名的中文翻译。
6. 拿不准用途时：能算数的选 metric，能分组的选 segment，两者都不是的选 context。
7. 只输出 JSON 本身，不要包 Markdown 代码块，不要加解释。
`;
