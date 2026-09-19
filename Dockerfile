# VoiceLens 部署镜像（官方源）。国内网络请用 Dockerfile_cn，那份换了 npm/apt 镜像源并把时区设为 +8。
#
# 一个镜像承载三种角色，由第一个参数选择：web（默认）/ worker / migrate。
#
#   docker build -t voicelens:latest .
#   docker run --rm     --env-file .env.local                  voicelens:latest migrate
#   docker run -d --name voicelens-web    --env-file .env.local -p 3000:3000 voicelens:latest
#   docker run -d --name voicelens-worker --env-file .env.local voicelens:latest worker
#
# Web 与 Worker 必须都常驻（见 README「运行」）：Web 只写作业，Worker 执行长任务。
# 两者共用同一份镜像和同一套环境变量（.env.local.example 列全了）。
# 数据库与对象存储都在镜像外：容器本身无状态，不挂卷也不落盘。

# 换基础镜像（例如换 Node 版本或走镜像仓库）：--build-arg NODE_IMAGE=...
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- build
# 装全量依赖（next build 需要 typescript / tailwind 等 devDependencies）→ 构建 →
# 就地剪掉 devDependencies，剪完的 node_modules 直接交给运行阶段，省一次完整安装。
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# 先只拷依赖清单：package.json / package-lock.json 没变时这层走缓存
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# 构建期不连数据库：页面全是 force-dynamic，连接池是懒初始化的，
# 所以这里不需要 DATABASE_URL 之类的运行时凭据。
#
# typescript 是 devDependency，但 next start 每次启动都要加载 next.config.ts：
# 剪掉之后 Next 会在容器启动时自己 npm install typescript，既慢又要求运行期能连外网
# （离线或只读文件系统下直接起不来）。所以先把构建期装好的那份挪到一边，剪完再放回去
# ——typescript 没有自身依赖，整目录搬移即可，也不用为此多连一次镜像源。
RUN npm run build \
 && mv node_modules/typescript /tmp/typescript \
 && npm prune --omit=dev \
 && mv /tmp/typescript node_modules/typescript \
 && npm cache clean --force \
 && rm -rf .next/cache

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# 运行期要三样东西：构建产物 .next、生产依赖 node_modules、
# 以及 Worker 与迁移直接用 tsx 执行的 TS 源码（worker/、db/、被 worker 引用的 src/）。
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
COPY --chown=node:node worker ./worker
COPY --chown=node:node db ./db
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node package.json package-lock.json next.config.ts tsconfig.json ./
COPY docker/entrypoint.sh /usr/local/bin/voicelens
RUN chmod 755 /usr/local/bin/voicelens

# 基础镜像自带的非 root 账号（uid 1000）
USER node
EXPOSE 3000

# 刻意不设 CMD：设了就等于永远给入口脚本传一个参数，VOICELENS_ROLE 将永远不生效
# （托管平台通常只能填环境变量）。默认角色由入口脚本兜底，仍然是 web。
ENTRYPOINT ["voicelens"]
