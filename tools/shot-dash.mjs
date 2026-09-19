// Dev tool. Opens the Pro dashboard for a player in a debug Chrome (extension
// loaded, lookups agreed in that profile) and saves one screenshot per section,
// plus the whole thing, plus the home card. Nothing is clicked on the site and
// nothing is typed into its inputs; everything runs in the extension's own
// isolated world, on the extension's own elements.
//   CDP_PORT=9345 node tools/shot-dash.mjs <outDir> [player, default TeNa] [theme, default classic]
// Optional, as environment variables:
//   DASH_WIDTH=720        viewport width (default 1280)
//   DASH_CLAN=TAG         open with this clan (adds the clan section)
//   DASH_COMPARE=Name     also render the compare section against Name
//   DASH_NUMBERS=1        unfold every "Numbers" box
//   DASH_HOME=1           also render the home card WITH stats for the player,
//                         into a test container (dash-homecard-stats.png); the
//                         page's own card stays as it is
//   DASH_SESSION=1        show a made-up "today's session" (restored after)
//   DASH_SESSION_PCT=0.9,0.7  its rank before,after (default 3.4,2.6)
//   DASH_SCALE=2          device pixel ratio (default 1)
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9345);
const OUT = process.argv[2] ?? ".shots";
const PLAYER = process.argv[3] ?? "TeNa";
const THEME = process.argv[4] ?? "classic";
const WIDTH = Number(process.env.DASH_WIDTH ?? 1280);
const CLAN = process.env.DASH_CLAN ?? null;
const COMPARE = process.env.DASH_COMPARE ?? null;
const NUMBERS = process.env.DASH_NUMBERS === "1";
const HOME = process.env.DASH_HOME === "1";
const SESSION = process.env.DASH_SESSION === "1";
const SCALE = Number(process.env.DASH_SCALE ?? 1);
const [PCT_BEFORE, PCT_AFTER] = (process.env.DASH_SESSION_PCT ?? "3.4,2.6").split(",").map(Number);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page" && t.url.includes("openfront.io"));
if (!target) throw new Error("no openfront.io tab in the debug Chrome");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const contexts = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.executionContextCreated") contexts.push(msg.params.context);
  else if (msg.method === "Runtime.executionContextsCleared") contexts.length = 0;
});
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
const page = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
};
const iso = async (expression) => {
  for (const c of [...contexts].reverse()) {
    if (c.auxData?.type !== "isolated" || !/OpenFront Pro/.test(c.name ?? "")) continue;
    const probe = await send("Runtime.evaluate", { expression: "typeof globalThis.__ofrOpenDashboard === 'function' && !!chrome.runtime?.id", contextId: c.id, returnByValue: true });
    if (probe.result?.result?.value !== true) continue;
    const res = await send("Runtime.evaluate", { expression, contextId: c.id, awaitPromise: true, returnByValue: true });
    return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
  }
  return "no live extension context";
};
const shotEl = async (name, selector) => {
  const box = await page(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
  if (!box || !box.width) return console.log("  (no", selector, ")");
  const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...box, scale: 1 } });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.result.data, "base64"));
  console.log(" ", `${name}.png`, `${Math.round(box.width)}x${Math.round(box.height)}`);
};
const metrics = (height) => send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: SCALE, mobile: false });

await send("Runtime.enable");
await metrics(900);
await send("Page.navigate", { url: "https://openfront.io/" });
await wait(8000);
await iso(`chrome.storage.sync.set({ dataConsent: true, enabled: true, theme: ${JSON.stringify(THEME)} })`);
await wait(1500);

let savedSession = null;
if (SESSION) {
  savedSession = await iso(`chrome.storage.local.get("session").then((r) => JSON.stringify(r.session ?? null))`);
  const now = Date.now();
  const sample = {
    day: new Date().toDateString(),
    startPct: PCT_BEFORE,
    games: [
      { gameId: "shot1", place: 4, total: 40, won: false, at: now - 5 * 36e5 },
      { gameId: "shot2", place: 1, total: 28, won: true, at: now - 4 * 36e5 },
      { gameId: "shot3", place: null, total: 60, won: false, at: now - 3 * 36e5 },
      { gameId: "shot4", place: 12, total: 35, won: false, at: now - 2 * 36e5 },
      { gameId: "shot5", place: null, total: 50, won: true, at: now - 36e5, pctBefore: PCT_BEFORE, pctAfter: PCT_AFTER },
    ],
  };
  await iso(`chrome.storage.local.set({ session: ${JSON.stringify(sample)} })`);
}

await shotEl("dash-homecard", ".ofr-home");
if (HOME) {
  // A test container of our own; homeWidget() re-uses the single .ofr-home card,
  // so it is moved in here for the shot. content.js re-places the card on every
  // scan (the front page changes all the time) through globalThis.__ofrHomeWidget,
  // so that hook is paused for the shot and put back afterwards (and the final
  // reload restores everything anyway).
  console.log("home:", await iso(`(async () => {
    const real = globalThis.__ofrHomeWidget;
    globalThis.__ofrShotHomeWidget = real;
    globalThis.__ofrHomeWidget = () => {};
    const host = document.createElement("div");
    host.className = "ofr-shot-home";
    host.style.cssText = "position:fixed;left:24px;top:24px;width:${Math.min(720, WIDTH - 48)}px;padding:12px;z-index:2147483647;background:var(--ofr-stage-bg)";
    document.body.append(host);
    await real(host, ${JSON.stringify(PLAYER)}, { streamer: false });
    return "ok";
  })()`));
  await wait(1200);
  await shotEl("dash-homecard-stats", ".ofr-shot-home");
  await iso(`(() => {
    globalThis.__ofrHomeWidget = globalThis.__ofrShotHomeWidget ?? globalThis.__ofrHomeWidget;
    delete globalThis.__ofrShotHomeWidget;
    document.querySelector(".ofr-shot-home .ofr-home")?.removeAttribute("data-ofr-for");
    return "ok";
  })()`);
  await wait(600); // the next scan moves the card home and re-renders it
  await page(`document.querySelector(".ofr-shot-home")?.remove()`);
}

console.log("open:", await iso(`globalThis.__ofrOpenDashboard(${JSON.stringify(PLAYER)}, { self: true, clanStats: true, clan: ${JSON.stringify(CLAN)} }); "ok"`));
await wait(6000);
if (COMPARE) {
  // the dashboard's own "Compare with..." box (not a site input)
  console.log("compare:", await iso(`(() => {
    const input = document.querySelector(".ofr-dash-compare-input");
    if (!input) return "no compare box";
    input.value = ${JSON.stringify(COMPARE)};
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    return "ok";
  })()`));
  await wait(5000);
}
if (NUMBERS) {
  await iso(`document.querySelectorAll(".ofr-dash .ofr-dash-numbers").forEach((d) => { d.open = true; }); "ok"`);
  await wait(800);
}

// The dashboard is a fixed overlay that scrolls inside itself. Lay it out at its
// full height instead (absolute, body not scrolling), then grow the viewport to
// match, so the whole page can be captured in one image.
const height = await page(`(() => {
  const root = document.querySelector(".ofr-dash");
  if (!root) return 0;
  Object.assign(root.style, { position: "absolute", top: "0", bottom: "auto", height: "auto", minHeight: "100vh" });
  const body = root.querySelector(".ofr-dash-body");
  if (body) Object.assign(body.style, { flex: "none", overflow: "visible", maxHeight: "none", height: "auto" });
  return Math.ceil(root.scrollHeight);
})()`);
console.log("dashboard height", height);
await metrics(Math.max(900, Math.min(16000, height + 40)));
await wait(1000);
await shotEl("dash-all", ".ofr-dash");
const sections = await page(`[...document.querySelectorAll(".ofr-dash-section")].map((s, i) => { s.dataset.shot = String(i); return (s.querySelector("h2")?.textContent ?? "section").trim(); })`);
for (const [i, title] of (Array.isArray(sections) ? sections : []).entries()) await shotEl(`dash-${String(i).padStart(2, "0")}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}`, `.ofr-dash-section[data-shot="${i}"]`);

if (SESSION) {
  await iso(savedSession && savedSession !== "null"
    ? `chrome.storage.local.set({ session: ${savedSession} })`
    : `chrome.storage.local.remove("session")`);
}
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "https://openfront.io/" });
ws.close();
