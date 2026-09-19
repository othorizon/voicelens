#!/bin/sh
# VoiceLens 容器入口：同一个镜像按第一个参数切换角色。
#
#   web      Next.js 服务，监听 $PORT（默认 3000）——不传参数时的默认角色
#   worker   常驻后台 Worker，轮询规划 / 预览 / 全量分析三类作业队列
#   migrate  顺序应用 db/migrations/*.sql 后退出（幂等，`migrate --dry` 只列待执行项）
#
# 其它参数原样执行，方便 `docker run ... voicelens sh` 或跑 scripts/ 下的脚本。
#
# Web 与 Worker 是两个独立进程（见 README「运行」），所以这里不做 all-in-one：
# 一个容器一个角色，任一进程退出即容器退出，交给 Docker / 编排器重启。
set -eu

role="${1:-web}"
if [ "$#" -gt 0 ]; then shift; fi

case "$role" in
  web)
    # next start 自己读 PORT，默认监听 0.0.0.0
    exec node node_modules/next/dist/bin/next start "$@"
    ;;
  worker)
    # 让连接池按 Worker 的默认上限（8）来开，见 src/lib/db/index.ts
    export VOICELENS_ROLE=worker
    exec node_modules/.bin/tsx worker/index.ts "$@"
    ;;
  migrate)
    exec node_modules/.bin/tsx db/apply.ts "$@"
    ;;
  *)
    exec "$role" "$@"
    ;;
esac
