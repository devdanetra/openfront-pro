// The stream overlay's pure half (src/overlay-core.js) in node: page options,
// formatting, the checks on what arrives through storage, and which cards show.
//
//   node tools/test-overlay.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { console, URLSearchParams };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/scoring.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/overlay-core.js"), "utf8"), sandbox);
const O = sandbox.OFR_OVERLAY;
const S = sandbox.OFR_SCORING;

let failures = 0;
let total = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, ok, detail = "") {
  total++;
  if (!ok) failures++;
  if (!ok) console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
}
// vm objects come from another realm: compare through JSON
const plain = (v) => JSON.parse(JSON.stringify(v));

console.log("options");
{
  const d = plain(O.parseOptions(""));
  check("defaults", eq(d, { widgets: ["rank", "live", "recap"], bg: "transparent", scale: 1, pos: "tr", recap: 20, name: true, streamer: false, edit: false, demo: false }), JSON.stringify(d));
  const o = plain(O.parseOptions("?w=live,rank,live,bogus&bg=green&scale=1.25&pos=bl&recap=45&name=0&streamer=1&edit=1"));
  check("all options", eq(o, { widgets: ["live", "rank"], bg: "green", scale: 1.25, pos: "bl", recap: 45, name: false, streamer: true, edit: true, demo: false }), JSON.stringify(o));
  check("widget order kept, duplicates and unknowns dropped", eq(o.widgets, ["live", "rank"]));
  check("hash overrides the query", O.parseOptions("?bg=green&pos=tl", "#bg=dark").bg === "dark" && O.parseOptions("?bg=green&pos=tl", "#bg=dark").pos === "tl");
  check("bad values fall back", eq(plain(O.parseOptions("?bg=red&pos=middle&scale=abc&recap=x")), plain(O.parseOptions(""))));
  check("scale is clamped", O.parseOptions("?scale=9").scale === 3 && O.parseOptions("?scale=0.1").scale === 0.5 && O.parseOptions("?scale=-2").scale === 1);
  check("recap is clamped and rounded", O.parseOptions("?recap=99999").recap === 600 && O.parseOptions("?recap=-5").recap === 0 && O.parseOptions("?recap=12.6").recap === 13);
  check("recap=0 means until the next game", O.parseOptions("?recap=0").recap === 0);
  check("w= with nothing valid shows nothing", O.parseOptions("?w=none").widgets.length === 0);
  check("streamer accepts true/yes/on", O.parseOptions("?streamer=true").streamer && O.parseOptions("?streamer=on").streamer && !O.parseOptions("?streamer=0").streamer);
  check("name=1 keeps the name", O.parseOptions("?name=1").name === true);

  const round = O.parseOptions(O.buildQuery(o));
  check("buildQuery round-trips", eq(plain(round), o), O.buildQuery(o));
  check("defaults build an empty query", O.buildQuery(O.parseOptions("")) === "");
  const obs = O.buildQuery({ ...o, demo: true }, { forObs: true });
  check("an OBS address never carries edit or demo", !/edit|demo/.test(obs), obs);
  check("commas are encoded (the worker's hash filter allows no comma)", /^[\w=&%.-]*$/.test(O.buildQuery(o).slice(1)), O.buildQuery(o));
  check("no widgets survives the round trip", O.parseOptions(O.buildQuery({ ...o, widgets: [] })).widgets.length === 0);
}

console.log("formatting");
check("clock m:ss", O.clock(0) === "0:00" && O.clock(59.9) === "0:59" && O.clock(754) === "12:34");
check("clock h:mm:ss", O.clock(3725) === "1:02:05");
check("clock rejects junk", O.clock(NaN) === "0:00" && O.clock(-4) === "0:00" && O.clock("12") === "0:00");
check("share", O.sharePct(0.124) === "12%" && O.sharePct(0.0834) === "8.3%" && O.sharePct(0) === "0.0%" && O.sharePct(0.0004) === "<0.1%" && O.sharePct(1) === "100%");
check("share rejects junk", O.sharePct(null) === null && O.sharePct(-1) === null && O.sharePct("0.5") === null);

console.log("heartbeat");
{
  const now = 1_700_000_000_000;
  check("fresh", O.heartbeatFresh(now - 1000, now));
  check("stale", !O.heartbeatFresh(now - O.STALE_MS - 1, now));
  check("false / missing", !O.heartbeatFresh(false, now) && !O.heartbeatFresh(undefined, now) && !O.heartbeatFresh(0, now));
  check("far future is not fresh", !O.heartbeatFresh(now + 120000, now));
  check("beats well within the stale window", O.BEAT_MS * 5 <= O.STALE_MS);
  // content.js keeps its own copy of the threshold (it cannot load this file)
  const content = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const m = /const OVERLAY_STALE_MS = (\d+);/.exec(content);
  check("content.js uses the same stale threshold", m && Number(m[1]) === O.STALE_MS, m?.[1]);
}

console.log("live state");
{
  const now = 1_700_000_000_000;
  const good = { gameId: "AbCd1234", at: now - 500, phase: "playing", seconds: 100, map: "World", mode: "Free For All", humans: 12, humansTotal: 40, players: 57, place: 3, share: 0.05, top: [{ share: 0.1 }, { share: 0.07 }, { share: 0.05, me: true }] };
  const l = plain(O.sanitizeLive(good, now));
  check("a good state passes", l && l.place === 3 && l.share === 0.05 && l.top.length === 3 && l.top[2].me === true, JSON.stringify(l));
  check("stale state is dropped", O.sanitizeLive({ ...good, at: now - O.LIVE_STALE_MS - 1 }, now) === null);
  check("bad game id is dropped", O.sanitizeLive({ ...good, gameId: "../x" }, now) === null && O.sanitizeLive({ ...good, gameId: 5 }, now) === null);
  check("not an object", O.sanitizeLive("x", now) === null && O.sanitizeLive(null, now) === null);
  const bad = plain(O.sanitizeLive({ ...good, phase: "hacked", share: 7, place: 99, humans: 50, humansTotal: 3, seconds: -3, map: "A‮B<img src=x>".repeat(10), top: [{ share: "1" }, 5, null, { share: 0.2 }] }, now));
  check("unknown phase -> playing", bad.phase === "playing");
  check("share clamped to 1", bad.share === 1);
  check("a place past the field is dropped", bad.place === null);
  check("humans total never below humans alive", bad.humansTotal === 50);
  check("negative seconds -> 0", bad.seconds === 0);
  check("a map name with markup or bidi controls is dropped", bad.map === "", JSON.stringify(bad.map));
  check("plain map and mode names pass", l.map === "World" && l.mode === "Free For All");
  const named = (map, mode) => plain(O.sanitizeLive({ ...good, map, mode }, now));
  check("real map names pass", named("Gulf of St. Lawrence", "Team").map === "Gulf of St. Lawrence" && named("Baikal (Nuke Wars)", "x").map === "Baikal (Nuke Wars)" && named("Between Two Seas", "x").map === "Between Two Seas");
  check("stream text is refused", named("follow me on twitch.tv/x !!", "x").map === "" && named("World", "<b>FREE V-BUCKS</b>").mode === "" && named("a".repeat(41), "x").map === "" && named(42, null).map === "" && named("World", "Free\nFor All").mode === "");
  check("label rule", O.label(" World ") === "World" && O.label("") === "" && O.label("Ünïcode") === "" && O.label("Mars & Co.") === "Mars & Co.");
  check("leaders capped at 3 and cleaned", bad.top.length === 3 && bad.top[0].share === 0 && bad.top[1].share === 0);
  check("clock runs on between writes", Math.round(O.liveSeconds(plain(O.sanitizeLive({ ...good, at: now - 2000 }, now)), now)) === 102);
  check("...but not in spawn or after the game", O.liveSeconds(plain(O.sanitizeLive({ ...good, at: now - 2000, phase: "ended" }, now)), now) === 100);
  check("the page runs the clock between writes (4 s apart and more)", O.liveSeconds(plain(O.sanitizeLive({ ...good, at: now - 11000 }, now)), now) === 111);
  check("...but never past the stale limit", O.liveSeconds({ ...plain(O.sanitizeLive(good, now)), at: now - 60000 }, now) === 100 + O.LIVE_STALE_MS / 1000);

  const rows = plain(O.leaderRows(l));
  check("leader rows: you among the top 3", rows.length === 3 && rows[2].me && rows[0].frac === 1 && Math.abs(rows[2].frac - 0.5) < 1e-9, JSON.stringify(rows));
  const outside = plain(O.leaderRows(plain(O.sanitizeLive({ ...good, place: 9, share: 0.01, top: [{ share: 0.2 }, { share: 0.1 }, { share: 0.05 }] }, now))));
  check("leader rows: you appended with your place", outside.length === 4 && outside[3].me && outside[3].place === 9, JSON.stringify(outside));
  const out = plain(O.leaderRows(plain(O.sanitizeLive({ ...good, phase: "out", place: null, share: null, top: [{ share: 0.2 }] }, now))));
  check("leader rows: out of the game, no row for you", out.length === 1 && !out[0].me);
}

console.log("session");
{
  const day = "Sat Sep 19 2026";
  const session = { day, startPct: 8, games: [{ won: false, place: 5, total: 40 }, { won: true, place: 1, total: 30 }, { won: true, pctAfter: 6.2 }, null, "x"] };
  const v = plain(O.sessionView(session, day));
  check("counts games and wins", v.games === 3 && v.wins === 2, JSON.stringify(v));
  check("one pip per game, in order", eq(v.pips.map((p) => p.won), [false, true, true]));
  check("drift up (a smaller percentile is better)", v.drift?.dir === "up" && Math.abs(v.drift.delta - 1.8) < 1e-9);
  check("drift down", plain(O.sessionView({ ...session, startPct: 5 }, day)).drift.dir === "down");
  check("drift same", plain(O.sessionView({ ...session, startPct: 6.21 }, day)).drift.dir === "same");
  check("no drift without a start", plain(O.sessionView({ ...session, startPct: null }, day)).drift === null);
  check("yesterday's session is empty", plain(O.sessionView(session, "Sun Sep 20 2026")).games === 0);
  check("junk session", plain(O.sessionView("x", day)).games === 0 && plain(O.sessionView(null, day)).games === 0);
  const many = plain(O.sessionView({ day, games: Array.from({ length: 20 }, (_, i) => ({ won: i % 3 === 0 })) }, day));
  check("pips capped (newest kept)", many.pips.length === 12 && many.more === 8 && many.games === 20);
}

console.log("rank");
{
  const info = { found: true, games: 412, ratedGames: 400, ratedWins: 60, expectedWins: 31, streak: 7 };
  const r = plain(O.rankView(info, S));
  const expected = S.ranked(info).pct;
  check("ranked player", r.kind === "ok" && r.pct === expected && r.band === S.percentBand(expected) && r.text === S.formatPercent(expected) && r.streak === 7, JSON.stringify(r));
  check("gauge fraction: higher for a better rank", plain(O.rankView({ ...info, ratedWins: 120 }, S)).frac > r.frac);
  check("gauge never empty", plain(O.rankView({ ...info, ratedWins: 0, expectedWins: 60 }, S)).frac >= 0.03);
  check("too few games -> unranked", plain(O.rankView({ ...info, ratedGames: 2 }, S)).kind === "unranked");
  check("not asked yet -> loading", plain(O.rankView(undefined, S)).kind === "loading");
  check("no name -> none", plain(O.rankView(null, S)).kind === "none");
  check("consent refused", plain(O.rankView({ found: false, reason: "consent" }, S)).kind === "consent");
  check("ofstats down", plain(O.rankView({ found: false, reason: "error" }, S)).kind === "error");
  check("no history", plain(O.rankView({ found: false, reason: "no-history" }, S)).kind === "none");
  check("silly streak clamped", plain(O.rankView({ ...info, streak: 1e9 }, S)).streak === 999 && plain(O.rankView({ ...info, streak: -3 }, S)).streak === 0);

  // streamer mode: your rank stays off the stream, the streak stays
  const hidden = plain(O.hideRank(r));
  check("streamer: a rank becomes hidden, streak kept", eq(hidden, { kind: "hidden", streak: 7, games: 412 }), JSON.stringify(hidden));
  check("streamer: no percentile left in it", !/pct|text|band|frac/.test(JSON.stringify(hidden)));
  check("streamer: unranked hidden too", plain(O.hideRank(plain(O.rankView({ ...info, ratedGames: 2 }, S)))).kind === "hidden");
  check("streamer: other states unchanged", plain(O.hideRank({ kind: "consent" })).kind === "consent" && plain(O.hideRank({ kind: "error" })).kind === "error" && O.hideRank(null) === null);
}

console.log("recap card");
{
  const now = 1_700_000_000_000;
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const recap = plain(O.sanitizeRecap({ gameId: "AbCd1234", at: now - 5000, png }));
  check("a good card passes", recap && recap.png === png);
  check("webp is fine too", !!O.sanitizeRecap({ gameId: "AbCd1234", at: now, png: "data:image/webp;base64,UklGRg==" }));
  check("not a data: image", O.sanitizeRecap({ gameId: "AbCd1234", at: now, png: "https://evil.example/x.png" }) === null);
  check("svg refused (it could carry script)", O.sanitizeRecap({ gameId: "AbCd1234", at: now, png: "data:image/svg+xml;base64,PHN2Zz4=" }) === null);
  check("junk inside the base64", O.sanitizeRecap({ gameId: "AbCd1234", at: now, png: 'data:image/png;base64,AAAA" onerror="x' }) === null);
  check("too big", O.sanitizeRecap({ gameId: "AbCd1234", at: now, png: `data:image/png;base64,${"A".repeat(O.MAX_PNG)}` }) === null);
  check("bad game id", O.sanitizeRecap({ gameId: "x", at: now, png }) === null);

  check("shown right after the game", O.recapState(recap, null, 20, now).show === true);
  check("countdown fraction", Math.abs(O.recapState(recap, null, 20, now).frac - 0.75) < 1e-9);
  check("hidden after its seconds", O.recapState(recap, null, 20, now + 20000).show === false);
  check("recap=0: stays until the next game", O.recapState(recap, null, 0, now + 3600 * 1000).show === true);
  const nextGame = { gameId: "Next5678", phase: "playing" };
  check("...and goes when the next game starts", O.recapState(recap, nextGame, 0, now).show === false);
  check("never over a different running game", O.recapState(recap, nextGame, 20, now).show === false);
  check("but fine over its own finished game", O.recapState(recap, { gameId: "AbCd1234", phase: "ended" }, 20, now).show === true);

  // name=0 / streamer mode: only a card drawn masked
  check("the masked flag is kept, and only a real true counts", recap.streamer === false && plain(O.sanitizeRecap({ gameId: "AbCd1234", at: now, png, streamer: true })).streamer === true && plain(O.sanitizeRecap({ gameId: "AbCd1234", at: now, png, streamer: "yes" })).streamer === false);
  const maskedCard = plain(O.sanitizeRecap({ gameId: "AbCd1234", at: now, png, streamer: true }));
  check("a page that shows your name shows any card", O.recapFor(recap, false) === recap && O.recapFor(maskedCard, false) === maskedCard);
  check("a page that hides your name drops an unmasked card", O.recapFor(recap, true) === null);
  check("...and shows a masked one", O.recapFor(maskedCard, true) === maskedCard);
  check("an old card without the flag counts as unmasked", O.recapFor({ gameId: "AbCd1234", at: now, png }, true) === null && O.recapFor(null, true) === null);
}

console.log("which cards");
{
  const now = 1_700_000_000_000;
  const opts = plain(O.parseOptions(""));
  const rank = { kind: "ok" };
  const session = { games: 2 };
  const live = { gameId: "AbCd1234", phase: "playing" };
  const recap = { gameId: "AbCd1234", at: now - 1000, png: "data:image/png;base64,AA==" };
  const L = (o, s, t = now) => plain(O.layout(o, s, t));
  check("rank + live", eq(L(opts, { rank, session, live }), ["rank", "live"]));
  check("the recap replaces its game's live card", eq(L(opts, { rank, session, live: { ...live, phase: "ended" }, recap }), ["rank", "recap"]));
  check("...unless recap cards are off", eq(L({ ...opts, widgets: ["rank", "live"] }, { rank, session, live: { ...live, phase: "ended" }, recap }), ["rank", "live"]));
  check("order follows w=", eq(L({ ...opts, widgets: ["live", "rank"] }, { rank, session, live }), ["live", "rank"]));
  check("rank card with a session and no lookup", eq(L(opts, { rank: { kind: "consent" }, session }), ["rank"]));
  check("no rank card with nothing to show", eq(L(opts, { rank: { kind: "consent" }, session: { games: 0 } }), []));
  check("switched off: nothing", eq(L(opts, { rank, session, live, recap, off: true }), []));
  check("widgets off", eq(L({ ...opts, widgets: [] }, { rank, session, live, recap }), []));
  check("streamer: the rank card stays with a hidden rank", eq(L(opts, { rank: { kind: "hidden", streak: 2 }, session: { games: 0 } }), ["rank"]));
}

// content.js's half of the publishing rules (it cannot load overlay-core.js): the
// block between its <overlay-pure> markers, run here as it is.
console.log("publishing (content.js)");
{
  const content = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const from = content.indexOf("// <overlay-pure>");
  const to = content.indexOf("// </overlay-pure>");
  check("content.js has the <overlay-pure> block", from > 0 && to > from);
  const C = { Number, Math, JSON };
  vm.createContext(C);
  vm.runInContext(`${content.slice(from, to)}\nthis.P = { OVERLAY_STALE_MS, OVERLAY_LIVE_STALE_MS, OVERLAY_KEYS, overlayLabel, overlayShare, overlaySignature, overlayMayWrite, overlayMayRemove };`, C);
  const P = C.P;
  check("same live stale limit as the page", P.OVERLAY_LIVE_STALE_MS === O.LIVE_STALE_MS);
  check("everything published is cleared", eq(plain(P.OVERLAY_KEYS).sort(), ["overlayLive", "overlayMask", "overlayRecap", "overlaySelf"]));

  // labels: the same rule on both sides
  const samples = ["World", "Gulf of St. Lawrence", "Baikal (Nuke Wars)", "Free For All", "Team", " Europe ", "", "twitch.tv/x !!", "<b>x</b>", "a".repeat(41), "Ünïcode", "A‮B", "x\ny", 5, null];
  check("overlayLabel = the page's label rule", samples.every((s) => P.overlayLabel(s) === O.label(s)), JSON.stringify(samples.map((s) => [P.overlayLabel(s), O.label(s)])));

  check("shares rounded to 3 decimals and clamped", P.overlayShare(0.12345) === 0.123 && P.overlayShare(0.12351) === 0.124 && P.overlayShare(3) === 1 && P.overlayShare(-1) === 0 && P.overlayShare(null) === null && P.overlayShare(NaN) === null);

  const live = { gameId: "AbCd1234", phase: "playing", seconds: 100, map: "World", mode: "Team", humans: 3, humansTotal: 9, players: 20, place: 2, share: 0.124, top: [{ share: 0.2, me: false }], visible: true };
  const sig = P.overlaySignature(live);
  check("signature: nothing for no game", P.overlaySignature(null) === "");
  check("signature: the clock is not a change", P.overlaySignature({ ...live, seconds: 101, at: 5, owner: "x" }) === sig);
  check("signature: land, place, phase and visibility are", [{ share: 0.125 }, { place: 3 }, { phase: "out" }, { visible: false }, { top: [{ share: 0.21, me: false }] }].every((d) => P.overlaySignature({ ...live, ...d }) !== sig));
  check("signature: sub-0.1 % creep is gone after rounding", P.overlaySignature({ ...live, share: P.overlayShare(0.12404) }) === P.overlaySignature({ ...live, share: P.overlayShare(0.12396) }));

  // one tab at a time
  const now = 1_700_000_000_000;
  const theirs = { owner: "B", at: now - 2000, visible: true };
  check("owner rule: nothing stored -> write", P.overlayMayWrite(null, "A", false, now) && P.overlayMayWrite(undefined, "A", true, now));
  check("owner rule: our own -> keep writing", P.overlayMayWrite({ owner: "A", at: now - 2000, visible: false }, "A", false, now));
  check("owner rule: another tab's fresh entry -> leave it", !P.overlayMayWrite(theirs, "A", true, now) && !P.overlayMayWrite(theirs, "A", false, now));
  check("owner rule: a background tab's entry -> a tab on screen takes over", P.overlayMayWrite({ ...theirs, visible: false }, "A", true, now));
  check("owner rule: ...but a background tab does not", !P.overlayMayWrite({ ...theirs, visible: false }, "A", false, now));
  check("owner rule: an abandoned entry -> anyone", P.overlayMayWrite({ ...theirs, at: now - P.OVERLAY_LIVE_STALE_MS - 1 }, "A", false, now) && P.overlayMayWrite({ owner: "B" }, "A", false, now) && P.overlayMayWrite({ ...theirs, at: now + 120000 }, "A", false, now));
  check("owner rule: an old entry without owner is fresh until stale", !P.overlayMayWrite({ at: now - 1000, visible: true }, "A", true, now));
  check("remove rule: only our own", P.overlayMayRemove({ owner: "A", at: now }, "A", now) && !P.overlayMayRemove(theirs, "A", now) && !P.overlayMayRemove(null, "A", now));
  check("remove rule: or an abandoned one (the sweep)", P.overlayMayRemove({ ...theirs, at: now - P.OVERLAY_LIVE_STALE_MS - 1 }, "A", now));
  // two tabs taking turns every tick is what this prevents
  let stored = null;
  let flips = 0;
  for (let t = 0; t < 20; t++) {
    for (const [me, visible] of [["A", true], ["B", true]]) {
      if (!P.overlayMayWrite(stored, me, visible, now + t * 1000)) continue;
      if (stored && stored.owner !== me) flips++;
      stored = { owner: me, at: now + t * 1000, visible };
    }
  }
  check("two tabs on screen: no ping-pong", flips === 0 && stored.owner === "A", `${flips} flips, owner ${stored?.owner}`);
}

console.log("sample data");
{
  const d = O.demo(1_700_000_000_000);
  check("demo live passes the checks", !!O.sanitizeLive(d.live, 1_700_000_000_000));
  check("demo rank is ranked", O.rankView(d.info, S).kind === "ok");
  check("demo session counts", O.sessionView(d.session, new Date(1_700_000_000_000).toDateString()).games === 5);
}

console.log(`\n${total - failures}/${total} checks`);
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
