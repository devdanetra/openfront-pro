// Loads the unpacked extension into the debug Chrome through the DevTools
// Extensions domain (needs --enable-unsafe-extension-debugging).
import nodePath from "node:path";
import { fileURLToPath as toPath } from "node:url";
const REPO_ROOT = nodePath.resolve(nodePath.dirname(toPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] ?? 9335);
const PATH = process.argv[3] ?? REPO_ROOT; // the unpacked extension = this repository

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const res = await new Promise((resolve) => {
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === 1) resolve(msg);
  });
  ws.send(
    JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: PATH } }),
  );
});
console.log(JSON.stringify(res));
ws.close();
