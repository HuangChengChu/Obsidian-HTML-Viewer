/**
 * 进度数据区的文本手术（提取 / 替换 / 插入 / 安全转义）。
 *
 * 纯模块：不 import obsidian，可直接被 Node 单测引用。
 *
 * 数据区约定（D01/D02）：
 *   <script id="html-quiz-progress" type="application/json">
 *   { ...JSON... }
 *   </script>
 * 插件只替换标签内部的 JSON，其余字节一个不动。
 */

import { isPlainObject } from "./protocol.ts";

export const PROGRESS_BLOCK_ID = "html-quiz-progress";

/**
 * 注意 `\bid=` 会误伤 `data-id=`，因此要求 id 前必须是空白或引号。
 * 组1=开标签，组2=内容，组3=闭标签。
 */
export const PROGRESS_BLOCK_RE =
  /(<script\b[^>]*[\s"']id=["']html-quiz-progress["'][^>]*>)([\s\S]*?)(<\/script\s*>)/i;

/**
 * JSON 嵌入 <script> 时的三处必做转义。
 *
 *  1. `</script` → `<\/script`   否则提前闭合标签，后续正文被当脚本吞掉
 *  2. `<script`  → `<\u0073cript` 否则进入 script double-escaped 状态，`</script>` 不再结束脚本
 *  3. `<!--`    → `<\u0021--`   否则进入 script escaped 状态，结束标签行为改变
 *
 * 三条都作用在 JSON 文本本身，因此 JSON.parse 之后与原数据完全一致
 * （`\/`→`/`，`\u0073`→`s`，`\u0021`→`!`）。
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/<\//g, "<\\/")
    .replace(/<script/gi, "<\\u0073cript")
    .replace(/<!--/g, "<\\u0021--");
}

/** 序列化为可直接嵌入 script 的 JSON 文本（2 空格缩进 + 安全转义） */
export function serializeProgress(payload: unknown): string {
  const json = JSON.stringify(payload, null, 2);
  if (json === undefined) return "{}";
  return escapeJsonForScript(json);
}

export interface ExtractResult {
  found: boolean;
  /** 标签内部的原始文本 */
  raw: string;
  /** 解析成功后的对象；失败为 null */
  data: Record<string, unknown> | null;
  /** 解析失败原因 */
  error?: string;
}

/** 从 HTML 全文中提取数据区 */
export function extractProgress(text: string): ExtractResult {
  const m = findBlock(text, PROGRESS_BLOCK_RE);
  if (!m) {
    return { found: false, raw: "", data: null };
  }
  const raw = m[2] ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    return { found: true, raw, data: null, error: "数据区为空" };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isPlainObject(parsed)) {
      return { found: true, raw, data: null, error: "数据区不是 JSON 对象" };
    }
    return { found: true, raw, data: parsed };
  } catch (err) {
    return {
      found: true,
      raw,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 生成一整块数据区 */
export function buildProgressBlock(payload: unknown): string {
  return `<script id="${PROGRESS_BLOCK_ID}" type="application/json">\n${serializeProgress(payload)}\n</script>`;
}

export type ApplyAction = "replaced" | "inserted" | "appended";

export interface ApplyResult {
  text: string;
  action: ApplyAction;
}

/**
 * 把 payload 写进 HTML 全文：
 *  - 已有数据区 → 原地替换其内部 JSON（其余字节不动）
 *  - 没有数据区 → 插到最后一个 `</body>` 之前
 *  - 连 `</body>` 都没有 → 追加到末尾
 */
export function applyProgress(text: string, payload: unknown): ApplyResult {
  const serialized = serializeProgress(payload);

  const m = findBlock(text, PROGRESS_BLOCK_RE);
  if (m) {
    const open = m[1];
    const close = m[3];
    const out =
      text.slice(0, m.index) +
      open +
      serialized +
      close +
      text.slice(m.index + m[0].length);
    return { text: out, action: "replaced" };
  }

  const block = buildProgressBlock(payload);
  const bodyRe = /<\/body\s*>/gi;
  let lastIdx = -1;
  let mm: RegExpExecArray | null;
  while ((mm = bodyRe.exec(text)) !== null) lastIdx = mm.index;
  if (lastIdx >= 0) {
    return {
      text: `${text.slice(0, lastIdx)}${block}\n${text.slice(lastIdx)}`,
      action: "inserted",
    };
  }
  return {
    text: `${text.replace(/\s*$/, "")}\n${block}\n`,
    action: "appended",
  };
}

/**
 * 找出 HTML 注释的区间。
 *
 * 为什么需要：模板顶部的「AI 提取说明」注释里会写出一字不差的
 * `<script id="html-quiz-progress">` 字样。如果直接用正则去匹配，
 * **会先命中注释**，一旦写入就会把从注释处到真实数据块之间的整篇文档
 * （head/style/body/正文）全部覆盖掉——这是灾难级事故。
 */
function commentSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function isInsideComment(spans: Array<[number, number]>, index: number): boolean {
  for (const [start, end] of spans) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/** 在忽略 HTML 注释的前提下，找出第一个匹配块 */
function findBlock(text: string, re: RegExp): RegExpExecArray | null {
  const spans = commentSpans(text);
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const g = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (!isInsideComment(spans, m.index)) return m;
    g.lastIndex = m.index + 1;
  }
  return null;
}

/** 统计数据区数量（忽略注释中的字面量） */
export function countProgressBlocks(text: string): number {
  const spans = commentSpans(text);
  const g = new RegExp(PROGRESS_BLOCK_RE.source, "gi");
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (!isInsideComment(spans, m.index)) count += 1;
    g.lastIndex = m.index + 1;
  }
  return count;
}

// ---------------------------------------------------------------- 内容元数据块

export const CONTENT_META_ID = "html-content-meta";

export const CONTENT_META_RE =
  /(<script\b[^>]*[\s"']id=["']html-content-meta["'][^>]*>)([\s\S]*?)(<\/script\s*>)/i;

/**
 * 提取静态的内容元数据块（题库 / 标准答案 / 章节结构）。
 * 这块由页面作者（通常是 AI）写入，插件**不写它**，只读。
 */
export function extractContentMeta(
  text: string,
): { found: boolean; data: Record<string, unknown> | null; error?: string } {
  const m = findBlock(text, CONTENT_META_RE);
  if (!m) {
    return { found: false, data: null };
  }
  const raw = (m[2] ?? "").trim();
  if (!raw) {
    return { found: true, data: null, error: "内容元数据区为空" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return { found: true, data: null, error: "内容元数据区不是 JSON 对象" };
    }
    return { found: true, data: parsed };
  } catch (err) {
    return {
      found: true,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
