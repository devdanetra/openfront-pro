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
  check("defaults", eq(d, { widgets: ["rank", "live", "recap"], bg: "transparent", scale: 1, pos: "tr", recap: 20, replay: 25, delay: 0, delayAuto: true, name: true, streamer: false, edit: false, demo: false }), JSON.stringify(d));
  const o = plain(O.parseOptions("?w=live,rank,live,bogus&bg=green&scale=1.25&pos=bl&recap=45&name=0&streamer=1&edit=1"));
  check("all options", eq(o, { widgets: ["live", "rank"], bg: "green", scale: 1.25, pos: "bl", recap: 45, replay: 25, delay: 0, delayAuto: true, name: false, streamer: true, edit: true, demo: false }), JSON.stringify(o));
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
  const bad = plain(O.sanitizeLive({ ...good, phase: "hacked", share: 7, place: 99, humans: 50, humansTotal: 3, seconds: -3, map: "A\u202eB<img src=x>".repeat(10), top: [{ share: "1" }, 5, null, { share: 0.2 }] }, now));
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

  // #2: with a delay the page asks at vnow = now - delay: a card made after vnow waits
  for (const delay of [30, 90]) {
    const at = now; // the card was made now; the delayed stream is `delay` s behind
    const card = { ...recap, at };
    const early = plain(O.recapState(card, { gameId: "AbCd1234", phase: "watching" }, 20, now + 10000 - delay * 1000));
    check(`delay ${delay}: not before the delayed stream reaches the end`, early.show === false && early.startsIn === (delay - 10) * 1000, JSON.stringify(early));
    const opts = plain(O.parseOptions(`?delay=${delay}`));
    const lv = { gameId: "AbCd1234", phase: "playing" };
    check(`delay ${delay}: ...so the (delayed) live card stays up meanwhile`, eq(plain(O.layout(opts, { rank: { kind: "ok" }, session: { games: 1 }, live: lv, recap: card }, now + 10000 - delay * 1000)), ["rank", "live"]));
    const due = plain(O.recapState(card, { gameId: "AbCd1234", phase: "ended" }, 20, now + delay * 1000 - delay * 1000));
    check(`delay ${delay}: shown once it does, for its full time`, due.show === true && due.frac === 1, JSON.stringify(due));
    check(`delay ${delay}: then gone`, plain(O.recapState(card, null, 20, now + (delay + 20) * 1000 - delay * 1000)).show === false);
  }
  check("a card from far in the future is not waited for", plain(O.recapState({ ...recap, at: now + (O.MAX_DELAY + 120) * 1000 }, null, 20, now)).startsIn === undefined);

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
  vm.runInContext(`${content.slice(from, to)}\nthis.P = { OVERLAY_STALE_MS, OVERLAY_LIVE_STALE_MS, OVERLAY_KEYS, OVERLAY_REPLAY_MAX, REPLAY_TRIES, replayFirstPlan, replayNextPlan, overlayLabel, overlayShare, overlaySignature, overlayMayWrite, overlayMayRemove };`, C);
  const P = C.P;
  check("same live stale limit as the page", P.OVERLAY_LIVE_STALE_MS === O.LIVE_STALE_MS);
  check("everything published is cleared", eq(plain(P.OVERLAY_KEYS).sort(), ["overlayLive", "overlayMask", "overlayRecap", "overlayReplay", "overlaySelf"]));

  // labels: the same rule on both sides
  const samples = ["World", "Gulf of St. Lawrence", "Baikal (Nuke Wars)", "Free For All", "Team", " Europe ", "", "twitch.tv/x !!", "<b>x</b>", "a".repeat(41), "Ünïcode", "A\u202eB", "x\ny", 5, null];
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

// ---- observer mode: caster card, delay, replay ----------------------------------------------
console.log("caster options and delay");
{
  const c = plain(O.parseOptions("?w=caster"));
  check("w=caster -> delay 90 by default", c.delay === O.CASTER_DELAY && O.CASTER_DELAY === 90 && eq(c.widgets, ["caster"]), JSON.stringify(c));
  check("no caster card -> no delay", O.parseOptions("?w=rank,live").delay === 0 && O.parseOptions("").delay === 0);
  check("delay=0 turns it off with the caster card", O.parseOptions("?w=caster&delay=0").delay === 0);
  check("delay set by hand, also without the caster card", O.parseOptions("?w=caster&delay=45").delay === 45 && O.parseOptions("?delay=30").delay === 30);
  check("delay clamped 0..600 and rounded", O.parseOptions("?w=caster&delay=9999").delay === 600 && O.parseOptions("?w=caster&delay=-5").delay === 0 && O.parseOptions("?delay=12.4").delay === 12);
  check("junk delay -> the default", O.parseOptions("?w=caster&delay=abc").delay === 90 && O.parseOptions("?delay=").delay === 0);
  check("replay seconds clamped, 0 = off", O.parseOptions("?replay=0").replay === 0 && O.parseOptions("?replay=9999").replay === 600 && O.parseOptions("?replay=x").replay === 25);
  const both = plain(O.parseOptions("?w=rank,caster,recap&delay=120&replay=40&pos=bl"));
  check("widget order with the caster card", eq(both.widgets, ["rank", "caster", "recap"]));
  check("round trip: caster, delay, replay", eq(plain(O.parseOptions(O.buildQuery(both))), both), O.buildQuery(both));
  check("the default delay of the caster card is not written out", O.buildQuery(plain(O.parseOptions("?w=caster"))) === "?w=caster", O.buildQuery(plain(O.parseOptions("?w=caster"))));
  check("delay=0 with the caster card is written out", O.buildQuery(plain(O.parseOptions("?w=caster&delay=0"))) === "?w=caster&delay=0");
  check("an OBS address keeps delay and replay", /delay=120/.test(O.buildQuery(both, { forObs: true })) && /replay=40/.test(O.buildQuery(both, { forObs: true })));
  check("the worker's hash filter accepts the caster address", /^#[\w=&%.-]{0,200}$/.test(`#${O.buildQuery({ ...both, bg: "green", edit: true }).slice(1)}`));

  // #11: a watched game is delayed with the default cards too
  check("no delay= in the address: automatic", O.parseOptions("").delayAuto === true && O.parseOptions("?w=caster").delayAuto === true && O.parseOptions("?delay=0").delayAuto === false && O.parseOptions("?delay=abc").delayAuto === true);
  check("delay=0 set by hand is written out even with the default cards (it keeps a watched game undelayed)", O.buildQuery(plain(O.parseOptions("?delay=0"))) === "?delay=0" && plain(O.parseOptions(O.buildQuery(plain(O.parseOptions("?delay=0"))))).delayAuto === false);
  const eff = (q, watched) => O.effectiveDelay(plain(O.parseOptions(q)), watched);
  check("default cards: 0 for your own game, 90 s for a game you watch", eff("", false) === 0 && eff("", true) === O.CASTER_DELAY);
  check("caster card: 90 s either way", eff("?w=caster", false) === 90 && eff("?w=caster", true) === 90);
  check("a delay set by hand always wins", eff("?delay=0", true) === 0 && eff("?delay=30", true) === 30 && eff("?w=caster&delay=0", true) === 0 && eff("?delay=45", false) === 45);
  check("options from before delayAuto: a non-default delay counts as set by hand", O.effectiveDelay({ widgets: ["rank"], delay: 20 }, true) === 20 && O.effectiveDelay({ widgets: ["rank"], delay: 0 }, true) === 90);
  const watched = { gameId: "AbCd1234", phase: "watching" };
  const mine = { gameId: "AbCd1234", phase: "playing" };
  check("a watched game: phase 'watching' or caster data", O.isWatched(watched) && O.isWatched({ phase: "ended", caster: { board: [] } }) && !O.isWatched(mine) && !O.isWatched(null));
  const t0 = 1_700_000_000_000;
  let buf = O.delayPush([], watched, t0, 100000);
  buf = O.delayPush(buf, null, t0 + 5000, 100000);
  check("spectated: now, or still playing out of the buffer", O.spectated([], watched) && O.spectated(buf, null) && !O.spectated(O.delayPush([], mine, t0, 100000), mine) && !O.spectated(null, null));
}

console.log("delayed rank card (overlay.js)");
{
  // the rank card's buffers: the first value is history (shown at once, got 0), later
  // ones as late as the game cards
  const t0 = 1_700_000_000_000;
  const D = 90000;
  let s = O.delayPush([], { games: 2 }, 0, D + 10000);
  s = O.delayPush(s, { games: 3 }, t0, D + 10000);
  check("a game recorded just now: today's pips still show the old count", plain(O.delayPick(s, t0 + 10000, D)).games === 2);
  check("...and the new one when the delayed stream gets there", plain(O.delayPick(s, t0 + D, D)).games === 3);
  check("the first value shows at once", plain(O.delayPick(O.delayPush([], { games: 1 }, 0, D), t0, D)).games === 1);
  const page = fs.readFileSync(path.join(ROOT, "src/overlay.js"), "utf8");
  check("overlay.js: session and rank lookups go through the delay buffers", /delayed\("infoBuf", state\.info, now, delayMs\)/.test(page) && /delayed\("sessionBuf", state\.session, now, delayMs\)/.test(page) && /hold\("sessionBuf"/.test(page) && /hold\("infoBuf"/.test(page));
  check("overlay.js: the delay in force is the effective one (a watched game with the default cards)", /O\.effectiveDelay\(opts, O\.spectated\(state\.buffer, state\.live\)\)/.test(page) && !/opts\.delay \* 1000/.test(page));
  check("overlay.js: a recap still to come keeps the page ticking", /rs\.startsIn != null/.test(page));
}

console.log("delay buffer");
{
  const t0 = 1_700_000_000_000;
  let buf = [];
  const D = 90000;
  for (let s = 0; s <= 200; s += 2) buf = O.delayPush(buf, { n: s }, t0 + s * 1000, D);
  check("nothing older than needed is kept", buf.length <= D / 2000 + 3, `${buf.length} entries`);
  check("pick: the state from 90 s ago", plain(O.delayPick(buf, t0 + 200000, D))?.n === 110);
  check("pick: between two writes, the older one", plain(O.delayPick(buf, t0 + 201500, D))?.n === 110);
  check("pick: nothing that old yet", O.delayPick(O.delayPush([], { n: 1 }, t0, D), t0 + 1000, D) === null);
  check("pending while a newer state waits", O.delayPending(O.delayPush([], { n: 1 }, t0, D), t0 + 1000, D) === true);
  let gone = O.delayPush(buf, null, t0 + 202000, D);
  check("a game that ended is played out late too", plain(O.delayPick(gone, t0 + 250000, D))?.n === 160 && O.delayPick(gone, t0 + 292000, D) === null);
  check("delay 0 = the newest", plain(O.delayPick(buf, t0 + 200000, 0))?.n === 200);
  check("junk in, nothing out", O.delayPick(null, t0, D) === null && eq(plain(O.delayPush(null, { n: 1 }, NaN, D)), []));
  gone = O.delayPush(gone, { n: 999 }, t0 + 100000, D); // a clock that went back
  check("an entry from the future is not kept past a newer one", plain(gone).every((e, i, a) => i === 0 || e.got >= a[i - 1].got));
  let big = [];
  for (let i = 0; i < 5000; i++) big = O.delayPush(big, { i }, t0 + i * 10, 600000);
  check("bounded in memory", big.length <= 2400, `${big.length}`);
}

console.log("caster card data");
{
  const now = 1_700_000_000_000;
  const caster = {
    teamGame: true,
    playersAlive: 19,
    humansAlive: 11,
    humansTotal: 42,
    more: 3,
    board: [
      { place: 1, name: "[OFP] Kestrel", team: "Red", share: 0.21, frac: 1, alive: true, rgb: [224, 68, 62], band: "elite" },
      { place: null, name: "A\u202eB <img src=x onerror=alert(1)>", team: "Blue", share: 0, frac: 0, alive: false, outAt: 612, rgb: [300, -5, "x"], band: "godlike" },
      "junk",
    ],
    teams: [{ name: "Red", share: 0.4, frac: 1, alive: 3, total: 4, rgb: [224, 68, 62] }, { name: "<b>x</b>", share: 0.2 }],
    feed: [{ at: 612, name: "Anon1", human: true, rgb: [1, 2, 3] }, { at: "x" }],
  };
  const l = plain(O.sanitizeLive({ gameId: "AbCd1234", at: now, phase: "watching", seconds: 700, caster }, now));
  const c = l.caster;
  check("caster data passes", c && c.board.length === 2 && c.teams.length === 1 && c.feed.length === 1 && c.humansAlive === 11, JSON.stringify(c));
  check("names: bidi overrides out, text kept as text (drawn with textContent)", c.board[1].name === "AB <img src=x onerror=alert(1)>", JSON.stringify(c.board[1].name));
  check("colours clamped, junk colour dropped", c.board[0].rgb.join() === "224,68,62" && c.board[1].rgb === null);
  check("unknown rank band dropped", c.board[0].band === "elite" && c.board[1].band === null);
  check("team names: plain words only", c.teams[0].name === "Red");
  check("eliminated at", c.board[1].outAt === 612 && c.board[1].alive === false);
  check("no caster data: none", plain(O.sanitizeLive({ gameId: "AbCd1234", at: now }, now)).caster === null);
  check("bad caster data: none", plain(O.sanitizeLive({ gameId: "AbCd1234", at: now, caster: { board: "x" } }, now)).caster === null);
  const long = plain(O.sanitizeCaster({ board: Array.from({ length: 40 }, (_, i) => ({ place: i + 1, name: "x".repeat(99), share: 0.01 })), feed: Array.from({ length: 40 }, () => ({ at: 1 })) }));
  check("capped: 12 rows, 8 eliminations, 40-character names", long.board.length === 12 && long.feed.length === 8 && long.board[0].name.length === 40);
}

console.log("replay");
{
  const now = 1_700_000_000_000;
  const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  const r = plain(O.sanitizeReplay({ gameId: "AbCd1234", at: now, gif, streamer: false }));
  check("a good replay passes", r && r.gif === gif && r.streamer === false);
  check("only a GIF", O.sanitizeReplay({ gameId: "AbCd1234", at: now, gif: "data:image/png;base64,AA==" }) === null && O.sanitizeReplay({ gameId: "AbCd1234", at: now, gif: "https://x/y.gif" }) === null && O.sanitizeReplay({ gameId: "AbCd1234", at: now, gif: 'data:image/gif;base64,AA" onload="x' }) === null);
  check("too big", O.sanitizeReplay({ gameId: "AbCd1234", at: now, gif: `data:image/gif;base64,${"A".repeat(O.MAX_GIF)}` }) === null);
  check("a skipped one carries its note", eq(plain(O.sanitizeReplay({ gameId: "AbCd1234", at: now, gif: null, note: "size" })), { gameId: "AbCd1234", at: now, gif: null, streamer: false, note: "size" }));
  check("unknown note dropped", plain(O.sanitizeReplay({ gameId: "AbCd1234", at: now, note: "<b>" })).note === null);
  const masked = plain(O.sanitizeReplay({ gameId: "AbCd1234", at: now, gif, streamer: true }));
  check("masking like the recap card", O.replayFor(r, false) === r && O.replayFor(r, true) === null && O.replayFor(masked, true) === masked);

  const opts = plain(O.parseOptions(""));
  const recap = { gameId: "AbCd1234", at: now, png: "data:image/png;base64,AA==" };
  const ended = { gameId: "AbCd1234", phase: "ended" };
  const S = (o, t, rc = recap, lv = ended) => plain(O.replayState(r, rc, lv, o, t));
  check("after the recap card: not yet", S(opts, now + 10000).show === false && S(opts, now + 10000).startsIn === 10000);
  check("...then for replay seconds", S(opts, now + 20000).show === true && S(opts, now + 44000).show === true && Math.abs(S(opts, now + 32500).frac - 0.5) < 1e-9);
  check("...then gone", S(opts, now + 45000).show === false && S(opts, now + 45000).done === true);
  check("no recap card: right away", S(opts, now + 1000, null).show === true);
  check("recap cards off: right away", S({ ...opts, widgets: ["rank", "live"] }, now + 1000).show === true);
  check("recap=0 (until the next game): no replay", S({ ...opts, recap: 0 }, now + 3600000).show === false);
  check("replay=0: off", S({ ...opts, replay: 0 }, now + 21000).show === false);
  check("never over a different game being played", S(opts, now + 21000, recap, { gameId: "Next5678", phase: "playing" }).show === false);
  check("a late recap card pushes the replay back", plain(O.replayState(r, { ...recap, at: now + 15000 }, ended, opts, now + 21000)).show === false);
  check("a skipped replay never shows", plain(O.replayState({ ...r, gif: null }, null, ended, opts, now + 1000)).show === false);

  const L = (o, st, t) => plain(O.layout(o, st, t));
  const caster = { board: [], teams: [], feed: [] };
  check("caster card for a watched game", eq(L({ ...opts, widgets: ["caster"] }, { live: { gameId: "AbCd1234", phase: "watching", caster } }, now), ["caster"]));
  check("no caster card while you play", eq(L({ ...opts, widgets: ["caster"] }, { live: { gameId: "AbCd1234", phase: "playing", caster: null } }, now), []));
  check("recap, then replay, then gone", eq(L(opts, { live: ended, recap, replay: r }, now + 5000), ["recap"]) && eq(L(opts, { live: ended, recap, replay: r }, now + 25000), ["replay"]) && eq(L(opts, { live: ended, recap, replay: r }, now + 60000), []));
  check("caster variant: replay after the game, then gone", eq(L({ ...opts, widgets: ["caster"] }, { live: { ...ended, caster }, replay: r }, now + 1000), ["replay"]) && eq(L({ ...opts, widgets: ["caster"] }, { live: { ...ended, caster }, replay: r }, now + 30000), []));
  check("a game still running keeps its card after an old replay", eq(L({ ...opts, widgets: ["caster"] }, { live: { gameId: "AbCd1234", phase: "watching", caster }, replay: r }, now + 30000), ["caster"]));
}

console.log("replay size (content.js)");
{
  const content = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const C = { Number, Math, JSON };
  vm.createContext(C);
  vm.runInContext(`${content.slice(content.indexOf("// <overlay-pure>"), content.indexOf("// </overlay-pure>"))}\nthis.P = { OVERLAY_REPLAY_MAX, REPLAY_TRIES, replayFirstPlan, replayNextPlan };`, C);
  const P = C.P;
  check("same size cap on both sides", P.OVERLAY_REPLAY_MAX === O.MAX_GIF);
  check("first try: up to 150 frames, twice the size", eq(plain(P.replayFirstPlan(360)), { maxFrames: 150, maxScale: 2 }) && eq(plain(P.replayFirstPlan(40)), { maxFrames: 40, maxScale: 2 }));
  check("it fits: done", P.replayNextPlan({ maxFrames: 150, maxScale: 2 }, P.OVERLAY_REPLAY_MAX) === null && P.replayNextPlan({ maxFrames: 150, maxScale: 2 }, 1000) === null);
  const a = plain(P.replayNextPlan({ maxFrames: 150, maxScale: 2 }, Math.round(P.OVERLAY_REPLAY_MAX * 1.2)));
  check("a bit over: fewer frames, same size", a.maxScale === 2 && a.maxFrames < 150 && a.maxFrames >= 100, JSON.stringify(a));
  const b = plain(P.replayNextPlan({ maxFrames: 150, maxScale: 2 }, P.OVERLAY_REPLAY_MAX * 6));
  check("far over: the recorded size, more frames back", b.maxScale === 1 && b.maxFrames > 40, JSON.stringify(b));
  check("hopeless: skipped", plain(P.replayNextPlan({ maxFrames: 40, maxScale: 1 }, 20_000_000)).skip === true);
  // a model of the encoder: bytes ~ frames x pixels; every plan either shrinks or stops
  const model = (p) => p.maxFrames * (p.maxScale === 2 ? 60000 : 20000);
  let plan = plain(P.replayFirstPlan(360));
  let tries = 0;
  let size = model(plan);
  while (tries < P.REPLAY_TRIES) {
    const next = P.replayNextPlan(plan, size);
    tries++;
    if (!next || next.skip) break;
    check(`plan ${tries} makes progress`, next.maxFrames < plan.maxFrames || next.maxScale < plan.maxScale, JSON.stringify([plan, next]));
    plan = plain(next);
    size = model(plan);
  }
  check("a big game fits within the tries", size <= P.OVERLAY_REPLAY_MAX && tries <= P.REPLAY_TRIES, `${size} after ${tries}`);

  // #10: storage room
  check("the replay is at most 1.5 MB of storage", O.MAX_GIF <= 1_500_000 && P.OVERLAY_REPLAY_MAX <= 1_500_000);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const TOURNEY_CACHE = 3_000_000; // tournament-core.js CACHE_CAPS.bytes
  check("manifest: Chrome 114+ (storage.local is 10 MB there, 5 MB before)", manifest.minimum_chrome_version === "114");
  check("recap + replay + tournament cache stay well under the 10 MB of storage.local", O.MAX_GIF + O.MAX_PNG + TOURNEY_CACHE <= 7_000_000);
  check("...and the tournament cache cap is still that", /bytes: 3_000_000/.test(fs.readFileSync(path.join(ROOT, "src/tournament-core.js"), "utf8")));
}

console.log("overlay images in storage (content.js)");
{
  // overlayMakeRoom / overlayPutCard, run as they are against a stand-in storage that
  // records every change event the way chrome.storage.onChanged would hand it out
  const content = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const from = content.indexOf("const OVERLAY_CARD_KEYS");
  const end = content.indexOf("\n}\n", content.indexOf("async function overlayPutCard")) + 3;
  check("content.js has overlayMakeRoom / overlayPutCard", from > 0 && end > from);
  check("every recap / replay write goes through overlayPutCard", !/chrome\.storage\.local\.set\(\{ overlay(Recap|Replay):/.test(content) && (content.match(/overlayPutCard\("overlayReplay"/g) ?? []).length === 3 && (content.match(/overlayPutCard\("overlayRecap"/g) ?? []).length === 1);
  const store = {};
  const events = [];
  const chrome = {
    storage: {
      local: {
        get: async (k) => ({ [k]: store[k] }),
        remove: async (keys) => {
          const ev = {};
          for (const k of [].concat(keys)) if (k in store) (ev[k] = { oldValue: store[k] }), delete store[k];
          if (Object.keys(ev).length) events.push(ev);
        },
        set: async (items) => {
          const ev = {};
          for (const [k, v] of Object.entries(items)) (ev[k] = { oldValue: store[k], newValue: v }), (store[k] = v);
          events.push(ev);
        },
      },
    },
  };
  const C = { chrome, Promise, Array, Object, JSON };
  vm.createContext(C);
  vm.runInContext(`${content.slice(from, end)}\nthis.put = overlayPutCard; this.cardGame = overlayCardGame;`, C);
  const img = (n) => "x".repeat(n);
  store.overlayRecap = { gameId: "Game0001", png: img(10) };
  store.overlayReplay = { gameId: "Game0001", gif: img(10) };
  await C.put("overlayRecap", { gameId: "Game0002", png: img(10) });
  check("a new game's recap: the previous game's recap and replay go first", store.overlayRecap.gameId === "Game0002" && !("overlayReplay" in store), JSON.stringify(Object.keys(store)));
  await C.put("overlayReplay", { gameId: "Game0002", gif: img(10) });
  check("...its replay then keeps the recap of the same game", store.overlayRecap?.gameId === "Game0002" && store.overlayReplay?.gameId === "Game0002");
  events.length = 0;
  await C.put("overlayReplay", { gameId: "Game0002", gif: img(12), streamer: true });
  check("the replay made again (masking): removed first, then written", events.length === 2 && "overlayReplay" in events[0] && events[0].overlayReplay.newValue === undefined && events[1].overlayReplay.oldValue === undefined, JSON.stringify(events.map((e) => Object.keys(e))));
  events.length = 0;
  await C.put("overlayReplay", { gameId: "Game0003", gif: img(10) });
  check("never an old and a new image in one change event", events.length >= 2 && events.every((e) => !Object.values(e).some((c) => c.oldValue && c.newValue)), JSON.stringify(events.map((e) => Object.keys(e))));
  check("the stored cards are known afterwards (no re-read)", C.cardGame.overlayReplay === "Game0003" && C.cardGame.overlayRecap === null);
}

console.log("sample data");
{
  const d = O.demo(1_700_000_000_000);
  check("demo watched game passes the checks, with its caster card", !!plain(O.sanitizeLive(d.watch, 1_700_000_000_000))?.caster?.board?.length);
  check("demo live passes the checks", !!O.sanitizeLive(d.live, 1_700_000_000_000));
  check("demo rank is ranked", O.rankView(d.info, S).kind === "ok");
  check("demo session counts", O.sessionView(d.session, new Date(1_700_000_000_000).toDateString()).games === 5);
}

console.log(`\n${total - failures}/${total} checks`);
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
