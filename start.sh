#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN=python
else
  echo "未找到 Python 3，请先安装 Python 3.10 或更高版本。"
  exit 1
fi

PORT=${AUCTION_PORT:-8080}

echo "朋友杯球员竞拍系统正在启动……"
echo "本机访问：http://127.0.0.1:${PORT}"

if command -v ipconfig >/dev/null 2>&1; then
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
elif command -v hostname >/dev/null 2>&1; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
else
  LAN_IP=""
fi

if [ -n "$LAN_IP" ]; then
  echo "局域网访问：http://${LAN_IP}:${PORT}"
else
  echo "其他设备请访问：http://这台电脑的局域网IP:${PORT}"
fi

echo "按 Ctrl+C 停止服务。"
exec "$PYTHON_BIN" app.py
