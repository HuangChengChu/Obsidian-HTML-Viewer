/**
 * L2：翻页键专项测试（jsdom 跑真实 runtime.js 成品模板）
 *
 * 覆盖：
 *   1. 上下箭头 / 垂直居中靠右 / 拇指间隔
 *   2. ★ 点击真的能翻页 —— 含「click 的 target 被 setPointerCapture 重定向到容器」的回归
 *   3. 触屏分区翻页：点按翻页、滑动不翻、画笔模式不翻
 *   4. 旧版位置格式迁移
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const QUIZ = resolve(ROOT, "templates/template-quiz.html");

async function load() {
  const html = readFileSync(QUIZ, "utf8");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://local.test/pager.html",
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.scrollBy = () => {};
  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

/** 记录 scrollBy 调用 */
function trackScroll(dom) {
  const calls = [];
  dom.window.scrollBy = (arg) => {
    calls.push(arg);
  };
  return calls;
}

function mouse(dom, type, opts = {}) {
  const ev = new dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.x ?? 0,
    clientY: opts.y ?? 0,
  });
  Object.defineProperty(ev, "pointerId", { value: opts.pointerId ?? 1 });
  Object.defineProperty(ev, "pointerType", { value: opts.pointerType ?? "mouse" });
  return ev;
}

/** jsdom 没有 TouchEvent，手工造一个 */
function touch(dom, type, x, y) {
  const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
  const t = { clientX: x, clientY: y, identifier: 1 };
  Object.defineProperty(ev, "touches", {
    value: type === "touchend" ? [] : [t],
  });
  Object.defineProperty(ev, "changedTouches", { value: [t] });
  return ev;
}

// ---------------------------------------------------------------- 1. 形态

test("翻页键是上下箭头，垂直居中靠右，拇指间隔 44px", async () => {
  const dom = await load();
  const doc = dom.window.document;
  const pager = doc.querySelector(".hvv-pager");
  const up = pager.querySelector('[data-hvv-dir="-1"]');
  const down = pager.querySelector('[data-hvv-dir="1"]');
  assert.equal(up.textContent, "▲", "上方是向上箭头");
  assert.equal(down.textContent, "▼", "下方是向下箭头");

  const css = doc.querySelector("style[data-hvv-style]").textContent;
  assert.match(css, /\.hvv-pager\{[^}]*flex-direction:column/, "上下排列");
  assert.match(css, /\.hvv-pager\{[^}]*gap:44px/, "拇指间隔 44px");
  assert.match(css, /\.hvv-pager\{[^}]*top:50%/, "垂直居中");
  assert.match(css, /\.hvv-pager\{[^}]*right:20px/, "靠右");

  const st = pager.style;
  assert.equal(st.top, "50%", "默认垂直居中");
  assert.equal(st.right, "20px", "默认靠右 20px");
  dom.window.close();
});

// ---------------------------------------------------------------- 2. 点击真的翻页

test("★ 点击向上箭头 → 向上翻一屏", async () => {
  const dom = await load();
  const calls = trackScroll(dom);
  const doc = dom.window.document;
  const up = doc.querySelector('[data-hvv-dir="-1"]');
  up.dispatchEvent(mouse(dom, "pointerdown", { pointerId: 7 }));
  up.dispatchEvent(mouse(dom, "pointerup", { pointerId: 7 }));
  up.dispatchEvent(mouse(dom, "click"));
  assert.equal(calls.length, 1, "应触发一次滚动");
  assert.ok(calls[0].top < 0, "应向上翻");
  assert.equal(calls[0].top, -dom.window.innerHeight * 0.9);
  assert.equal(
    calls[0].behavior,
    "instant",
    "翻页必须瞬时跳转（墨水屏设备不能有平滑动画）",
  );
  dom.window.close();
});

test("★ 点击向下箭头 → 向下翻一屏", async () => {
  const dom = await load();
  const calls = trackScroll(dom);
  const doc = dom.window.document;
  const down = doc.querySelector('[data-hvv-dir="1"]');
  down.dispatchEvent(mouse(dom, "pointerdown", { pointerId: 8 }));
  down.dispatchEvent(mouse(dom, "pointerup", { pointerId: 8 }));
  down.dispatchEvent(mouse(dom, "click"));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].top > 0, "应向下翻");
  dom.window.close();
});

test("★ 回归：click 的 target 被指针捕获重定向到容器时，仍然要能翻页", async () => {
  // 真实浏览器里 setPointerCapture 会把 click 的 target 重定向到 pager 容器，
  // 于是 e.target.closest("[data-hvv-dir]") 恒为 null —— 翻页从不上线就没生效过。
  const dom = await load();
  const calls = trackScroll(dom);
  const doc = dom.window.document;
  const pager = doc.querySelector(".hvv-pager");
  const down = pager.querySelector('[data-hvv-dir="1"]');

  down.dispatchEvent(mouse(dom, "pointerdown", { pointerId: 9 }));
  down.dispatchEvent(mouse(dom, "pointerup", { pointerId: 9 }));
  // 模拟重定向：事件直接派发到容器上，e.target 就是容器
  pager.dispatchEvent(mouse(dom, "click"));

  assert.equal(calls.length, 1, "target 被重定向后也必须能翻页");
  assert.ok(calls[0].top > 0, "应向下翻");
  dom.window.close();
});

test("拖动超过 6px 视为拖动，不翻页", async () => {
  const dom = await load();
  const calls = trackScroll(dom);
  const doc = dom.window.document;
  const pager = doc.querySelector(".hvv-pager");
  const down = pager.querySelector('[data-hvv-dir="1"]');

  down.dispatchEvent(mouse(dom, "pointerdown", { pointerId: 3, x: 100, y: 100 }));
  pager.dispatchEvent(mouse(dom, "pointermove", { pointerId: 3, x: 160, y: 100 }));
  down.dispatchEvent(mouse(dom, "pointerup", { pointerId: 3, x: 160, y: 100 }));
  pager.dispatchEvent(mouse(dom, "click"));
  assert.equal(calls.length, 0, "拖动不应触发翻页");
  dom.window.close();
});

test("翻页键位置可拖动并写回进度（新格式 top 比例 + right 像素）", async () => {
  const dom = await load();
  const doc = dom.window.document;
  const pager = doc.querySelector(".hvv-pager");
  pager.dispatchEvent(mouse(dom, "pointerdown", { pointerId: 4, x: 700, y: 300 }));
  pager.dispatchEvent(mouse(dom, "pointermove", { pointerId: 4, x: 660, y: 380 }));
  pager.dispatchEvent(mouse(dom, "pointerup", { pointerId: 4, x: 660, y: 380 }));
  const ui = dom.window.__HTML_VIEW__.getState().ui.pager;
  assert.equal(typeof ui.top, "number", "top 是垂直位置比例");
  assert.equal(typeof ui.right, "number", "right 是距右像素");
  assert.ok(ui.top > 0.5, "往下拖应该更靠下");
  dom.window.close();
});

// ---------------------------------------------------------------- 3. 触屏分区翻页

test("触屏点按上半屏 → 向上翻页", async () => {
  const dom = await load();
  const calls = trackScroll(dom);
  const doc = dom.window.document;
  doc.dispatchEvent(touch(dom, "touchstart", 200, 100));
  doc.dispatchEvent(touch(dom, "touchend", 200, 100));
  assert.equal(calls.length, 1, "点按应触发翻页");
  assert.ok(calls[0].top < 0, "上半屏向上翻");
  dom.window.close();
});

test("触屏点按下半屏 → 向下翻页", async () => {
  const dom = await load();
  const calls = trackScroll(dom);
  const doc = dom.window.document;
  const y = dom.window.innerHeight - 80;
  doc.dispatchEvent(touch(dom, "touchstart", 200, y));
  doc.dispatchEvent(touch(dom, "touchend", 200, y));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].top > 0, "下半屏向下翻");
  dom.window.close();
});

test("触屏滑动 → 不翻页（交给原生滚动）", async () => {
  const dom = await load();
  const calls = trackScroll(dom);
  const doc = dom.window.document;
  doc.dispatchEvent(touch(dom, "touchstart", 200, 400));
  doc.dispatchEvent(touch(dom, "touchend", 200, 260));
  assert.equal(calls.length, 0, "滑动不应翻页");
  dom.window.close();
});

test("画笔模式下触屏不触发分区翻页", async () => {
  const dom = await load();
  const calls = trackScroll(dom);
  const doc = dom.window.document;
  dom.window.__HTML_VIEW__.ink.setActive(true);
  doc.dispatchEvent(touch(dom, "touchstart", 200, 100));
  doc.dispatchEvent(touch(dom, "touchend", 200, 100));
  assert.equal(calls.length, 0, "画笔模式触摸用于绘制/滚动");
  dom.window.close();
});

test("点在按钮上不触发分区翻页", async () => {
  const dom = await load();
  const calls = trackScroll(dom);
  const doc = dom.window.document;
  const btn = doc.querySelector(".hvv-zone-actions button");
  const r = btn.getBoundingClientRect();
  const x = r.left || 20;
  const y = r.top || 20;
  btn.dispatchEvent(touch(dom, "touchstart", x, y));
  btn.dispatchEvent(touch(dom, "touchend", x, y));
  assert.equal(calls.length, 0, "交互元素上的点按不翻页");
  dom.window.close();
});

// ---------------------------------------------------------------- 4. 旧格式迁移

test("旧版 ui.pager {x,y} 自动迁移成「垂直居中 + 距右」", async () => {
  const dom = await load();
  const api = dom.window.__HTML_VIEW__;
  const ev = new dom.window.MessageEvent("message", {
    data: {
      type: "HTML_QUIZ:PROGRESS",
      payload: {
        payload: { ui: { pager: { x: 33, y: 24 } } },
        pluginVersion: "1.2.0",
        source: "plugin",
      },
    },
  });
  dom.window.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 30));
  const pager = dom.window.document.querySelector(".hvv-pager");
  assert.equal(pager.style.right, "33px", "旧的 x 变成距右像素");
  assert.equal(pager.style.top, "50%", "旧的 y 迁移成垂直居中");
  dom.window.close();
});
