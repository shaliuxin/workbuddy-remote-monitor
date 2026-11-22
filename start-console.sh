#!/bin/bash
# WorkBuddy Monitor Console (macOS) —— 启动控制台
# 用法: bash start-console.sh
cd "$(dirname "$0")"

echo "========================================"
echo "  WorkBuddy Monitor Console"
echo "========================================"

# 1) 选择 Node 运行时：优先内置（按 CPU 架构），回退系统 node
ARCH=$(uname -m)
case "$ARCH" in
  arm64) RT="./runtime/node-arm64" ;;
  *)     RT="./runtime/node-x64" ;;
esac

# tar 包传输可能丢失可执行位，兜底补上
[ -f "$RT" ] && chmod +x "$RT" 2>/dev/null

if [ -x "$RT" ]; then
  echo "[OK] built-in runtime: $RT ($ARCH)"
else
  if command -v node >/dev/null 2>&1; then
    RT="node"
    echo "[OK] using system node ($ARCH)"
  else
    echo "[ERROR] runtime/$RT 不可执行，且未安装系统 Node.js"
    echo "        修复二选一："
    echo "          chmod +x runtime/node-arm64 runtime/node-x64"
    echo "          或 brew install node"
    exit 1
  fi
fi

# 2) 依赖检查（完整分发包已内联 ws，无需联网）
if [ ! -d "node_modules/ws" ]; then
  echo "[ERROR] 缺少 node_modules/ws，请使用完整分发包"
  exit 1
fi

echo "[START] console running in this window (close window = stop console)"
echo "        monitor server keeps running after console closes"
echo "        browser will open http://127.0.0.1:48790"
echo

# 3) 先开浏览器（页面每 2 秒自动重试，服务一起来就显示数据）
open http://127.0.0.1:48790 2>/dev/null || true

# 4) 当前终端直接运行控制台
"$RT" wb-console-server.js

echo
echo "[EXIT] console stopped."
