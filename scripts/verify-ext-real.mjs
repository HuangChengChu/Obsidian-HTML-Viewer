/**
 * G8 真机验收：外部 HTML（没有 runtime 的普通网页）也能用上全部页面功能
 *
 *   node scripts/verify-ext-real.mjs [vault路径]
 *
 * 前置：Obsidian 以 --remote-debugging-port=9333 启动。
 *
 * 验的是「插件打开一个自带网页时会不会自动注入 runtime」，
 * 以及注入之后翻页/作答/标注/手写是不是真的能用、能不能写回原文件。
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

const STD = join(TEST_DIR, "auto-ext.html");
const MIN = join(TEST_DIR, "auto-ext-minimal.html");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  —  " + detail : ""}`);
}
const sleep = (ms) => execSync(`sleep ${(ms / 1000).toFixed(1)}`);
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const uri = (qs) => sh(`open "obsidian://html-view?${qs}"`);
const readLog = () => {
  try {
    return JSON.parse(readFileSync(LOG_FILE, "utf8")).log || [];
  } catch {
    return [];
  }
};
const BLOCK_RE =
  /<script id="html-quiz-progress" type="application\/json">([\s\S]*?)<\/script>/;
function blockOf(file) {
  const m = BLOCK_RE.exec(readFileSync(file, "utf8"));
  return m ? JSON.parse(m[1]) : null;
}
/**
 * 把数据区整块去掉，便于比较「除数据区外有没有变」。
 * 用「去掉」而不是「替换成占位符」：基准文件可能压根没有数据区，
 * 替换成占位符的话两边就对不上了。
 */
function stripBlockText(text) {
  return text.replace(
    /<script id="html-quiz-progress" type="application\/json">[\s\S]*?<\/script>\n?/,
    "",
  );
}

/** 给验收样例页打唯一标记，便于在多个 HTML 视图里认领本次这一页 */
function markTestPage(file, id) {
  const text = readFileSync(file, "utf8");
  const tag = `<meta name="hvv-test-id" content="${id}">`;
  if (text.includes(tag)) return;
  writeFileSync(file, text.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`), "utf8");
}

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
      ws.addEventListener("open", res);
      ws.addEventListener("error", rej);
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error("CDP 超时：" + method));
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
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error("页面求值异常：" + JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  return r.result ? r.result.value : undefined;
}

/** 按唯一标记认领本次验收页面对应的 iframe */
async function attachIframe(cdp, testId, timeout = 25000) {
  const probe = `!!(document.querySelector('meta[name="hvv-test-id"]') &&
    document.querySelector('meta[name="hvv-test-id"]').content === ${JSON.stringify(testId)} &&
    window.__HTML_VIEW__)`;
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

async function click(cdp, sessionId, x, y) {
  const base = { x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 }, sessionId);
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
    `✗ 连不上 CDP ${PORT}，请用 --remote-debugging-port=${PORT} 启动 Obsidian 后重试。`,
  );
  process.exit(1);
}
check("CDP 已连上真实 Obsidian 进程", true, version.Browser);

mkdirSync(TEST_DIR, { recursive: true });
copyFileSync(join(ROOT, "templates/ext/sample-standard.html"), STD);
copyFileSync(join(ROOT, "templates/ext/sample-minimal.html"), MIN);
markTestPage(STD, "auto-ext");
markTestPage(MIN, "auto-ext-minimal");
// 基准：刚铺好时的文件内容（后面拿它跟「插件写回之后」比）
const STD_BASELINE = readFileSync(STD, "utf8");
const MIN_BASELINE = readFileSync(MIN, "utf8");

// 磁盘上的样例页确实没有 runtime（这是本门禁的前提）
check(
  "★ 样例页本身不含 runtime（是普通网页）",
  !readFileSync(STD, "utf8").includes("__HTML_VIEW__"),
);
check(
  "★ 样例页本身不含进度区",
  !readFileSync(STD, "utf8").includes("html-quiz-progress"),
);

uri("do=debug&enable=1");
sleep(800);

const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
const { targetInfos } = await cdp.send("Target.getTargets");
const pageTarget = targetInfos.find((t) => t.type === "page");
const { sessionId: page } = await cdp.send("Target.attachToTarget", {
  targetId: pageTarget.targetId,
  flatten: true,
});
check("已挂上 Obsidian 主页面 session", !!page, page);

uri(
  `do=probe&file=${encodeURIComponent("html-view-test/auto-ext.html")}`,
);
sleep(8000);
const frame = await attachIframe(cdp, "auto-ext");
check("★ 已挂上外部网页的沙箱 iframe session", !!frame, frame || "未找到");
if (!frame) {
  cdp.close();
  process.exit(1);
}
await sleep(1500);

// ---------------------------------------------------------------- 1. runtime 被注入

const injected = await ev(
  cdp,
  frame,
  `(()=>({
    runtime: typeof window.__HTML_VIEW__,
    pager: !!document.querySelector('.hvv-pager'),
    pagerBtns: document.querySelectorAll('.hvv-pager-btn').length,
    inkFab: !!document.querySelector('.hvv-ink-fab'),
    contentRoot: (function(){
      var r = document.querySelector('#content') || document.querySelector('main') || document.querySelector('article') || document.body;
      return r.tagName + (r.id ? '#'+r.id : '');
    })(),
    ownLayout: document.body.classList.contains('hvv-own-layout'),
    navLeaked: (function(){
      // 兜底到 body 时，导航栏里的 li 不该被当成正文
      var root = document.querySelector('#content') || document.querySelector('main') || document.querySelector('article') || document.body;
      if (root !== document.body) return 'n/a';
      return document.querySelectorAll('nav li').length ? 'nav 有 li' : 'nav 无 li';
    })(),
  }))()`,
);
check("★ runtime 已注入到外部网页", injected && injected.runtime === "object", JSON.stringify(injected));
check("★ 翻页键出现了（上下两个）", injected && injected.pager && injected.pagerBtns === 2, injected ? `按钮数 ${injected.pagerBtns}` : "");
check("★ 手写 FAB 出现了", injected && injected.inkFab === true);
check("★ 正文根识别正确（#content）", injected && injected.contentRoot === "MAIN#content", injected ? injected.contentRoot : "");
check(
  "★ 没有动页面的排版（未加全局 box-sizing 类）",
  injected && injected.ownLayout === false,
  injected ? `ownLayout=${injected.ownLayout}` : "",
);

// ---------------------------------------------------------------- 2. 翻页真的能用

const pagerPos = await ev(
  cdp,
  frame,
  `(()=>{const d=document.querySelector('.hvv-pager-btn[data-hvv-dir="1"]');if(!d)return null;
    const b=d.getBoundingClientRect();return {cx:b.left+b.width/2,cy:b.top+b.height/2};})()`,
);
check("★ 能定位到向下翻页键", !!pagerPos, JSON.stringify(pagerPos));

// 页面自带 scroll-behavior: smooth 时，测试自己定位滚动也必须显式 instant，
// 否则脚本里的定位会自己在动画，等下一步测量时页面早就滚到别处去了。
const scrollTo = async (y) => {
  await ev(cdp, frame, `window.scrollTo({top:${y},behavior:'instant'});1`);
  await sleep(400);
};

const metrics = await ev(
  cdp,
  frame,
  `(()=>({
     max: Math.round(document.documentElement.scrollHeight - innerHeight),
     vh: innerHeight,
     sb: getComputedStyle(document.documentElement).scrollBehavior
   }))()`,
);
const STEP = Math.round(metrics.vh * 0.9);
console.log(
  `  [页面度量] 可视高度=${metrics.vh} 最大滚动=${metrics.max} 翻页步长=${STEP} scroll-behavior=${metrics.sb}`,
);
check(
  "★ 样例页足够长（至少能滚两屏半，翻页键才有意义）",
  metrics.max > metrics.vh * 1.5,
  `最大滚动 ${metrics.max} vs 可视高度 ${metrics.vh}`,
);

// 点向下箭头 → 真的向下翻页
// 从顶部点：此时下面一定有空间，翻页键必须真的把页面往下推
await scrollTo(0);
const scrollBefore = await ev(cdp, frame, "Math.round(window.scrollY)");
if (pagerPos) await click(cdp, frame, pagerPos.cx, pagerPos.cy);
// 瞬时滚动：点完很快就得到位。页面有 scroll-behavior: smooth 时，
// 如果 runtime 用了两参数 scrollTo，这里量到的会是「才走了一半」。
await sleep(120);
const scrollSoon = await ev(cdp, frame, "Math.round(window.scrollY)");
await sleep(1200);
const scrollAfter = await ev(cdp, frame, "Math.round(window.scrollY)");
check(
  "★ 点击向下箭头 → 外部网页上真的向下翻页",
  scrollAfter > scrollBefore && scrollAfter >= scrollBefore + STEP * 0.9,
  `scrollY ${scrollBefore} → ${scrollAfter}（步长 ${STEP}）`,
);
check(
  "★ 翻页是瞬时的（页面写了 scroll-behavior:smooth 也不该变成动画）",
  scrollSoon >= scrollBefore + STEP * 0.9,
  `点击后 120ms 时 scrollY=${scrollSoon}，期望立刻到位 ≥ ${scrollBefore + Math.round(STEP * 0.9)}；页面 scroll-behavior=${metrics.sb}`,
);

// 点向上箭头 → 真的向上翻页（从底部点，上面一定有空间）
await scrollTo(metrics.max);
const upPos = await ev(
  cdp,
  frame,
  `(()=>{const d=document.querySelector('.hvv-pager-btn[data-hvv-dir="-1"]');if(!d)return null;
    const b=d.getBoundingClientRect();return {cx:b.left+b.width/2,cy:b.top+b.height/2};})()`,
);
const scrollBefore2 = await ev(cdp, frame, "Math.round(window.scrollY)");
if (upPos) await click(cdp, frame, upPos.cx, upPos.cy);
await sleep(1200);
const scrollAfter2 = await ev(cdp, frame, "Math.round(window.scrollY)");
check(
  "★ 点击向上箭头 → 真的向上翻页",
  scrollAfter2 < scrollBefore2 && scrollBefore2 - scrollAfter2 >= STEP * 0.9,
  `scrollY ${scrollBefore2} → ${scrollAfter2}（步长 ${STEP}）`,
);

// ---------------------------------------------------------------- 3. 作答能回写原文件

await ev(
  cdp,
  frame,
  `(()=>{const el=document.querySelector('#content [data-qid="q1"] input[value="B"]');
    if(!el) return false; el.checked=true; el.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`,
);
await sleep(1200);
await ev(cdp, frame, "window.__HTML_VIEW__.saveNow();1");
await sleep(1500);

const stdBlock = blockOf(STD);
check(
  "★ 外部网页保存后出现了进度区",
  !!stdBlock,
  stdBlock ? `keys=${Object.keys(stdBlock).length}` : "没找到进度区",
);
check(
  "★ 作答已落盘到外部网页文件本身",
  !!stdBlock && stdBlock.answers && stdBlock.answers.q1 && stdBlock.answers.q1.value === "B",
  stdBlock && stdBlock.answers ? JSON.stringify(stdBlock.answers.q1) : "",
);
check(
  "★ 除数据区外，外部网页逐字节未变",
  stripBlockText(readFileSync(STD, "utf8")) === stripBlockText(STD_BASELINE),
);

// ---------------------------------------------------------------- 4. 标注能落盘

await ev(
  cdp,
  frame,
  `(()=>{const el=document.querySelector('#content p');
    if(!el) return false;
    const r=document.createRange(); r.selectNodeContents(el);
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
    return true;})()`,
);
await sleep(400);
await ev(
  cdp,
  frame,
  `(()=>{try{return window.__HTML_VIEW__.addAnnotation({quote:'这一段用来验证', text:'外部网页也能标注'});}catch(e){return 'ERR:'+e.message;}})()`,
);
await sleep(1000);
await ev(cdp, frame, "window.__HTML_VIEW__.saveNow();1");
await sleep(1500);

const stdBlock2 = blockOf(STD);
check(
  "★ 标注已落盘到外部网页文件",
  !!stdBlock2 && Array.isArray(stdBlock2.annotations) && stdBlock2.annotations.length >= 1,
  stdBlock2 && stdBlock2.annotations
    ? JSON.stringify(stdBlock2.annotations[0]).slice(0, 120)
    : "",
);
check(
  "★ 标注锚点指向正文而不是目录",
  !!stdBlock2 &&
    stdBlock2.annotations.length >= 1 &&
    !String(stdBlock2.annotations[0].quote || "").includes("目录"),
  stdBlock2 && stdBlock2.annotations.length ? stdBlock2.annotations[0].quote : "",
);

// ---------------------------------------------------------------- 5. 重开能恢复

uri(`do=probe&file=${encodeURIComponent("html-view-test/auto-ext.html")}`);
sleep(8000);
const frame2 = await attachIframe(cdp, "auto-ext");
check("重新打开后已重新挂上 iframe session", !!frame2, frame2 || "未找到");
if (frame2) {
  await sleep(1500);
  const restored = await ev(
    cdp,
    frame2,
    `(()=>({
      runtime: typeof window.__HTML_VIEW__,
      checked: (document.querySelector('#content [data-qid="q1"] input:checked')||{}).value || null,
    }))()`,
  );
  check("★ 重新打开后 runtime 依然被注入", restored && restored.runtime === "object");
  check(
    "★ 重新打开后作答自动恢复",
    restored && restored.checked === "B",
    restored ? `checked=${restored.checked}` : "",
  );
}

// ---------------------------------------------------------------- 6. 没有 #content 的页面也能用

uri(`do=probe&file=${encodeURIComponent("html-view-test/auto-ext-minimal.html")}`);
sleep(8000);
const frame3 = await attachIframe(cdp, "auto-ext-minimal");
check("★ 已挂上「无 #content」网页的 iframe session", !!frame3, frame3 || "未找到");
if (frame3) {
  await sleep(1200);
  const minInfo = await ev(
    cdp,
    frame3,
    `(()=>({
      runtime: typeof window.__HTML_VIEW__,
      pager: !!document.querySelector('.hvv-pager'),
      inkFab: !!document.querySelector('.hvv-ink-fab'),
      root: (function(){var r=document.querySelector('#content')||document.querySelector('main')||document.querySelector('article')||document.body;return r.tagName;})(),
      paragraphs: (function(){var r=document.querySelector('#content')||document.querySelector('main')||document.querySelector('article')||document.body;return r.querySelectorAll('p').length;})(),
    }))()`,
  );
  check("★ 没有 #content 的网页也被注入了 runtime", minInfo && minInfo.runtime === "object", JSON.stringify(minInfo));
  check("★ 正文根退到 article", minInfo && minInfo.root === "ARTICLE", minInfo ? minInfo.root : "");
  check("★ 没有 #content 的网页也有翻页键和手写按钮", minInfo && minInfo.pager && minInfo.inkFab);
  check("★ 正文段落找得到", minInfo && minInfo.paragraphs >= 4, minInfo ? `${minInfo.paragraphs} 段` : "");

  // 标注也能用
  await ev(
    cdp,
    frame3,
    `(()=>{try{return window.__HTML_VIEW__.addAnnotation({quote:'这一段用来验证', text:'兜底路径也能标注'});}catch(e){return 'ERR:'+e.message;}})()`,
  );
  await sleep(900);
  await ev(cdp, frame3, "window.__HTML_VIEW__.saveNow();1");
  await sleep(1500);
  const minBlock = blockOf(MIN);
  check(
    "★ 没有 #content 的网页也能把标注写回文件",
    !!minBlock && Array.isArray(minBlock.annotations) && minBlock.annotations.length >= 1,
    minBlock && minBlock.annotations ? JSON.stringify(minBlock.annotations[0]).slice(0, 100) : "",
  );
}

// ---------------------------------------------------------------- 7. 插件侧收到状态上报

const log = readLog();
check("插件收到外部网页的状态上报", log.some((l) => l.includes("auto-ext")), `${log.length} 条日志`);

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
console.log(`G8 外部 HTML 实机验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("未通过：");
  failed.forEach((f) => console.log(`  ✗ ${f.name} ${f.detail}`));
  process.exit(1);
}
console.log("全部通过 ✅");

// 收尾：关掉调试日志，别把用户的插件留在「调试日志开启」状态
uri("do=debug&enable=0");
sleep(300);
