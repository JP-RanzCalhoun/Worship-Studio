// Tiny CDP driver for the app's WebView2. Usage:
//   node cdp.mjs eval "<js expression>"        (awaits promises, prints JSON)
//   node cdp.mjs shot out.png
import fs from "node:fs";

const [, , cmd, arg] = process.argv;
const pages = await (await fetch("http://127.0.0.1:9333/json")).json();
const want = process.env.CDP_URL || "juce.backend";
const page = pages.find((p) => p.type === "page" && p.url.includes(want)) || pages.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r) => (ws.onopen = r));

if (cmd === "eval") {
  const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log("saved", arg);
}
ws.close();
process.exit(0);
