/**
 * Regression test for the model registry and the four analysis modes.
 *
 * The routing checks are pure and always run. The rest needs a SCRATCH database
 * — it writes and then deletes fixture rows, so it refuses to touch the one in
 * DATABASE_URL:
 *
 *   MODELS_TEST_DATABASE_URL=postgresql://... npx tsx scripts/test-models.ts
 *
 * The database must already have the migrations applied.
 */
process.env.DATABASE_URL = process.env.MODELS_TEST_DATABASE_URL ?? "";
// The registry encrypts with MODEL_SECRET, falling back to AUTH_SECRET. Pin one
// here so the test is not at the mercy of the developer's .env.local.
process.env.MODEL_SECRET = "models-test-secret-models-test-secret-0123456789";

import { closePool, execute, one, query } from "../src/lib/db";
import {
  DEFAULT_STAGE_PARAMS,
  PLAN_AUDIO_KIND,
  audioKinds,
  asMode,
  asPatch,
  applyPatch,
  applyStagePatch,
  isEmptyStagePatch,
  requiredKinds,
  sessionStrategy,
  stageOptions,
  textModelKind,
  type AnalysisMode,
} from "../src/lib/models/mode";
import {
  clearModelReferences,
  pickModel,
  readDefaults,
  requireModel,
  resolveRuntime,
  runtimeFor,
  writeDefaults,
  writeSourcePatch,
} from "../src/lib/models/registry";
import { decryptSecret, describeSecret, encryptSecret, sameSecret } from "../src/lib/models/secret";

const TAG = "models-test-" + process.pid;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a === e) return console.log(`PASS  ${label}`);
  failures++;
  console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

function checkThrows(label: string, fn: () => unknown, fragment: string) {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(fragment)) return console.log(`PASS  ${label}`);
    failures++;
    return console.log(`FAIL  ${label}\n        expected a message containing ${fragment}\n        actual   ${message}`);
  }
  failures++;
  console.log(`FAIL  ${label}\n        expected a throw, got none`);
}

/* ------------------------------------------------------------- routing */

function routingChecks() {
  console.log("\n-- 分析模式的调用路由 --");

  // The whole point of omni_all: one model for everything, audio or not.
  check("omni_all · 含音频", sessionStrategy("omni_all", true), "omni_single");
  check("omni_all · 无音频", sessionStrategy("omni_all", false), "omni_single");
  check("omni_all · 纯文本层", textModelKind("omni_all"), "omni");

  check("omni_for_audio · 含音频", sessionStrategy("omni_for_audio", true), "omni_single");
  check("omni_for_audio · 无音频", sessionStrategy("omni_for_audio", false), "multimodal_single");
  check("omni_for_audio · 纯文本层", textModelKind("omni_for_audio"), "multimodal");

  check("omni_then_refine · 含音频", sessionStrategy("omni_then_refine", true), "omni_then_refine");
  // A two-pass mode must NOT pay for a second pass on a session with no audio.
  check("omni_then_refine · 无音频走单次", sessionStrategy("omni_then_refine", false), "multimodal_single");

  check("audio_first · 含音频", sessionStrategy("audio_first", true), "audio_then_multimodal");
  check("audio_first · 无音频走单次", sessionStrategy("audio_first", false), "multimodal_single");

  // Listening is omni's job in every mode — nothing else accepts an audio part.
  check("规划试听恒为 omni", PLAN_AUDIO_KIND, "omni");

  check("omni_all 只必需 omni", requiredKinds("omni_all"), ["omni"]);
  check("omni_all 不额外需要音频模型", audioKinds("omni_all"), []);
  check("omni_for_audio 必需多模态", requiredKinds("omni_for_audio"), ["multimodal"]);
  check("omni_for_audio 遇音频需要 omni", audioKinds("omni_for_audio"), ["omni"]);

  check("未知模式回落到默认", asMode("nonsense"), "omni_for_audio");
  check("空值回落到默认", asMode(null), "omni_for_audio");
  check("已知模式原样保留", asMode("audio_first"), "audio_first");
}

/* ------------------------------------------------------- inheritance */

function inheritanceChecks() {
  console.log("\n-- 配置继承 --");
  const base = {
    mode: "omni_all" as AnalysisMode,
    omniModelId: "o-1",
    multimodalModelId: "m-1",
    stages: DEFAULT_STAGE_PARAMS,
  };

  check("空覆盖完全继承", applyPatch(base, asPatch({})), base);
  check("只覆盖模式时模型仍继承", applyPatch(base, asPatch({ mode: "audio_first" })), {
    mode: "audio_first",
    omniModelId: "o-1",
    multimodalModelId: "m-1",
    stages: DEFAULT_STAGE_PARAMS,
  });
  check("只覆盖单个模型时模式仍继承", applyPatch(base, asPatch({ multimodalModelId: "m-2" })), {
    mode: "omni_all",
    omniModelId: "o-1",
    multimodalModelId: "m-2",
    stages: DEFAULT_STAGE_PARAMS,
  });
  // Junk in the column must not resolve into a mode the engine cannot run.
  check("非法模式当作未覆盖", applyPatch(base, asPatch({ mode: "made-up" })), base);
  check("空字符串 id 当作未覆盖", applyPatch(base, asPatch({ omniModelId: "" })), base);
}

/* -------------------------------------------------------- 阶段参数继承 */

function stageChecks() {
  console.log("\n-- 各阶段调用参数 --");

  check("未配置时用内置默认", applyStagePatch(DEFAULT_STAGE_PARAMS, {}), DEFAULT_STAGE_PARAMS);
  check(
    "只覆盖一个字段，另一个仍继承",
    applyStagePatch(DEFAULT_STAGE_PARAMS, { report: { thinking: "on", maxTokens: null } }).report,
    { thinking: "on", maxTokens: DEFAULT_STAGE_PARAMS.report.maxTokens },
  );
  check(
    "覆盖一个阶段不影响其他阶段",
    applyStagePatch(DEFAULT_STAGE_PARAMS, { report: { thinking: "on", maxTokens: null } }).global,
    DEFAULT_STAGE_PARAMS.global,
  );
  // 数据源层再覆盖一次：全局 → 数据源，逐字段生效。
  const workspace = applyStagePatch(DEFAULT_STAGE_PARAMS, {
    report: { thinking: "on", maxTokens: 20000 },
  });
  check(
    "数据源层只改预算，思考沿用全局",
    applyStagePatch(workspace, { report: { thinking: null, maxTokens: 6000 } }).report,
    { thinking: "on", maxTokens: 6000 },
  );

  check("junk 阶段被忽略", asPatch({ stages: { nope: { thinking: "on" } } }).stages, {});
  check("junk 思考值被忽略", asPatch({ stages: { report: { thinking: "yes" } } }).stages, {});
  check("负数预算被忽略", asPatch({ stages: { report: { maxTokens: -5 } } }).stages, {});
  check("合法值被保留", asPatch({ stages: { report: { maxTokens: 9000 } } }).stages, {
    report: { thinking: null, maxTokens: 9000 },
  });
  check("空覆盖判定为空", isEmptyStagePatch(asPatch({ stages: {} }).stages), true);

  // On the wire: "auto" and 0 are the absence of a parameter, not false and 0.
  check("auto 不发送 enable_thinking 覆盖", stageOptions(DEFAULT_STAGE_PARAMS, "session"), {});
  check("0 不发送 max_tokens", stageOptions(applyStagePatch(DEFAULT_STAGE_PARAMS, {
    report: { thinking: "off", maxTokens: 0 },
  }), "report"), { thinking: false });
  check("显式值原样发送", stageOptions(applyStagePatch(DEFAULT_STAGE_PARAMS, {
    report: { thinking: "on", maxTokens: 5000 },
  }), "report"), { thinking: true, maxTokens: 5000 });
}

/* ------------------------------------------------------------ secrets */

function secretChecks() {
  console.log("\n-- API Key 加解密 --");
  const plain = "sk-abcdef0123456789";
  const cipher = encryptSecret(plain);

  check("密文与明文不同", cipher === plain, false);
  check("往返解密一致", decryptSecret(cipher), plain);
  // A fresh IV per encryption; identical ciphertext would leak equality.
  check("同一明文两次加密结果不同", encryptSecret(plain) === cipher, false);
  check("掩码只露头尾", describeSecret(cipher).masked, "sk-…6789");
  check("可读标记为真", describeSecret(cipher).readable, true);
  check("同值比较为真", sameSecret(cipher, plain), true);
  check("异值比较为假", sameSecret(cipher, "sk-other"), false);

  // What a rotated MODEL_SECRET looks like: reported, not thrown.
  const good = process.env.MODEL_SECRET;
  process.env.MODEL_SECRET = "a-different-secret-a-different-secret-0123456789";
  const state = describeSecret(cipher);
  process.env.MODEL_SECRET = good;
  check("换密钥后标记为不可读", state.readable, false);
  check("换密钥后仍知道有值", state.present, true);
}

/* ---------------------------------------------------------- database */

async function seedModel(name: string, kind: "omni" | "multimodal", key = "sk-" + name) {
  return one<{ id: string }>(
    `insert into ai_models (name, kind, base_url, model, api_key_cipher)
     values ($1, $2, 'https://example.invalid/v1', $3, $4)
     returning id`,
    [`${name}.${TAG}`, kind, `${name}-model`, encryptSecret(key)],
  );
}

async function dbChecks() {
  console.log("\n-- 注册表解析（数据库） --");
  const owner = await one<{ id: string }>(
    `insert into users (email, password_hash, role) values ($1, 'x', 'member') returning id`,
    [`owner.${TAG}@example.invalid`],
  );
  const omni = await seedModel("omni", "omni");
  const multimodal = await seedModel("mm", "multimodal");
  const source = await one<{ id: string }>(
    `insert into data_sources (name, created_by) values ($1, $2) returning id`,
    [`src.${TAG}`, owner.id],
  );

  await writeDefaults(
    { mode: "omni_for_audio", omniModelId: omni.id, multimodalModelId: multimodal.id, stages: {} },
    owner.id,
  );
  check("默认配置写入后可读回", await readDefaults(), {
    mode: "omni_for_audio",
    omniModelId: omni.id,
    multimodalModelId: multimodal.id,
    stages: DEFAULT_STAGE_PARAMS,
  });

  // A stage stored at the workspace level reaches the engine through the runtime.
  await writeDefaults(
    {
      mode: "omni_for_audio",
      omniModelId: omni.id,
      multimodalModelId: multimodal.id,
      stages: { report: { thinking: "on", maxTokens: 9000 } },
    },
    owner.id,
  );
  check("阶段参数写入后进入运行时", (await resolveRuntime(source.id)).stages.report, {
    thinking: "on",
    maxTokens: 9000,
  });
  check(
    "未配置的阶段仍是内置默认",
    (await resolveRuntime(source.id)).stages.global,
    DEFAULT_STAGE_PARAMS.global,
  );
  await writeDefaults(
    { mode: "omni_for_audio", omniModelId: omni.id, multimodalModelId: multimodal.id, stages: {} },
    owner.id,
  );

  const inherited = await resolveRuntime(source.id);
  check("数据源默认继承全局模式", inherited.mode, "omni_for_audio");
  check("两个槽位都解析出来", [inherited.omni?.model, inherited.multimodal?.model], [
    "omni-model",
    "mm-model",
  ]);
  check("运行时带出解密后的 Key", inherited.omni?.apiKey, "sk-omni");

  // Per-field override: the mode moves, the models keep following the default.
  await writeSourcePatch(source.id, {
    mode: "audio_first",
    omniModelId: null,
    multimodalModelId: null,
    stages: { session: { thinking: "off", maxTokens: null } },
  });
  const overridden = await resolveRuntime(source.id);
  check("数据源覆盖模式生效", overridden.mode, "audio_first");
  check("未覆盖的模型仍继承", overridden.multimodal?.id, multimodal.id);
  check("数据源覆盖阶段参数生效", overridden.stages.session, {
    thinking: "off",
    maxTokens: DEFAULT_STAGE_PARAMS.session.maxTokens,
  });

  // A disabled model is a reported problem, not a silent empty slot…
  await execute(`update ai_models set enabled = false where id = $1`, [omni.id]);
  const degraded = await resolveRuntime(source.id);
  check("停用的模型不出现在运行时", pickModel(degraded, "omni"), null);
  check("停用原因被记录", (degraded.problems.omni ?? "").includes("已被停用"), true);
  checkThrows("取用停用模型时报出原因", () => requireModel(degraded, "omni", "会话层分析"), "已被停用");
  // …and it must not take the healthy slot down with it.
  check("另一个槽位不受影响", requireModel(degraded, "multimodal", "用户层汇总").id, multimodal.id);
  await runtimeFor(omni.id).then(
    () => {
      failures++;
      console.log("FAIL  runtimeFor 对停用模型应当抛错");
    },
    (err: Error) => check("runtimeFor 对停用模型抛错", err.message.includes("已被停用"), true),
  );
  await execute(`update ai_models set enabled = true where id = $1`, [omni.id]);

  // Deleting a model clears it everywhere rather than leaving a dangling id.
  const cleared = await clearModelReferences(omni.id);
  await execute(`delete from ai_models where id = $1`, [omni.id]);
  check("清理报告了受影响的数据源数", cleared, 0); // this source inherits, so nothing to rewrite
  check("全局默认里的引用已清除", (await readDefaults()).omniModelId, null);
  check("删除后解析为未配置", (await resolveRuntime(source.id)).omni, null);
  checkThrows(
    "未配置时给出可执行的提示",
    () =>
      requireModel(
        { mode: "audio_first", omni: null, multimodal: null, stages: DEFAULT_STAGE_PARAMS, problems: {} },
        "omni",
        "会话层分析",
      ),
    "设置 → 分析模型",
  );

  // Now the same thing for a source that pinned the model explicitly.
  const omni2 = await seedModel("omni2", "omni");
  await writeSourcePatch(source.id, {
    mode: null,
    omniModelId: omni2.id,
    multimodalModelId: multimodal.id,
    stages: {},
  });
  const cleared2 = await clearModelReferences(omni2.id);
  check("清理改写了显式引用它的数据源", cleared2, 1);
  const after = await one<{ model_config: Record<string, unknown> }>(
    `select model_config from data_sources where id = $1`,
    [source.id],
  );
  check("被删槽位已移除", after.model_config.omniModelId ?? null, null);
  check("同一行的另一个槽位保持不变", after.model_config.multimodalModelId, multimodal.id);
}

async function cleanup() {
  await execute(`delete from data_sources where name like $1`, [`%${TAG}`]);
  await execute(`delete from ai_models where name like $1`, [`%${TAG}`]);
  await execute(`delete from users where email like $1`, [`%${TAG}@example.invalid`]);
  // The settings row is workspace-wide, so put it back the way the migration left it.
  await execute(
    `update app_settings
     set value = '{"mode": "omni_for_audio", "omniModelId": null, "multimodalModelId": null}'::jsonb
     where key = 'analysis_defaults'`,
  );
}

async function main() {
  routingChecks();
  inheritanceChecks();
  stageChecks();
  secretChecks();

  if (!process.env.DATABASE_URL) {
    console.log(
      "\nSKIP  数据库相关检查：未设置 MODELS_TEST_DATABASE_URL\n" +
        "      （这些检查会写入 fixture 行，请指向一个临时库，不要指向真实库）",
    );
    return;
  }
  await dbChecks();
  // Prove the fixtures are actually reachable before the cleanup deletes them.
  const left = await query(`select 1 from ai_models where name like $1`, [`%${TAG}`]);
  check("测试模型行确实写进了库", left.length > 0, true);
}

main()
  .catch((err) => {
    failures++;
    console.error(err);
  })
  .finally(async () => {
    if (process.env.DATABASE_URL) {
      await cleanup().catch((e) => console.error("cleanup failed:", e));
      await closePool();
    }
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
  });
