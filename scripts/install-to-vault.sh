#!/usr/bin/env bash
# 一键把插件装进 Obsidian vault 并启用；同时铺一份样例页到测试目录。
#
#   ./scripts/install-to-vault.sh [vault路径]
#
# 默认 vault：/Users/mac/Documents/Obsidian Vault
set -euo pipefail

VAULT="${1:-/Users/mac/Documents/Obsidian Vault}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ID="html-single-file-view"
DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"
TEST_DIR="$VAULT/html-view-test"

if [ ! -d "$VAULT/.obsidian" ]; then
  echo "✗ 找不到 vault：$VAULT" >&2
  exit 1
fi

if [ ! -f "$ROOT/dist/plugin/main.js" ]; then
  echo "✗ 没有构建产物，先执行：npm run build:all" >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$ROOT/dist/plugin/main.js" "$ROOT/dist/plugin/manifest.json" "$ROOT/dist/plugin/styles.css" "$DEST/"
echo "✓ 插件已安装到 $DEST"

# 写入 community-plugins.json 以启用插件
node - "$VAULT" "$PLUGIN_ID" <<'NODE'
const fs = require("fs");
const path = require("path");
const vault = process.argv[2];
const id = process.argv[3];
const file = path.join(vault, ".obsidian", "community-plugins.json");
let list = [];
try {
  list = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(list)) list = [];
} catch {
  list = [];
}
if (!list.includes(id)) {
  list.push(id);
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n", "utf8");
  console.log("✓ 已启用插件：" + id);
} else {
  console.log("· 插件已在启用列表中：" + id);
}
NODE

# 铺样例页（写到 auto-* ：自动验收专用，绝不覆盖用户手测过的 demo-* 数据）
mkdir -p "$TEST_DIR"
cp "$ROOT/templates/template-quiz.html" "$TEST_DIR/auto-quiz.html"
cp "$ROOT/templates/template-news.html" "$TEST_DIR/auto-news.html"
echo "✓ 样例页已就位：$TEST_DIR/auto-quiz.html, auto-news.html"
echo "  （demo-quiz.html / demo-news.html 是用户手测样例，本脚本不覆盖）"

echo
echo "下一步：重启 Obsidian（设置 → 常规 → 重新加载应用，或完全退出再打开）"
