/**
 * 跨设备合并契约（D09/D10/D11）。
 *
 * 纯模块：不 import obsidian，可直接被 Node 单测引用。
 *
 * 裁决规则：
 *  - answers        按题号合并，同题比 `at`，缺 `at` 视为更旧
 *  - notes/annotations/marks/strokes  按 `id` 合并，同 id 比 `at`
 *  - 墓碑 `deleted:true` 是终态：任一侧为墓碑，结果即墓碑
 *  - sectionProgress 按 sid 合并，`read:true` 优先于 `read:false`
 *  - 标量字段（scrollY 等）取 meta.updatedAt 较新的一方
 */

import { isPlainObject } from "./protocol.ts";

export type Block = Record<string, unknown>;

export interface MergeResult {
  merged: Block;
  /** 冲突时最终采用了磁盘值的字段路径 */
  keptFromDisk: string[];
  /** 是否存在过冲突 */
  conflicted: boolean;
}

export function isTombstone(entry: unknown): boolean {
  return isPlainObject(entry) && entry.deleted === true;
}

function idOf(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null;
  const id = entry.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function timeOf(entry: unknown): number {
  if (!isPlainObject(entry)) return 0;
  const at = entry.at;
  if (typeof at !== "string") return 0;
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

function metaTime(block: Block): number {
  const meta = block.meta;
  if (!isPlainObject(meta)) return 0;
  const at = meta.updatedAt;
  if (typeof at !== "string") return 0;
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

interface Picked {
  v: unknown;
  from: "disk" | "incoming";
}

function pick(diskEntry: unknown, incomingEntry: unknown, diskNewer: boolean): Picked {
  const diskTomb = isTombstone(diskEntry);
  const incTomb = isTombstone(incomingEntry);
  if (diskTomb || incTomb) {
    if (diskTomb && incTomb) {
      return timeOf(incomingEntry) >= timeOf(diskEntry)
        ? { v: incomingEntry, from: "incoming" }
        : { v: diskEntry, from: "disk" };
    }
    return diskTomb
      ? { v: diskEntry, from: "disk" }
      : { v: incomingEntry, from: "incoming" };
  }
  const dt = timeOf(diskEntry);
  const it = timeOf(incomingEntry);
  if (it > dt) return { v: incomingEntry, from: "incoming" };
  if (dt > it) return { v: diskEntry, from: "disk" };
  return diskNewer
    ? { v: diskEntry, from: "disk" }
    : { v: incomingEntry, from: "incoming" };
}

function mergeIdArray(
  diskArr: unknown[],
  incArr: unknown[],
  label: string,
  keptFromDisk: string[],
  diskNewer: boolean,
): unknown[] {
  const out: unknown[] = [];
  const index = new Map<string, number>();

  for (const entry of diskArr) {
    out.push(entry);
    const id = idOf(entry);
    if (id !== null) index.set(id, out.length - 1);
  }

  for (const entry of incArr) {
    const id = idOf(entry);
    if (id !== null && index.has(id)) {
      const i = index.get(id) as number;
      const picked = pick(out[i], entry, diskNewer);
      out[i] = picked.v;
      if (picked.from === "disk") keptFromDisk.push(`${label}.${id}`);
    } else {
      out.push(entry);
      if (id !== null) index.set(id, out.length - 1);
    }
  }

  return out;
}

export function mergeProgress(disk: Block, incoming: Block): MergeResult {
  const keptFromDisk: string[] = [];
  const diskNewer = metaTime(disk) > metaTime(incoming);
  const merged: Block = { ...incoming };

  // meta：以较新的一方为准
  const metaSrc = diskNewer ? disk.meta : incoming.meta;
  merged.meta = isPlainObject(metaSrc) ? { ...metaSrc } : {};

  // answers：按题号
  const diskAnswers = isPlainObject(disk.answers) ? disk.answers : {};
  const incAnswers = isPlainObject(incoming.answers) ? incoming.answers : {};
  if (Object.keys(diskAnswers).length > 0 || Object.keys(incAnswers).length > 0) {
    const out: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(diskAnswers), ...Object.keys(incAnswers)]);
    for (const key of keys) {
      const hasDisk = key in diskAnswers;
      const hasInc = key in incAnswers;
      if (!hasInc) {
        out[key] = diskAnswers[key];
        continue;
      }
      if (!hasDisk) {
        out[key] = incAnswers[key];
        continue;
      }
      const picked = pick(diskAnswers[key], incAnswers[key], diskNewer);
      out[key] = picked.v;
      if (picked.from === "disk") keptFromDisk.push(`answers.${key}`);
    }
    merged.answers = out;
  }

  // 四个条目数组：按 id（notes/annotations/marks/strokes）
  for (const key of ["notes", "annotations", "marks", "strokes"] as const) {
    const diskArr = Array.isArray(disk[key]) ? (disk[key] as unknown[]) : [];
    const incArr = Array.isArray(incoming[key]) ? (incoming[key] as unknown[]) : [];
    if (diskArr.length > 0 || incArr.length > 0) {
      merged[key] = mergeIdArray(diskArr, incArr, key, keptFromDisk, diskNewer);
    }
  }

  // sectionProgress：按 sid，read:true 优先
  const diskSp = isPlainObject(disk.sectionProgress) ? disk.sectionProgress : {};
  const incSp = isPlainObject(incoming.sectionProgress) ? incoming.sectionProgress : {};
  if (Object.keys(diskSp).length > 0 || Object.keys(incSp).length > 0) {
    const out: Record<string, unknown> = {};
    const sids = new Set([...Object.keys(diskSp), ...Object.keys(incSp)]);
    for (const sid of sids) {
      const hasDisk = sid in diskSp;
      const hasInc = sid in incSp;
      if (!hasInc) {
        out[sid] = diskSp[sid];
        continue;
      }
      if (!hasDisk) {
        out[sid] = incSp[sid];
        continue;
      }
      const dRead = isPlainObject(diskSp[sid]) && diskSp[sid].read === true;
      const iRead = isPlainObject(incSp[sid]) && incSp[sid].read === true;
      if (dRead !== iRead) {
        out[sid] = dRead ? diskSp[sid] : incSp[sid];
        continue;
      }
      out[sid] = pick(diskSp[sid], incSp[sid], diskNewer).v;
    }
    merged.sectionProgress = out;
  }

  // 标量字段：last-write-wins
  for (const key of [
    "scrollY",
    "scrollPercent",
    "currentQuestion",
    "readDone",
    "ui",
  ] as const) {
    const hasDisk = key in disk;
    const hasInc = key in incoming;
    if (!hasInc) {
      if (hasDisk) merged[key] = disk[key];
      continue;
    }
    if (!hasDisk) continue;
    if (diskNewer) {
      merged[key] = disk[key];
      keptFromDisk.push(key);
    }
  }

  return {
    merged,
    keptFromDisk,
    conflicted: keptFromDisk.length > 0,
  };
}

/** 清除墓碑条目（本地整理动作） */
export function stripTombstones(block: Block): Block {
  const out: Block = { ...block };
  for (const key of ["notes", "annotations", "marks", "strokes"] as const) {
    const arr = out[key];
    if (Array.isArray(arr)) {
      out[key] = arr.filter((e) => !isTombstone(e));
    }
  }
  return out;
}
