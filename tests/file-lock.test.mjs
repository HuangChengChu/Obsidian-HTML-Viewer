import { test } from "node:test";
import assert from "node:assert/strict";

import { FileLock } from "../plugin/src/file-lock.ts";

test("FileLock: 同一 key 串行执行，不交错", async () => {
  const lock = new FileLock();
  const log = [];
  const task = (name, delay) =>
    lock.run("a.html", async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, delay));
      log.push(`${name}:end`);
    });
  await Promise.all([task("t1", 20), task("t2", 1), task("t3", 1)]);
  assert.deepEqual(log, ["t1:start", "t1:end", "t2:start", "t2:end", "t3:start", "t3:end"]);
});

test("FileLock: 不同 key 并行", async () => {
  const lock = new FileLock();
  const log = [];
  const task = (key, name) =>
    lock.run(key, async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`${name}:end`);
    });
  await Promise.all([task("a.html", "a"), task("b.html", "b")]);
  assert.ok(
    log.indexOf("b:start") < log.indexOf("a:end"),
    "不同 key 不应互相阻塞：b:start 必须出现在 a:end 之前",
  );
  assert.ok(
    log.indexOf("a:start") < log.indexOf("b:start"),
    "同批次内按注册顺序启动",
  );
});

test("FileLock: 任务抛错不影响后续排队任务", async () => {
  const lock = new FileLock();
  await assert.rejects(
    lock.run("a.html", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const v = await lock.run("a.html", async () => "ok");
  assert.equal(v, "ok");
});

test("FileLock: 返回值透传", async () => {
  const lock = new FileLock();
  const r = await lock.run("k", async () => ({ ok: 1 }));
  assert.deepEqual(r, { ok: 1 });
});
