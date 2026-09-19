// Dev tool + end-to-end check of observer mode and the overlay replay, WITHOUT the
// game or openfront.io: a stand-in page plays a game you WATCH (tools/standin-game.mjs:
// not on the game's roster, myPlayer() null, a made-up map, players eliminated on a
// schedule, gameOver() on demand), the real launcher attaches to it and runs the
// real content scripts and page-probe.js, and serves the overlay and observer pages;
// all of it in a headless Chrome on free ports. The stand-in GameView has OpenFront
// v0.34.10's seat semantics: its own isSpectator() is also true for a PLAYER in the
// spawn phase and for an eliminated one - those must never get the caster feed.
//
//   node tools/shot-observer.mjs [outDir]     (default .shots/observer)
//
// Checks: the probe's caster feed (only while asked, names as shown, never the raw
// ones), the caster panel (leaderboard, rank badges from the seeded cache, team view,
// eliminations, fold, streamer mode, switch), the OBS caster card through
// overlayLive with its delay buffer, the replay GIF (only once the game is over,
// size cap, masking, gone when the next game runs), and the observer page against
// a STUBBED worker answer (started / countdown / no start time / nobody playing /
// reminder, also across two observer tabs / consent) - nothing is
// asked of OpenFront, and Watch is caught before it could open anything. Then
// screenshots in classic and daylight.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { playerGamePage, spectatorGamePage } from "./standin-game.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? path.join(ROOT, ".shots", "observer");
const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const CDP = await freePort();
const FFA_ID = "aB3dEfGh7K";
const TEAM_ID = "bT9mWq4xZp";
const PLAY_ID = "cP4yRk8sLm";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${String(detail).slice(0, 400)}` : ""}`);
};

// ---- the stand-in site -----------------------------------------------------------------
const site = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (req.url.startsWith(`/game/${FFA_ID}`)) return res.end(spectatorGamePage(FFA_ID));
  if (req.url.startsWith(`/game/${TEAM_ID}`)) return res.end(spectatorGamePage(TEAM_ID, { team: true }));
  // a game you PLAY: /game/<PLAY_ID>?role=spawning|eliminated|player
  if (req.url.startsWith(`/game/${PLAY_ID}`)) return res.end(playerGamePage(PLAY_ID, { role: new URL(req.url, "http://x").searchParams.get("role") ?? "player" }));
  res.end("<!doctype html><title>home</title><body>home</body>");
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${site.address().port}`;

// ---- launcher with seeded storage: ranks for some watched players, nothing looked up ------
const bgSource = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const CACHE_PREFIX = /const CACHE_PREFIX = "([^"]+)"/.exec(bgSource)[1];
const now = Date.now();
const rankInfo = (games, ratedWins, expectedWins) => ({ found: true, games, wins: ratedWins, winRate: (100 * ratedWins) / games, ratedGames: games, ratedWins, expectedWins, streak: 1, recentGames: [], maps: [], modes: [] });
const seeded = {
  "[lux] tena": rankInfo(412, 60, 31.5),
  "[ofp] kestrel": rankInfo(520, 260, 40),
  marlowe: rankInfo(300, 70, 30),
  "[un] mox": rankInfo(200, 30, 24),
  "hollow crown": rankInfo(150, 12, 14),
  tsarina: { found: false, reason: "no-history" },
  pike: { found: false, reason: "no-history" },
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofr-observer-"));
const appdata = path.join(tmp, "appdata");
fs.mkdirSync(path.join(appdata, "openfront-pro-launcher"), { recursive: true });
fs.writeFileSync(
  path.join(appdata, "openfront-pro-launcher", "storage.json"),
  JSON.stringify({
    sync: { dataConsent: true, themesMigrated: true, theme: "classic", streamerMode: false },
    local: Object.fromEntries(Object.entries(seeded).map(([k, v]) => [`${CACHE_PREFIX}${k}`, { value: v, expiresAt: now + 3600 * 1000 }])),
  }),
);
const out = [];
const launcher = spawn(process.execPath, [path.join(ROOT, "launcher/openfront-pro-launcher.cjs"), "--attach", `--port=${CDP}`], {
  env: { ...process.env, APPDATA: appdata, OFR_LAUNCHER_TEST_ORIGIN: `${ORIGIN}/` },
});
launcher.stdout.on("data", (d) => out.push(String(d)));
launcher.stderr.on("data", (d) => out.push(String(d)));
const chrome = spawn(CHROME, [`--user-data-dir=${path.join(tmp, "chrome")}`, `--remote-debugging-port=${CDP}`, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `${ORIGIN}/game/${FFA_ID}`], { stdio: "ignore" });
await wait(2500);
const base = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}/.exec(out.join(""))?.[0];
if (!base) throw new Error(`launcher did not start: ${out.join("")}`);
const api = (op, body) => fetch(`${base}/__api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, ...body }) }).then((r) => r.json()).then((r) => r.value);
const local = async (key) => (await api("storage.get", { area: "local", keys: [key] }))?.[key];
const sync = (items) => api("storage.set", { area: "sync", items });

// ---- CDP ---------------------------------------------------------------------------------
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
  await send("Page.enable");
  const evaluate = async (expression, contextId) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (r.result?.exceptionDetails) return `threw: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`;
    return r.result?.result?.value;
  };
  const inWorld = (expression) => {
    const ctx = [...contexts.values()].filter((c) => c.name === "OpenFront Pro").pop();
    return ctx ? evaluate(expression, ctx.id) : "no world";
  };
  const shot = async (name, { alpha = false } = {}) => {
    await send("Emulation.setDefaultBackgroundColorOverride", alpha ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
    const s = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.result.data, "base64"));
    console.log(`  shot ${name}.png`);
  };
  return { send, evaluate, inWorld, shot, close: () => ws.close() };
}
const until = async (fn, { tries = 60, every = 500 } = {}) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await wait(every);
  }
  return fn();
};

const game = await connect((u) => u.startsWith(`${ORIGIN}/game/`));
await game.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 30 && !/attached to the game window/.test(out.join("")); i++) await wait(300);
check("launcher attached to the stand-in game", /attached to the game window/.test(out.join("")));
await wait(1500);
check("page-probe 6 (observer mode, roster-based spectator) is in", (await game.evaluate("window.__ofrProbeVersion")) >= 6);

// ---- the caster feed and panel (FFA) --------------------------------------------------------------
console.log("watching a free-for-all");
const gameAttr = async () => {
  try {
    return JSON.parse((await game.evaluate("document.documentElement.dataset.ofrGame || 'null'")) || "null");
  } catch {
    return null; // mid-navigation
  }
};
const g0 = await until(async () => (await gameAttr())?.spectator === true && (await gameAttr()));
check("the probe says: watching, not playing", g0?.spectator === true && g0.alive === null && g0.over === false && g0.replay === false, JSON.stringify(g0));
check("stand-in: this client is on no roster, and isSpectator() is the client's own formula", (await game.evaluate("window.fakeGame.worker.gameStartInfo.players.every((p) => p.clientID !== window.fakeGame.myClientID()) && window.fakeGame.isSpectator() === true")) === true);
check("the extension asks for the caster feed (panel on)", (await until(async () => (await game.evaluate("document.documentElement.dataset.ofrCaster")) === "on")) === true);
await game.evaluate(`window.__casterMsgs = []; addEventListener("message", (e) => { if (e.source === window && e.data?.__ofr === "caster-state") window.__casterMsgs.push(e.data); }); 1`);
await wait(2600);
const feed = await game.evaluate("JSON.stringify(window.__casterMsgs.at(-1) ?? null)");
const msg = JSON.parse(feed || "null");
check("feed: once a second", (await game.evaluate("window.__casterMsgs.length")) >= 2);
check("feed: every player's shown name, team, land, state, colour", msg && msg.players.length >= 10 && msg.players.every((p) => Number.isInteger(p.sid) && typeof p.name === "string" && "alive" in p && Array.isArray(p.rgb)), feed?.slice(0, 300));
check("feed: never the raw names (p.static)", !feed.includes("RAW-"), "");
check("feed: a hidden name stays hidden", feed.includes("\u{1F464} Wolf Pack"));
const panel = () =>
  game.inWorld(`(() => {
    const p = document.querySelector(".ofr-caster");
    if (!p) return null;
    return {
      open: p.dataset.open,
      phase: p.dataset.phase,
      clock: p.querySelector(".ofr-caster-clock")?.textContent,
      count: p.querySelector(".ofr-caster-count")?.textContent,
      rows: [...p.querySelectorAll(".ofr-caster-row")].map((r) => ({ alive: r.dataset.alive, name: r.querySelector(".ofr-caster-name")?.textContent, masked: r.querySelector(".ofr-caster-name")?.dataset.masked === "true", badge: r.querySelector(".ofr-caster-badge")?.textContent ?? null, pct: r.querySelector(".ofr-caster-pct")?.textContent })),
      feed: [...p.querySelectorAll(".ofr-caster-out")].map((r) => [r.querySelector(".ofr-caster-time")?.textContent, r.querySelector(".ofr-caster-name")?.textContent]),
      teams: [...p.querySelectorAll(".ofr-caster-team")].map((r) => r.querySelector(".ofr-caster-name")?.textContent),
      text: p.innerText,
    };
  })()`);
let pv = await until(async () => {
  const v = await panel();
  return v && v.rows.length >= 6 && v.feed.length >= 2 ? v : null;
});
check("the caster panel opens by itself, docked", pv?.open === "true" && pv.phase === "watching", JSON.stringify(pv)?.slice(0, 200));
const shares = (pv?.rows ?? []).filter((r) => r.alive === "true").map((r) => parseFloat(r.pct));
check("leaderboard: by land, names as the game shows them", shares.length >= 5 && shares.every((v, i) => i === 0 || v <= shares[i - 1]) && pv.rows.some((r) => r.name === "\u{1F464} Wolf Pack") && pv.rows.some((r) => r.name === "[OFP] Kestrel"), JSON.stringify(pv?.rows));
check("rank badges from the lookup cache (seeded, nothing fetched)", pv?.rows.find((r) => r.name === "[OFP] Kestrel")?.badge?.startsWith("Top ") && !pv.rows.find((r) => r.name === "\u{1F464} Wolf Pack")?.badge, JSON.stringify(pv?.rows.map((r) => [r.name, r.badge])));
check("eliminations: humans and nations with their time, no bots", pv?.feed.some(([, n]) => n === "Anon42") && pv.feed.every(([, n]) => !/^Bot /.test(n)) && pv.feed.every(([t]) => /^\d+:\d\d$/.test(t)), JSON.stringify(pv?.feed));
check("clock and humans alive in the head", /^\d+:\d\d$/.test(pv?.clock ?? "") && /^\d+\/8$/.test(pv?.count ?? ""), `${pv?.clock} ${pv?.count}`);
check("no raw names in what the extension drew", !(await game.evaluate(`document.body.innerText + (document.querySelector(".ofr-caster")?.outerHTML ?? "")`)).includes("RAW-"));
check("the game's own element is untouched", (await game.evaluate("document.querySelector('player-panel')?.g === window.fakeGame && document.getElementById('view') !== null")) === true);

await game.send("Page.bringToFront");
await wait(1200);
await game.shot("caster-panel-classic-ffa");
await sync({ theme: "daylight" });
await wait(1500);
await game.shot("caster-panel-daylight-ffa");
await sync({ theme: "classic" });
await wait(800);

// fold / unfold, remembered
await game.inWorld(`document.querySelector(".ofr-caster-fold").click(); 1`);
await wait(500);
check("folds to a tab on the right edge", (await panel())?.open === "false" && (await local("casterFolded")) === true);
await game.shot("caster-panel-classic-folded");
await game.inWorld(`document.querySelector(".ofr-caster-tab").click(); 1`);
await wait(400);
check("...and opens again", (await panel())?.open === "true" && (await local("casterFolded")) === false);

// streamer mode: no player names, no ranks
await sync({ streamerMode: true });
pv = await until(async () => {
  const v = await panel();
  return v?.rows.some((r) => r.masked) ? v : null;
}, { tries: 10 });
check("streamer mode: human names and ranks gone, nations keep theirs", pv && !pv.text.includes("Kestrel") && !pv.text.includes("Marlowe") && pv.rows.every((r) => !r.badge) && (pv.feed.some(([, n]) => n === "France") || pv.rows.some((r) => r.name === "Ottoman Empire")), JSON.stringify(pv?.rows?.map((r) => r.name)));
await game.shot("caster-panel-classic-streamer");
await sync({ streamerMode: false });
await wait(1200);

// the switch: panel off and no overlay -> no feed at all
await sync({ casterPanel: false });
await wait(1500);
const before = await game.evaluate("window.__casterMsgs.length");
await wait(2500);
check("panel off, no overlay: panel gone and the probe quiet", (await panel()) === null && (await game.evaluate("document.documentElement.dataset.ofrCaster")) === "off" && (await game.evaluate("window.__casterMsgs.length")) === before, `${before} -> ${await game.evaluate("window.__casterMsgs.length")}`);
await sync({ casterPanel: true });
await until(async () => (await panel()) !== null, { tries: 10 });

// ---- the OBS caster overlay, with its delay ------------------------------------------------
console.log("caster overlay");
await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`${base}/src/overlay.html?w=caster&delay=10`)}`, { method: "PUT" });
const ov = await connect((u) => u.startsWith(`${base}/src/overlay.html`));
await ov.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await ov.send("Page.bringToFront");
const live = await until(async () => (await local("overlayLive"))?.caster?.board?.length && (await local("overlayLive")), { tries: 20 });
check("overlayLive carries the watched game's caster data", live?.gameId === FFA_ID && live.phase === "watching" && live.caster.board.length >= 6 && live.caster.feed.length >= 1, JSON.stringify(live)?.slice(0, 300));
check("...names as shown, never raw, ranks as bands only", JSON.stringify(live).includes("[OFP] Kestrel") && !JSON.stringify(live).includes("RAW-") && live.caster.board[0].band === "elite" && !("pct" in live.caster.board[0]));
const ovDom = () =>
  ov.evaluate(`(() => ({
    cards: [...document.querySelectorAll("#cards > .ov-card")].map((c) => c.className),
    delay: document.getElementById("delay").hidden ? null : document.getElementById("delay").textContent,
    clock: document.querySelector(".ov-caster .ov-clock")?.textContent ?? null,
    rows: [...document.querySelectorAll(".ov-crow .ov-cname")].map((n) => n.textContent),
    feed: [...document.querySelectorAll(".ov-out .ov-cname")].map((n) => n.textContent),
    replay: document.querySelector(".ov-replay img")?.src?.slice(0, 22) ?? null,
  }))()`);
let d = await ovDom();
check("delay 10: nothing yet, the badge says it is buffering", d.cards.length === 0 && /delayed 10s/.test(d.delay ?? "") && /buffering/.test(d.delay ?? ""), JSON.stringify(d));
await wait(10500);
d = await until(async () => {
  const v = await ovDom();
  return v.cards.some((c) => c.includes("ov-caster")) ? v : null;
}, { tries: 10 });
const nowLive = await local("overlayLive");
const toSecs = (c) => c.split(":").reduce((a, b) => a * 60 + Number(b), 0);
const lag = nowLive.seconds - toSecs(d?.clock ?? "0:00");
check("after 10 s: the caster card, from 10 s ago (200 game seconds behind at 20x)", d?.cards.some((c) => c.includes("ov-caster")) && lag > 150 && lag < 260, `shown ${d?.clock}, live ${nowLive.seconds}, lag ${lag}`);
check("the card: leaderboard and eliminations", d.rows.includes("[OFP] Kestrel") && d.feed.length >= 1, JSON.stringify(d));
check("the delay badge stays", d.delay === "delayed 10s");
// a busy "map" behind the transparent overlay, like a stream
const BACKDROP = `(() => {
  const c = document.createElement("canvas"); c.width = 960; c.height = 540;
  const g = c.getContext("2d"); let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = "#3f7fb5"; g.fillRect(0, 0, 960, 540);
  for (let i = 0; i < 26; i++) { g.fillStyle = ["#bfdc8a", "#c9c89c", "#d8cf9e", "#a9cf7c"][i % 4]; g.beginPath(); g.ellipse(r() * 960, r() * 540, 60 + r() * 170, 40 + r() * 110, r() * 3, 0, 7); g.fill(); }
  const cols = ["#e0443e", "#f2c12e", "#3b7be0", "#8e44ad", "#16a085", "#e67e22", "#ecf0f1", "#2c3e50"];
  for (let i = 0; i < 140; i++) { g.fillStyle = cols[i % cols.length]; g.globalAlpha = 0.85; g.fillRect(r() * 960, r() * 540, 8 + r() * 46, 8 + r() * 36); }
  document.body.style.background = "url(" + c.toDataURL() + ") center / cover";
  return 1;
})()`;
await ov.shot("overlay-caster-classic-delay-transparent", { alpha: true });
await ov.evaluate(BACKDROP);
await wait(400);
await ov.shot("overlay-caster-classic-delay-over-map");
await sync({ theme: "daylight" });
await ov.send("Page.navigate", { url: `${base}/src/overlay.html?w=caster&delay=0&bg=dark` });
await wait(2500);
await ov.shot("overlay-caster-daylight-dark");
await sync({ theme: "classic" });
// the default: 90 s with the caster card
await ov.send("Page.navigate", { url: `${base}/src/overlay.html?w=caster` });
await wait(2000);
d = await ovDom();
check("w=caster alone: 90 s late by default", d.delay === "delayed 90s · buffering" && d.cards.length === 0, JSON.stringify(d));
await ov.shot("overlay-caster-classic-default-90s-buffering", { alpha: true });
// #11: the default cards (no caster card) showing a game you WATCH: 90 s too
await ov.send("Page.navigate", { url: `${base}/src/overlay.html` });
await wait(2500);
d = await ovDom();
check("default cards, a watched game: 90 s late by default, nothing live yet", d.delay === "delayed 90s · buffering" && !d.cards.some((c) => c.includes("ov-live")), JSON.stringify(d));
await ov.send("Page.navigate", { url: `${base}/src/overlay.html?delay=0` });
await wait(2500);
d = await ovDom();
check("...delay=0 in the address wins: the live card at once", d.delay === null && d.cards.some((c) => c.includes("ov-live")), JSON.stringify(d));
// masked page: no names on the card, whatever arrives
await ov.send("Page.navigate", { url: `${base}/src/overlay.html?w=caster&delay=0&name=0` });
await until(async () => (await local("overlayMask")) > 0, { tries: 10 });
const maskedLive = await until(async () => {
  const l = await local("overlayLive");
  return l?.caster?.board?.every((r) => r.name === null || r.name === "France" || r.name === "Ottoman Empire") ? l : null;
}, { tries: 12 });
d = await ovDom();
check("name=0: the tab sends no player names, the card shows none", !!maskedLive && !JSON.stringify(maskedLive).includes("Kestrel") && !d.rows.includes("[OFP] Kestrel"), JSON.stringify(d.rows));
// settings panel with the caster options
await ov.send("Page.navigate", { url: `${base}/src/overlay.html?w=caster&edit=1&bg=dark` });
await wait(2200);
check("settings: caster chip, replay switch, delay 90", (await ov.evaluate(`document.querySelector('[data-w="caster"]').getAttribute("aria-pressed") === "true" && document.getElementById("ed-replay-on").getAttribute("aria-pressed") === "true" && document.getElementById("ed-delay").value === "90"`)) === true);
await ov.shot("overlay-caster-classic-edit");

// ---- a game you PLAY: never the caster feed (the client's isSpectator() says yes) ----------------
console.log("playing, not watching");
await ov.send("Page.navigate", { url: `${base}/src/overlay.html` });
for (const role of ["spawning", "eliminated"]) {
  await game.send("Page.navigate", { url: `${ORIGIN}/game/${PLAY_ID}?role=${role}` });
  const g = await until(async () => {
    const v = await gameAttr();
    return v && v.running ? v : null;
  }, { tries: 20 });
  await wait(1500);
  await game.evaluate(`window.__casterMsgs = []; addEventListener("message", (e) => { if (e.source === window && e.data?.__ofr === "caster-state") window.__casterMsgs.push(e.data); }); 1`);
  await wait(2500);
  check(`${role}: the stand-in's own isSpectator() is true (the trap)`, (await game.evaluate("window.fakeGame.isSpectator()")) === true);
  check(`${role}: the probe says playing, not watching`, g?.spectator === false && (role === "spawning" ? g.spawn === true && g.alive === null : g.alive === false), JSON.stringify(g));
  check(`${role}: no caster feed asked for, none sent, no panel`, (await game.evaluate("document.documentElement.dataset.ofrCaster")) === "off" && (await game.evaluate("window.__casterMsgs.length")) === 0 && (await panel()) === null);
  const phase = role === "spawning" ? "spawn" : "out";
  const l = await until(async () => {
    const v = await local("overlayLive");
    return v?.gameId === PLAY_ID && v.phase === phase ? v : null;
  }, { tries: 20 });
  check(`${role}: the overlay gets your game, no caster data`, l && !l.caster, JSON.stringify(l ?? (await local("overlayLive")))?.slice(0, 200));
  if (role === "spawning") {
    check("spawning: the clock is the game's (0), not ticks / 10", l?.seconds === 0, `seconds ${l?.seconds}`);
    // the watched game before it is still playing out 90 s late on this page; a page
    // opened now has only your own game: no delay
    await ov.send("Page.navigate", { url: `${base}/src/overlay.html` });
    d = await until(async () => {
      const v = await ovDom();
      return v?.cards?.some?.((c) => c.includes("ov-live")) ? v : null; // (mid-navigation: not yet)
    }, { tries: 10 });
    check("your own game, default cards: no delay", d?.delay === null, JSON.stringify(d ?? (await ovDom())));
  }
}

// ---- a team game ------------------------------------------------------------------------------
console.log("watching a team game");
await game.send("Page.navigate", { url: `${ORIGIN}/game/${TEAM_ID}` });
await ov.send("Page.navigate", { url: `${base}/src/overlay.html?w=caster&delay=0` });
pv = await until(async () => {
  const v = await panel();
  return v && Array.isArray(v.teams) && v.teams.length === 4 && v.feed.length >= 1 ? v : null;
}, { tries: 40 });
check("team view: four teams with land, alive and totals", pv?.teams.join() !== undefined && ["Red", "Blue", "Yellow", "Green"].every((t) => pv.teams.includes(t)), JSON.stringify(pv?.teams));
const tlive = await until(async () => (await local("overlayLive"))?.caster?.teamGame && (await local("overlayLive")), { tries: 20 });
check("overlay: team totals too", tlive?.gameId === TEAM_ID && tlive.caster.teams.length === 4 && tlive.caster.teams.every((t) => t.total >= 2), JSON.stringify(tlive?.caster?.teams));
await game.send("Page.bringToFront");
await wait(1000);
await game.shot("caster-panel-classic-team");
await sync({ theme: "daylight" });
await wait(1500);
await game.shot("caster-panel-daylight-team");
await sync({ theme: "classic" });
await ov.send("Page.bringToFront");
await wait(1500);
await ov.evaluate(BACKDROP);
await wait(400);
await ov.shot("overlay-caster-classic-team-over-map");

// ---- the replay GIF -----------------------------------------------------------------------
console.log("replay");
check("no replay while the game runs", !(await local("overlayReplay")));
// a few more minutes of the game in the timelapse (one frame a second here)
await until(async () => (await game.inWorld("globalThis.OFR_LAPSE.count()")) >= 18, { tries: 30, every: 1000 });
const frames = await game.inWorld("globalThis.OFR_LAPSE.count()");
check("the timelapse recorded the watched game", frames >= 8, `${frames} frames`);
await game.evaluate("window.__standinOver = true; 1");
const replay = await until(async () => {
  const r = await local("overlayReplay");
  return r?.gif ? r : null;
}, { tries: 90 });
check("game over: the tab makes the replay GIF", replay?.gameId === TEAM_ID && /^data:image\/gif;base64,/.test(replay.gif) && replay.streamer === false, replay ? `${replay.gif.length} chars` : "none");
check("...within the size cap (1.5 MB)", replay && replay.gif.length <= 1_500_000);
if (replay?.gif) fs.writeFileSync(path.join(OUT, "replay.gif"), Buffer.from(replay.gif.split(",")[1], "base64"));
const g1 = await gameAttr();
check("the probe says: over", g1?.over === true);
d = await until(async () => {
  const v = await ovDom();
  return v.replay ? v : null;
}, { tries: 20 });
check("the overlay plays it (caster variant: right after the game)", d?.replay === "data:image/gif;base64," && d.cards.some((c) => c.includes("ov-replay")), JSON.stringify(d));
await wait(1800); // a few frames in
await ov.shot("overlay-replay-classic-over-map");
await sync({ theme: "daylight" });
await ov.send("Page.navigate", { url: `${base}/src/overlay.html?w=caster&delay=0&bg=dark` });
await wait(3500);
await ov.shot("overlay-replay-daylight-dark");
await sync({ theme: "classic" });
// masking, like the recap card
await sync({ streamerMode: true });
const maskedReplay = await until(async () => {
  const r = await local("overlayReplay");
  return r?.streamer === true && r.gif ? r : null;
}, { tries: 60 });
check("streamer mode: the replay is made again, masked, same timer", maskedReplay?.at === replay?.at && maskedReplay.gif !== replay.gif, maskedReplay ? "masked" : "none");
await sync({ streamerMode: false });
await until(async () => (await local("overlayReplay"))?.streamer === false, { tries: 60 });
// replay=0: off
await ov.send("Page.navigate", { url: `${base}/src/overlay.html?w=caster&delay=0&replay=0` });
await wait(2000);
check("replay=0: not shown", (await ovDom()).replay === null);
// the next game: the old replay never shows over it
await game.evaluate("window.__standinOver = false; 1");
await game.send("Page.navigate", { url: `${ORIGIN}/game/${FFA_ID}` });
await ov.send("Page.navigate", { url: `${base}/src/overlay.html?w=caster&delay=0` });
await until(async () => (await local("overlayLive"))?.gameId === FFA_ID, { tries: 30 });
await wait(1500);
d = await ovDom();
check("a new game being watched: its card, not the old replay", d.replay === null && d.cards.some((c) => c.includes("ov-caster")), JSON.stringify(d.cards));
// closing the overlay removes it all (the recap card's rule)
await ov.send("Page.navigate", { url: "about:blank" });
await api("storage.set", { area: "local", items: { overlayEnabled: Date.now() - 200000 } });
const cleared = await until(async () => !(await local("overlayReplay")) && !(await local("overlayLive")), { tries: 30 });
check("no overlay any more: overlayReplay removed with the rest", cleared === true);

// ---- the observer page, against a stubbed worker ------------------------------------------------
console.log("observer page");
await ov.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
const t = Date.now();
const STARTED = { id: FFA_ID, route: "ok", exists: true, fetchedAt: t, info: { gameConfig: { gameMap: "Europe", gameMode: "Free For All", maxPlayers: 50 }, clients: [...Array(41).fill({ spectator: false }), ...Array(3).fill({ spectator: true })], startsAt: t - 754000, serverTime: t } };
const LOBBY_INFO = { gameConfig: { gameMap: "World", gameMode: "Team", playerTeams: 4, maxPlayers: 40, gameType: "Private" }, clients: Array(17).fill({ spectator: false }), serverTime: t };
// a countdown (startsIn: seconds from each answer), no start time at all, nobody playing
const WAITING = { id: TEAM_ID, route: "ok", exists: true, fetchedAt: t, info: { ...LOBBY_INFO, startsIn: 45 } };
const UNKNOWN = { id: TEAM_ID, route: "ok", exists: true, fetchedAt: t, info: { ...LOBBY_INFO, startsAt: null } };
const EMPTY = { id: TEAM_ID, route: "ok", exists: true, fetchedAt: t, info: { ...LOBBY_INFO, clients: [{ spectator: true }] } };
// The page's own chrome.* is replaced for the worker's answer and for opening a tab:
// nothing reaches OpenFront, nothing is opened.
const stub = (answer) =>
  ov.evaluate(`(() => {
    window.__opened = window.__opened ?? [];
    window.__asked = window.__asked ?? [];
    window.__answer = ${JSON.stringify(answer)};
    if (!window.__stubbed) {
      window.__stubbed = true;
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (m) => {
        if (m?.type === "observerCheck") { window.__asked.push(m.gameId); const a = window.__answer; return Promise.resolve(a && a.info ? { ...a, fetchedAt: Date.now(), info: { ...a.info, serverTime: Date.now(), startsAt: a.info.startsAt === null ? null : a.info.startsIn != null ? Date.now() + a.info.startsIn * 1000 : Date.now() - 754000 } } : a); }
        if (m?.type === "notify") { window.__notified = m; return Promise.resolve(); }
        return real(m);
      };
      chrome.tabs.create = async ({ url }) => { window.__opened.push(url); };
    }
    return 1;
  })()`);
const obDom = () =>
  ov.evaluate(`(() => ({
    state: document.getElementById("ob-game").dataset.state ?? null,
    hidden: document.getElementById("ob-game").hidden,
    status: document.getElementById("ob-status").textContent,
    tiles: [...document.querySelectorAll(".ob-tile-val")].map((t) => t.textContent),
    buttons: [...document.querySelectorAll("#ob-actions button")].map((b) => b.textContent + (b.disabled ? " (off)" : "")),
    warn: document.getElementById("ob-warn").hidden ? null : document.getElementById("ob-warn").textContent,
    remind: document.getElementById("ob-remind").hidden ? null : document.getElementById("ob-remind").textContent,
    hint: document.getElementById("ob-hint").textContent,
    opened: window.__opened ?? [],
    asked: window.__asked ?? [],
  }))()`);
const ask = (text) => ov.evaluate(`(() => { const i = document.getElementById("ob-link"); i.value = ${JSON.stringify(text)}; document.getElementById("ob-form").requestSubmit(); return 1; })()`);
for (const theme of ["classic", "daylight"]) {
  await sync({ theme });
  await ov.send("Page.navigate", { url: `${base}/src/observer.html` });
  await wait(1500);
  await stub(STARTED);
  await ask(`https://openfront.io/game/${FFA_ID}`);
  let o = await until(async () => {
    const v = await obDom();
    return v.state === "started" ? v : null;
  }, { tries: 10 });
  check(`${theme}: started game -> Live, map, mode, players, Watch`, o?.status.startsWith("Live · 12:3") && o.tiles.includes("Europe") && o.tiles.includes("FFA") && o.tiles.includes("41/50") && o.buttons.includes("Watch"), JSON.stringify(o));
  check(`${theme}: only the id was asked for, nothing opened by itself`, eq(o?.asked, [FFA_ID]) && o.opened.length === 0);
  await ov.shot(`observer-${theme}-started`);
  if (theme === "classic") {
    await ov.evaluate(`[...document.querySelectorAll("#ob-actions button")].find((b) => b.textContent === "Watch").click(); 1`);
    check("Watch opens the game's plain link in a new tab (caught by the stub)", eq((await obDom()).opened, [`https://openfront.io/game/${FFA_ID}`]));
  }
  await stub(WAITING);
  await ask(`https://openfront.io/#join=${TEAM_ID}`);
  o = await until(async () => {
    const v = await obDom();
    return v.state === "countdown" ? v : null;
  }, { tries: 10 });
  check(`${theme}: a lobby -> the warning, Remind me, Open lobby anyway`, /joins the lobby as a player/.test(o?.warn ?? "") && /^Starts in 0:4\d$/.test(o.status) && o.buttons.includes("Remind me when it starts") && o.buttons.includes("Open lobby anyway") && !o.buttons.includes("Watch") && o.tiles.includes("17/40") && o.tiles.includes("4 teams"), JSON.stringify(o));
  check(`${theme}: a lobby is never opened by itself`, o?.opened.length === (theme === "classic" ? 1 : 0));
  await ov.shot(`observer-${theme}-waiting`);
  await ov.evaluate(`[...document.querySelectorAll("#ob-actions button")].find((b) => b.textContent === "Remind me when it starts").click(); 1`);
  await wait(1200);
  o = await obDom();
  check(`${theme}: reminder running, with its schedule`, /Next check in \d+ s · gives up in 29:5\d/.test(o.remind ?? ""), o.remind);
  await ov.shot(`observer-${theme}-remind`);
  if (theme === "classic") {
    // the lobby starts: the reminder's next check (15 s) finds it running
    await stub({ ...STARTED, id: TEAM_ID });
    o = await until(async () => {
      const v = await obDom();
      return v.state === "started" ? v : null;
    }, { tries: 24, every: 1000 });
    check("reminder: it started -> Watch offered, a notification, still nothing opened", o?.buttons.includes("Watch") && o.remind === null && o.opened.length === 1 && (await ov.evaluate("!!window.__notified")) === true && (await ov.evaluate("document.title")).startsWith("● Live"), JSON.stringify(o));
    // #5: no start time -> state unknown, Check again, no Watch
    await stub(UNKNOWN);
    await ask(TEAM_ID);
    o = await until(async () => {
      const v = await obDom();
      return v.state === "unknown" ? v : null;
    }, { tries: 10 });
    check("no start time: 'State unknown', Check again, no Watch", o?.status === "State unknown" && /No start time/.test(o.warn ?? "") && o.buttons.includes("Check again") && !o.buttons.includes("Watch"), JSON.stringify(o));
    await ov.shot("observer-classic-unknown");
    // #3: past the start time, nobody playing -> no Watch
    await stub(EMPTY);
    await ask(TEAM_ID);
    o = await until(async () => {
      const v = await obDom();
      return v.state === "empty" ? v : null;
    }, { tries: 10 });
    check("nobody playing: 'No one is playing', no Watch", o?.status === "No one is playing" && !o.buttons.some((b) => b.startsWith("Watch")), JSON.stringify(o));
    // #6: a countdown that runs out shows "Starting…", not 0:00
    await stub({ ...WAITING, info: { ...WAITING.info, startsIn: 1 } });
    await ask(TEAM_ID);
    await wait(2600);
    const ranOut = (await obDom()).status;
    check("a countdown that ran out: 'Starting…' until the re-check", ranOut === "Starting…", ranOut);
    // #8: one reminder per game across observer tabs - the newest takes over
    await stub(WAITING);
    await ask(TEAM_ID);
    await until(async () => (await obDom()).state === "countdown", { tries: 10 });
    await ov.evaluate(`[...document.querySelectorAll("#ob-actions button")].find((b) => b.textContent === "Remind me when it starts").click(); 1`);
    await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`${base}/src/observer.html#second`)}`, { method: "PUT" });
    const ob2 = await connect((u) => u === `${base}/src/observer.html#second`);
    await wait(1500);
    await ob2.evaluate(`(() => { chrome.runtime.sendMessage = (m) => m?.type === "observerCheck" ? Promise.resolve({ id: ${JSON.stringify(TEAM_ID)}, route: "ok", exists: true, fetchedAt: Date.now(), info: { gameConfig: { gameMap: "World", maxPlayers: 40 }, clients: Array(17).fill({ spectator: false }), serverTime: Date.now(), startsAt: Date.now() + 45000 } }) : Promise.resolve(); const i = document.getElementById("ob-link"); i.value = ${JSON.stringify(TEAM_ID)}; document.getElementById("ob-form").requestSubmit(); return 1; })()`);
    await wait(1500);
    await ob2.evaluate(`[...document.querySelectorAll("#ob-actions button")].find((b) => b.textContent === "Remind me when it starts").click(); 1`);
    await wait(1000);
    const first = await obDom();
    const second = await ob2.evaluate(`document.getElementById("ob-remind").hidden`);
    check("a second observer tab reminding of the same game: the first one stops and says so", first.remind === null && /another observer tab/.test(await ov.evaluate(`document.getElementById("ob-actions").textContent`)) && second === false, JSON.stringify(first));
    ob2.close();
    await ask("hello there");
    check("not a link: said so", /not a game link/.test((await obDom()).hint));
    await stub({ error: "consent" });
    await ask(FFA_ID);
    o = await until(async () => {
      const v = await obDom();
      return v.state === "consent" ? v : null;
    }, { tries: 10 });
    check("lookups not agreed: nothing checked, a way to agree", o?.buttons.includes("Read and turn on"), JSON.stringify(o));
  }
}
await sync({ theme: "classic" });

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
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
