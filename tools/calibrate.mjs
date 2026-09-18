// Recalculates the PERCENTILE_TABLE in src/content.js from live data, and
// prints how a real lobby would be labelled with the table that is shipped.
//
//   node tools/calibrate.mjs            # show current labelling + quantiles
//
// Players are sampled from recently finished public games via the OpenFront
// API, then looked up on ofstats for wins vs expectedWins.
import fs from "node:fs";

const SRC = new URL("../src/scoring.js", import.meta.url);
const source = fs.readFileSync(SRC, "utf8");

// Reuse the shipped scoring code rather than a copy that can drift.
const pick = (name) => {
  const re = new RegExp(
    `(const ${name} = [\\s\\S]*?^\\];)|(function ${name}\\([\\s\\S]*?^\\})`,
    "m",
  );
  const m = source.match(re);
  if (!m) throw new Error(`could not extract ${name} from scoring.js`);
  return m[0];
};
const scoring = [
  "const SHRINK_K = " + source.match(/const SHRINK_K = (\d+)/)[1] + ";",
  "const MIN_RATED_GAMES = " + source.match(/const MIN_RATED_GAMES = (\d+)/)[1] + ";",
  pick("skillRatio"),
  pick("PERCENTILE_TABLE"),
  pick("topPercent"),
  pick("percentBand"),
  pick("formatPercent"),
  "return { skillRatio, topPercent, percentBand, formatPercent, MIN_RATED_GAMES };",
].join("\n");
const { skillRatio, topPercent, percentBand, formatPercent, MIN_RATED_GAMES } =
  new Function(scoring)();

const j = async (u) => {
  try {
    const r = await fetch(u, { headers: { accept: "application/json" } });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
};

const end = new Date();
const start = new Date(Date.now() - 24 * 3600e3);
const games = await j(
  `https://api.openfront.io/public/games?start=${start.toISOString()}&end=${end.toISOString()}&type=Public&limit=40`,
);
const names = new Set();
for (const g of games ?? []) {
  const d = await j(`https://api.openfront.io/public/game/${g.game}?turns=false`);
  for (const p of d?.info?.players ?? []) {
    if (p.username && !/^Anon[A-Za-z]*\d*$/.test(p.username)) names.add(p.username);
  }
  if (names.size > 500) break;
}

const players = [];
const list = [...names];
for (let i = 0; i < list.length; i += 25) {
  await Promise.all(
    list.slice(i, i + 25).map(async (n) => {
      const d = await j(`https://api.ofstats.io/players/${encodeURIComponent(n)}`);
      if (!d || !(d.gamesPlayed > 0)) return;
      const rows = d.maps?.rows ?? [];
      const info = {
        ratedGames: rows.reduce((a, r) => a + (r.games ?? 0), 0),
        ratedWins: rows.reduce((a, r) => a + (r.wins ?? 0), 0),
        expectedWins: rows.reduce((a, r) => a + (r.expectedWins ?? 0), 0),
      };
      const ratio = skillRatio(info);
      if (ratio === null || info.ratedGames < MIN_RATED_GAMES) return;
      players.push({ name: n, ratio, pct: topPercent(ratio) });
    }),
  );
}

players.sort((a, b) => a.pct - b.pct);
console.log(`sampled ${players.length} rated players of ${list.length} names\n`);

const bands = {};
for (const p of players) bands[percentBand(p.pct)] = (bands[percentBand(p.pct)] ?? 0) + 1;
console.log("band spread:", bands);

const labels = {};
for (const p of players) {
  const l = `Top ${formatPercent(p.pct)}%`;
  labels[l] = (labels[l] ?? 0) + 1;
}
const worst = Object.entries(labels).sort((a, b) => b[1] - a[1])[0];
console.log(
  `distinct labels: ${Object.keys(labels).length}, most common "${worst[0]}" on ${worst[1]}/${players.length}`,
);
console.log("\nsample:", players.slice(0, 3).concat(players.slice(-3)).map((p) => `${p.name}=Top ${formatPercent(p.pct)}% (${p.ratio.toFixed(2)}x)`));

const ratios = players.map((p) => p.ratio).sort((a, b) => a - b);
const q = (p) => ratios[Math.floor((ratios.length - 1) * p)].toFixed(2);
console.log("\nratio quantiles: p10", q(0.1), "p25", q(0.25), "p50", q(0.5), "p75", q(0.75), "p90", q(0.9), "p95", q(0.95));
