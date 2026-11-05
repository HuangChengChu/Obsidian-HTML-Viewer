/**
 * 验证：打开 / 标注 / 关闭一个 HTML 文件，各触发多少次「整文件写盘」。
 *
 *   node scripts/probe-write-amplification.mjs
 *
 * 这是同步流量核查的关键论据：
 * 「打开文件看一眼就关」到底传不传数据、传几次。
 *
 * 做法：
 *   1. 复制模板 HTML 成 auto-sync-check.html，记录 mtime 与内容指纹
 *   2. 开插件调试日志（每次写盘会打一条「写回成功」）
 *   3. 分阶段动作，每阶段统计「写回成功」的增量
 */
import { execSync } from "node:child_process";
import { copyFileSync, statSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VAULT = process.argv[2] || "/Users/mac/Documents/Obsidian Vault";
const TEST_DIR = join(VAULT, "html-view-test");
const FILE = join(TEST_DIR, "auto-sync-check.html");
const PLUGIN_DIR = join(VAULT, ".obsidian/plugins/html-single-file-view");
const PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (ms) => execSync(`sleep ${(ms / 1000).toFixed(1)}`);
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);
const logLines = () => {
  try {
    const d = JSON.parse(readFileSync(join(PLUGIN_DIR, "data.json"), "utf8"));
    return (d.log || []).map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  } catch {
    return [];
  }
};
const writeCount = () => logLines().filter((l) => l.includes("写回成功")).length;

mkdirSync(TEST_DIR, { recursive: true });
copyFileSync(join(ROOT, "templates/template-quiz.html"), FILE);
const size = statSync(FILE).size;
console.log(`样例文件 ${size} 字节（${(size / 1024).toFixed(1)} KB）`);

// ---- CDP 小工具
let ws;
let seq = 0;
const pending = new Map();
async function cdpConnect() {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  });
}
function send(method, params = {}, sessionId, timeoutMs = 15000) {
  const id = ++seq;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(payload));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("超时 " + method));
      }
    }, timeoutMs);
  });
}
async function ev(sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result ? r.result.value : undefined;
}
async function attachPage() {
  const { targetInfos } = await send("Target.getTargets");
  const pt = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId: pt.targetId, flatten: true });
  return sessionId;
}
async function attachFrame(testId) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const { targetInfos } = await send("Target.getTargets");
    for (const t of targetInfos.filter((x) => x.type === "iframe" && (x.url || "").startsWith("about:srcdoc"))) {
      let sessionId;
      try {
        ({ sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true }));
      } catch {
        continue;
      }
      try {
        const id = await ev(sessionId, `(document.querySelector('meta[name="hvv-test-id"]')||{}).content||null`);
        if (id === testId) return sessionId;
      } catch {
        /* next */
      }
    }
    await sleep(600);
  }
  return null;
}

await cdpConnect();
const page = await attachPage();

// 给样例页打个标记，便于认领 iframe
{
  const txt = readFileSync(FILE, "utf8");
  const tag = `<meta name="hvv-test-id" content="auto-sync-check">`;
  if (!txt.includes(tag)) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(FILE, txt.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`), "utf8");
  }
}

sh(`open "obsidian://html-view?do=debug&enable=1"`);
sleep(1000);
const base = writeCount();

const mtime0 = statSync(FILE).mtimeMs;
const sha0 = sha(FILE);

// ---------- 阶段 1：打开
sh(`open "obsidian://html-view?do=probe&file=${encodeURIComponent("html-view-test/auto-sync-check.html")}"`);
await sleep(7000);
const frame = await attachFrame("auto-sync-check");
if (!frame) {
  console.error("没找到 iframe");
  process.exit(1);
}
const w1 = writeCount();
console.log(
  `\n【打开】写盘 ${w1 - base} 次；文件是否被改写=${sha(FILE) !== sha0}；mtime 变化=${statSync(FILE).mtimeMs !== mtime0}`,
);

// ---------- 阶段 2：作答一次（change 事件 → scheduleSave → 500ms 防抖后写盘）
await ev(
  frame,
  `(()=>{const i=document.querySelector('#content input[type=radio]');
    if(!i) return 'no-radio';
    i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true})); return 'ok';})()`,
);
await sleep(2500);
const w2 = writeCount();
console.log(`【作答 1 次】写盘 ${w2 - w1} 次；文件已改写=${sha(FILE) !== sha0}`);

// ---------- 阶段 3：连打 5 次（看 500ms 防抖是否合并成 1 次写盘）
for (let i = 0; i < 5; i++) {
  await ev(
    frame,
    `(()=>{const is=[...document.querySelectorAll('#content input[type=radio]')];
      const i=is[${i} % is.length]; if(!i) return 0;
      i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`,
  );
}
await sleep(2500);
const w3 = writeCount();
console.log(`【再连打 5 次作答】写盘 ${w3 - w2} 次（500ms 防抖合并后应该 ≈1，而不是 5）`);

// ---------- 阶段 4：滚动阅读（只看不改）会不会写盘
let wAfter = w3;
{
  const wBefore = writeCount();
  // 逐屏往下滚，模拟读一篇长文
  const maxScroll = await ev(
    frame,
    "Math.round(document.documentElement.scrollHeight - innerHeight)",
  );
  for (let y = 0; y <= maxScroll; y += 300) {
    await ev(frame, `window.scrollTo({top:${y},behavior:'instant'});1`);
    await sleep(320);
  }
  await sleep(2000);
  const wAfterNow = writeCount();
  wAfter = wAfterNow;
  console.log(
    `【滚动阅读 ${maxScroll}px，只看不改】写盘 ${wAfterNow - wBefore} 次（章节进度变化会触发保存）`,
  );
}

// ---------- 阶段 5：关掉标签页
await ev(
  page,
  `(()=>{const app=window.app;if(!app||!app.workspace)return 'no-app';let n=0;
    for(const leaf of app.workspace.getLeavesOfType('html-single-file-view')){
      const st=leaf.view&&leaf.view.getState&&leaf.view.getState();
      const p=st&&typeof st.path==='string'?st.path:'';
      if(p.indexOf('auto-sync-check.html')>=0){leaf.detach();n++;}
    }return n;})()`,
);
await sleep(3000);
const w4 = writeCount();
console.log(`【关闭标签页】写盘 ${w4 - wAfter} 次`);

console.log(`\n合计写盘 ${w4 - base} 次；样例文件 ${size} 字节`);
console.log(
  `放大倍数：每次写盘都传整个文件 → ${((w4 - base) * size) / 1024} KB（按 ${(size / 1024).toFixed(1)} KB/次 估算）`,
);
console.log("\n日志明细:");
for (const l of logLines().filter((x) => x.includes("写回"))) console.log("  ", l.slice(0, 140));

sh(`open "obsidian://html-view?do=debug&enable=0"`);
sleep(600);
ws.close();
