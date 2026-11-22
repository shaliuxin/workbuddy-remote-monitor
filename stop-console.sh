#!/bin/bash
# 停止 WorkBuddy 控制台（macOS）—— 不影响监控服务端
for P in 48790 48791 48792 48793 48794 48795; do
  PIDS=$(lsof -ti tcp:$P -sTCP:LISTEN 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null && echo "[停止] 控制台 (端口 $P)"
  fi
done
echo "done"
