// Clan hub: the pure logic (src/clans-logic.js - weeks, movers, rates, recruit
// filtering and sorting, clan comparison, head-to-head) and the worker's new
// "clanTable" route (src/background.js run in node:vm with a fake chrome.* and a
// fake fetch: shape, cache, consent gate). No network.
//
//   node tools/test-clans.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

let failures = 0;
let passes = 0;
function ok(cond, what) {
  if (cond) passes++;
  else {
    failures++;
    console.log("FAIL", what);
  }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const near = (a, b, what, eps = 1e-9) => ok(Math.abs(a - b) <= eps, `${what}: got ${a}, want ${b}`);

// ---- load the pure half ------------------------------------------------------------------------------
const sb = { console };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src("scoring.js"), sb);
vm.runInContext(src("clans-logic.js"), sb);
const L = sb.OFR_CLAN_LOGIC;
const S = sb.OFR_SCORING;
ok(L && S, "OFR_CLAN_LOGIC loads in node");

// ---- names and tags -----------------------------------------------------------------------------------
eq(L.normTag("[lux]"), "LUX", "normTag strips brackets, upper-cases");
eq(L.normTag("TOOLONG"), null, "normTag rejects 6+ chars");
eq(L.normTag("a b"), null, "normTag rejects spaces");
eq(L.splitName("[LUX] TeNa"), { tag: "LUX", bare: "TeNa" }, "splitName tagged");
eq(L.splitName("TeNa"), { tag: null, bare: "TeNa" }, "splitName bare");
ok(L.isGuest("Anon289") && L.isGuest("AnonFox12") && !L.isGuest("Anonymous Bob"), "guest handles");
ok(L.isSelf("[LUX] TeNa", "[lux] tena"), "isSelf same full name, any case");
ok(L.isSelf("TeNa", "[LUX] TeNa"), "isSelf: your bare name counts as you (streamer mode errs on hiding)");
ok(!L.isSelf("TeNa2", "[LUX] TeNa") && !L.isSelf("x", null), "isSelf negatives");

// ---- ISO weeks (ofstats' 2026-W38 started 1789344000000 = Mon 14 Sep 2026 00:00 UTC) ---------------------
eq(L.weekStart("2026-W38"), 1789344000000, "weekStart matches ofstats' weekStart");
eq(L.isoWeek(1789344000000), "2026-W38", "isoWeek of a Monday");
eq(L.isoWeek(1789948800000 - 1), "2026-W38", "isoWeek of the Sunday's last ms");
eq(L.shiftWeek("2026-W38", -1), "2026-W37", "shiftWeek -1");
eq(L.shiftWeek("2026-W01", -1), "2025-W52", "shiftWeek across a year");
eq(L.shiftWeek("2021-W01", -1), "2020-W53", "shiftWeek into a 53-week year");
eq(L.shiftWeek("2020-W53", 1), "2021-W01", "shiftWeek out of a 53-week year");
eq(L.shiftWeek("junk", 1), null, "shiftWeek rejects junk");
eq(L.weekNumber("2026-W07"), 7, "weekNumber");

// ---- movers -----------------------------------------------------------------------------------------------
{
  const cur = [
    { tag: "UN", rank: 1 },
    { tag: "ITA", rank: 2 },
    { tag: "NU", rank: 3 },
    { tag: "NEW", rank: 4 },
    { tag: "GAL", rank: 5 },
  ];
  const prev = [
    { tag: "UN", rank: 1 },
    { tag: "GAL", rank: 2 },
    { tag: "JR", rank: 3 },
    { tag: "NU", rank: 4 },
    { tag: "ITA", rank: 5 },
  ];
  const m = L.movers(cur, prev);
  ok(m.known, "movers: previous week known");
  eq(m.up.map((r) => [r.tag, r.delta]), [["ITA", 3], ["NU", 1]], "movers: climbers, biggest first");
  eq(m.down.map((r) => [r.tag, r.delta]), [["GAL", -3]], "movers: fallers");
  eq(m.entered.map((r) => r.tag), ["NEW"], "movers: entered the table");
  eq(m.left.map((r) => r.tag), ["JR"], "movers: left the table");
  eq(m.byTag.get("UN").delta, 0, "movers: unchanged is 0");
  const none = L.movers(cur, []);
  ok(!none.known && none.entered.length === 0 && none.up.length === 0, "movers: no previous week, no invented movers");
  eq(L.movers(cur, prev, { limit: 1 }).up.length, 1, "movers: limit");
}

// ---- one clan ----------------------------------------------------------------------------------------------
{
  // shape of /clans/LUX as background.js fetchClan returns it (numbers from a real answer)
  const clan = {
    games: 22574,
    wins: 6067,
    memberCount: 1530,
    activeMembers: 574,
    team: { games: 5509, wins: 1657, stackedGames: 959, stackedWins: 481, recentGames: 50, recentWins: 11, avgStack: 1.36 },
    reference: { stackedWinRate: 19.801076302133385 },
  };
  const r = L.clanRates(clan);
  near(r.all, 6067 / 22574, "clanRates all");
  near(r.team, 1657 / 5509, "clanRates team");
  near(r.stacked, 481 / 959, "clanRates stacked");
  near(r.recent, 11 / 50, "clanRates recent");
  near(r.stackedRef, 0.19801076302133385, "clanRates reference");
  near(r.active, 574 / 1530, "clanRates active share");
  const empty = L.clanRates({ games: 0, wins: 0 });
  ok(empty.all === null && empty.team === null && empty.active === null, "clanRates: no games = no rate, not 0 or NaN");

  const now = Date.UTC(2026, 8, 19);
  const day = 86400000;
  const act = L.memberActivity(
    [{ lastPlayed: new Date(now - 2 * day).toISOString() }, { lastPlayed: new Date(now - 20 * day).toISOString() }, { lastPlayed: new Date(now - 90 * day).toISOString() }, { lastPlayed: null }],
    now,
  );
  eq(act, { week: 1, month: 1, idle: 1, unknown: 1, total: 4 }, "memberActivity buckets");
}

// ---- profiles, strength, maps ------------------------------------------------------------------------------------
const now = Date.UTC(2026, 8, 19);
const DAY = 86400000;
function player(name, { ratio = 1, games = 100, mode = { ffa: 80, team: 20, ranked: 0 }, seenDays = 1, maps = null, recent = [] } = {}) {
  const expectedWins = games * 0.1;
  return {
    found: true,
    username: name,
    games,
    wins: Math.round(expectedWins * ratio),
    ratedGames: games,
    ratedWins: expectedWins * ratio,
    expectedWins,
    modes: [
      { mode: "Free For All", games: mode.ffa, wins: 1 },
      { mode: "Team", games: mode.team, wins: 1 },
      { mode: "Ranked", games: mode.ranked, wins: 0 },
    ],
    lastSeen: new Date(now - seenDays * DAY).toISOString(),
    recentGames: recent,
    maps: maps ?? [{ map: "World", games, wins: expectedWins * ratio, expectedWins }],
  };
}
{
  const p = L.profile(player("Ace", { ratio: 2.2 }), now);
  ok(p.pct != null && p.pct <= 5, `profile: strong ratio ranks high (${p?.pct})`);
  eq(p.band, "elite", "profile band");
  eq(p.modes.ffa.games, 80, "profile: FFA games");
  eq(p.modes.team.games, 20, "profile: team games");
  near(p.lastSeenDays, 1, "profile: last seen in days");
  ok(L.profile({ found: false }) === null, "profile: not found -> null");
  const few = L.profile({ ...player("Few", { games: 2 }), ratedGames: 2 }, now);
  ok(few && few.pct === null, "profile: under 3 rated games -> no percentile");

  const profs = [L.profile(player("a", { ratio: 2.2 }), now), L.profile(player("b", { ratio: 1 }), now), few, null];
  const st = L.memberStrength(profs);
  eq(st.ranked, 2, "memberStrength: ranked count");
  near(st.avgPct, (profs[0].pct + profs[1].pct) / 2, "memberStrength: mean of the ranked");
  eq(st.counts.unranked, 2, "memberStrength: unranked + missing counted");
  eq(st.counts.elite, 1, "memberStrength: elite");

  const infos = [
    player("m1", { maps: [{ map: "World", games: 20, wins: 6, expectedWins: 2 }, { map: "Europe", games: 30, wins: 2, expectedWins: 3 }] }),
    player("m2", { maps: [{ map: "World", games: 10, wins: 3, expectedWins: 1 }, { map: "Tiny", games: 4, wins: 4, expectedWins: 0.4 }] }),
  ];
  const maps = L.clanMaps(infos, { minGames: 10 });
  eq(maps.map((m) => m.map), ["World", "Europe"], "clanMaps: best first, thin maps dropped");
  eq([maps[0].games, maps[0].wins, maps[0].players], [30, 9, 2], "clanMaps: summed over members");
}

// ---- clan vs clan ---------------------------------------------------------------------------------------------------
{
  const a = { points: 17463, rank: 1, rates: { all: 0.26, team: 0.3, stacked: 0.376, recent: 0.2, active: 0.4 }, memberCount: 9000, games: 18236, avgPct: 30 };
  const b = { points: 92, rank: 43, rates: { all: 0.27, team: 0.3, stacked: 0.5, recent: null, active: 0.37 }, memberCount: 1530, games: 22574, avgPct: 20 };
  const rows = L.compareRows(a, b);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  ok(by.points.a.better && !by.points.b.better, "compare: more points is better");
  near(by.points.a.frac, 1, "compare: counts scale to the larger side");
  near(by.points.b.frac, 92 / 17463, "compare: counts scale to the larger side (b)");
  ok(by.rank.a.better && by.rank.a.frac > by.rank.b.frac, "compare: rank - lower is better and gets the longer bar");
  ok(by.strength.b.better && by.strength.b.frac > by.strength.a.frac, "compare: member percentile - lower is better");
  ok(!by.team.a.better && !by.team.b.better, "compare: a tie marks nobody");
  ok(by.recent.a.value === 0.2 && by.recent.b.value === null && !by.recent.a.better, "compare: one side missing is shown, not judged");
  near(by.stacked.b.frac, 0.5, "compare: rates are drawn as they are");
  ok(rows.every((r) => r.a.frac >= 0 && r.a.frac <= 1 && r.b.frac >= 0 && r.b.frac <= 1), "compare: fractions within 0..1");
  eq(L.compareRows({}, {}).length, 0, "compare: nothing known, no rows");
}

// ---- head-to-head --------------------------------------------------------------------------------------------------------
{
  const clanGamesA = [
    { id: "g1", mode: "Free For All", winner: "[AAA] alice", end: 5 },
    { id: "g2", mode: "Team", winner: "Team: Red", end: 4 },
    { id: "g9", mode: "Free For All", winner: "France", end: 9 },
  ];
  const clanGamesB = [
    { id: "g1", mode: "Free For All", winner: "[AAA] alice", end: 5 },
    { id: "g2", mode: "Team", winner: "Team: Red", end: 4 },
    { id: "g8", mode: "Free For All", winner: "[BBB] bob", end: 8 },
  ];
  const playersA = [{ name: "alice", recentGames: [{ id: "g3", won: true, mode: "Team", date: 3 }, { id: "g4", won: false, mode: "Team", date: 2 }, { id: "g5", won: false, mode: "Free For All", date: 1 }] }];
  const playersB = [{ name: "bob", recentGames: [{ id: "g3", won: true, mode: "Team", date: 3 }, { id: "g4", won: true, mode: "Team", date: 2 }, { id: "g5", won: false, mode: "Free For All", date: 1 }, { id: "g8", won: true, mode: "Free For All", date: 8 }] }];
  const h = L.headToHead({ tagA: "AAA", tagB: "BBB", clanGamesA, clanGamesB, playersA, playersB });
  const out = Object.fromEntries(h.games.map((g) => [g.id, g.outcome]));
  eq(out, { g1: "a", g2: "unknown", g3: "allies", g4: "b", g5: "neither" }, "headToHead outcomes");
  eq([h.a, h.b, h.allies, h.neither, h.unknown], [1, 1, 1, 1, 1], "headToHead counts");
  ok(!("g8" in out) && !("g9" in out), "headToHead: games only one clan was in are not counted");
  eq(h.games.map((g) => g.id), ["g1", "g2", "g3", "g4", "g5"], "headToHead: newest first");
  eq(h.games.find((g) => g.id === "g3").playersA, ["alice"], "headToHead: who was there");
  const nothing = L.headToHead({ tagA: "AAA", tagB: "BBB", clanGamesA: [{ id: "x" }], clanGamesB: [{ id: "y" }] });
  eq(nothing.games.length, 0, "headToHead: no overlap -> nothing invented");
  // A won a team game, B's side only known from the clan list: could have been allies
  const teamOnly = L.headToHead({ tagA: "AAA", tagB: "BBB", clanGamesB: [{ id: "t", mode: "Team", winner: "Team: Blue" }], playersA: [{ name: "a", recentGames: [{ id: "t", won: true, mode: "Team" }] }] });
  eq(teamOnly.games[0].outcome, "unknown", "headToHead: a team win against an unseen side is not called");
}

// ---- week validation (#week=) ------------------------------------------------------------------------------------------------
{
  const t = Date.UTC(2026, 8, 19); // Saturday of 2026-W38
  eq(L.validWeek("2026-W38", t), "2026-W38", "validWeek: this week");
  eq(L.validWeek("2026-W37", t), "2026-W37", "validWeek: last week");
  eq(L.validWeek("2026-W39", t), null, "validWeek: next week is refused");
  eq(L.validWeek("2025-W38", t), "2025-W38", "validWeek: 52 weeks back");
  eq(L.validWeek("2025-W37", t), null, "validWeek: more than a year back is refused");
  eq(L.validWeek("2026-W00", t), null, "validWeek: W00");
  eq(L.validWeek("2025-W53", Date.UTC(2026, 0, 20)), null, "validWeek: W53 in a 52-week year");
  eq(L.validWeek("2020-W53", Date.UTC(2021, 0, 20)), "2020-W53", "validWeek: W53 in a 53-week year");
  eq(L.validWeek("2026-W37&sort=x", t), null, "validWeek: junk after the week");
  eq(L.validWeek(null, t), null, "validWeek: null");
}

// ---- streamer mode names ---------------------------------------------------------------------------------------------------
{
  eq(L.displayName("[LUX] TeNa", {}), "TeNa", "displayName: off shows the bare name");
  eq(L.displayName("[LUX] TeNa", { streamer: true, self: "[LUX] TeNa" }), "You", "displayName: you");
  eq(L.displayName("[LUX] Bob", { streamer: true, self: "[LUX] TeNa" }), "Bob", "displayName: others shown once self is known");
  eq(L.displayName("[LUX] Bob", { streamer: true, self: null }), L.MASK, "displayName: self unknown masks everyone");
  ok(L.nameHidden("Bob", { streamer: true, self: null }) && !L.nameHidden("Bob", { streamer: true, self: "TeNa" }) && L.nameHidden("TeNa", { streamer: true, self: "TeNa" }), "nameHidden");
  ok(!L.nameHidden("TeNa", { streamer: false, self: null }), "nameHidden: streamer mode off");
}

// ---- the recruit index: records, merge, cap ------------------------------------------------------------------------------------
{
  const rec = L.recruitRecord({ ...player("Solo Ace", { ratio: 2.3 }), recentGames: [{ id: "g", won: true }], maps: [{ map: "World", games: 100, wins: 23, expectedWins: 10 }] }, 1000);
  eq(Object.keys(rec).sort(), ["at", "games", "lastSeen", "modes", "name", "pct", "wins"], "recruitRecord: slim - no game list, no maps");
  ok(JSON.stringify(rec).length < 400, `recruitRecord: small (${JSON.stringify(rec).length} bytes)`);
  eq(rec.at, 1000, "recruitRecord: lookup time");
  near(rec.pct, Math.round(S.ranked(player("Solo Ace", { ratio: 2.3 })).pct * 100) / 100, "recruitRecord: percentile from OFR_SCORING");
  eq(L.recruitRecord(player("[LUX] TeNa", { ratio: 2 })), null, "recruitRecord: tagged -> none");
  eq(L.recruitRecord(player("AnonFox12", { ratio: 2 })), null, "recruitRecord: guest -> none");
  eq(L.recruitRecord({ found: false, reason: "no-history" }), null, "recruitRecord: miss -> none");
  eq(L.recruitRecord({ ...player("Few", { games: 2 }), ratedGames: 2 }), null, "recruitRecord: no percentile -> none");

  const mk = (name, at) => ({ name, pct: 10, games: 50, wins: 10, lastSeen: null, modes: [], at });
  const T = 100 * 86400000;
  const merged = L.mergeRecruits([mk("A", T - 10), mk("b", T - 5), mk("Old", T - L.RECRUIT_MAX_AGE - 1)], [mk("a", T), mk("B", T - 50)], { now: T });
  eq(merged.map((r) => r.name), ["a", "b"], "mergeRecruits: one per name (newer wins), expired dropped, newest first");
  const many = Array.from({ length: 700 }, (_, i) => mk(`p${i}`, T - i));
  const capped = L.mergeRecruits([], many, { now: T });
  eq(capped.length, L.RECRUIT_CAP, "mergeRecruits: capped");
  eq(L.RECRUIT_CAP, 500, "recruit cap is 500");
  eq(capped.at(-1).name, `p${L.RECRUIT_CAP - 1}`, "mergeRecruits: the most recently looked up are kept");
  eq(L.mergeRecruits(null, null, { now: T }), [], "mergeRecruits: nothing stored");
  ok(JSON.stringify({ v: 1, players: capped.map((r) => ({ ...r, modes: [{ mode: "Free For All", games: 1, wins: 0 }, { mode: "Team", games: 1, wins: 0 }, { mode: "Ranked", games: 1, wins: 0 }] })) }).length < 200000, "a full index stays under 200 KB");

  const back = L.recruitProfile(L.recruitRecord(player("Teamer", { ratio: 1.5, mode: { ffa: 10, team: 85, ranked: 5 }, seenDays: 20 }), now), now);
  eq([back.modes.team.games, back.modes.ffa.games, back.recent.length], [85, 10, 0], "recruitProfile: modes back from the record");
  near(back.lastSeenDays, 20, "recruitProfile: last seen");
}

// ---- recruits from the index ---------------------------------------------------------------------------------------------------
{
  const infos = [
    player("[LUX] TeNa", { ratio: 2.5 }), // tagged: never a recruit (the worker drops it; the hub too)
    player("Solo Ace", { ratio: 2.3, mode: { ffa: 90, team: 10, ranked: 0 }, seenDays: 2 }),
    player("Teamer", { ratio: 1.5, mode: { ffa: 10, team: 85, ranked: 5 }, seenDays: 20 }),
    player("Old Hand", { ratio: 1.9, games: 900, seenDays: 60 }),
    player("Average Joe", { ratio: 1.0, seenDays: 1, mode: { ffa: 95, team: 5, ranked: 0 } }),
    player("Anon77", { ratio: 3 }), // guest handle
    player("Newbie", { ratio: 3, games: 5 }), // too few games
    player("Me Myself", { ratio: 2.8 }),
  ];
  const records = infos.map((i) => L.recruitRecord(i, now)).filter(Boolean);
  // a tagged record slipped in by hand is still left out
  records.push({ name: "[XX] Sneaky", pct: 1, games: 99, wins: 50, lastSeen: null, modes: [], at: now });
  const storage = { v: 1, players: records };

  const all = L.recruits(storage, { maxPct: null, activeDays: null, self: "[ME] Me Myself", now });
  eq(all.list.map((p) => p.username), ["Solo Ace", "Old Hand", "Teamer", "Average Joe"], "recruits: untagged, ranked, not you, best first");
  eq(all.pool, 4, "recruits: pool size");
  const top15 = L.recruits(storage, { maxPct: 15, activeDays: null, self: "[ME] Me Myself", now });
  ok(top15.list.every((p) => p.pct <= 15) && top15.list.length < 4, "recruits: percentile filter");
  eq(L.recruits(storage, { maxPct: null, activeDays: 7, self: "Me Myself", now }).list.map((p) => p.username), ["Solo Ace", "Average Joe"], "recruits: activity filter");
  eq(L.recruits(storage, { maxPct: null, activeDays: null, mode: "team", self: "Me Myself", now }).list.map((p) => p.username), ["Teamer"], "recruits: mode filter");
  eq(L.recruits(storage, { maxPct: null, activeDays: null, sort: "games", self: "Me Myself", now }).list[0].username, "Old Hand", "recruits: sort by games");
  eq(L.recruits(storage, { maxPct: null, activeDays: null, sort: "recent", self: "Me Myself", now }).list.map((p) => p.username), ["Average Joe", "Solo Ace", "Teamer", "Old Hand"], "recruits: sort by recent");
  ok(L.recruits(storage, { maxPct: null, activeDays: null, now }).list.some((p) => p.username === "Me Myself"), "recruits: without a known self nothing is hidden");
  eq(L.recruits({}, {}).list.length, 0, "recruits: empty index");
  eq(L.recruits(null, {}).list.length, 0, "recruits: no index at all");
  eq(L.recruits(records, { maxPct: null, activeDays: null, self: "Me Myself", now }).pool, 4, "recruits: a bare array works too");
}

// ---- log scale ----------------------------------------------------------------------------------------------------------------
near(L.sqrtFrac(17463, 17463), 1, "sqrtFrac max");
near(L.sqrtFrac(1747, 17470), Math.sqrt(0.1), "sqrtFrac mid");
eq(L.sqrtFrac(0, 10), 0, "sqrtFrac zero");
eq(L.compareRows({ games: 1021000 }, { games: 5 })[0].a.text, "1.0M", "compare: millions compact");

// ---- the worker: clanTable route, consent gate, cache -------------------------------------------------------------------------
{
  const bgSrc = src("background.js");
  ok(/const LOOKUP_MESSAGES = new Set\([^)]*"clanTable"/.test(bgSrc), "clanTable is behind the consent gate (LOOKUP_MESSAGES)");

  const T0 = Date.now();
  // what an older version left in storage.local: an expired and a live cache
  // entry, an older cache generation, and data that is not the cache at all
  const store = {
    sync: {},
    local: {
      "ofs7:expired guy": { value: player("Expired Guy", { ratio: 2 }), expiresAt: T0 - 1000 },
      "ofs7:fresh one": { value: player("Fresh One", { ratio: 1.8 }), expiresAt: T0 + 600000 },
      "ofs7:[lux] tagged": { value: player("[LUX] Tagged", { ratio: 2 }), expiresAt: T0 - 1000 },
      "ofs7:clan:LUX": { value: { found: true, tag: "LUX" }, expiresAt: T0 - 1000 },
      // a live name match is no player: it never seeds the recruit index
      "ofs7:match:matched name": { value: { found: true, id: "MATCHED1", via: "games", others: 0, clear: true }, expiresAt: T0 + 600000 },
      "ofs5:older gen": { value: player("Older Gen", { ratio: 2 }), expiresAt: T0 + 600000 },
      // ofs6 answered names, which ofstats now answers 404: "new" for everyone
      "ofs6:stale miss": { value: { found: false, reason: "no-history" }, expiresAt: T0 + 600000 },
      tournaments: { list: [] },
    },
    full: false, // true: storage.local.set rejects like a full quota
  };
  const listeners = { message: [], changed: [] };
  const area = (name) => ({
    get: async (keys) => {
      const all = store[name];
      if (keys == null) {
        if (name === "local") store.getAllLocal = (store.getAllLocal ?? 0) + 1;
        return { ...all };
      }
      if (typeof keys === "string") return keys in all ? { [keys]: all[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in all ? all[k] : d]));
    },
    set: async (items) => {
      if (name === "local" && store.full) throw new Error("QUOTA_BYTES quota exceeded");
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: store[name][k], newValue: v };
        store[name][k] = structuredClone(v);
      }
      for (const f of listeners.changed) f(changes, name);
    },
    remove: async (keys) => {
      for (const k of [].concat(keys)) delete store[name][k];
    },
  });
  const noop = { addListener() {} };
  const chrome = {
    runtime: { id: "test", getManifest: () => ({ version: "0" }), getURL: (p) => p, onMessage: { addListener: (f) => listeners.message.push(f) }, onConnect: noop, onInstalled: noop, onStartup: noop },
    storage: { sync: area("sync"), local: area("local"), session: area("local"), onChanged: { addListener: (f) => listeners.changed.push(f) } },
    tabs: { query: async () => [], create: async () => {}, onUpdated: noop },
    scripting: { executeScript: async () => [], insertCSS: async () => {} },
    notifications: { create() {} },
    permissions: { contains: async () => true, request: async () => true },
    alarms: { create() {}, onAlarm: noop },
  };
  const fetched = [];
  const W38 = {
    week: "2026-W38",
    weekStart: 1789344000000,
    weekEnd: 1789948800000,
    isCurrentWeek: true,
    pagination: { page: 1, limit: 50, total: 9972 },
    clans: [
      { rank: 1, clanTag: "UN", points: 17463, games: 18236, wins: 4691, stackedGames: 5260, stackedWins: 1980, stackedWinRate: 37.6, activeMembers: 2887, pointsPerMember: 6.05, pointsByStack: [] },
      { rank: 2, clanTag: "ITA", points: 1708.8, games: 6027, wins: 990, stackedGames: 397, stackedWins: 158, stackedWinRate: 39.8, activeMembers: 410, pointsPerMember: 4.17 },
    ],
    timeline: { weeks: ["2026-W37", "2026-W38"], series: [{ clanTag: "UN", ranks: [1, 1], points: [21307, 17463] }] },
    clanOfTheWeek: { week: "2026-W37", clanTag: "UN", points: 21307 },
  };
  // ofstats as it is now: /players/<id> answers account ids only (a name gets 404);
  // /names/<bare name> lists the newest games under that name with any tag or case,
  // each with the account's id and the full name it played as; /search lists
  // accounts by their usual name and tag.
  const H = 3600000;
  const PLAYS = [
    // [display name, account id, hours ago]: one row per game
    ["Solo Ace", "SOLOACE1", 1],
    ["[LUX] TeNa", "LUXTENA1", 2],
    ["TeNa", "BARETENA", 1], // the bare name is somebody else
    ["Quota Name", "QUOTANM1", 1],
    ["Fine Name", "FINENAM1", 1],
    // 3 of the 5 recent games under it: a clear pick
    ["Clear Pick", "CLEARPK1", 1], ["Clear Pick", "OTHERCP1", 2], ["Clear Pick", "CLEARPK1", 3], ["Clear Pick", "CLEARPK1", 5], ["Clear Pick", "OTHERCP1", 7],
    // three accounts; the newest played 1 game in 5: not clear
    ["Crowd", "CROWDAA1", 1], ["Crowd", "CROWDBB1", 2], ["Crowd", "CROWDBB1", 3], ["Crowd", "CROWDCC1", 4], ["Crowd", "CROWDCC1", 5],
    ["mixcase", "LOWERMC1", 1], ["MixCase", "UPPERMC1", 4],
    ["Tagged One", "UNTAGGD1", 1], ["[ABC] Tagged One", "ABCTAGD1", 6],
    ["Twin", "TWINAAA1", 1],
    ["Rare", "RAREOTH1", 1], // "[XY] Rare" has no recent game: only the search knows it
    ["Listed", "LISTEDXX", 1], // "Listed Only" is in the name index's account list only
    ["France", "FRANCE99", 1], ["[FR] France", "FRANCE01", 2],
    // plays tagged; a public free-for-all lobby (tags hidden) shows him bare
    ["[TSI] Harry Tohs", "HARRYTS1", 1], ["[TSI] Harry Tohs", "HARRYTS1", 3],
  ];
  const SHARED = { france: 5000 }; // accounts per bare name, where it is not just the plays above
  const LISTED = { "listed only": [{ publicId: "LISTED01", username: "Listed Only", gamesPlayed: 9, wins: 1, lastSeen: new Date(T0 - 90 * 86400000).toISOString() }] };
  const PEOPLE = [
    { type: "person", publicId: "RAREXY01", name: "Rare", clanTag: "XY", score: 50 },
    { type: "person", publicId: "RAREOTH1", name: "Rare", clanTag: null, score: 80 },
  ];
  const NAME_OF = new Map([["RECID001", "[LUX] Rec Guy"], ["MEMBERID", "[IDC] Member"], ["MYSELF01", "[LUX] Me Myself"], ["RAREXY01", "[XY] Rare"], ["LISTED01", "Listed Only"], ["TWINBBB1", "Twin"], ["OTHERME1", "[ZZ] Me Myself"], ["RACEME01", "Race Me"]]);
  for (const [name, id] of PLAYS) if (!NAME_OF.has(id)) NAME_OF.set(id, name);
  const NO_ID_IN_ANSWER = new Set(["RECID001"]); // an answer without its own publicId
  const low = (s) => String(s ?? "").toLowerCase();
  const bareOf = (n) => n.replace(/^\[[A-Za-z0-9]{1,5}\]\s*/, "");
  const fakeFetch = async (url) => {
    fetched.push(String(url));
    const u = new URL(url);
    if (u.pathname === "/clans" && u.searchParams.get("sort")) return new Response('{"error":"Invalid sort"}', { status: 400 });
    if (u.pathname === "/clans") return new Response(JSON.stringify({ ...W38, week: u.searchParams.get("week") ?? W38.week, isCurrentWeek: !u.searchParams.get("week") }), { status: 200 });
    // a clan whose members come with their player id
    if (u.pathname === "/clans/IDC") return new Response(JSON.stringify({ clanTag: "IDC", gamesPlayed: 10, members: [{ username: "[IDC] Member", publicId: "MEMBERID", gamesPlayed: 10, wins: 2 }] }), { status: 200 });
    // OpenFront's record of a finished game: the players' public ids
    if (u.hostname === "api.openfront.io" && u.pathname === "/public/game/RECGAME1") {
      return new Response(JSON.stringify({ info: { gameID: "RECGAME1", config: {}, players: [{ username: "Rec Guy", clanTag: "LUX", clientID: "c1", publicID: "RECID001", stats: {} }] } }), { status: 200 });
    }
    if (u.hostname === "api.openfront.io" && u.pathname === "/public/game/TWINGAME") {
      return new Response(JSON.stringify({ info: { gameID: "TWINGAME", config: {}, players: [{ username: "Twin", clanTag: null, clientID: "c2", publicID: "TWINBBB1", stats: {} }] } }), { status: 200 });
    }
    if (u.hostname === "api.openfront.io" && u.pathname === "/public/game/TWOMEGAM") {
      return new Response(JSON.stringify({ info: { gameID: "TWOMEGAM", config: {}, players: [{ username: "Me Myself", clanTag: "ZZ", clientID: "c3", publicID: "OTHERME1", stats: {} }] } }), { status: 200 });
    }
    if (u.pathname.startsWith("/names/")) {
      const base = decodeURIComponent(u.pathname.slice("/names/".length));
      if (/^Down/.test(base)) return new Response("oops", { status: 502 });
      if (base === "Race Me") await new Promise((r) => setTimeout(r, 300)); // a slow answer
      const rows = PLAYS.filter(([n]) => low(bareOf(n)) === low(base));
      const listed = LISTED[low(base)] ?? null;
      if (!rows.length && !listed) return new Response('{"error":"Name not found"}', { status: 404 });
      const games = rows
        .map(([n, id, h], i) => ({ gameId: `n${i}`, map: "World", mode: "Free For All", date: T0 - h * H, publicId: id, username: n }))
        .sort((a, b) => b.date - a.date);
      const accountCount = SHARED[low(base)] ?? new Set([...rows.map((r) => r[1]), ...(listed ?? []).map((a) => a.publicId)]).size;
      return new Response(JSON.stringify({ name: base, games, pagination: { page: 1, limit: 20, total: games.length, totalPages: 1 }, accounts: listed, accountCount }), { status: 200 });
    }
    if (u.pathname === "/search") {
      const q = low(u.searchParams.get("q"));
      return new Response(JSON.stringify({ people: PEOPLE.filter((p) => low(p.name).includes(q)), players: [], clans: [], games: [] }), { status: 200 });
    }
    if (u.pathname.startsWith("/players/")) {
      const id = decodeURIComponent(u.pathname.slice("/players/".length));
      if (!NAME_OF.has(id)) return new Response('{"error":"Player not found"}', { status: 404 });
      // ofstats' player shape, as fetchStats reads it
      return new Response(
        JSON.stringify({
          ...(NO_ID_IN_ANSWER.has(id) ? {} : { publicId: id }),
          username: NAME_OF.get(id),
          gamesPlayed: 120,
          wins: 30,
          lastSeen: new Date(T0 - 86400000).toISOString(),
          modes: [{ mode: "Free For All", games: 100, wins: 25 }, { mode: "Team", games: 20, wins: 5 }],
          maps: { rows: [{ map: "World", games: 120, wins: 30, expectedWins: 12 }] },
          games: Array.from({ length: 60 }, (_, i) => ({ gameId: `g${i}`, isWinner: i % 3 === 0, map: "World", mode: "Free For All", date: T0 - i * 3600000 })),
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };
  const ctx = vm.createContext({
    chrome,
    console: { log() {}, warn() {}, error: console.error },
    fetch: fakeFetch,
    Response,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    WebSocket: class {},
  });
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(src(f), ctx, { filename: f });
  };
  vm.runInContext(bgSrc, ctx, { filename: "background.js" });
  // an asynchronous answer that never comes resolves "TIMEOUT" (the hub would wait forever)
  const ask = (msg) =>
    new Promise((resolve) => {
      let async = false;
      for (const f of listeners.message) if (f(msg, {}, resolve) === true) async = true;
      setTimeout(() => resolve(async ? "TIMEOUT" : undefined), async ? 3000 : 50);
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500); // worker start: purge, then the batched index write

  // ---- worker start: purge and seed ----
  ok(!("ofs7:expired guy" in store.local) && !("ofs7:clan:LUX" in store.local) && !("ofs7:[lux] tagged" in store.local), "worker start: expired cache entries purged");
  ok("ofs7:fresh one" in store.local && "ofs7:match:matched name" in store.local, "worker start: live cache entries kept");
  ok(!("ofs5:older gen" in store.local), "worker start: older cache generation purged");
  ok(!("ofs6:stale miss" in store.local), "worker start: answers to name lookups (ofs6, 'new' for everyone) purged");
  ok("tournaments" in store.local, "worker start: other data untouched");
  eq((store.local.recruitIndex?.players ?? []).map((r) => r.name).sort(), ["Expired Guy", "Fresh One"], "worker start: cached untagged players seed the recruit index");

  const refused = await ask({ type: "clanTable" });
  eq(refused, { error: "consent" }, "clanTable refused before consent");
  eq(fetched.length, 0, "nothing reaches ofstats before consent");

  await chrome.storage.sync.set({ dataConsent: true });
  const t = await ask({ type: "clanTable" });
  ok(t?.found === true && t.week === "2026-W38" && t.isCurrentWeek === true, "clanTable: current week");
  eq(t.clans[0], { rank: 1, tag: "UN", points: 17463, games: 18236, wins: 4691, stackedGames: 5260, stackedWins: 1980, stackedWinRate: 37.6, activeMembers: 2887, pointsPerMember: 6.05 }, "clanTable: row shape");
  eq(t.timeline.series[0], { tag: "UN", ranks: [1, 1], points: [21307, 17463] }, "clanTable: timeline shape");
  eq(t.clanOfTheWeek, { week: "2026-W37", tag: "UN", points: 21307 }, "clanTable: clan of the week");
  eq(t.total, 9972, "clanTable: total");
  eq(fetched.at(-1), "https://api.ofstats.io/clans?limit=50", "clanTable: request for the current week");
  const again = await ask({ type: "clanTable" });
  ok(again?.found && fetched.length === 1, "clanTable: second ask served from cache");
  const w37 = await ask({ type: "clanTable", week: "2026-W37" });
  ok(w37?.week === "2026-W37" && w37.isCurrentWeek === false, "clanTable: past week");
  eq(fetched.at(-1), "https://api.ofstats.io/clans?limit=50&week=2026-W37", "clanTable: week parameter");
  const n = fetched.length;
  const bad = await ask({ type: "clanTable", week: "2026-W37&sort=x" });
  ok(bad?.found && bad.week === "2026-W38", "clanTable: a malformed week is dropped (current week instead)");
  eq(fetched.length, n, "clanTable: ...and never reaches ofstats (served from the current-week cache)");
  ok(Object.keys(store.local).some((k) => k === "ofs7:clans:table:2026-W37"), "clanTable: cached under the cache prefix");

  // ---- lookups feed the recruit index; a failed name still gets an answer ----
  const looked = await ask({ type: "lookup", usernames: ["Solo Ace", "[LUX] TeNa", "Down Guy"] });
  ok(looked !== "TIMEOUT", "lookup: answered");
  ok(looked?.["Solo Ace"]?.found && looked?.["[LUX] TeNa"]?.found, "lookup: hits");
  eq(looked?.["Down Guy"]?.reason, "error", "lookup: a failing name answers 'error'");
  await sleep(450);
  const idx = store.local.recruitIndex?.players ?? [];
  const solo = idx.find((r) => r.name === "Solo Ace");
  ok(solo && fin(solo.pct) && solo.games === 120 && !("recentGames" in solo) && !("maps" in solo), "recruit index: slim record written on a lookup hit");
  ok(!idx.some((r) => r.name === "[LUX] TeNa" || r.name === "Down Guy"), "recruit index: no tagged player, no failed lookup");
  ok(JSON.stringify(solo).length < 400, "recruit index: a few hundred bytes per player");

  // ---- storage.local full: cacheSet fails, the lookup still answers ----
  store.full = true;
  const before = fetched.length;
  const quota = await ask({ type: "lookup", usernames: ["Quota Name", "Down Again"] });
  ok(quota !== "TIMEOUT", "full storage: the lookup handler still responds");
  ok(quota?.["Quota Name"]?.found === true, "full storage: the answer comes through");
  eq(quota?.["Down Again"]?.reason, "error", "full storage: a failing name still answers 'error'");
  const quota2 = await ask({ type: "lookup", usernames: ["Quota Name"] });
  // /names/Quota Name, /players/QUOTANM1, /names/Down Again - and nothing more
  ok(quota2?.["Quota Name"]?.found && fetched.length === before + 3, "full storage: the answer is kept in memory (no second request)");
  const tbl = await ask({ type: "clanTable", week: "2026-W36" });
  ok(tbl !== "TIMEOUT" && tbl?.found, "full storage: clanTable still responds");
  await sleep(450); // the index write fails quietly
  store.full = false;

  // ---- the worker's own safety net: a lookup that throws still answers ----
  const odd = await ask({ type: "lookup", usernames: [null, "Fine Name"] });
  ok(odd !== "TIMEOUT" && odd?.["Fine Name"]?.found, "lookup: an odd name does not stall the others");

  // ---- names are matched to accounts; ofstats is asked by id only ----
  eq([looked["Solo Ace"]?.id, looked["Solo Ace"]?.match], ["SOLOACE1", { via: "games", others: 0, clear: true }], "match: the newest game under exactly the name; nobody else on it");
  ok(fetched.includes("https://api.ofstats.io/names/Solo%20Ace") && fetched.includes("https://api.ofstats.io/players/SOLOACE1?limit=60"), "match: /names/<name>, then /players/<id>");
  eq(looked["[LUX] TeNa"]?.id, "LUXTENA1", "match: a tagged name goes to the account that played with the tag (the bare TeNa is somebody else)");
  ok(fetched.includes("https://api.ofstats.io/names/TeNa"), "match: the name index is asked for the bare name");

  const m = await ask({ type: "lookup", usernames: ["Clear Pick", "Crowd", "MixCase", "[ABC] Tagged One", "France", "[FR] France", "Brand New", "[XY] Rare", "Listed Only"] });
  ok(m !== "TIMEOUT", "match: answered");
  eq([m["Clear Pick"]?.id, m["Clear Pick"]?.match], ["CLEARPK1", { via: "games", others: 1, clear: true }], "match: 3 of the 5 recent games under the name: a clear pick");
  eq([m.Crowd?.id, m.Crowd?.match], ["CROWDAA1", { via: "games", others: 2, clear: false }], "match: the newest of three, 1 game in 5: not clear");
  eq(m.MixCase?.id, "UPPERMC1", "match: the same case before any case");
  eq(m["[ABC] Tagged One"]?.id, "ABCTAGD1", "match: the tag has to match too");
  eq([m.France?.found, m.France?.reason, m.France?.accounts], [false, "shared", 5000], "match: an untagged name thousands of accounts play under answers 'shared'");
  eq(m["[FR] France"]?.id, "FRANCE01", "match: ...the same name with a tag is matched");
  eq([m["Brand New"]?.found, m["Brand New"]?.reason], [false, "no-history"], "match: a name nobody played under is 'new'");
  ok(!fetched.some((f) => f.includes("search?q=Brand")), "match: ...without asking the search");
  eq([m["[XY] Rare"]?.id, m["[XY] Rare"]?.match], ["RAREXY01", { via: "search", others: 0, clear: true }], "match: no recent game under the name: ofstats' search, same name and tag");
  eq([m["Listed Only"]?.id, m["Listed Only"]?.match?.via], ["LISTED01", "accounts"], "match: ...or the accounts the name index lists");
  const askedPlayers = fetched.filter((f) => f.startsWith("https://api.ofstats.io/players/")).map((f) => decodeURIComponent(f.slice("https://api.ofstats.io/players/".length).split("?")[0]));
  ok(askedPlayers.length > 0 && askedPlayers.every((x) => NAME_OF.has(x)), `ids: /players/ is only ever asked for an account id (asked: ${askedPlayers.filter((x) => !NAME_OF.has(x)).join(", ")})`);

  // the match is kept longer than the stats: a fresh lookup asks ofstats for the stats only
  const n0 = fetched.length;
  await ask({ type: "lookup", usernames: ["Crowd"], fresh: true });
  eq(fetched.slice(n0), ["https://api.ofstats.io/players/CROWDAA1?limit=60"], "match: cached; a fresh lookup asks for the stats only");
  ok("ofs7:match:crowd" in store.local && store.local["ofs7:match:crowd"].expiresAt - Date.now() > 5 * 3600000, "match: cached for hours, under the cache prefix");
  const n0b = fetched.length;
  await ask({ type: "lookup", usernames: ["Brand New"], fresh: true });
  eq(fetched.slice(n0b), ["https://api.ofstats.io/names/Brand%20New"], "match: a fresh lookup asks again past a cached miss");

  // an exact id beats a match: a game record says who "Twin" is
  const twin = await ask({ type: "lookup", usernames: ["Twin"] });
  eq(twin?.Twin?.id, "TWINAAA1", "exact: matched by name first");
  await ask({ type: "gameRecord", gameId: "TWINGAME" });
  await sleep(20);
  const twin2 = await ask({ type: "lookup", usernames: ["Twin"] });
  eq([twin2?.Twin?.id, twin2?.Twin?.match], ["TWINBBB1", undefined], "exact: a game record's id replaces the cached match");
  ok(fetched.at(-1) === "https://api.ofstats.io/players/TWINBBB1?limit=60", "exact: ...asked for by that id");

  // ---- your own id, read from OpenFront's page ----
  eq(await ask({ type: "selfId", name: "[LUX] Me Myself", id: "bad id!" }), { ok: false }, "selfId: a malformed id is refused");
  eq(await ask({ type: "selfId", name: "[LUX] Me Myself", id: "MYSELF01" }), { ok: true }, "selfId: answered");
  await sleep(20);
  const n1 = fetched.length;
  const me = await ask({ type: "lookup", usernames: ["[LUX] Me Myself"] });
  eq(fetched.slice(n1), ["https://api.ofstats.io/players/MYSELF01?limit=60"], "selfId: your own name goes straight to your id");
  ok(me?.["[LUX] Me Myself"]?.found && me["[LUX] Me Myself"].match === undefined, "selfId: no name match involved");

  // ---- the race: your id arrives while the first lookup of your name is still matching it ----
  const first = ask({ type: "lookup", usernames: ["Race Me"] }); // its /names/ answer takes 300 ms
  await sleep(50);
  eq(await ask({ type: "selfId", name: "Race Me", id: "RACEME01" }), { ok: true }, "race: your id arrives meanwhile");
  const second = await ask({ type: "lookup", usernames: ["Race Me"] });
  eq(second?.["Race Me"]?.id, "RACEME01", "race: the lookup made after it goes by your id, not the name match in flight");
  eq((await first)?.["Race Me"]?.reason, "no-history", "race: (the earlier lookup still gets its own answer)");
  await sleep(50);
  const third = await ask({ type: "lookup", usernames: ["Race Me"] });
  ok(third?.["Race Me"]?.id === "RACEME01" && store.local["ofs7:race me"]?.value?.id === "RACEME01", "race: ...and the late name match does not replace it in the cache");

  // ---- a lobby that hides clan tags (every public free-for-all): anyTag ----
  const strict = await ask({ type: "lookup", usernames: ["Harry Tohs"] });
  eq(strict?.["Harry Tohs"]?.reason, "no-history", "anyTag: without it, a bare name does not match the name played with a tag");
  const loose = await ask({ type: "lookup", usernames: ["Harry Tohs"], anyTag: true });
  eq([loose?.["Harry Tohs"]?.id, loose?.["Harry Tohs"]?.match], ["HARRYTS1", { via: "games", others: 0, clear: true }], "anyTag: the bare name matches it under any tag");
  ok("ofs7:~harry tohs" in store.local && "ofs7:match:~harry tohs" in store.local && "ofs7:harry tohs" in store.local, "anyTag: answers cached apart from the strict ones");
  const looseTagged = await ask({ type: "lookup", usernames: ["[ABC] Tagged One"], anyTag: true });
  eq(looseTagged?.["[ABC] Tagged One"]?.id, "ABCTAGD1", "anyTag: a name shown with its tag still has to match it");

  const rec = await ask({ type: "gameRecord", gameId: "RECGAME1" });
  eq(rec?.players?.[0]?.publicID, "RECID001", "ids: game record read");
  await sleep(20);
  const recHit = await ask({ type: "lookup", usernames: ["[LUX] Rec Guy"] });
  eq(fetched.at(-1), "https://api.ofstats.io/players/RECID001?limit=60", "ids: learned from a game record ([TAG] name -> publicID)");
  eq(recHit?.["[LUX] Rec Guy"]?.id, "RECID001", "ids: the id is in the result even when ofstats' answer has none");

  const n2 = fetched.length;
  const recLoose = await ask({ type: "lookup", usernames: ["Rec Guy"], anyTag: true });
  eq(fetched.slice(n2), ["https://api.ofstats.io/players/RECID001?limit=60"], "anyTag: an id learned under a tag serves the bare name ([LUX] Rec Guy -> Rec Guy)");
  ok(recLoose?.["Rec Guy"]?.found && recLoose["Rec Guy"].match === undefined, "anyTag: ...as an exact id, no name match");
  // your own id under the bare name a tag-hiding lobby shows, and somebody else's under a tag
  await ask({ type: "gameRecord", gameId: "TWOMEGAM" });
  eq(await ask({ type: "selfId", name: "Me Myself", id: "MYSELF01" }), { ok: true }, "anyTag: your id noted under the bare name the lobby shows");
  await sleep(20);
  const n3 = fetched.length;
  await ask({ type: "lookup", usernames: ["Me Myself"], anyTag: true });
  eq(fetched.slice(n3), ["https://api.ofstats.io/players/MYSELF01?limit=60"], "anyTag: the bare name's own id first, not [ZZ] Me Myself's");

  const clan = await ask({ type: "clan", tag: "IDC" });
  eq(clan?.members?.[0]?.id, "MEMBERID", "ids: a clan member's id");
  await ask({ type: "lookup", usernames: ["[IDC] Member"] });
  eq(fetched.at(-1), "https://api.ofstats.io/players/MEMBERID?limit=60", "ids: learned from a clan's member list");

  await sleep(700);
  const saved = new Map(store.local.ofsPlayerIds ?? []);
  ok(saved.get("[lux] rec guy") === "RECID001" && saved.get("[idc] member") === "MEMBERID" && saved.get("[lux] me myself") === "MYSELF01" && saved.get("twin") === "TWINBBB1", "ids: exact ids kept in storage.local");
  ok(!saved.has("crowd") && !saved.has("solo ace") && !saved.has("[xy] rare"), "ids: name matches are not stored as exact ids");

  // ---- clearCache empties the recruit index too ----
  const cleared = await ask({ type: "clearCache" });
  ok(cleared !== "TIMEOUT" && !("recruitIndex" in store.local) && !Object.keys(store.local).some((k) => k.startsWith("ofs7:")), "clearCache: cache and recruit index gone");
  ok("tournaments" in store.local, "clearCache: other data untouched");
  ok("ofsPlayerIds" in store.local, "clearCache: learned player ids kept (they are not cached stats)");
}
function fin(v) {
  return typeof v === "number" && Number.isFinite(v);
}

console.log(failures ? `${failures} failed, ${passes} passed` : `all passed (${passes})`);
process.exit(failures ? 1 : 0);
