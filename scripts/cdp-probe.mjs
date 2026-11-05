/**
 * CDP 探针：列出 Obsidian 的调试目标与 iframe 结构（开发调试用）
 */
const PORT = Number(process.env.CDP_PORT || 9333);

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
console.log("browser:", version.Browser);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
});
function send(method, params = {}, sessionId) {
  const id = ++seq;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout " + method));
      }
    }, 10000);
  });
}

const targets = await send("Target.getTargets");
console.log("--- targets ---");
for (const t of targets.targetInfos) {
  console.log(
    `type=${t.type} id=${t.targetId} url=${(t.url || "").slice(0, 70)} title=${(t.title || "").slice(0, 40)}`,
  );
}

await send("Target.setAutoAttach", {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
});

const attached = events.filter((e) => e.method === "Target.attachedToTarget");
console.log("--- attachedToTarget 事件 ---", attached.length);
for (const e of attached) {
  console.log(
    `session=${e.params.sessionId} type=${e.params.targetInfo.type} url=${(e.params.targetInfo.url || "").slice(0, 60)}`,
  );
}

ws.close();
