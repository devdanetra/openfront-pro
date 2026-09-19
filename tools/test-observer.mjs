// Observer mode's pure half (src/observer-core.js) in node: which game a pasted
// link names (through tournament-core.js's parser, as on the observer page, and
// without it), the route to the game's server, what OpenFront's gameInfo says, the
// reminder's schedule, and the caster data (leaderboard reducer, eliminations
// feed, team totals, masking). Then the worker's observerCheck (background.js,
// between its <observer-check> markers) against a stand-in fetch: nothing here
// touches the network.
//
//   node tools/test-observer.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { seatModel } from "./standin-game.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
function load(files) {
  const sandbox = { console, URL, URLSearchParams, TextEncoder, TextDecoder };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(src(f), sandbox, { filename: f });
  return sandbox;
}
const withParser = load(["src/tournament-core.js", "src/observer-core.js"]);
const alone = load(["src/observer-core.js"]);
const O = withParser.OFR_OBSERVER;

let failures = 0;
let total = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (v) => JSON.parse(JSON.stringify(v));
function check(name, ok, detail = "") {
  total++;
  if (!ok) failures++;
  if (!ok) console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
}

console.log("links");
for (const [label, core] of [["with tournament-core.js", O], ["alone", alone.OFR_OBSERVER]]) {
  const id = (s) => core.parseLink(s).id;
  check(`${label}: game link`, id("https://openfront.io/game/aB3dEfGh7K") === "aB3dEfGh7K");
  check(`${label}: worker path`, id("https://openfront.io/w3/game/aB3dEfGh7K") === "aB3dEfGh7K");
  check(`${label}: lobby link #join=`, id("https://openfront.io/#join=aB3dEfGh7K") === "aB3dEfGh7K");
  check(`${label}: /join/<id>`, id("https://openfront.io/join/aB3dEfGh7K") === "aB3dEfGh7K");
  check(`${label}: bare id (10 and 8 characters)`, id("aB3dEfGh7K") === "aB3dEfGh7K" && id("5S99ULQP") === "5S99ULQP");
  check(`${label}: surrounding text and spaces`, id("  come watch: https://openfront.io/game/aB3dEfGh7K  ") === "aB3dEfGh7K");
  check(`${label}: a link with a query and a hash`, id("https://openfront.io/game/aB3dEfGh7K?x=1#y") === "aB3dEfGh7K");
  check(`${label}: other sites refused`, id("https://evil.example/game/aB3dEfGh7K") === null);
  check(`${label}: too short / too long / junk`, id("abc") === null && id("aB3dEfGh7K1234") === null && id("") === null && id("https://openfront.io/game/../x") === null);
  check(`${label}: empty says so`, core.parseLink("   ").error === "empty" && core.parseLink(null).error === "empty");
  check(`${label}: a malformed link does not throw`, core.parseLink("https://openfront.io/game/%E0%A4%A").id === null);
}
check("with the tournament parser: a chat word is not an id", O.parseLink("everyone").id === null && O.parseLink("Wellplayed").id === null);
check("...and ?gameId= works", O.parseLink("https://openfront.io/?gameId=aB3dEfGh7K").id === "aB3dEfGh7K");
check("watch address: the plain /game/<id> link", O.watchUrl("aB3dEfGh7K") === "https://openfront.io/game/aB3dEfGh7K" && O.watchUrl("../x") === null && O.watchUrl(5) === null);

console.log("route");
{
  // OpenFront's simpleHash (src/core/Util.ts) against an independent 32-bit version
  const ref = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  const ids = ["aB3dEfGh7K", "bzzzzzzzzz", "5S99ULQP", "d4tvvVquk6", "a", "", "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"];
  check("simpleHash = hash * 31 + c, 32-bit, abs", ids.every((s) => O.simpleHash(s) === ref(s)), JSON.stringify(ids.map((s) => [O.simpleHash(s), ref(s)])));
  const cluster = { servers: { a: { host: "blue.openfront.io", numWorkers: 16, version: "abc1234", state: "open" }, b: { host: "evil.example", numWorkers: 4 }, c: { host: "green.openfront.io", numWorkers: 0 }, d: { host: "x.openfront.io.evil.example", numWorkers: 2 } } };
  const r = plain(O.gameRoute("aB3dEfGh7K", cluster));
  const w = ref("aB3dEfGh7K") % 16;
  check("the id's letter names the server, the hash the worker", r.kind === "ok" && r.host === "blue.openfront.io" && r.worker === w && r.exists === `https://blue.openfront.io/w${w}/api/game/aB3dEfGh7K/exists` && r.info === `https://blue.openfront.io/w${w}/api/game/aB3dEfGh7K`, JSON.stringify(r));
  check("only openfront.io hosts (the extension's own host access)", O.gameRoute("bB3dEfGh7K", cluster).kind === "unsupported" && O.gameRoute("dB3dEfGh7K", cluster).kind === "unsupported");
  check("a broken worker count", O.gameRoute("cB3dEfGh7K", cluster).kind === "unsupported");
  check("an unknown letter", O.gameRoute("xB3dEfGh7K", cluster).kind === "unknown-letter" && O.gameRoute("AB3dEfGh7K", cluster).kind === "unknown-letter" && O.gameRoute("1B3dEfGh7K", cluster).kind === "unknown-letter");
  check("an 8-character id is from before server letters", O.gameRoute("5S99ULQP", cluster).kind === "legacy");
  check("no list", O.gameRoute("aB3dEfGh7K", null).kind === "no-list" && O.gameRoute("aB3dEfGh7K", { servers: 5 }).kind === "no-list");
  check("prototype keys are not servers", O.gameRoute("aB3dEfGh7K", { servers: Object.create({ a: { host: "blue.openfront.io", numWorkers: 2 } }) }).kind === "unknown-letter");
  check("not an id", O.gameRoute("../../x", cluster).kind === "bad" && O.gameRoute(null, cluster).kind === "bad");
}

console.log("status");
{
  const now = 1_700_000_000_000;
  const info = (extra = {}) => ({ gameConfig: { gameMap: "Europe", gameMode: "Team", playerTeams: 4, maxPlayers: 40, gameType: "Private" }, clients: [{}, {}, { spectator: true }, {}], serverTime: now, ...extra });
  const st = (res, t = now) => plain(O.gameStatus({ id: "aB3dEfGh7K", route: "ok", exists: true, fetchedAt: now, ...res }, t));
  const started = st({ info: info({ startsAt: now - 60000 }) });
  check("started a minute ago: watch", started.state === "started" && started.since === 60 && O.canWatch(started), JSON.stringify(started));
  check("map, mode, teams, players without spectators", started.map === "Europe" && started.mode === "Team" && started.teams === 4 && started.players === 3 && started.spectators === 1 && started.maxPlayers === 40);
  const soon = st({ info: info({ startsAt: now + 42000 }) });
  check("a countdown: not yet", soon.state === "countdown" && soon.startsIn === 42 && !O.canWatch(soon));
  // GameManager ticks once a second and start()s 2 s after "prestart": the real start is
  // up to ~3 s after startsAt (a join before it is a PLAYER's), then GameServer refuses
  // non-spectator joins for LATE_JOIN_GRACE_MS = 5 s. Watch waits for both, plus 1 s.
  check("the watch window: 5 s of refusals after a start up to 3 s late, 1 s to spare", O.LATE_JOIN_MS === 5000 && O.WATCH_AFTER_MS === O.LATE_JOIN_MS + 4000);
  const just = st({ info: info({ startsAt: now - 2000 }) });
  check("just started: maybe not really yet, then joins refused - wait it out", just.state === "starting" && just.watchIn === 7 && !O.canWatch(just), JSON.stringify(just));
  check("still starting 8.9 s after the start time", st({ info: info({ startsAt: now - 8900 }) }).state === "starting");
  check("...a spectator's seat from 9 s", st({ info: info({ startsAt: now - 9000 }) }).state === "started" && O.canWatch(st({ info: info({ startsAt: now - 9000 }) })));
  const skewed = st({ info: info({ startsAt: now + 10000, serverTime: now + 30000 }) });
  check("the server's clock counts, not ours", skewed.state === "started" && skewed.since === 20, JSON.stringify(skewed));

  // #3: past its start time with nobody playing - the server never started it (or holds
  // the start), and a join now would be a lobby join: a PLAYER's seat
  const empty = st({ info: info({ startsAt: now - 60000, clients: [{ spectator: true }] }) });
  check("nobody playing: 'No one is playing', no Watch", empty.state === "empty" && empty.players === 0 && !O.canWatch(empty), JSON.stringify(empty));
  check("...no clients at all, same", st({ info: info({ startsAt: now - 60000, clients: [] }) }).state === "empty");
  check("...nor while it would be starting", st({ info: info({ startsAt: now - 1000, clients: [] }) }).state === "empty");
  check("canWatch wants players and the server's clock", !O.canWatch({ state: "started", players: 0, clock: true }) && !O.canWatch({ state: "started", players: 3 }) && O.canWatch({ state: "started", players: 3, clock: true }) && !O.canWatch(null));

  // #7: no serverTime - the local clock does not decide that a game started
  const noClock = st({ info: info({ startsAt: now - 60000, serverTime: undefined }) });
  check("no server time: not declared started", noClock.state === "unknown" && noClock.reason === "clock" && !O.canWatch(noClock), JSON.stringify(noClock));
  check("...a countdown still runs on the local clock", st({ info: info({ startsAt: now + 30000, serverTime: null }) }).state === "countdown");

  // #5: no start time - a private lobby waiting for its host, or a lobby that started
  // by filling up (GameServer sets no startsAt then; gameInfo has no "started" flag)
  const noStart = st({ info: info() });
  check("no start time, not full: state unknown, no Watch", noStart.state === "unknown" && noStart.reason === "no-start" && !O.canWatch(noStart), JSON.stringify(noStart));
  const fullNow = st({ info: info({ clients: Array(40).fill({}) }) });
  check("full and no start time: it starts now - wait out the window, remember when", fullNow.state === "starting" && fullNow.filled === true && fullNow.fullAt === now && fullNow.watchIn === 9, JSON.stringify(fullNow));
  const fullLater = plain(O.gameStatus({ id: "aB3dEfGh7K", route: "ok", exists: true, fetchedAt: now, info: info({ clients: Array(31).fill({}) }) }, now, { fullAt: now - 20000 }));
  check("seen full before, fewer now: started (reaching max players is for good)", fullLater.state === "started" && fullLater.filled && fullLater.since === null && O.canWatch(fullLater), JSON.stringify(fullLater));
  check("...but not without the server's clock", plain(O.gameStatus({ id: "aB3dEfGh7K", fetchedAt: now, info: info({ serverTime: null }) }, now, { fullAt: now - 20000 })).state === "unknown");
  check("...nor with nobody left", plain(O.gameStatus({ id: "aB3dEfGh7K", fetchedAt: now, info: info({ clients: [] }) }, now, { fullAt: now - 20000 })).state === "empty");

  // #6: the page's own re-check when a known start is due - any countdown length
  check("follow-up at the end of a long countdown (+ the watch window)", O.followUpIn({ state: "countdown", startsIn: 900 }) === 900000 + O.WATCH_AFTER_MS + 500 && O.followUpIn({ state: "countdown", startsIn: 42 }) === 42000 + O.WATCH_AFTER_MS + 500);
  check("follow-up when the starting window ends", O.followUpIn({ state: "starting", watchIn: 3 }) === 3500);
  check("no follow-up otherwise", ["started", "unknown", "empty", "ended", "missing", "error"].every((s) => O.followUpIn({ state: s }) === null) && O.followUpIn(null) === null);
  check("ended: in the archive", st({ exists: false, info: null, ended: true }).state === "ended");
  check("missing", st({ exists: false, info: null }).state === "missing");
  check("old id", st({ exists: null, info: null, route: "legacy" }).state === "legacy");
  check("no answer", st({ exists: null, info: null, error: "HTTP 503" }).state === "error" && st({ exists: null, info: null, error: "HTTP 503" }).detail === "HTTP 503");
  check("consent refused (the worker's gate)", plain(O.gameStatus({ error: "consent" })).state === "consent");
  check("switched off", plain(O.gameStatus({ id: "aB3dEfGh7K", error: "off" })).state === "off");
  check("junk", plain(O.gameStatus(null)).state === "error" && plain(O.gameStatus("x")).state === "error");
  const hostile = st({ info: { gameConfig: { gameMap: "<img src=x onerror=1>", gameMode: "Free\nFor All", playerTeams: "Duos", maxPlayers: "x" }, clients: "x", serverTime: now, startsAt: "soon" } });
  check("names that are not plain words are dropped", hostile.map === "" && hostile.mode === "" && hostile.teams === "Duos" && hostile.maxPlayers === null && hostile.players === 0 && hostile.state === "unknown", JSON.stringify(hostile));
}

console.log("reminder");
{
  const t0 = 1_700_000_000_000;
  const empty = { state: "empty" };
  check("every 15 s while it waits", O.remindNext(empty, t0, t0) === 15000 && O.remindNext(empty, t0, t0 + 60000) === 15000);
  check("gives up after 30 minutes", O.remindNext(empty, t0, t0 + O.REMIND_FOR_MS) === null && O.remindNext(empty, t0, t0 + O.REMIND_FOR_MS - 5000) === 5000);
  check("a known countdown: one check just after the watch window", O.remindNext({ state: "countdown", startsIn: 3 }, t0, t0) === 3000 + O.WATCH_AFTER_MS + 500);
  check("...never more often than every 3 s nor less than every 15 s", O.remindNext({ state: "countdown", startsIn: 0 }, t0, t0) >= 3000 && O.remindNext({ state: "countdown", startsIn: 900 }, t0, t0) === 15000);
  check("starting: right after the watch window", O.remindNext({ state: "starting", watchIn: 2 }, t0, t0) === 2500);
  check("started / ended / refused: stop", [{ state: "started" }, { state: "ended" }, { state: "consent" }, { state: "off" }].every((s) => O.remindNext(s, t0, t0) === null));
  check("not found / an old id: stop (nothing will start)", O.remindNext({ state: "missing" }, t0, t0) === null && O.remindNext({ state: "legacy" }, t0, t0) === null);
  check("an error keeps trying gently", O.remindNext({ state: "error" }, t0, t0) === 15000);
  check("no start time: a few tries, then stop", O.REMIND_UNSURE_TRIES >= 3 && O.REMIND_UNSURE_TRIES <= 10 && O.remindNext({ state: "unknown" }, t0, t0, O.REMIND_UNSURE_TRIES - 1) === 15000 && O.remindNext({ state: "unknown" }, t0, t0, O.REMIND_UNSURE_TRIES) === null);
  check("...other states do not count those tries", O.remindNext({ state: "error" }, t0, t0, 99) === 15000);
}

// #8: the observer page's reminder, statically: no follow-up next to a reminder, one
// reminder and one notification per game across observer tabs
console.log("observer page (source)");
{
  const page = src("src/observer.js");
  const fn = (name) => {
    const at = page.indexOf(`function ${name}(`);
    const end = page.indexOf("\n  }\n", at);
    return at >= 0 ? page.slice(at, end) : "";
  };
  check("startRemind clears a pending follow-up", /clearTimeout\(state\.follow\)/.test(fn("startRemind")));
  check("startRemind tells other observer tabs (the newest reminder of a game wins)", /tell\(\{ kind: "remind", id: state\.id \}\)/.test(fn("startRemind")) && /new BroadcastChannel\("ofr-observer"\)/.test(page) && /m\.kind === "remind" && state\.remind[\s\S]{0,40}stopRemind\(\)/.test(page));
  check("one notification per game: claimed in storage, told to the other tabs", /observerNotified/.test(fn("notifyOnce")) && /tell\(\{ kind: "started", id \}\)/.test(fn("notifyOnce")) && /notifyOnce\(s\)/.test(fn("remindStep")));
  check("the follow-up is scheduled for any countdown (followUpIn), not only short ones", /O\.followUpIn\(state\.status\)/.test(page) && !/startsIn < 600/.test(page));
  check("a countdown that ran out does not sit at 0:00", /"Starting…"/.test(page));
  check("#13: no '#game=' handover and no state.enabled left", !/#game=/.test(page) && !/state\.enabled/.test(page) && !/enabled: true,\n\s*\};/.test(page));
  check("Watch only when canWatch", /if \(O\.canWatch\(s\)\) \{\s*actions\.append\(button\("Watch"/.test(page));
}

console.log("caster data");
{
  const P = (sid, name, tiles, extra = {}) => ({ sid, name, tiles, alive: tiles > 0, type: "HUMAN", human: true, team: null, rgb: [sid, sid, sid], ...extra });
  const msg = (tick, players, extra = {}) => ({ gameId: "aB3dEfGh7K", tick, seconds: tick / 10, land: 1000, mode: "Free For All", map: "Europe", players, ...extra });
  let s = O.casterReduce(null, msg(100, [P(1, "[OFP] Kestrel", 300), P(2, "Marlowe", 200), P(3, "France", 100, { type: "NATION", human: false }), P(4, "Bot 1", 50, { type: "BOT", human: false }), P(5, "Never", 0)]));
  check("first state: nobody eliminated yet", s && s.feed.length === 0 && Object.keys(s.alive).length === 4, JSON.stringify(s?.feed));
  s = O.casterReduce(s, msg(200, [P(1, "[OFP] Kestrel", 450), P(2, "Marlowe", 0, { alive: false }), P(3, "France", 0, { type: "NATION", human: false, alive: false }), P(5, "Never", 0)]));
  check("eliminations: a human and a nation, at the game clock", eq(plain(s.feed).map((f) => [f.name, f.at, f.human]), [["Marlowe", 20, true], ["France", 20, false]]), JSON.stringify(s.feed));
  check("a bot that fell is not in the feed", !s.feed.some((f) => f.sid === 4));
  check("a player who never had land is never 'eliminated'", !s.feed.some((f) => f.sid === 5));
  const again = O.casterReduce(s, msg(210, [P(1, "[OFP] Kestrel", 460), P(2, "Marlowe", 0, { alive: false })]));
  check("each elimination once", again.feed.length === 2);
  const v = plain(O.casterView(again, { limit: 12 }));
  check("board: alive by land, then the fallen (latest first)", v.board[0].name === "[OFP] Kestrel" && v.board[0].place === 1 && v.board[0].frac === 1 && v.board[1].alive === false && v.board[1].outAt === 20, JSON.stringify(v.board));
  check("counts", v.playersAlive === 1 && v.humansAlive === 1 && v.humansTotal === 2, JSON.stringify(v));
  check("feed newest first", v.feed[0].at >= v.feed[v.feed.length - 1].at);
  check("phase", v.phase === "watching" && plain(O.casterView(O.casterReduce(again, msg(220, [], { over: true })))).phase === "ended" && plain(O.casterView(O.casterReduce(null, msg(5, [], { spawn: true })))).phase === "spawn");

  const fresh = O.casterReduce(again, { ...msg(10, [P(9, "New", 10)]), gameId: "zB3dEfGh7K" });
  check("a new game starts over", fresh.gameId === "zB3dEfGh7K" && fresh.feed.length === 0);
  const back = O.casterReduce(again, msg(50, [P(1, "[OFP] Kestrel", 100)]));
  check("a clock that went backwards starts over (a replay rewound)", back.feed.length === 0);
  const revived = O.casterReduce(again, msg(230, [P(1, "[OFP] Kestrel", 460), P(2, "Marlowe", 20)]));
  check("someone back with land loses the 'out' mark", !(2 in revived.outAt) && revived.alive[2]);

  // masking: streamer mode / an overlay page that hides names
  const m = plain(O.casterView(s, { masked: true, pctOf: () => 3 }));
  check("masked: no human names, no ranks; nations keep theirs", m.board.every((r) => r.type !== "HUMAN" || r.name === null) && m.board.every((r) => r.pct === null) && m.feed.find((f) => !f.human).name === "France" && m.feed.find((f) => f.human).name === null, JSON.stringify(m));
  const ranked = plain(O.casterView(s, { pctOf: (n) => (n === "[OFP] Kestrel" ? 2.5 : null) }));
  check("ranks from the lookup cache for humans", ranked.board[0].pct === 2.5 && ranked.board.every((r) => r.name === "[OFP] Kestrel" || r.pct === null));

  // team games
  const T = (sid, team, tiles, extra = {}) => P(sid, `P${sid}`, tiles, { team, ...extra });
  const team = O.casterReduce(null, msg(100, [T(1, "Red", 300), T(2, "Red", 100), T(3, "Blue", 250), T(4, "Blue", 0, { alive: false }), T(5, "Bot", 40, { type: "BOT", human: false })], { mode: "Team", teams: 2 }));
  const tv = plain(O.casterView(team));
  check("team totals: land, alive/total, by land", tv.teamGame && tv.teams.length === 2 && tv.teams[0].name === "Red" && Math.abs(tv.teams[0].share - 0.4) < 1e-9 && tv.teams[0].alive === 2 && tv.teams[1].alive === 1 && tv.teams[1].total === 2, JSON.stringify(tv.teams));
  check("bots are not a team", !tv.teams.some((t) => t.name === "Bot"));
  check("a team's colour is its biggest player's", eq(tv.teams[0].rgb, [1, 1, 1]));
  check("FFA: no team view", plain(O.casterView(s)).teamGame === false);

  // what the page can fake: shapes and ranges only
  const junk = O.casterReduce(null, { gameId: "aB3dEfGh7K", tick: 1, land: 10, players: [{ sid: 0, name: "x", tiles: 5 }, { sid: 1.5, tiles: 5 }, { sid: 7, name: "A\u202eB\u0000C".repeat(20), tiles: 1e9, team: "<b>", rgb: [999, -1, NaN], type: "ADMIN", alive: true }, { sid: 7, name: "dup", tiles: 1 }, null, "x"] });
  check("bad ids, duplicates and junk rows are dropped", junk.players.length === 1 && junk.players[0].sid === 7);
  const j = junk.players[0];
  check("names cleaned and capped, share clamped, bad team and type dropped", !/[\u0000\u202e]/.test(j.name) && j.name.length <= 40 && j.share === 1 && j.team === null && j.type === "BOT" && j.rgb === null, JSON.stringify(j));
  check("not a caster message", O.casterReduce(null, { gameId: "../x", tick: 1, players: [] }) === null && O.casterReduce(s, "x") === s);
  let big = null;
  for (let t = 1; t < 400; t++) big = O.casterReduce(big, msg(t * 10, Array.from({ length: 30 }, (_, i) => P(i + 1, `P${i}`, i < 30 - (t % 30) ? 10 : 0))));
  check("the feed is bounded", big.feed.length <= O.FEED_KEEP);
}

// #1 / #12: the REAL page-probe.js against a stand-in GameView with OpenFront
// v0.34.10's seat semantics (tools/standin-game.mjs seatModel: isSpectator() is
// `!myPlayer()?.isAlive() || isReplay()`), in node with a minimal page around it.
console.log("page probe: who is watching");
{
  const probeSrc = src("src/page-probe.js");
  const ME = "Me0000001";
  const ROSTER = ["Pl0000001", "Pl0000002", ME];
  const pv = (sid, name, tiles, alive = true, type = "HUMAN") => ({
    smallID: () => sid,
    type: () => type,
    isAlive: () => alive,
    numTilesOwned: () => tiles,
    displayName: () => name,
    name: () => name,
    team: () => null,
    isMe: () => false,
    territoryColor: () => ({ toRgb: () => ({ r: sid, g: sid, b: sid }) }),
    static: { name: `RAW-${sid}` },
  });
  // a game in `role` for this client; opts: { spawn, noRoster, mine: true|false|null }
  function makeGame(role, { ticks = 3000, seconds, noRoster = false, cosmeticsOnly = false } = {}) {
    const mine = pv(3, "Me", role === "eliminated" ? 0 : 500, role !== "eliminated");
    const seat = seatModel(role, ME, ROSTER, () => mine);
    const g = {
      ...seat.game,
      gameID: () => "aB3dEfGh7K",
      ticks: () => ticks,
      elapsedGameSeconds: () => (seconds ?? (role === "spawning" ? 0 : ticks / 10 - 30)),
      gameOver: () => false,
      isCatchingUp: () => false,
      numLandTiles: () => 1000,
      playerViews: () => [pv(1, "Alpha", 300), pv(2, "Beta", 200), ...(role === "player" || role === "eliminated" ? [mine] : [])],
      config: () => ({ ...seat.config, gameConfig: () => ({ gameMode: "Free For All", gameMap: "Europe" }), playerTeams: () => 0 }),
    };
    if (noRoster || cosmeticsOnly) delete g.worker;
    if (noRoster) delete g._cosmetics;
    return g;
  }
  function runProbe(game) {
    const dataset = { ofrCaster: "on", ofrOverlay: "on" };
    const posted = [];
    const loops = [];
    const sandbox = {
      console,
      Map, // the stand-in's roster Map comes from this realm
      document: { documentElement: { dataset }, querySelector: (s) => (s === "player-panel" ? { g: game } : null), querySelectorAll: () => [] },
      location: { origin: "https://openfront.io" },
      setInterval: (fn) => loops.push(fn),
      clearInterval: () => {},
    };
    sandbox.window = { postMessage: (m) => posted.push(m) };
    vm.createContext(sandbox);
    vm.runInContext(probeSrc, sandbox, { filename: "page-probe.js" });
    for (const fn of loops) fn();
    return { game: JSON.parse(dataset.ofrGame ?? "null"), caster: posted.filter((m) => m.__ofr === "caster-state"), stats: posted.filter((m) => m.__ofr === "overlay-stats") };
  }
  const spawning = makeGame("spawning", { ticks: 300 });
  check("stand-in: the client's own isSpectator() is TRUE for a player in the spawn phase (the trap)", spawning.isSpectator() === true && spawning.myPlayer() === null);
  let r = runProbe(spawning);
  check("a player in the spawn phase: not a spectator, no caster feed", r.game?.spectator === false && r.game.spawn === true && r.caster.length === 0, JSON.stringify(r.game));
  const out = makeGame("eliminated");
  check("stand-in: ...and TRUE for an eliminated player", out.isSpectator() === true && out.myPlayer() !== null);
  r = runProbe(out);
  check("an eliminated player: not a spectator (still their game), no caster feed", r.game?.spectator === false && r.game.alive === false && r.caster.length === 0, JSON.stringify(r.game));
  r = runProbe(makeGame("player"));
  check("a player: not a spectator", r.game?.spectator === false && r.game.alive === true && r.caster.length === 0);
  r = runProbe(makeGame("spectator"));
  check("a real spectator (not on the roster): spectator, caster feed on", r.game?.spectator === true && r.game.alive === null && r.caster.length === 1 && r.caster[0].players.length === 2, JSON.stringify(r.game));
  check("...names as shown, never the raw ones", !JSON.stringify(r.caster).includes("RAW-"));
  r = runProbe(makeGame("spectator", { cosmeticsOnly: true }));
  check("...found through GameView._cosmetics when the worker's roster is not readable", r.game?.spectator === true);
  r = runProbe(Object.assign(makeGame("spectator"), { inSpawnPhase: () => true }));
  check("...a spectator during the spawn phase too (the roster says so)", r.game?.spectator === true);
  r = runProbe(makeGame("intentional"));
  check("Spectate picked in the lobby (Config.isIntentionalSpectator): spectator", r.game?.spectator === true);
  r = runProbe(makeGame("replay"));
  check("a replay: spectator, replay", r.game?.spectator === true && r.game.replay === true && r.caster.length === 1);
  // no roster at all (a changed build): the spawn phase is never "watching"
  r = runProbe(makeGame("spawning", { noRoster: true }));
  check("no roster: spawn phase -> not a spectator", r.game?.spectator === false);
  r = runProbe(makeGame("eliminated", { noRoster: true }));
  check("no roster: eliminated (a PlayerView of mine) -> not a spectator", r.game?.spectator === false);
  r = runProbe(makeGame("spectator", { noRoster: true }));
  check("no roster: past the spawn phase with no PlayerView -> spectator", r.game?.spectator === true);

  // #12: the clock in the spawn phase is elapsedGameSeconds() (0), not ticks / 10
  r = runProbe(makeGame("spawning", { ticks: 300 }));
  check("spawn phase: overlay clock 0, not ticks/10 (no jump when the game starts)", r.stats.length === 1 && r.stats[0].seconds === 0, JSON.stringify(r.stats[0]));
  const specSpawn = Object.assign(makeGame("spectator", { ticks: 300, seconds: 0 }), { inSpawnPhase: () => true });
  r = runProbe(specSpawn);
  check("spawn phase: caster clock 0 too", r.caster.length === 1 && r.caster[0].seconds === 0, JSON.stringify(r.caster[0]?.seconds));
  r = runProbe(makeGame("spectator", { ticks: 3000, seconds: 270 }));
  check("running: the game's own clock (ticks since the start)", r.caster[0]?.seconds === 270 && r.stats[0]?.seconds === 270);
  const noClock = makeGame("spectator", { ticks: 3000 });
  delete noClock.elapsedGameSeconds;
  r = runProbe(noClock);
  check("no elapsedGameSeconds in the build: ticks / 10", r.caster[0]?.seconds === 300);
}

console.log("worker: observerCheck with a stand-in fetch");
{
  const bg = src("src/background.js");
  const from = bg.indexOf("// <observer-check>");
  const to = bg.indexOf("// </observer-check>");
  check("background.js has the <observer-check> block", from > 0 && to > from);
  const calls = [];
  const inits = [];
  let routes = {};
  const sandbox = {
    console,
    Date,
    JSON,
    OFR_OBSERVER: O,
    getSettings: async () => ({ enabled: sandbox.enabled }),
    fetchGameRecord: async (id) => {
      calls.push(`record ${id}`);
      return routes.record ?? { pending: true };
    },
    fetch: async (url, init) => {
      calls.push(url);
      inits.push(init);
      const hit = Object.entries(routes).find(([k]) => url.endsWith(k));
      const [status, body, type = "application/json"] = hit ? hit[1] : [404, null];
      return { status, ok: status >= 200 && status < 300, headers: { get: () => type }, json: async () => body };
    },
    enabled: true,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${bg.slice(from, to)}\nthis.observerCheck = observerCheck; this.slimGameInfo = slimGameInfo;`, sandbox);
  const w = O.simpleHash("aB3dEfGh7K") % 16;
  const cluster = { servers: { a: { host: "blue.openfront.io", numWorkers: 16, version: "abc1234", state: "open" } } };
  const info = { gameID: "aB3dEfGh7K", gameConfig: { gameMap: "Europe", gameMode: "Free For All", maxPlayers: 50, bots: 400, disableNations: false }, clients: [{ username: "Secret Name", clientID: "c1", clanTag: "X" }, { username: "Other", clientID: "c2", spectator: true }], startsAt: Date.now() - 120000, serverTime: Date.now() };
  routes = { "cluster.json?site=openfront.io": [200, cluster], [`/w${w}/api/game/aB3dEfGh7K/exists`]: [200, { exists: true }], [`/w${w}/api/game/aB3dEfGh7K`]: [200, info] };
  const res = plain(await sandbox.observerCheck("aB3dEfGh7K"));
  check("asks the server list, then the game's own worker", calls[0] === "https://api.openfront.io/cluster.json?site=openfront.io" && calls[1] === `https://blue.openfront.io/w${w}/api/game/aB3dEfGh7K/exists` && calls[2] === `https://blue.openfront.io/w${w}/api/game/aB3dEfGh7K`, JSON.stringify(calls));
  check("a running game: its info, and the page gets no names", res.exists === true && res.info?.gameConfig?.gameMap === "Europe" && !JSON.stringify(res).includes("Secret Name") && !JSON.stringify(res).includes("c1"), JSON.stringify(res));
  check("...and reads as started", plain(O.gameStatus(res, Date.now())).state === "started");
  check("#9: every request refuses redirects (redirect: 'error')", inits.length >= 3 && inits.every((i) => i?.redirect === "error"), JSON.stringify(inits));
  calls.length = 0;
  await sandbox.observerCheck("aB3dEfGh7K");
  check("the server list is cached", calls.length === 2 && !calls[0].includes("cluster.json"), JSON.stringify(calls));
  routes[`/w${w}/api/game/aB3dEfGh7K/exists`] = [200, { exists: false }];
  routes.record = { players: [{}] };
  calls.length = 0;
  const ended = plain(await sandbox.observerCheck("aB3dEfGh7K"));
  check("gone from the server, in the archive: over", ended.exists === false && ended.ended === true && calls.includes("record aB3dEfGh7K") && plain(O.gameStatus(ended)).state === "ended");
  routes.record = { pending: true };
  check("gone and not archived: missing", plain(O.gameStatus(await sandbox.observerCheck("aB3dEfGh7K"))).state === "missing");
  routes[`/w${w}/api/game/aB3dEfGh7K/exists`] = [403, null, "text/html"];
  const blocked = plain(await sandbox.observerCheck("aB3dEfGh7K"));
  check("a bot check or an error page: said so, not guessed", blocked.error === "HTTP 403" && plain(O.gameStatus(blocked)).state === "error", JSON.stringify(blocked));
  routes[`/w${w}/api/game/aB3dEfGh7K/exists`] = [200, "<html>", "text/html"];
  check("HTML instead of JSON", /not JSON/.test((await sandbox.observerCheck("aB3dEfGh7K")).error));
  calls.length = 0;
  const legacy = plain(await sandbox.observerCheck("5S99ULQP"));
  check("an 8-character id: only the archive is asked", legacy.route === "legacy" && eq(calls, ["record 5S99ULQP"]), JSON.stringify(calls));
  calls.length = 0;
  check("not an id: nothing asked", (await sandbox.observerCheck("../../etc")).id === null && (await sandbox.observerCheck({ toString: () => "aB3dEfGh7K" })).id === null && calls.length === 0);
  sandbox.enabled = false;
  check("switched off: nothing asked", (await sandbox.observerCheck("aB3dEfGh7K")).error === "off" && calls.length === 0);
  check("slimGameInfo keeps counts only", eq(Object.keys(plain(sandbox.slimGameInfo(info))).sort(), ["clients", "gameConfig", "serverTime", "startsAt"]) && eq(plain(sandbox.slimGameInfo(info)).clients, [{ spectator: false }, { spectator: true }]));
  // the consent gate: observerCheck is one of the lookup messages
  check("observerCheck waits for the rank-lookup agreement (LOOKUP_MESSAGES)", /LOOKUP_MESSAGES = new Set\(\[[^\]]*"observerCheck"/.test(bg));
  check("the worker can open the observer page (own keys only)", /PAGES = \{[^}]*observer: "src\/observer\.html"/.test(bg) && /Object\.hasOwn\(PAGES, msg\.page\)/.test(bg));
}

console.log(`\n${total - failures}/${total} checks`);
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
