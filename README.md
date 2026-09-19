# VoiceLens · 语音对话智能分析平台

面向 **ASR-LLM-TTS 三段式语音系统** 的对话数据分析平台。上传对话 JSONL 与音频，
按「会话 → 用户 → 全局」三层视角由 AI 自主规划分析口径，最终产出**可下探的单页 HTML 报告**。

技术栈：Next.js 15 (App Router) · React 19 · shadcn/ui · Tailwind v4 · React Flow ·
Supabase (Postgres + Auth + Storage) · qwen3.8-omni-flash（文本/图像/音频输入）

---

## 核心流程

```
数据源 ──导入──> 会话/消息 + 音频(对象存储)
   │
   ├─ extra 字段 schema（手工定义类型/层级/用途：metric|segment|context|filter）
   │
   └─ 工作流（React Flow 可视化编排 10 个节点的参数）
          │
          ├─ 1 规划  三层抽样 ＋ 试听音频 → 模型动态生成 4 段提示词 → 存为模板版本 vN
          ├─ 2 预览  模板 × 抽样 → session→user→global→报告，产出预览 HTML
          │        └─ 不满意 → 写修改建议 → 回到规划（生成 vN+1，parent 指向 vN）
          ├─ 3 确认  锁定执行模板
          └─ 4 生成  全量三层分析 → 单页 HTML 报告（自带全局/用户/会话下探）
```

三层分析严格遵循 **先 session、再 user、最后 global** 的自底向上汇总：
每层只消费下一层的**结构化结果**，不重复读原始转录，因此可线性扩展到大规模数据。

## 目录结构

| 路径 | 说明 |
|---|---|
| `src/app/(auth)/` | 登录 / 注册（Supabase Auth） |
| `src/app/(app)/` | 主应用：概览、数据源、工作流、任务、设置 |
| `src/app/api/` | 导入、示例数据、报告 HTML、音频签名代理、轮询状态 |
| `src/lib/engine/` | 分析引擎：归一化、抽样、提示词、三层分析、报告渲染 |
| `src/lib/workflow/` | 工作流节点定义与图 → 执行配置解析 |
| `src/lib/actions/` | Server Actions（数据源、工作流、工作台、任务） |
| `worker/index.ts` | 常驻后台 Worker：规划 / 预览 / 全量任务三类作业队列 |
| `scripts/e2e.ts` | 端到端冒烟脚本 |

## 运行

```bash
npm install
cp .env.local.example .env.local   # 填入 Supabase 与模型凭据
npm run build && npm start         # Web，端口 3000
npm run worker                     # 后台 Worker（另开一个进程，必须常驻）
```

`worker` 与 Web 是两个独立进程：Web 只接受请求、写作业；Worker 轮询队列执行长任务，
进度与日志写回任务对象，Web 端每 3 秒轮询刷新。Worker 重启会自动把孤儿作业重新入队。

## 数据格式

zip 压缩包 = 一个对话 JSONL（层级任意）＋ 音频文件（可选，层级任意）。

```jsonc
{
  "sessionId": "sess_1001_01",
  "userId": "u_1001",
  "timestamp": "2026-09-01 08:12:04",
  "message": { "role": "user", "content": "导航去最近的充电站" },
  "audio": "sess_1001_01_t000.wav",
  "extra": { "skill": "navigation", "asr_confidence": 0.93, "interrupted": false }
}
```

字段别名兼容：`session_id/sid`、`user_id/uid`、`created_at/ts/time`、`audio_file/audio_path`，
也支持顶层直接写 `role + content`，以及「一行一个 session、内含 messages 数组」的导出格式。
音频只把**字节**写进 Supabase Storage 的私有桶 `audio`，数据库只存对象路径。

同一个 `sessionId` 多次导入会自动追加到已有会话（`seq` 续号、转录拼接、计数累加）。

## 环境变量

| 变量 | 用途 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 接入 |
| `SUPABASE_SERVICE_EMAIL` / `SUPABASE_SERVICE_PASSWORD` | Worker 专用成员账号（首次启动自动注册） |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 模型服务（OpenAI 兼容 Chat Completions） |
| `AI_ENABLE_THINKING` | 深度思考默认开关（默认 false，规划与报告单独开启） |
| `WORKER_POLL_MS` / `WORKER_CONCURRENCY` | Worker 轮询与并发 |

## 安全边界

- 全部业务表开启 RLS，仅 `authenticated` 可读写；未登录在 middleware 层重定向。
- 浏览器只与本平台自己的路由通信：报告、音频、任务状态都经服务端转发，不下发任何凭据。
- 音频播放与送模型都走**短时效签名 URL**（播放 10 分钟，送模型 1 小时）。
- 数据库里不存文件字节；音频仅存对象路径。

## 演示数据

`导入` 页有两个入口：**导入示例数据**（车机语音助手，服务端生成并直接入库，
附带推荐 extra schema 与业务描述）与 **下载示例 zip**（同一数据集，可自行检查结构后上传）。
示例含程序合成的可听 WAV 波形，用于验证多模态链路是否打通。
