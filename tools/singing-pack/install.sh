#!/usr/bin/env bash
# 唱歌整合包 - 环境安装（Linux / macOS）
set -e
cd "$(dirname "$0")"

echo "============================================"
echo " 唱歌整合包 - 环境安装"
echo "============================================"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[!] 没找到 python3，请先安装 Python 3.10 或 3.11"
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "[1/3] 创建虚拟环境 .venv ..."
  python3 -m venv .venv
else
  echo "[1/3] .venv 已存在，跳过"
fi

echo "[2/3] 升级 pip ..."
.venv/bin/python -m pip install --upgrade pip

echo "[3/3] 安装依赖（rvc-python + imageio-ffmpeg）..."
# 无 NVIDIA 显卡时加 --torch-cpu，体积小很多
.venv/bin/python python/rvc-infer.py install "$@"

echo ""
echo "[检查] 环境状态："
.venv/bin/python python/rvc-infer.py info

echo ""
echo "============================================"
echo " 安装完成。接下来："
echo "  1. 把 .pth 音色模型放进 voice-models/"
echo "  2. 把歌放进 songs/，或用 tools/fetch-song.js 抓"
echo "  3. 把 skills/singing 复制到 QQ-agent 的 skills/"
echo "  4. 控制台启用「唱歌」技能，填好 Python 路径"
echo "============================================"
