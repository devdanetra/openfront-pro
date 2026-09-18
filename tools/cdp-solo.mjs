// Dev tool. Starts a SOLO game on the live site in a debug Chrome with the
// extension loaded (solo runs in the browser: nobody else is affected), lets it
// run, and checks what the page-world probe and the timelapse see. Saves a GIF
// and a WebM made from the recorded frames.
//
// SAFETY: this must never end up in a game with other people. It clicks only
// buttons found by their text INSIDE the single-player modal, never a screen
// position, and it goes on only once the running game says it is
// "Singleplayer". Anything else: it leaves to the home page and stops.
// It does not spawn - a solo game runs (nations and bots play) without us.
//   CDP_PORT=9345 node tools/cdp-solo.mjs <outDir> [seconds to play, default 70]
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9345);
const OUT = process.argv[2];
const PLAY = Number(process.argv[3] ?? 70) * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page" && t.url.includes("openfront.io"));
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
  else if (msg.method === "Runtime.executionContextDestroyed") {
    const i = contexts.findIndex((c) => c.id === msg.params.executionContextId);
    if (i !== -1) contexts.splice(i, 1);
  } else if (msg.method === "Runtime.executionContextsCleared") contexts.length = 0;
});
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
const page = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
};
const iso = async (expression) => {
  for (const c of [...contexts].reverse()) {
    if (c.auxData?.type !== "isolated" || !/OpenFront Pro/.test(c.name ?? "")) continue;
    const probe = await send("Runtime.evaluate", { expression: "typeof chrome?.storage?.sync === 'object' && !!chrome.runtime?.id", contextId: c.id, returnByValue: true });
    if (probe.result?.result?.value !== true) continue;
    const res = await send("Runtime.evaluate", { expression, contextId: c.id, awaitPromise: true, returnByValue: true });
    return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
  }
  return "no live extension context";
};
const shot = async (name) => {
  const res = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.result.data, "base64"));
};
const clickText = async (re, within = "document") => {
  const spot = await page(`(() => { const scope = ${within === "document" ? "document" : `document.querySelector(${JSON.stringify(within)})`}; if (!scope) return null; const b = [...scope.querySelectorAll("button, o-button, [role=button]")].filter((x) => ${re}.test((x.textContent || "").trim()) && x.getBoundingClientRect().width > 0).pop(); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.textContent.trim().slice(0, 30) }; })()`);
  if (!spot) return null;
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: spot.x, y: spot.y, button: "left", clickCount: 1 });
  return spot.text;
};

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "https://openfront.io/" });
await wait(9000);
console.log("extension", await iso("chrome.runtime.getManifest().version"));
await iso(`chrome.storage.sync.set({ dataConsent: true, timelapse: true, enabled: true, showRecap: true })`);
console.log("click:", await clickText("/^solo$/i"));
await wait(2500);
await shot("solo-modal");
const modalShown = await page(`(() => { const m = document.querySelector("single-player-modal"); if (!m) return false; return [...m.querySelectorAll("div")].some((d) => d.getBoundingClientRect().width > 0); })()`);
if (modalShown !== true) {
  console.log("the single-player modal did not open; reloading the home page (drops any lobby a stray click may have opened) and stopping");
  await send("Page.navigate", { url: "https://openfront.io/" });
  await wait(2000);
  ws.close();
  process.exit(2);
}
console.log("click:", await clickText("/^(start( game)?|play)$/i", "single-player-modal"));
await wait(15000);
const bail = async (why) => {
  console.log(`NOT a confirmed single-player game (${why}); leaving.`);
  await send("Page.navigate", { url: "https://openfront.io/" });
  await wait(3000);
  console.log("now at:", await page("location.pathname"));
  ws.close();
  process.exit(3);
};
const gameType = await page(`(() => { try { return document.querySelector("player-panel")?.g?.config?.()?.gameConfig?.()?.gameType ?? null; } catch (e) { return "threw"; } })()`);
console.log("game type:", gameType);
if (gameType !== "Singleplayer") await bail(`gameType = ${JSON.stringify(gameType)}`);
const state = () => page(`(() => { const g = document.querySelector("player-panel")?.g; if (!g) return { game: false, url: location.pathname };
  const call = (o, m, ...a) => { try { return typeof o?.[m] === "function" ? o[m](...a) : "missing"; } catch (e) { return "threw"; } };
  const buf = call(g, "tileStateBuffer");
  return { game: true, url: location.pathname, id: call(g, "gameID"), ticks: call(g, "ticks"), spawn: call(g, "inSpawnPhase"), w: call(g, "width"), h: call(g, "height"), buffer: buf && buf.constructor ? buf.constructor.name + ":" + buf.length : String(buf), players: (call(g, "playerViews") || []).length, me: !!call(g, "myPlayer"), colour: (() => { try { return JSON.stringify(g.playerViews()[0].territoryColor().toRgb()); } catch (e) { return "threw " + e.message; } })(), terrainByte: call(g, "terrainByte", 0), attrs: { game: document.documentElement.dataset.ofrGame ?? null, lapse: document.documentElement.dataset.ofrLapse ?? null } }; })()`);
console.log("game state:", JSON.stringify(await state()));
await shot("solo-start");

// No spawn click: clicking a screen position is how an earlier version of this
// tool joined a public lobby by accident. The game runs without us.
const t0 = Date.now();
while (Date.now() - t0 < PLAY) {
  await wait(10000);
  if ((await page(`(() => { try { return document.querySelector("player-panel")?.g?.config?.()?.gameConfig?.()?.gameType ?? null; } catch (e) { return null; } })()`)) !== "Singleplayer") await bail("the game changed under us");
  console.log(`  +${Math.round((Date.now() - t0) / 1000)}s frames=${await iso("globalThis.OFR_LAPSE?.count() ?? -1")} ticks=${(await state()).ticks}`);
}
await shot("solo-playing");
const frames = await iso("globalThis.OFR_LAPSE.count()");
console.log("frames recorded:", frames, "| game seconds:", await iso("globalThis.OFR_LAPSE.seconds()"));
if (frames >= 2) {
  const toB64 = `(blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(blob); })`;
  const gif = await iso(`globalThis.OFR_LAPSE.toGif({}).then(${toB64})`);
  if (typeof gif === "string" && !gif.startsWith("threw")) {
    fs.writeFileSync(`${OUT}/timelapse-solo.gif`, Buffer.from(gif, "base64"));
    console.log("gif:", fs.statSync(`${OUT}/timelapse-solo.gif`).size, "bytes");
  } else console.log("gif failed:", String(gif).slice(0, 300));
  const webm = await iso(`globalThis.OFR_LAPSE.toWebM({}).then(${toB64})`);
  if (typeof webm === "string" && !webm.startsWith("threw")) {
    fs.writeFileSync(`${OUT}/timelapse-solo.webm`, Buffer.from(webm, "base64"));
    console.log("webm:", fs.statSync(`${OUT}/timelapse-solo.webm`).size, "bytes");
  } else console.log("webm failed:", String(webm).slice(0, 300));
}
await send("Page.navigate", { url: "https://openfront.io/" }); // leave the solo game
await wait(1500);
ws.close();
