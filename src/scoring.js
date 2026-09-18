// Skill scoring shared by the lobby badges (content.js), the Pro dashboard
// (dashboard.js) and the share card. Loaded as a content script before them, in
// the same isolated world, and exposed on globalThis.OFR_SCORING.
//
// tools/calibrate.mjs reads the constants and functions below straight out of
// this file, so keep each as a top-level `const NAME = [...]` or
// `function name(...) {...}`.
(() => {
  if (globalThis.OFR_SCORING) return;

function compactGames(games) {
  return games >= 1000 ? `${(games / 1000).toFixed(1)}k` : String(games);
}

// Skill = wins against what an average player would have won in the same
// lobbies (ofstats' per-map expectedWins already accounts for lobby size), so a
// 60-player free-for-all and a 1v1 are on one scale.
//
// Shrunk toward parity so a 4-game hot streak does not outrank a 1000-game
// veteran: K is worth K expected wins of "perfectly average" evidence.
const SHRINK_K = 3;

function skillRatio(info) {
  if (!(info?.expectedWins > 0)) return null;
  return (info.ratedWins + SHRINK_K) / (info.expectedWins + SHRINK_K);
}

// Measured on real public-lobby players (tools/calibrate.mjs). ofstats' own
// winsTop only has the buckets 0.01/0.1/1/5, which puts most of a lobby in
// "Top 1%"; these breakpoints spread the same players out.
const PERCENTILE_TABLE = [
  [0.43, 95],
  [0.54, 90],
  [0.75, 75],
  [0.87, 60],
  [0.97, 50],
  [1.11, 40],
  [1.21, 30],
  [1.28, 25],
  [1.34, 20],
  [1.43, 15],
  [1.62, 10],
  [1.78, 5],
  [2.05, 3],
  [2.2, 1.5],
  [2.6, 1],
  [3.2, 0.5],
];

// Interpolate in log space — the ratio is multiplicative, so the gap from 1.0
// to 1.2 means as much as 1.2 to 1.44.
function topPercent(ratio) {
  const table = PERCENTILE_TABLE;
  const best = table[table.length - 1];
  if (ratio <= table[0][0]) return 99;
  if (ratio >= best[0]) return best[1];
  for (let i = 1; i < table.length; i++) {
    const [hiRatio, hiPct] = table[i];
    if (ratio > hiRatio) continue;
    const [loRatio, loPct] = table[i - 1];
    const t =
      (Math.log(ratio) - Math.log(loRatio)) /
      (Math.log(hiRatio) - Math.log(loRatio));
    return loPct + t * (hiPct - loPct);
  }
  return best[1];
}

function percentBand(pct) {
  if (pct <= 5) return "elite";
  if (pct <= 15) return "strong";
  if (pct <= 35) return "good";
  if (pct <= 60) return "average";
  return "low";
}

function formatPercent(pct) {
  if (pct < 1) return "<1";
  return String(Math.round(pct));
}

// Below this there is not enough history for a percentile to mean anything.
const MIN_RATED_GAMES = 3;

function ranked(info) {
  const ratio = skillRatio(info);
  if (ratio === null || !(info.ratedGames >= MIN_RATED_GAMES)) return null;
  return { ratio, pct: topPercent(ratio) };
}

// Same scoring for one map's row (wins vs expected on that map only).
function rowRank(row) {
  if (!(row?.expectedWins > 0)) return null;
  const ratio = (row.wins + SHRINK_K) / (row.expectedWins + SHRINK_K);
  return { ratio, pct: topPercent(ratio) };
}

  globalThis.OFR_SCORING = {
    SHRINK_K,
    MIN_RATED_GAMES,
    PERCENTILE_TABLE,
    compactGames,
    skillRatio,
    topPercent,
    percentBand,
    formatPercent,
    ranked,
    rowRank,
  };
})();
