/**
 * G5 实机验收脚本（真实 Obsidian 进程内跑，不接受模拟）
 *
 *   node scripts/verify-real.mjs [vault路径]
 *
 * 前置条件：
 *   1. 插件已安装并启用（scripts/install-to-vault.sh）
 *   2. Obsidian 正在运行且已加载插件
 *
 * 脚本会：
 *   - 复位样例页（保证基线干净）
 *   - 通过 obsidian:// 协议触发插件内的自检 / 状态探测 / 复习清单
 *   - 直接校验 vault 里的文件字节与剪贴板内容
 */
import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VAULT = process.argv[2] || "/Users/mac/Documents/Obsidian Vault";
const TEST_DIR = join(VAULT, "html-view-test");
const PLUGIN_DIR = join(VAULT, ".obsidian/plugins/html-single-file-view");
const LOG_FILE = join(PLUGIN_DIR, "data.json");

const QUIZ = join(TEST_DIR, "auto-quiz.html");
const NEWS = join(TEST_DIR, "auto-news.html");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  —  " + detail : ""}`);
}
function sh(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}
function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    execSync("sleep 0.2");
  }
}
function uri(qs) {
  sh(`open "obsidian://html-view?${qs}"`);
}
function readLog() {
  try {
    return JSON.parse(readFileSync(LOG_FILE, "utf8")).log || [];
  } catch {
    return [];
  }
}
const BLOCK_RE =
  /<script id="html-quiz-progress" type="application\/json">([\s\S]*?)<\/script>/;
function blockOf(file) {
  const m = BLOCK_RE.exec(readFileSync(file, "utf8"));
  return m ? JSON.parse(m[1]) : null;
}
function stripBlock(file) {
  return readFileSync(file, "utf8").replace(
    /<script id="html-quiz-progress" type="application\/json">[\s\S]*?<\/script>/,
    "§BLOCK§",
  );
}

// ---------------------------------------------------------------- 0. 前置

if (!existsSync(join(PLUGIN_DIR, "main.js"))) {
  console.error("✗ 插件未安装，请先执行 scripts/install-to-vault.sh");
  process.exit(1);
}
mkdirSync(TEST_DIR, { recursive: true });
copyFileSync(join(ROOT, "templates/template-quiz.html"), QUIZ);
copyFileSync(join(ROOT, "templates/template-news.html"), NEWS);
const pristineQuiz = readFileSync(QUIZ, "utf8");

// 打开调试日志
uri("do=debug&enable=1");
sleep(1500);

// ---------------------------------------------------------------- 1. 自检写入

uri(
  `do=selftest&vault=${encodeURIComponent("Obsidian Vault")}&file=${encodeURIComponent(
    "html-view-test/auto-quiz.html",
  )}`,
);
sleep(7000);

const log1 = readLog();
check(
  "实机链路：iframe 握手 → 页面保存 → 插件写回",
  log1.some((l) => l.includes("收到消息 LOAD_PROGRESS")) &&
    log1.some((l) => l.includes("收到消息 SAVE_PROGRESS")) &&
    log1.some((l) => l.includes("写回成功")),
  `${log1.length} 条日志`,
);

const block = blockOf(QUIZ);
check("写回后数据区可解析且有内容", !!block, block ? `keys=${Object.keys(block).length}` : "无");
check(
  "作答已落盘（q1 = B）",
  block && block.answers && block.answers.q1 && block.answers.q1.value === "B",
  block && block.answers && block.answers.q1 ? String(block.answers.q1.value) : "缺失",
);
check(
  "笔记已落盘",
  block && Array.isArray(block.notes) && block.notes.some((n) => n.text === "自检笔记"),
);
check(
  "评注已落盘且带 quote 锚点",
  block &&
    Array.isArray(block.annotations) &&
    block.annotations.some((a) => a.text === "自检批注" && typeof a.quote === "string"),
);
check(
  "位置标记已落盘且带 y 锚点",
  block && Array.isArray(block.marks) && block.marks.some((m) => typeof m.y === "number"),
);
check(
  "章节阅读进度已落盘",
  block &&
    block.sectionProgress &&
    Object.keys(block.sectionProgress).length === 2 &&
    block.sectionProgress.s1.read === true,
  block && block.sectionProgress ? JSON.stringify(Object.keys(block.sectionProgress)) : "无",
);
check(
  "meta 被插件盖章（updatedAt / updatedBy）",
  block && block.meta && !!block.meta.updatedAt && !!block.meta.updatedBy,
  block && block.meta ? `${block.meta.updatedBy}` : "无",
);

check(
  "★ 除数据区外，文件逐字节未变",
  stripBlock(QUIZ) === pristineQuiz.replace(
    /<script id="html-quiz-progress" type="application\/json">[\s\S]*?<\/script>/,
    "§BLOCK§",
  ),
  "正文 / 注释 / 样式全部原样",
);

// ---------------------------------------------------------------- 2. 状态恢复

uri(`do=probe&file=${encodeURIComponent("html-view-test/auto-quiz.html")}`);
sleep(2500);
const log2 = readLog();
const stateLine = [...log2].reverse().find((l) => l.includes("页面状态上报"));
check(
  "★ 重新打开后页面自动恢复已保存的作答",
  !!stateLine && stateLine.includes('"q1"') && stateLine.includes('"B"'),
  stateLine ? stateLine.slice(0, 90) : "无状态上报",
);

// ---------------------------------------------------------------- 3. 合并不重复

const beforeCount = blockOf(QUIZ).answers ? Object.keys(blockOf(QUIZ).answers).length : 0;
uri(
  `do=selftest&vault=${encodeURIComponent("Obsidian Vault")}&file=${encodeURIComponent(
    "html-view-test/auto-quiz.html",
  )}`,
);
sleep(7000);
const block2 = blockOf(QUIZ);
check(
  "★ 二次保存后作答不重复（按题合并）",
  block2 && Object.keys(block2.answers).length === beforeCount,
  `题目数 ${beforeCount} → ${block2 ? Object.keys(block2.answers).length : "?"}`,
);
check(
  "二次保存后笔记累加（条目按 id 合并，不覆盖）",
  block2 && block2.notes.length === 2,
  block2 ? `notes=${block2.notes.length}` : "?",
);

// ---------------------------------------------------------------- 4. 复习清单

uri(`do=review&file=${encodeURIComponent("html-view-test/auto-quiz.html")}`);
sleep(3000);
let clip = "";
try {
  clip = sh("pbpaste");
} catch {
  clip = "";
}
check(
  "★ 复习清单已复制到剪贴板且含作答与笔记",
  clip.includes("自检笔记") && (clip.includes("我的答案") || clip.includes("正确 1")),
  clip ? `剪贴板 ${clip.length} 字符` : "剪贴板为空",
);

// ---------------------------------------------------------------- 5. 资讯页

uri(
  `do=selftest&vault=${encodeURIComponent("Obsidian Vault")}&file=${encodeURIComponent(
    "html-view-test/auto-news.html",
  )}`,
);
sleep(7000);
const newsBlock = blockOf(NEWS);
check(
  "资讯页同样能写回进度与标注",
  !!newsBlock &&
    Array.isArray(newsBlock.annotations) &&
    newsBlock.annotations.length > 0,
  newsBlock ? `annotations=${newsBlock.annotations.length}` : "无",
);
check(
  "资讯页章节进度已落盘",
  !!newsBlock &&
    newsBlock.sectionProgress &&
    Object.keys(newsBlock.sectionProgress).length === 3,
  newsBlock && newsBlock.sectionProgress
    ? JSON.stringify(Object.keys(newsBlock.sectionProgress))
    : "无",
);

// ---------------------------------------------------------------- 汇总

const failed = results.filter((r) => !r.ok);
console.log();
console.log(`G5 实机验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("未通过：");
  failed.forEach((f) => console.log(`  ✗ ${f.name} ${f.detail}`));
  process.exit(1);
}
console.log("全部通过 ✅");

// 收尾：关掉调试日志，别把用户的插件留在「调试日志开启」状态
uri("do=debug&enable=0");
sleep(300);
