/**
 * G7 真机验收：UI 改版（翻页键 / 顶底栏合并 / 折叠菜单）
 *
 *   node scripts/verify-ui-real.mjs [vault路径]
 *
 * 前置：Obsidian 以 --remote-debugging-port=9333 启动。
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VAULT = process.argv[2] || "/Users/mac/Documents/Obsidian Vault";
const PORT = Number(process.env.CDP_PORT || 9333);
const TEST_DIR = join(VAULT, "html-view-test");
const QUIZ = join(TEST_DIR, "auto-quiz.html");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  —  " + detail : ""}`);
}
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const sleep = (ms) => execSync(`sleep ${(ms / 1000).toFixed(1)}`);
const uri = (qs) => sh(`open "obsidian://html-view?${qs}"`);

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
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function ev(cdp, sessionId, expression) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result ? r.result.value : undefined;
}

async function click(cdp, sessionId, x, y) {
  const b = { x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" };
  await cdp.send("Input.dispatchMouseEvent", { ...b, type: "mousePressed" }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...b, type: "mouseReleased", buttons: 0 }, sessionId);
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
 * 这里按页面特征挑：quiz 模板里有 [data-qid] 题目块。
 */
async function attachIframe(cdp, timeout = 20000) {
  const probe = `!!(document.querySelector('meta[name="hvv-test-id"]') &&
      window.__HTML_VIEW__ && document.querySelector('#content [data-qid]'))`;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const candidates = targetInfos.filter(
      (t) => t.type === "iframe" && (t.url || "").startsWith("about:srcdoc"),
    );
    for (const f of candidates) {
      let sessionId;
      try {
        ({ sessionId } = await cdp.send("Target.attachToTarget", {
          targetId: f.targetId,
          flatten: true,
        }));
      } catch {
        continue;
      }
      try {
        const hit = await ev(cdp, sessionId, probe);
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

if (!existsSync(join(VAULT, ".obsidian/plugins/html-single-file-view", "main.js"))) {
  console.error("✗ 插件未安装");
  process.exit(1);
}
let version;
try {
  version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
} catch {
  console.error(`✗ 连不上 CDP ${PORT}，请用 --remote-debugging-port=${PORT} 启动 Obsidian`);
  process.exit(1);
}
check("CDP 已连上真实 Obsidian 进程", true, version.Browser);

mkdirSync(TEST_DIR, { recursive: true });
copyFileSync(join(ROOT, "templates/template-quiz.html"), QUIZ);
// 打唯一标记：工作区里可能同时开着用户自己的样例页，别抓到别人的页面
markTestPage(QUIZ, "auto-quiz");

const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
const { targetInfos } = await cdp.send("Target.getTargets");
const pageTarget = targetInfos.find((t) => t.type === "page");
const { sessionId: page } = await cdp.send("Target.attachToTarget", {
  targetId: pageTarget.targetId,
  flatten: true,
});
check("已挂上 Obsidian 主页面 session", !!page, page);

uri(`do=probe&file=${encodeURIComponent("html-view-test/auto-quiz.html")}`);
sleep(6000);
const frame = await attachIframe(cdp);
check("★ 已挂上 HTML 视图的沙箱 iframe session", !!frame, frame || "未找到");
if (!frame) {
  cdp.close();
  process.exit(1);
}
await sleep(1500);

// ---------------------------------------------------------------- 1. 翻页键形态

const pagerInfo = await ev(
  cdp,
  frame,
  `(()=>{
    const p=document.querySelector('.hvv-pager');
    if(!p) return null;
    const up=p.querySelector('[data-hvv-dir="-1"]');
    const down=p.querySelector('[data-hvv-dir="1"]');
    const r=(e)=>{const b=e.getBoundingClientRect();return {cx:b.left+b.width/2,cy:b.top+b.height/2}};
    return {
      up: up.textContent, down: down.textContent,
      top: p.style.top, right: p.style.right, transform: p.style.transform,
      gap: parseFloat(getComputedStyle(p).gap),
      flexDir: getComputedStyle(p).flexDirection,
      opacity: getComputedStyle(p).opacity,
      upPos: r(up), downPos: r(down),
      fab: (()=>{const f=document.querySelector('.hvv-ink-fab');if(!f)return null;const b=f.getBoundingClientRect();return {cx:b.left+b.width/2,cy:b.top+b.height/2}})(),
      vw: innerWidth, vh: innerHeight,
    };
  })()`,
);
check("★ 翻页键是上下箭头", pagerInfo && pagerInfo.up === "▲" && pagerInfo.down === "▼", JSON.stringify(pagerInfo && { up: pagerInfo.up, down: pagerInfo.down }));
check(
  "★ 翻页键垂直居中靠右",
  pagerInfo && pagerInfo.top === "50%" && pagerInfo.transform === "translateY(-50%)",
  pagerInfo ? `top=${pagerInfo.top} transform=${pagerInfo.transform}` : "",
);
check(
  "★ 两个箭头之间留拇指间隔（44px）",
  pagerInfo && pagerInfo.gap === 44,
  pagerInfo ? `gap=${pagerInfo.gap}px` : "",
);
check(
  "原始要求保留：透明度 40%",
  pagerInfo && pagerInfo.opacity === "0.4",
  pagerInfo ? `opacity=${pagerInfo.opacity}` : "",
);
check(
  "★ 翻页键不再与右下角手写按钮抢位置（垂直错开）",
  pagerInfo &&
    pagerInfo.fab &&
    Math.abs(pagerInfo.upPos.cy - pagerInfo.fab.cy) > 120,
  pagerInfo && pagerInfo.fab
    ? `上箭头 y=${Math.round(pagerInfo.upPos.cy)}，手写按钮 y=${Math.round(pagerInfo.fab.cy)}`
    : "",
);

// ---------------------------------------------------------------- 2. 点击真的翻页

await ev(cdp, frame, "window.scrollTo(0,600);1");
await sleep(600);
let before = await ev(cdp, frame, "Math.round(window.scrollY)");
await click(cdp, frame, pagerInfo.upPos.cx, pagerInfo.upPos.cy);
await sleep(1400);
let after = await ev(cdp, frame, "Math.round(window.scrollY)");
check(
  "★ 点击向上箭头 → 真的向上翻页（这是修好的那个 bug）",
  after < before,
  `scrollY ${before} → ${after}`,
);

before = await ev(cdp, frame, "Math.round(window.scrollY)");
await click(cdp, frame, pagerInfo.downPos.cx, pagerInfo.downPos.cy);
await sleep(1400);
after = await ev(cdp, frame, "Math.round(window.scrollY)");
check("★ 点击向下箭头 → 真的向下翻页", after > before, `scrollY ${before} → ${after}`);

// ---------------------------------------------------------------- 3. 触屏分区翻页

await ev(cdp, frame, "window.scrollTo(0,600);1");
await sleep(600);

// ---------------------------------------------------------------- 触屏坐标系校准
//
// CDP 的触摸事件用哪种坐标系，取决于沙箱 iframe 是不是被拆到独立进程：
//   · 独立进程 → 触摸走浏览器进程 → 坐标是「顶层窗口坐标」，要加 iframe 在主窗口里的偏移
//   · 同进程   → 坐标就是「iframe 内部坐标」，原样发才对
// 这个行为在同一台机器上会变（iframe 重建 / 进程重新分配），
// 写死偏移就会隔一阵子飘一次。所以这里现场实测一次，用差值修正后续所有触摸派发。
//
// 校准原理：发一个探针点 S，页面回传它实际收到的 clientX/clientY，
// 则「要发什么坐标」= 目标局部坐标 + (S - 收到值)。
let touchDelta = { x: 0, y: 0 };
{
  await ev(
    cdp,
    frame,
    `(()=>{
       window.__hvvtouch=[];
       if(window.__hvvtouchInstalled) return 1;
       window.__hvvtouchInstalled=1;
       document.addEventListener('touchstart', function(e){
         var t=e.touches&&e.touches[0];
         if(t) window.__hvvtouch.push({x:t.clientX,y:t.clientY});
       }, true);
       return 1;
     })()`,
  );

  // iframe 在主窗口里的位置（窗口坐标系）
  const rect = await ev(
    cdp,
    page,
    `(()=>{
       const f=[...document.querySelectorAll('iframe.html-view-frame')]
         .filter(x=>x.getBoundingClientRect().width>0)[0];
       if(!f) return null;
       const b=f.getBoundingClientRect();
       return {L:b.left,T:b.top,w:b.width,h:b.height};
     })()`,
  );

  // 候选探针点：两种坐标系解释下都要落在 iframe 范围内
  const cands = [];
  if (rect) {
    const { L, T, w, h } = rect;
    const raw = [
      [L + 40, T + 40],
      [L + w - 40, T + 40],
      [L + 40, T + h - 40],
      [w / 2, h / 2],
      [w * 0.7, h * 0.3],
      [w * 0.3, h * 0.7],
    ];
    for (const [x, y] of raw) {
      const inLocal = x >= 0 && y >= 0 && x < w && y < h;
      const inWin = x >= L && y >= T && x < L + w && y < T + h;
      if (!inLocal && !inWin) continue;
      cands.push({ x: Math.round(x), y: Math.round(y) });
    }
  }
  if (!cands.length) cands.push({ x: 200, y: 200 });

  let probed = null;
  for (const c of cands) {
    await ev(cdp, frame, "window.__hvvtouch=[];1");
    await cdp.send(
      "Input.dispatchTouchEvent",
      { type: "touchStart", touchPoints: [{ x: c.x, y: c.y, id: 7 }] },
      frame,
    );
    await sleep(150);
    const got = await ev(cdp, frame, "window.__hvvtouch[0]||null");
    // 收尾这个探针触点：位置偏移超过 10px，runtime 会当成「滑动」而不翻页
    await cdp.send(
      "Input.dispatchTouchEvent",
      { type: "touchEnd", touchPoints: [{ x: c.x + 240, y: c.y + 240, id: 7 }] },
      frame,
    );
    await sleep(200);
    if (got && typeof got.x === "number") {
      probed = { sent: c, got };
      break;
    }
  }

  if (probed) {
    touchDelta = {
      x: probed.sent.x - probed.got.x,
      y: probed.sent.y - probed.got.y,
    };
  }
  const mode =
    Math.abs(touchDelta.x) < 2 && Math.abs(touchDelta.y) < 2
      ? "iframe 内部坐标（原样发）"
      : `顶层窗口坐标（需加偏移 ${touchDelta.x},${touchDelta.y}）`;
  console.log(`  [触摸坐标系] ${mode}`);
  if (!probed) console.log("  [触摸坐标系] ⚠ 探针没收到事件，沿用默认偏移 0,0");
}

// 与 runtime 的 isInteractiveTarget 同口径
const INTERACTIVE_SEL =
  "a,button,input,textarea,select,label,summary,details,[contenteditable]," +
  "[data-hvv-ink],[data-hvv-dir],.hvv-pager,.hvv-ink-fab,.hvv-inkbar," +
  ".hvv-brushgrid,.hvv-overlay,.hvv-pop,.hvv-dialog,.hvv-seltool,.hvv-zone";

// 在指定半屏里找一个「非交互元素」的落点（正文空白处），避免点到答题选项
const safePoint = async (upper) =>
  await ev(
    cdp,
    frame,
    `(()=>{
      const SEL=${JSON.stringify(INTERACTIVE_SEL)};
      const h=innerHeight, w=innerWidth;
      const y0 = ${upper ? "24" : "Math.floor(h/2)+24"};
      const y1 = ${upper ? "Math.floor(h/2)-24" : "h-24"};
      for(let y=y0; y<=y1; y+=10){
        for(let x=24; x<=w-24; x+=16){
          const e=document.elementFromPoint(x,y);
          if(e && !e.closest(SEL)) return {x,y};
        }
      }
      return null;
    })()`,
  );

const tap = async (x, y) => {
  await cdp.send(
    "Input.dispatchTouchEvent",
    { type: "touchStart", touchPoints: [{ x: x + touchDelta.x, y: y + touchDelta.y, id: 1 }] },
    frame,
  );
  await sleep(80);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, frame);
  await sleep(1400);
};

// 3a. 点到交互元素（答题选项）→ 不翻页：点选项是在答题，不是在翻页
//     必须选「当前视口内可见」的选项，否则落点不在选项上，测的就不是同一件事
const optPoint = await ev(
  cdp,
  frame,
  `(()=>{
     const ls=[...document.querySelectorAll('#content label')];
     for(const l of ls){
       const b=l.getBoundingClientRect();
       const cx=b.left+b.width/2, cy=b.top+b.height/2;
       if(cy>24 && cy<innerHeight-24 && cx>0 && cx<innerWidth){
         return {x:cx,y:cy,txt:(l.textContent||"").trim().slice(0,20)};
       }
     }
     return null;
   })()`,
);
if (optPoint) {
  before = await ev(cdp, frame, "Math.round(window.scrollY)");
  await tap(optPoint.x, optPoint.y);
  after = await ev(cdp, frame, "Math.round(window.scrollY)");
  check(
    "★ 触屏点按答题选项 → 不翻页（点选项是答题）",
    after === before,
    `选项「${optPoint.txt}」scrollY ${before} → ${after}`,
  );
} else {
  check("★ 触屏点按答题选项 → 不翻页（点选项是答题）", false, "页面上没找到 label");
}

// 3b. 点按上半屏空白处 → 向上翻页
await ev(cdp, frame, "window.scrollTo(0,600);1");
await sleep(600);
const upPoint = await safePoint(true);
before = await ev(cdp, frame, "Math.round(window.scrollY)");
if (upPoint) await tap(upPoint.x, upPoint.y);
after = await ev(cdp, frame, "Math.round(window.scrollY)");
check(
  "★ 触屏点按上半屏 → 向上翻页",
  upPoint && after < before,
  upPoint ? `落点(${upPoint.x},${upPoint.y}) scrollY ${before} → ${after}` : "找不到非交互落点",
);

// 3c. 点按下半屏空白处 → 向下翻页
await ev(cdp, frame, "window.scrollTo(0,600);1");
await sleep(600);
const downPoint = await safePoint(false);
before = await ev(cdp, frame, "Math.round(window.scrollY)");
if (downPoint) await tap(downPoint.x, downPoint.y);
after = await ev(cdp, frame, "Math.round(window.scrollY)");
check(
  "★ 触屏点按下半屏 → 向下翻页",
  downPoint && after > before,
  downPoint ? `落点(${downPoint.x},${downPoint.y}) scrollY ${before} → ${after}` : "找不到非交互落点",
);

// 滑动不翻页（原生滚动本身会改变 scrollY，所以用翻页计数器判定）
// 起点用空白处，保证「没翻页」是因为滑动规则，而不是因为点到了交互元素
const swipePoint = await safePoint(false);
const flipsBefore = await ev(cdp, frame, "window.__HTML_VIEW__.pager.getFlipCount()");
before = await ev(cdp, frame, "Math.round(window.scrollY)");
await cdp.send(
  "Input.dispatchTouchEvent",
  { type: "touchStart", touchPoints: [{ x: swipePoint.x + touchDelta.x, y: swipePoint.y + touchDelta.y, id: 2 }] },
  frame,
);
await cdp.send(
  "Input.dispatchTouchEvent",
  { type: "touchMove", touchPoints: [{ x: swipePoint.x + touchDelta.x, y: swipePoint.y - 200 + touchDelta.y, id: 2 }] },
  frame,
);
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, frame);
await sleep(1200);
const flipsAfter = await ev(cdp, frame, "window.__HTML_VIEW__.pager.getFlipCount()");
after = await ev(cdp, frame, "Math.round(window.scrollY)");
check(
  "★ 触屏滑动 → 不翻页（留给原生滚动）",
  flipsAfter === flipsBefore,
  `翻页次数 ${flipsBefore} → ${flipsAfter}；scrollY ${before} → ${after} 是原生滚动`,
);

// ---------------------------------------------------------------- 4. 页面内不再弹黑色「已保存」框

await ev(cdp, frame, "window.__HTML_VIEW__.saveNow();1");
await sleep(1500);
const toastOn = await ev(
  cdp,
  frame,
  "!!(document.querySelector('.hvv-status') && document.querySelector('.hvv-status').classList.contains('is-on'))",
);
check("★ 保存后页面内不再弹黑色「已保存」框", toastOn === false);

// ---------------------------------------------------------------- 5. 外壳：顶栏消失 / 底栏改版 / 折叠菜单

const shell = await ev(
  cdp,
  page,
  `(()=>{
    // workspace 里可能有多份 HTML 视图实例，只认当前可见的那一个
    const bars=[...document.querySelectorAll('.html-view-status')].filter(el=>el.getClientRects().length>0);
    const bar=bars[0];
    if(!bar) return null;
    const q=(s)=>bar.querySelector(s);
    return {
      hasBanner: !!q('.html-view-banner'),
      hasName: !!q('.html-view-status-name'),
      hasStatus: !!bar,
      saved: q('.html-view-status-saved') ? q('.html-view-status-saved').textContent : null,
      kept: q('.html-view-status-kept') ? q('.html-view-status-kept').textContent : null,
      fold: q('.html-view-fold') ? q('.html-view-fold').textContent : null,
      foldRect: (()=>{const b=q('.html-view-fold');if(!b)return null;const r=b.getBoundingClientRect();return {cx:r.left+r.width/2,cy:r.top+r.height/2}})(),
      menuOpen: q('.html-view-menu') ? q('.html-view-menu').classList.contains('is-open') : null,
      instanceCount: bars.length,
    };
  })()`,
);
check("★ 顶栏（常驻提示条）已移除", shell && shell.hasBanner === false);
check("★ 底栏不再显示文件名", shell && shell.hasName === false);
check("★ 底栏显示「已保存于 …」", shell && /已保存于\s*\d{2}:\d{2}:\d{2}/.test(shell.saved || ""), shell ? shell.saved : "");
check("★ 底栏有向左的折叠按钮", shell && shell.fold === "‹", shell ? `fold="${shell.fold}"` : "");

// 展开折叠菜单
await click(cdp, page, shell.foldRect.cx, shell.foldRect.cy);
await sleep(700);
const menu = await ev(
  cdp,
  page,
  `(()=>{
    const bars=[...document.querySelectorAll('.html-view-status')].filter(el=>el.getClientRects().length>0);
    const m=bars[0] ? bars[0].querySelector('.html-view-menu') : null;
    if(!m) return null;
    return {
      open: m.classList.contains('is-open'),
      name: (m.querySelector('.html-view-menu-name')||{}).textContent,
      hint: (m.querySelector('.html-view-menu-hint')||{}).textContent,
      buttons: [...m.querySelectorAll('.html-view-menu-actions button')].map(b=>b.textContent),
    };
  })()`,
);
check("★ 点折叠按钮 → 菜单展开", menu && menu.open === true);
check(
  "★ 菜单收纳了三个低频操作",
  menu &&
    menu.buttons.length === 3 &&
    menu.buttons.includes("重新加载文件") &&
    menu.buttons.includes("复制复习清单") &&
    menu.buttons.includes("使用说明"),
  menu ? menu.buttons.join(" / ") : "",
);
check("★ 菜单里显示当前文件名", menu && /auto-quiz\.html/.test(menu.name || ""), menu ? menu.name : "");
check(
  "★ 并发提示已收进菜单",
  menu && /同时打开/.test(menu.hint || ""),
  menu ? (menu.hint || "").slice(0, 30) + "…" : "",
);

// 菜单里的「复制复习清单」真的能用
const reviewBtn = await ev(
  cdp,
  page,
  `(()=>{
    const bars=[...document.querySelectorAll('.html-view-status')].filter(el=>el.getClientRects().length>0);
    const scope=bars[0];
    const b=scope?[...scope.querySelectorAll('.html-view-menu-actions button')].find(x=>x.textContent==='复制复习清单'):null;
    if(!b) return null;const r=b.getBoundingClientRect();return {cx:r.left+r.width/2,cy:r.top+r.height/2};
  })()`,
);
if (reviewBtn) {
  await click(cdp, page, reviewBtn.cx, reviewBtn.cy);
  await sleep(2500);
  let clip = "";
  try {
    clip = sh("pbpaste");
  } catch {
    clip = "";
  }
  check(
    "★ 菜单里的「复制复习清单」可用",
    clip.includes("复习清单"),
    clip ? `剪贴板 ${clip.length} 字符` : "剪贴板为空",
  );
  const closed = await ev(
    cdp,
    page,
    `(()=>{const bars=[...document.querySelectorAll('.html-view-status')].filter(el=>el.getClientRects().length>0);const m=bars[0]&&bars[0].querySelector('.html-view-menu');return m?m.classList.contains('is-open'):null})()`,
  );
  check("★ 点完菜单项后菜单自动收起", closed === false);
}

// ---------------------------------------------------------------- 收尾：关掉自己开的标签页

// 验收脚本不能给用户的工作区留垃圾。只关 auto-* 的验收页，
// 用户自己开的 demo-* 一律不动。
const closedTabs = await ev(
  cdp,
  page,
  `(()=>{
     const app=window.app; if(!app||!app.workspace) return -1;
     let n=0;
     for(const leaf of app.workspace.getLeavesOfType('html-single-file-view')){
       const st=leaf.view&&leaf.view.getState&&leaf.view.getState();
       const p=st&&typeof st.path==='string'?st.path:'';
       if(p.indexOf('html-view-test/auto-')===0){ leaf.detach(); n++; }
     }
     return n;
   })()`,
);
console.log(`\n收尾：已关闭 ${closedTabs} 个验收标签页（auto-*）`);

// ---------------------------------------------------------------- 汇总

cdp.close();
const failed = results.filter((r) => !r.ok);
console.log();
console.log(`G7 UI 改版实机验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("未通过：");
  failed.forEach((f) => console.log(`  ✗ ${f.name} ${f.detail}`));
  process.exit(1);
}
console.log("全部通过 ✅");
