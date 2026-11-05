/**
 * 把构建产物摆到仓库根目录。
 *
 * Obsidian 插件的仓库约定：根目录就是插件本体
 * （main.js / manifest.json / styles.css / versions.json），
 * BRAT 和手动安装都从这里取；源码放在 plugin/src 等子目录。
 *
 *   node scripts/stage-release.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist/plugin");

if (!existsSync(resolve(dist, "main.js"))) {
  console.error("✗ 没有构建产物，先执行：npm run build:all");
  process.exit(1);
}
mkdirSync(resolve(root, "release"), { recursive: true });

const files = [
  ["dist/plugin/main.js", "main.js"],
  ["dist/plugin/manifest.json", "manifest.json"],
  ["dist/plugin/styles.css", "styles.css"],
  ["plugin/versions.json", "versions.json"],
];

for (const [from, to] of files) {
  const src = resolve(root, from);
  if (!existsSync(src)) {
    console.error(`✗ 缺文件：${from}`);
    process.exit(1);
  }
  copyFileSync(src, resolve(root, to));
  console.log(`[stage] ${from} → ${to}`);
}
console.log("[stage] 仓库根目录已是插件本体");
