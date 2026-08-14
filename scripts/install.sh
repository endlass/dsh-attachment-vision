#!/usr/bin/env bash
# dsh-attachment-vision 一键安装脚本（幂等）：
#   1. 复制插件到 $DSH_HOME/profiles/node_modules/
#   2. 在 $DSH_HOME/cordis.patch.yml 注册（已注册则跳过）
#   3. 提示配置识图模型 API Key（写入 ~/.dsh/.env）
#   4. 提示重启 dsh
# 用法: bash scripts/install.sh [/path/to/dsh-attachment-vision]
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_ID="dsh-attachment-vision"
ENV_FILE="$DSH_HOME/.env"

if ! command -v dsh >/dev/null 2>&1; then
  echo "❌ 未找到 dsh 命令。请先安装 DeepSeek Harness（npx @deepseek-ai/dsh）再运行本脚本。"
  exit 1
fi

echo "==> [1/4] 安装插件到 $DSH_HOME/profiles/node_modules/$PLUGIN_ID"
mkdir -p "$DSH_HOME/profiles/node_modules"
if [ -e "$DSH_HOME/profiles/node_modules/$PLUGIN_ID" ]; then
  rm -rf "$DSH_HOME/profiles/node_modules/$PLUGIN_ID.bak-$(date +%s)"
  mv "$DSH_HOME/profiles/node_modules/$PLUGIN_ID" "$DSH_HOME/profiles/node_modules/$PLUGIN_ID.bak-$(date +%s)"
fi
cp -r "$SRC" "$DSH_HOME/profiles/node_modules/$PLUGIN_ID"
rm -rf "$DSH_HOME/profiles/node_modules/$PLUGIN_ID/.git" 2>/dev/null || true
echo "    ✅ 已复制（旧版本已备份为 .bak-*）"

echo "==> [2/4] 注册到 $DSH_HOME/cordis.patch.yml（幂等）"
PATCH_FILE="$DSH_HOME/cordis.patch.yml"
touch "$PATCH_FILE"
if grep -q "id: $PLUGIN_ID" "$PATCH_FILE"; then
  echo "    ⏭  已注册，跳过"
else
  printf -- '- insert:\n    - id: %s\n      name: %s\n' "$PLUGIN_ID" "$PLUGIN_ID" >> "$PATCH_FILE"
  echo "    ✅ 已追加注册条目"
fi

echo "==> [3/4] 检查识图模型 API Key"
if grep -qE '^(QWEN_VL_API_KEY|VISION_API_KEY|DASHSCOPE_API_KEY|ZHIPUAI_API_KEY)=' "$ENV_FILE" 2>/dev/null; then
  echo "    ✅ $ENV_FILE 已有 API Key"
else
  echo "    ⚠️  $ENV_FILE 未配置 API Key，请手动追加："
  echo ""
  echo "      QWEN_VL_API_KEY=sk-xxx"
  echo "      # QWEN_VL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1"
  echo "      # QWEN_VL_MODEL=qwen3-vl-flash"
  echo "      # QWEN_VL_FALLBACK_MODELS=glm-4.6v-flash,glm-4v-flash   # 可选：限流/5xx 时自动降级"
  echo ""
  echo "    （也可用 VISION_API_KEY / DSH_VISION_API_KEY / ZHIPUAI_API_KEY / DASHSCOPE_API_KEY）"
fi

echo "==> [4/4] 完成"
echo "    请重启 dsh 使插件生效："
echo "      systemctl restart dsh    # systemd 部署"
echo "      或重启你的 dsh 进程（npx @deepseek-ai/dsh web）"
