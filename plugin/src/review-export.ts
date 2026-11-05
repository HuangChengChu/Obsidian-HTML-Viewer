/**
 * 复习清单 Markdown 生成（D29）。
 *
 * 纯模块：不 import obsidian，可直接被 Node 单测引用。
 *
 * 注意：数据区只存原始用户输入，本模块在「读取时」做推导
 * （判分 / 归类），不往文件里写任何派生字段。
 */

import { isPlainObject } from "./protocol.ts";
import { isTombstone } from "./merge.ts";
import type { Block } from "./merge.ts";

export interface ReviewExportOptions {
  /** 生成时间戳 */
  now?: string;
  /** 来源文件名 */
  sourceName?: string;
}

function normalizeValue(v: unknown): string {
  if (Array.isArray(v)) {
    return v
      .map((x) => String(x).trim())
      .sort()
      .join(",");
  }
  return String(v ?? "").trim();
}

function stemOf(q: unknown, fallback: string): string {
  if (isPlainObject(q) && typeof q.stem === "string") return q.stem.trim();
  return fallback;
}

function shortStem(stem: string, max = 40): string {
  const one = stem.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function entryOf(answers: Record<string, unknown>, qid: string): unknown {
  return Object.prototype.hasOwnProperty.call(answers, qid) ? answers[qid] : undefined;
}

export function buildReviewMarkdown(
  progress: Block,
  meta: Block,
  options: ReviewExportOptions = {},
): string {
  const now =
    options.now ?? new Date().toISOString().slice(0, 16).replace("T", " ");
  const sourceName = options.sourceName ?? "未命名.html";

  const title =
    (isPlainObject(meta) && typeof meta.title === "string" && meta.title) || "未命名文档";

  const questions = isPlainObject(meta) && Array.isArray(meta.questions) ? meta.questions : [];
  const sections = isPlainObject(meta) && Array.isArray(meta.sections) ? meta.sections : [];

  const answers = isPlainObject(progress.answers) ? progress.answers : {};

  const notes = (Array.isArray(progress.notes) ? progress.notes : []).filter(
    (e) => !isTombstone(e),
  );
  const annotations = (
    Array.isArray(progress.annotations) ? progress.annotations : []
  ).filter((e) => !isTombstone(e));
  const marks = (Array.isArray(progress.marks) ? progress.marks : []).filter(
    (e) => !isTombstone(e),
  );

  const sectionProgress = isPlainObject(progress.sectionProgress)
    ? progress.sectionProgress
    : {};
  const readCount = Object.keys(sectionProgress).filter(
    (sid) =>
      isPlainObject(sectionProgress[sid]) && sectionProgress[sid].read === true,
  ).length;
  const totalSections =
    sections.length > 0
      ? sections.length
      : Object.keys(sectionProgress).length;

  const wrong: string[] = [];
  const unanswered: string[] = [];
  const doubts: string[] = [];
  let answeredCount = 0;
  let correctCount = 0;

  for (const q of questions) {
    const qid = isPlainObject(q) && typeof q.id === "string" ? q.id : "";
    if (!qid) continue;
    const entry = entryOf(answers, qid);
    const stem = stemOf(q, qid);

    if (entry === undefined) {
      unanswered.push(`### ${qid.toUpperCase()} · ${shortStem(stem)}\n- 状态：未作答`);
      continue;
    }
    answeredCount += 1;

    const raw = isPlainObject(entry) ? entry.value : entry;
    const std = isPlainObject(q) ? q.answer : undefined;
    const ok =
      std !== undefined && normalizeValue(raw) === normalizeValue(std);
    if (ok) correctCount += 1;

    const why = isPlainObject(entry) && typeof entry.why === "string" ? entry.why : "";
    const wrongReason =
      isPlainObject(entry) && typeof entry.wrongReason === "string"
        ? entry.wrongReason
        : "";

    if (!ok) {
      const lines = [
        `### ${qid.toUpperCase()} · ${shortStem(stem)}`,
        `- 我的答案：${normalizeValue(raw) || "（空）"} ｜ 正确答案：${normalizeValue(std) || "（未提供）"}`,
      ];
      if (why) lines.push(`- 我的思路：${why}`);
      if (wrongReason) lines.push(`- 原因：${wrongReason}`);
      wrong.push(lines.join("\n"));
    }

    const flagged =
      isPlainObject(entry) && (entry.doubt === true || entry.unsure === true);
    if (flagged) {
      const lines = [`### ${qid.toUpperCase()} · ${shortStem(stem)}`];
      if (why) lines.push(`- 我的思路：${why}`);
      lines.push("- 状态：标记为存疑");
      doubts.push(lines.join("\n"));
    }
  }

  const readingDoubts = annotations
    .filter((a) => isPlainObject(a) && a.doubt === true)
    .map((a) => {
      const quote = typeof a.quote === "string" ? a.quote : "";
      const text = typeof a.text === "string" ? a.text : "";
      const detail = text || quote || "（无说明）";
      return `- ${detail}${quote && text ? `（原文：${shortStem(quote, 30)}）` : ""}`;
    });

  const otherAnnotations = annotations
    .filter((a) => isPlainObject(a) && a.doubt !== true)
    .map((a) => {
      const quote = typeof a.quote === "string" ? a.quote : "";
      const text = typeof a.text === "string" ? a.text : "";
      return `- ${text || "（无说明）"}${quote ? `（原文：${shortStem(quote, 30)}）` : ""}`;
    });

  const markLines = marks.map((m) => {
    const text = isPlainObject(m) && typeof m.text === "string" ? m.text : "";
    return `- ${text || "（仅位置标记）"}`;
  });

  const noteLines = notes.map((n) => {
    const text = isPlainObject(n) && typeof n.text === "string" ? n.text : "";
    return `- ${text}`;
  });

  const out: string[] = [];
  out.push(`# 复习清单 · ${title}`);
  out.push("");
  out.push(`> 来源：${sourceName} · 生成于 ${now}`);
  out.push("");
  out.push("## 概览");
  out.push(
    `- 题目 ${questions.length} · 已答 ${answeredCount} · 正确 ${correctCount} · 错题 ${wrong.length} · 未答 ${unanswered.length}`,
  );
  out.push(
    `- 阅读 ${readCount}/${totalSections} 章读完 · 评注 ${annotations.length} · 标记 ${marks.length} · 笔记 ${notes.length}`,
  );
  out.push("");

  if (wrong.length > 0) {
    out.push("## 需要复盘的错题");
    out.push("");
    out.push(wrong.join("\n\n"));
    out.push("");
  }

  if (unanswered.length > 0) {
    out.push("## 待复盘");
    out.push("");
    out.push(unanswered.join("\n\n"));
    out.push("");
  }

  if (doubts.length > 0) {
    out.push("## 存疑");
    out.push("");
    out.push(doubts.join("\n\n"));
    out.push("");
  }

  if (readingDoubts.length > 0) {
    out.push("## 阅读疑问");
    out.push("");
    out.push(readingDoubts.join("\n"));
    out.push("");
  }

  if (noteLines.length > 0) {
    out.push("## 我的笔记");
    out.push("");
    out.push(noteLines.join("\n"));
    out.push("");
  }

  const annotationLines = [...otherAnnotations, ...markLines];
  if (annotationLines.length > 0) {
    out.push("## 标注与标记");
    out.push("");
    out.push(annotationLines.join("\n"));
    out.push("");
  }

  if (
    wrong.length === 0 &&
    unanswered.length === 0 &&
    doubts.length === 0 &&
    readingDoubts.length === 0 &&
    noteLines.length === 0 &&
    annotationLines.length === 0
  ) {
    out.push("> 暂无用户产出。");
    out.push("");
  }

  return out.join("\n");
}
