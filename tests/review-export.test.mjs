import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReviewMarkdown } from "../plugin/src/review-export.ts";

const progress = {
  meta: { updatedAt: "2026-11-04T11:00:00.000Z" },
  answers: {
    q1: { value: "B", at: "2026-11-04T10:00:00.000Z", why: "我选了B因为…", wrongReason: "概念混淆" },
    q2: { value: ["A", "C"], at: "2026-11-04T10:01:00.000Z" },
  },
  notes: [{ id: "n1", text: "未分类灵感：量子计算可能相关", at: "2026-11-04T10:02:00.000Z" }],
  annotations: [
    { id: "a1", text: "这句没看懂", quote: "核心是熵增", at: "2026-11-04T10:03:00.000Z", doubt: true },
    { id: "a2", text: "重要", quote: "另一段", at: "2026-11-04T10:04:00.000Z", doubt: false },
  ],
  marks: [{ id: "m1", text: "回头看", y: 1280, quote: "最近段落", at: "2026-11-04T10:05:00.000Z", doubt: false }],
  sectionProgress: { s1: { title: "第一章", read: true, percent: 100 }, s2: { title: "第二章", read: false, percent: 40 } },
  scrollPercent: 55,
  readDone: false,
};

const meta = {
  title: "AI 行业观察",
  questions: [
    { id: "q1", stem: "第一题题干很长", options: ["A. 甲", "B. 乙"], answer: "A", explain: "解析" },
    { id: "q2", stem: "第二题题干", options: ["A. 甲", "B. 乙", "C. 丙"], answer: "B" },
    { id: "q3", stem: "第三题没答", options: ["A. 甲"], answer: "A" },
  ],
  sections: [{ id: "s1", title: "第一章" }, { id: "s2", title: "第二章" }],
};

test("buildReviewMarkdown: 基本结构", () => {
  const md = buildReviewMarkdown(progress, meta, { now: "2026-11-04 23:30", sourceName: "note.html" });
  assert.ok(md.startsWith("# 复习清单"));
  assert.ok(md.includes("AI 行业观察"));
  assert.ok(md.includes("note.html"));
  assert.ok(md.includes("## 概览"));
});

test("buildReviewMarkdown: 错题带正确答案、我的答案、思路、原因", () => {
  const md = buildReviewMarkdown(progress, meta, {});
  assert.ok(md.includes("需要复盘的错题"));
  assert.ok(md.includes("正确答案"), "要显示标准答案");
  assert.ok(md.includes("我选了B因为"), "要显示我的思路");
  assert.ok(md.includes("概念混淆"), "要显示选错原因");
});

test("buildReviewMarkdown: 未作答题目进待复盘", () => {
  const md = buildReviewMarkdown(progress, meta, {});
  assert.ok(md.includes("q3") || md.includes("第三题"), "未作答的题也要列出来");
});

test("buildReviewMarkdown: 存疑标注单独成节", () => {
  const md = buildReviewMarkdown(progress, meta, {});
  assert.ok(md.includes("阅读疑问") || md.includes("存疑"));
  assert.ok(md.includes("这句没看懂"));
});

test("buildReviewMarkdown: 笔记列出", () => {
  const md = buildReviewMarkdown(progress, meta, {});
  assert.ok(md.includes("我的笔记"));
  assert.ok(md.includes("量子计算可能相关"));
});

test("buildReviewMarkdown: 章节进度进概览", () => {
  const md = buildReviewMarkdown(progress, meta, {});
  assert.ok(md.includes("1/2"), "应显示 1/2 章读完");
});

test("buildReviewMarkdown: 无 meta 时不崩", () => {
  const md = buildReviewMarkdown({}, {}, {});
  assert.ok(typeof md === "string" && md.length > 0);
});

test("buildReviewMarkdown: 墓碑条目不出现", () => {
  const withTomb = {
    ...progress,
    notes: [{ id: "n1", text: "已删", deleted: true }, { id: "n2", text: "留下的" }],
  };
  const md = buildReviewMarkdown(withTomb, meta, {});
  assert.ok(!md.includes("已删"));
  assert.ok(md.includes("留下的"));
});
