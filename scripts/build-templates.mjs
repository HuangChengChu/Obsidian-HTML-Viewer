/**
 * 构建成品模板：把 runtime.js 与演示图片注入模板源，产出单文件 HTML。
 *
 *   node scripts/build-templates.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const srcDir = resolve(root, "templates/src");
const outDir = resolve(root, "templates");
mkdirSync(outDir, { recursive: true });

const runtime = readFileSync(resolve(srcDir, "runtime.js"), "utf8");
const demoImage = readFileSync(resolve(srcDir, "demo-image.txt"), "utf8").trim();

const targets = [
  { src: "news.html", out: "template-news.html" },
  { src: "quiz.html", out: "template-quiz.html" },
];

for (const t of targets) {
  let html = readFileSync(resolve(srcDir, t.src), "utf8");
  // 用函数式替换：runtime 里含有 `$&` 等字符，字符串替换会被当成特殊模式
  html = html.replace("__RUNTIME__", () => `<script>\n${runtime}\n</script>`);
  html = html.replace(/__DEMO_IMG__/g, () => demoImage);
  if (html.includes("__RUNTIME__") || html.includes("__DEMO_IMG__")) {
    throw new Error(`占位符未全部替换：${t.src}`);
  }
  const outPath = resolve(outDir, t.out);
  writeFileSync(outPath, html, "utf8");
  console.log(`[templates] ${t.out}  ${(html.length / 1024).toFixed(1)} KB`);
}
