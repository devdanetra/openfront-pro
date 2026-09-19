// Tournament helper, pure half (src/tournament-core.js), over real OpenFront game
// records normalised by background.js - the same sample set as test-recap.mjs
// (run that once to download them into .recap/).
//   node tools/test-tournament.mjs
import { loadCore, loadRecords, demoTournaments, SAMPLE_IDS } from "./tournament-fixtures.mjs";

const { normaliseRecord, T } = loadCore();
const { raw, slim } = loadRecords(normaliseRecord, T);
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const valid = (t) => {
  const v = T.validateTournament(clone(t));
  if (!v.ok) throw new Error(`fixture invalid: ${v.error}`);
  return v.value;
};
if (slim.size < SAMPLE_IDS.length) {
  console.log(`only ${slim.size}/${SAMPLE_IDS.length} records in .recap/ - run node tools/test-recap.mjs first`);
  process.exit(1);
}

console.log("game ids and links");
{
  const cases = [
    ["5S99ULQP", "5S99ULQP"],
    ["https://openfront.io/game/ddNXyXafFo", "ddNXyXafFo"],
    ["https://openfront.io/#join=d4tvvVquk6", "d4tvvVquk6"],
    ["openfront.io/join/yfMnoHJP", "yfMnoHJP"],
    ["https://openfront.io/w0/game/dc5VgbARGx?replay", "dc5VgbARGx"],
    ["https://www.openfront.io/game/dc5VgbARGx", "dc5VgbARGx"],
    ["https://ofstats.io/game/HPeHLRqX", "HPeHLRqX"],
    ["#join=dVLrYJEaGm", "dVLrYJEaGm"],
    ["<https://openfront.io/game/dfReijmudi>", "dfReijmudi"],
    ["https://openfront.io/?gameId=AbCd1234", "AbCd1234"],
    ["https://evil.example/game/5S99ULQP", null],
    ["https://openfront.io.evil.com/game/abcdEFGH", null],
    ["javascript:alert(1)", null],
    ["abc", null],
    ["a".repeat(17), null],
    ["https://openfront.io/game/<script>", null],
    ["data:text/html,5S99ULQP", null],
  ];
  for (const [input, want] of cases) check(`${input.slice(0, 50)} -> ${want}`, T.idFromToken(input) === want, `got ${T.idFromToken(input)}`);
  const many = T.parseGameRefs("5S99ULQP, https://openfront.io/game/5S99ULQP\nnot-a-game https://openfront.io/#join=d4tvvVquk6;ddNXyXafFo");
  check("several at once, deduplicated, bad ones reported", JSON.stringify(many.ids) === JSON.stringify(["5S99ULQP", "d4tvvVquk6", "ddNXyXafFo"]) && JSON.stringify(many.bad) === JSON.stringify(["not-a-game"]), JSON.stringify(many));
}

console.log("records");
{
  for (const [id, r] of slim) check(`${id}: slim record passes its own check`, T.checkSlim(clone(r)) !== null && r.gameId === id);
  const blob = JSON.stringify([...slim.values()]);
  check("no persistent id (a secret) and no full stats kept", !/persistentID/.test(blob) && !/"gold"/.test(blob));
  check("teamIndex comes through the normaliser (matchmade team games only)", slim.get("dc5VgbARGx").players.some((p) => p.teamIndex === 1) && slim.get("5S99ULQP").players.every((p) => p.teamIndex === null));
  const bad = clone(slim.get("HPeHLRqX"));
  bad.players[0].killedAt = "soon";
  check("a damaged cached record is refused", T.checkSlim(bad) === null);
  check("newer records: conquests are distinct victims", slim.get("ddNXyXafFo").players.some((p) => p.conquests > 0));
}

console.log("suggested participants");
{
  const two = T.suggestParticipants(slim.get("dc5VgbARGx"), "team");
  check("ranked 2v2: two teams from team slots", two.length === 2, JSON.stringify(two.map((p) => p.name)));
  check("the winning side first, named by its clan tag, with both members", two[0].name === "HS" && two[0].members.length === 2 && two[0].tags[0] === "HS");
  check("the other side keeps OpenFront's colour name (Blue won at slot 1 -> slot 0 is Red)", two[1].name === "Red", two[1].name);
  const ffa = T.suggestParticipants(slim.get("5S99ULQP"), "player");
  check("FFA players, winner first", ffa[0].name === "TeNa" && ffa.length <= T.LIMITS.participants);
  const clans = T.suggestParticipants(slim.get("5S99ULQP"), "team");
  check("FFA as clans: biggest clan first", clans[0].name === "67" && clans.every((c) => c.tags.length === 1), clans.slice(0, 3).map((c) => c.name).join(","));
}

console.log("matching players to participants");
{
  const t = valid({ ...demoTournaments(T).league, participants: [
    { id: "pa", name: "tena", tags: [], members: [], color: 0 }, // lower case on purpose
    { id: "pb", name: "Nobody", tags: [], members: [], color: 1 },
  ] });
  const rec = slim.get("5S99ULQP");
  const m = T.matchPlayers(t, rec, { id: rec.gameId, assign: {} });
  check("case-insensitive name match", m.byPid.get("pa").length === 1 && m.byPid.get("pa")[0].username === "TeNa");
  check("absent participant has nobody", m.byPid.get("pb").length === 0);
  check("unmatched lists only players who played", m.unmatched.every((u) => u.active) && m.unmatched.length === rec.players.filter((p) => p.active).length - 1);
  // explicit choices: assign a player, ignore another
  const someone = m.unmatched[0];
  const m2 = T.matchPlayers(t, rec, { id: rec.gameId, assign: { [someone.key]: "pb", [m.unmatched[1].key]: "" } });
  check("organiser's assignment wins", m2.byPid.get("pb")[0]?.clientID === someone.key);
  check("'not in tournament' removes a player from the unmatched list", m2.unmatched.length === m.unmatched.length - 2);
  // namesakes: dfReijmudi has two players called USSR
  const ussr = valid({ ...t, participants: [{ id: "pu", name: "USSR", tags: [], members: [], color: 0 }] });
  const recU = slim.get("dfReijmudi");
  const hits = recU.players.filter((p) => p.username.toLowerCase() === "ussr");
  const mu = T.matchPlayers(ussr, recU, { id: recU.gameId, assign: {} });
  const bothPlayed = hits.filter((p) => p.active).length > 1;
  check("two players of the same name: not guessed", !bothPlayed || (mu.byPid.get("pu").length === 0 && mu.unmatched.some((u) => u.ambiguous)), `${hits.length} namesakes`);
  if (hits.some((p) => p.clanTag)) {
    const tagged = hits.find((p) => p.clanTag);
    const mt = T.matchPlayers(valid({ ...ussr, participants: [{ id: "pu", name: "USSR", tags: [tagged.clanTag.toLowerCase()], members: [], color: 0 }] }), recU, { id: recU.gameId, assign: {} });
    check("a clan tag breaks the tie", mt.byPid.get("pu")[0]?.clientID === tagged.clientID);
  }
  // team unit: by clan tag, a listed member without the tag, and a conflict
  const team = valid({ ...t, unit: "team", participants: [
    { id: "pa", name: "UN", tags: ["un"], members: [], color: 0 },
    { id: "pb", name: "Friends", tags: [], members: ["TeNa"], color: 1 },
  ] });
  const mt = T.matchPlayers(team, rec, { id: rec.gameId, assign: {} });
  check("team by clan tag (case-insensitive)", mt.byPid.get("pa").length === 2 && mt.byPid.get("pa").every((p) => p.clanTag.toUpperCase() === "UN"));
  check("team by listed member", mt.byPid.get("pb").length === 1);
  const clash = valid({ ...team, participants: [...team.participants, { id: "pc", name: "UN again", tags: ["UN"], members: [], color: 2 }] });
  const mc = T.matchPlayers(clash, rec, { id: rec.gameId, assign: {} });
  check("two teams claiming one tag: left for the organiser", mc.byPid.get("pa").length === 0 && mc.unmatched.filter((u) => u.ambiguous).length === 2);
}

console.log("placement and scoring");
{
  const demo = demoTournaments(T);
  const league = valid(demo.league);
  const st = T.standings(league, slim);
  const g5 = st.games.find((g) => g.gameId === "5S99ULQP");
  const tena = g5.rows.find((r) => r.pid === "pa");
  check("FFA winner is 1st among participants and flagged", tena.place === 1 && tena.won && !tena.tied);
  check("points = place table + conquests", tena.points === 10 + tena.conquests * 1, `${tena.points}`);
  const places = g5.rows.map((r) => r.place);
  check("places are 1..n in order", places.every((p, i) => i === 0 || p >= places[i - 1]));
  // team game, old format: TeNa and potato both on the winning team -> tied 1st, points split
  const gy = st.games.find((g) => g.gameId === "yfMnoHJP");
  const a = gy.rows.find((r) => r.pid === "pa");
  const c = gy.rows.find((r) => r.pid === "pc");
  check("co-winners tie for 1st", a.place === 1 && c.place === 1 && a.tied && c.tied && a.won && c.won);
  check("tied places share the points of the places they span", a.parts.place === 8.5, `${a.parts.place}`);
  check("placePoints: 3-way tie at 2nd", T.placePoints([10, 7, 5, 4], 2, 3) === 5.3);
  // never-spawned players: no points, no average
  const dns = st.games.flatMap((g) => g.rows).filter((r) => r.dns);
  check("a participant who never spawned scores 0", dns.length > 0 && dns.every((r) => r.points === 0), `${dns.length}`);
  // a 1v1 whose loser has no elimination tick
  const g1 = T.scoreGame(valid({ ...league, participants: [{ id: "pa", name: "TeNa", tags: [], members: [], color: 0 }, { id: "pb", name: "calabo", tags: [], members: [], color: 1 }] }), slim.get("HPeHLRqX"), { id: "HPeHLRqX", assign: {} });
  check("1v1: winner 1st, loser 2nd", g1.rows[0].pid === "pa" && g1.rows[0].place === 1 && g1.rows[1].place === 2);
  // Team wins only
  const wins = valid({ ...demo.bo3, format: "league" });
  const sw = T.standings(wins, slim);
  check("'Team wins only': points equal wins", sw.rows.every((r) => r.points === r.wins * 1));
  // a void game (no active players)
  const voidRec = { ...clone(slim.get("HPeHLRqX")), gameId: "VoidGame1" };
  voidRec.players.forEach((p) => (p.active = false));
  const sv = T.scoreGame(league, voidRec, { id: "VoidGame1", assign: {} });
  check("a game without a result counts for nobody", sv.state === "void" && sv.rows.length === 0);
}

console.log("tie-breaks");
{
  // synthetic records: four participants, controlled finishes
  const P = (name) => ({ username: name, clanTag: null, clientID: `c${name}`, active: true, killedAt: null, finalTiles: null, winner: false, conquests: 0, teamIndex: null });
  const game = (id, order, winner = true) => ({
    gameId: id, map: "World", mode: "Free For All", teams: null, duration: 600, start: Number(id.replace(/\D/g, "")), end: 1, winner: { type: "player", name: null },
    // order: best first; the first wins, the rest fall in reverse order
    players: order.map((n, i) => ({ ...P(n), winner: winner && i === 0, killedAt: i === 0 ? null : 1000 - i * 10 })),
  });
  const recs = new Map([
    ["Game1111", game("Game1111", ["A", "B", "C", "D"])],
    ["Game2222", game("Game2222", ["B", "A", "D", "C"])],
    ["Game3333", game("Game3333", ["C", "D", "A"], false)],
  ]);
  const t = valid({
    ...demoTournaments(T).league,
    scoring: { preset: "custom", win: 0, place: [3, 2, 1, 0], conquest: 0 },
    participants: ["A", "B", "C", "D"].map((n, i) => ({ id: `p${n.toLowerCase()}`, name: n, tags: [], members: [], color: i })),
    games: [...recs.keys()].map((id) => ({ id, assign: {} })),
  });
  const st = T.standings(t, recs);
  const order = st.rows.map((r) => `${r.name}:${r.points}:${r.wins}:${r.avgPlace}:${r.tieBreak}`);
  // A: 3+2+1=6, 1 win, avg 2 · B: 2+3=5, 1 win · C: 1+0+3=4 · D: 0+1+2=3
  check("points first", st.rows[0].name === "A" && st.rows.at(-1).name === "D", order.join(" "));
  // make A and B level on points: B gets 1 more in a 4th game where A is absent
  recs.set("Game4444", game("Game4444", ["C", "B"], false)); // B 2nd -> +2 -> B 7? adjust below
  t.games.push({ id: "Game4444", assign: {} });
  t.scoring.place = [3, 1, 1, 0];
  const st2 = T.standings(t, recs);
  const A = st2.rows.find((r) => r.name === "A");
  const B = st2.rows.find((r) => r.name === "B");
  // A: 3+1+1 = 5 (1 win) · B: 1+3+1 = 5 (1 win) · avg A 2.0 (1,2,3) vs B 1.67 (2,1,2)
  check("level on points and wins -> better average place", A.points === B.points && A.wins === B.wins && st2.rows.indexOf(B) < st2.rows.indexOf(A) && st2.rows[st2.rows.indexOf(A)].tieBreak === "avg", st2.rows.map((r) => `${r.name}:${r.points}:${r.wins}:${r.avgPlace}`).join(" "));
  // head-to-head: two participants level on points, wins and average; the one who placed better when they met is first
  const h = new Map([
    ["Game5555", game("Game5555", ["X", "Y"], false)],
    ["Game6666", game("Game6666", ["Y", "Z"], false)],
    ["Game7777", game("Game7777", ["Z", "X"], false)],
    ["Game8888", game("Game8888", ["X", "W"], false)],
  ]);
  const th = valid({
    ...t,
    scoring: { preset: "custom", win: 0, place: [1, 0], conquest: 0 },
    participants: ["X", "Y", "Z", "W"].map((n, i) => ({ id: `p${n.toLowerCase()}`, name: n, tags: [], members: [], color: i })),
    games: [...h.keys()].map((id) => ({ id, assign: {} })),
  });
  const s3 = T.standings(th, h);
  // X: 1+0+1 = 2 (avg 1.33, 3 games) · Y: 0+1 = 1 · Z: 0+1 = 1 · W: 0 -> check Y vs Z: level on points, wins(0), avg (1.5 each); Y beat Z in Game6666
  const Y = s3.rows.findIndex((r) => r.name === "Y");
  const Z = s3.rows.findIndex((r) => r.name === "Z");
  check("level on points, wins and average -> head-to-head", Y < Z && s3.rows[Z].tieBreak === "h2h", s3.rows.map((r) => `${r.name}:${r.points}:${r.avgPlace}:${r.tieBreak}`).join(" "));
  check("head-to-head matrix records who placed better", s3.h2h.get("py").get("pz").w === 1 && s3.h2h.get("pz").get("py").l === 1);
}

console.log("bracket");
{
  check("standard seeding for 8", JSON.stringify(T.seedOrder(8)) === "[1,8,4,5,2,7,3,6]");
  const cup = valid(demoTournaments(T).cup);
  const br = T.bracket(cup, slim);
  const m = (id) => br.rounds.flat().find((x) => x.id === id);
  check("QF1 TeNa beat calabo in their 1v1 (HPeHLRqX)", m("r1m1").winner === "p1" && m("r1m1").games[0].gameId === "HPeHLRqX");
  check("QF3 decided by the other 1v1: Batman beat hyLine", m("r1m3").winner === "p7" && m("r1m3").by === "games");
  check("QF2 decided by the first game both played (in play order)", m("r1m2").winner === "p4" && m("r1m2").games.length === 1);
  check("winners advance to the semi-finals", m("r2m1").a === "p1" && m("r2m1").b === "p4" && m("r2m2").a === "p7" && m("r2m2").b === "p3");
  check("manual override decides a match with no game", m("r2m1").winner === "p1" && m("r2m1").by === "override");
  check("final waits for the other semi", m("r3m1").a === "p1" && m("r3m1").b === null && br.champion === null);
  check("a game fitting no open match is reported", br.unplaced.some((u) => u.gameId === "dfReijmudi" && u.why === "none"));
  // override the other semi and the final -> champion
  const done = valid({ ...cup, overrides: [{ a: "p1", b: "p4", winner: "p1" }, { a: "p7", b: "p3", winner: "p3" }, { a: "p3", b: "p1", winner: "p3" }] });
  const b2 = T.bracket(done, slim);
  check("overrides carry through to a champion", b2.champion === "p3");
  // an override naming someone not in that match is ignored
  const odd = valid({ ...cup, overrides: [{ a: "p1", b: "p8", winner: "p8" }] });
  check("an override for a player not in the match is ignored", T.bracket(odd, slim).rounds[1][0].by !== "override");
  // changing an upstream result resets the match below
  const flip = valid({ ...cup, overrides: [{ a: "p1", b: "p8", winner: "p8" }, { a: "p1", b: "p4", winner: "p1" }] });
  const b3 = T.bracket(flip, slim);
  check("an upstream override reroutes the bracket (the TeNa-potato result no longer applies)", b3.rounds[1][0].a === "p8" && b3.rounds[1][0].by !== "override");
  const st3 = T.staleRefs(flip, b3);
  check("...and is listed as stale for the page to clear", st3.overrides.length === 1 && st3.overrides[0].a === "p1" && st3.overrides[0].b === "p4");
  // byes: 5 participants in an 8-slot bracket, top seeds get byes
  const five = valid({ ...cup, participants: cup.participants.slice(0, 5), overrides: {} });
  const b5 = T.bracket(five, slim);
  const byes = b5.rounds[0].filter((x) => x.by === "bye").map((x) => x.winner);
  check("byes go to the top seeds", JSON.stringify(byes.sort()) === JSON.stringify(["p1", "p2", "p3"]), JSON.stringify(byes));
  // best of 3: one win is not enough
  const bo3 = valid({ ...cup, bestOf: 3, overrides: {} });
  const b6 = T.bracket(bo3, slim);
  check("best of 3: one game won is not a decided match", b6.rounds[0][0].winsA === 1 && b6.rounds[0][0].winner === null && b6.rounds[0][0].need === 2);
  // pinning a game to a match
  // (best of 3, so that match is still open when that game comes up)
  const pinned = valid({ ...cup, bestOf: 3, overrides: {}, games: cup.games.map((g) => (g.id === "dfReijmudi" ? { ...g, match: "r1m4" } : g)) });
  const b7 = T.bracket(pinned, slim);
  check("a game pinned to a match counts there", b7.rounds[0][3].games.some((g) => g.gameId === "dfReijmudi"));
  check("a bracket needs two participants", T.bracket(valid({ ...cup, participants: cup.participants.slice(0, 1), overrides: {} }), slim).rounds.length === 0);
}

console.log("series");
{
  const s = valid(demoTournaments(T).bo3);
  const se = T.series(s, slim);
  check("UN vs ITA over three games: 2-1 to UN", se.winsA === 2 && se.winsB === 1 && se.winner === "pun" && se.by === "games", JSON.stringify(se.games));
  const bo1 = T.series(valid({ ...s, bestOf: 1 }), slim);
  check("best of 1: later games are extra, not counted", bo1.games.filter((g) => g.extra).length === 2 && bo1.winsA + bo1.winsB === 1);
  const ov = T.series(valid({ ...s, overrides: { series: "pit" } }), slim);
  check("series override", ov.winner === "pit" && ov.by === "override");
}

console.log("validation (files, links, storage)");
{
  const good = valid(demoTournaments(T).league);
  const bad = (name, mut) => {
    const t = clone(good);
    mut(t);
    const r = T.validateTournament(t);
    check(`refused: ${name}`, !r.ok, r.ok ? "accepted" : r.error);
  };
  bad("name not text", (t) => (t.name = { toString: 1 }));
  bad("name too long", (t) => (t.name = "x".repeat(61)));
  bad("empty name", (t) => (t.name = "   "));
  bad("bidi override in a name", (t) => (t.participants[0].name = `evil${String.fromCharCode(0x202e)}gnp.exe`));
  bad("control character", (t) => (t.participants[0].name = `a${String.fromCharCode(0)}b`));
  bad("unknown format", (t) => (t.format = "swiss"));
  bad("best of 4", (t) => (t.bestOf = 4));
  bad("points as a string", (t) => (t.scoring.win = "10"));
  bad("NaN points", (t) => (t.scoring.conquest = NaN));
  bad("huge placement table", (t) => (t.scoring.place = Array(33).fill(1)));
  bad("65 participants", (t) => (t.participants = Array.from({ length: 65 }, (_, i) => ({ id: `p${i}`, name: `n${i}`, tags: [], members: [], color: 0 }))));
  bad("duplicate participant id", (t) => (t.participants[1].id = t.participants[0].id));
  bad("participant id shape", (t) => (t.participants[0].id = "__proto__"));
  bad("tag with markup", (t) => (t.participants[0].tags = ["<b>"]));
  bad("colour out of range", (t) => (t.participants[0].color = T.COLORS));
  bad("override whose winner is not a side", (t) => (t.overrides = [{ a: "pa", b: "pb", winner: "pc" }]));
  bad("override for one participant against itself", (t) => (t.overrides = [{ a: "pa", b: "pa", winner: "pa" }]));
  bad("override naming an unknown participant", (t) => (t.overrides = [{ a: "pa", b: "pzz", winner: "pa" }]));
  bad("two results for one pair", (t) => (t.overrides = [{ a: "pa", b: "pb", winner: "pa" }, { a: "pb", b: "pa", winner: "pb" }]));
  bad("pin naming an unknown participant", (t) => (t.games[0].match = { a: "pa", b: "pzz" }));
  bad("game id shorter than OpenFront's (7)", (t) => (t.games[0].id = "AbCd123"));
  bad("left-to-right mark (U+200E) in a name", (t) => (t.participants[0].name = `Bob${String.fromCharCode(0x200e)}`));
  bad("right-to-left mark (U+200F) in a member", (t) => (t.participants[0].members = [`x${String.fromCharCode(0x200f)}`]));
  bad("Arabic letter mark (U+061C) in the title", (t) => (t.name = `Cup${String.fromCharCode(0x61c)}`));
  bad("bad game id", (t) => (t.games[0].id = "../../x"));
  bad("duplicate game", (t) => (t.games[1].id = t.games[0].id));
  bad("201 games", (t) => (t.games = Array.from({ length: 201 }, (_, i) => ({ id: `Game${String(i).padStart(4, "0")}`, assign: {} }))));
  bad("assignment to an unknown participant", (t) => (t.games[0].assign = { abc: "pzz" }));
  bad("assignment key shape", (t) => (t.games[0].assign = JSON.parse('{"__proto__":"pa"}')));
  bad("override to an unknown participant", (t) => (t.overrides = { r1m1: "pzz" }));
  bad("override key shape", (t) => (t.overrides = { constructor: "pa" }));
  bad("participants not a list", (t) => (t.participants = { length: 1 }));
  const odd = clone(good);
  odd.extra = "<img src=x onerror=alert(1)>";
  odd.participants[0].name = "<img src=x onerror=alert(1)>";
  const r = T.validateTournament(odd);
  check("unknown keys dropped; markup-looking names kept as plain text (shown via textContent)", r.ok && !("extra" in r.value) && r.value.participants[0].name.startsWith("<img"));
  const fromJson = T.validateTournament(JSON.parse('{"__proto__":{"polluted":1},"name":"x","format":"league","unit":"player","bestOf":1,"scoring":{"win":1,"place":[],"conquest":0},"participants":[],"games":[]}'));
  check("a __proto__ key in JSON pollutes nothing", fromJson.ok && ({}).polluted === undefined && !Object.prototype.hasOwnProperty.call(fromJson.value, "__proto__"));
  const file = JSON.stringify(T.exportObject(good));
  const back = T.importText(file);
  check("export -> import round trip (new id)", back.ok && back.value.name === good.name && back.value.id !== good.id && back.value.games.length === good.games.length);
  check("import refuses other JSON", !T.importText('{"format":"something-else","version":1}').ok && !T.importText("not json").ok);
  check("import refuses an oversized file", !T.importText(" ".repeat(T.LIMITS.fileBytes + 1)).ok);
}

console.log("share links");
{
  const t = valid(demoTournaments(T).cup);
  const enc = await T.encodeShare(t);
  check("encodes into a #t= link", enc.ok && enc.hash.startsWith("#t=z") && enc.length < T.LIMITS.shareChars, `${enc.length} chars`);
  const dec = await T.decodeShare(enc.hash);
  check("decodes to the same tournament", dec.ok && JSON.stringify({ ...dec.value, id: 0 }) === JSON.stringify({ ...t, id: 0 }));
  const plain = await T.encodeShare(t, { zip: false });
  const decPlain = await T.decodeShare(plain.hash);
  check("plain (no CompressionStream) variant round-trips", plain.ok && plain.hash.startsWith("#t=j") && decPlain.ok && decPlain.value.name === t.name);
  check("compression makes it shorter", enc.length < plain.length, `${enc.length} vs ${plain.length}`);
  // too big for a link -> file export instead
  const big = valid({ ...t, participants: Array.from({ length: 64 }, (_, i) => ({ id: `p${i}`, name: `Player ${Math.random().toString(36).slice(2)}${i}`, tags: [Math.random().toString(36).slice(2, 7)], members: Array.from({ length: 24 }, () => Math.random().toString(36).slice(2)), color: i % 6 })), overrides: {}, games: Array.from({ length: 200 }, (_, i) => ({ id: Math.random().toString(36).slice(2, 12).padEnd(8, "x"), assign: {} })) });
  const encBig = await T.encodeShare(big);
  check("a tournament too big for a link says so", !encBig.ok && encBig.reason === "too-big", `${encBig.length} chars`);
  const bomb = new Uint8Array(4 * 1024 * 1024); // compresses to a few KB, inflates past the cap
  const zipped = new Uint8Array(await new Response(new Blob([bomb]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const bombHash = `#t=z${T.b64url.encode(zipped)}`;
  const decBomb = await T.decodeShare(bombHash);
  check("decompression bomb refused", !decBomb.ok, `${bombHash.length} chars -> ${decBomb.error}`);
  for (const [name, h] of [
    ["garbage", "#t=z!!!!"],
    ["not base64 deflate", "#t=zAAAA"],
    ["no prefix", "#x=abc"],
    ["too long", `#t=j${"A".repeat(T.LIMITS.shareChars + 1)}`],
    ["valid JSON, wrong shape", `#t=j${T.b64url.encode(new TextEncoder().encode('{"name":1}'))}`],
    ["invalid UTF-8", `#t=j${T.b64url.encode(new Uint8Array([0xff, 0xfe, 0x7b]))}`],
  ]) {
    const r = await T.decodeShare(h);
    check(`refused link: ${name}`, !r.ok, r.error);
  }
}

console.log("record cache plan (LRU)");
{
  const idx = { AAAA1111: [1, 1000], BBBB2222: [2, 1000], CCCC3333: [3, 1000] };
  const p = T.cachePlan(idx, [["DDDD4444", 1000, 4]], { count: 3, bytes: 10_000 });
  check("over the count: the least recently used goes", JSON.stringify(p.evict) === '["AAAA1111"]' && !p.index.AAAA1111 && p.index.DDDD4444);
  const p2 = T.cachePlan(idx, [["AAAA1111", undefined, 5], ["EEEE5555", 2500, 6]], { count: 10, bytes: 4000 });
  check("reading refreshes; over the bytes: oldest evicted first", JSON.stringify(p2.evict) === '["BBBB2222","CCCC3333"]' && p2.index.AAAA1111[0] === 5 && p2.index.AAAA1111[1] === 1000);
  const p3 = T.cachePlan({ "../x": [1, 1], ok: "no" }, []);
  check("a damaged index is cleaned", Object.keys(p3.index).length === 0);
}

console.log("results text");
{
  const demo = demoTournaments(T);
  const cup = valid(demo.cup);
  const txt = T.resultsText(cup, { st: T.standings(cup, slim), br: T.bracket(cup, slim) });
  check("bracket text names the rounds and the players", /Semi-finals/.test(txt) && /TeNa/.test(txt) && /unofficial/.test(txt));
  const lg = valid(demo.league);
  const lt = T.resultsText(lg, { st: T.standings(lg, slim) });
  check("league text lists everyone with points", lg.participants.every((p) => lt.includes(p.name)) && /pts/.test(lt));
}

// ---- review fixes ------------------------------------------------------------------------------
const LRM = String.fromCharCode(0x200e);
const RLM = String.fromCharCode(0x200f);
const ALM = String.fromCharCode(0x61c);
const ZWSP = String.fromCharCode(0x200b);
// a synthetic record: order = best first; the first wins (unless winner false), the rest fall in reverse order
const P = (name, extra = {}) => ({ username: name, clanTag: null, clientID: `c${name.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`, active: true, killedAt: null, finalTiles: null, winner: false, conquests: 0, teamIndex: null, ...extra });
const game = (id, order, winner = true) => ({
  gameId: id, map: "World", mode: "Free For All", teams: null, duration: 600, start: Number(id.replace(/\D/g, "")) || 1, end: 1, winner: { type: "player", name: null },
  players: order.map((n, i) => ({ ...P(n), winner: winner && i === 0, killedAt: i === 0 ? null : 1000 - i * 10 })),
});
const parts = (names) => names.map((n, i) => ({ id: `p${n.toLowerCase().replace(/[^a-z0-9]/g, "")}`, name: n, tags: [], members: [], color: i % 6 }));

console.log("game ids: OpenFront's shape, chat lines, malformed links");
{
  check("8 to 10 characters only", T.idFromToken("AbCd123") === null && T.idFromToken("AbCd12345678") === null && T.idFromToken("AbCd1234") === "AbCd1234" && T.idFromToken("AbCd123456") === "AbCd123456");
  const chat = T.parseGameRefs("gg Wellplayed everyone, EVERYONE that game was Brilliant!! see you Saturday");
  check("a pasted chat line adds nothing", chat.ids.length === 0 && chat.bad.length > 0, JSON.stringify(chat.ids));
  check("a bare id without digits but with mixed case still counts (ddNXyXafFo)", T.idFromToken("ddNXyXafFo") === "ddNXyXafFo" && T.idFromToken("dfReijmudi") === "dfReijmudi");
  check("inside a recognised link no digit is needed", T.idFromToken("https://openfront.io/game/dfReijmudi") === "dfReijmudi");
  let threw = false;
  let mixed;
  try {
    mixed = T.parseGameRefs("https://openfront.io/#join=%E0 5S99ULQP https://openfront.io/#join=%ZZ ddNXyXafFo");
  } catch {
    threw = true;
  }
  check("a malformed link (%E0) is reported, the rest still added", !threw && JSON.stringify(mixed.ids) === '["5S99ULQP","ddNXyXafFo"]' && mixed.bad.length === 2, JSON.stringify(mixed));
  check("the page asks before fetching more than 20 records at once", T.AUTO_FETCH === 20);
}

console.log("bad characters (U+200E, U+200F, U+061C)");
{
  const dirty = `Bob${LRM}by${RLM} the ${ALM}Great`;
  check("clean() strips them (what every page input goes through)", T.clean(dirty) === "Bobby the Great" && !T.BAD_CHARS.test(T.clean(dirty)));
  const t = valid(demoTournaments(T).league);
  const p = T.newParticipant(t, { name: `${RLM}Eve${LRM}`, tags: [`X${LRM}Y`, "<b>"], members: [`m${ALM}1`] });
  const t2 = { ...clone(t), participants: [...t.participants, p] };
  check("a participant made from a record's name saves as a valid tournament", p.name === "Eve" && p.tags.join() === "XY" && p.members.join() === "m1" && T.validateTournament(t2).ok);
  // stored with one of them (an older build let it through): kept, listed as damaged, never dropped
  const broken = { ...clone(t), id: "brokenone1", name: `Cup${LRM}` };
  const plan = T.planLoad({ [`${T.TKEY}brokenone1`]: broken, [`${T.TKEY}${t.id}`]: clone(t) });
  check("a stored tournament that fails validation is kept as damaged, untouched", plan.list.length === 1 && plan.damaged.length === 1 && plan.damaged[0].raw === broken && plan.damaged[0].raw.name === `Cup${LRM}`, JSON.stringify(plan.damaged.map((d) => d.error)));
  check("...and is still in the index (not removed by the next save)", plan.index.includes("brokenone1"));
  const mt = T.matchPlayers(valid({ ...t, participants: [{ id: "pa", name: "Bobby", tags: [], members: [], color: 0 }] }), { players: [P(`Bob${LRM}by`)] }, { assign: {} });
  check("names compare without those characters", mt.byPid.get("pa").length === 1);
}

console.log("storage: one key each, migration, limit, other tabs");
{
  const demo = demoTournaments(T);
  const league = valid(demo.league);
  const cup = valid(demo.cup);
  const old = [clone(league), { ...clone(cup), name: `x${RLM}` }, "garbage"];
  const plan = T.planLoad({ tournaments: old, tournamentLast: league.id });
  check("migration: every entry of the old list gets its own key (damaged ones unchanged)", plan.migrate.length === 3 && plan.migrate[0].id === league.id && plan.migrate[1].value === old[1] && plan.migrate[2].value === "garbage" && plan.removeOld);
  check("migration: valid ones listed, damaged ones kept", plan.list.length === 1 && plan.damaged.length === 2);
  const again = T.planLoad({ tournaments: old, [`${T.TKEY}${league.id}`]: { ...clone(league), name: "edited since" } });
  check("migration resumes without overwriting a key that already exists", !again.migrate.some((w) => w.id === league.id) && again.list.find((x) => x.id === league.id)?.name === "edited since");
  // the limit
  const many = {};
  for (let i = 0; i < 31; i++) many[`${T.TKEY}t${String(i).padStart(5, "0")}`] = { ...clone(league), name: `L${i}` };
  const p31 = T.planLoad(many);
  check("more than the limit in storage: all listed, none dropped", p31.list.length === 31);
  check("no room for a 31st (kept shared or new): refused", !T.hasRoom(30) && !T.hasRoom(31) && T.hasRoom(29));
  // merge by id, last writer by `updated`
  const mine = { ...clone(league), updated: 1000 };
  check("another tab's newer copy wins", T.mergeOne(mine, { ...clone(league), updated: 2000 }).act === "take");
  check("our newer copy is kept (written)", T.mergeOne(mine, { ...clone(league), updated: 500 }).act === "keep");
  check("a tournament another tab added is taken in", T.mergeOne(null, clone(cup)).act === "take");
  check("deleted in another tab: gone, unless we have unsaved edits", T.mergeOne(mine, undefined).act === "gone" && T.mergeOne(mine, undefined, { dirty: true }).act === "keep");
  check("a damaged write from another tab never replaces a good copy", T.mergeOne(mine, { name: 1 }).act === "keep" && T.mergeOne(null, { name: 1 }).act === "damaged");
  check("index merge: ours first, theirs added, deleted ones out", JSON.stringify(T.mergeIndex(["aaaaaa", "bbbbbb"], ["cccccc", "aaaaaa", "dddddd"], ["dddddd"])) === '["aaaaaa","bbbbbb","cccccc"]');
  const ordered = T.planLoad({ [`${T.TKEY}${league.id}`]: clone(league), [`${T.TKEY}${cup.id}`]: clone(cup), [T.TINDEX]: [cup.id, league.id] });
  check("the stored order is kept", ordered.list.map((x) => x.id).join() === `${cup.id},${league.id}`);
}

console.log("namesakes (player mode)");
{
  const t = valid({ ...demoTournaments(T).league, participants: [{ id: "pa", name: "Bob", tags: [], members: [], color: 0 }, { id: "pb", name: "bob", tags: [], members: [], color: 1 }, { id: "pc", name: "Ann", tags: [], members: [], color: 2 }] });
  const rec = game("Game1234", ["Bob", "Ann"]);
  const m = T.matchPlayers(t, rec, { assign: {} });
  check("'Bob' and 'bob' both claim one player: nobody gets them, listed as ambiguous", m.byPid.get("pa").length === 0 && m.byPid.get("pb").length === 0 && m.unmatched.some((u) => u.username === "Bob" && u.ambiguous));
  check("an unambiguous name still matches", m.byPid.get("pc").length === 1);
  const tagged = valid({ ...t, participants: [{ id: "pa", name: "Bob", tags: ["RED"], members: [], color: 0 }, { id: "pb", name: "bob", tags: ["BLU"], members: [], color: 1 }] });
  const rec2 = { ...rec, players: [P("Bob", { clanTag: "BLU" })] };
  check("a clan tag settles which namesake it is", T.matchPlayers(tagged, rec2, { assign: {} }).byPid.get("pb").length === 1);
  const assigned = T.matchPlayers(t, rec, { assign: { [rec.players[0].clientID]: "pb" } });
  check("the organiser's choice settles it", assigned.byPid.get("pb").length === 1 && assigned.byPid.get("pa").length === 0);
}

console.log("bracket: results and pins by sides, not positions");
{
  const cup = valid(demoTournaments(T).cup);
  // reseed: potato (p4) swaps with bunnykisses67 (p6); TeNa and potato no longer meet in the semis
  const re = clone(cup);
  const i4 = re.participants.findIndex((p) => p.id === "p4");
  const i6 = re.participants.findIndex((p) => p.id === "p6");
  [re.participants[i4], re.participants[i6]] = [re.participants[i6], re.participants[i4]];
  const reseeded = valid(re);
  const b = T.bracket(reseeded, slim);
  const semi = b.rounds[1][0];
  check("after a reseed a TeNa-potato result is not handed to whoever sits in that slot", !(semi.by === "override" && (semi.a !== "p1" || semi.b !== "p4") && semi.a && semi.b), `${semi.a} v ${semi.b} by ${semi.by}`);
  check("...it applies only where exactly those two meet", b.rounds.flat().filter((m) => m.by === "override").every((m) => T.pairKey(m.a, m.b) === T.pairKey("p1", "p4")));
  // the same pair meeting in another slot keeps its result
  const orig = T.bracket(cup, slim);
  check("the original seeding: the result decides TeNa vs potato", orig.rounds[1][0].by === "override" && orig.rounds[1][0].winner === "p1");
  // a pin to a match that is already decided: listed, not moved elsewhere
  const pinnedDone = valid({ ...clone(cup), games: cup.games.map((g) => (g.id === "yfMnoHJP" ? { ...g, match: { a: "p1", b: "p8" } } : g)) });
  const bp = T.bracket(pinnedDone, slim);
  check("a game pinned to a match that is not open is listed, not placed elsewhere", bp.unplaced.some((u) => u.gameId === "yfMnoHJP" && u.why === "pin") && !bp.rounds.flat().some((m) => m.games.some((g) => g.gameId === "yfMnoHJP")));
  const pinPair = valid({ ...clone(cup), bestOf: 3, overrides: [], games: cup.games.map((g) => (g.id === "dfReijmudi" ? { ...g, match: { a: "p6", b: "p3" } } : g)) });
  check("a pin by sides counts in that match", T.bracket(pinPair, slim).rounds[0][3].games.some((g) => g.gameId === "dfReijmudi"));
  const stalePin = valid({ ...clone(cup), games: cup.games.map((g) => (g.id === "dfReijmudi" ? { ...g, match: { a: "p2", b: "p3" } } : g)) });
  check("a pin whose two sides meet nowhere is stale", T.staleRefs(stalePin, T.bracket(stalePin, slim)).pins.includes("dfReijmudi"));
  // older builds' position-based data
  const legacy = T.validateTournament({ ...clone(cup), overrides: { r1m2: "p4", r2m1: "p1", series: "p1" }, games: cup.games.map((g) => (g.id === "dfReijmudi" ? { ...g, match: "r1m4" } : g)) });
  check("old position keys: round 1 and series converted to sides, later rounds dropped with a note", legacy.ok && legacy.value.overrides.some((o) => T.pairKey(o.a, o.b) === T.pairKey("p4", "p5") && o.winner === "p4") && legacy.value.overrides.some((o) => T.pairKey(o.a, o.b) === T.pairKey("p1", "p2")) && legacy.value.games.find((g) => g.id === "dfReijmudi").match?.a && legacy.notes.length === 1, JSON.stringify(legacy.value?.overrides));
  const s = valid(demoTournaments(T).bo3);
  const ov = T.series(valid({ ...s, overrides: [{ a: "pit", b: "pun", winner: "pit" }] }), slim);
  check("series result by sides", ov.winner === "pit" && ov.by === "override");
  const other = T.series(valid({ ...s, participants: [...s.participants, { id: "pzz", name: "Other", tags: [], members: [], color: 3 }], overrides: [{ a: "pit", b: "pzz", winner: "pzz" }] }), slim);
  check("a series result for another pair is ignored", other.by !== "override");
}

console.log("record cache: 250, the open tournament's records never evicted");
{
  check("cache holds more than one tournament's games", T.CACHE_CAPS.count >= T.LIMITS.games + 50);
  const idx = {};
  for (let i = 0; i < 260; i++) idx[`Game${String(i).padStart(4, "0")}`] = [i, 1000];
  const keep = new Set(["Game0000", "Game0001", "Game0002"]);
  const p = T.cachePlan(idx, [], { count: 250, bytes: 1e9 }, keep);
  check("over the cap: the oldest go, except the open tournament's", p.evict.length === 10 && !p.evict.some((id) => keep.has(id)) && p.evict[0] === "Game0003", p.evict.slice(0, 3).join());
  const free = T.evictAllBut(idx, keep);
  check("storage full: every record but the open tournament's is freed", free.evict.length === 257 && Object.keys(free.index).length === 3);
}

console.log("finishing order");
{
  check("never spawned is checked before won", T.finishKey({ won: true, dns: true }).tier === 3 && T.finishKey({ won: true, dns: false }).tier === 0);
  // team game: participant X's only player is on the winning team but never spawned
  const rec = { ...game("Game5678", ["A", "B"], false), winner: { type: "team", name: "Red" } };
  rec.players.push({ ...P("X"), active: false, winner: true, killedAt: null });
  rec.players[0].winner = true;
  const t = valid({ ...demoTournaments(T).league, participants: parts(["A", "B", "X"]) });
  const s = T.scoreGame(t, rec, { id: rec.gameId, assign: {} });
  const x = s.rows.find((r) => r.pid === "px");
  check("a never-spawned player on the winning team is last, not a winner, no points", x && x.dns && !x.won && x.place === 3 && x.points === 0, JSON.stringify(x && { place: x.place, won: x.won, points: x.points }));
}

console.log("average place compared unrounded");
{
  const X = [2, 3, 2];
  const Y = [3, 2, 3, 2, 2, 2, 3, 2, 2, 2];
  const recs = new Map();
  Y.forEach((py, i) => {
    const order = ["A", "B"];
    if (i < 3) {
      const px = X[i];
      const slots = [];
      slots[px - 1] = "X";
      slots[py - 1] = "Y";
      const rest = ["A", "B"].filter(() => true);
      const full = [];
      for (let k = 0; k < 4; k++) full.push(slots[k] ?? rest.shift());
      recs.set(`Game${1000 + i}`, game(`Game${1000 + i}`, full));
    } else {
      order.splice(py - 1, 0, "Y");
      recs.set(`Game${1000 + i}`, game(`Game${1000 + i}`, order));
    }
  });
  const t = valid({
    ...demoTournaments(T).league,
    scoring: { preset: "custom", win: 0, place: [0, 0, 0, 0], conquest: 0 },
    participants: parts(["A", "B", "X", "Y"]),
    games: [...recs.keys()].map((id) => ({ id, assign: {} })),
  });
  const st = T.standings(t, recs);
  const rx = st.rows.find((r) => r.name === "X");
  const ry = st.rows.find((r) => r.name === "Y");
  check("both show 2.3 (7/3 and 23/10)", rx.avgPlace === 2.3 && ry.avgPlace === 2.3, `${rx.placeSum}/${rx.placed} ${ry.placeSum}/${ry.placed}`);
  check("2.30 ranks above 2.33: not a tie sent to head-to-head", st.rows.indexOf(ry) < st.rows.indexOf(rx) && T.compareAvg(ry, rx) < 0, st.rows.map((r) => `${r.name}:${r.avgPlace}:${r.tieBreak}`).join(" "));
  check("head-to-head alone would have put X first (so the test discriminates)", st.h2h.get("px").get("py").w > st.h2h.get("px").get("py").l);
}

console.log("team colours");
{
  const rec = { gameId: "Team7game", teams: 7, winner: { type: "team", name: "Red" }, players: Array.from({ length: 14 }, (_, i) => P(`p${i}`, { teamIndex: i % 7, winner: i % 7 === 0 })) };
  const teams = T.suggestParticipants(rec, "team");
  check("seven teams named Red ... Teal", teams.map((x) => x.name).join() === "Red,Blue,Yellow,Green,Purple,Orange,Teal", teams.map((x) => x.name).join());
  check("each team colour its own slot", new Set(teams.map((x) => x.color)).size === 7 && teams.every((x) => x.color < T.COLORS));
}

console.log("results text for Discord");
{
  const t = valid({ ...demoTournaments(T).league, name: "@here Cup", participants: parts(["@everyone", "**bold**", "a_b", "`code`", "<@123>", "~~s~~", "||spoil||", "> quote"]), games: [] });
  const txt = T.resultsText(t, { st: T.standings(t, new Map()) });
  check("no ping survives (@everyone, @here, <@id>)", !/@everyone|@here|<@1/.test(txt) && txt.includes(`@${ZWSP}everyone`) && txt.includes(`@${ZWSP}here`));
  check("markdown is escaped", txt.includes("\\*\\*bold\\*\\*") && txt.includes("a\\_b") && txt.includes("\\`code\\`") && txt.includes("\\~\\~s\\~\\~") && txt.includes("\\|\\|spoil\\|\\|") && txt.includes("\\> quote"), txt.split("\n").slice(0, 4).join(" / "));
}

console.log("speed: 64 teams x 24 members, 200 games x 150 players");
{
  const teams = Array.from({ length: 64 }, (_, i) => ({ id: `p${i}`, name: `Team ${i}`, tags: [`T${i}`], members: Array.from({ length: 24 }, (_, j) => `m${i}x${j}`), color: i % 6 }));
  const recs = new Map();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let g = 0; g < 200; g++) {
    const id = `Game${String(g).padStart(4, "0")}`;
    const players = Array.from({ length: 150 }, (_, k) => {
      const team = Math.floor(rnd() * 70); // some strangers
      const who = team < 64 ? `M${team}X${Math.floor(rnd() * 24)}` : `stranger${k}`;
      return { ...P(who), clientID: `c${g}k${k}`, clanTag: rnd() < 0.2 && team < 64 ? `t${team}` : null, killedAt: k === 0 ? null : 5000 - k, winner: k === 0 };
    });
    recs.set(id, { gameId: id, map: "World", mode: "Team", teams: 64, duration: 600, start: g + 1, end: 1, winner: { type: "player", name: null }, players });
  }
  const t = valid({ ...demoTournaments(T).league, unit: "team", participants: teams, games: [...recs.keys()].map((id) => ({ id, assign: {} })) });
  const compute = T.computer();
  const t0 = performance.now();
  const c1 = compute(t, recs, "1");
  const first = performance.now() - t0;
  const t1 = performance.now();
  const c2 = compute(t, recs, "1");
  const again = performance.now() - t1;
  check("first compute under 200 ms", first < 200, `${first.toFixed(1)} ms, ${c1.st.rows[0].played} games for the leader`);
  check("memoised: same tournament and version -> no recompute", c1 === c2 && again < 5, `${again.toFixed(2)} ms`);
  check("a new version recomputes", compute(t, recs, "2") !== c1);
  check("members matched case-insensitively (M1X2 = m1x2)", c1.st.rows.every((r) => r.played > 0));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
