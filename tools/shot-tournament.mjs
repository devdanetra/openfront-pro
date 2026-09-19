// Dev tool. Screenshots every view of the tournament page (src/tournament.html)
// with made-up tournaments built from the real records in .recap/, served by the
// launcher's local server (so chrome.* works without installing anything) in a
// headless Chrome driven over the DevTools protocol. Never touches openfront.io;
// the launcher's worker fetches ONE record live from api.openfront.io (the rest
// are pre-seeded into the record cache, which is what a returning user has).
//   node tools/shot-tournament.mjs [outDir]      (SHOT_SCALE=2 env: device pixel ratio 2)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ROOT, loadCore, loadRecords, demoTournaments } from "./tournament-fixtures.mjs";

const OUT = process.argv[2] ?? path.join(ROOT, ".shots", "tournament");
const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// free ports, never fixed ones: other dev tools drive headless Chromes too, and
// two on one debugging port end up steering each other's tabs
const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
const SCALE = Number(process.env.SHOT_SCALE ?? 1);
const LIVE_ID = "dVLrYJEaGm"; // fetched through the worker, not pre-seeded
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const { normaliseRecord, T } = loadCore();
const { slim } = loadRecords(normaliseRecord, T);
const demo = demoTournaments(T);
// text-fit stress: the longest title and names validation allows, 12 players (byes)
const long = (i) => `${["Supercalifragilistic", "Extraordinarily", "Magnificent"][i % 3]} Commander Number ${i + 1}xx`.slice(0, 40);
const stress = {
  ...demo.cup,
  id: "demostress1",
  name: "The Unreasonably Long Invitational Championship Grand Finals",
  participants: [...demo.cup.participants, ...Array.from({ length: 4 }, (_, i) => ({ id: `px${i}`, name: long(i), tags: [], members: [], color: i % 6 }))].map((p, i) => (i === 2 ? { ...p, name: "Averyveryverylongsinglewordwithoutspace1" } : p)),
  overrides: {},
};
// two players: the smallest bracket image (champion box vs footer)
const duel = { ...demo.cup, id: "demoduel001", name: "Grudge Match", participants: demo.cup.participants.filter((p) => ["p1", "p8"].includes(p.id)), games: [{ id: "HPeHLRqX", assign: {} }], overrides: [] };
// best of 5 after three games: two slots unplayed (their outline must show)
const bo5 = { ...demo.bo3, id: "demoseries5", name: "UN vs ITA · Best of 5", bestOf: 5 };
// 21 games no cache holds: the page must wait for a click before fetching
const gate = { ...demo.league, id: "demogate001", name: "Big import", games: Array.from({ length: 21 }, (_, i) => ({ id: `Zz${String(i).padStart(2, "0")}x9Qk`, assign: {} })) };
const tournaments = [demo.league, demo.cup, demo.bo3, demo.clans, stress, duel, bo5, gate].map((t) => {
  const v = T.validateTournament(JSON.parse(JSON.stringify(t)));
  if (!v.ok) throw new Error(`${t.name}: ${v.error}`);
  return v.value;
});

// oldFormat: the single "tournaments" list of earlier builds (the page moves it
// to one key each), with one entry an older build let a U+200E through: it must
// be kept and listed as damaged, not dropped
function seedLocal({ withLive = false, oldFormat = false } = {}) {
  const local = { tournamentLast: tournaments[0].id, tRecIdx: {} };
  if (oldFormat) {
    const damaged = { ...JSON.parse(JSON.stringify(tournaments[0])), id: "damaged001", name: `Spring Cup${String.fromCharCode(0x200e)}` };
    local.tournaments = [...tournaments, damaged];
  } else {
    for (const t of tournaments) local[`tournament:${t.id}`] = t;
    local.tournamentIdx = tournaments.map((t) => t.id);
  }
  for (const [id, rec] of slim) {
    if (id === LIVE_ID && !withLive) continue;
    local[`tRec:${id}`] = JSON.parse(JSON.stringify(rec));
    local.tRecIdx[id] = [Date.now(), JSON.stringify(rec).length];
  }
  return local;
}

async function session({ theme, consent = true, oldFormat = false }) {
  const CDP = await freePort();
  const GAME_PORT = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofr-tourney-"));
  const appdata = path.join(tmp, "appdata", "openfront-pro-launcher");
  fs.mkdirSync(appdata, { recursive: true });
  fs.writeFileSync(path.join(appdata, "storage.json"), JSON.stringify({ sync: { dataConsent: consent, themesMigrated: true, theme }, local: seedLocal({ oldFormat }) }));
  const out = [];
  const launcher = spawn(process.execPath, [path.join(ROOT, "launcher/openfront-pro-launcher.cjs"), "--attach", `--port=${GAME_PORT}`], { env: { ...process.env, APPDATA: path.join(tmp, "appdata") } });
  launcher.stdout.on("data", (d) => out.push(String(d)));
  launcher.stderr.on("data", (d) => out.push(String(d)));
  let base = null;
  for (let i = 0; i < 40 && !base; i++) {
    await wait(200);
    base = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}/.exec(out.join(""))?.[0];
  }
  if (!base) throw new Error("launcher did not start: " + out.join(""));
  const chrome = spawn(CHROME, [`--user-data-dir=${path.join(tmp, "chrome")}`, `--remote-debugging-port=${CDP}`, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
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
  const logs = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.exceptionThrown") logs.push(`EXCEPTION ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    else if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") logs.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
  });
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const close = async () => {
    ws.close();
    chrome.kill();
    launcher.kill();
    await wait(600);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Chrome may still hold its profile
    }
  };
  return { base, send, evaluate, close, logs };
}

async function shoot(s, name, width) {
  await s.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: SCALE, mobile: false });
  await wait(250);
  const m = await s.send("Page.getLayoutMetrics");
  const size = m.result.cssContentSize;
  const height = Math.min(6000, Math.ceil(size.height));
  const overflow = await s.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth");
  const shot = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }); // the clip is in CSS px; SCALE comes from the device metrics
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.result.data, "base64"));
  console.log(`${name}.png${overflow ? "  !! horizontal overflow" : ""}`);
}
const click = (s, k) => s.evaluate(`(() => { const b = document.querySelector('[data-k="${k}"]'); if (b) b.click(); return !!b; })()`);
const pick = (s, id) => s.evaluate(`(() => { const p = document.getElementById("tn-pick"); p.value = "${id}"; p.dispatchEvent(new Event("change")); return p.value; })()`);
async function savePreview(s, name) {
  await click(s, "tab:share");
  await wait(500);
  const data = await s.evaluate(`document.querySelector("canvas.tn-preview")?.toDataURL("image/png").split(",")[1] ?? null`);
  if (data) {
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`${name}.png (results image)`);
  }
}

for (const theme of ["classic", "daylight"]) {
  const s = await session({ theme, oldFormat: theme === "classic" });
  await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await s.send("Page.navigate", { url: `${s.base}/src/tournament.html` });
  await wait(2500);
  if (theme === "classic") {
    const moved = await s.evaluate(`chrome.storage.local.get(null).then((a) => ({ old: "tournaments" in a, keys: Object.keys(a).filter((k) => k.startsWith("tournament:")).length }))`);
    console.log(`migration: old key left = ${moved?.old}, tournament keys = ${moved?.keys}`);
    await shoot(s, `${theme}-1280-damaged-banner`, 1280);
    // delete it (two presses), so the other shots are not about it
    const rm = `(() => { const b = document.querySelector('#tn-damaged [data-k$=":rm"]'); if (b) b.click(); return !!b; })()`;
    await s.evaluate(rm);
    await wait(200);
    await s.evaluate(rm);
    await wait(400);
    const left = await s.evaluate(`chrome.storage.local.get(null).then((a) => Object.keys(a).filter((k) => k.startsWith("tournament:")).length)`);
    console.log(`after deleting the damaged one: tournament keys = ${left}`);
  }
  for (const width of [1280, 720]) {
    const tag = `${theme}-${width}`;
    // league
    await pick(s, tournaments[0].id);
    await wait(400);
    await click(s, "tab:standings");
    await wait(300);
    await shoot(s, `${tag}-league-standings`, width);
    await click(s, `row:pa`);
    await wait(200);
    await shoot(s, `${tag}-league-standings-expanded`, width);
    await click(s, `row:pa`);
    await click(s, "tab:games");
    await wait(300);
    await click(s, "game:5S99ULQP");
    await wait(200);
    await shoot(s, `${tag}-league-games`, width);
    await click(s, "game:5S99ULQP");
    await click(s, "tab:setup");
    await wait(300);
    await shoot(s, `${tag}-league-setup`, width);
    await click(s, "tab:share");
    await wait(600);
    await shoot(s, `${tag}-league-share`, width);
    // bracket
    await pick(s, tournaments[1].id);
    await wait(2500); // the live record
    await click(s, "tab:bracket");
    await wait(300);
    await click(s, "ovr:r2m1");
    await wait(200);
    await shoot(s, `${tag}-bracket`, width);
    await click(s, "ovr:r2m1");
    await click(s, "tab:games");
    await wait(300);
    await shoot(s, `${tag}-bracket-games`, width);
    await click(s, "tab:setup");
    await wait(300);
    await shoot(s, `${tag}-bracket-setup`, width);
    // series
    await pick(s, tournaments[2].id);
    await wait(400);
    await click(s, "tab:series");
    await wait(300);
    await shoot(s, `${tag}-series`, width);
    // clans
    await pick(s, tournaments[3].id);
    await wait(400);
    await click(s, "tab:standings");
    await wait(300);
    await shoot(s, `${tag}-clans-standings`, width);
    if (width === 1280) {
      await pick(s, tournaments[0].id);
      await wait(300);
      await savePreview(s, `${theme}-results-league`);
      await pick(s, tournaments[1].id);
      await wait(300);
      await savePreview(s, `${theme}-results-bracket`);
      await pick(s, tournaments[2].id);
      await wait(300);
      await savePreview(s, `${theme}-results-series`);
      await pick(s, tournaments[3].id);
      await wait(300);
      await savePreview(s, `${theme}-results-clans`);
      await pick(s, tournaments[4].id);
      await wait(300);
      await savePreview(s, `${theme}-results-stress-bracket`);
      await pick(s, tournaments[5].id);
      await wait(300);
      await savePreview(s, `${theme}-results-duel-bracket`);
      await pick(s, tournaments[6].id);
      await wait(300);
      await click(s, "tab:series");
      await wait(300);
      await shoot(s, `${tag}-series-bo5`, width);
      await pick(s, tournaments[7].id);
      await wait(600);
      await click(s, "tab:games");
      await wait(300);
      await shoot(s, `${tag}-fetch-gate`, width);
      await pick(s, tournaments[4].id);
      await wait(300);
      await click(s, "tab:bracket");
      await wait(300);
      await shoot(s, `${tag}-stress-bracket`, width);
    }
    if (width === 720) {
      await pick(s, tournaments[4].id);
      await wait(300);
      await click(s, "tab:standings");
      await wait(300);
      await shoot(s, `${tag}-stress-standings`, width);
    }
  }
  // a share link opened in this page (the league's own link)
  const hash = await s.evaluate(`(async () => (await OFR_TOURNEY.encodeShare((await chrome.storage.local.get("tournament:${tournaments[0].id}"))["tournament:${tournaments[0].id}"])).hash)()`);
  if (hash) {
    await s.send("Page.navigate", { url: `${s.base}/src/tournament.html${hash}` });
    await wait(1500);
    await shoot(s, `${theme}-1280-shared-link`, 1280);
  }
  // an empty page (no tournaments) and a brand-new one
  await s.evaluate(`chrome.storage.local.get(null).then((a) => chrome.storage.local.remove(Object.keys(a).filter((k) => k.startsWith("tournament:") || k === "tournamentIdx")))`);
  await s.send("Page.navigate", { url: `${s.base}/src/tournament.html` });
  await wait(1200);
  await shoot(s, `${theme}-720-empty`, 720);
  await click(s, "none-new");
  await wait(400);
  await shoot(s, `${theme}-720-new-setup`, 720);
  if (s.logs.length) console.log(s.logs.join("\n"));
  await s.close();
}

// lookups not agreed: the banner, and games waiting for it
{
  const s = await session({ theme: "classic", consent: false });
  await s.send("Page.navigate", { url: `${s.base}/src/tournament.html` });
  await wait(1500);
  await pick(s, tournaments[1].id);
  await wait(500);
  await click(s, "tab:games");
  await wait(300);
  await shoot(s, "classic-1280-consent-off", 1280);
  if (s.logs.length) console.log(s.logs.join("\n"));
  await s.close();
}
process.exit(0);
