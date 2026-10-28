#!/usr/bin/env bash
# 容器入口：同一个 WINEPREFIX、同一份 identity.json、同一份 bdms.node，起 N 个 serve 进程。
# 与 deploy/entrypoint.sh 的差别只有两件事：多进程、日志落文件（供宿主侧读）。
#
# 进程清单由 run.sh 经 VERIFY_SERVE_PORTS 传入（空格分隔的容器内端口）。
set -uo pipefail

cd /app
mkdir -p /logs

PORTS=${VERIFY_SERVE_PORTS:-8899 8900}
export LIBMSSDK_BIND=0.0.0.0
export LIBMSSDK_CLIENT_DIR="${LIBMSSDK_CLIENT_DIR:-/app/client}"
export LIBMSSDK_STATE_DIR=/app/data

if [ ! -f "${WINEPREFIX}/system.reg" ]; then
    echo "[verify] 首次启动：初始化 Wine prefix（约 20-40 秒）" >&2
    wineboot -u >/dev/null 2>&1 || true
fi

# 身份先落盘，再拉起进程：否则两个进程同时首次生成会分裂出两个 device_id。
# 那是 #2 的范围，不是本验证要测的东西；这里只做前置，不测竞态。
wine /opt/node-win/node.exe src/index.mjs config >/logs/identity-preflight.out 2>/logs/identity-preflight.err || true

for port in $PORTS; do
    LIBMSSDK_PORT="$port" wine /opt/node-win/node.exe src/index.mjs serve \
        >"/logs/serve-$port.out" 2>"/logs/serve-$port.err" &
    pid=$!
    echo "$pid" >"/logs/serve-$port.pid"
    echo "[verify] serve pid=$pid port=$port" >&2
done

wait
