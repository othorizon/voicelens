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
# playwright 现在是生产依赖（Worker 用它渲染并校验报告页面），但浏览器用镜像里的
# 发行版 chromium，所以跳过它 postinstall 时自带的那份下载。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
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

# ---------------------------------------------- 报告校验用的浏览器
# 报告页面是模型写的。平台在真实浏览器里渲染它、把校验结果和截图发回给模型，不合格就让
# 它改到合格为止。没有浏览器，这一步整段被跳过（只剩静态检查），报告就是「从来没人看过
# 一眼」直接发出去的 —— 线上报告排版错乱、深色模式看不见字、窄屏横向溢出，绝大多数
# 就是这里没有浏览器。
#
# 用发行版的 chromium，而不是 `npx playwright install`：后者要再下载一份 ~150MB 的浏览器
# 和一堆运行库，而 playwright 只需要一个可执行文件路径（VOICELENS_CHROMIUM_PATH，见
# src/lib/engine/report-validate.ts）。apt 会把它需要的系统库一并带上。
#
# fonts-noto-cjk 不是可选项：缺中文字体时截图里全是豆腐块，模型会照着「修」根本不存在
# 的排版问题，比不给它看更糟。
#
# 不想要这 ~300MB：--build-arg WITH_BROWSER=false。此时报告不做渲染校验也没有截图，
# 任务日志里会写明；自己另外提供浏览器的话，运行时用 -e VOICELENS_CHROMIUM_PATH=... 覆盖。
ARG WITH_BROWSER=true
RUN set -eu; \
    if [ "$WITH_BROWSER" = "true" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends chromium fonts-noto-cjk; \
      rm -rf /var/lib/apt/lists/*; \
      /usr/bin/chromium --version; \
    else \
      echo "WITH_BROWSER=false：镜像内不含浏览器，报告将跳过渲染校验与截图"; \
    fi
ENV VOICELENS_CHROMIUM_PATH=/usr/bin/chromium

# 运行期要三样东西：构建产物 .next、生产依赖 node_modules、
# 以及 Worker 与迁移直接用 tsx 执行的 TS 源码（worker/、db/、被 worker 引用的 src/）。
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
# 没有 public/：静态资源走 App Router 的约定文件（src/app/icon.svg、apple-icon.png），
# 构建时已编译进 .next。以后真加了 public/，这里要补一行 COPY，否则运行期 404。
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
