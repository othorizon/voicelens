/**
 * Deterministic demo dataset generator for the "智能车机语音助手" scenario.
 * Produces JSONL dialogues plus short real WAV audio so the whole pipeline
 * (upload → storage → analysis → report) can be exercised end to end.
 */
import JSZip from "jszip";
import type { ExtraFieldDef } from "@/lib/types";

export const DEMO_EXTRA_SCHEMA: ExtraFieldDef[] = [
  {
    name: "skill",
    label: "技能",
    kind: "enum",
    scope: "message",
    options: ["navigation", "music", "hvac", "window", "query", "chat", "fallback"],
    description: "ASR-LLM 路由到的技能域；fallback 表示未能命中任何技能，走了兜底话术",
    usage: "segment",
  },
  {
    name: "emotion",
    label: "用户情绪",
    kind: "sentiment",
    scope: "message",
    options: ["neutral", "happy", "confused", "frustrated", "angry"],
    description: "由端侧情绪模型给出的用户情绪标签",
    usage: "segment",
    positive: true,
  },
  {
    name: "interrupted",
    label: "打断",
    kind: "boolean",
    scope: "message",
    description: "TTS 播报过程中被用户语音打断（barge-in），true 表示 AI 回复未播完",
    usage: "metric",
  },
  {
    name: "asr_confidence",
    label: "ASR 置信度",
    kind: "number",
    scope: "message",
    description: "语音识别置信度 0-1，低于 0.6 通常意味着噪声干扰或口音导致的误识别",
    usage: "metric",
  },
  {
    name: "tts_latency_ms",
    label: "TTS 首包延迟",
    kind: "number",
    scope: "message",
    description: "从用户说完到 TTS 首包返回的毫秒数，超过 1200ms 用户会明显感到卡顿",
    usage: "metric",
  },
  {
    name: "retry",
    label: "重复追问",
    kind: "boolean",
    scope: "message",
    description: "用户就同一诉求重复表述，通常意味着上一轮没有被理解",
    usage: "metric",
  },
  {
    name: "resolved",
    label: "本会话是否解决",
    kind: "boolean",
    scope: "session",
    description: "端侧判定本次会话的用户诉求是否被满足",
    usage: "metric",
    positive: true,
  },
  {
    name: "noise_level",
    label: "车内噪音",
    kind: "enum",
    scope: "message",
    options: ["low", "medium", "high"],
    description: "麦克风采集到的环境噪音等级，high 常伴随 ASR 置信度下降",
    usage: "filter",
  },
];

/* ---------------------------------------------------------------- random */

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rnd: () => number, arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

interface Turn {
  role: "user" | "assistant";
  text: string;
  skill: string;
  emotion: string;
  interrupted: boolean;
  asr_confidence: number;
  tts_latency_ms: number;
  retry: boolean;
  noise: string;
}

interface Scenario {
  skill: string;
  userLines: string[];
  aiLines: string[];
  failUserLines: string[];
  failAiLines: string[];
}

const SCENARIOS: Scenario[] = [
  {
    skill: "navigation",
    userLines: [
      "导航去最近的充电站",
      "帮我导航到公司",
      "我要去虹桥火车站，走高速",
      "找个评分高的川菜馆",
      "回家，避开拥堵路段",
    ],
    aiLines: [
      "已为您找到 3 个充电站，最近的一个距离 1.2 公里，需要现在开始导航吗？",
      "好的，已规划到公司的路线，全程 18 公里，预计 32 分钟，途中有一段拥堵。",
      "已为您设置目的地虹桥火车站，推荐走 G50 高速，预计 1 小时 5 分钟。",
      "找到 5 家评分 4.7 以上的川菜馆，最近的一家在 800 米外，要导航过去吗？",
    ],
    failUserLines: ["导航去那个……就上次去的那个地方", "我说的是虹桥火车站不是虹桥机场", "算了你别导航了"],
    failAiLines: [
      "抱歉，我没有找到匹配的地点，请再说一次具体名称。",
      "已切换到虹桥机场，需要现在出发吗？",
      "好的，已取消导航。",
    ],
  },
  {
    skill: "music",
    userLines: [
      "放一首周杰伦的歌",
      "声音大一点",
      "换一首轻音乐",
      "播放我今天早上收藏的歌单",
      "暂停",
    ],
    aiLines: [
      "正在为您播放《晴天》，来自专辑《叶惠美》。",
      "已将音量调到 18。",
      "好的，为您切换到轻音乐歌单，现在播放《晨雾》。",
      "正在播放您收藏的歌单「通勤路上」，共 24 首。",
    ],
    failUserLines: ["放一首那个……就那个抖音上很火的", "我要听的不是这个", "你能不能听懂人话"],
    failAiLines: ["抱歉，没有找到相关歌曲，为您推荐热门榜单。", "正在播放热门榜单第一名。", "已为您重新搜索。"],
  },
  {
    skill: "hvac",
    userLines: [
      "太热了，把空调调低两度",
      "关掉后排空调",
      "打开座椅加热",
      "温度调到 24 度",
      "开一下内循环",
    ],
    aiLines: [
      "已将空调温度降到 22 度。",
      "后排空调已关闭。",
      "主驾座椅加热已打开，档位 2。",
      "温度已设置为 24 度，当前车内 27 度，预计 3 分钟达到。",
    ],
    failUserLines: ["我说调低不是调高", "太冷了调回来", "别开了，我手动调吧"],
    failAiLines: ["已将温度升到 26 度。", "好的，已恢复 24 度。", "抱歉，请手动操作。"],
  },
  {
    skill: "window",
    userLines: ["把主驾车窗打开一半", "关一下天窗", "全部车窗降下来通风", "打开后备箱"],
    aiLines: ["主驾车窗已打开 50%。", "天窗已关闭。", "四门车窗已全部降下，注意行车安全。", "后备箱正在打开。"],
    failUserLines: ["我说的是副驾不是主驾", "别开天窗，外面在下雨"],
    failAiLines: ["副驾车窗已打开。", "抱歉，天窗已打开。"],
  },
  {
    skill: "query",
    userLines: [
      "现在还有多少电",
      "续航还剩多少公里",
      "今天限号吗",
      "外面多少度",
      "查一下胎压",
    ],
    aiLines: [
      "当前电量 62%，按最近 50 公里的能耗估算，剩余续航 318 公里。",
      "剩余续航 318 公里，如需长途建议在中途服务区补能。",
      "您的车牌今天不限号，可以正常通行。",
      "车外 14 度，空气质量良好，适合开窗通风。",
    ],
    failUserLines: ["我问的是胎压不是电量", "这个数据不对吧"],
    failAiLines: ["当前电量 62%。", "抱歉，胎压数据暂时获取不到，请稍后再试。"],
  },
  {
    skill: "chat",
    userLines: ["今天有点堵啊", "你会讲笑话吗", "陪我聊聊天", "你觉得新能源车怎么样"],
    aiLines: [
      "确实，前方 2 公里有事故，预计还要 15 分钟才能通过，要不要切换路线？",
      "会啊：为什么程序员喜欢黑暗？因为 bug 见了光就跑。",
      "当然，路上还有 20 分钟，想聊点什么？",
      "从数据看，电车的加速和静谧性普遍更好，长途补能规划是关键。",
    ],
    failUserLines: ["你这回答有点敷衍", "别扯这些了"],
    failAiLines: ["抱歉，我可能没理解到位。", "好的，那我们聊点别的？"],
  },
];

const FALLBACK_LINES = {
  user: ["那个……", "喂？", "嗯……等一下", "算了不用了", "你能做什么"],
  ai: [
    "抱歉，我没太听清，您可以说「导航去哪里」或者「播放音乐」。",
    "这个我还不太确定，您可以试试问我电量、续航或者空调。",
    "抱歉，暂时没有理解您的意思。",
  ],
};

function noiseFor(rnd: () => number, index: number, total: number): "low" | "medium" | "high" {
  const p = rnd();
  if (index > total - 4 && p < 0.4) return "high";
  return p < 0.6 ? "low" : p < 0.88 ? "medium" : "high";
}

function buildConversation(rnd: () => number, quality: "good" | "mixed" | "bad", length: number): Turn[] {
  const turns: Turn[] = [];
  const scenario = pick(rnd, SCENARIOS);
  const failProbability = quality === "good" ? 0.05 : quality === "mixed" ? 0.32 : 0.7;

  for (let i = 0; i < length; i++) {
    const failed = rnd() < failProbability;
    const noise = noiseFor(rnd, i, length);
    const userText = failed ? pick(rnd, scenario.failUserLines) : pick(rnd, scenario.userLines);
    const aiText = failed ? pick(rnd, scenario.failAiLines) : pick(rnd, scenario.aiLines);
    const isFallback = quality === "bad" && rnd() < 0.12;
    const asrBase = failed ? 0.42 : 0.9;
    const confidence = Math.min(
      0.99,
      Math.max(0.12, asrBase + (rnd() - 0.5) * 0.24 - (noise === "high" ? 0.18 : noise === "medium" ? 0.06 : 0)),
    );
    const interrupt = rnd() < (failed ? 0.4 : quality === "good" ? 0.07 : 0.2);
    const latency = Math.round(
      (quality === "good" ? 620 : quality === "mixed" ? 900 : 1350) + (rnd() - 0.5) * 520 + (noise === "high" ? 220 : 0),
    );
    const emotion = failed
      ? pick(rnd, ["frustrated", "confused", "frustrated", "angry", "neutral"])
      : pick(rnd, ["neutral", "happy", "neutral", "confused"]);

    turns.push({
      role: "user",
      text: isFallback ? pick(rnd, FALLBACK_LINES.user) : userText,
      skill: isFallback ? "fallback" : scenario.skill,
      emotion,
      interrupted: false,
      asr_confidence: Math.round(confidence * 1000) / 1000,
      tts_latency_ms: 0,
      retry: failed && rnd() < 0.55,
      noise,
    });

    let reply = isFallback ? pick(rnd, FALLBACK_LINES.ai) : aiText;
    turns.push({
      role: "assistant",
      text: interrupt ? truncateMid(reply) : reply,
      skill: isFallback ? "fallback" : scenario.skill,
      emotion: "neutral",
      interrupted: interrupt,
      asr_confidence: 1,
      tts_latency_ms: Math.max(180, latency),
      retry: false,
      noise,
    });
  }
  return turns;
}

function truncateMid(text: string) {
  const cut = Math.max(6, Math.floor(text.length * 0.42));
  return `${text.slice(0, cut)}…`;
}

/* ------------------------------------------------------------ wav encode */

/** Minimal PCM WAV encoder — deterministic tone + noise so the file is audible. */
export function makeWav(seed: number, seconds = 0.9, sampleRate = 16000): Uint8Array {
  const rnd = mulberry32(seed);
  const n = Math.floor(seconds * sampleRate);
  const data = new Uint8Array(44 + n * 2);
  const view = new DataView(data.buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) data[off + i] = s.charCodeAt(i);
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, n * 2, true);

  const baseFreq = 130 + Math.floor(rnd() * 180);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 22) * Math.min(1, (seconds - t) * 14);
    const formant =
      Math.sin(2 * Math.PI * baseFreq * t) * 0.5 +
      Math.sin(2 * Math.PI * baseFreq * 2.4 * t) * 0.26 +
      Math.sin(2 * Math.PI * baseFreq * 3.7 * t) * 0.12;
    const jitter = (rnd() - 0.5) * 0.07;
    const v = Math.max(-1, Math.min(1, (formant + jitter) * env * 0.62));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return data;
}

/* ------------------------------------------------------------ generation */

export interface DemoRecord {
  sessionId: string;
  userId: string;
  timestamp: string;
  message: { role: string; content: string };
  extra: Record<string, unknown>;
  audio?: string;
}

export interface DemoDataset {
  records: DemoRecord[];
  sessions: number;
  users: number;
  audios: number;
  startedAt: Date;
  endedAt: Date;
}

const CITIES = ["上海", "北京", "深圳", "杭州", "成都", "广州"];
const ROLES = ["产品经理", "工程师", "设计师", "销售", "教师", "医生", "学生", "运营"];

export function generateDemoDataset(opts: {
  sessions?: number;
  users?: number;
  seed?: number;
  days?: number;
  audioEveryN?: number;
}): DemoDataset {
  const totalSessions = opts.sessions ?? 90;
  const totalUsers = opts.users ?? 36;
  const rnd = mulberry32(opts.seed ?? 20260918);
  const days = opts.days ?? 14;
  const audioEveryN = Math.max(1, opts.audioEveryN ?? 6);

  const users = Array.from({ length: totalUsers }, (_, i) => ({
    id: `u_${String(1000 + i)}`,
    city: pick(rnd, CITIES),
    role: pick(rnd, ROLES),
    quality: (i % 5 === 0 ? "bad" : i % 3 === 0 ? "good" : "mixed") as "good" | "mixed" | "bad",
    sessions: 1 + Math.floor(rnd() * 5),
  }));
  // Force the total session count close to the target.
  let assigned = 0;
  for (const u of users) {
    u.sessions = Math.max(1, u.sessions);
    assigned += u.sessions;
  }
  while (assigned < totalSessions) {
    users[Math.floor(rnd() * users.length)].sessions++;
    assigned++;
  }

  const now = Date.now();
  const records: DemoRecord[] = [];
  let sessionIndex = 0;
  let audioCount = 0;
  let msgIndex = 0;

  for (const u of users) {
    for (let s = 0; s < u.sessions; s++) {
      sessionIndex++;
      const sessionId = `sess_${u.id}_${String(s + 1).padStart(2, "0")}`;
      const daysAgo = Math.floor(rnd() * days);
      const hour = 6 + Math.floor(rnd() * 16);
      const minute = Math.floor(rnd() * 60);
      const started = new Date(now - daysAgo * 86400000);
      started.setHours(hour, minute, Math.floor(rnd() * 60), 0);

      const pairCount = 2 + Math.floor(rnd() * 9);
      const turns = buildConversation(rnd, u.quality, pairCount);
      const resolved = u.quality === "good" ? rnd() < 0.92 : u.quality === "mixed" ? rnd() < 0.62 : rnd() < 0.28;
      let cursor = started.getTime();

      turns.forEach((t, i) => {
        cursor += 1200 + Math.floor(rnd() * 4200);
        const withAudio = msgIndex % audioEveryN === 0;
        const extra: Record<string, unknown> = {
          skill: t.skill,
          emotion: t.emotion,
          interrupted: t.interrupted,
          asr_confidence: t.asr_confidence,
          tts_latency_ms: t.tts_latency_ms,
          retry: t.retry,
          noise_level: t.noise,
          device: `car-${u.city}-0${(sessionIndex % 9) + 1}`,
          lang: "zh-CN",
        };
        if (t.role === "user") extra.resolve_hint = resolved;

        const audioFile = withAudio ? `${sessionId}_t${String(i).padStart(3, "0")}.wav` : undefined;
        if (audioFile) audioCount++;

        records.push({
          sessionId,
          userId: u.id,
          timestamp: new Date(cursor).toISOString().replace("T", " ").slice(0, 19),
          message: { role: t.role, content: t.text },
          extra: {
            ...extra,
            ...(i === 0 ? { user_city: u.city, user_role: u.role, resolved } : {}),
          },
          audio: audioFile,
        });
        msgIndex++;
      });
    }
  }

  const timestamps = records.map((r) => Date.parse(r.timestamp.replace(" ", "T")));
  return {
    records,
    sessions: sessionIndex,
    users: totalUsers,
    audios: audioCount,
    startedAt: new Date(Math.min(...timestamps)),
    endedAt: new Date(Math.max(...timestamps)),
  };
}

/** Build the exact upload format the platform expects: one JSONL + audio in a zip. */
export async function buildDemoZip(dataset: DemoDataset): Promise<Uint8Array> {
  const zip = new JSZip();
  const folder = zip.folder("demo_car_assistant")!;

  folder.file(
    "dialogues.jsonl",
    dataset.records.map((r) => JSON.stringify(r)).join("\n"),
  );

  const audioFolder = folder.folder("audio")!;
  dataset.records.forEach((r, i) => {
    if (!r.audio) return;
    audioFolder.file(r.audio, makeWav(i * 7919 + 13, 0.7 + (i % 5) * 0.12));
  });

  folder.file(
    "README.txt",
    [
      "VoiceLens 示例数据集 · 智能车机语音助手",
      "",
      `会话数：${dataset.sessions}`,
      `用户数：${dataset.users}`,
      `消息数：${dataset.records.length}`,
      `音频数：${dataset.audios}（程序合成的可听波形，用于验证多模态链路）`,
      `时间范围：${dataset.startedAt.toISOString().slice(0, 10)} ~ ${dataset.endedAt.toISOString().slice(0, 10)}`,
      "",
      "dialogues.jsonl 每行一条消息，字段：",
      "  sessionId / userId / timestamp / message{role,content} / extra{...} / audio",
      "",
      "extra 字段建议的 schema 配置见平台的「字段 Schema」页，可一键从数据推断。",
    ].join("\n"),
  );

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export const DEMO_BUSINESS_DESC = `这是新能源汽车车机语音助手的真实用户对话数据，链路为 ASR - LLM - TTS 三段式：用户语音经 ASR 转文本，LLM 决策并生成回复，再由 TTS 播报。

对话双方：
- user：车主或乘客，在驾驶过程中通过语音使用车辆功能，双手不离方向盘，注意力有限，容错率低。
- assistant：车机语音助手，需要快速、准确、简短地回应。

用户主要想完成的任务：导航/找地点（navigation）、音乐播放与音量控制（music）、空调与座椅（hvac）、车窗与后备箱（window）、车辆状态查询（query）、闲聊（chat）。当 ASR 或意图理解失败时会落到 fallback 兜底话术。

已知的系统性问题：
1. 车内噪音（高速、开窗、后排说话）导致 ASR 误识别，表现为 asr_confidence 偏低、用户 retry 重复追问。
2. TTS 播报偏长，用户等不及直接打断（extra.interrupted 为 true 且 assistant 文本以「…」截断）。
3. 首包延迟过高（tts_latency_ms > 1200）时用户会重复唤醒。
4. 指代消解弱：「上次那个地方」「这个」「副驾」容易理解错。

我们希望通过分析回答：
- 各技能域的使用占比与成功率分别是多少，哪个技能体验最差？
- 打断率、重复追问率、低 ASR 置信度占比是多少，与噪音等级有什么关系？
- TTS 延迟分布如何，超过阈值的比例有多高，是否显著影响会话解决率？
- 哪类用户（重度/偶发、不同城市）问题最集中，是否存在需要优先跟进的高风险用户？
- 从产品和算法两侧，接下来最该做的三件事是什么？`;
