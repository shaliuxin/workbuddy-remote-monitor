#!/bin/bash
# 停止 WorkBuddy 监控服务端（macOS, 端口 48787）
PIDS=$(lsof -ti tcp:48787 -sTCP:LISTEN 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill 2>/dev/null
  echo "[完成] 监控服务端已停止 (PID $PIDS)"
else
  echo "[提示] 48787 端口没有监听进程"
fi
