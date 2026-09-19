// Dev tool + end-to-end check of the stream overlay, WITHOUT the game or
// openfront.io: a stand-in "game" page (a fake GameView on <player-panel>, read
// by the real page-probe.js) is attached by the real launcher, whose content
// scripts publish into storage; the overlay page is served by the same launcher
// and screenshotted in a headless Chrome at 1920x1080.
//
//   node tools/shot-overlay.mjs [outDir]     (default .shots/overlay)
//   SHOT_SCALE=2 (env): 1920x1080 shots at device pixel ratio 2
//   OVERLAY_ELITE=1 (env): a top-1% player (the numbers of the screenshots'
//   dashboard) instead of the default top-5% one
//
// Checks the whole path - heartbeat -> content.js -> probe -> overlayLive ->
// overlay page, recap card via OFR_RECAP.drawCard, streamer mode, heartbeat going
// stale, leaving the game - then shoots classic + daylight on transparent /
// green / dark (and transparent composited over a made-up map), the settings
// panel and the small window. Uses an isolated settings folder; the rank comes
// from a pre-filled cache entry, so nothing is looked up on the network.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? path.join(ROOT, ".shots", "overlay");
const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// a port nobody else is using: other dev tools drive headless Chromes too, and two
// on one debugging port end up steering each other's tabs
const CDP = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const GAME_ID = "AbCd1234";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};

// ---- the stand-in game: a fake, read-only GameView the probe can read ---------------
const GAME_PAGE = `<!doctype html><title>stand-in game</title><body style="background:#355">
<script>
  localStorage.setItem("username", "TeNa");
  localStorage.setItem("clanTag", "LUX");
  const start = Date.now();
  const people = [];
  for (let i = 1; i <= 57; i++) people.push({ id: i, type: i <= 38 ? "HUMAN" : "FAKEHUMAN", alive: i <= 14 || i > 38, tiles: Math.round(40000 / (i + 1.5)) });
  people[1].tiles = 12400; people[0].tiles = 17100; // #1 somebody, #2 me (id 2)
  const view = (p) => ({ smallID: () => p.id, type: () => p.type, isAlive: () => p.alive, numTilesOwned: () => p.tiles, isMe: () => p.id === 2, clientID: () => "Cl1ent02", displayName: () => "P" + p.id });
  window.fakeGame = {
    gameID: () => ${JSON.stringify(GAME_ID)},
    ticks: () => 7540 + Math.floor((Date.now() - start) / 100),
    inSpawnPhase: () => false,
    isCatchingUp: () => false,
    myPlayer: () => view(people[1]),
    playerViews: () => people.map(view),
    numLandTiles: () => 100000,
    config: () => ({ gameConfig: () => ({ gameMode: "Free For All", gameMap: "World" }) }),
  };
  const panel = document.createElement("player-panel");
  panel.g = window.fakeGame;
  document.body.append(panel);
</script></body>`;
const site = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(req.url.startsWith("/game/") ? GAME_PAGE : "<!doctype html><title>home</title><body>home</body>");
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${site.address().port}`;

// ---- launcher with seeded storage ---------------------------------------------------
const bgSource = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const CACHE_PREFIX = /const CACHE_PREFIX = "([^"]+)"/.exec(bgSource)[1];
const today = new Date().toDateString();
const now = Date.now();
const ELITE = process.env.OVERLAY_ELITE === "1";
const SCALE = Number(process.env.SHOT_SCALE ?? 1); // SHOT_SCALE=2: the 1920x1080 shots at device pixel ratio 2
const info = {
  found: true, username: "[LUX] TeNa", games: 412, wins: 61, winRate: 14.8, ratedGames: 400, ratedWins: 60, expectedWins: 31.5, streak: 3,
  recentGames: [], maps: [], modes: [],
  ...(ELITE ? { games: 516, wins: 398, winRate: 77.1, ratedGames: 516, ratedWins: 398, expectedWins: 60 } : {}),
};
const [START_PCT, PCT_BEFORE, PCT_AFTER] = ELITE ? [1.1, 0.9, 0.8] : [6.4, 5.6, 4.9];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofr-overlay-"));
const appdata = path.join(tmp, "appdata");
fs.mkdirSync(path.join(appdata, "openfront-pro-launcher"), { recursive: true });
fs.writeFileSync(
  path.join(appdata, "openfront-pro-launcher", "storage.json"),
  JSON.stringify({
    sync: { dataConsent: true, themesMigrated: true, theme: "classic", streamerMode: false },
    local: {
      ofrDevHooks: true, // content.js exposes __ofrOverlayRecap only with this (dev profiles)
      [`${CACHE_PREFIX}[lux] tena`]: { value: info, expiresAt: now + 3600 * 1000 },
      session: {
        day: today,
        startPct: START_PCT,
        games: [
          { gameId: "g0000001", won: false, place: 5, total: 40, at: now - 5e6 },
          { gameId: "g0000002", won: true, place: 1, total: 38, at: now - 4e6 },
          { gameId: "g0000003", won: false, place: 3, total: 44, at: now - 3e6 },
          { gameId: "g0000004", won: true, place: 1, total: 41, at: now - 2e6 },
          { gameId: "g0000005", won: true, place: 1, total: 36, at: now - 1e6, pctBefore: PCT_BEFORE, pctAfter: PCT_AFTER },
        ],
      },
    },
  }),
);
const out = [];
const launcher = spawn(process.execPath, [path.join(ROOT, "launcher/openfront-pro-launcher.cjs"), "--attach", `--port=${CDP}`], {
  env: { ...process.env, APPDATA: appdata, OFR_LAUNCHER_TEST_ORIGIN: `${ORIGIN}/` },
});
launcher.stdout.on("data", (d) => out.push(String(d)));
launcher.stderr.on("data", (d) => out.push(String(d)));
const chrome = spawn(CHROME, [`--user-data-dir=${path.join(tmp, "chrome")}`, `--remote-debugging-port=${CDP}`, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `${ORIGIN}/game/${GAME_ID}`], { stdio: "ignore" });
await wait(2500);
const base = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}/.exec(out.join(""))?.[0];
if (!base) throw new Error(`launcher did not start: ${out.join("")}`);
check("launcher prints the OBS address with bg=transparent", out.join("").includes(`${base}/src/overlay.html?bg=transparent`));

const api = (op, body) => fetch(`${base}/__api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, ...body }) }).then((r) => r.json()).then((r) => r.value);
const local = (keys) => api("storage.get", { area: "local", keys });

// ---- CDP ----------------------------------------------------------------------------
async function connect(match) {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === "page" && match(t.url));
    } catch {
      // not up yet
    }
    if (!target) await wait(250);
  }
  if (!target) throw new Error("no such tab");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const contexts = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.executionContextCreated") contexts.set(m.params.context.id, m.params.context);
    else if (m.method === "Runtime.executionContextDestroyed") contexts.delete(m.params.executionContextId);
    else if (m.method === "Runtime.executionContextsCleared") contexts.clear();
  });
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Runtime.enable");
  const evaluate = async (expression, contextId) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (r.result?.exceptionDetails) return `threw: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`;
    return r.result?.result?.value;
  };
  const inWorld = (expression) => {
    const ctx = [...contexts.values()].filter((c) => c.name === "OpenFront Pro").pop();
    return ctx ? evaluate(expression, ctx.id) : "no world";
  };
  return { send, evaluate, inWorld, close: () => ws.close() };
}

const game = await connect((u) => u.startsWith(`${ORIGIN}/game/`));
for (let i = 0; i < 30 && !/attached to the game window/.test(out.join("")); i++) await wait(300);
check("launcher attached to the stand-in game", /attached to the game window/.test(out.join("")));
await wait(1500);
check("content scripts and the new probe are in", (await game.inWorld("typeof globalThis.__ofrOverlayRecap")) === "function" && (await game.evaluate("window.__ofrProbeVersion")) >= 4);
check("nothing is published before an overlay is open", !(await local("overlayLive")).overlayLive && (await game.evaluate("document.documentElement.dataset.ofrOverlay")) !== "on");

// the overlay tab
await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`${base}/src/overlay.html`)}`, { method: "PUT" });
const ov = await connect((u) => u.startsWith(`${base}/src/overlay.html`));
await ov.send("Page.enable");
await ov.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: SCALE, mobile: false });
await ov.send("Page.bringToFront");
await wait(5000);

console.log("live path");
const beat = (await local("overlayEnabled")).overlayEnabled;
check("the overlay page writes its heartbeat", typeof beat === "number" && Date.now() - beat < 30000, String(beat));
check("the game tab turns the probe on", (await game.evaluate("document.documentElement.dataset.ofrOverlay")) === "on");
const live = (await local("overlayLive")).overlayLive;
check(
  "overlayLive carries the game",
  live?.gameId === GAME_ID && live.phase === "playing" && live.place === 2 && live.players === 33 && live.humans === 14 && live.humansTotal === 38 && Math.abs(live.share - 0.124) < 1e-6 && live.map === "World" && live.mode === "Free For All" && live.seconds >= 754,
  JSON.stringify(live),
);
check("no names in overlayLive", !JSON.stringify(live ?? {}).includes('"name"'));
check("overlayLive names the tab that owns it", typeof live?.owner === "string" && live.owner.length >= 8, String(live?.owner));
{
  // the clock is not a change: an unchanged game is rewritten every ~4 s, not every second
  const ats = new Set();
  for (let i = 0; i < 7; i++) {
    ats.add((await local("overlayLive")).overlayLive?.at);
    await wait(500);
  }
  check("no write every second (clock left out of the change check)", ats.size <= 2, `${ats.size} writes in 3 s`);
}
check("overlaySelf is the tagged name", (await local("overlaySelf")).overlaySelf?.name === "[LUX] TeNa");
const dom = () =>
  ov.evaluate(`(() => ({
    cards: [...document.querySelectorAll("#cards > .ov-card")].map((c) => c.classList[1]),
    name: document.querySelector(".ov-name")?.textContent ?? null,
    gauge: document.querySelector(".ov-gauge-val")?.textContent ?? null,
    clock: document.querySelector(".ov-clock")?.textContent ?? null,
    vals: [...document.querySelectorAll(".ov-val")].map((v) => v.textContent),
    pips: document.querySelectorAll(".ov-pip").length,
    flames: document.querySelectorAll('.ov-flame[data-on="true"]').length,
    drift: document.querySelector(".ov-gauge-drift")?.dataset.dir ?? null,
  }))()`);
let d = await dom();
check("rank and live cards on screen", JSON.stringify(d.cards) === '["ov-rank","ov-live"]', JSON.stringify(d));
check("rank card: name, gauge, 3 flames, 5 pips, rank up", d.name === "[LUX] TeNa" && /^<?\d+%$/.test(d.gauge ?? "") && d.flames === 3 && d.pips === 5 && d.drift === "up", JSON.stringify(d));
check("live card: clock, place, land, humans", /^1[2-9]:\d\d$/.test(d.clock ?? "") && d.vals[0] === "#2/33" && d.vals[1] === "12%" && d.vals[2] === "14/38", JSON.stringify(d));
const c1 = d.clock;
await wait(2200);
d = await dom();
check("the clock moves", d.clock !== c1, `${c1} -> ${d.clock}`);

// ---- screenshots ----------------------------------------------------------------------
const shot = async (name, { alpha = false } = {}) => {
  await ov.send("Emulation.setDefaultBackgroundColorOverride", alpha ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
  const s = await ov.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.result.data, "base64"));
  console.log(`  shot ${name}.png`);
};
const open = async (query, settle = 1800) => {
  await ov.send("Page.navigate", { url: `${base}/src/overlay.html${query}` });
  await wait(settle);
};
// A busy, colourful "map" behind the transparent overlay (test only): what a stream looks like.
const BACKDROP = `(() => {
  const c = document.createElement("canvas"); c.width = 960; c.height = 540;
  const g = c.getContext("2d"); let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = "#3f7fb5"; g.fillRect(0, 0, 960, 540);
  for (let i = 0; i < 26; i++) { g.fillStyle = ["#bfdc8a", "#c9c89c", "#d8cf9e", "#a9cf7c"][i % 4]; g.beginPath(); g.ellipse(r() * 960, r() * 540, 60 + r() * 170, 40 + r() * 110, r() * 3, 0, 7); g.fill(); }
  const cols = ["#e0443e", "#f2c12e", "#3b7be0", "#8e44ad", "#16a085", "#e67e22", "#ecf0f1", "#2c3e50"];
  for (let i = 0; i < 140; i++) { g.fillStyle = cols[i % cols.length]; g.globalAlpha = 0.85; g.fillRect(r() * 960, r() * 540, 8 + r() * 46, 8 + r() * 36); }
  g.globalAlpha = 1; g.fillStyle = "#fff"; g.font = "700 12px system-ui";
  for (let i = 0; i < 40; i++) g.fillText(["Garibaldi", "USSR", "France", "Anon12", "[UN] Mox"][i % 5], r() * 920, r() * 530);
  document.body.style.background = "url(" + c.toDataURL() + ") center / cover";
  return 1;
})()`;

async function setTheme(theme) {
  await api("storage.set", { area: "sync", items: { theme } });
  await wait(600);
}

for (const theme of ["classic", "daylight"]) {
  console.log(`theme ${theme}`);
  await setTheme(theme);
  await open("?bg=transparent");
  check(`${theme}: theme applied on the overlay page`, (await ov.evaluate("document.documentElement.dataset.ofrTheme ?? 'classic'")) === theme);
  await shot(`overlay-${theme}-transparent`, { alpha: true });
  await ov.evaluate(BACKDROP);
  await wait(300);
  await shot(`overlay-${theme}-over-map`);
  await open("?bg=green");
  await shot(`overlay-${theme}-green`);
  await open("?bg=dark");
  await shot(`overlay-${theme}-dark`);
}

console.log("recap card");
await setTheme("classic");
await open("?bg=transparent&recap=30");
const sandbox = vm.createContext({ console, URL, Math, JSON, Date });
const block = bgSource.slice(bgSource.indexOf("// <record-normaliser>"), bgSource.indexOf("// </record-normaliser>"));
vm.runInContext(block.replace(/async function fetchGameRecord[\s\S]*?\n}\n/, "") + "\nthis.normaliseRecord = normaliseRecord;", sandbox);
const recordFile = path.join(ROOT, ".recap", "game-5S99ULQP.json");
if (!fs.existsSync(recordFile)) {
  check("sample record .recap/game-5S99ULQP.json (run node tools/test-recap.mjs once)", false);
} else {
  const record = sandbox.normaliseRecord(JSON.parse(fs.readFileSync(recordFile, "utf8")), "5S99ULQP");
  const made = await game.inWorld(`(() => {
    const record = ${JSON.stringify(record)};
    return globalThis.__ofrOverlayRecap(record, ${JSON.stringify(GAME_ID)}, { me: "tena", myClan: "LUX", streamer: false, pctOf: () => 4 });
  })()`);
  await wait(2500);
  const recap = (await local("overlayRecap")).overlayRecap;
  check("recap model analysed", made === "ok", String(made));
  check("overlayRecap stored as a PNG under 1.5 MB", recap?.gameId === GAME_ID && /^data:image\/png;base64,/.test(recap.png) && recap.png.length < 1_500_000, `${recap?.png?.length ?? 0} chars`);
  d = await dom();
  check("the recap card replaces its game's live card", JSON.stringify(d.cards) === '["ov-rank","ov-recap"]', JSON.stringify(d.cards));
  await shot("overlay-classic-recap-transparent", { alpha: true });
  await ov.evaluate(BACKDROP);
  await wait(300);
  await shot("overlay-classic-recap-over-map");
  await open("?bg=dark&pos=bl&recap=30");
  await shot("overlay-classic-recap-dark-bottom-left");
  check("a reload of the overlay page keeps the card (closing grace)", !!(await local("overlayRecap")).overlayRecap && (await dom()).cards.includes("ov-recap"));

  // your name must not reach the stream on the card either
  const until = async (fn) => {
    for (let i = 0; i < 30; i++) {
      const v = (await local("overlayRecap")).overlayRecap;
      if (fn(v)) return v;
      await wait(250);
    }
    return (await local("overlayRecap")).overlayRecap;
  };
  await open("?bg=transparent&recap=300");
  await api("storage.set", { area: "sync", items: { streamerMode: true } });
  const masked = await until((v) => v?.streamer === true);
  check("streamer mode on: the tab draws the card again, masked, same timer", masked?.streamer === true && masked.png !== recap.png && masked.at === recap.at, `${masked?.streamer} ${masked?.at === recap?.at}`);
  await wait(400);
  d = await dom();
  check("...and the page shows it", d.cards.includes("ov-recap"), JSON.stringify(d.cards));
  await shot("overlay-classic-recap-streamer");
  await api("storage.set", { area: "sync", items: { streamerMode: false } });
  const unmasked = await until((v) => v?.streamer === false);
  check("streamer mode off: drawn with your name again", unmasked?.streamer === false);
  await open("?bg=transparent&recap=300&name=0");
  const byPage = await until((v) => v?.streamer === true);
  check("name=0 on the page: the tab masks the card for it", byPage?.streamer === true && (await local("overlayMask")).overlayMask > 0);
  d = await dom();
  check("...and the page shows only that one", d.cards.includes("ov-recap") && d.name === null, JSON.stringify(d));
  await open("?bg=transparent&recap=300");
  const back = await until((v) => v?.streamer === false);
  check("that page gone: the mask is lifted", back?.streamer === false && !(await local("overlayMask")).overlayMask, `card masked: ${back?.streamer}, overlayMask: ${(await local("overlayMask")).overlayMask}`);
  // an unmasked card never shows on a page that hides the name, whatever is stored
  await api("storage.set", { area: "sync", items: { streamerMode: true } });
  await api("storage.set", { area: "local", items: { overlayRecap: { ...back, at: Date.now() } } });
  await wait(300);
  const seen = await ov.evaluate(`[...document.querySelectorAll("#cards > .ov-card")].map((c) => c.classList[1])`);
  const stored = (await local("overlayRecap")).overlayRecap;
  check("a stored unmasked card is not shown in streamer mode", !seen.includes("ov-recap") || stored?.streamer === true, `${JSON.stringify(seen)} stored masked: ${stored?.streamer}`);
  await api("storage.set", { area: "sync", items: { streamerMode: false } });
  await until((v) => v?.streamer === false);

  await open("?bg=transparent&recap=2");
  await wait(2500);
  d = await dom();
  check("recap=2: the card goes after its seconds and the live card is back", !d.cards.includes("ov-recap") && d.cards.includes("ov-live"), JSON.stringify(d.cards));
}

console.log("settings panel and window");
await setTheme("daylight");
await open("?edit=1&bg=dark");
check("launcher page: Browser Source wording and the secret-key warning", /Browser source/.test(await ov.evaluate("document.getElementById('ed-how').textContent")) && /secret key/.test(await ov.evaluate("document.getElementById('ed-url-note').textContent")));
await shot("overlay-daylight-edit");
await setTheme("classic");
await open("?edit=1&bg=dark");
await shot("overlay-classic-edit");
await ov.send("Emulation.setDeviceMetricsOverride", { width: 680, height: 860, deviceScaleFactor: 1, mobile: false });
await open("?bg=green&edit=1");
await shot("overlay-classic-window-680x860-edit");
await open("?bg=green");
await shot("overlay-classic-window-680x860");
await ov.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: SCALE, mobile: false });
await open("?bg=transparent&demo=1&edit=1&pos=br&scale=1.3");
await shot("overlay-classic-demo-bottom-right-130");

console.log("streamer mode");
await open("?bg=transparent");
await api("storage.set", { area: "sync", items: { streamerMode: true } });
await wait(800);
d = await dom();
check("streamer mode hides your name at once", d.name === null && d.cards.includes("ov-rank"), JSON.stringify(d));
check("...and it is nowhere in the page text", !(await ov.evaluate("document.body.innerText")).includes("TeNa"));
await shot("overlay-classic-streamer");
await api("storage.set", { area: "sync", items: { streamerMode: false } });
await open("?bg=transparent&name=0");
check("name=0 hides it too", (await dom()).name === null);

console.log("launcher settings page");
await ov.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 560, deviceScaleFactor: 2, mobile: false });
await ov.send("Page.navigate", { url: `${base}/src/popup.html#tools` });
await wait(1800);
check("its Tools tab offers the OBS address (copy only, never shown)", (await ov.evaluate(`(() => { const row = document.getElementById("overlay-obs"); return !!row && !row.hidden && !document.body.innerText.includes(${JSON.stringify(base)}); })()`)) === true);
await shot("launcher-settings-tools");
await ov.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: SCALE, mobile: false });
const inGame = await game.inWorld(`(async () => {
  globalThis.__ofrOpenSettingsInPage();
  await new Promise((r) => setTimeout(r, 1200));
  const row = globalThis.__ofrSettingsShadow.getElementById("overlay-obs");
  document.querySelector(".ofr-settings-head button").click();
  return row ? row.hidden : "missing";
})()`);
check("...but not the copy inside the game window (that is what gets streamed)", inGame === true, String(inGame));

console.log("switching off");
await ov.send("Page.navigate", { url: "about:blank" }); // no page, no heartbeat
await api("storage.set", { area: "local", items: { overlayEnabled: Date.now() - 200000 } });
await wait(2500);
check("stale heartbeat: the tab stops and clears overlayLive", !(await local("overlayLive")).overlayLive && (await game.evaluate("document.documentElement.dataset.ofrOverlay")) === "off");
await api("storage.set", { area: "local", items: { overlayEnabled: Date.now() } });
await wait(2500);
check("fresh heartbeat: publishing resumes", !!(await local("overlayLive")).overlayLive);
// OpenFront is a single-page app: leaving a game changes the address, the game goes
await game.evaluate(`history.pushState({}, "", "/"); document.querySelector("player-panel").remove(); 1`);
await wait(2500);
check("leaving the game clears overlayLive", !(await local("overlayLive")).overlayLive);
// a full page load (where the last write may not get out): the next page sweeps it
await game.send("Page.navigate", { url: `${ORIGIN}/game/${GAME_ID}` });
for (let i = 0; i < 20 && !(await local("overlayLive")).overlayLive; i++) await wait(500);
check("back in a game: published again", !!(await local("overlayLive")).overlayLive);
await game.send("Page.navigate", { url: `${ORIGIN}/` });
for (let i = 0; i < 40 && (await local("overlayLive")).overlayLive; i++) await wait(500);
check("...and a full page load away: swept once abandoned", !(await local("overlayLive")).overlayLive);

game.close();
ov.close();
launcher.kill();
chrome.kill();
site.close();
await wait(800);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // Chrome may still hold its profile
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
