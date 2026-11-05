/**
 * G9 真机验收：MD 阅读视图里手写 / 标注 / 笔记 / 进度真的能用，且写回 frontmatter
 *
 *   node scripts/verify-md-real.mjs [vault路径]
 *
 * 前置：Obsidian 以 --remote-debugging-port=9333 启动。
 *
 * 验的是「真的在 Obsidian 里跑」这一层，单测（jsdom）验不了：
 *   - runtime 真的注入到了 Obsidian 主页面并接管了这一篇
 *   - 右下角有触笔按钮、触笔正上方有静止的关停按钮、右侧有笔记把手
 *   - 加笔记 / 画一笔 / 滚动，frontmatter 的 hvv 字段里真的出现对应数据
 *   - 关停之后正文恢复成可选中可编辑
 *   - 切到另一篇 MD，上一篇的数据不会串过去
 *   - MD 正文本身没被改坏
 */
import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
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

const MD_A = join(TEST_DIR, "auto-md.md");
const MD_B = join(TEST_DIR, "auto-md-b.md");
const MD_C = join(TEST_DIR, "auto-md-nofm.md");

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

const SAMPLE_A = `---
title: MD 阅读视图验收样例
---

# 一、这是什么

这是一份用来验收「插件在 MD 阅读视图里生效」的样例文档。

## 二、怎么用

选中任意一段文字，会弹出评注与存疑两个按钮。

## 三、章节进度

滚到这一节的时候，章节进度会记进 frontmatter 的 hvv 字段里。
`;

const SAMPLE_B = `---
title: 另一篇
---

# 另一篇文档

这是第二篇，用来验证切篇时数据不会串台。
`;

/** 完全没有 frontmatter 的 MD：用来验「插件能不能自己造出 frontmatter 块」 */
const SAMPLE_C = `# 没有 frontmatter 的一篇

正文照旧，插件保存时应该自己建出 frontmatter 块来。
`;

/** 去掉 frontmatter，只留正文（用来验证正文没被改坏） */
function bodyOf(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
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
    throw new Error(
      "页面求值异常：" + JSON.stringify(r.exceptionDetails).slice(0, 500),
    );
  }
  return r.result ? r.result.value : undefined;
}

/** 在 Obsidian 里按路径打开阅读视图 */
const OPEN_MD = (rel) => `(async () => {
  const leaf = app.workspace.getLeaf(false);
  await leaf.setViewState({
    type: "markdown",
    state: { file: ${JSON.stringify(rel)}, mode: "preview" },
    active: true,
  });
  return "ok";
})()`;

/** 读 Obsidian 解析好的 frontmatter（走的是插件自己那条路） */
const READ_FM = (rel) => `(() => {
  const f = app.vault.getAbstractFileByPath(${JSON.stringify(rel)});
  if (!f) return null;
  const c = app.metadataCache.getFileCache(f);
  return c && c.frontmatter ? c.frontmatter : null;
})()`;

/** 等 frontmatter 里出现期望的内容 */
async function waitFor(cdp, page, rel, predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    last = await ev(cdp, page, READ_FM(rel));
    if (last && predicate(last)) return last;
    await sleep(500);
  }
  return last;
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
writeFileSync(MD_A, SAMPLE_A, "utf8");
writeFileSync(MD_B, SAMPLE_B, "utf8");
writeFileSync(MD_C, SAMPLE_C, "utf8");
const BODY_A_BASE = bodyOf(SAMPLE_A);

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

/**
 * 等 Obsidian 的元数据缓存跟上磁盘上的文件。
 *
 * 插件读 frontmatter 走的是 metadataCache，而缓存是异步刷新的：
 * 脚本刚把文件重置完，缓存里还留着上一轮的 hvv，
 * 插件一合并就把上一轮的数据又并回来了（笔记会一轮轮累积）。
 * 所以这里必须等到缓存真的更新了再往下走。
 */
async function waitCache(cdp, page, rel, predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    last = await ev(cdp, page, READ_FM(rel));
    if (predicate(last)) return last;
    await sleep(300);
  }
  return last;
}

const resetA = await waitCache(
  cdp,
  page,
  "html-view-test/auto-md.md",
  (fm) => !fm || !fm.hvv,
);
check(
  "样例文件已重置，Obsidian 的缓存也跟上了（没有残留 hvv）",
  !resetA || !resetA.hvv,
  resetA ? JSON.stringify(resetA).slice(0, 120) : "缓存里没有 frontmatter",
);

// 本轮写回次数从这里开始数（插件日志是累计的）
const LOG_BASE = readLog().length;

// ---------------------------------------------------------------- 1. 接管

await ev(cdp, page, OPEN_MD("html-view-test/auto-md.md"));
sleep(3500);

const diag = await ev(
  cdp,
  page,
  `(() => {
  const api = window.__HTML_VIEW__;
  if (!api) return { runtimeInjected: false };
  const root = api.getHostRoot ? api.getHostRoot() : null;
  const fab = document.querySelector(".hvv-ink-fab");
  const halt = document.querySelector(".hvv-halt");
  const tab = document.querySelector("[data-hvv-panel-tab]");
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  return {
    runtimeInjected: true,
    hostKind: api.getHostKind(),
    isAttached: api.isAttached(),
    paused: api.isPaused(),
    rootClass: root ? root.className : null,
    scrollClass: api.getHostScroll && api.getHostScroll() ? api.getHostScroll().className : null,
    inkInRoot: root ? !!root.querySelector("svg.hvv-ink") : false,
    inkDirectlyOnBody: [...document.body.children].some(
      (c) => c.tagName.toLowerCase() === "svg" && c.classList.contains("hvv-ink"),
    ),
    fabRect: r(fab),
    haltRect: r(halt),
    tabRect: r(tab),
    pager: !!document.querySelector(".hvv-pager"),
    overlay: !!document.querySelector(".hvv-overlay"),
    bodyHasHvvClass: document.body.classList.contains("hvv-root"),
  };
})()`,
);

check("★ runtime 已注入 Obsidian 主页面", !!diag.runtimeInjected);
check("★ 宿主类型是 page（不是 iframe）", diag.hostKind === "page", diag.hostKind);
check("★ 已接管当前这篇 MD", diag.isAttached === true);
check(
  "正文根是阅读视图的内容容器",
  /markdown-preview-sizer/.test(String(diag.rootClass)),
  String(diag.rootClass),
);
check(
  "滚动容器是阅读视图自己",
  /markdown-preview-view/.test(String(diag.scrollClass)),
  String(diag.scrollClass),
);
check("手写画布建在正文根里", diag.inkInRoot === true);
check("画布没有直接挂在 body 上", diag.inkDirectlyOnBody === false);
check("MD 里没有翻页键（不跟 Obsidian 打架）", diag.pager === false);
check("MD 里没有图片三态层", diag.overlay === false);
check(
  "没有往 Obsidian 的 body 上加 class",
  diag.bodyHasHvvClass === false,
);

// 右下角：触笔 + 静止关停按钮（笔的正上方）+ 右侧笔记把手
check("右下角有触笔按钮", !!diag.fabRect, JSON.stringify(diag.fabRect));
check("触笔正上方有静止的关停按钮", !!diag.haltRect, JSON.stringify(diag.haltRect));
if (diag.fabRect && diag.haltRect) {
  check(
    "关停按钮就在笔的上方",
    Math.abs(diag.fabRect.x - diag.haltRect.x) < 6 &&
      diag.haltRect.y + diag.haltRect.h <= diag.fabRect.y + 2,
    `笔 y=${diag.fabRect.y}，开关 y=${diag.haltRect.y}`,
  );
}
check("右侧有笔记把手", !!diag.tabRect, JSON.stringify(diag.tabRect));

// ---------------------------------------------------------------- 2. 笔记

await ev(
  cdp,
  page,
  `(() => {
  const api = window.__HTML_VIEW__;
  api.addNote("G9 验收笔记");
  api.saveNow();
  return "ok";
})()`,
);
const fmAfterNote = await waitFor(
  cdp,
  page,
  "html-view-test/auto-md.md",
  (fm) => fm.hvv && Array.isArray(fmvNotes(fm)) && fmvNotes(fm).length > 0,
);
function fmvNotes(fm) {
  return (fm.hvv && fm.hvv.notes) || [];
}
check(
  "★ 笔记写进 frontmatter 的 hvv",
  !!(fmAfterNote && fmAfterNote.hvv && fmvNotes(fmAfterNote).length > 0),
  fmAfterNote ? JSON.stringify(fmvNotes(fmAfterNote)).slice(0, 160) : "没有 hvv",
);
check(
  "笔记内容正确",
  !!fmAfterNote &&
    fmvNotes(fmAfterNote).some((n) => n && n.text === "G9 验收笔记"),
);
check(
  "★ 磁盘上的 MD 文件里真的有 hvv 字段",
  /(^|\n)hvv:/.test(readFileSync(MD_A, "utf8")),
);
check(
  "★ MD 正文没被改坏",
  bodyOf(readFileSync(MD_A, "utf8")) === BODY_A_BASE,
);

// ---------------------------------------------------------------- 3. 涂鸦

await ev(
  cdp,
  page,
  `(() => {
  const api = window.__HTML_VIEW__;
  api.ink.drawStroke([{ x: 40, y: 60 }, { x: 90, y: 80 }, { x: 130, y: 70 }], { color: "red", width: 4 });
  api.ink.save();
  return "ok";
})()`,
);
const fmAfterInk = await waitFor(
  cdp,
  page,
  "html-view-test/auto-md.md",
  (fm) => fm.hvv && Array.isArray(fm.hvv.strokes) && fm.hvv.strokes.length > 0,
);
check(
  "★ 涂鸦写进 frontmatter 的 hvv.strokes",
  !!(fmAfterInk && fmAfterInk.hvv && Array.isArray(fmAfterInk.hvv.strokes)),
  fmAfterInk ? `strokes=${fmAfterInk.hvv?.strokes?.length}` : "没有 hvv",
);

// ---------------------------------------------------------------- 4. 章节进度

await ev(
  cdp,
  page,
  `(() => {
  const sc = document.querySelector(".markdown-preview-view");
  sc.scrollTop = Math.max(120, Math.floor(sc.scrollHeight * 0.6));
  sc.dispatchEvent(new Event("scroll"));
  return sc.scrollTop;
})()`,
);
sleep(2500);
const fmAfterScroll = await waitFor(
  cdp,
  page,
  "html-view-test/auto-md.md",
  (fm) =>
    fm.hvv &&
    fm.hvv.sectionProgress &&
    Object.keys(fm.hvv.sectionProgress).length > 0,
);
check(
  "★ 章节进度写进 frontmatter 的 hvv.sectionProgress",
  !!(
    fmAfterScroll &&
    fmAfterScroll.hvv &&
    fmAfterScroll.hvv.sectionProgress &&
    Object.keys(fmAfterScroll.hvv.sectionProgress).length > 0
  ),
  fmAfterScroll ? JSON.stringify(fmAfterScroll.hvv?.sectionProgress).slice(0, 200) : "没有",
);

// ---------------------------------------------------------------- 5. 关停

const pausedState = await ev(
  cdp,
  page,
  `(() => {
  const btn = document.querySelector(".hvv-halt");
  btn.click();
  const api = window.__HTML_VIEW__;
  const root = api.getHostRoot();
  const cs = getComputedStyle(root);
  const selTool = document.querySelector(".hvv-seltool");
  return {
    paused: api.isPaused(),
    userSelect: cs.userSelect || cs.webkitUserSelect,
    btnText: btn.textContent,
    uiRootPaused: document.querySelector(".hvv-page-root").classList.contains("is-paused"),
    selToolPointer: selTool ? getComputedStyle(selTool).pointerEvents : "n/a",
  };
})()`,
);
check("★ 点关停按钮后运行时进入暂停态", pausedState.paused === true);
check(
  "暂停后正文恢复可选中（user-select 不是 none）",
  pausedState.userSelect !== "none",
  String(pausedState.userSelect),
);
check("按钮变成 ▶（可以再点回来）", pausedState.btnText === "▶", pausedState.btnText);
check("界面壳进入暂停态", pausedState.uiRootPaused === true);

const resumed = await ev(
  cdp,
  page,
  `(() => {
  document.querySelector(".hvv-halt").click();
  return window.__HTML_VIEW__.isPaused();
})()`,
);
check("再点一下恢复运行", resumed === false);

// ---------------------------------------------------------------- 6. 切篇不串台

await ev(cdp, page, OPEN_MD("html-view-test/auto-md-b.md"));
sleep(3000);
const stateB = await ev(cdp, page, `(() => {
  const api = window.__HTML_VIEW__;
  const s = api.getState();
  return { notes: (s.notes || []).length, attached: api.isAttached() };
})()`);
check("切到第二篇后已接管新的一篇", stateB.attached === true);
check(
  "★ 切篇后上一篇的数据没有串过来",
  stateB.notes === 0,
  `第二篇 notes=${stateB.notes}`,
);
check(
  "★ 切篇瞬间的残留保存没有打到第二篇的文件上",
  !readFileSync(MD_B, "utf8").includes("G9 验收笔记"),
  "第二篇文件里不该出现第一篇的笔记",
);

await ev(cdp, page, OPEN_MD("html-view-test/auto-md.md"));
sleep(3000);
const stateA = await ev(cdp, page, `(() => {
  const api = window.__HTML_VIEW__;
  const s = api.getState();
  return { notes: (s.notes || []).length, strokes: (s.strokes || []).length };
})()`);
check(
  "★ 切回第一篇，笔记与涂鸦都还在（且没有重复累积）",
  stateA.notes === 1 && stateA.strokes === 1,
  `notes=${stateA.notes} strokes=${stateA.strokes}`,
);

// ---------------------------------------------------------------- 7. 死循环

// 没有 frontmatter 的 MD：插件要能自己把 frontmatter 块建出来
await ev(cdp, page, OPEN_MD("html-view-test/auto-md-nofm.md"));
sleep(3000);
await ev(
  cdp,
  page,
  `(() => {
  const api = window.__HTML_VIEW__;
  api.addNote("无 frontmatter 篇的笔记");
  api.saveNow();
  return "ok";
})()`,
);
const fmNoFm = await waitFor(
  cdp,
  page,
  "html-view-test/auto-md-nofm.md",
  (fm) => fm && fm.hvv && Array.isArray(fm.hvv.notes) && fm.hvv.notes.length > 0,
);
check(
  "★ 没有 frontmatter 的 MD，插件自己建出了 frontmatter 块",
  !!(fmNoFm && fmNoFm.hvv && fmNoFm.hvv.notes.length > 0),
  fmNoFm ? JSON.stringify(fmNoFm.hvv?.notes).slice(0, 120) : "没有 hvv",
);
check(
  "建出来的 frontmatter 里正文没丢",
  readFileSync(MD_C, "utf8").includes("没有 frontmatter 的一篇"),
);

const log = readLog().slice(LOG_BASE);
const writes = log.filter((l) => l.includes("MD 写回成功")).length;
check(
  "★ 没有「写→重渲染→再写」的死循环",
  writes <= 8,
  `本轮写回 ${writes} 次`,
);

// ---------------------------------------------------------------- 收尾

cdp.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== G9 结果：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
  process.exit(1);
}
