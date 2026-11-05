#!/usr/bin/env bash
# 打包交付物：两个 zip
#   dist/html-single-file-view-<版本>.zip     —— Obsidian 插件本体（装进 .obsidian/plugins/）
#   dist/Obsidian-HTML-Viewer-<版本>.zip       —— 完整工程（源码 + 模板 + 文档 + 测试）
#
#   ./scripts/package-dist.sh [版本号]   默认从 package.json 读
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./package.json').version")}"
DIST="$ROOT/dist"
mkdir -p "$DIST"

if [ ! -f "$DIST/plugin/main.js" ]; then
  echo "✗ 没有构建产物，先执行：npm run build:all" >&2
  exit 1
fi

# 1) 插件包：直接是 .obsidian/plugins/<id>/ 的内容
PLUGIN_ZIP="$DIST/html-single-file-view-$VERSION.zip"
TMP_PLUGIN="$DIST/.tmp-plugin-$VERSION.zip"
rm -f "$TMP_PLUGIN"
( cd "$DIST/plugin" && zip -q -X "$TMP_PLUGIN" main.js manifest.json styles.css )
mv -f "$TMP_PLUGIN" "$PLUGIN_ZIP"
echo "✓ $PLUGIN_ZIP"

# 2) 工程包：源码 / 模板 / 文档 / 测试（不含 node_modules、dist、.git）
FULL_ZIP="$DIST/Obsidian-HTML-Viewer-$VERSION.zip"
TMP_FULL="$DIST/.tmp-full-$VERSION.zip"
rm -f "$TMP_FULL"
zip -q -X -r "$TMP_FULL" \
  LICENSE README.md package.json package-lock.json \
  main.js manifest.json styles.css versions.json \
  .github \
  docs plugin/src plugin/package.json plugin/manifest.json plugin/versions.json \
  plugin/styles.css plugin/tsconfig.json plugin/esbuild.config.mjs \
  templates/src templates/ext templates/template-quiz.html templates/template-news.html \
  templates/template-external.html \
  scripts tests \
  -x "*/node_modules/*" "*/.DS_Store" "*/.git/*"
mv -f "$TMP_FULL" "$FULL_ZIP"
echo "✓ $FULL_ZIP"

echo
unzip -l "$PLUGIN_ZIP" | tail -6
