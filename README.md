# VoiceLens · 语音对话智能分析平台

面向 **ASR-LLM-TTS 三段式语音系统** 的对话数据分析平台。上传对话 JSONL 与音频，
按「会话 → 用户 → 全局」三层视角由 AI 自主规划分析口径，最终产出**可下探的单页 HTML 报告**。

技术栈：Next.js 15 (App Router) · React 19 · shadcn/ui · Tailwind v4 · React Flow ·
PostgreSQL（pg 直连）· S3 兼容对象存储（阿里云 OSS）· qwen3.8-omni-flash（文本/图像/音频输入）

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
| `db/migrations/` | 建库 SQL（15 张表 + 7 个 SQL 函数 + 索引），由 `npm run db:migrate` 应用 |
| `src/app/(auth)/` | 登录 / 注册（自建邮箱密码认证） |
| `src/app/(app)/` | 主应用：概览、数据源、工作流、任务、设置 |
| `src/app/api/` | 导入、示例数据、报告 HTML、音频签名代理、轮询状态 |
| `src/lib/engine/` | 分析引擎：归一化、抽样、提示词、三层分析、报告渲染 |
| `src/lib/workflow/` | 工作流节点定义与图 → 执行配置解析 |
| `src/lib/actions/` | Server Actions（认证、数据源、工作流、工作台、任务） |
| `src/lib/db/` | 连接池与查询封装（参数化 SQL） |
| `src/lib/auth/` | 会话签发与校验、argon2 口令哈希 |
| `src/lib/storage/` | S3 兼容对象存储（上传与预签名 URL） |
| `worker/index.ts` | 常驻后台 Worker：规划 / 预览 / 全量任务三类作业队列 |
| `scripts/e2e.ts` | 端到端冒烟脚本 |

## 运行

```bash
npm install
cp .env.local.example .env.local   # 填入数据库、对象存储与模型凭据
npm run db:migrate                 # 建表 + 建函数（幂等，可重复执行）
npm run build && npm start         # Web，端口 3000
npm run worker                     # 后台 Worker（另开一个进程，必须常驻）
```

数据库迁移是纯 SQL 文件 + 版本记录表：`db/apply.ts` 按文件名顺序执行 `db/migrations/*.sql`，
每个文件在自己的事务里应用，并把 sha256 记进 `_migrations`。已应用的文件被改动会直接报错——
改 schema 请新增一个迁移文件，不要编辑旧的。`npm run db:migrate -- --dry` 只列出待执行项。

首次访问 `/register` 注册的账号会成为工作区 owner，之后注册的是 member。

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
音频只把**字节**写进 S3 兼容的私有桶，数据库只存对象路径。

同一个 `sessionId` 多次导入会自动追加到已有会话（`seq` 续号、转录拼接、计数累加）。

### extra 字段的统计口径

`extra` 的真实取值分布由 Postgres 直算（`extra_histogram`），是报告「确定性指标」的来源，
规则是**每个字段只产出一种口径**：

- 字段在 schema 里声明了 → 按声明的 `kind` 统计：`number` 出均值/中位数/P90/最大值/样本数，
  其余（`enum`/`sentiment`/`boolean`/`text`）出取值计数。
- 未声明 → 按实际占多数的类型推断，这正是「从数据推断」的引导场景。
- 不符合所选口径的值（例如数值字段里混进的 `"N/A"`）不计入统计，但会记在 `mixed_count` 里，
  脏数据可见而不是被静默丢掉。

只统计**消息级** `extra`。会话行的 `extra` 是该会话所有消息 extra 的浅合并（后写覆盖先写），
只是个采样快照，不能当会话级事实表来聚合。

## 环境变量

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串；托管实例通常需要 `?sslmode=require` |
| `DATABASE_POOL_MAX` | 单进程连接池上限（Web 默认 10，Worker 默认 8） |
| `AUTH_SECRET` | 会话 Cookie 的签名密钥，至少 32 字符；轮换会使全部会话失效 |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | S3 兼容对象存储的接入点与私有桶 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 对象存储凭据（仅服务端使用） |
| `S3_FORCE_PATH_STYLE` | 路径风格寻址；OSS/S3 用默认 false，MinIO 需 true |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 模型服务（OpenAI 兼容 Chat Completions） |
| `AI_ENABLE_THINKING` | 深度思考默认开关（默认 false，规划与报告单独开启） |
| `WORKER_POLL_MS` | Worker 轮询间隔

## 安全边界

- 授权在应用层：未登录请求在 middleware 被重定向，Server Actions 与 Route Handlers 各自再校验一次会话。
  这是一个**共享团队工作区**——登录后即可访问全部数据源与任务，记录只留创建者，不做行级隔离。
- 会话是一枚 HS256 签名的 HttpOnly Cookie（7 天，活跃使用会自动续期）；口令用 argon2id 哈希
  （19 MiB / 2 轮）。登录失败不区分「密码错」与「账号不存在」，避免枚举。
- 浏览器只与本平台自己的路由通信：报告、音频、任务状态都经服务端转发，数据库与对象存储凭据
  不下发到前端。
- 音频桶保持私有，播放与送模型都走**短时效预签名 URL**（播放 10 分钟，送模型 1 小时）。
- 数据库里不存文件字节；音频仅存对象路径。

> 音频送模型时传的是预签名 URL，由模型服务**主动回源**拉取。若对象存储不可公网访问，
> 多模态链路会静默退化成纯文本分析（提示词里写了「音频不可用则仅依据转录」），任务依然成功。
> 部署后建议用示例数据验证一次音频确实被读到。

## 演示数据

`导入` 页有两个入口：**导入示例数据**（车机语音助手，服务端生成并直接入库，
附带推荐 extra schema 与业务描述）与 **下载示例 zip**（同一数据集，可自行检查结构后上传）。
示例含程序合成的可听 WAV 波形，用于验证多模态链路是否打通。
