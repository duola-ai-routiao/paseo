#!/usr/bin/env bash
#
# Paseo 本地一键部署脚本
#
# 行为：
#   1. 构建 server 侧全部 workspace 包（highlight -> relay -> protocol -> client -> server -> cli）
#   2. 导出浏览器版 Web UI 并打包进 packages/server/dist/server/web-ui
#   3. 在专属 dev home（.dev/paseo-home-deploy）中以 --web-ui 模式启动守护进程
#      默认监听 127.0.0.1:6769（可通过 PASEO_DEPLOY_LISTEN 覆盖）
#
# 安全约束：
#   - 绝不触碰 6767（桌面版/生产守护进程）与 6768（开发守护进程）
#   - 重复执行时自动先停止由本脚本启动的旧实例（通过 pid 文件匹配）
#
# 用法：
#   ./scripts/deploy-local.sh            # 构建 + 启动
#   ./scripts/deploy-local.sh stop       # 仅停止本脚本启动的实例
#   ./scripts/deploy-local.sh restart    # 停止 + 构建 + 启动
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LISTEN="${PASEO_DEPLOY_LISTEN:-127.0.0.1:6769}"
HOST="${LISTEN%:*}"
PORT="${LISTEN##*:}"
DEPLOY_HOME="${PASEO_DEPLOY_HOME:-$ROOT_DIR/.dev/paseo-home-deploy}"
PID_FILE="$DEPLOY_HOME/daemon-deploy.pid"
LOG_FILE="$DEPLOY_HOME/deploy-daemon.log"

say() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; }

stop_instance() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      say "停止旧实例 (pid=$pid) ..."
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}

wait_port_free() {
  for _ in $(seq 1 20); do
    if ! (exec 3<>"/dev/tcp/$HOST/$PORT") 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  err "端口 $LISTEN 仍被占用，且不属于本脚本管理的实例。请检查: ss -ltnp | grep $PORT"
  exit 1
}

wait_ready() {
  say "等待守护进程就绪 (http://$LISTEN) ..."
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://$LISTEN/" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  err "守护进程在 60 秒内未就绪，日志见: $LOG_FILE"
  exit 1
}

cmd_stop() {
  stop_instance
  say "已停止。"
}

cmd_start() {
  mkdir -p "$DEPLOY_HOME"

  say "══════ 1/3 构建 server 侧 workspace 包 ══════"
  npm run build:server

  say "══════ 2/3 构建 daemon Web UI ══════"
  npm run build:daemon-web-ui

  say "══════ 3/3 启动守护进程 ($LISTEN, web-ui 开启) ══════"
  stop_instance
  wait_port_free

  PASEO_HOME="$DEPLOY_HOME" \
  PASEO_LISTEN="$LISTEN" \
  PASEO_WEB_UI_ENABLED=true \
  PASEO_CORS_ORIGINS='*' \
    nohup npm run start --workspace=@getpaseo/server -- --web-ui \
      >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  wait_ready

  say "══════════════════════════════════════════════"
  say "  ✅ 部署完成"
  say "  Web UI : http://$LISTEN/"
  say "  Home   : $DEPLOY_HOME"
  say "  日志   : $LOG_FILE"
  say "  PID    : $pid  (记录于 $PID_FILE)"
  say "  停止   : ./scripts/deploy-local.sh stop"
  say "══════════════════════════════════════════════"
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_start ;;
  *) err "未知命令: $1 (可用: start|stop|restart)"; exit 1 ;;
esac
