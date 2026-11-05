import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROGRESS_BLOCK_ID,
  escapeJsonForScript,
  serializeProgress,
  extractProgress,
  buildProgressBlock,
  applyProgress,
  countProgressBlocks,
  extractContentMeta,
} from "../plugin/src/progress-codec.ts";

const BLOCK = `<script id="${PROGRESS_BLOCK_ID}" type="application/json">`;

function fileWithBlock(json) {
  return `<!DOCTYPE html><html><body><p>hi</p>\n${BLOCK}\n${json}\n</script>\n</body></html>`;
}

test("extractProgress: 命中并解析", () => {
  const text = fileWithBlock('{"currentQuestion":3,"answers":{"q1":"B"}}');
  const r = extractProgress(text);
  assert.equal(r.found, true);
  assert.equal(r.data.currentQuestion, 3);
  assert.equal(r.data.answers.q1, "B");
  assert.equal(r.error, undefined);
});

test("extractProgress: 没有数据区 → found=false", () => {
  const r = extractProgress("<html><body>nothing</body></html>");
  assert.equal(r.found, false);
  assert.equal(r.data, null);
});

test("extractProgress: JSON 非法 → found=true 且带 error，不抛异常", () => {
  const r = extractProgress(fileWithBlock("{not json"));
  assert.equal(r.found, true);
  assert.equal(r.data, null);
  assert.ok(r.error && r.error.length > 0);
});

test("escapeJsonForScript: </script 必须被转义", () => {
  const out = escapeJsonForScript('{"t":"</script><script>alert(1)</script>"}');
  assert.ok(!out.includes("</script"), "输出里不能出现裸的 </script");
  assert.ok(out.includes("<\\/script"));
});

test("escapeJsonForScript: <script 必须被转义", () => {
  const out = escapeJsonForScript('{"t":"<script>x</script>"}');
  assert.ok(!/<script/i.test(out), "输出里不能出现裸的 <script");
});

test("escapeJsonForScript: <!-- 必须被转义", () => {
  const out = escapeJsonForScript('{"t":"<!--"}');
  assert.ok(!out.includes("<!--"));
});

test("serializeProgress: 危险字符往返后完全还原", () => {
  const payload = {
    a: "</script>",
    b: "<script>alert(1)</script>",
    c: "<!-- tricky -->",
    d: "带反斜杠 \\ 的路径 C:\\temp\\x",
    e: "混合 </ 和 < 的文本",
    f: ["</script>", "普通"],
  };
  const text = serializeProgress(payload);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, payload, "转义后 JSON.parse 必须完全还原原始数据");
  assert.ok(!/<\/(script)/i.test(text));
  assert.ok(!/<script/i.test(text));
  assert.ok(!text.includes("<!--"));
});

test("serializeProgress: 2 空格缩进", () => {
  const text = serializeProgress({ a: 1 });
  assert.ok(text.includes('\n  "a": 1'), "应为 2 空格缩进");
});

test("applyProgress: 原地替换，其余字节逐字不变", () => {
  const before = fileWithBlock("{}");
  const { text, action } = applyProgress(before, { currentQuestion: 7 });
  assert.equal(action, "replaced");
  assert.ok(text.includes('"currentQuestion": 7'));
  // 除数据区外逐字比对
  const strip = (s) => s.replace(/<script\b[^>]*\bid=["']html-quiz-progress["'][^>]*>[\s\S]*?<\/script\s*>/i, "§BLOCK§");
  assert.equal(strip(text), strip(before));
});

test("applyProgress: 保留开标签原有属性", () => {
  const before = `<script id="html-quiz-progress" type="application/json" data-x="1">{}</script>`;
  const { text } = applyProgress(before, { a: 1 });
  assert.ok(text.includes('id="html-quiz-progress"'));
  assert.ok(text.includes('data-x="1"'));
});

test("applyProgress: 缺数据区时插到最后一个 </body> 之前", () => {
  const before = "<html><body><p>a</p></body></html>";
  const { text, action } = applyProgress(before, { a: 1 });
  assert.equal(action, "inserted");
  assert.ok(text.indexOf("html-quiz-progress") > text.indexOf("<p>a</p>"));
  assert.ok(text.indexOf("html-quiz-progress") < text.lastIndexOf("</body>"));
});

test("applyProgress: 无 </body> 时追加到末尾", () => {
  const before = "<html><p>a</p>";
  const { text, action } = applyProgress(before, { a: 1 });
  assert.equal(action, "appended");
  assert.ok(text.trimEnd().endsWith("</script>"));
});

test("applyProgress: 幂等——同 payload 连续两次结果逐字节相同", () => {
  const before = fileWithBlock("{}");
  const p = { currentQuestion: 3, answers: { q1: "B" }, notes: [] };
  const t1 = applyProgress(before, p).text;
  const t2 = applyProgress(t1, p).text;
  assert.equal(t1, t2);
});

test("applyProgress: 多个同 id 数据区只替换第一个", () => {
  const before =
    `<script id="html-quiz-progress" type="application/json">{"x":1}</script>` +
    `<p>mid</p>` +
    `<script id="html-quiz-progress" type="application/json">{"x":2}</script>`;
  const { text } = applyProgress(before, { x: 99 });
  assert.ok(text.includes('"x": 99'));
  assert.ok(text.includes('{"x":2}'), "第二个数据区必须原样保留");
  assert.equal(countProgressBlocks(text), 2);
});

test("buildProgressBlock: 生成可被再次解析的区块", () => {
  const block = buildProgressBlock({ a: 1 });
  const r = extractProgress(`<html><body>${block}</body></html>`);
  assert.equal(r.found, true);
  assert.equal(r.data.a, 1);
});

test("countProgressBlocks: 计数正确", () => {
  assert.equal(countProgressBlocks("<html></html>"), 0);
  assert.equal(countProgressBlocks(fileWithBlock("{}")), 1);
});

test("注释里提到数据区标签时，必须忽略注释、只认真正的数据区", () => {
  const text = `<!DOCTYPE html><html><head>
<!-- AI 提取说明：数据位于 <script id="html-quiz-progress" type="application/json"> 区块 -->
<title>t</title></head><body><p>正文</p>
<script id="html-quiz-progress" type="application/json">
{"currentQuestion":9}
</script>
</body></html>`;
  const r = extractProgress(text);
  assert.equal(r.found, true);
  assert.equal(r.data.currentQuestion, 9, "必须取到真正的数据区，而不是注释里的字面量");
  assert.equal(countProgressBlocks(text), 1, "注释里的字面量不计入块数");
});

test("applyProgress: 注释里的字面量不被替换，正文与注释都完好", () => {
  const text = `<!DOCTYPE html><html><head>
<!-- 位于 <script id="html-quiz-progress" type="application/json"> 区块 -->
</head><body><p>正文不能丢</p>
<script id="html-quiz-progress" type="application/json">
{"currentQuestion":1}
</script>
</body></html>`;
  const { text: out, action } = applyProgress(text, { currentQuestion: 5 });
  assert.equal(action, "replaced");
  assert.ok(out.includes("正文不能丢"), "正文必须完好");
  assert.ok(out.includes("位于"), "注释必须完好");
  assert.ok(out.includes('"currentQuestion": 5'), "真实数据区应被更新");
  assert.equal(extractProgress(out).data.currentQuestion, 5);
});

test("extractContentMeta: 同样忽略注释里的字面量", () => {
  const text = `<html><head>
<!-- 题目在 <script id="html-content-meta" type="application/json"> 内 -->
</head><body>
<script id="html-content-meta" type="application/json">{"title":"真标题"}</script>
</body></html>`;
  const r = extractContentMeta(text);
  assert.equal(r.found, true);
  assert.equal(r.data.title, "真标题");
});

test("extractContentMeta: 读出题库与章节结构", () => {
  const text = `<html><body>
<script id="html-content-meta" type="application/json">
{"title":"T","questions":[{"id":"q1","answer":"B"}],"sections":[{"id":"s1","title":"第一章"}]}
</script>
</body></html>`;
  const r = extractContentMeta(text);
  assert.equal(r.found, true);
  assert.equal(r.data.title, "T");
  assert.equal(r.data.questions[0].answer, "B");
  assert.equal(r.data.sections[0].id, "s1");
});

test("extractContentMeta: 没有该块 → found=false；非法 JSON → 带 error", () => {
  assert.equal(extractContentMeta("<html></html>").found, false);
  const bad = extractContentMeta(
    '<script id="html-content-meta" type="application/json">{oops</script>',
  );
  assert.equal(bad.found, true);
  assert.equal(bad.data, null);
  assert.ok(bad.error);
});
