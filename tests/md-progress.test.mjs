import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MD_PROGRESS_KEY,
  MD_PROGRESS_SCHEMA,
  extractMdProgress,
  buildMdFrontmatter,
  mergeMdProgress,
  cleanMdTombstones,
  isMdProgressData,
  hasMdProgressKey,
} from "../plugin/src/md-progress.ts";

const at = (t) => new Date(t).toISOString();

// ---------------------------------------------------------------- 提取

test("extractMdProgress: 没有 frontmatter → 未找到", () => {
  assert.deepEqual(extractMdProgress(undefined), { found: false, data: null });
  assert.deepEqual(extractMdProgress(null), { found: false, data: null });
  assert.deepEqual(extractMdProgress("不是对象"), { found: false, data: null });
  assert.deepEqual(extractMdProgress([]), { found: false, data: null });
});

test("extractMdProgress: frontmatter 里没有 hvv → 未找到", () => {
  const r = extractMdProgress({ title: "我的笔记", tags: ["a"] });
  assert.equal(r.found, false);
  assert.equal(r.data, null);
});

test("extractMdProgress: 取出 hvv 对象", () => {
  const data = { schema: MD_PROGRESS_SCHEMA, meta: { updatedAt: at("2026-11-05T10:00:00Z") } };
  const r = extractMdProgress({ title: "x", hvv: data });
  assert.equal(r.found, true);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.data, data);
});

test("extractMdProgress: hvv 是字符串 JSON 时也能解开", () => {
  const data = { schema: MD_PROGRESS_SCHEMA, notes: [] };
  const r = extractMdProgress({ hvv: JSON.stringify(data) });
  assert.equal(r.found, true);
  assert.deepEqual(r.data, data);
});

test("extractMdProgress: hvv 是坏 JSON → 报错但不给数据", () => {
  const r = extractMdProgress({ hvv: "{不是 JSON" });
  assert.equal(r.found, true);
  assert.equal(r.data, null);
  assert.ok(r.error, "应给出错误原因");
});

test("extractMdProgress: hvv 是数字 / 数组 → 报错但不给数据", () => {
  const n = extractMdProgress({ hvv: 123 });
  assert.equal(n.found, true);
  assert.equal(n.data, null);
  assert.ok(n.error);

  const a = extractMdProgress({ hvv: [1, 2] });
  assert.equal(a.found, true);
  assert.equal(a.data, null);
  assert.ok(a.error);
});

test("extractMdProgress: hvv 是空值 → 报错", () => {
  const n = extractMdProgress({ hvv: null });
  assert.equal(n.found, true);
  assert.equal(n.data, null);
  assert.ok(n.error);

  const s = extractMdProgress({ hvv: "   " });
  assert.equal(s.found, true);
  assert.equal(s.data, null);
  assert.ok(s.error);
});

// ---------------------------------------------------------------- 写回

test("buildMdFrontmatter: 只动 hvv，其他字段原样保留", () => {
  const fm = { title: "我的笔记", tags: ["x"], aliases: ["别名"] };
  const payload = { schema: MD_PROGRESS_SCHEMA, notes: [] };
  const out = buildMdFrontmatter(fm, payload);
  assert.equal(out.title, "我的笔记");
  assert.deepEqual(out.tags, ["x"]);
  assert.deepEqual(out.aliases, ["别名"]);
  assert.deepEqual(out[MD_PROGRESS_KEY], payload);
});

test("buildMdFrontmatter: 不修改传入的原对象", () => {
  const fm = { title: "a" };
  const out = buildMdFrontmatter(fm, { notes: [] });
  assert.equal(MD_PROGRESS_KEY in fm, false, "原 frontmatter 不能被就地写入");
  assert.notEqual(out, fm, "应返回新对象");
});

test("buildMdFrontmatter: 原来没有 frontmatter 也能造出来", () => {
  const out = buildMdFrontmatter(undefined, { notes: [] });
  assert.equal(MD_PROGRESS_KEY in out, true);
});

// ---------------------------------------------------------------- 合并

test("mergeMdProgress: 与 HTML 版同一套裁决规则", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-05T10:00:00Z") },
    answers: { q1: { value: "A", at: at("2026-11-05T10:00:00Z") } },
    notes: [{ id: "n1", text: "旧", at: at("2026-11-05T10:00:00Z") }],
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-05T11:00:00Z") },
    answers: { q1: { value: "B", at: at("2026-11-05T11:00:00Z") } },
    notes: [{ id: "n1", text: "新", at: at("2026-11-05T11:00:00Z") }],
  };
  const { merged, conflicted } = mergeMdProgress(disk, incoming);
  assert.equal(merged.answers.q1.value, "B");
  assert.equal(merged.notes[0].text, "新");
  assert.equal(conflicted, false);
});

test("mergeMdProgress: 墓碑是终态（删除能跨设备生效）", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-05T10:00:00Z") },
    notes: [{ id: "n1", deleted: true, at: at("2026-11-05T10:00:00Z") }],
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-05T11:00:00Z") },
    notes: [{ id: "n1", text: "还没删", at: at("2026-11-05T09:00:00Z") }],
  };
  const { merged } = mergeMdProgress(disk, incoming);
  assert.equal(merged.notes[0].deleted, true, "磁盘上是墓碑，删除应当胜出");
});

test("mergeMdProgress: 磁盘更新时保留磁盘值并记 keptFromDisk", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-05T12:00:00Z") },
    answers: { q1: { value: "C", at: at("2026-11-05T12:00:00Z") } },
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-05T11:00:00Z") },
    answers: { q1: { value: "A", at: at("2026-11-05T11:00:00Z") } },
  };
  const { merged, keptFromDisk } = mergeMdProgress(disk, incoming);
  assert.equal(merged.answers.q1.value, "C");
  assert.deepEqual(keptFromDisk, ["answers.q1"]);
});

test("cleanMdTombstones: 清掉已删除条目", () => {
  const out = cleanMdTombstones({
    notes: [{ id: "n1", text: "留着" }, { id: "n2", deleted: true }],
    annotations: [],
  });
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].id, "n1");
});

// ---------------------------------------------------------------- 形状自检

test("isMdProgressData: 正常数据通过", () => {
  assert.equal(
    isMdProgressData({
      schema: MD_PROGRESS_SCHEMA,
      meta: { updatedAt: "x" },
      answers: {},
      notes: [],
      annotations: [],
      marks: [],
      strokes: [],
      sectionProgress: {},
    }),
    true,
  );
});

test("isMdProgressData: schema 不对 → 不认", () => {
  assert.equal(isMdProgressData({ schema: "别的东西" }), false);
});

test("isMdProgressData: 字段形状不对 → 不认（防止覆盖用户手写的内容）", () => {
  assert.equal(isMdProgressData({ notes: "不是数组" }), false);
  assert.equal(isMdProgressData({ answers: [] }), false);
  assert.equal(isMdProgressData({ sectionProgress: "x" }), false);
  assert.equal(isMdProgressData({ meta: [] }), false);
  assert.equal(isMdProgressData("不是对象"), false);
  assert.equal(isMdProgressData(null), false);
});

test("hasMdProgressKey: 判断 frontmatter 里有没有 hvv", () => {
  assert.equal(hasMdProgressKey({ hvv: {} }), true);
  assert.equal(hasMdProgressKey({ title: "x" }), false);
  assert.equal(hasMdProgressKey(undefined), false);
});

// ---------------------------------------------------------------- 往返

test("往返：取出 → 合并 → 写回 → 再取出，数据不丢", () => {
  const original = {
    schema: MD_PROGRESS_SCHEMA,
    meta: { updatedAt: at("2026-11-05T10:00:00Z"), updatedBy: "pc" },
    answers: { q1: { value: "B", at: at("2026-11-05T10:00:00Z") } },
    notes: [{ id: "n1", text: "记得复习", at: at("2026-11-05T10:00:00Z") }],
    annotations: [{ id: "a1", quote: "这一段", text: "批注", at: at("2026-11-05T10:00:00Z") }],
    marks: [],
    strokes: [],
    sectionProgress: { s1: { read: true, percent: 100 } },
  };
  const fm = { title: "我的笔记", hvv: original };
  const got = extractMdProgress(fm);
  assert.equal(got.found, true);

  // 另一台设备加了一条笔记
  const incoming = {
    meta: { updatedAt: at("2026-11-05T11:00:00Z"), updatedBy: "phone" },
    notes: [{ id: "n2", text: "手机上写的", at: at("2026-11-05T11:00:00Z") }],
  };
  const { merged } = mergeMdProgress(got.data, incoming);
  const fm2 = buildMdFrontmatter(fm, merged);
  const got2 = extractMdProgress(fm2);
  assert.equal(got2.data.notes.length, 2);
  assert.equal(got2.data.answers.q1.value, "B");
  assert.equal(got2.data.sectionProgress.s1.read, true);
  assert.equal(fm2.title, "我的笔记", "其他 frontmatter 字段不能丢");
});
