/**
 * L3：runtime 的 page 宿主（Obsidian 主页面里的 MD 阅读视图）
 *
 * 覆盖的是「同一份 runtime 换个宿主还能不能正常工作」：
 *   - 初始化时不越界（不建翻页键、不接管触屏翻页、不乱加图片事件）
 *   - attachPage 之后正文根、手写画布、状态类都挂对地方
 *   - detachPage 之后该拆的都拆干净，不留残余
 *   - 临时关停让位、恢复
 *   - 宿主塞进来的进度能落到状态里
 *
 * 这里只验「逻辑对不对」；真机上还得看 Obsidian 真实渲染出来的效果（G9）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RUNTIME = readFileSync(resolve(ROOT, "templates/src/runtime.js"), "utf8");

const PAGE_HTML = `<!doctype html>
<html><head><title>t</title></head>
<body>
  <div class="app">
    <div class="markdown-preview-view" id="scroller">
      <div class="markdown-preview-sizer" id="root">
        <h1>标题一</h1>
        <p>这是一段正文，用来测试批注锚点。</p>
        <h2>标题二</h2>
        <p>这是第二段正文。</p>
      </div>
    </div>
  </div>
</body></html>`;

/** 以 page 宿主身份加载 runtime */
async function loadPageHost() {
  const dom = new JSDOM(PAGE_HTML, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://local.test/md.html",
    beforeParse(window) {
      window.__HVV_HOST__ = { kind: "page" };
      window.scrollTo = () => {};
      window.scrollBy = () => {};
    },
  });
  // 手动执行 runtime（outside-only 模式不自动跑页面脚本）
  dom.window.eval(RUNTIME);
  await new Promise((r) => setTimeout(r, 30));
  return dom;
}

test("page 宿主：初始化不越界（不建翻页键/触屏翻页/图片层）", async () => {
  const dom = await loadPageHost();
  const doc = dom.window.document;
  const api = dom.window.__HTML_VIEW__;
  assert.ok(api, "runtime 应该已就位");
  assert.equal(api.getHostKind(), "page");
  assert.equal(doc.querySelector(".hvv-pager"), null, "MD 里不要翻页键");
  assert.equal(doc.querySelector(".hvv-overlay"), null, "MD 里不要图片三态层");
  assert.ok(doc.querySelector(".hvv-page-root"), "应该有专用的界面壳");
  assert.equal(
    doc.body.classList.contains("hvv-root"),
    false,
    "不能把 class 加到 Obsidian 的 body 上",
  );
  dom.window.close();
});

test("page 宿主：attachPage 之后正文根与手写画布都挂对地方", async () => {
  const dom = await loadPageHost();
  const doc = dom.window.document;
  const api = dom.window.__HTML_VIEW__;
  const root = doc.getElementById("root");
  const scroller = doc.getElementById("scroller");

  api.attachPage({ root, scroll: scroller });

  assert.equal(api.isAttached(), true);
  assert.ok(root.classList.contains("hvv-content-root"), "正文根要有标记");
  assert.ok(root.classList.contains("hvv-root"), "正文根也要带 CSS 变量");
  assert.ok(
    doc.querySelector(".hvv-page-root").classList.contains("is-md"),
    "接上 MD 之后界面壳才显示按钮",
  );

  const svg = root.querySelector("svg.hvv-ink");
  assert.ok(svg, "手写画布应该建在正文根里");
  assert.equal(svg.parentElement, root, "画布必须是正文根的子节点");
  assert.equal(
    [...doc.body.children].some(
      (c) => c.tagName.toLowerCase() === "svg" && c.classList.contains("hvv-ink"),
    ),
    false,
    "画布不能直接挂在 body 上",
  );
  dom.window.close();
});

test("page 宿主：detachPage 之后不留下残余", async () => {
  const dom = await loadPageHost();
  const doc = dom.window.document;
  const api = dom.window.__HTML_VIEW__;
  const root = doc.getElementById("root");

  api.attachPage({ root, scroll: doc.getElementById("scroller") });
  api.detachPage();

  assert.equal(api.isAttached(), false);
  assert.equal(root.classList.contains("hvv-content-root"), false);
  assert.equal(root.classList.contains("hvv-root"), false);
  assert.equal(root.querySelector("svg.hvv-ink"), null, "画布要摘掉");
  assert.equal(
    doc.querySelector(".hvv-page-root").classList.contains("is-md"),
    false,
    "界面壳的 MD 标记要去掉",
  );
  dom.window.close();
});

test("page 宿主：临时关停 → 正文恢复可选中，恢复后状态类复原", async () => {
  const dom = await loadPageHost();
  const doc = dom.window.document;
  const api = dom.window.__HTML_VIEW__;
  const root = doc.getElementById("root");

  api.attachPage({ root, scroll: doc.getElementById("scroller") });
  assert.equal(api.isPaused(), false);

  api.setPaused(true);
  assert.equal(api.isPaused(), true);
  assert.ok(
    doc.querySelector(".hvv-page-root").classList.contains("is-paused"),
    "界面壳要进入关停态",
  );
  assert.ok(root.classList.contains("is-paused"), "正文根也要进入关停态");

  api.setPaused(false);
  assert.equal(api.isPaused(), false);
  assert.equal(
    doc.querySelector(".hvv-page-root").classList.contains("is-paused"),
    false,
  );
  assert.equal(root.classList.contains("is-paused"), false);
  dom.window.close();
});

test("page 宿主：宿主推进度 → 笔记与章节进度落到状态里", async () => {
  const dom = await loadPageHost();
  const doc = dom.window.document;
  const api = dom.window.__HTML_VIEW__;
  const root = doc.getElementById("root");

  api.attachPage({ root, scroll: doc.getElementById("scroller") });
  api.applyProgressData({
    notes: [{ id: "n1", text: "MD 笔记", at: new Date().toISOString() }],
    annotations: [
      { id: "a1", text: "评注", quote: "这是一段正文", at: new Date().toISOString() },
    ],
    strokes: [],
    sectionProgress: {},
  });

  const state = api.getState();
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].text, "MD 笔记");
  assert.equal(state.annotations.length, 1);
  assert.equal(api.getMode(), "plugin", "宿主推了数据就该进入插件模式");
  dom.window.close();
});

test("page 宿主：切篇时状态不串台", async () => {
  const dom = await loadPageHost();
  const doc = dom.window.document;
  const api = dom.window.__HTML_VIEW__;
  const rootA = doc.getElementById("root");
  const rootB = doc.createElement("div");
  rootB.innerHTML = "<p>另一篇</p>";
  doc.body.appendChild(rootB);

  api.attachPage({ root: rootA, scroll: doc.getElementById("scroller") });
  api.applyProgressData({
    notes: [{ id: "n1", text: "第一篇的笔记", at: new Date().toISOString() }],
  });
  assert.equal(api.getState().notes.length, 1);

  api.attachPage({ root: rootB, scroll: null });
  assert.equal(api.getState().notes.length, 0, "换篇后上一份数据不能带过来");
  assert.equal(rootA.classList.contains("hvv-content-root"), false);
  assert.ok(rootB.classList.contains("hvv-content-root"));
  assert.equal(rootB.querySelector("svg.hvv-ink") !== null, true, "画布要搬到新正文根");
  dom.window.close();
});

test("page 宿主：同一篇重新接管时保留内存里的涂鸦草稿", async () => {
  const dom = await loadPageHost();
  const doc = dom.window.document;
  const api = dom.window.__HTML_VIEW__;
  const root = doc.getElementById("root");
  const scroller = doc.getElementById("scroller");

  api.attachPage({ root, scroll: scroller });
  api.ink.drawStroke([{ x: 10, y: 10 }, { x: 40, y: 30 }], { color: "ink", width: 4 });
  assert.equal(api.ink.getState().draft, 1, "草稿先在内存里");

  // Obsidian 重渲染这一篇时会把正文根内容清空重建（画布被抹掉），
  // 插件会重新接管同一篇——这时候草稿要还在。
  root.innerHTML = "<p>重建后的内容</p>";
  api.attachPage({ root, scroll: scroller, keepDraft: true });
  assert.equal(api.ink.getState().draft, 1, "重新接管同一篇要保留草稿");
  assert.ok(root.querySelector("svg.hvv-ink"), "画布要重新建起来");

  // 但换到另一篇，草稿必须清掉
  const other = doc.createElement("div");
  doc.body.appendChild(other);
  api.attachPage({ root: other, scroll: null });
  assert.equal(api.ink.getState().draft, 0, "换篇要清掉草稿");
  dom.window.close();
});
