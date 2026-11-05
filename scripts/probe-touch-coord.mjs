/**
 * 探针：确认 CDP 触摸事件与鼠标事件在「沙箱 iframe」里的坐标系差异。
 *
 *   node scripts/probe-touch-coord.mjs
 *
 * 关键难点：工作区里同时存在多个 HTML 视图（可见的 + 隐藏标签页里的），
 * 每个都是一个独立 CDP target。必须把「主窗口里可见的那个 DOM iframe」
 * 和「正确的 CDP target」对上，否则事件派发会打到隐藏页面上。
 *
 * 对齐办法：DOM iframe 的 srcdoc 属性里带着本页的 hvv-test-id 标记，
 * 用它把 DOM 元素和 CDP target 一一对应。
 */
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (ms) => execSync(`sleep ${(ms / 1000).toFixed(1)}`);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
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

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

const { targetInfos } = await cdp.send("Target.getTargets");
const pageTarget = targetInfos.find((t) => t.type === "page");
const { sessionId: page } = await cdp.send("Target.attachToTarget", {
  targetId: pageTarget.targetId,
  flatten: true,
});

// 1) 主窗口里所有 iframe：谁可见、srcdoc 里的 test-id 是什么
const domFrames = await ev(
  cdp,
  page,
  `(()=>{
     return [...document.querySelectorAll('iframe.html-view-frame')].map((f,i)=>{
       const b=f.getBoundingClientRect();
       const m=(f.getAttribute('srcdoc')||'').match(/hvv-test-id"\\s+content="([^"]*)"/);
       return {i, testId:m?m[1]:null, left:b.left, top:b.top, w:b.width, h:b.height,
               vis:b.width>0&&b.height>0};
     });
   })()`,
);
console.log("主窗口里的 DOM iframe：");
for (const r of domFrames || []) console.log("  ", JSON.stringify(r));

const visible = (domFrames || []).filter((f) => f.vis);
if (visible.length !== 1) {
  console.error(`期望恰好 1 个可见 iframe，实际 ${visible.length} 个`);
  process.exit(1);
}
const wantId = visible[0].testId;
console.log(`\n可见 iframe 的 test-id = ${wantId}`);

// 2) 找出 test-id 相同的 CDP target
const candidates = [];
for (const t of targetInfos.filter((x) => x.type === "iframe" && (x.url || "").startsWith("about:srcdoc"))) {
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
    if (id === wantId) candidates.push(sessionId);
  } catch {
    /* next */
  }
}
console.log(`test-id 匹配的 target 数：${candidates.length}`);

// 3) 逐个试派发，先找出「活的那个」
let frame = null;
for (const s of candidates) {
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 5, y: 5, id: 1 }] }, s, 3000);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s, 3000);
    console.log("  → 这个 target 能接触摸，是活的");
    frame = s;
    break;
  } catch (e) {
    console.log("  → 这个 target 接不了触摸（隐藏）：", e.message);
  }
}
if (!frame) {
  console.error("没有活着的 target");
  process.exit(1);
}

// 4) 装监听
await ev(
  cdp,
  frame,
  `(()=>{
     window.__probe=[];
     if(window.__probeInstalled) return 1;
     window.__probeInstalled=1;
     const rec=(e)=>{
       const t=(e.touches&&e.touches[0])||(e.changedTouches&&e.changedTouches[0]);
       window.__probe.push({type:e.type,
         cx: t ? t.clientX : (typeof e.clientX==='number'?e.clientX:null),
         cy: t ? t.clientY : (typeof e.clientY==='number'?e.clientY:null)});
     };
     for(const n of ['touchstart','touchend','mousedown','mouseup']) document.addEventListener(n,rec,true);
     return 1;
   })()`,
);

const TX = 120;
const TY = 160;
const L = visible[0].left;
const T = visible[0].top;

async function sendTouch(x, y) {
  await ev(cdp, frame, "window.__probe=[];1");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] }, frame);
  await sleep(120);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, frame);
  await sleep(400);
  return await ev(cdp, frame, "JSON.stringify(window.__probe)");
}

async function sendMouse(x, y) {
  await ev(cdp, frame, "window.__probe=[];1");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, frame);
  await sleep(120);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, frame);
  await sleep(400);
  return await ev(cdp, frame, "JSON.stringify(window.__probe)");
}

console.log(`\niframe 偏移 left=${L} top=${T}\n`);

console.log(`--- 触摸：原样发 (${TX},${TY}) ---`);
console.log(await sendTouch(TX, TY));
console.log(`--- 触摸：发 (${TX + L},${TY + T}) 加偏移 ---`);
console.log(await sendTouch(TX + L, TY + T));
console.log(`--- 鼠标：原样发 (${TX},${TY}) ---`);
console.log(await sendMouse(TX, TY));
console.log(`--- 鼠标：发 (${TX + L},${TY + T}) 加偏移 ---`);
console.log(await sendMouse(TX + L, TY + T));

cdp.close();
