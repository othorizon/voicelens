#!/bin/bash
# VoiceLens 容器入口：同一个镜像按第一个参数切换角色。
#
#   web      Next.js 服务，监听 $PORT（默认 3000）——不传参数时的默认角色
#   worker   常驻后台 Worker，轮询规划 / 预览 / 全量分析三类作业队列
#   all      一个容器里同时跑 Web 与 Worker（单机省事，代价见下）
#   migrate  顺序应用 db/migrations/*.sql 后退出（幂等，`migrate --dry` 只列待执行项）
#
# 其它参数原样执行，方便 `docker run ... voicelens bash` 或跑 scripts/ 下的脚本。
#
# web / all 认 VOICELENS_MIGRATE_ON_START=true：起服务前先跑一次迁移。
# db/apply.ts 没有互斥锁，所以同一个库上只让一个容器开这个开关。
set -euo pipefail

migrate_if_requested() {
  case "${VOICELENS_MIGRATE_ON_START:-}" in
    1 | true | TRUE | yes | on)
      echo "[entrypoint] VOICELENS_MIGRATE_ON_START -> 先应用数据库迁移"
      node_modules/.bin/tsx db/apply.ts
      ;;
  esac
}

role="${1:-web}"
if [ "$#" -gt 0 ]; then shift; fi

case "$role" in
  web)
    migrate_if_requested
    # next start 自己读 PORT，默认监听 0.0.0.0
    exec node node_modules/next/dist/bin/next start "$@"
    ;;

  worker)
    # 让连接池按 Worker 的默认上限（8）来开，见 src/lib/db/index.ts
    export VOICELENS_ROLE=worker
    exec node_modules/.bin/tsx worker/index.ts "$@"
    ;;

  all)
    # 单机模式：Worker 后台、Web 前台，仍是两个独立进程（各自的连接池，互不阻塞）。
    # 任一进程退出就把另一个也收掉、按它的退出码结束容器，交给 --restart 拉起来——
    # 否则会出现「容器还活着但 Worker 已经死了」，任务只排队不执行还看不出来。
    # 代价：日志混在一起、不能只重启/只扩容其中一个。数据量上来了就拆成两个容器。
    migrate_if_requested
    VOICELENS_ROLE=worker node_modules/.bin/tsx worker/index.ts &
    worker_pid=$!
    node node_modules/next/dist/bin/next start "$@" &
    web_pid=$!

    # docker stop：两个进程都收 SIGTERM，收完以 0 退出（别让正常停机看起来像失败）
    trap 'trap - TERM INT; echo "[entrypoint] 收到停止信号，正在停 web 与 worker"; kill -TERM "$worker_pid" "$web_pid" 2>/dev/null || true; wait || true; exit 0' TERM INT

    status=0
    wait -n || status=$?
    echo "[entrypoint] web/worker 之一已退出（code=${status}），停止另一个进程"
    kill -TERM "$worker_pid" "$web_pid" 2>/dev/null || true
    wait || true
    exit "$status"
    ;;

  migrate)
    exec node_modules/.bin/tsx db/apply.ts "$@"
    ;;

  *)
    exec "$role" "$@"
    ;;
esac
