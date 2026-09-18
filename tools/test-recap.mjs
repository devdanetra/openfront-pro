// Runs the recap's pure half - background.js's record normaliser and
// recap.js's analyse() - over real OpenFront game records, in node.
//
//   node tools/test-recap.mjs            fetch the sample records once into
//                                        .recap/ (git-ignored dev data), then test
//
// Records cover both formats the API serves (older builds, and newer ones with
// finalTiles / kills), FFA, Team, Duos, ranked 2v2, ranked 1v1, and a game with
// two players of the same name.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // survives spaces in the path
const DIR = path.join(ROOT, ".recap");
fs.mkdirSync(DIR, { recursive: true });

const SAMPLES = {
  "5S99ULQP": "FFA, old format, TeNa wins",
  yfMnoHJP: "Team 7, old format, Yellow wins",
  HPeHLRqX: "ranked 1v1, old format",
  ddNXyXafFo: "FFA, new format",
  d4tvvVquk6: "Duos, new format",
  dc5VgbARGx: "ranked 2v2, new format",
  dVLrYJEaGm: "ranked 1v1, new format",
  dfReijmudi: "Team 5, new format, two players called USSR",
};

// ---- load the code under test ------------------------------------------------------
const bg = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const block = bg.slice(bg.indexOf("// <record-normaliser>"), bg.indexOf("// </record-normaliser>"));
const sandbox = { globalThis: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(block.replace(/async function fetchGameRecord[\s\S]*?\n}\n/, "") + "\nthis.normaliseRecord = normaliseRecord;", sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/scoring.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/recap.js"), "utf8"), sandbox);
const { normaliseRecord, OFR_RECAP } = sandbox;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};

async function load(id) {
  const file = path.join(DIR, `game-${id}.json`);
  if (!fs.existsSync(file)) {
    const res = await fetch(`https://api.openfront.io/public/game/${id}?turns=false`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    fs.writeFileSync(file, JSON.stringify(await res.json()));
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// a fake world ranking: deterministic, covers about two thirds of the players
const pctOf = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 3 === 0 ? null : 1 + (h % 97);
};

const invariants = (label, model, record) => {
  if (model.state !== "ok") return;
  const active = record.players.filter((p) => p.active).length;
  check(`${label}: counts only players who spawned`, model.meta.players === active && model.standings.length === active, `${active} of ${record.players.length}`);
  check(`${label}: nobody without a death is given a made-up exact place`, model.standings.every((r) => !(r.time === "alive" && /^\d+$/.test(r.place) && r.place !== "1") || record.players.some((p) => p.finalTiles != null)));
  check(`${label}: awards have unique holders capped at 2 (+sweep)`, (() => {
    const per = new Map();
    for (const a of model.awards) if (a.key !== "sweep") per.set(a.holder, (per.get(a.holder) ?? 0) + 1);
    return [...per.values()].every((n) => n <= 2);
  })());
  check(`${label}: survival curve is monotonic and ends at the survivors`, (() => {
    const pts = model.charts.survival.points;
    for (let i = 1; i < pts.length; i++) if (pts[i].y > pts[i - 1].y || pts[i].x < pts[i - 1].x) return false;
    return pts[0].y === active;
  })());
  check(`${label}: text export has no undefined/NaN`, !/undefined|NaN|\[object/.test(OFR_RECAP.textLines(model, []).join("\n")));
};

for (const [id, what] of Object.entries(SAMPLES)) {
  const raw = await load(id);
  console.log(`\n${id} - ${what}`);
  if (!raw) {
    console.log("  (could not fetch; skipped)");
    continue;
  }
  const record = normaliseRecord(raw, id);
  const active = record.players.filter((p) => p.active);
  console.log(`  ${record.map} / ${record.mode} / teams=${record.teams} / ${record.players.length} listed, ${active.length} spawned / winner ${record.winner.type}:${record.winner.name ?? ""} (${record.winner.ids.length} ids) / finalTiles on ${active.filter((p) => p.finalTiles != null).length}`);

  // as a spectator
  const spectator = OFR_RECAP.analyse(record, { me: null, pctOf });
  console.log(`  spectator: "${spectator.result?.title}" - ${spectator.result?.kicker}`);
  invariants("spectator", spectator, record);

  // as the winner, as the first player out, as a survivor, as someone who never spawned
  const winner = active.find((p) => p.winner);
  const firstOut = [...active].filter((p) => p.killedAt != null).sort((a, b) => a.killedAt - b.killedAt)[0];
  const survivor = active.find((p) => !p.winner && p.killedAt == null);
  const ghost = record.players.find((p) => !p.active);
  const unique = (p) => p && record.players.filter((q) => q.username.toLowerCase() === p.username.toLowerCase()).length === 1;
  for (const [role, p] of [["winner", winner], ["first out", firstOut], ["survivor", survivor], ["never spawned", ghost]]) {
    if (!p || !unique(p)) continue;
    const model = OFR_RECAP.analyse(record, { me: p.username.toLowerCase(), myClan: p.clanTag, pctOf });
    const r = model.result;
    console.log(`  as ${role} (${p.username}): "${r.title}${r.of ? ` ${r.of}` : ""}" - ${r.kicker} | chips: ${model.chips.map((c) => `${c.text} ${c.label}${c.ranked ? ` #${c.rank}` : ""}`).join("; ") || "-"}`);
    invariants(role, model, record);
    if (role === "winner") check("winner reads Victory", r.title === "Victory" && r.tone === "win");
    if (role === "first out" && !model.isTeam && !model.is1v1) check("first out is last", r.title === `#${model.meta.players + (record.winner.type === "nation" ? 1 : 0)}`, r.title);
    if (role === "survivor" && model.is1v1) check("1v1 loser without killedAt reads Defeat", r.title === "Defeat");
    if (role === "survivor" && !model.is1v1 && !model.isTeam) check("FFA survivor is tied or exactly placed, never '#1'", r.title !== "#1", r.title);
    if (role === "never spawned") check("never spawned is not ranked", r.kind === "sat");
    if (role === "winner") {
      console.log(`    lines: ${model.lines.map((l) => l.text).join(" | ")}`);
      console.log(`    awards: ${model.awards.map((a) => `${a.title}=${a.who}`).join(", ")}`);
    }
  }
  const dup = record.players.find((p) => !unique(p));
  if (dup) {
    const model = OFR_RECAP.analyse(record, { me: dup.username.toLowerCase(), myClan: null, pctOf });
    check(`duplicate name "${dup.username}" is not guessed`, model.me === null && model.result.kind === "spectator");
  }
}

// ---- regressions found in review, on real records -----------------------------------------------
console.log("");
console.log("regressions");
const real = async (id) => normaliseRecord(await load(id), id);
const as = (record, name, extra = {}) => OFR_RECAP.analyse(record, { me: name.toLowerCase(), pctOf, ...extra });
{
  const duos = await real("d4tvvVquk6");
  const team5 = await real("dfReijmudi");
  const killerOf = (record, name) => as(record, name).lines.find((l) => l.kind === "killer")?.text ?? "";
  // conquered early, came back, finished off much later by someone else
  check("killer = the conquest at the moment of elimination (AnonBonfire6)", /gandhi with nukes/.test(killerOf(duos, "AnonBonfire6")), killerOf(duos, "AnonBonfire6"));
  check("killer = the conquest at the moment of elimination (CCCP)", /AnonFlame7/.test(killerOf(team5, "CCCP")), killerOf(team5, "CCCP"));
  // a member of the winning team who died in minute two
  const dead = as(duos, "AnonRiver2");
  const s = dead.charts.survival;
  const onCurve = s.points.find((pt) => pt.x === s.me.x);
  check("dead winner sits ON the survival curve, not at the final count", dead.me.won && !dead.me.alive && onCurve && onCurve.y === s.me.y, JSON.stringify(s.me));
  check("survival curve ends at the number of players without an elimination tick", s.points[s.points.length - 1].y === duos.players.filter((pl) => pl.active && pl.killedAt == null).length);
  const spectator = OFR_RECAP.analyse(duos, { me: null, pctOf });
  check("spectator graphs follow the winner who did the work, not the first listed", /gandhi with nukes/.test(spectator.charts.compare.legend[0].label), spectator.charts.compare.legend[0].label);
  // ranked 2v2 where exactly one human was eliminated, twice
  const v2 = await real("dc5VgbARGx");
  const hakon = as(v2, "HakonDenSkjetne", { myClan: "HS" });
  check("repeat conquests of one victim count once", hakon.chips.find((c) => c.key === "conq")?.value === 1 && !hakon.awards.some((a) => a.key === "executioner"), JSON.stringify(hakon.chips.find((c) => c.key === "conq")));
  // ofstats keys a tagged player on "[TAG] name"; their bare name is another record there
  const asked = new Set();
  const byKey = (k) => {
    asked.add(k);
    return k === "[hs] hakondenskjetne" ? 7 : null;
  };
  const taggedMe = as(v2, "HakonDenSkjetne", { myClan: "HS", pctOf: byKey });
  check("a tagged player's percentile is keyed \"[TAG] name\", never the bare name", asked.has("[hs] hakondenskjetne") && !asked.has("hakondenskjetne") && taggedMe.me?.pct === 7 && taggedMe.standings.find((r) => r.me)?.pct === 7, [...asked].join(", "));
  const keys = v2.players.filter((p) => p.active).map((p) => (p.clanTag ? `[${p.clanTag}] ${p.username}` : p.username).toLowerCase());
  check("every player is asked for under their ofstats name (bare when untagged)", keys.length === asked.size && keys.every((k) => asked.has(k)), keys.join(", "));
  // old format: no kill list, so the wording must not promise distinct players
  const old = as(await real("5S99ULQP"), "TeNa");
  check("old records say conquests, not players", /conquests?$/.test(old.chips.find((c) => c.key === "conq")?.label ?? ""), old.chips.find((c) => c.key === "conq")?.label);
  const twins = OFR_RECAP.analyse(team5, { me: "ussr", myClan: null, pctOf, streamer: true });
  check("streamer mode: a name shared with another player is still masked", twins.me === null && !twins.standings.some((r) => /ussr/i.test(r.name)) && !/ussr/i.test(OFR_RECAP.textLines(twins, []).join(" ")));
  // OpenFront ids beat names: two players called USSR, told apart by client id
  const ussr = team5.players.filter((p) => p.username === "USSR" && p.active);
  if (ussr.length === 2) {
    const first = OFR_RECAP.analyse(team5, { me: "ussr", myClientId: ussr[0].clientID, pctOf });
    const second = OFR_RECAP.analyse(team5, { me: "ussr", myClientId: ussr[1].clientID, pctOf });
    check("same name, client id known: each USSR gets their own recap", first.matchedBy === "clientId" && second.matchedBy === "clientId" && first.result.kicker !== second.result.kicker, `${first.result.kicker} | ${second.result.kicker}`);
    check("the record's public id comes back for next time", typeof first.myPublicId === "string" && first.myPublicId.length > 0 && first.myPublicId !== second.myPublicId);
    const later = OFR_RECAP.analyse(team5, { me: "ussr", myPublicId: second.myPublicId, pctOf });
    check("same name, only the public id known: still exact", later.matchedBy === "publicId" && later.result.kicker === second.result.kicker);
    const renamed = OFR_RECAP.analyse(team5, { me: "some new name", myClientId: ussr[0].clientID, pctOf });
    check("a client id finds me even after a rename", renamed.me !== null && renamed.matchedBy === "clientId");
    check("a wrong client id falls back to the name rules (ambiguous -> not guessed)", OFR_RECAP.analyse(team5, { me: "ussr", myClientId: "nope1234", pctOf }).me === null);
  } else check("fixture still has two active USSR players", false);
  const tied = as(await real("5S99ULQP"), "LAND MASS");
  check("a tied survivor gets no 'finished #2 among them'", tied.me.tied && !tied.lines.some((l) => l.kind === "seed"));
}

// ---- synthetic edge cases --------------------------------------------------------------------
console.log("\nsynthetic");
const mk = (over) => ({ info: { gameID: "x", config: { gameMap: "World", gameMode: "Free For All" }, duration: 600, num_turns: 6000, players: [], ...over } });
const pl = (name, id, stats) => ({ username: name, clientID: id, clanTag: null, ...(stats ? { stats } : {}) });
const nation = normaliseRecord(mk({ winner: ["nation", "France"], players: [pl("a", "1", { attacks: ["10"] }), pl("b", "2", { attacks: ["10"], killedAt: "500" }), pl("c", "3", { attacks: ["5"], killedAt: "900" })] }), "x");
const nm = OFR_RECAP.analyse(nation, { me: "c", pctOf: () => null });
check("nation winner: one field size everywhere", nm.result.of === "of 4" && OFR_RECAP.analyse(nation, { me: "a", pctOf: () => null }).result.of === "of 4", nm.result.of);
{
  const clash = normaliseRecord(mk({ winner: ["player", "1"], players: [{ ...pl("USSR", "1", { attacks: ["10"] }), clanTag: "RED" }, pl("USSR", "2", { attacks: ["10"], killedAt: "100" }), pl("x", "3", { attacks: ["5"], killedAt: "50" })] }), "x");
  check("same name, my clan unknown: do not guess", OFR_RECAP.analyse(clash, { me: "ussr", myClan: null, pctOf: () => null }).me === null);
  check("same name, my clan known: found", OFR_RECAP.analyse(clash, { me: "ussr", myClan: "RED", pctOf: () => null }).me?.won === true);
  const field = normaliseRecord(mk({ winner: ["player", "1"], players: [pl("w", "1", { attacks: ["9"] }), ...["a", "b", "c", "d", "e"].map((n, i) => pl(n, String(i + 2), { attacks: ["5"], killedAt: String(100 * (i + 1)) }))] }), "x");
  const ranks = { w: 55, a: 60, b: 70, c: 80, d: 90, e: 95 };
  const up = OFR_RECAP.analyse(field, { me: "a", pctOf: (n) => ranks[n] ?? null });
  check("the best-ranked player winning is not an 'upset'", !up.lines.some((l) => l.kind === "upset") && up.lines.some((l) => l.kind === "favourite"), up.lines.map((l) => l.kind).join(","));
  const sameTick = normaliseRecord(mk({ winner: ["player", "1"], players: [pl("w", "1", { attacks: ["9"] }), pl("me", "2", { attacks: ["5"], killedAt: "500" }), pl("a", "3", { attacks: ["5"], killedAt: "500" }), pl("b", "4", { attacks: ["5"], killedAt: "100" }), pl("c", "5", { attacks: ["5"], killedAt: "90" })] }), "x");
  const st = OFR_RECAP.analyse(sameTick, { me: "me", pctOf: (n) => ({ w: 5, me: 40, a: 10, b: 50, c: 60 })[n] ?? null });
  check("eliminated on the same tick = same place, nobody 'outlasted' the other", st.standings.filter((r) => r.place === "2").length === 2 && !st.lines.some((l) => l.kind === "giant" && /a/.test(l.text)), st.lines.map((l) => l.text).join(" | "));
}
check("nation winner: nobody human is the winner, places start at 2", nm.winnerLabel === "France (nation)" && nm.result.title === "#3" && nm.standings[0].place.replace("=", "") === "2", `${nm.result.title} / ${nm.standings.map((s) => s.place).join(",")}`);
const none = OFR_RECAP.analyse(normaliseRecord(mk({ players: [pl("a", "1"), pl("b", "2")] }), "x"), { me: "a", pctOf: () => null });
check("no winner and no stats: a message, not a crash", none.state === "nostats" && typeof none.message === "string");
const empty = OFR_RECAP.analyse(normaliseRecord({}, "x"), {});
check("empty record: a message, not a crash", empty.state === "nostats");
const streamer = OFR_RECAP.analyse(nation, { me: "a", pctOf: () => null, streamer: true });
{
  const ranked5 = OFR_RECAP.analyse(await real("5S99ULQP"), { me: "tena", pctOf: (n) => (n === "tena" ? 2.4 : pctOf(n)), streamer: true });
  const text = OFR_RECAP.textLines(ranked5, []).join(" | ");
  check("streamer mode hides the viewer's rank too", ranked5.me.pct === null && !/Seeded|Top 2(\.4)?%/.test(text) && !ranked5.lines.some((l) => /You \(Top/.test(l.text)) && ranked5.standings.find((r) => r.me).pct === null, text.slice(0, 160));
}
check("streamer mode never prints the viewer's name", !OFR_RECAP.textLines(streamer, []).join("\n").match(/\ba\b/) && streamer.me.name === "You");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
