/**
 * 协议常量与载荷校验。
 *
 * 纯模块：不 import obsidian，可直接被 Node 单测引用。
 */

export const MSG_LOAD = "LOAD_PROGRESS";
export const MSG_SAVE = "SAVE_PROGRESS";
export const MSG_PROGRESS = "HTML_QUIZ:PROGRESS";
export const MSG_ACK = "HTML_QUIZ:ACK";
export const MSG_SELFTEST = "HTML_QUIZ:SELFTEST";
/** 插件 → 页面：索要当前页面状态 */
export const MSG_PROBE = "HTML_QUIZ:PROBE";
/** 页面 → 插件：回送当前页面状态（白名单内） */
export const MSG_STATE = "STATE_PROBE";
/** 页面 → 插件：上报手写标注层状态（白名单内，不参与写回） */
export const MSG_INK = "HTML_QUIZ:INK";

/** 只接受来自 iframe 的指令 */
export const INBOUND_TYPES = [MSG_LOAD, MSG_SAVE, MSG_STATE, MSG_INK] as const;

export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_DEPTH = 8;
export const MAX_STRING_LENGTH = 500000;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function depthOf(v: unknown, d = 0): number {
  if (d > 64) return d;
  if (Array.isArray(v)) {
    let max = d;
    for (const item of v) max = Math.max(max, depthOf(item, d + 1));
    return max;
  }
  if (isPlainObject(v)) {
    let max = d;
    for (const key of Object.keys(v)) max = Math.max(max, depthOf(v[key], d + 1));
    return max;
  }
  return d;
}

function cleanValue(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > MAX_STRING_LENGTH ? v.slice(0, MAX_STRING_LENGTH) : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v === null) return null;
  if (Array.isArray(v)) return v.map((x) => cleanValue(x));
  if (isPlainObject(v)) return cleanObject(v);
  return undefined;
}

function cleanObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith("__")) continue;
    const cleaned = cleanValue(obj[key]);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

export type SanitizeResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * 清洗来自 iframe 的载荷：
 * - 必须是普通对象（不能是数组/null/原始值）
 * - 嵌套深度受限
 * - 丢弃 `__` 前缀键
 * - 超长字符串截断
 * - 序列化后体积受限
 */
export function sanitizePayload(raw: unknown): SanitizeResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "payload 必须是普通对象" };
  }
  if (depthOf(raw) > MAX_DEPTH) {
    return { ok: false, reason: `payload 嵌套深度超过 ${MAX_DEPTH}` };
  }
  // 体积按「原始载荷」判定：超限直接拒绝，而不是截断后悄悄丢掉用户数据
  let rawSize = 0;
  try {
    rawSize = JSON.stringify(raw).length;
  } catch {
    return { ok: false, reason: "payload 无法序列化" };
  }
  if (rawSize > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: `payload 大小超过 ${MAX_PAYLOAD_BYTES} 字节` };
  }
  const payload = cleanObject(raw);
  return { ok: true, payload };
}

/** 只认白名单内的、来自 iframe 的指令 */
export function isInboundMessage(
  data: unknown,
): data is { type: string; payload?: unknown } {
  if (!isPlainObject(data)) return false;
  const t = data.type;
  if (typeof t !== "string") return false;
  return (INBOUND_TYPES as readonly string[]).includes(t);
}
