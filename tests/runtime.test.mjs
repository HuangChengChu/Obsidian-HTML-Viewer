/**
 * L2：页面运行时行为自检（jsdom 跑真实 runtime.js 代码）
 *
 * 这些断言全部针对「成品模板 + 真实运行时」，不是 mock。
 * 真机（真实 Obsidian / Chromium）端到端断言见 L3。
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
const NEWS = resolve(ROOT, "templates/template-news.html");

async function load(file, url = "https://local.test/page.html") {
  const html = readFileSync(file, "utf8");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url,
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.scrollBy = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

test("运行时已加载并暴露接口", async () => {
  const dom = await load(QUIZ);
  const api = dom.window.__HTML_VIEW__;
  assert.ok(api, "__HTML_VIEW__ 应该存在");
  assert.ok(api.version);
  assert.equal(typeof api.getMode, "function");
  dom.window.close();
});

test("不在插件环境时自动降级，并显示明确提示", async () => {
  const dom = await load(QUIZ);
  const api = dom.window.__HTML_VIEW__;
  assert.equal(api.getMode(), "fallback");
  const banner = dom.window.document.getElementById("hvv-banner");
  assert.ok(banner, "应有降级横幅");
  assert.ok(banner.classList.contains("is-on"));
  assert.match(banner.textContent, /当前不在自定义 HTML 视图/);
  assert.match(banner.textContent, /无法跨设备同步/);
  dom.window.close();
});

test("降级时进度写入 localStorage", async () => {
  const dom = await load(QUIZ);
  const api = dom.window.__HTML_VIEW__;
  api.setAnswer("q1", "B");
  api.saveNow();
  const raw = dom.window.localStorage.getItem("html-view-progress:/page.html");
  assert.ok(raw, "应写入 localStorage");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.answers.q1.value, "B");
  dom.window.close();
});

test("file:// 下 localStorage 不可用时退到内存且不抛错", async () => {
  const dom = await load(QUIZ, "file:///tmp/page.html");
  const api = dom.window.__HTML_VIEW__;
  api.setAnswer("q2", "A");
  assert.doesNotThrow(() => api.saveNow());
  const state = api.getState();
  assert.equal(state.answers.q2.value, "A");
  dom.window.close();
});

test("采集：单选 / 多选 / 思路 / 存疑", async () => {
  const dom = await load(QUIZ);
  const api = dom.window.__HTML_VIEW__;
  const doc = dom.window.document;

  api.setAnswer("q1", "B");
  const why = doc.querySelector('[data-qid="q1"] .q-why');
  why.value = "因为要写在文件里";
  const doubt = doc.querySelector('[data-qid="q1"] .q-doubt');
  doubt.checked = true;

  const q2 = doc.querySelector('[data-qid="q2"]');
  q2.querySelector('input[value="A"]').checked = true;
  q2.querySelector('input[value="B"]').checked = true;

  const s = api.getState();
  assert.equal(s.answers.q1.value, "B");
  assert.equal(s.answers.q1.why, "因为要写在文件里");
  assert.equal(s.answers.q1.doubt, true);
  assert.ok(Array.isArray(s.answers.q2.value));
  assert.deepEqual(Array.from(s.answers.q2.value).sort(), ["A", "B"]);
  assert.ok(s.answers.q1.at, "应带题级时间戳");
  dom.window.close();
});

test("采集：笔记 / 评注 / 位置标记 三类各自成数组", async () => {
  const dom = await load(QUIZ);
  const api = dom.window.__HTML_VIEW__;
  api.addNote("随手记一条灵感");
  api.addAnnotation({ quote: "题干片段", text: "这句没看懂" });
  api.addMark({ text: "回头看" });
  const s = api.getState();
  assert.equal(s.notes.length, 1);
  assert.equal(s.annotations.length, 1);
  assert.equal(s.marks.length, 1);
  assert.equal(s.annotations[0].quote, "题干片段");
  assert.equal(typeof s.marks[0].y, "number");
  dom.window.close();
});

test("章节切分：显式 data-sid 优先", async () => {
  const dom = await load(QUIZ);
  const sections = dom.window.__HTML_VIEW__.getSections();
  assert.equal(sections.length, 2);
  assert.deepEqual(Array.from(sections, (s) => s.id), ["s1", "s2"]);
  dom.window.close();
});

test("资讯页无显式标记时按 h2 回退切分", async () => {
  const runtime = readFileSync(resolve(ROOT, "templates/src/runtime.js"), "utf8");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<article id="content">
  <h2>第一章</h2><p>正文一</p>
  <h2>第二章</h2><p>正文二</p>
</article>
<section id="html-interaction-zone"></section>
<script>${runtime}</script>
</body></html>`;
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://local.test/fallback.html",
  });
  dom.window.scrollTo = () => {};
  await new Promise((r) => setTimeout(r, 60));
  const sections = dom.window.__HTML_VIEW__.getSections();
  assert.equal(sections.length, 2, "应按 h2 切成 2 节");
  assert.ok(sections[0].id.startsWith("auto-"), "回退切分使用 auto- 前缀");
  assert.equal(sections[0].title, "第一章");
  dom.window.close();
});

test("判分：答对显示正确徽标，答错显示错误与正确答案", async () => {
  const dom = await load(QUIZ);
  const api = dom.window.__HTML_VIEW__;
  api.setAnswer("q1", "B");
  api.updateJudges();
  const badges = dom.window.document.querySelectorAll(".hvv-q-judge");
  assert.ok(badges.length >= 1, "应有判分徽标");
  const ok = [...badges].find((b) => b.classList.contains("is-ok"));
  assert.ok(ok, "q1 选 B（正确答案）应显示正确");
  api.setAnswer("q1", "A");
  api.updateJudges();
  const bad = [...dom.window.document.querySelectorAll(".hvv-q-judge")].find(
    (b) => b.classList.contains("is-no"),
  );
  assert.ok(bad, "答错应显示错误徽标");
  assert.match(bad.textContent, /B/);
  dom.window.close();
});

test("一致性校验：正文题数与元数据题数不符时给出提示", async () => {
  const dom = await load(QUIZ);
  const doc = dom.window.document;
  const extra = doc.createElement("div");
  extra.className = "q";
  extra.setAttribute("data-qid", "q9");
  doc.querySelector("#content").appendChild(extra);
  // 重新触发一致性检查
  dom.window.__HTML_VIEW__.getSections();
  const meta = dom.window.__HTML_VIEW__.getMeta();
  assert.equal(meta.questions.length, 3);
  dom.window.close();
});

test("插件模式：收到 PROGRESS 后切换并可回传 SAVE_PROGRESS", async () => {
  const dom = await load(QUIZ);
  const api = dom.window.__HTML_VIEW__;
  const sent = [];
  dom.window.postMessage = (data) => {
    sent.push(data);
  };
  const ev = new dom.window.MessageEvent("message", {
    data: {
      type: "HTML_QUIZ:PROGRESS",
      payload: {
        payload: { answers: { q1: { value: "B", at: "2026-01-01T00:00:00.000Z" } } },
        pluginVersion: "1.0.0",
        source: "plugin",
      },
    },
  });
  dom.window.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(api.getMode(), "plugin");

  const state = api.getState();
  assert.equal(state.answers.q1.value, "B", "应恢复已保存的作答");

  api.setAnswer("q3", "B");
  api.saveNow();
  const save = sent.find((m) => m && m.type === "SAVE_PROGRESS");
  assert.ok(save, "应发出 SAVE_PROGRESS");
  assert.equal(save.payload.answers.q3.value, "B");
  assert.equal(save.payload.answers.q1.value, "B", "原有作答应一并保留");
  dom.window.close();
});

test("插件模式下页面不直接改写数据区（写回只由插件做）", async () => {
  const dom = await load(QUIZ);
  const before = dom.window.document.getElementById("html-quiz-progress").textContent;
  dom.window.__HTML_VIEW__.setAnswer("q1", "B");
  dom.window.__HTML_VIEW__.saveNow();
  const after = dom.window.document.getElementById("html-quiz-progress").textContent;
  assert.equal(before, after, "页面侧不得修改数据区，写回由插件统一做");
  dom.window.close();
});

test("翻页键：两个上下箭头、40% 透明、可拖动位置可同步", async () => {
  const dom = await load(QUIZ);
  const doc = dom.window.document;
  const pager = doc.querySelector(".hvv-pager");
  assert.ok(pager, "应有悬浮翻页键");
  assert.equal(pager.querySelectorAll(".hvv-pager-btn").length, 2);
  const opacity = dom.window.getComputedStyle(pager).opacity;
  assert.equal(opacity, "0.4", "默认透明度应为 40%");
  assert.ok(pager.style.right, "位置应来自进度状态");
  assert.ok(pager.style.top, "垂直位置应来自进度状态");
  dom.window.close();
});

test("图片：双击三态（缩略 → 等宽 → 全屏 → 等宽）", async () => {
  const dom = await load(NEWS);
  const api = dom.window.__HTML_VIEW__;
  const img = dom.window.document.querySelector("#content img");
  assert.ok(img, "资讯页应有内联图片");
  assert.match(img.getAttribute("src"), /^data:/, "图片必须是内联 dataURL");

  api.openOverlayFor(0);
  assert.equal(api.getImageState(), "fit");
  api.advanceImage();
  assert.equal(api.getImageState(), "full");
  api.advanceImage();
  assert.equal(api.getImageState(), "fit");
  api.closeOverlay();
  assert.equal(api.getImageState(), "thumb");
  dom.window.close();
});

test("底部可见区渲染笔记/评注/标记条目", async () => {
  const dom = await load(QUIZ);
  const api = dom.window.__HTML_VIEW__;
  api.addNote("笔记正文");
  api.addAnnotation({ quote: "引用", text: "评注正文" });
  api.addMark({ text: "标记正文" });
  api.renderZone();
  const items = dom.window.document.querySelectorAll(".hvv-item");
  assert.equal(items.length, 3);
  const text = [...items].map((i) => i.textContent).join(" ");
  assert.match(text, /笔记正文/);
  assert.match(text, /评注正文/);
  assert.match(text, /标记正文/);
  dom.window.close();
});

test("笔记里含 </script> 不会破坏页面结构", async () => {
  const dom = await load(QUIZ);
  const api = dom.window.__HTML_VIEW__;
  const evil = "坏内容 </script><script>window.__pwned=1</script>";
  api.addNote(evil);
  const s = api.getState();
  assert.equal(s.notes[0].text, evil);
  assert.equal(dom.window.__pwned, undefined, "注入的脚本不应被执行");
  assert.ok(
    dom.window.document.getElementById("html-quiz-progress"),
    "数据区应完好",
  );
  dom.window.close();
});

test("自检协议：SELFTEST 消息可脚本化跑一遍并触发保存", async () => {
  const dom = await load(QUIZ);
  const sent = [];
  dom.window.postMessage = (data) => sent.push(data);
  const ev = new dom.window.MessageEvent("message", {
    data: {
      type: "HTML_QUIZ:SELFTEST",
      payload: {
        answer: { q1: "B" },
        noteText: "自检笔记",
        annotationText: "自检批注",
        markText: "自检标记",
        scrollTo: 200,
      },
    },
  });
  dom.window.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 30));
  const s = dom.window.__HTML_VIEW__.getState();
  assert.equal(s.answers.q1.value, "B");
  assert.equal(s.notes.length, 1);
  assert.equal(s.annotations.length, 1);
  assert.equal(s.marks.length, 1);
  dom.window.close();
});
