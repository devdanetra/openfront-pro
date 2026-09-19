// Dev check of the stream overlay as a real extension page: loads this unpacked
// extension into a throw-away headless Chrome, asks the worker to open the
// overlay (popup "Tools" -> Open), and checks that it opens as a popup window on
// green with the Window Capture hint, reads storage and draws the cards.
// Never touches openfront.io.
//   node tools/cdp-overlay-ext.mjs [outDir]    (default .shots/overlay)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? path.join(ROOT, ".shots", "overlay");
const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};
const PORT = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofr-ovx-"));
const chrome = spawn(CHROME, [`--user-data-dir=${tmp}`, `--remote-debugging-port=${PORT}`, "--enable-unsafe-extension-debugging", "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let version = null;
for (let i = 0; i < 40 && !version; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    await wait(250);
  }
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
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
const send = (method, params = {}, sessionId) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
const loaded = await send("Extensions.loadUnpacked", { path: ROOT });
const extId = loaded.result?.id;
check("extension loads", !!extId, JSON.stringify(loaded.error ?? ""));
await wait(1500);

async function attach(targetId) {
  const r = await send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = r.result.sessionId;
  await send("Runtime.enable", {}, sessionId);
  const evaluate = async (expression) => {
    const x = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    return x.result?.exceptionDetails ? `threw: ${x.result.exceptionDetails.exception?.description}` : x.result?.result?.value;
  };
  return { sessionId, evaluate };
}
const targets = async () => (await send("Target.getTargets")).result.targetInfos;

// an extension page to talk to the worker from (the toolbar popup's document)
const created = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/popup.html#tools` });
await wait(1500);
const popup = await attach(created.result.targetId);
const today = new Date().toDateString();
const now = Date.now();
await popup.evaluate(`chrome.storage.sync.set({ dataConsent: true, theme: "classic" }).then(() => chrome.storage.local.set({
  overlaySelf: { name: "[LUX] TeNa" },
  "ofs6:[lux] tena": { value: { found: true, games: 412, wins: 61, ratedGames: 400, ratedWins: 60, expectedWins: 31.5, streak: 6 }, expiresAt: ${now} + 3600000 },
  session: { day: ${JSON.stringify(today)}, startPct: 6.4, games: [{ won: true }, { won: false }, { won: true, pctAfter: 7.2 }] },
})).then(() => 1)`);
check("the popup's Tools pane has no launcher-only OBS row here", (await popup.evaluate(`document.getElementById("overlay-obs").hidden`)) === true);
await popup.evaluate(`chrome.runtime.sendMessage({ type: "openPage", page: "overlay" }).then(() => 1, () => 1)`);
await wait(2500);
const overlayTarget = (await targets()).find((t) => t.type === "page" && t.url.startsWith(`chrome-extension://${extId}/src/overlay.html`));
check("the worker opened the overlay", !!overlayTarget, overlayTarget?.url);
check("...on green with the settings panel", /\?bg=green&edit=1$/.test(overlayTarget?.url ?? ""), overlayTarget?.url);
if (overlayTarget) {
  const ov = await attach(overlayTarget.targetId);
  const win = await ov.evaluate(`chrome.windows.getCurrent().then((w) => ({ type: w.type, width: w.width, height: w.height }))`);
  check("...in a popup window of its own", win?.type === "popup", JSON.stringify(win));
  // fresh live state, as the game tab would write it
  await ov.evaluate(`chrome.storage.local.set({ overlayLive: { gameId: "AbCd1234", at: Date.now(), phase: "out", seconds: 1500, map: "Europe", mode: "Free For All", humans: 9, humansTotal: 41, players: 30, place: null, share: 0, top: [{ share: 0.21 }, { share: 0.18 }, { share: 0.09 }] } }).then(() => 1)`);
  await wait(1500);
  const state = await ov.evaluate(`(() => ({
    beat: null,
    how: document.getElementById("ed-how").textContent,
    windowBtnHidden: document.getElementById("ed-window").hidden,
    cards: [...document.querySelectorAll("#cards > .ov-card")].map((c) => c.classList[1]),
    phase: document.querySelector(".ov-live")?.dataset.phase ?? null,
    flames: document.querySelectorAll('.ov-flame[data-on="true"]').length,
    more: document.querySelector(".ov-more")?.textContent ?? null,
    drift: document.querySelector(".ov-gauge-drift")?.dataset.dir ?? null,
    name: document.querySelector(".ov-name")?.textContent ?? null,
  }))()`);
  const beat = await ov.evaluate(`chrome.storage.local.get("overlayEnabled").then((r) => r.overlayEnabled)`);
  check("heartbeat written", typeof beat === "number" && Date.now() - beat < 30000);
  check("Window Capture + Chroma Key hint", /Window Capture/.test(state.how) && /Chroma Key/.test(state.how), state.how);
  check("no 'Open as window' inside the window itself", state.windowBtnHidden === true);
  check("rank + live cards from storage", JSON.stringify(state.cards) === '["ov-rank","ov-live"]' && state.phase === "out", JSON.stringify(state));
  check("streak past five: five flames and x6, rank down", state.flames === 5 && state.more === "\u00d76" && state.drift === "down", JSON.stringify(state));
  await send("Emulation.setDeviceMetricsOverride", { width: 680, height: 860, deviceScaleFactor: 1, mobile: false }, ov.sessionId);
  await wait(500);
  const shot = await send("Page.captureScreenshot", { format: "png" }, ov.sessionId);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "overlay-extension-window-edit.png"), Buffer.from(shot.result.data, "base64"));
  await ov.evaluate(`document.getElementById("ed-done").click(); 1`);
  await wait(600);
  const shot2 = await send("Page.captureScreenshot", { format: "png" }, ov.sessionId);
  fs.writeFileSync(path.join(OUT, "overlay-extension-window.png"), Buffer.from(shot2.result.data, "base64"));
  check("Done hides the panel and drops edit from the address", (await ov.evaluate(`document.getElementById("edit").hidden && !location.search.includes("edit")`)) === true);
}

ws.close();
chrome.kill();
await wait(800);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // Chrome may still hold its profile
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
