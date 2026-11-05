/**
 * 探针：点答题选项之后，滚动位置为什么归零？
 *
 *   node scripts/probe-scroll-reset.mjs
 *
 * 做法：在 iframe 里种一个标记（window.__MARK__），再采样 scrollY。
 * 标记还在 → 页面没重载；标记没了 → iframe 被重新 srcdoc 过一次。
 */
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VAULT = process.argv[2] || "/Users/mac/Documents/Obsidian Vault";
const PORT = Number(process.env.CDP_PORT || 9333);
const TEST_DIR = join(VAULT, "html-view-test");
const QUIZ = join(TEST_DIR, "auto-quiz.html");
const sleep = (ms) => execSync(`sleep ${(ms / 1000).toFixed(1)}`);
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id != null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP 超时：" + method));
        }
      }, timeoutMs);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function ev(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result ? r.result.value : undefined;
}

function markTestPage(file, id) {
  const text = readFileSync(file, "utf8");
  const tag = `<meta name="hvv-test-id" content="${id}">`;
  if (text.includes(tag)) return;
  writeFileSync(file, text.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`), "utf8");
}

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
const { targetInfos } = await cdp.send("Target.getTargets");
const pageTarget = targetInfos.find((t) => t.type === "page");
const { sessionId: page } = await cdp.send("Target.attachToTarget", {
  targetId: pageTarget.targetId,
  flatten: true,
});

mkdirSync(TEST_DIR, { recursive: true });
copyFileSync(join(ROOT, "templates/template-quiz.html"), QUIZ);
markTestPage(QUIZ, "auto-quiz");

sh(`open "obsidian://html-view?do=probe&file=${encodeURIComponent("html-view-test/auto-quiz.html")}"`);
sleep(7000);

// 按 test-id 认领 iframe target（目标列表要在打开文件之后重新取）
let frame = null;
const end = Date.now() + 20000;
while (Date.now() < end && !frame) {
  const { targetInfos: fresh } = await cdp.send("Target.getTargets");
  for (const t of fresh.filter((x) => x.type === "iframe" && (x.url || "").startsWith("about:srcdoc"))) {
    let sessionId;
    try {
      ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }));
    } catch {
      continue;
    }
    try {
      const id = await ev(
        cdp,
        sessionId,
        `(document.querySelector('meta[name="hvv-test-id"]')||{}).content||null`,
      );
      if (id === "auto-quiz") {
        frame = sessionId;
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!frame) await sleep(600);
}
if (!frame) {
  console.error("没找到 auto-quiz 的 iframe");
  process.exit(1);
}
sleep(1500);

// 种标记
await ev(cdp, frame, "window.__MARK__='alive-'+Date.now();1");
const mark0 = await ev(cdp, frame, "window.__MARK__||null");

// 滚到 600
await ev(cdp, frame, "window.scrollTo({top:600,behavior:'instant'});1");
sleep(600);
console.log("点击前 scrollY =", await ev(cdp, frame, "Math.round(window.scrollY)"));

// 找当前可见的选项
const opt = await ev(
  cdp,
  frame,
  `(()=>{
     const ls=[...document.querySelectorAll('#content label')];
     for(const l of ls){
       const b=l.getBoundingClientRect();
       const cx=b.left+b.width/2, cy=b.top+b.height/2;
       if(cy>24 && cy<innerHeight-24 && cx>0 && cx<innerWidth)
         return {x:cx,y:cy,txt:(l.textContent||'').trim().slice(0,30), checked:!!l.querySelector('input:checked')};
     }
     return null;
   })()`,
);
console.log("落点:", JSON.stringify(opt));

if (!opt) process.exit(1);

// 派发触摸
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: opt.x, y: opt.y, id: 1 }] }, frame);
sleep(80);
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, frame);

// 采样
for (let i = 0; i < 16; i++) {
  await sleep(250);
  const s = await ev(
    cdp,
    frame,
    `JSON.stringify({y:Math.round(window.scrollY), mark:window.__MARK__||null, ans:JSON.stringify(window.__HTML_VIEW__&&window.__HTML_VIEW__.getState?window.__HTML_VIEW__.getState().answers:null)})`,
  );
  console.log(`  t+${(i + 1) * 250}ms`, s);
}
console.log("\n标记（点击前）:", mark0);

cdp.close();
