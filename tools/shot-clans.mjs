// Dev tool. Screenshots every view of the clan hub (src/clans.html) with real
// ofstats data, served by the launcher's local server (so chrome.* works
// without installing anything) in a headless Chrome over the DevTools protocol.
// Lookups are agreed in an isolated APPDATA; nothing touches openfront.io.
//   node tools/shot-clans.mjs <outDir> [themes=classic,daylight] [widths=1280,720] [--streamer]
//   SHOT_SCALE=2 (env) shoots at device pixel ratio 2
//
// Recruits read only the worker's local recruit index, so the script first asks
// the worker for a few untagged players (winners of the clans' recent games), as
// a lobby would. Also shot: streamer mode with your name unknown (every name
// masked) and the extension switched off.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const OUT = args[0] ?? path.join(ROOT, ".shots/clans");
const THEMES = (args[1] ?? "classic,daylight").split(",");
const WIDTHS = (args[2] ?? "1280,720").split(",").map(Number);
const STREAMER = process.argv.includes("--streamer");
const SCALE = Number(process.env.SHOT_SCALE ?? 1); // SHOT_SCALE=2: device pixel ratio 2 (crisper, twice the pixels)
const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// free ports: other dev tools drive headless Chromes too, and two on one
// debugging port end up steering each other's tabs
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const CDP = await freePort();
const GAME_PORT = await freePort();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofr-clans-"));
const appdata = path.join(tmp, "appdata", "openfront-pro-launcher");
fs.mkdirSync(appdata, { recursive: true });
fs.writeFileSync(
  path.join(appdata, "storage.json"),
  JSON.stringify({ sync: { dataConsent: true, themesMigrated: true, theme: THEMES[0], streamerMode: STREAMER }, local: STREAMER ? { selfStatsName: "[LUX] TeNa" } : {} }),
);
const out = [];
const launcher = spawn(process.execPath, [path.join(ROOT, "launcher/openfront-pro-launcher.cjs"), "--attach", `--port=${GAME_PORT}`], { env: { ...process.env, APPDATA: path.join(tmp, "appdata") } });
launcher.stdout.on("data", (d) => out.push(String(d)));
launcher.stderr.on("data", (d) => out.push(String(d)));
await wait(2500);
const base = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}/.exec(out.join(""))?.[0];
if (!base) throw new Error("launcher did not start: " + out.join(""));

const chrome = spawn(CHROME, [`--user-data-dir=${path.join(tmp, "chrome")}`, `--remote-debugging-port=${CDP}`, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === "page" && t.url === "about:blank");
  } catch {
    await wait(250);
  }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const consoleLines = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === "Runtime.exceptionThrown") consoleLines.push(`EXCEPTION ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
  else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleLines.push(`console.error ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send("Runtime.enable");
await send("Page.enable");
await send("Page.bringToFront");

async function settle(maxMs = 45000) {
  const t0 = Date.now();
  await wait(600);
  while (Date.now() - t0 < maxMs) {
    const busy = await evaluate(`!!document.querySelector('.ofr-state[data-kind="loading"], .hub-progress, .ofr-badge[data-ofr-kind="pending"]')`);
    if (!busy) break;
    await wait(500);
  }
  await wait(400);
}
async function shoot(name, width) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(300);
  const h = await evaluate("Math.ceil(document.documentElement.scrollHeight)");
  await send("Emulation.setDeviceMetricsOverride", { width, height: Math.min(6000, Math.max(600, h)), deviceScaleFactor: SCALE, mobile: false });
  await wait(300);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.result.data, "base64"));
  console.log(name, `${width}x${h}`);
}

// seed the local cache with a few untagged players, as lobbies would
await send("Page.navigate", { url: `${base}/src/clans.html#recruits` });
await wait(1500);
const seeded = await evaluate(`(async () => {
  const names = new Set();
  for (const tag of ["LUX", "UN"]) {
    const c = await chrome.runtime.sendMessage({ type: "clan", tag });
    for (const g of c?.recentGames ?? []) if (g.winner && !/^\\[|^Team|^Anon|\\+/.test(g.winner)) names.add(g.winner);
  }
  const list = [...names].slice(0, 10);
  const r = await chrome.runtime.sendMessage({ type: "lookup", usernames: list });
  return Object.entries(r ?? {}).map(([k, v]) => k + ":" + (v.found ? "found" : v.reason));
})()`);
console.log("seeded:", JSON.stringify(seeded));
await wait(800); // the worker writes its recruit index in batches

const VIEWS = [
  ["board", "#board"],
  ["clan", "#tag=LUX"],
  ["compare", "#vs=LUX&with=UN"],
  ["recruits", "#recruits"],
];
for (const theme of THEMES) {
  await evaluate(`chrome.storage.sync.set({ theme: ${JSON.stringify(theme)} })`);
  for (const [view, hash] of VIEWS) {
    for (const width of WIDTHS) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: `${base}/src/clans.html${hash}` });
      await wait(800);
      await settle();
      if (view === "recruits") await evaluate(`[...document.querySelectorAll('.hub-seg button')].find(b => b.textContent === 'all' && b.closest('[aria-label="Rank"]'))?.click()`);
      if (view === "recruits") await evaluate(`[...document.querySelectorAll('[aria-label="Last played"] button')].find(b => b.textContent === 'any')?.click()`);
      if (view === "clan") await evaluate(`document.querySelector('.hub-member-row')?.click()`);
      await wait(300);
      await shoot(`clans-${theme}-${view}-${width}${STREAMER ? "-streamer" : ""}.png`, width);
    }
  }
}
// streamer mode before the hub knows your name: every name masked, a banner
await evaluate(`Promise.all([chrome.storage.sync.set({ streamerMode: true, theme: "classic" }), chrome.storage.local.set({ selfStatsName: "" })])`);
for (const [view, hash] of [["clan", "#tag=LUX"], ["recruits", "#recruits"]]) {
  await send("Page.navigate", { url: `${base}/src/clans.html${hash}` });
  await wait(800);
  await settle();
  if (view === "recruits") await evaluate(`[...document.querySelectorAll('.hub-seg button')].find(b => b.textContent === 'all' && b.closest('[aria-label="Rank"]'))?.click()`);
  if (view === "clan") await evaluate(`document.querySelector('.hub-member-row')?.click()`);
  await wait(300);
  await shoot(`clans-classic-${view}-masked-720.png`, 720);
}
await evaluate(`chrome.storage.sync.set({ streamerMode: ${STREAMER} })`);
if (STREAMER) await evaluate(`chrome.storage.local.set({ selfStatsName: "[LUX] TeNa" })`);
// the extension switched off
await evaluate(`chrome.storage.sync.set({ enabled: false })`);
await send("Page.navigate", { url: `${base}/src/clans.html#board` });
await wait(1500);
await shoot("clans-classic-off-720.png", 720);
await evaluate(`chrome.storage.sync.set({ enabled: true })`);
// the consent state
await evaluate(`chrome.storage.sync.set({ dataConsent: false, theme: "classic" })`);
await send("Page.navigate", { url: `${base}/src/clans.html#board` });
await wait(1500);
await shoot("clans-classic-noconsent-720.png", 720);
if (consoleLines.length) console.log(consoleLines.join("\n"));

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
