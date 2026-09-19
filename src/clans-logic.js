// Clan hub: the pure half (no DOM, no chrome.*), so node can test it
// (tools/test-clans.mjs). Needs globalThis.OFR_SCORING (src/scoring.js) loaded
// first. Exposed as globalThis.OFR_CLAN_LOGIC. The worker (background.js)
// loads it too, for the Recruits index (recruitRecord / mergeRecruits).
(() => {
  if (globalThis.OFR_CLAN_LOGIC) return;
  const S = () => globalThis.OFR_SCORING;

  const DAY = 86400000;
  const WEEK = 7 * DAY;
  // "[TAG] name" - ofstats' key for a player who plays with a clan tag.
  const TAGGED = /^\[([A-Za-z0-9]{1,5})\]\s+(\S.*)$/;
  // OpenFront's generated handles for players who never set a name (content.js).
  const GUEST = /^Anon[A-Za-z]*\d*$/u;
  const TAG_RE = /^[A-Za-z0-9]{1,5}$/;

  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  const lower = (s) => String(s ?? "").toLowerCase();
  const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.length > 0 && lower(a) === lower(b);

  function normTag(tag) {
    const t = String(tag ?? "").trim().replace(/^\[|\]$/g, "").toUpperCase();
    return TAG_RE.test(t) ? t : null;
  }
  function splitName(name) {
    const m = TAGGED.exec(String(name ?? ""));
    return m ? { tag: m[1].toUpperCase(), bare: m[2] } : { tag: null, bare: String(name ?? "") };
  }
  const bareName = (name) => splitName(name).bare;
  const isTagged = (name) => TAGGED.test(String(name ?? ""));
  const isGuest = (name) => GUEST.test(String(name ?? ""));

  // Is this name you? Errs on the side of yes (streamer mode hides on a match):
  // the same full name, or the same bare name under any tag or none.
  function isSelf(name, self) {
    if (!self || !name) return false;
    return sameName(name, self) || sameName(bareName(name), bareName(self));
  }

  // ---- ISO weeks ("2026-W38", Monday to Sunday, UTC as ofstats uses) -------------------
  function isoWeek(ms) {
    const d = new Date(ms);
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = day.getUTCDay() || 7; // Monday 1 .. Sunday 7
    day.setUTCDate(day.getUTCDate() + 4 - dow); // the Thursday decides the year
    const year = day.getUTCFullYear();
    const week = Math.ceil(((day - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
    return `${year}-W${String(week).padStart(2, "0")}`;
  }
  // Monday 00:00 UTC of that week, or null for anything that is not a week.
  function weekStart(week) {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(week ?? ""));
    if (!m) return null;
    const year = Number(m[1]);
    const w = Number(m[2]);
    if (w < 1 || w > 53) return null;
    const jan4 = Date.UTC(year, 0, 4);
    const dow = new Date(jan4).getUTCDay() || 7;
    return jan4 - (dow - 1) * DAY + (w - 1) * WEEK;
  }
  function shiftWeek(week, delta) {
    const start = weekStart(week);
    return start == null ? null : isoWeek(start + delta * WEEK + DAY);
  }
  const weekNumber = (week) => Number(/-W(\d{2})$/.exec(String(week ?? ""))?.[1] ?? NaN);
  // A week the hub may show (#week=): a real ISO week (no W00, no W53 in a
  // 52-week year) from 52 weeks ago up to this week. Anything else -> null.
  function validWeek(week, now = Date.now()) {
    const start = weekStart(week);
    if (start == null || isoWeek(start) !== week) return null;
    const floor = weekStart(isoWeek(now - 52 * WEEK));
    const current = weekStart(isoWeek(now));
    return start >= floor && start <= current ? week : null;
  }

  // What the hub shows for an ofstats name. In streamer mode your own name is
  // "You"; while the hub does not know which name is yours (self null), every
  // name is masked, since any of them could be yours.
  const MASK = "••••••";
  function displayName(name, { streamer = false, self = null } = {}) {
    if (!streamer) return bareName(name);
    if (!self) return MASK;
    return isSelf(name, self) ? "You" : bareName(name);
  }
  // ...and whether a link or tooltip may carry the real name.
  const nameHidden = (name, { streamer = false, self = null } = {}) => streamer && (!self || isSelf(name, self));

  // ---- weekly movers: this week's table against last week's ---------------------------------
  // current / previous: [{ tag, rank }] (each week's top of the table). A clan
  // missing from last week's table "entered" it; one missing from this week's
  // "left" it. delta > 0 = climbed.
  function movers(current, previous, { limit = 3 } = {}) {
    const cur = (current ?? []).filter((c) => c?.tag && fin(c.rank));
    const prev = (previous ?? []).filter((c) => c?.tag && fin(c.rank));
    const before = new Map(prev.map((c) => [c.tag.toUpperCase(), c.rank]));
    const now = new Set(cur.map((c) => c.tag.toUpperCase()));
    const known = prev.length > 0;
    const rows = cur.map((c) => {
      const was = before.get(c.tag.toUpperCase());
      return {
        tag: c.tag,
        rank: c.rank,
        prevRank: was ?? null,
        delta: was == null ? null : was - c.rank,
        entered: known && was == null,
      };
    });
    const byTag = new Map(rows.map((r) => [r.tag.toUpperCase(), r]));
    const up = rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta || a.rank - b.rank).slice(0, limit);
    const down = rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta || a.rank - b.rank).slice(0, limit);
    const entered = rows.filter((r) => r.entered);
    const left = prev.filter((c) => !now.has(c.tag.toUpperCase())).map((c) => ({ tag: c.tag, prevRank: c.rank }));
    return { known, rows, byTag, up, down, entered, left };
  }

  // ---- one clan -------------------------------------------------------------------------------
  const rate = (wins, games) => (fin(games) && games > 0 && fin(wins) ? wins / games : null);

  function clanRates(clan) {
    const t = clan?.team ?? {};
    return {
      all: rate(clan?.wins, clan?.games),
      team: rate(t.wins, t.games),
      stacked: rate(t.stackedWins, t.stackedGames),
      recent: rate(t.recentWins, t.recentGames),
      // ofstats' reference: what an average stack wins (percent)
      stackedRef: fin(clan?.reference?.stackedWinRate) ? clan.reference.stackedWinRate / 100 : null,
      active: fin(clan?.memberCount) && clan.memberCount > 0 && fin(clan?.activeMembers) ? Math.min(1, clan.activeMembers / clan.memberCount) : null,
    };
  }

  const ago = (iso, now) => {
    const t = typeof iso === "number" ? iso : Date.parse(iso ?? "");
    return Number.isFinite(t) ? Math.max(0, (now - t) / DAY) : null;
  };
  // "active" = played in the last 7 / 30 days, from ofstats' lastPlayed per member.
  function activityOf(lastPlayed, now = Date.now()) {
    const days = ago(lastPlayed, now);
    if (days == null) return { days: null, level: "unknown" };
    return { days, level: days <= 7 ? "week" : days <= 30 ? "month" : "idle" };
  }
  function memberActivity(members, now = Date.now()) {
    const out = { week: 0, month: 0, idle: 0, unknown: 0, total: 0 };
    for (const m of members ?? []) {
      out[activityOf(m.lastPlayed, now).level]++;
      out.total++;
    }
    return out;
  }

  function modeKey(mode) {
    const s = lower(mode);
    if (s.includes("team")) return "team";
    if (s.includes("ranked") || s.includes("1v1") || s.includes("duel")) return "ranked";
    if (s.includes("free")) return "ffa";
    return "other";
  }

  // A player lookup (background.js fetchStats) as the hub draws it.
  function profile(info, now = Date.now()) {
    if (!info?.found) return null;
    const r = S().ranked(info);
    const modes = { ffa: { games: 0, wins: 0 }, team: { games: 0, wins: 0 }, ranked: { games: 0, wins: 0 }, other: { games: 0, wins: 0 } };
    for (const m of info.modes ?? []) {
      const k = modeKey(m.mode);
      modes[k].games += fin(m.games) ? m.games : 0;
      modes[k].wins += fin(m.wins) ? m.wins : 0;
    }
    const recent = (info.recentGames ?? []).slice(0, 10).map((g) => ({ won: g.won === true, mode: modeKey(g.mode), map: g.map ?? null, date: g.date ?? null, id: g.id ?? null }));
    const expectedRate = info.ratedGames > 0 && fin(info.expectedWins) ? info.expectedWins / info.ratedGames : null;
    return {
      username: String(info.username ?? ""),
      pct: r ? r.pct : null,
      band: r ? S().percentBand(r.pct) : null,
      ratio: r ? r.ratio : null,
      games: fin(info.games) ? info.games : 0,
      wins: fin(info.wins) ? info.wins : 0,
      winRate: rate(info.wins, info.games),
      expectedRate,
      lastSeenDays: ago(info.lastSeen, now),
      modes,
      recent,
      streak: fin(info.streak) ? info.streak : 0,
    };
  }

  // Members' percentiles: the mean of those ranked, and how many sit in each band.
  function memberStrength(profiles) {
    const ranked = (profiles ?? []).filter((p) => p && fin(p.pct));
    const counts = { elite: 0, strong: 0, good: 0, average: 0, low: 0, unranked: 0 };
    for (const p of profiles ?? []) {
      if (p && fin(p.pct)) counts[S().percentBand(p.pct)]++;
      else counts.unranked++;
    }
    const avg = ranked.length ? ranked.reduce((a, p) => a + p.pct, 0) / ranked.length : null;
    const sorted = ranked.map((p) => p.pct).sort((a, b) => a - b);
    const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
    return { avgPct: avg, medianPct: median, ranked: ranked.length, total: (profiles ?? []).length, counts };
  }

  // The clan's best maps, from the looked-up members' per-map rows (wins
  // against expected wins, the same scoring as a player's map rank). A map
  // needs minGames between them.
  function clanMaps(infos, { minGames = 10, limit = 5 } = {}) {
    const by = new Map();
    for (const info of infos ?? []) {
      if (!info?.found) continue;
      for (const row of info.maps ?? []) {
        if (!row?.map) continue;
        const acc = by.get(row.map) ?? { map: row.map, games: 0, wins: 0, expectedWins: 0, players: 0 };
        acc.games += fin(row.games) ? row.games : 0;
        acc.wins += fin(row.wins) ? row.wins : 0;
        acc.expectedWins += fin(row.expectedWins) ? row.expectedWins : 0;
        acc.players++;
        by.set(row.map, acc);
      }
    }
    return [...by.values()]
      .filter((m) => m.games >= minGames && m.expectedWins > 0)
      .map((m) => ({ ...m, ...S().rowRank(m) }))
      .sort((a, b) => b.ratio - a.ratio || b.games - a.games)
      .slice(0, limit);
  }

  // ---- clan vs clan --------------------------------------------------------------------------
  // a / b: { points, rank, rates (clanRates), memberCount, activeMembers, games, avgPct }
  // One row per measure both sides have. frac is each side's bar (0..1): rates
  // as they are, counts against the larger of the two, "lower is better"
  // measures (rank, percentile) inverted so the longer bar is the better one.
  function compareRows(a, b) {
    const rows = [];
    const pctTxt = (v) => `${Math.round(v * 100)}%`;
    const add = (key, label, va, vb, { kind = "count", lowerBetter = false, text = String } = {}) => {
      if (!fin(va) && !fin(vb)) return;
      let fa;
      let fb;
      if (kind === "rate") {
        fa = fin(va) ? va : 0;
        fb = fin(vb) ? vb : 0;
      } else if (lowerBetter) {
        const hi = Math.max(fin(va) ? va : 0, fin(vb) ? vb : 0) || 1;
        // inverted on a shared scale: the smaller value gets the longer bar
        fa = fin(va) ? Math.max(0.04, 1 - (va - 1) / (hi * 1.15)) : 0;
        fb = fin(vb) ? Math.max(0.04, 1 - (vb - 1) / (hi * 1.15)) : 0;
      } else {
        const hi = Math.max(fin(va) ? va : 0, fin(vb) ? vb : 0) || 1;
        fa = fin(va) ? va / hi : 0;
        fb = fin(vb) ? vb / hi : 0;
      }
      const both = fin(va) && fin(vb) && va !== vb;
      const aBetter = both && (lowerBetter ? va < vb : va > vb);
      const bBetter = both && !aBetter;
      rows.push({
        key,
        label,
        a: { value: fin(va) ? va : null, frac: fa, text: fin(va) ? text(va) : "—", better: aBetter },
        b: { value: fin(vb) ? vb : null, frac: fb, text: fin(vb) ? text(vb) : "—", better: bBetter },
      });
    };
    const compact = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 10000 ? `${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
    add("points", "points", a.points, b.points, { text: compact });
    add("rank", "rank", a.rank, b.rank, { lowerBetter: true, text: (v) => `#${v}` });
    add("win", "win rate", a.rates?.all, b.rates?.all, { kind: "rate", text: pctTxt });
    add("team", "team", a.rates?.team, b.rates?.team, { kind: "rate", text: pctTxt });
    add("stacked", "stacked", a.rates?.stacked, b.rates?.stacked, { kind: "rate", text: pctTxt });
    add("recent", "recent", a.rates?.recent, b.rates?.recent, { kind: "rate", text: pctTxt });
    add("members", "members", a.memberCount, b.memberCount, { text: compact });
    add("active", "active", a.rates?.active, b.rates?.active, { kind: "rate", text: pctTxt });
    add("strength", "member rank", a.avgPct, b.avgPct, { lowerBetter: true, text: (v) => `Top ${Math.round(v)}%` });
    add("games", "games", a.games, b.games, { text: compact });
    return rows;
  }

  // Games both clans were in, from what is visible: each clan's 20 recent games
  // on ofstats (with the winner's display name) and the recent games of the
  // members looked up (each with that member's own result). A side counts as
  // having won when one of its visible members won; in a team game that is
  // only as good as the members looked up (a clan split over two teams, with
  // its winners not looked up, reads as a loss for that side):
  //   "a" / "b"  - one side has a winner in it (a member who won, or an FFA
  //                winner carrying the tag) and the other does not;
  //   "allies"   - both sides have a winner: same winning team;
  //   "neither"  - nobody on either side won;
  //   "unknown"  - a side's result is not visible at all.
  // players: [{ name, recentGames: [{ id, won, map, mode, date }] }]
  function headToHead({ tagA, tagB, clanGamesA = [], clanGamesB = [], playersA = [], playersB = [] }) {
    const A = normTag(tagA);
    const B = normTag(tagB);
    const games = new Map();
    const entry = (id) => {
      let e = games.get(id);
      if (!e) {
        e = { id, map: null, mode: null, date: null, a: new Set(), b: new Set(), aWon: false, bWon: false, winner: null, inA: false, inB: false };
        games.set(id, e);
      }
      return e;
    };
    const fromClan = (list, side) => {
      for (const g of list ?? []) {
        if (!g?.id) continue;
        const e = entry(g.id);
        e[side === "a" ? "inA" : "inB"] = true;
        e.map ??= g.map ?? null;
        e.mode ??= g.mode ?? null;
        e.date ??= g.end ?? null;
        if (g.winner) {
          e.winner = g.winner;
          const wt = splitName(g.winner).tag;
          if (wt && wt === A) e.aWon = true;
          if (wt && wt === B) e.bWon = true;
        }
      }
    };
    const fromPlayers = (list, side) => {
      for (const p of list ?? []) {
        for (const g of p?.recentGames ?? []) {
          if (!g?.id) continue;
          const e = entry(g.id);
          e[side === "a" ? "inA" : "inB"] = true;
          e[side].add(p.name);
          if (g.won === true) e[side === "a" ? "aWon" : "bWon"] = true;
          e.map ??= g.map ?? null;
          e.mode ??= g.mode ?? null;
          e.date ??= g.date ?? null;
        }
      }
    };
    fromClan(clanGamesA, "a");
    fromClan(clanGamesB, "b");
    fromPlayers(playersA, "a");
    fromPlayers(playersB, "b");
    // A side's result is known when one of its members' own records has the
    // game, or in a free-for-all once anyone's win is known (one winner).
    const outcomeOf = (e) => {
      const ffa = modeKey(e.mode) === "ffa" && (e.winner != null || e.aWon || e.bWon);
      const aKnown = e.a.size > 0 || ffa;
      const bKnown = e.b.size > 0 || ffa;
      if (e.aWon && e.bWon) return "allies";
      if (e.aWon) return bKnown ? "a" : "unknown";
      if (e.bWon) return aKnown ? "b" : "unknown";
      return aKnown && bKnown ? "neither" : "unknown";
    };
    const shared = [...games.values()]
      .filter((e) => e.inA && e.inB)
      .map((e) => ({
        id: e.id,
        map: e.map,
        mode: e.mode,
        date: e.date,
        playersA: [...e.a],
        playersB: [...e.b],
        winner: e.winner,
        outcome: outcomeOf(e),
      }))
      .sort((x, y) => (y.date ?? 0) - (x.date ?? 0));
    const count = (o) => shared.filter((g) => g.outcome === o).length;
    return { games: shared, a: count("a"), b: count("b"), allies: count("allies"), neither: count("neither"), unknown: count("unknown") };
  }

  // ---- recruits: a small local index of untagged, ranked players -------------------------------
  // background.js keeps it in chrome.storage.local under RECRUIT_KEY, written
  // when a lookup of such a player comes back (lobbies, games, recaps, the
  // dashboard's search and compare boxes: whatever asked). One slim record per
  // player, no game list: at most RECRUIT_CAP players, the most recently looked
  // up first, and none looked up more than RECRUIT_MAX_AGE ago.
  const RECRUIT_KEY = "recruitIndex";
  const RECRUIT_CAP = 500;
  const RECRUIT_MAX_AGE = 60 * DAY;

  // A lookup (background.js fetchStats) as a record, or null for anyone who can
  // never be a recruit (tagged, guest handle, no percentile).
  function recruitRecord(info, at = Date.now()) {
    if (!info?.found || typeof info.username !== "string") return null;
    const name = info.username;
    if (!name || name.length > 64 || isTagged(name) || isGuest(name)) return null;
    const r = S().ranked(info);
    if (!r) return null;
    const num = (v) => (fin(v) && v >= 0 ? v : 0);
    return {
      name,
      pct: Math.round(r.pct * 100) / 100,
      games: num(info.games),
      wins: num(info.wins),
      lastSeen: typeof info.lastSeen === "string" || fin(info.lastSeen) ? info.lastSeen : null,
      modes: (Array.isArray(info.modes) ? info.modes : []).slice(0, 8).map((m) => ({ mode: String(m?.mode ?? "").slice(0, 40), games: num(m?.games), wins: num(m?.wins) })),
      at,
    };
  }
  // The stored list with new records merged in: one per name (the newer wins),
  // nothing older than maxAge, the cap most recently looked up.
  function mergeRecruits(list, add = [], { now = Date.now(), cap = RECRUIT_CAP, maxAge = RECRUIT_MAX_AGE } = {}) {
    const by = new Map();
    for (const r of [...(Array.isArray(list) ? list : []), ...(Array.isArray(add) ? add : [])]) {
      if (!r || typeof r.name !== "string" || !r.name || !fin(r.at) || now - r.at > maxAge) continue;
      const k = lower(r.name);
      const had = by.get(k);
      if (!had || r.at >= had.at) by.set(k, r);
    }
    return [...by.values()].sort((a, b) => b.at - a.at).slice(0, cap);
  }
  // A record as the hub draws it (the same shape as profile(), without games).
  function recruitProfile(rec, now = Date.now()) {
    if (!rec || typeof rec.name !== "string" || !fin(rec.pct)) return null;
    const modes = { ffa: { games: 0, wins: 0 }, team: { games: 0, wins: 0 }, ranked: { games: 0, wins: 0 }, other: { games: 0, wins: 0 } };
    for (const m of Array.isArray(rec.modes) ? rec.modes : []) {
      const k = modeKey(m?.mode);
      modes[k].games += fin(m?.games) ? m.games : 0;
      modes[k].wins += fin(m?.wins) ? m.wins : 0;
    }
    const games = fin(rec.games) ? rec.games : 0;
    const wins = fin(rec.wins) ? rec.wins : 0;
    return {
      username: rec.name,
      pct: rec.pct,
      band: S().percentBand(rec.pct),
      ratio: null,
      games,
      wins,
      winRate: rate(wins, games),
      expectedRate: null,
      lastSeenDays: ago(rec.lastSeen, now),
      modes,
      recent: [],
      streak: 0,
    };
  }

  // index: the stored { players: [record] } (or the array itself).
  // filters: { maxPct (null = any), activeDays (null = any), mode ("any" | "ffa" | "team" | "ranked"),
  //            sort ("rank" | "recent" | "games"), self (your ofstats name), now }
  function recruits(index, { maxPct = null, activeDays = null, mode = "any", sort = "rank", self = null, now = Date.now(), minGames = 10 } = {}) {
    const pool = [];
    const seen = new Set();
    for (const rec of Array.isArray(index) ? index : Array.isArray(index?.players) ? index.players : []) {
      const name = rec?.name;
      if (typeof name !== "string" || isTagged(name) || isGuest(name) || isSelf(name, self) || seen.has(lower(name))) continue;
      const p = recruitProfile(rec, now);
      if (!p || p.games < minGames) continue;
      seen.add(lower(name));
      pool.push(p);
    }
    const plays = (p, k) => {
      const g = p.modes[k]?.games ?? 0;
      return g >= 3 && g >= 0.2 * p.games;
    };
    const list = pool.filter(
      (p) =>
        (maxPct == null || p.pct <= maxPct) &&
        (activeDays == null || (p.lastSeenDays != null && p.lastSeenDays <= activeDays)) &&
        (mode === "any" || plays(p, mode)),
    );
    const bySort = {
      rank: (a, b) => a.pct - b.pct || b.games - a.games,
      recent: (a, b) => (a.lastSeenDays ?? 1e9) - (b.lastSeenDays ?? 1e9) || a.pct - b.pct,
      games: (a, b) => b.games - a.games || a.pct - b.pct,
    };
    list.sort(bySort[sort] ?? bySort.rank);
    return { list, pool: pool.length };
  }

  // square-root scale for a bar of points: the top clan often has ten times
  // the next, which on a linear bar leaves everyone else a sliver
  function sqrtFrac(v, max) {
    if (!fin(v) || !fin(max) || max <= 0 || v <= 0) return 0;
    return Math.min(1, Math.sqrt(v / max));
  }

  globalThis.OFR_CLAN_LOGIC = {
    normTag,
    splitName,
    bareName,
    isTagged,
    isGuest,
    isSelf,
    sameName,
    isoWeek,
    weekStart,
    shiftWeek,
    weekNumber,
    validWeek,
    MASK,
    displayName,
    nameHidden,
    movers,
    rate,
    clanRates,
    activityOf,
    memberActivity,
    modeKey,
    profile,
    memberStrength,
    clanMaps,
    compareRows,
    headToHead,
    RECRUIT_KEY,
    RECRUIT_CAP,
    RECRUIT_MAX_AGE,
    recruitRecord,
    mergeRecruits,
    recruitProfile,
    recruits,
    sqrtFrac,
  };
})();
