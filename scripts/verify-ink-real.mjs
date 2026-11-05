/**
 * G6 真机验收：手写标注层（真实 Obsidian 进程内跑，不接受模拟）
 *
 *   node scripts/verify-ink-real.mjs [vault路径]
 *
 * 前置条件：
 *   1. 插件已安装并启用（scripts/install-to-vault.sh）
 *   2. Obsidian 以 `--remote-debugging-port=9333` 启动（脚本会检测并在缺失时提示）
 *
 * 手法：
 *   通过 Chrome DevTools Protocol 向**真实 Obsidian 进程**里的沙箱 iframe
 *   派发 `Input.dispatchMouseEvent({pointerType:"pen"})` 真实笔事件，
 *   再直接校验 vault 里的文件字节。
 *
 *   坐标说明：iframe 是独立目标（OOPIF），其 session 内的坐标就是 iframe 自己的
 *   视口坐标，和页面里 getBoundingClientRect() 的结果同一套。
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
const PORT = Number(process.env.CDP_PORT || 9333);
const TEST_DIR = join(VAULT, "html-view-test");
const PLUGIN_DIR = join(VAULT, ".obsidian/plugins/html-single-file-view");
const LOG_FILE = join(PLUGIN_DIR, "data.json");
const QUIZ = join(TEST_DIR, "auto-quiz.html");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  —  " + detail : ""}`);
}
function sh(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}
function sleep(ms) {
  execSync(`sleep ${(ms / 1000).toFixed(1)}`);
}
function uri(qs) {
  sh(`open "obsidian://html-view?${qs}"`);
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
function readLog() {
  try {
    return JSON.parse(readFileSync(LOG_FILE, "utf8")).log || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- CDP 客户端

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) for (const l of this.listeners) l(msg);
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
  send(method, params = {}, sessionId) {
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
      }, 20000);
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- 页面操作

/** 在 iframe session 里求值 */
async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error("页面求值异常：" + JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  return r.result ? r.result.value : undefined;
}

/** 派发一次真实点击（鼠标） */
async function click(cdp, sessionId, x, y) {
  const base = { x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 }, sessionId);
}

/** 派发一次真实双击 */
async function doubleClick(cdp, sessionId, x, y) {
  const base = { x, y, button: "left", buttons: 1, pointerType: "mouse" };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0, clickCount: 1 }, sessionId);
  await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 2 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0, clickCount: 2 }, sessionId);
}

/** 派发一次真实笔触（pointerType = pen） */
async function penStroke(cdp, sessionId, points) {
  const first = points[0];
  await cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x: first.x,
      y: first.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "pen",
      force: 0.5,
    },
    sessionId,
  );
  for (const p of points.slice(1)) {
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1, pointerType: "pen", force: 0.5 },
      sessionId,
    );
  }
  const last = points[points.length - 1];
  await cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "pen",
      force: 0,
    },
    sessionId,
  );
}

async function waitFor(cdp, sessionId, expr, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await evaluate(cdp, sessionId, expr);
      if (v) return v;
    } catch {
      /* ignore */
    }
    await sleep(400);
  }
  return null;
}

/** 给验收样例页打一个唯一标记，便于在多个 HTML 视图里精确认领本次这一页 */
function markTestPage(file, id) {
  const text = readFileSync(file, "utf8");
  const tag = `<meta name="hvv-test-id" content="${id}">`;
  if (text.includes(tag)) return;
  const patched = text.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
  writeFileSync(file, patched, "utf8");
}

/**
 * 找到 HTML 视图的沙箱 iframe 并挂上 session。
 *
 * 工作区里可能同时开着多个 HTML 视图（用户自己的样例页 + 本次验收页），
 * 不能只取「第一个 about:srcdoc」——那可能抓到别人的页面。
 * 这里按页面特征挑：quiz 模板里有 [data-qid] 题目块，news 模板没有。
 */
async function attachIframe(cdp, timeout = 20000, kind = "quiz") {
  const probe = `!!(document.querySelector('meta[name="hvv-test-id"]') &&
      window.__HTML_VIEW__ &&
      document.querySelector('#content ${kind === "quiz" ? "[data-qid]" : "[data-sid]"}'))`;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const candidates = targetInfos.filter(
      (t) => t.type === "iframe" && (t.url || "").startsWith("about:srcdoc"),
    );
    for (const iframe of candidates) {
      let sessionId;
      try {
        ({ sessionId } = await cdp.send("Target.attachToTarget", {
          targetId: iframe.targetId,
          flatten: true,
        }));
      } catch {
        continue;
      }
      try {
        const hit = await evaluate(cdp, sessionId, probe);
        if (hit) return sessionId;
      } catch {
        /* 不是我们要的页面，换下一个 */
      }
    }
    await sleep(500);
  }
  return null;
}

// ---------------------------------------------------------------- 0. 前置

if (!existsSync(join(PLUGIN_DIR, "main.js"))) {
  console.error("✗ 插件未安装，请先执行 scripts/install-to-vault.sh");
  process.exit(1);
}
let version;
try {
  version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
} catch {
  console.error(
    `✗ 连不上 CDP 端口 ${PORT}。请用 --remote-debugging-port=${PORT} 启动 Obsidian 后重试。`,
  );
  process.exit(1);
}
check("CDP 已连上真实 Obsidian 进程", true, version.Browser);

mkdirSync(TEST_DIR, { recursive: true });
copyFileSync(join(ROOT, "templates/template-quiz.html"), QUIZ);
// 给验收页打唯一标记：工作区里可能同时开着用户自己的样例页，
// 靠标记精确挑出「本次验收这一份」，别抓到别人的页面
markTestPage(QUIZ, "auto-quiz");
const pristineQuiz = readFileSync(QUIZ, "utf8");

uri("do=debug&enable=1");
sleep(1200);

const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
const { targetId: pageTargetId } = await cdp.send("Target.getTargets").then((r) => ({
  targetId: r.targetInfos.find((t) => t.type === "page")?.targetId,
}));
const { sessionId: pageSession } = await cdp.send("Target.attachToTarget", {
  targetId: pageTargetId,
  flatten: true,
});
check("已挂上 Obsidian 主页面 session", !!pageSession, pageSession);

// 打开样例页。用 do=probe 会强制重读磁盘并重建 iframe，确保页面是刚铺好的干净模板
uri(`do=probe&vault=${encodeURIComponent("Obsidian Vault")}&file=${encodeURIComponent("html-view-test/auto-quiz.html")}`);
sleep(6000);
const frame = await attachIframe(cdp);
check("★ 已挂上 HTML 视图的沙箱 iframe session（真实页面）", !!frame, frame || "未找到");
if (!frame) {
  cdp.close();
  process.exit(1);
}

const ready = await waitFor(
  cdp,
  frame,
  "!!(window.__HTML_VIEW__ && window.__HTML_VIEW__.ink) && !!document.querySelector('.hvv-ink-fab')",
);
check("页面运行时已就绪（手写层 API 存在）", !!ready);

// ---------------------------------------------------------------- 1. 进入画笔模式

const baseBlock = blockOf(QUIZ);
const baseAlive = (
  baseBlock && Array.isArray(baseBlock.strokes) ? baseBlock.strokes : []
).filter((x) => !x.deleted).length;

const fabRect = await evaluate(
  cdp,
  frame,
  "(()=>{const r=document.querySelector('.hvv-ink-fab').getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;const hit=document.elementFromPoint(cx,cy);return {x:cx,y:cy,hit:hit?hit.tagName+'.'+(hit.className&&hit.className.baseVal!==undefined?hit.className.baseVal:hit.className):'null',inner:{w:innerWidth,h:innerHeight},scrollY:window.scrollY}})()",
);
console.log("  · FAB 落点：", JSON.stringify(fabRect));
await click(cdp, frame, fabRect.x, fabRect.y);
await sleep(700);
const inkState1 = await evaluate(cdp, frame, "window.__HTML_VIEW__.ink.getState()");
const inkClass1 = await evaluate(cdp, frame, "document.body.className");
console.log("  · 点击后 body 类名：", inkClass1);
check(
  "★ 真实点击右下角 ✏️ 进入画笔模式",
  inkState1 && inkState1.active === true,
  JSON.stringify(inkState1),
);

// ---------------------------------------------------------------- 2. 笔事件绘制

const target = await evaluate(
  cdp,
  frame,
  "(()=>{const p=document.querySelector('#content p.q-title');p.scrollIntoView({block:'center'});const r=p.getBoundingClientRect();return {x:r.left+30,y:r.top+20,w:r.width,h:r.height,txt:p.textContent.slice(0,20)}})()",
);
await sleep(500);
const targetPos = await evaluate(
  cdp,
  frame,
  "(()=>{const p=document.querySelector('#content p.q-title');const r=p.getBoundingClientRect();return {x:r.left+30,y:r.top+20}})()",
);
check("已定位到正文段落（笔事件落点）", !!targetPos, target ? target.txt : "");

const pts = [];
for (let i = 0; i < 12; i++) {
  pts.push({ x: targetPos.x + i * 6, y: targetPos.y + Math.sin(i / 2) * 6 });
}
await penStroke(cdp, frame, pts);
await sleep(500);

const afterPen = await evaluate(cdp, frame, "window.__HTML_VIEW__.ink.getState()");
check(
  "★ 真实笔事件（pointerType=pen）画出 1 笔",
  afterPen && afterPen.draft === 1,
  JSON.stringify(afterPen),
);
check(
  "★ 页面已识别为笔设备（penSeen=true）",
  afterPen && afterPen.penSeen === true,
  afterPen ? String(afterPen.penSeen) : "",
);
const draftPaths = await evaluate(
  cdp,
  frame,
  "document.querySelectorAll('svg.hvv-ink path.hvv-draft').length",
);
check("画布上确实渲染出笔迹节点", draftPaths === 1, `draft path = ${draftPaths}`);

// ---------------------------------------------------------------- 3. 笔/手指分派

// 识别到笔之后，手指应当只滚动、不画
const beforeTouch = afterPen.draft;
await cdp.send(
  "Input.dispatchTouchEvent",
  { type: "touchStart", touchPoints: [{ x: targetPos.x, y: targetPos.y + 60, id: 1 }] },
  frame,
);
await cdp.send(
  "Input.dispatchTouchEvent",
  { type: "touchMove", touchPoints: [{ x: targetPos.x, y: targetPos.y + 20, id: 1 }] },
  frame,
);
await cdp.send(
  "Input.dispatchTouchEvent",
  { type: "touchEnd", touchPoints: [] },
  frame,
);
await sleep(400);
const afterTouch = await evaluate(cdp, frame, "window.__HTML_VIEW__.ink.getState()");
check(
  "★ 笔模式下手指不落笔（只滚动）",
  afterTouch && afterTouch.draft === beforeTouch,
  `draft ${beforeTouch} → ${afterTouch ? afterTouch.draft : "?"}`,
);

// ---------------------------------------------------------------- 4. 保存涂鸦

const saveRect = await evaluate(
  cdp,
  frame,
  "(()=>{const b=document.querySelector('[data-hvv-ink=\"save\"]');const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()",
);
await click(cdp, frame, saveRect.x, saveRect.y);
await sleep(2500);

const block = blockOf(QUIZ);
const alive = (b) =>
  (b && Array.isArray(b.strokes) ? b.strokes : []).filter((s) => !s.deleted);
check(
  "★ 涂鸦已写回 HTML 文件的进度区",
  !!block && Array.isArray(block.strokes) && alive(block).length === baseAlive + 1,
  `已存笔迹 ${baseAlive} → ${alive(block).length}`,
);
const st = alive(block)[alive(block).length - 1];
check(
  "★ 笔迹条目含路径 / 颜色 / 粗细 / 锚点",
  !!st &&
    typeof st.d === "string" &&
    st.d.startsWith("M") &&
    st.color === "ink" &&
    st.width === 4 &&
    !!st.anchor &&
    typeof st.anchor.text === "string",
  st ? JSON.stringify(st).slice(0, 160) : "无",
);
check(
  "★ 锚点指向被涂画的那一段",
  !!st && st.anchor.text.startsWith("Q1."),
  st && st.anchor ? st.anchor.text.slice(0, 24) : "无",
);
check(
  "★ 除数据区外，文件逐字节未变",
  stripBlock(QUIZ) ===
    pristineQuiz.replace(
      /<script id="html-quiz-progress" type="application\/json">[\s\S]*?<\/script>/,
      "§BLOCK§",
    ),
  "正文 / 注释 / 样式全部原样",
);

// ---------------------------------------------------------------- 5. 重新打开后恢复

uri(`do=probe&file=${encodeURIComponent("html-view-test/auto-quiz.html")}`);
sleep(6000);
const frame2 = await attachIframe(cdp);
check("重新打开后已重新挂上 iframe session", !!frame2, frame2 || "未找到");
if (frame2) {
  const ok = await waitFor(
    cdp,
    frame2,
    "!!window.__HTML_VIEW__ && !!window.__HTML_VIEW__.ink",
  );
  check("页面重新就绪", !!ok);
  const restored = await evaluate(
    cdp,
    frame2,
    "(()=>{const s=window.__HTML_VIEW__.ink.getState();return {saved:s.saved,draft:s.draft,paths:document.querySelectorAll('svg.hvv-ink path.hvv-saved').length}})()",
  );
  check(
    "★ 重新打开后笔迹自动恢复并重绘",
    restored && restored.saved === baseAlive + 1 && restored.paths === baseAlive + 1,
    `已存 ${restored ? restored.saved : "?"} / 重绘 ${restored ? restored.paths : "?"}（基线 ${baseAlive}）`,
  );
}

// ---------------------------------------------------------------- 6. 正文双击放大

const frameUse = frame2 || frame;
// 重载后是全新页面，需重新进入画笔模式（工具条默认隐藏）
await evaluate(
  cdp,
  frameUse,
  "(()=>{const r=document.querySelector('.hvv-ink-fab').getBoundingClientRect();window.__fab={x:r.left+r.width/2,y:r.top+r.height/2};return 1})()",
);
const fab2 = await evaluate(cdp, frameUse, "window.__fab");
await click(cdp, frameUse, fab2.x, fab2.y);
await sleep(700);
const inkAgain = await evaluate(cdp, frameUse, "window.__HTML_VIEW__.ink.getState()");
check(
  "重新打开后重新进入画笔模式",
  inkAgain && inkAgain.active === true,
  JSON.stringify(inkAgain),
);

await evaluate(
  cdp,
  frameUse,
  "(()=>{const p=document.querySelectorAll('#content p.q-title')[1];p.scrollIntoView({block:'center'});return 1})()",
);
await sleep(500);
const bodyPoint = await evaluate(
  cdp,
  frameUse,
  "(()=>{const p=document.querySelectorAll('#content p.q-title')[1];const r=p.getBoundingClientRect();return {x:r.left+40,y:r.top+15}})()",
);
await doubleClick(cdp, frameUse, bodyPoint.x, bodyPoint.y);
await sleep(700);
const zoomed = await evaluate(
  cdp,
  frameUse,
  "(()=>{const s=window.__HTML_VIEW__.ink.getState();const t=document.querySelector('#content').style.transform||'';return {zoom:s.zoom,transform:t}})()",
);
check(
  "★ 正文双击 → 2x 放大",
  zoomed && zoomed.zoom === 2 && /scale\(2\)/.test(zoomed.transform || ""),
  JSON.stringify(zoomed),
);
await doubleClick(cdp, frameUse, bodyPoint.x, bodyPoint.y);
await sleep(700);
const zoomBack = await evaluate(
  cdp,
  frameUse,
  "(()=>{const s=window.__HTML_VIEW__.ink.getState();const t=document.querySelector('#content').style.transform||'';return {zoom:s.zoom,transform:t}})()",
);
check(
  "★ 再双击 → 立即回到 1x",
  zoomBack && zoomBack.zoom === 1,
  JSON.stringify(zoomBack),
);

// ---------------------------------------------------------------- 7. 清屏语义

const clearRect = await evaluate(
  cdp,
  frameUse,
  "(()=>{const b=document.querySelector('[data-hvv-ink=\"clear\"]');const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()",
);
// 先画一笔临时草稿
const pt2 = { x: targetPos.x, y: targetPos.y + 40 };
const pts2 = [];
for (let i = 0; i < 10; i++) pts2.push({ x: pt2.x + i * 5, y: pt2.y + i * 2 });
await penStroke(cdp, frameUse, pts2);
await sleep(400);
const beforeClear = await evaluate(cdp, frameUse, "window.__HTML_VIEW__.ink.getState()");
check("已画出第 2 笔临时草稿", beforeClear && beforeClear.draft === 1, JSON.stringify(beforeClear));

await click(cdp, frameUse, clearRect.x, clearRect.y);
await sleep(600);
const afterClear = await evaluate(cdp, frameUse, "window.__HTML_VIEW__.ink.getState()");
check(
  "★ 单击清屏只清临时草稿，已保存笔迹保留",
  afterClear && afterClear.draft === 0 && afterClear.saved === baseAlive + 1,
  JSON.stringify(afterClear),
);

// ---------------------------------------------------------------- 8. 双击清全部 → 墓碑

await doubleClick(cdp, frameUse, clearRect.x, clearRect.y);
await sleep(700);
const dlgShown = await evaluate(
  cdp,
  frameUse,
  "!!(document.querySelector('.hvv-dialog') && document.querySelector('.hvv-dialog').classList.contains('is-on'))",
);
check("双击清屏弹出确认框", dlgShown === true);
if (dlgShown) {
  const okRect = await evaluate(
    cdp,
    frameUse,
    "(()=>{const bs=[...document.querySelectorAll('.hvv-dialog button')];const b=bs.find(x=>x.textContent==='确认清空');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()",
  );
  if (okRect) {
    await click(cdp, frameUse, okRect.x, okRect.y);
    await sleep(2500);
  }
}
const blockAfter = blockOf(QUIZ);
check(
  "★ 双击清全部 → 已保存笔迹写墓碑（跨设备同步删除）",
  blockAfter &&
    Array.isArray(blockAfter.strokes) &&
    blockAfter.strokes.length > 0 &&
    blockAfter.strokes.every((s) => s.deleted === true),
  blockAfter && blockAfter.strokes
    ? `共 ${blockAfter.strokes.length} 条，全部为墓碑`
    : "无",
);
const gone = await evaluate(
  cdp,
  frameUse,
  "window.__HTML_VIEW__.ink.getState().saved",
);
check("画面上笔迹已全部清空", gone === 0, `saved=${gone}`);

// ---------------------------------------------------------------- 9. 插件侧日志

const log = readLog();
check(
  "插件收到手写层状态上报",
  log.some((l) => l.includes("手写层状态")),
  `${log.length} 条日志`,
);

// ---------------------------------------------------------------- 汇总

cdp.close();
const failed = results.filter((r) => !r.ok);
console.log();
console.log(`G6 手写层实机验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("未通过：");
  failed.forEach((f) => console.log(`  ✗ ${f.name} ${f.detail}`));
  process.exit(1);
}
console.log("全部通过 ✅");

// 收尾：关掉调试日志，别把用户的插件留在「调试日志开启」状态
uri("do=debug&enable=0");
sleep(300);
