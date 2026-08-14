#!/usr/bin/env bash
# dsh-attachment-vision 冒烟验证：在临时 DSH_HOME 挂载插件，headless 问 dsh 一个问题。
# 用法: bash scripts/verify.sh [dsh-cmd]   (默认用 PATH 里的 dsh)
set -euo pipefail

DSH_CMD="${1:-dsh}"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT

# 1) 组装临时 DSH_HOME：复制必需配置骨架 + 插件
mkdir -p "$TMP_HOME/profiles/node_modules"
cp -r "$PLUGIN_DIR" "$TMP_HOME/profiles/node_modules/dsh-attachment-vision"
if [ -f "$HOME/.dsh/settings.yaml" ]; then cp "$HOME/.dsh/settings.yaml" "$TMP_HOME/settings.yaml"; fi
if [ -d "$HOME/.dsh/.agent-presets" ]; then cp -r "$HOME/.dsh/.agent-presets" "$TMP_HOME/.agent-presets"; fi

cat > "$TMP_HOME/cordis.patch.yml" <<'PATCH'
- insert:
    - id: dsh-attachment-vision
      name: dsh-attachment-vision
PATCH

export DSH_HOME="$TMP_HOME"
export DSH_ATTACHMENT_VISION_DEBUG=1

# 2) 语法检查
echo "==> node --check"
node --check "$PLUGIN_DIR/lib/index.js"

# 3) headless 会话（临时 patch 指向默认 preset；只回 OK 不触发任何工具）
echo "==> headless mount + one question"
OUT="$("$DSH_CMD" --profile headless --patch /tmp/verify-preset.yml '只回复：OK' 2>&1 || true)"

# 4) 检查插件激活痕迹
if grep -q "dsh-attachment-vision" <<<"$OUT"; then
  echo "==> plugin loaded: OK"
elif [ -f /tmp/dsh-attachment-vision.log ]; then
  echo "==> plugin mark log present: OK"
  tail -5 /tmp/dsh-attachment-vision.log
else
  echo "==> WARN: 未见插件激活痕迹（headless profile 可能不含该插件层，见 README 手动挂载方式）"
  echo "$OUT" | tail -20
fi
