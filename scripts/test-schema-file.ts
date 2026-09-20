/**
 * extra schema 描述文件的解析与合并测试。
 *
 * No database and no network: this is the one piece of the import path that
 * hand-written (and model-written) files hit first, so it is worth pinning
 * down on its own. Run with `npm run test:schema`.
 */
import {
  PRIMARY_SCHEMA_FILE,
  SCHEMA_FILE_EXAMPLE,
  SchemaFileError,
  isSchemaFilePath,
  mergeSchemaFields,
  parseSchemaFile,
  pickSchemaFile,
  schemaFileJson,
} from "../src/lib/schema-file";
import type { ExtraFieldDef } from "../src/lib/types";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail === undefined ? "" : detail);
  }
}

function group(name: string, fn: () => void) {
  console.log(`\n${name}`);
  fn();
}

function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* ------------------------------------------------------------- file names */

group("文件名识别", () => {
  check("识别推荐文件名", isSchemaFilePath(`data/${PRIMARY_SCHEMA_FILE}`));
  check("大小写不敏感", isSchemaFilePath("Extra-Schema.JSON"));
  check("不误伤对话数据", !isSchemaFilePath("dialogues.jsonl") && !isSchemaFilePath("sessions.json"));

  const picked = pickSchemaFile([
    { path: "a/b/schema.json" },
    { path: `nested/${PRIMARY_SCHEMA_FILE}` },
    { path: "extra_schema.json" },
  ]);
  check("多个文件时取最浅的一个", picked?.path === "extra_schema.json", picked);
});

/* ----------------------------------------------------------------- parse */

group("标准格式", () => {
  const parsed = parseSchemaFile(SCHEMA_FILE_EXAMPLE);
  check("规范里的示例可以解析", parsed.fields.length === 6, parsed.fields.length);
  check("mode 被读出来", parsed.mode === "merge", parsed.mode);
  check("没有告警", parsed.warnings.length === 0, parsed.warnings);

  const skill = parsed.fields.find((f) => f.name === "skill");
  check("枚举取值保留", skill?.options?.length === 6, skill?.options);
  check("用途保留", skill?.usage === "segment", skill?.usage);

  const model = parsed.fields.find((f) => f.name === "vehicle_model");
  check("会话级层级保留", model?.scope === "session", model?.scope);

  const emotion = parsed.fields.find((f) => f.name === "emotion");
  check("极性保留", emotion?.positive === true, emotion?.positive);
});

group("宽松的写法", () => {
  const bare = parseSchemaFile(`[{ "name": "skill", "kind": "enum", "usage": "segment" }]`);
  check("顶层数组", bare.fields.length === 1 && bare.mode === null);

  const keyed = parseSchemaFile(
    `{ "version": 1, "skill": { "kind": "enum", "usage": "segment" }, "latency_ms": { "kind": "number" } }`,
  );
  check("以字段名为键的对象", keyed.fields.length === 2, keyed.fields.map((f) => f.name));
  check("version 不被当成字段", !keyed.fields.some((f) => f.name === "version"));

  const aliases = parseSchemaFile(
    `{ "fields": [{ "key": "emotion", "type": "情绪", "用途": "分群", "values": ["happy", "angry"], "desc": "情绪标签" }] }`,
  );
  check("键名与取值的同义写法", aliases.fields[0].kind === "sentiment", aliases.fields[0]);
  check("中文用途", aliases.fields[0].usage === "segment", aliases.fields[0].usage);
  check("说明读到", aliases.fields[0].description === "情绪标签", aliases.fields[0].description);

  const relaxed = parseSchemaFile(`{
    // 行注释
    "fields": [
      { "name": "retry", "kind": "boolean", "usage": "metric" }, /* 块注释 */
    ],
  }`);
  check("注释与尾逗号", relaxed.fields.length === 1, relaxed.fields);

  const url = parseSchemaFile(`[{ "name": "src", "kind": "text", "description": "来源 https://a.example/x" }]`);
  check("字符串里的 // 不被当成注释", !!url.fields[0].description?.includes("https://a.example/x"), url.fields[0]);
});

group("缺省与纠错", () => {
  const inferred = parseSchemaFile(`[{ "name": "latency_ms", "kind": "number" }]`);
  check("数值字段默认用途为指标", inferred.fields[0].usage === "metric", inferred.fields[0].usage);
  check("默认层级为消息级", inferred.fields[0].scope === "message");

  const bad = parseSchemaFile(`[{ "name": "skill", "kind": "categorical", "usage": "chart" }]`);
  check("同义 kind 被接受", bad.fields[0].kind === "enum", bad.fields[0].kind);
  check("未知 usage 退回默认并告警", bad.fields[0].usage === "segment" && bad.warnings.length > 0, bad.warnings);

  const dropped = parseSchemaFile(`[{ "kind": "enum" }, { "name": "ok", "kind": "text" }]`);
  check("无 name 的条目被跳过", dropped.fields.length === 1 && dropped.warnings.length === 1, dropped);

  const dup = parseSchemaFile(`[{ "name": "a", "kind": "text" }, { "name": "a", "kind": "number" }]`);
  check("重复字段保留第一条", dup.fields.length === 1 && dup.fields[0].kind === "text", dup.fields);

  const numOptions = parseSchemaFile(`[{ "name": "n", "kind": "number", "options": ["1", "2"] }]`);
  check("数值字段的 options 被丢弃", numOptions.fields[0].options === undefined, numOptions.fields[0]);

  const objOptions = parseSchemaFile(
    `[{ "name": "s", "kind": "enum", "options": [{ "value": "a" }, { "value": "b" }] }]`,
  );
  check("对象形式的取值被展平", objOptions.fields[0].options?.join(",") === "a,b", objOptions.fields[0].options);
});

group("无法使用的文件", () => {
  check("空文件", throws(() => parseSchemaFile("  ")) !== null);
  check("非 JSON", throws(() => parseSchemaFile("这不是 JSON")) !== null);
  check("没有字段", throws(() => parseSchemaFile(`{ "version": 1 }`)) !== null);
  check("空数组", throws(() => parseSchemaFile("[]")) !== null);
  check(
    "抛出的是 SchemaFileError",
    (() => {
      try {
        parseSchemaFile("{");
        return false;
      } catch (e) {
        return e instanceof SchemaFileError;
      }
    })(),
  );
});

/* ----------------------------------------------------------------- merge */

const current: ExtraFieldDef[] = [
  {
    name: "skill",
    label: "技能（人工命名）",
    kind: "enum",
    scope: "message",
    options: ["navigation", "music"],
    description: "页面上手工写的口径",
    usage: "segment",
  },
  { name: "keep_me", label: "保留我", kind: "text", scope: "message", description: "", usage: "context" },
];

group("合并", () => {
  const incoming = parseSchemaFile(
    `[{ "name": "skill", "kind": "enum", "usage": "filter" }, { "name": "new_one", "kind": "number" }]`,
  ).fields;

  const merged = mergeSchemaFields(current, incoming, "merge");
  check("未提及的字段保留", merged.some((f) => f.name === "keep_me"), merged.map((f) => f.name));
  check("新字段追加", merged.some((f) => f.name === "new_one"));
  check("顺序稳定", merged[0].name === "skill" && merged[1].name === "keep_me", merged.map((f) => f.name));

  const skill = merged.find((f) => f.name === "skill")!;
  check("文件里的用途生效", skill.usage === "filter", skill.usage);
  check("文件没写的显示名保留原值", skill.label === "技能（人工命名）", skill.label);
  check("文件没写的说明保留原值", skill.description === "页面上手工写的口径", skill.description);
  check("文件没写的取值保留原值", skill.options?.length === 2, skill.options);

  const overridden = mergeSchemaFields(
    current,
    parseSchemaFile(`[{ "name": "skill", "kind": "enum", "usage": "segment", "label": "技能域", "options": ["a"] }]`).fields,
    "merge",
  );
  check("文件写了就覆盖", overridden[0].label === "技能域" && overridden[0].options?.join() === "a", overridden[0]);
});

group("覆盖", () => {
  const replaced = mergeSchemaFields(
    current,
    parseSchemaFile(`[{ "name": "only", "kind": "text" }]`).fields,
    "replace",
  );
  check("结果就是文件内容", replaced.length === 1 && replaced[0].name === "only", replaced);
  check("显示名自动补齐", replaced[0].label === "Only", replaced[0].label);
});

/* ------------------------------------------------------------- round trip */

group("序列化", () => {
  const json = schemaFileJson(current, "replace");
  const back = parseSchemaFile(json);
  check("写出去再读回来字段数一致", back.fields.length === current.length, back.fields.length);
  check("mode 写入", back.mode === "replace", back.mode);
  check("说明不丢", back.fields[0].description === current[0].description, back.fields[0].description);
  check("取值不丢", back.fields[0].options?.join() === "navigation,music", back.fields[0].options);
});

console.log(`\n${failures ? "✗" : "✓"} ${checks - failures}/${checks} 通过`);
process.exit(failures ? 1 : 0);
