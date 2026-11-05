#!/usr/bin/env bash
# 采集 UI 截图证据：打开样例页 → 等待渲染 → 抓 Obsidian 窗口截图
#
#   ./scripts/capture-screenshots.sh [vault路径]
#
# 需要 macOS 图形会话处于「已解锁」状态（锁屏时系统不允许截屏）。
set -euo pipefail

VAULT="${1:-/Users/mac/Documents/Obsidian Vault}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/evidence"
mkdir -p "$OUT"

# 1. 让 Obsidian 打开样例页（插件接管 .html 扩展名）
open "obsidian://open?vault=$(python3 -c "import urllib.parse;print(urllib.parse.quote('Obsidian Vault'))")&file=$(python3 -c "import urllib.parse;print(urllib.parse.quote('html-view-test/demo-quiz.html'))")"
sleep 6

# 2. 取 Obsidian 窗口坐标
BOUNDS="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  tell process "Obsidian"
    set frontmost to true
    delay 0.5
    set p to position of window 1
    set s to size of window 1
    return (item 1 of p as string) & "," & (item 2 of p as string) & "," & (item 1 of s as string) & "," & (item 2 of s as string)
  end tell
end tell
APPLESCRIPT
)"

echo "窗口坐标：$BOUNDS"
# 3. 截图
screencapture -x -R"$BOUNDS" "$OUT/obsidian-html-view.png"
echo "✓ 截图已保存：$OUT/obsidian-html-view.png"

# 4. 再截一张「图片放大态」：触发一次双击等价动作不现实，改为提示人工操作
echo "提示：在 Obsidian 里双击演示图片，可再手动截一张放大态。"
