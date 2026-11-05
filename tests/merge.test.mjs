import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeProgress,
  isTombstone,
  stripTombstones,
} from "../plugin/src/merge.ts";

const at = (t) => new Date(t).toISOString();

test("mergeProgress: answers 按题合并，同题取 at 新者", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-04T10:00:00Z"), updatedBy: "disk" },
    answers: { q1: { value: "A", at: at("2026-11-04T10:00:00Z") }, q2: { value: "C", at: at("2026-11-04T09:00:00Z") } },
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-04T11:00:00Z"), updatedBy: "phone" },
    answers: { q1: { value: "B", at: at("2026-11-04T11:00:00Z") }, q3: { value: "D", at: at("2026-11-04T11:00:00Z") } },
  };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.answers.q1.value, "B", "q1 取更新的 incoming");
  assert.equal(merged.answers.q2.value, "C", "q2 只有磁盘有，保留");
  assert.equal(merged.answers.q3.value, "D", "q3 只有 incoming 有，保留");
});

test("mergeProgress: 缺失 at 的一方视为更旧", () => {
  const disk = { meta: { updatedAt: at("2026-11-04T10:00:00Z") }, answers: { q1: { value: "A" } } };
  const incoming = { meta: { updatedAt: at("2026-11-04T11:00:00Z") }, answers: { q1: { value: "B", at: at("2026-11-04T11:00:00Z") } } };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.answers.q1.value, "B");
});

test("mergeProgress: 磁盘侧无 at 而 incoming 也无 at → 以 updatedAt 新的一方为准", () => {
  const disk = { meta: { updatedAt: at("2026-11-04T10:00:00Z") }, answers: { q1: { value: "A" } } };
  const incoming = { meta: { updatedAt: at("2026-11-04T11:00:00Z") }, answers: { q1: { value: "B" } } };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.answers.q1.value, "B");
});

test("mergeProgress: 三个数组按 id 合并", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-04T10:00:00Z") },
    notes: [{ id: "n1", text: "旧笔记", at: at("2026-11-04T10:00:00Z") }],
    annotations: [{ id: "a1", text: "旧评注", at: at("2026-11-04T10:00:00Z") }],
    marks: [{ id: "m1", text: "旧标记", at: at("2026-11-04T10:00:00Z") }],
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-04T11:00:00Z") },
    notes: [{ id: "n2", text: "新笔记", at: at("2026-11-04T11:00:00Z") }],
    annotations: [{ id: "a1", text: "新评注", at: at("2026-11-04T11:00:00Z") }],
    marks: [],
  };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.notes.length, 2);
  assert.equal(merged.annotations[0].text, "新评注");
  assert.equal(merged.marks.length, 1);
});

test("mergeProgress: 墓碑是终态——删除胜出", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-04T10:00:00Z") },
    notes: [{ id: "n1", text: "还在", at: at("2026-11-04T10:00:00Z") }],
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-04T11:00:00Z") },
    notes: [{ id: "n1", deleted: true, at: at("2026-11-04T11:00:00Z") }],
  };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.notes.length, 1);
  assert.equal(isTombstone(merged.notes[0]), true);
  const cleaned = stripTombstones(merged);
  assert.equal(cleaned.notes.length, 0);
});

test("mergeProgress: 墓碑 vs 更新的存活项——删除仍是终态", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-04T10:00:00Z") },
    notes: [{ id: "n1", deleted: true, at: at("2026-11-04T10:00:00Z") }],
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-04T11:00:00Z") },
    notes: [{ id: "n1", text: "又写回来了", at: at("2026-11-04T11:00:00Z") }],
  };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(isTombstone(merged.notes[0]), true, "删除是终态，不因另一端后写而复活");
});

test("mergeProgress: sectionProgress 逐 sid 合并，read:true 优先", () => {
  const disk = {
    meta: { updatedAt: at("2026-11-04T10:00:00Z") },
    sectionProgress: { s1: { read: true, percent: 100, at: at("2026-11-04T10:00:00Z") } },
  };
  const incoming = {
    meta: { updatedAt: at("2026-11-04T11:00:00Z") },
    sectionProgress: { s1: { read: false, percent: 20, at: at("2026-11-04T11:00:00Z") }, s2: { read: true, percent: 100 } },
  };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.sectionProgress.s1.read, true, "读过不因另一端旧数据回退");
  assert.equal(merged.sectionProgress.s2.read, true);
});

test("mergeProgress: 标量字段按 meta.updatedAt 新的一方为准", () => {
  const disk = { meta: { updatedAt: at("2026-11-04T10:00:00Z") }, scrollY: 100, readDone: false };
  const incoming = { meta: { updatedAt: at("2026-11-04T11:00:00Z") }, scrollY: 900, readDone: true };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal(merged.scrollY, 900);
  assert.equal(merged.readDone, true);
});

test("mergeProgress: 磁盘侧更新时保留磁盘值并记录 keptFromDisk", () => {
  const disk = { meta: { updatedAt: at("2026-11-04T12:00:00Z") }, scrollY: 100 };
  const incoming = { meta: { updatedAt: at("2026-11-04T11:00:00Z") }, scrollY: 900 };
  const { merged, keptFromDisk } = mergeProgress(disk, incoming);
  assert.equal(merged.scrollY, 100);
  assert.ok(Array.isArray(keptFromDisk));
  assert.ok(keptFromDisk.includes("scrollY"));
});

test("mergeProgress: 两侧都没有某字段时不凭空造出", () => {
  const disk = { meta: { updatedAt: at("2026-11-04T10:00:00Z") } };
  const incoming = { meta: { updatedAt: at("2026-11-04T11:00:00Z") } };
  const { merged } = mergeProgress(disk, incoming);
  assert.equal("answers" in merged, false);
  assert.equal("notes" in merged, false);
});

test("stripTombstones: 三个数组都清理", () => {
  const block = {
    notes: [{ id: "n1", deleted: true }],
    annotations: [{ id: "a1", text: "保留" }],
    marks: [{ id: "m1", deleted: true }],
  };
  const cleaned = stripTombstones(block);
  assert.equal(cleaned.notes.length, 0);
  assert.equal(cleaned.annotations.length, 1);
  assert.equal(cleaned.marks.length, 0);
});
