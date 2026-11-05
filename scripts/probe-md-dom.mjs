/**
 * MD 阅读视图探针（开发调试用）
 *
 *   node scripts/probe-md-dom.mjs [vault路径]
 *
 * 前置：Obsidian 以 --remote-debugging-port=9333 启动。
 *
 * 它会：
 *   1. 打开样例 MD 的阅读视图
 *   2. 把阅读视图的 DOM 结构、runtime 接管状态、界面元素位置全部打印出来
 *
 * 用来回答两个问题：
 *   - Obsidian 现在的阅读视图到底长什么样（类名、滚动容器、正文根）
 *   - runtime 有没有真的接管这一篇
 */
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VAULT = process.argv[2] || "/Users/mac/Documents/Obsidian Vault";
const PORT = Number(process.env.CDP_PORT || 9333);
const MD_REL = "html-view-test/auto-md.md";

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
    throw new Error(
      "页面求值异常：" + JSON.stringify(r.exceptionDetails).slice(0, 500),
    );
  }
  return r.result ? r.result.value : undefined;
}

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
console.log("browser:", version.Browser);

const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
const { targetInfos } = await cdp.send("Target.getTargets");
const pageTarget = targetInfos.find((t) => t.type === "page");
const { sessionId: page } = await cdp.send("Target.attachToTarget", {
  targetId: pageTarget.targetId,
  flatten: true,
});
console.log("主页面 session:", page);

// 打开样例 MD 的阅读视图
const openExpr = `(async () => {
  const leaf = app.workspace.getLeaf(false);
  await leaf.setViewState({
    type: "markdown",
    state: { file: ${JSON.stringify(MD_REL)}, mode: "preview" },
    active: true,
  });
  return "ok";
})()`;
console.log("打开阅读视图:", await ev(cdp, page, openExpr));
sleep(4000);

const diag = await ev(
  cdp,
  page,
  `(() => {
  const api = window.__HTML_VIEW__;
  const out = {
    runtimeInjected: !!api,
    hostKind: api ? api.getHostKind() : null,
    isAttached: api ? api.isAttached() : null,
    paused: api ? api.isPaused() : null,
    rootClass: api && api.getHostRoot ? (api.getHostRoot() ? api.getHostRoot().className : null) : null,
    rootTag: api && api.getHostRoot ? (api.getHostRoot() ? api.getHostRoot().tagName : null) : null,
    scrollClass: api && api.getHostScroll ? (api.getHostScroll() ? api.getHostScroll().className : null) : null,
    uiRoot: !!document.querySelector(".hvv-page-root"),
    uiRootIsMd: !!document.querySelector(".hvv-page-root.is-md"),
    inkSvgInRoot: !!(api && api.getHostRoot && api.getHostRoot()
      ? api.getHostRoot().querySelector("svg.hvv-ink") : false),
    inkSvgAnywhere: !!document.querySelector("svg.hvv-ink"),
    inkSvgParent: (() => {
      const s = document.querySelector("svg.hvv-ink");
      return s && s.parentElement ? s.parentElement.className + " / " + s.parentElement.tagName : null;
    })(),
    fabRect: (() => {
      const b = document.querySelector(".hvv-ink-fab");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    haltRect: (() => {
      const b = document.querySelector(".hvv-halt");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    panelTab: !!document.querySelector("[data-hvv-panel-tab]"),
    previewViewCount: document.querySelectorAll(".markdown-preview-view").length,
    sizerCount: document.querySelectorAll(".markdown-preview-sizer").length,
    activeFile: app.workspace.getActiveFile() ? app.workspace.getActiveFile().path : null,
    viewMode: (() => {
      const v = app.workspace.activeView;
      return v && typeof v.getMode === "function" ? v.getMode() : "n/a";
    })(),
    viewType: (() => {
      const v = app.workspace.activeView;
      return v ? v.getViewType() : null;
    })(),
  };
  return out;
})()`,
);
console.log("\n=== 诊断 ===");
console.log(JSON.stringify(diag, null, 2));

// 阅读视图 DOM 结构
const dom = await ev(
  cdp,
  page,
  `(() => {
  const pv = document.querySelector(".markdown-preview-view");
  if (!pv) return { found: false };
  const chain = [];
  let node = pv;
  for (let i = 0; i < 6 && node; i++) {
    const st = getComputedStyle(node);
    chain.push({
      tag: node.tagName,
      cls: node.className,
      overflowY: st.overflowY,
      position: st.position,
      scrollH: node.scrollHeight,
      clientH: node.clientHeight,
    });
    node = node.parentElement;
  }
  const inner = [];
  const pvKids = Array.from(pv.children).map((c) => ({
    tag: c.tagName,
    cls: c.className,
    overflowY: getComputedStyle(c).overflowY,
    position: getComputedStyle(c).position,
    scrollH: c.scrollHeight,
    clientH: c.clientHeight,
  }));
  return { found: true, chain, pvKids };
})()`,
);
console.log("\n=== 阅读视图 DOM 链 ===");
console.log(JSON.stringify(dom, null, 2));

cdp.close();
