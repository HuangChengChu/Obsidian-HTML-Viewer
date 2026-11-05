import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MSG_LOAD,
  MSG_SAVE,
  MSG_PROGRESS,
  MSG_ACK,
  MSG_SELFTEST,
  MSG_STATE,
  MSG_INK,
  INBOUND_TYPES,
  MAX_PAYLOAD_BYTES,
  isPlainObject,
  sanitizePayload,
  isInboundMessage,
} from "../plugin/src/protocol.ts";

test("isPlainObject: 只接受普通对象", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject("x"), false);
  assert.equal(isPlainObject(1), false);
});

test("sanitizePayload: 拒绝数组 / null / 原始值", () => {
  assert.equal(sanitizePayload([]).ok, false);
  assert.equal(sanitizePayload(null).ok, false);
  assert.equal(sanitizePayload("x").ok, false);
  assert.equal(sanitizePayload(42).ok, false);
  assert.equal(sanitizePayload({ a: 1 }).ok, true);
});

test("sanitizePayload: 丢弃 __ 前缀键", () => {
  const r = sanitizePayload({ keep: 1, __evil: "x", nested: { __bad: 1, good: 2 } });
  assert.equal(r.ok, true);
  assert.equal("__evil" in r.payload, false);
  assert.equal(r.payload.nested.__bad, undefined);
  assert.equal(r.payload.nested.good, 2);
});

test("sanitizePayload: 体积上限", () => {
  const big = { t: "x".repeat(MAX_PAYLOAD_BYTES + 100) };
  const r = sanitizePayload(big);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("size") || r.reason.includes("大小"));
});

test("sanitizePayload: 嵌套深度上限", () => {
  let deep = { v: 1 };
  for (let i = 0; i < 20; i++) deep = { n: deep };
  const r = sanitizePayload(deep);
  assert.equal(r.ok, false);
});

test("sanitizePayload: 单个超长字符串被截断（体积仍在上限内）", () => {
  const r = sanitizePayload({ t: "y".repeat(600000) });
  assert.equal(r.ok, true);
  assert.equal(r.payload.t.length, 500000, "应被截断到 MAX_STRING_LENGTH");
});

test("isInboundMessage: 只认白名单指令", () => {
  assert.equal(isInboundMessage({ type: MSG_LOAD }), true);
  assert.equal(isInboundMessage({ type: MSG_SAVE, payload: {} }), true);
  assert.equal(isInboundMessage({ type: MSG_PROGRESS }), false, "插件→iframe 的指令不接受来自 iframe");
  assert.equal(isInboundMessage({ type: MSG_ACK }), false);
  assert.equal(isInboundMessage({ type: MSG_SELFTEST }), false);
  assert.equal(isInboundMessage({ type: "EVAL" }), false);
  assert.equal(isInboundMessage(null), false);
  assert.equal(isInboundMessage("LOAD_PROGRESS"), false);
});

test("INBOUND_TYPES 只包含四个指令", () => {
  assert.deepEqual(
    [...INBOUND_TYPES].sort(),
    [MSG_LOAD, MSG_SAVE, MSG_STATE, MSG_INK].sort(),
  );
});

test("STATE_PROBE 是合法的入站指令（页面状态上报）", () => {
  assert.equal(isInboundMessage({ type: MSG_STATE, payload: {} }), true);
});

test("HTML_QUIZ:INK 是合法的入站指令（手写层状态上报）", () => {
  assert.equal(isInboundMessage({ type: MSG_INK, payload: {} }), true);
});
