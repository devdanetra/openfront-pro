// Dev tool. Screenshots every tab of the settings popup, served by the launcher's
// local server (so chrome.* works without installing anything), in a headless
// Chrome driven over the DevTools protocol.
//   node tools/shot-popup.mjs <outDir> [theme]     (POPUP_TABS=look,tools env: only these tabs)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? path.join(ROOT, ".shots");
const THEME = process.argv[3] ?? "classic";
const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP = 9396;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofr-popup-"));
const appdata = path.join(tmp, "appdata", "openfront-pro-launcher");
fs.mkdirSync(appdata, { recursive: true });
fs.writeFileSync(path.join(appdata, "storage.json"), JSON.stringify({ sync: { dataConsent: true, themesMigrated: true, theme: THEME, watchlist: ["tena", "firedan"] }, local: {} }));
const out = [];
const launcher = spawn(process.execPath, [path.join(ROOT, "launcher/openfront-pro-launcher.cjs"), "--attach", "--port=9395"], { env: { ...process.env, APPDATA: path.join(tmp, "appdata") } });
launcher.stdout.on("data", (d) => out.push(String(d)));
await wait(2500);
const base = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}/.exec(out.join(""))?.[0];
if (!base) throw new Error("launcher did not start: " + out.join(""));

const chrome = spawn(CHROME, [`--user-data-dir=${path.join(tmp, "chrome")}`, `--remote-debugging-port=${CDP}`, "--headless=new", "--disable-gpu", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === "page");
  } catch {
    await wait(250);
  }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });

await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 860, deviceScaleFactor: 2, mobile: false });
for (const tab of (process.env.POPUP_TABS ?? "look,lobby,game,chat,tools,about").split(",")) {
  await send("Page.navigate", { url: `${base}/src/popup.html#${tab}` });
  await wait(1800);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, `popup-${THEME}-${tab}.png`), Buffer.from(shot.result.data, "base64"));
  console.log(`popup-${THEME}-${tab}.png`);
}
ws.close();
chrome.kill();
launcher.kill();
await wait(800);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // Chrome may still hold its profile
}
process.exit(0);
