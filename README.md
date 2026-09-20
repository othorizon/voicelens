# VoiceLens · 语音对话智能分析平台

面向 **ASR-LLM-TTS 三段式语音系统** 的对话数据分析平台。上传对话 JSONL 与音频，
按「会话 → 用户 → 全局」三层视角由 AI 自主规划分析口径，最终产出**可下探的单页 HTML 报告**。

技术栈：Next.js 15 (App Router) · React 19 · shadcn/ui · Tailwind v4 · React Flow ·
PostgreSQL（pg 直连）· S3 兼容对象存储（阿里云 OSS）· 任意 OpenAI 兼容模型（多模态 / omni，后台可配多套）

---

## 核心流程

```
数据源 ──导入──> 会话/消息 + 音频(对象存储)
   │
   ├─ extra 字段 schema（zip 内 schema 文件自动导入，或手工定义类型/层级/用途：
   │                     metric|segment|context|filter）
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
| `src/app/(app)/` | 主应用：概览、数据源、工作流、任务、设置（角色分配） |
| `src/app/pending/` | 无权限账号的等待开通页 |
| `src/app/api/` | 分片直传签名、导入入队、示例数据、报告 HTML、音频签名代理、轮询状态 |
| `src/lib/engine/` | 分析引擎：归一化、抽样、提示词、三层分析、报告渲染 |
| `src/lib/models/` | 模型注册表：四种分析模式的路由规则、API Key 加解密、配置解析 |
| `src/lib/schema-file.ts` | extra 字段 schema 描述文件：命名、解析、合并与可复制的规范文本 |
| `src/lib/workflow/` | 工作流节点定义与图 → 执行配置解析 |
| `src/lib/actions/` | Server Actions（认证、数据源、工作流、工作台、任务） |
| `src/lib/db/` | 连接池与查询封装（参数化 SQL） |
| `src/lib/auth/` | 会话签发与校验、argon2 口令哈希、角色表与归属判定 |
| `src/lib/storage/` | S3 兼容对象存储（分片上传、预签名 URL、Range 读取） |
| `src/lib/upload/` | 浏览器端分片直传与断点续传 |
| `worker/index.ts` | 常驻后台 Worker：导入 / 规划 / 预览 / 全量任务四类作业队列 |
| `scripts/e2e.ts` | 端到端冒烟脚本 |

## 运行

```bash
npm install
cp .env.local.example .env.local   # 填入数据库与对象存储凭据（模型在页面上配）
npm run db:migrate                 # 建表 + 建函数（幂等，可重复执行）
npm run build && npm start         # Web，端口 3000
npm run worker                     # 后台 Worker（另开一个进程，必须常驻）
```

> **还有一步在代码之外：给对象存储的 Bucket 配一条 CORS 规则。**
> 压缩包由浏览器直传到 Bucket，没有这条规则上传会在浏览器侧被拦掉，报
> 「无法直传到对象存储」。规则怎么填见〈[Bucket 必配：跨域（CORS）规则](#bucket-必配跨域cors规则)〉。
> 另外，**导入由 Worker 执行**，Worker 没起来的话上传能成功，但批次会一直停在「排队中」。

数据库迁移是纯 SQL 文件 + 版本记录表：`db/apply.ts` 按文件名顺序执行 `db/migrations/*.sql`，
每个文件在自己的事务里应用，并把 sha256 记进 `_migrations`。已应用的文件被改动会直接报错——
改 schema 请新增一个迁移文件，不要编辑旧的。`npm run db:migrate -- --dry` 只列出待执行项。

首次访问 `/register` 注册的账号会成为工作区 **owner**（拥有全部权限）；之后注册的账号默认
**无权限**，需要 owner 或管理员在「设置 → 成员与角色」里开通。角色见下面的〈权限模型〉。

`worker` 与 Web 是两个独立进程：Web 只接受请求、写作业；Worker 轮询队列执行长任务，
进度与日志写回任务对象，Web 端每 3 秒轮询刷新。Worker 重启会自动把孤儿作业重新入队。
**数据导入也是一类作业**，所以 Worker 没起来时上传能成功、批次会停在「排队中」。

## 容器部署

两份 Dockerfile 产出的镜像内容完全一致，只差依赖源与时区：

| 文件 | 适用网络 | 差异 |
|---|---|---|
| `Dockerfile` | 能直连官方源 | npm 官方源，时区 UTC |
| `Dockerfile_cn` | 国内 | npm 源 `registry.npmmirror.com`、apt 源 `mirrors.aliyun.com`，时区 `Asia/Shanghai`（UTC+8） |

一个镜像承载四种角色，用第一个参数选择：`web`（默认）/ `worker` / `all` / `migrate`。

### 方式一：compose，一条命令两个容器（推荐）

```bash
cp .env.local.example .env.local         # 填数据库与对象存储凭据（模型在页面上配）
docker compose run --rm web migrate      # 首次部署：建表建函数（幂等）
docker compose up -d --build             # Web + Worker，访问 http://<host>:3000
```

默认走 `Dockerfile_cn`；官方源与 UTC 用 `DOCKERFILE=Dockerfile docker compose up -d --build`。
Worker 跑不过来就 `docker compose up -d --scale worker=3`——队列用 `for update skip locked`
领作业，多实例不会抢到同一个任务。

### 方式二：一个容器跑全部（单机省事）

```bash
docker build -f Dockerfile_cn -t voicelens:latest .
docker run -d --name voicelens --restart unless-stopped \
  --env-file .env.local -e VOICELENS_MIGRATE_ON_START=true \
  -p 3000:3000 voicelens:latest all
```

`all` 在一个容器里起 Web 与 Worker 两个进程，任一进程退出就把另一个收掉、整体退出，
交给 `--restart` 拉起——避免「容器还在但 Worker 已经死了，任务只排队不执行」。
代价是日志混在一起、不能只重启或只扩容其中一个，数据量上来了建议换方式一。
`VOICELENS_MIGRATE_ON_START=true` 会在起服务前跑一次迁移（`db/apply.ts` 没有互斥锁，
同一个库别让两个容器同时开这个开关）。

角色也可以用环境变量选：不带命令参数时，`VOICELENS_ROLE=all`（或 `web` / `worker` / `migrate`）
等价于把角色写在命令里，给只能填环境变量的托管平台用。命令参数优先级高于环境变量。

### 部署到 Dokploy / Coolify 这类 PaaS（单实例）

以 Dokploy 为例，一个 Application 就能跑起来：

1. **Create Application**,源选 GitHub / Git 仓库。
2. **Build Type** 选 `Dockerfile`:Dockerfile Path 填 `Dockerfile_cn`（官方源填 `Dockerfile`）,
   Docker Context Path 填 `.`,Docker Build Stage 留空。
3. **Build Time Arguments**（可选，构建时）：`NPM_REGISTRY`、`APT_MIRROR`、`TZ`,不填就用文件里的默认值。
4. **Environment**（运行时）：照 `.env.local.example` 填 `DATABASE_URL`、`AUTH_SECRET`、`S3_*`,再加两条：
   （模型不在这里配，部署完由所有者在「设置 → 分析模型」里填）
   - `VOICELENS_ROLE=all` —— 一个实例里同时跑 Web 与 Worker
   - `VOICELENS_MIGRATE_ON_START=true` —— 启动时自动建表
5. **Domains**:Host 填域名，Container Port 填 `3000`,打开 HTTPS（Let's Encrypt）。
6. Deploy。

用环境变量而不是平台的 Run Command 来选角色，是因为这类平台改命令时常把 ENTRYPOINT 一起覆盖掉。

**Replicas 保持 1**:`all` 模式每个实例都自带一个 Worker。多副本时队列本身是安全的
（`for update skip locked` 不会重复领任务），但 `VOICELENS_MIGRATE_ON_START` 会多个实例同时迁移，
有冲突风险。要扩容就建两个 Application（一个 `VOICELENS_ROLE=web` 配域名，一个 `VOICELENS_ROLE=worker`
不配域名），或者直接用平台的 Docker Compose 部署吃仓库里的 `docker-compose.yml`。

用平台的 Compose 部署时有两点要注意：选 **Docker Compose** 而不是 **Stack** 模式（Stack 模式不支持
`build:`）；本仓库的 compose 用 `env_file: .env.local`,而平台注入的通常是 `.env`,需要改成平台的写法
或直接在 compose 里写 `environment:`。

### 方式三：手动两个容器

```bash
docker run --rm     --env-file .env.local                                voicelens:latest migrate
docker run -d --name voicelens-web    --env-file .env.local -p 3000:3000 voicelens:latest
docker run -d --name voicelens-worker --env-file .env.local              voicelens:latest worker
```

### 为什么 Web 与 Worker 要分开

Web 只接受请求、写作业；Worker 跑的是几分钟到几十分钟、反复调模型的三层分析。合在一个进程里，
长任务会占住事件循环与连接池，页面响应和 3 秒一次的进度轮询都会被拖慢；分开还能各自重启、
只给 Worker 扩容（Web 一份、Worker 多份）。`all` 只是把这两个进程放进同一个容器，并没有合成一个进程。

### 通用说明

- `--env-file` 直接读 `.env.local`，但**值不要加引号**：docker 会把引号当字面量读进去。
- Worker 必须常驻，否则任务（含**数据导入**）只会排队不执行；Worker 重启会自动把孤儿作业重新入队。
- 对象存储的 Bucket 要配 CORS（浏览器直传上传用）与「碎片过期」生命周期规则，见
  〈[Bucket 必配：跨域（CORS）规则](#bucket-必配跨域cors规则)〉。这两条都在控制台上配，不在代码里。
- 容器无状态：数据在 Postgres、音频在对象存储，不用挂卷；进程以非 root（uid 1000）运行。
  导入也不落临时文件（压缩包在桶里就地按条目读），所以容器磁盘不会随数据量增长。
- compose 里给两个服务都封了容器日志（3 × 10MB）。docker 默认的 json-file 驱动**不封顶**，
  是这套部署里唯一一处会让宿主机磁盘单调增长的地方；手工 `docker run` 记得自己加
  `--log-opt max-size=10m --log-opt max-file=3`。
- `migrate --dry` 只列待执行的迁移；镜像里的其它命令原样执行，例如
  `docker run --rm --env-file .env.local voicelens:latest node_modules/.bin/tsx scripts/rerender-report.ts <task-id>`。
- 镜像源与时区都是 build-arg，换一家只改参数：
  `--build-arg NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/`、`--build-arg APT_MIRROR=mirrors.tuna.tsinghua.edu.cn`、`--build-arg TZ=UTC`。
- 基础镜像（docker.io）拉不动时，给 dockerd 配 `registry-mirrors`，或
  `--build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim`。

时区影响两处可见行为：报告里的「生成时间」按容器时区渲染；导入数据中**不带时区**的时间戳
（`2026-09-01 08:12:04`）按容器时区解释后转成 UTC 落库。`Dockerfile_cn` 取 +8 是因为国内导出的
日志通常就是北京时间；如果你的日志本来是 UTC，运行时加 `-e TZ=UTC` 覆盖即可。

## 数据格式

zip 压缩包 = 一个对话 JSONL（层级任意）＋ 音频文件（可选，层级任意）
＋ 一个 extra 字段说明文件（可选，见下）。

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

### extra 字段 schema 描述文件（可选）

`extra` 里的埋点字段平台并不认识，所以需要有人说明「这个字段是什么、分析时怎么用」。
除了在「字段 Schema」页逐个配置，也可以把说明随数据一起放进 zip：

```
my-data.zip
├─ dialogues.jsonl
├─ voicelens.schema.json   # ← 这个文件，可选，任意层级
└─ audio/…
```

```jsonc
{
  "version": 1,
  "mode": "merge",                       // merge（默认）只更新文件里写到的字段；replace 整体覆盖
  "fields": [
    {
      "name": "asr_confidence",          // extra 里的键名，必填
      "label": "ASR 置信度",
      "kind": "number",                  // enum | sentiment | boolean | number | text
      "scope": "message",                // message（默认）| session
      "usage": "metric",                 // metric | segment | context | filter
      "description": "语音识别置信度 0-1，低于 0.6 通常是噪声或口音导致的误识别"
    }
  ]
}
```

- 文件名取 `voicelens.schema.json`（推荐）、`schema.json`、`extra-schema.json`、`extra_schema.json` 之一，
  不区分大小写；它不会被当成对话数据解析。
- 导入时自动写入该数据源的 extra schema，导入批次上会显示读到了哪个文件、生效了几个字段。
- 文件写错不会让导入失败：对话照常入库，原因记在批次的错误信息里。
- 也可以在「字段 Schema」页点「导入 schema 文件」直接覆盖页面配置（改动仍需点保存才落库）。
- 两个页面都有「schema 文件规范」按钮，可查看并**一键复制**完整规范——规范本身就是写给 AI 的提示词，
  连同几行真实 JSONL 发给模型即可生成这个文件。示例 zip 里也自带一份可参考。

### 导入上传：浏览器直传 + 断点续传

压缩包的字节**不经过应用服务器**。上传时浏览器先向 `/api/sources/[id]/uploads` 要一次分片
上传（`create`），拿到服务端签好的 PUT URL（`sign`），再把切片直接 PUT 到对象存储；服务端
只负责签名、列分片（`status`）与合并（`complete`），全程不持有文件内容。

断点续传就落在这套机制上：已被对象存储接收的分片会一直留着，直到上传被合并或作废。
浏览器把 `key` / `uploadId` 记在 localStorage，暂停、刷新、断网、合上电脑之后重新选择
同一个文件，会先问一次 `status`、跳过已传分片、只补剩下的。上传页的「暂停」保留分片，
「取消并丢弃」会调用 `abort` 把分片一并删掉。

上传完成后浏览器只提交一个**对象路径**，批次以 `pending` 入队，由 **Worker** 认领执行——
web 进程不再在响应之后偷偷跑导入，所以部署或重启不会再让导入凭空消失。

Worker 入库时也不把压缩包读进内存：用 **HTTP Range 就地读**桶里的这个对象——先读中央目录，
再按条目读——峰值内存是单个条目而不是整包（实测 600MB 压缩包，峰值 RSS 191MB；旧的整包
读法同一份数据是 740MB，且随包大小线性增长）。解包完成后暂存的压缩包默认删除，失败则保留
以便重试（`IMPORT_KEEP_SOURCE_ZIP=true` 可改为一直保留）。

上限因此从 800MB 放宽到 **5GB**（`IMPORT_MAX_ZIP_MB` 可调）。它现在只是一道防手滑的闸，
真正随数据量增长的是**条数**：一个批次解析出的消息在写库期间会留在内存里，音频体积不会。

导入中的批次每隔几秒更新一次 `heartbeat_at`。心跳停了超过 5 分钟的 `processing` 批次会被
判定为「Worker 中途挂了」，标记为失败——按心跳而不是按「我启动时它在跑」来判断，是为了让
多个 Worker 能共用队列而不会互相把对方正在跑的导入判死。失败批次保留着压缩包，导入页直接点
「重试」即可，不用重新上传（重试会先清掉该批次已写入的半截数据再重新入队）。

### Bucket 必配：跨域（CORS）规则

浏览器直传是**跨域 PUT**，没有这条规则浏览器会在发请求前就拦掉，上传页报「无法直传到对象
存储」。这一步在对象存储控制台上配，不在代码或环境变量里。

阿里云 OSS：控制台 → 对应 Bucket → **数据安全 → 跨域设置** → 创建规则

| 项 | 值 |
|---|---|
| 来源 Source | 应用访问地址，如 `https://voicelens.example.com`（本地开发再加一行 `http://localhost:3000`） |
| 允许 Methods | `PUT` |
| 允许 Headers | `*` |
| 暴露 Headers | **不需要填** |
| 缓存时间 | 默认即可 |

几点容易踩的：

- **来源要精确匹配协议 + 域名 + 端口**，`https://` 和 `http://`、带不带端口都算不同来源。
- 预检 `OPTIONS` 由同一条规则自动覆盖，不用单独勾。
- **不需要暴露 ETag**：分片的 ETag 由服务端 `ListParts` 读取，不经过浏览器。
- **这条规则不授予任何权限**。它不是 ACL、不是 Bucket Policy，只是告诉浏览器「这个来源可以
  读到响应」。真正的授权全部来自服务端签的一次性分片 URL，Bucket 保持私有。
- **模型拉音频不需要 CORS**：那是模型服务端到端拉取，不经过浏览器，CORS 机制不参与。它只
  要求接入点公网可达（填了内网接入点 `oss-*-internal.aliyuncs.com` 就拉不到，浏览器直传同理）。

另外建议再加一条**生命周期规则**清理「未完成的分片上传」（OSS：Bucket → 数据管理 → 生命周期 →
碎片过期天数，设 7 天）。中断后再也没人续传的上传，分片会一直占着存储且不计入对象列表——
这是桶里唯一一处不会自己消失的残留：成功导入后暂存的压缩包会立即删除，删除批次时也会连
带删掉它，只有「上传到一半就再没人管」的分片需要靠这条规则兜底。

其它 S3 兼容存储同理，只是入口名字不同：AWS S3 在 Bucket → Permissions → CORS，填
`{"AllowedOrigins":["https://…"],"AllowedMethods":["PUT"],"AllowedHeaders":["*"]}`；MinIO 默认
放开 CORS，通常不用配。

### 分析模型

模型不再由启动配置决定，而是**由所有者在「设置 → 分析模型」里配置任意多套**，每套就是一个
OpenAI 兼容的 Chat Completions 端点（接口地址 + 模型 id + API Key），按能力分成两类：

| 类型 | 输入模态 | 承担的调用 |
|---|---|---|
| 多模态模型 | 文本 + 图像 | 全部纯文本调用：用户层、全局层、报告生成，以及规划里写提示词那一步 |
| omni 模型 | 文本 + 图像 + 音频 | 唯一可以接收音频的一类：规划试听、会话层带音频的分析 |

两类怎么配合，由**分析模式**决定，一共四种：

| 模式 | 含音频的会话 | 无音频的会话 | 汇总与报告 |
|---|---|---|---|
| 全部用 omni 统一分析 | omni 一次 | omni 一次 | omni |
| 涉及音频用 omni，其余用多模态 | omni 一次 | 多模态一次 | 多模态 |
| omni 分析后多模态二次优化 | omni（音频+转录）→ 多模态（结果+转录，不含音频） | 多模态一次 | 多模态 |
| 音频独立分析后交多模态 | omni（仅音频，出「音频观察」）→ 多模态（观察+完整对话） | 多模态一次 | 多模态 |

「含音频」指该会话确实有音频片段、且工作流里的音频开关是开的；签不出预签名 URL 的会话按
**无音频**处理——所以后两种模式不会因为音频链路退化而白白多花一次调用。规划阶段在后三种模式
下一致：试听音频永远走 omni，写提示词走多模态。

模式与模型的选择分两层，**逐字段继承**：

- **全局默认**：设置页里配一次，所有数据源默认跟随。
- **数据源覆盖**：数据源的「分析模型」页签，可以只改模式、或只换其中一个模型，没改的字段继续
  跟随全局。该页签底部有一张路由表，列出保存后每一类调用实际会用到哪个模型。

配置对**任务规划和实际分析任务同时生效**，作业在被 Worker 领取时解析一次，所以改完设置不必
重启 Worker，下一个任务就是新配置。跑完的任务会把当次用到的模式与两个模型写进
`analysis_tasks.stats.models`,并按实际路由统计每种调用各跑了多少个会话
（`stats.session_strategies`），任务页上直接能看到。

**关于 API Key**:填进来的 Key 用 AES-256-GCM 加密后存库，密钥取 `MODEL_SECRET`,未设置时回退
`AUTH_SECRET`。前端任何时候都只拿得到掩码（`sk-…a1b2`），编辑时留空即保持原值。若在没有设
`MODEL_SECRET` 的情况下轮换了 `AUTH_SECRET`,已存的 Key 会解不开——设置页会直接把这些行标红提示
重填，而不是等到任务跑起来才报错。

**升级提示**:本版本不迁移旧的 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`。新版本起来后模型列表是
空的，规划与分析任务会以明确的中文错误失败，由所有者在设置页重新配置即可。这样做是为了让 Key
以加密形式重新入库，而不是让环境变量里的明文继续当真相。

### 音频用没用，报告里看得见

音频是否送进模型由**开关**决定，不是「数据里有就用」。三个阶段各有一个，默认值不同：

| 阶段 | 参数 | 默认 |
|---|---|---|
| 智能规划 | 规划时听音频 | **开**（只抽几个样本，便宜） |
| 预览报告 | 预览时送入音频 | 关 |
| 会话层分析 | 送入音频 / 每会话音频上限 | 关 / 8 |

都在**工作流画布**上：点一下节点，右侧出参数面板，改完点保存。其中规划与预览两个也出现在
**分析工作台**上，两处读的是同一份工作流配置，工作台跑一次就把当次参数写回工作流，所以两个
页面不会各说各话。会话层分析的开关只在画布上，启动全量分析时不接受临时覆盖——画布是唯一真相。

音频链路是会**悄悄退化**的：签名失败、接入点不通、模型没拉到，提示词都会让模型退回只看转录，
任务照样 `completed`、报告照样生成。所以每次运行都会统计**实际送达**的量，写进
`analysis_tasks.stats.audio`，并在报告顶部渲染成一枚 chip：

```
音频  未启用（纯文本分析）
音频  已启用 · 312/480 会话 · 1,847 段
音频  已启用 · 300/480 会话 · 1,800 段，37 段未取到
音频  已启用，但 1,847 段全部未取到        ← 橙色高亮：开关开着但一段都没送到
```

最后一行是部署后最该盯的那一种：配置看起来是对的，实际一段都没进模型。预览报告同样带这枚
chip，所以「开音频 / 不开音频各跑一次预览对比效果」这条路是可验证的，不用靠猜。

### extra 字段的统计口径

`extra` 的真实取值分布由 Postgres 直算（`extra_histogram`），是报告「确定性指标」的来源，
规则是**每个字段只产出一种口径**：

- 字段在 schema 里声明了 → 按声明的 `kind` 统计：`number` 出均值/中位数/P90/最大值/样本数，
  其余（`enum`/`sentiment`/`boolean`/`text`）出取值计数。
- 未声明 → 按实际占多数的类型推断，这正是「从数据推断」与 schema 描述文件的引导场景。
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
| `IMPORT_MAX_ZIP_MB` | 单个压缩包上限，MB（默认 5120 = 5GB） |
| `IMPORT_KEEP_SOURCE_ZIP` | 导入成功后保留暂存的压缩包（默认 false，解包后即删） |
| `MODEL_SECRET` | 加密库里模型 API Key 的密钥；不填则回退 `AUTH_SECRET`（见〈分析模型〉） |
| `WORKER_POLL_MS` | Worker 轮询间隔 |
| `VOICELENS_ROLE` | 仅容器：不带命令参数时跑哪个角色（`web` 默认 / `worker` / `all` / `migrate`） |
| `VOICELENS_MIGRATE_ON_START` | 仅容器：`web`/`all` 启动前自动应用迁移（默认关） |

## 权限模型

角色存在 `users.role` 一列，四个取值：

| 角色 | 看数据 | 管数据 | 分配角色 |
|---|---|---|---|
| `owner` | 全部 | 全部 | 任意角色，含任免管理员；平台第一个账号，唯一且不可转让 |
| `admin` | 全部 | 全部 | 仅在「成员 ↔ 无权限」之间调整 |
| `member` | 自己创建的数据源 | 同左 | 无 |
| `none` | 无 | 无 | 无；新注册账号的默认值，登录后落在 `/pending` 等待开通 |

**归属以数据源为单位**：`sessions` / `messages` / `workflows` / `analysis_templates` /
`planning_jobs` / `template_previews` / `analysis_tasks` 全部挂在 `data_source_id` 下，
所以校验 `data_sources.created_by` 一处即覆盖其下全部内容。创建者被删号的数据源
（`created_by` 为 null）只有 owner / admin 看得到。

规则集中在三个文件，不散落在各处：

| 文件 | 职责 |
|---|---|
| `src/lib/auth/roles.ts` | 角色表与分配规则（无服务端依赖，前端选择器与后端校验共用同一份） |
| `src/lib/models/mode.ts` | 分析模式与调用路由表（同样无服务端依赖，配置页与引擎共用同一份） |
| `src/lib/auth/access.ts` | 归属判定：`canAccessSource` / `resolveOwnedRow` / `resolveAudioSource` |
| `src/lib/actions/common.ts` | 守卫：`requireSession` / `requireOwnerSession` / `require*Access` / `require*Page` / `ownerScope` |

跨数据源的列表查询（`listDataSources` / `listTasks` / `listWorkflows`）接收 `ownerScope()`
产出的过滤值：owner/admin 传 null 不过滤，成员传自己的 id。「不存在」与「不是你的」返回
同样的结果，因此无法用来探测 id 是否存在。

角色**不写进会话 Cookie**，`currentUser()` 每次请求都回库读取，所以调整角色后对方下一次
请求即生效，无需重新登录。

回归测试（需要一个**可写坏的**临时库，会自建再自清 fixture 行）：

```bash
ACCESS_TEST_DATABASE_URL=postgresql://... npm run test:access
```

分析模式与模型注册表也有一份同样形态的回归测试，其中路由与加解密部分不依赖数据库、可以直接跑：

```bash
npm run test:models                                       # 只跑路由/继承/加解密
MODELS_TEST_DATABASE_URL=postgresql://... npm run test:models   # 再加上注册表解析
```

## 安全边界

- 授权在应用层：未登录请求在 middleware 被重定向，Server Actions 与 Route Handlers 各自再按
  创建者校验一次（见〈权限模型〉）。`middleware.ts` 跑在 Edge runtime、只验签名 Cookie，读不到角色，
  因此角色校验落在 `src/app/(app)/layout.tsx` 与各 action / route 里。
- 会话是一枚 HS256 签名的 HttpOnly Cookie（7 天，活跃使用会自动续期）；口令用 argon2id 哈希
  （19 MiB / 2 轮）。登录失败不区分「密码错」与「账号不存在」，避免枚举。
- 浏览器只与本平台自己的路由通信：报告、音频、任务状态都经服务端转发，数据库与对象存储凭据
  不下发到前端。导入上传是唯一一条浏览器直连对象存储的链路，走的也是**服务端签名的一次性
  分片 PUT URL**，前端拿不到任何长期凭据；对象路径由服务端按 `imports/<数据源 id>/…` 生成，
  签名与合并前都会校验它属于当前数据源。
- 音频桶保持私有，播放与送模型都走**短时效预签名 URL**（播放 10 分钟，送模型 1 小时）。
- 模型 API Key 只有**所有者**能新增和修改（`requireOwnerSession`），AES-256-GCM 加密后入库，
  明文只在真正要发起调用的那一刻在服务端解出；前端拿到的永远是掩码。成员为自己的数据源挑模型
  走的是普通数据源守卫，挑得到名字，拿不到凭据。
- 数据库里不存文件字节；音频仅存对象路径。

> 音频送模型时传的是预签名 URL，由模型服务**主动回源**拉取。若对象存储不可公网访问，
> 多模态链路会退化成纯文本分析（提示词里写了「音频不可用则仅依据转录」），任务依然成功。
> 这种退化现在**不再是静默的**：报告顶部有一枚「音频」chip，见〈[音频用没用，报告里看得见](#音频用没用报告里看得见)〉。

## 演示数据

`导入` 页有两个入口：**导入示例数据**（车机语音助手，服务端生成并直接入库，
附带推荐 extra schema 与业务描述）与 **下载示例 zip**（同一数据集，可自行检查结构后上传）。
示例含程序合成的可听 WAV 波形，用于验证多模态链路是否打通。
示例 zip 里自带一份 `voicelens.schema.json`，既是 schema 描述文件的可运行样例，也能直接照着改。
