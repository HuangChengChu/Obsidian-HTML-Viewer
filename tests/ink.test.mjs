/**
 * L1/L2：手写标注层（incremental 模块）测试
 *
 * 覆盖三块：
 *   1. 纯函数：SVG 路径数学（可单测、无 DOM 依赖）
 *   2. 合并契约：strokes[] 按 id 合并 + 墓碑终态
 *   3. 运行时行为：jsdom 跑真实 runtime.js 成品模板
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { mergeProgress, stripTombstones } from "../plugin/src/merge.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const QUIZ = resolve(ROOT, "templates/template-quiz.html");

const at = (t) => new Date(t).toISOString();

// ---------------------------------------------------------------- 工具

async function load(file = QUIZ, url = "https://local.test/ink.html") {
  const html = readFileSync(file, "utf8");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url,
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.scrollBy = () => {};
  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

/** jsdom 没有布局引擎，这里手工给出矩形，让锚点/坐标换算走真实分支 */
function fakeRect(el, left, top, width, height) {
  el.getBoundingClientRect = () => ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
}

/** 给内容区与两段题干一个确定的版面 */
function layout(dom) {
  const doc = dom.window.document;
  const content = doc.querySelector("#content");
  fakeRect(content, 0, 0, 600, 800);
  const titles = [...doc.querySelectorAll("#content p.q-title")];
  fakeRect(titles[0], 20, 100, 560, 40);
  fakeRect(titles[1], 20, 300, 560, 40);
  return { content, titles };
}

/** jsdom 没有 PointerEvent，用 MouseEvent + 自定义属性模拟 */
function pointerEvent(dom, type, props) {
  const ev = new dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: props.clientX,
    clientY: props.clientY,
  });
  Object.defineProperty(ev, "pointerType", {
    value: props.pointerType || "mouse",
  });
  Object.defineProperty(ev, "pointerId", { value: props.pointerId || 1 });
  return ev;
}

// ---------------------------------------------------------------- 1. 路径数学

test("inkPointsToPath: 首点绝对、其余相对", async () => {
  const dom = await load();
  const { pointsToPath } = dom.window.__HTML_VIEW__.ink.path;
  assert.equal(
    pointsToPath([
      { x: 10, y: 20 },
      { x: 30, y: 25 },
      { x: 30, y: 45 },
    ]),
    "M10,20 l20,5 l0,20",
  );
  dom.window.close();
});

test("inkPathToPath 往返一致（相对路径可还原点集）", async () => {
  const dom = await load();
  const { pointsToPath, pathToPoints } = dom.window.__HTML_VIEW__.ink.path;
  const pts = [
    { x: 10, y: 20 },
    { x: 30, y: 25 },
    { x: 30, y: 45 },
  ];
  const back = pathToPoints(pointsToPath(pts));
  assert.equal(back.length, 3);
  assert.deepEqual(
    Array.from(back, (p) => [p.x, p.y]),
    pts.map((p) => [p.x, p.y]),
  );
  dom.window.close();
});

test("inkTranslatePath: 相对路径平移只改首点", async () => {
  const dom = await load();
  const { translatePath } = dom.window.__HTML_VIEW__.ink.path;
  const d = "M10,20 l20,5 l0,20";
  assert.equal(translatePath(d, 5, -3), "M15,17 l20,5 l0,20");
  dom.window.close();
});

test("inkTranslatePath: 负数与小数正确处理", async () => {
  const dom = await load();
  const { translatePath, pathToPoints } = dom.window.__HTML_VIEW__.ink.path;
  const d = "M10.5,-20.25 l-3.5,4";
  const moved = translatePath(d, -10.5, 20.25);
  assert.equal(moved, "M0,0 l-3.5,4");
  const pts = pathToPoints(moved);
  assert.equal(pts[0].x, 0);
  assert.equal(pts[0].y, 0);
  assert.equal(pts[1].x, -3.5);
  assert.equal(pts[1].y, 4);
  dom.window.close();
});

// ---------------------------------------------------------------- 2. 合并契约

test("mergeProgress: strokes 按 id 合并，同 id 取 at 新者", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-05T10:00:00Z") },
    strokes: [
      { id: "s1", d: "M1,1", at: at("2026-11-05T10:00:00Z") },
      { id: "s2", d: "M2,2", at: at("2026-11-05T10:00:00Z") },
    ],
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-05T11:00:00Z") },
    strokes: [
      { id: "s1", d: "M9,9", at: at("2026-11-05T11:00:00Z") },
      { id: "s3", d: "M3,3", at: at("2026-11-05T11:00:00Z") },
    ],
  };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.strokes.length, 3);
  const s1 = merged.strokes.find((s) => s.id === "s1");
  assert.equal(s1.d, "M9,9", "同 id 取更新的 incoming");
  assert.ok(merged.strokes.some((s) => s.id === "s2"), "只在磁盘有的应保留");
  assert.ok(merged.strokes.some((s) => s.id === "s3"), "只在 incoming 有的应保留");
});

test("mergeProgress: strokes 墓碑是终态（删除会跨设备同步）", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-05T10:00:00Z") },
    strokes: [{ id: "s1", d: "M1,1", at: at("2026-11-05T10:00:00Z") }],
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-05T11:00:00Z") },
    strokes: [{ id: "s1", deleted: true, at: at("2026-11-05T11:00:00Z") }],
  };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.strokes.length, 1);
  assert.equal(merged.strokes[0].deleted, true, "任一侧为墓碑，结果即墓碑");
});

test("mergeProgress: 磁盘是墓碑时不会被 incoming 的旧笔迹复活", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-05T12:00:00Z") },
    strokes: [{ id: "s1", deleted: true, at: at("2026-11-05T12:00:00Z") }],
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-05T11:00:00Z") },
    strokes: [{ id: "s1", d: "M1,1", at: at("2026-11-05T11:00:00Z") }],
  };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.strokes[0].deleted, true);
});

test("stripTombstones: 也能清理 strokes 里的墓碑", () => {
  const block = {
    strokes: [
      { id: "s1", d: "M1,1" },
      { id: "s2", deleted: true },
    ],
    notes: [{ id: "n1" }, { id: "n2", deleted: true }],
  };
  const cleaned = stripTombstones(block);
  assert.equal(cleaned.strokes.length, 1);
  assert.equal(cleaned.strokes[0].id, "s1");
  assert.equal(cleaned.notes.length, 1);
});

// ---------------------------------------------------------------- 3. 运行时

test("手写层 UI 就位：画布 / 悬浮按钮 / 工具条 / 缩放标签", async () => {
  const dom = await load();
  const doc = dom.window.document;
  assert.ok(doc.querySelector("svg.hvv-ink"), "应有铺在正文上的 SVG 画布");
  assert.ok(doc.querySelector(".hvv-ink-fab"), "应有右下角 ✏️ 悬浮按钮");
  const bar = doc.querySelector(".hvv-inkbar");
  assert.ok(bar, "应有工具条");
  const acts = [...bar.querySelectorAll("[data-hvv-ink]")].map((b) =>
    b.getAttribute("data-hvv-ink"),
  );
  for (const need of ["brush", "eraser", "clear", "save", "pen", "scroll", "exit"]) {
    assert.ok(acts.includes(need), `工具条应含 ${need}`);
  }
  assert.ok(doc.querySelector(".hvv-brushgrid"), "应有笔刷选择面板");
  assert.ok(doc.querySelector(".hvv-zoomtag"), "应有缩放标签");
  dom.window.close();
});

test("未进入画笔模式时画布不拦截指针事件（正文照常交互）", async () => {
  const dom = await load();
  const doc = dom.window.document;
  const css = doc.querySelector("style[data-hvv-style]").textContent;
  assert.match(
    css,
    /\.hvv-ink\{[^}]*pointer-events:none/,
    "默认画布不拦事件",
  );
  assert.match(
    css,
    /\.hvv-root\.is-ink \.hvv-ink\{pointer-events:auto/,
    "画笔模式下画布接管事件",
  );
  assert.equal(doc.body.classList.contains("is-ink"), false);
  dom.window.close();
});

test("进入画笔模式：画布接管事件 + 工具条显示 + 悬浮按钮变退出", async () => {
  const dom = await load();
  const api = dom.window.__HTML_VIEW__;
  const doc = dom.window.document;
  api.ink.setActive(true);
  assert.equal(doc.body.classList.contains("is-ink"), true);
  assert.equal(doc.querySelector(".hvv-inkbar").classList.contains("is-on"), true);
  assert.equal(doc.querySelector(".hvv-ink-fab").textContent, "✕");
  assert.equal(api.ink.getState().active, true);
  dom.window.close();
});

test("临时草稿只进内存，不进保存载荷", async () => {
  const dom = await load();
  const api = dom.window.__HTML_VIEW__;
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  const s = api.ink.getState();
  assert.equal(s.draft, 1, "有一笔临时草稿");
  assert.equal(s.saved, 0);
  const payload = api.getState();
  assert.equal(payload.strokes.length, 0, "草稿不得进写回载荷");
  dom.window.close();
});

test("点「保存涂鸦」才写盘：draft 并入 strokes 并带锚点", async () => {
  const dom = await load();
  layout(dom);
  const api = dom.window.__HTML_VIEW__;
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  api.ink.save();
  const payload = api.getState();
  assert.equal(payload.strokes.length, 1, "已保存笔迹应进写回载荷");
  const st = payload.strokes[0];
  assert.ok(st.id, "应有 id");
  assert.ok(st.d.startsWith("M30,110"), "路径应是相对路径格式");
  assert.equal(st.color, "ink");
  assert.equal(st.width, 4);
  assert.equal(st.saved, true);
  assert.ok(st.anchor && typeof st.anchor.text === "string", "应带段落锚点");
  assert.equal(
    st.anchor.text,
    "Q1. 单文件 HTML 页面要保证「删掉文件就彻底干净」，进度数据必须存在哪里",
    "锚点文本取段落前 40 字",
  );
  assert.equal(st.anchor.dx, 10, "锚点 dx 是笔迹起点相对段落左边的偏移");
  assert.equal(st.anchor.dy, 10, "锚点 dy 是笔迹起点相对段落上边的偏移");
  assert.equal(api.ink.getState().draft, 0, "保存后草稿清空");
  dom.window.close();
});

test("写回载荷里不出现仅运行时的重排偏移 dx/dy（避免多设备互相覆盖坐标）", async () => {
  const dom = await load();
  layout(dom);
  const api = dom.window.__HTML_VIEW__;
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  api.ink.save();
  const payload = api.getState();
  assert.equal("dx" in payload.strokes[0], false);
  assert.equal("dy" in payload.strokes[0], false);
  assert.ok(payload.strokes[0].anchor, "偏移只体现在 anchor 里");
  dom.window.close();
});

test("重排校正：段落下移后笔迹跟着平移（偏移不写回文件）", async () => {
  const dom = await load();
  const { titles } = layout(dom);
  const api = dom.window.__HTML_VIEW__;
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  api.ink.save();

  // 模拟换设备 / 改宽度后版面变化：第一段整体下移 100px
  fakeRect(titles[0], 20, 200, 560, 40);
  api.ink.reflow();

  const path = dom.window.document.querySelector("svg.hvv-ink path.hvv-saved");
  assert.ok(path, "应有已保存笔迹");
  assert.ok(path.getAttribute("d").startsWith("M30,210"), `应平移到新位置，实际 ${path.getAttribute("d")}`);

  const payload = api.getState();
  assert.equal("dx" in payload.strokes[0], false, "运行时偏移不得写回文件");
  assert.ok(payload.strokes[0].d.startsWith("M30,110"), "文件里仍是原始坐标");
  dom.window.close();
});

test("单击清屏只清临时草稿，已保存笔迹不受影响", async () => {
  const dom = await load();
  layout(dom);
  const api = dom.window.__HTML_VIEW__;
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  api.ink.save();
  api.ink.drawStroke([
    { x: 30, y: 320 },
    { x: 60, y: 340 },
  ]);
  assert.equal(api.ink.getState().draft, 1);
  api.ink.clearDraft();
  const s = api.ink.getState();
  assert.equal(s.draft, 0, "草稿已清");
  assert.equal(s.saved, 1, "已保存笔迹不受影响");
  assert.equal(api.getState().strokes.length, 1);
  dom.window.close();
});

test("双击清全部：弹确认框，确认后已保存笔迹写墓碑", async () => {
  const dom = await load();
  layout(dom);
  const api = dom.window.__HTML_VIEW__;
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  api.ink.save();

  api.ink.clearAll();
  const dlg = dom.window.document.querySelector(".hvv-dialog");
  assert.ok(dlg.classList.contains("is-on"), "应弹出确认框");
  const okBtn = [...dlg.querySelectorAll("button")].find(
    (b) => b.textContent === "确认清空",
  );
  assert.ok(okBtn, "应有确认按钮");
  okBtn.click();

  const payload = api.getState();
  assert.equal(payload.strokes.length, 1, "条目还在，但状态是墓碑");
  assert.equal(payload.strokes[0].deleted, true, "删除要走墓碑以便跨设备同步");
  assert.equal(api.ink.getState().saved, 0, "画面上不再有笔迹");
  dom.window.close();
});

test("橡皮删除已保存笔迹 → 写墓碑", async () => {
  const dom = await load();
  layout(dom);
  const api = dom.window.__HTML_VIEW__;
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  api.ink.save();
  api.ink.eraseAt(45, 120);
  const payload = api.getState();
  assert.equal(payload.strokes.length, 1);
  assert.equal(payload.strokes[0].deleted, true);
  assert.equal(api.ink.getState().saved, 0);
  dom.window.close();
});

test("正文双击放大 2x，再双击还原 1x", async () => {
  const dom = await load();
  layout(dom);
  const api = dom.window.__HTML_VIEW__;
  api.ink.zoomIn(100, 200);
  assert.equal(api.ink.getState().zoom, 2);
  const tag = dom.window.document.querySelector(".hvv-zoomtag");
  assert.equal(tag.classList.contains("is-on"), true, "放大态应显示缩放标签");
  assert.match(tag.textContent, /200%/);
  api.ink.zoomReset();
  assert.equal(api.ink.getState().zoom, 1);
  assert.equal(tag.classList.contains("is-on"), false);
  dom.window.close();
});

test("底部区显示「手写标注 N 笔」", async () => {
  const dom = await load();
  layout(dom);
  const api = dom.window.__HTML_VIEW__;
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  api.ink.save();
  api.renderZone();
  const sum = dom.window.document.querySelector("[data-hvv-zone-sum]");
  assert.match(sum.textContent, /手写标注 1 笔/);
  dom.window.close();
});

test("工具条吸附位置随进度同步（ui.inkbar）", async () => {
  const dom = await load();
  const api = dom.window.__HTML_VIEW__;
  const bar = dom.window.document.querySelector(".hvv-inkbar");
  // jsdom 无布局引擎，手工给出工具条矩形：贴近左边
  fakeRect(bar, 2, 30, 100, 40);
  const grip = bar.querySelector('[data-hvv-ink="grip"]');
  grip.dispatchEvent(pointerEvent(dom, "pointerdown", { clientX: 100, clientY: 100 }));
  grip.dispatchEvent(pointerEvent(dom, "pointermove", { clientX: 2, clientY: 30 }));
  grip.dispatchEvent(pointerEvent(dom, "pointerup", { clientX: 2, clientY: 30 }));
  const payload = api.getState();
  assert.ok(payload.ui.inkbar, "工具条吸附位置应进进度");
  assert.equal(payload.ui.inkbar.edge, "left", "拖到左侧应吸附左边");
  assert.equal(bar.classList.contains("is-v"), true, "左/右吸附时工具条竖排");
  dom.window.close();
});

test("手写层不破坏既有进度采集（答题 / 笔记仍可写）", async () => {
  const dom = await load();
  const api = dom.window.__HTML_VIEW__;
  api.setAnswer("q1", "B");
  api.addNote("随手一条");
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  api.ink.save();
  const payload = api.getState();
  assert.equal(payload.answers.q1.value, "B");
  assert.equal(payload.notes.length, 1);
  assert.equal(payload.strokes.length, 1);
  dom.window.close();
});

test("进度数据区不被页面直接改写（写回仍只由插件做）", async () => {
  const dom = await load();
  const before = dom.window.document.getElementById("html-quiz-progress").textContent;
  const api = dom.window.__HTML_VIEW__;
  api.ink.drawStroke([
    { x: 30, y: 110 },
    { x: 60, y: 130 },
  ]);
  api.ink.save();
  const after = dom.window.document.getElementById("html-quiz-progress").textContent;
  assert.equal(before, after, "页面侧不得修改数据区");
  dom.window.close();
});
