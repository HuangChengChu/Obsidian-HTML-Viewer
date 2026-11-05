/**
 * MD 文本的进度数据契约：frontmatter 里的 `hvv` 字段。
 *
 * 纯模块：不 import obsidian，可直接被 Node 单测引用。
 *
 * 为什么 MD 走 frontmatter 而不是 HTML 的 <script> 块：
 *  - MD 的正文由 Obsidian 自己渲染，插件不能往正文里插 <script> 标签
 *    （会被 Obsidian 的渲染管线处理掉，而且污染正文）
 *  - frontmatter 是 MD 天然就有的「元数据区」，Obsidian 官方有
 *    fileManager.processFrontMatter 专门读写它，不会破坏其他字段
 *  - 依然是「数据写在原文件里」，不产生任何附属文件
 *
 * 数据形状与 HTML 版完全一致（同一套 mergeProgress 合并规则），
 * 差异只在存放位置。
 */

import { isPlainObject } from "./protocol.ts";
import { mergeProgress, stripTombstones, type Block, type MergeResult } from "./merge.ts";

/** frontmatter 里承载进度数据的键名 */
export const MD_PROGRESS_KEY = "hvv";

/** 与 HTML 版共用同一套 schema 标识，便于同一份合并逻辑处理 */
export const MD_PROGRESS_SCHEMA = "html-quiz-progress/v1";

export interface MdExtractResult {
  found: boolean;
  /** 解析出来的进度数据；失败或不存在为 null */
  data: Block | null;
  /** 解析失败原因 */
  error?: string;
}

/**
 * 从 Obsidian 已解析好的 frontmatter 对象里取出进度数据。
 *
 * 注意 frontmatter 可能来自用户手写，内容不一定合法：
 *  - hvv 不是对象（比如用户写了 `hvv: 123`）→ 报错但不抛异常
 *  - hvv 是字符串（YAML 里写成了一整段 JSON）→ 也接受，解一下试试
 */
export function extractMdProgress(frontmatter: unknown): MdExtractResult {
  if (!isPlainObject(frontmatter)) {
    return { found: false, data: null };
  }
  if (!(MD_PROGRESS_KEY in frontmatter)) {
    return { found: false, data: null };
  }
  const raw = frontmatter[MD_PROGRESS_KEY];
  if (raw === null || raw === undefined) {
    return { found: true, data: null, error: "hvv 字段为空" };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { found: true, data: null, error: "hvv 字段是空字符串" };
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isPlainObject(parsed)) {
        return { found: true, data: null, error: "hvv 字段解析后不是对象" };
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
  if (!isPlainObject(raw)) {
    return { found: true, data: null, error: "hvv 字段不是对象" };
  }
  return { found: true, data: raw };
}

/**
 * 生成写入用的 frontmatter 对象（纯函数，不碰文件）。
 *
 * 只改 hvv 这一个键，其他字段原样保留。
 */
export function buildMdFrontmatter(frontmatter: unknown, payload: Block): Block {
  const base: Block = isPlainObject(frontmatter) ? { ...frontmatter } : {};
  base[MD_PROGRESS_KEY] = payload;
  return base;
}

/**
 * 合并磁盘侧与页面侧的进度（与 HTML 版同一套裁决规则）。
 *
 * MD 与 HTML 的差别只在存放位置，合并语义必须完全一致，
 * 否则「同一份数据在 HTML 和 MD 之间流转」会出现行为不一致。
 */
export function mergeMdProgress(disk: Block, incoming: Block): MergeResult {
  return mergeProgress(disk, incoming);
}

/** 清理墓碑条目（与 HTML 版同一套语义） */
export function cleanMdTombstones(block: Block): Block {
  return stripTombstones(block);
}

/**
 * 进度数据是否「看起来像一个合法的进度块」。
 *
 * 用于写回前自检：frontmatter 是用户手写的地方，
 * 我们不能因为一个字段形状不对就把整份 frontmatter 覆盖掉。
 */
export function isMdProgressData(v: unknown): v is Block {
  if (!isPlainObject(v)) return false;
  if (v.schema !== undefined && v.schema !== MD_PROGRESS_SCHEMA) return false;
  const arrays = ["notes", "annotations", "marks", "strokes"];
  for (const key of arrays) {
    if (key in v && !Array.isArray(v[key])) return false;
  }
  if ("answers" in v && !isPlainObject(v.answers)) return false;
  if ("sectionProgress" in v && !isPlainObject(v.sectionProgress)) return false;
  if ("meta" in v && !isPlainObject(v.meta)) return false;
  return true;
}

/**
 * 判断 frontmatter 里是否已经有 hvv 字段（用于「首次进入要不要提示用户」）。
 */
export function hasMdProgressKey(frontmatter: unknown): boolean {
  return isPlainObject(frontmatter) && MD_PROGRESS_KEY in frontmatter;
}
