// Tournament helper: the pure half (no DOM, no chrome.*), so node can run it
// (tools/test-tournament.mjs) over real game records. src/tournament.js is the page.
//
// A tournament lives only in this browser (chrome.storage.local, one key per
// tournament "tournament:<id>" plus an order index "tournamentIdx"), in an
// exported .json file, or in a share code (a URL fragment "#t=..."). There is no
// server: every result is recomputed from OpenFront's public game records, which
// the worker fetches ({type: "gameRecord"}) and the page caches (finished games
// never change).
//
// What a record can say (see background.js normaliseRecord and the recap notes):
//   - winners are flagged; a nation can win, and then no human did;
//   - no elimination tick = still had land at the end; newer records carry
//     finalTiles, which orders those survivors, older ones leave them tied;
//   - a player without stats never spawned;
//   - teamIndex (the team slot) only in matchmade team games, where OpenFront's
//     server stamps it; private lobbies - where tournaments are played - have
//     none, so teams there are told apart by clan tags or listed members.
// Places here are among the TOURNAMENT's participants in that game, not the whole
// lobby, so a stranger or a bot in the lobby never shifts anyone's points.
(() => {
  if (globalThis.OFR_TOURNEY) return;

  // OpenFront's own GAME_ID_REGEX (src/core/Schemas.ts)
  const GAME_ID = /^[A-Za-z0-9]{8,10}$/;
  const CLIENT_ID = /^[A-Za-z0-9]{1,16}$/;
  const PID = /^p[0-9a-z]{1,10}$/;
  const TID = /^[0-9a-z]{6,16}$/;
  // older builds pinned games / set results by bracket position (r1m1, series)
  const MATCH_ID = /^(?:r\d{1,2}m\d{1,3}|series)$/;
  const TAG_RE = /^[\p{L}\p{N}_.-]+$/u;
  const LIMITS = {
    name: 60, // tournament name
    pname: 40, // participant / player name
    tag: 10,
    tags: 8,
    members: 24,
    participants: 64,
    games: 200,
    assign: 128, // explicit player assignments per game
    place: 32, // placement points table
    tournaments: 30,
    shareChars: 6000, // the URL fragment after "#t="
    shareInflated: 256 * 1024, // decompressed share payload
    fileBytes: 512 * 1024, // imported .json file
  };
  const FORMATS = ["league", "bracket", "series"];
  const UNITS = ["player", "team"];
  const BEST_OF = [1, 3, 5, 7, 9];
  // Colour slots (tournament.css .tn-c0 ... .tn-c12): 0-5 follow the theme's
  // tokens, 6-12 are OpenFront's team colours (Red, Blue, Yellow, Green, Purple,
  // Orange, Teal), fixed because there the colour IS the team's name.
  const COLORS = 13;
  const CACHE_CAPS = { count: 250, bytes: 3_000_000 }; // record cache; more than LIMITS.games
  const AUTO_FETCH = 20; // more records than this to fetch at once wait for a click
  const PRESETS = {
    ffa: { label: "FFA points", win: 0, place: [10, 7, 5, 4, 3, 2, 1], conquest: 1 },
    wins: { label: "Team wins only", win: 1, place: [], conquest: 0 },
  };

  // ---- small helpers ---------------------------------------------------------------
  const lc = (s) => String(s ?? "").toLowerCase();
  const round1 = (n) => Math.round(n * 10) / 10;
  const newId = (prefix, n = 8) => {
    const bytes = new Uint8Array(n);
    globalThis.crypto.getRandomValues(bytes);
    return prefix + [...bytes].map((b) => "0123456789abcdefghijklmnopqrstuvwxyz"[b % 36]).join("");
  };
  // Control characters and bidi overrides are refused outright (names are shown as
  // text anyway; this keeps a hostile file from reordering what is on screen).
  const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/;

  // What the page's inputs (and names taken from records) go through, so nothing
  // saved can later fail the check above.
  const BAD_CHARS_ALL = new RegExp(BAD_CHARS.source, "g");
  const clean = (s) => String(s ?? "").replace(BAD_CHARS_ALL, "");
  // names compare case-insensitively and without those characters
  const nameKey = (s) => lc(clean(s)).trim();
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  // ---- game ids and links ---------------------------------------------------------------
  // Accepts bare ids, https://openfront.io/game/<id>, .../#join=<id>, /join/<id>,
  // ?gameId=<id>, a worker path (/w0/game/<id>) and ofstats.io/game/<id>.
  // Anything else is reported back, never guessed at.
  // A bare word must also look generated, so a pasted chat line ("Wellplayed",
  // "everyone") adds nothing: a digit, or a capital after the first letter next to
  // small letters (OpenFront's ids mix cases: 5S99ULQP, ddNXyXafFo).
  const looksGenerated = (t) => /\d/.test(t) || (/[a-z]/.test(t) && /[A-Z]/.test(t.slice(1)));
  function idFromToken(raw) {
    let t = String(raw).trim().replace(/^[<("'`]+|[>)"'`.,;!?]+$/g, "");
    if (!t) return null;
    if (GAME_ID.test(t)) return looksGenerated(t) ? t : null;
    const frag = /^#?(?:join|game)=([A-Za-z0-9]{8,10})$/.exec(t);
    if (frag) return frag[1];
    if (!/^https?:\/\//i.test(t)) {
      if (!/^(?:[\w-]+\.)*(?:openfront\.io|ofstats\.io)(?:[/?#]|$)/i.test(t)) return null;
      t = `https://${t}`;
    }
    let u;
    try {
      u = new URL(t);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase();
    const okHost = host === "openfront.io" || host.endsWith(".openfront.io") || host === "ofstats.io" || host.endsWith(".ofstats.io");
    if (!okHost || !/^https?:$/.test(u.protocol)) return null;
    const hash = u.hash.replace(/^#\/?/, "");
    const candidates = [];
    for (const part of hash.split(/[&?]/)) {
      const m = /^(?:join|game|gameId)=(.+)$/.exec(part);
      if (m) candidates.push(decodeURIComponent(m[1])); // may throw URIError: parseGameRefs reports the token
    }
    const hashPath = hash.split("/");
    for (let i = 0; i < hashPath.length - 1; i++) if (/^(?:game|join)$/i.test(hashPath[i])) candidates.push(hashPath[i + 1]);
    for (const key of ["gameId", "game", "join"]) {
      const v = u.searchParams.get(key);
      if (v) candidates.push(v);
    }
    const segs = u.pathname.split("/").filter(Boolean);
    for (let i = 0; i < segs.length - 1; i++) if (/^(?:game|join|games)$/i.test(segs[i])) candidates.push(segs[i + 1]);
    return candidates.find((c) => GAME_ID.test(c)) ?? null;
  }
  function parseGameRefs(text, max = 50) {
    const ids = [];
    const bad = [];
    for (const token of String(text ?? "").split(/[\s,;]+/)) {
      if (!token) continue;
      let id = null;
      try {
        id = idFromToken(token);
      } catch {
        id = null; // a malformed link (e.g. "%E0"): reported, the rest still added
      }
      if (id && !ids.includes(id)) ids.push(id);
      else if (!id) bad.push(token.slice(0, 60));
      if (ids.length >= max) break;
    }
    return { ids, bad };
  }

  // ---- records ---------------------------------------------------------------------------
  // What the tournament keeps of a normalised record (and caches): who played, who
  // won, when each fell, final land and players conquered. Never the full stats.
  function slimRecord(rec) {
    if (!rec || typeof rec !== "object" || !Array.isArray(rec.players)) return null;
    const hasKills = rec.hasKills === true;
    const w = rec.winner ?? {};
    return {
      gameId: String(rec.gameId ?? ""),
      map: typeof rec.map === "string" ? rec.map.slice(0, 60) : null,
      mode: typeof rec.mode === "string" ? rec.mode.slice(0, 30) : null,
      teams: typeof rec.teams === "number" || typeof rec.teams === "string" ? String(rec.teams).slice(0, 20) : null,
      duration: Number.isFinite(rec.duration) ? rec.duration : null,
      start: Number.isFinite(rec.start) ? rec.start : null,
      end: Number.isFinite(rec.end) ? rec.end : null,
      winner: { type: ["player", "team", "nation"].includes(w.type) ? w.type : null, name: typeof w.name === "string" ? w.name.slice(0, 40) : null },
      players: rec.players.slice(0, 400).map((p) => {
        const distinct = new Set((p.kills ?? []).map((k) => k.victim).filter(Boolean)).size;
        return {
          username: String(p.username ?? "").slice(0, 40),
          clanTag: typeof p.clanTag === "string" && p.clanTag ? p.clanTag.slice(0, 10) : null,
          clientID: typeof p.clientID === "string" ? p.clientID.slice(0, 16) : null,
          active: p.active === true,
          killedAt: Number.isFinite(p.killedAt) ? p.killedAt : null,
          finalTiles: Number.isFinite(p.finalTiles) ? p.finalTiles : null,
          winner: p.winner === true,
          conquests: hasKills && distinct > 0 ? distinct : Number(p.stats?.conquests?.humans ?? p.conquests ?? 0) || 0,
          teamIndex: Number.isInteger(p.teamIndex) ? p.teamIndex : null,
        };
      }),
    };
  }
  // A cached slim record, read back from storage: same shape or nothing.
  function checkSlim(r) {
    if (!r || typeof r !== "object" || typeof r.gameId !== "string" || !GAME_ID.test(r.gameId) || !Array.isArray(r.players) || r.players.length > 400) return null;
    for (const p of r.players) {
      if (!p || typeof p.username !== "string" || p.username.length > 40) return null;
      if (p.clanTag != null && (typeof p.clanTag !== "string" || p.clanTag.length > 10)) return null;
      if (p.killedAt != null && !Number.isFinite(p.killedAt)) return null;
      if (p.finalTiles != null && !Number.isFinite(p.finalTiles)) return null;
      if (!Number.isFinite(p.conquests)) return null;
    }
    return r;
  }

  // Team names by slot, as OpenFront assigns them: two teams are Red and Blue, up to
  // seven take this colour order, more are "Team N". Only trusted when the record's
  // winning team sits at the slot this list predicts; otherwise "Team <slot+1>".
  const TEAM_COLOURS = ["Red", "Blue", "Yellow", "Green", "Purple", "Orange", "Teal"];
  // each team colour its own slot (6..12, see COLORS)
  const COLOUR_SLOT = Object.fromEntries(TEAM_COLOURS.map((name, i) => [name, 6 + i]));
  function teamNames(rec) {
    const slots = [...new Set(rec.players.map((p) => p.teamIndex).filter((i) => i != null))].sort((a, b) => a - b);
    if (!slots.length) return null;
    const n = Math.max(Number(rec.teams) || 0, slots.at(-1) + 1);
    const guess = (i) => (n === 2 ? ["Red", "Blue"][i] : n <= 7 ? TEAM_COLOURS[i] : `Team ${i + 1}`);
    const winSlot = rec.players.find((p) => p.winner && p.teamIndex != null)?.teamIndex;
    const trusted = rec.winner?.type === "team" && winSlot != null && guess(winSlot) === rec.winner.name;
    return new Map(slots.map((i) => [i, trusted ? guess(i) : `Team ${i + 1}`]));
  }

  // Participants suggested from one record. unit "player": each player who played;
  // unit "team": team slots (matchmade team games only: private lobbies have no
  // teamIndex), else clan tags.
  function suggestParticipants(rec, unit) {
    if (!rec) return [];
    const played = rec.players.filter((p) => p.active);
    const order = placeOrder(played);
    if (unit === "player") {
      return order.slice(0, LIMITS.participants).map((p, i) => ({
        name: p.username,
        tags: p.clanTag ? [p.clanTag] : [],
        members: [],
        color: i % COLORS,
      }));
    }
    const names = teamNames(rec);
    const out = [];
    if (names) {
      for (const [slot, teamName] of names) {
        const members = played.filter((p) => p.teamIndex === slot);
        if (!members.length) continue;
        const tagCount = new Map();
        for (const m of members) if (m.clanTag) tagCount.set(m.clanTag.toUpperCase(), (tagCount.get(m.clanTag.toUpperCase()) ?? 0) + 1);
        const [topTag, topN] = [...tagCount].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
        const clan = topTag && topN * 2 >= members.length ? topTag : null;
        out.push({
          name: clan ?? teamName,
          tags: clan ? [clan] : [],
          members: members.slice(0, LIMITS.members).map((m) => m.username),
          color: COLOUR_SLOT[teamName] ?? out.length % COLORS,
          won: members.some((m) => m.winner),
        });
      }
      out.sort((a, b) => b.won - a.won);
      return out.slice(0, LIMITS.participants).map(({ won, ...p }) => p);
    }
    const byTag = new Map();
    for (const p of order) {
      if (!p.clanTag) continue;
      const key = p.clanTag.toUpperCase();
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key).push(p);
    }
    let i = 0;
    // biggest clans first; equal sizes keep the finishing order of their best player
    const clans = [...byTag].sort((a, b) => b[1].length - a[1].length);
    for (const [tag] of clans) out.push({ name: tag, tags: [tag], members: [], color: i++ % COLORS });
    // an old team record without clan tags still names its winning team
    if (!out.length && rec.winner?.type === "team") {
      const winners = played.filter((p) => p.winner);
      if (winners.length) out.push({ name: `Team ${rec.winner.name}`.replace(/^Team Team /, "Team "), tags: [], members: winners.slice(0, LIMITS.members).map((m) => m.username), color: COLOUR_SLOT[rec.winner.name] ?? 0 });
    }
    return out.slice(0, LIMITS.participants);
  }

  // ---- who is who -----------------------------------------------------------------------------
  // Maps a record's players to participants. Order: the organiser's explicit choice
  // for this game (by the player's per-game client id; "" = not in the tournament),
  // then names (case-insensitive; a player participant's tag only breaks ties
  // between namesakes), then clan tags for team participants. A player two
  // participants could claim is left for the organiser - counted before anyone
  // gets them, so "Bob" and "bob" never silently go to the first in the list.
  //
  // indexParticipants builds the lookups once per tournament (standings() shares
  // one across all games): name/member -> participants, tag -> participants.
  function indexParticipants(t) {
    const byName = new Map(); // unit "player": name and listed alternative names
    const byMember = new Map(); // unit "team": listed members
    const byTag = new Map();
    const tagsOf = new Map();
    const add = (map, key, pid) => {
      if (!key) return;
      const list = map.get(key);
      if (!list) map.set(key, [pid]);
      else if (!list.includes(pid)) list.push(pid);
    };
    for (const p of t.participants) {
      if (t.unit === "player") {
        add(byName, nameKey(p.name), p.id);
        for (const m of p.members) add(byName, nameKey(m), p.id);
      } else for (const m of p.members) add(byMember, nameKey(m), p.id);
      for (const tg of p.tags) add(byTag, nameKey(tg), p.id);
      tagsOf.set(p.id, new Set(p.tags.map(nameKey)));
    }
    return { t, byName, byMember, byTag, tagsOf };
  }
  const NONE = [];
  function matchPlayers(t, rec, game, ixIn) {
    const ix = ixIn && ixIn.t === t ? ixIn : indexParticipants(t);
    const byPid = new Map(t.participants.map((p) => [p.id, []]));
    const unmatched = [];
    const assign = game?.assign ?? {};
    const players = rec.players;
    const taken = new Set();
    const ambiguous = new Set();
    const put = (pid, p) => {
      byPid.get(pid).push(p);
      taken.add(p);
    };
    for (const p of players) {
      const a = p.clientID && Object.prototype.hasOwnProperty.call(assign, p.clientID) ? assign[p.clientID] : undefined;
      if (a === "") taken.add(p);
      else if (a && byPid.has(a)) put(a, p);
    }
    if (t.unit === "player") {
      // who could each player be? (participants the organiser already assigned
      // someone to in this game are out)
      const claims = new Map();
      for (const p of players) {
        if (taken.has(p)) continue;
        let cl = (ix.byName.get(nameKey(p.username)) ?? NONE).filter((pid) => !byPid.get(pid).length);
        if (cl.length > 1 && p.clanTag) {
          const tag = nameKey(p.clanTag);
          const narrowed = cl.filter((pid) => ix.tagsOf.get(pid).has(tag));
          if (narrowed.length === 1) cl = narrowed;
        }
        if (cl.length > 1) ambiguous.add(p);
        else if (cl.length === 1) {
          if (!claims.has(cl[0])) claims.set(cl[0], []);
          claims.get(cl[0]).push(p);
        }
      }
      for (const [pid, found] of claims) {
        let hits = found;
        const tags = ix.tagsOf.get(pid);
        if (hits.length > 1 && tags.size) {
          const narrowed = hits.filter((p) => tags.has(nameKey(p.clanTag)));
          if (narrowed.length) hits = narrowed;
        }
        if (hits.length > 1) {
          // prefer the one who actually played
          const act = hits.filter((p) => p.active);
          if (act.length === 1) hits = act;
        }
        if (hits.length === 1) put(pid, hits[0]);
        else for (const h of hits) ambiguous.add(h);
      }
    } else {
      for (const p of players) {
        if (taken.has(p)) continue;
        const byMember = ix.byMember.get(nameKey(p.username)) ?? NONE;
        const byTag = p.clanTag ? (ix.byTag.get(nameKey(p.clanTag)) ?? NONE) : NONE;
        const claim = byMember.length ? byMember : byTag;
        if (claim.length === 1) put(claim[0], p);
        else if (claim.length > 1) ambiguous.add(p);
      }
    }
    for (const p of players) {
      if (taken.has(p)) continue;
      const amb = ambiguous.has(p);
      if (!p.active && !amb) continue; // never spawned and nobody claims them
      unmatched.push({ key: p.clientID, username: p.username, clanTag: p.clanTag, active: p.active, ambiguous: amb });
    }
    return { byPid, unmatched };
  }

  // ---- finishing order -----------------------------------------------------------------------
  // Players (or participant groups) ordered best first: winners, those still on the
  // map (by final land when every one of them has it), then by elimination, latest
  // first. `tier`/`key` let callers find ties.
  function finishKey(g) {
    // never spawned comes first: a player on the winning team who never spawned
    // did not win anything
    if (g.dns) return { tier: 3, key: 0 };
    if (g.won) return { tier: 0, key: 0 };
    if (g.alive) return { tier: 1, key: g.tiles };
    return { tier: 2, key: g.lastTick };
  }
  function placeOrder(players) {
    const groups = players.map((p) => ({ p, won: p.winner, alive: p.killedAt == null, dns: !p.active, tiles: p.finalTiles, lastTick: p.killedAt ?? 0 }));
    const exactTiles = groups.filter((g) => !g.won && g.alive && !g.dns).every((g) => g.tiles != null);
    groups.sort((a, b) => compareFinish(a, b, exactTiles));
    return groups.map((g) => g.p);
  }
  function compareFinish(a, b, exactTiles) {
    const ka = finishKey(a);
    const kb = finishKey(b);
    if (ka.tier !== kb.tier) return ka.tier - kb.tier;
    if (ka.tier === 1) return exactTiles ? (kb.key ?? 0) - (ka.key ?? 0) : 0;
    if (ka.tier === 2) return kb.key - ka.key;
    return 0;
  }

  // Places of the participants present in one game: standard competition ranking
  // (1, 2, 2, 4) with ties where the record cannot tell two apart.
  function placeParticipants(byPid) {
    const groups = [];
    for (const [pid, players] of byPid) {
      if (!players.length) continue;
      const act = players.filter((p) => p.active);
      const aliveOnes = act.filter((p) => p.killedAt == null);
      groups.push({
        pid,
        won: act.length > 0 && players.some((p) => p.winner),
        dns: act.length === 0,
        alive: aliveOnes.length > 0,
        tiles: aliveOnes.length && aliveOnes.every((p) => p.finalTiles != null) ? aliveOnes.reduce((s, p) => s + p.finalTiles, 0) : null,
        lastTick: act.length ? Math.max(...act.map((p) => p.killedAt ?? 0)) : 0,
        conquests: players.reduce((s, p) => s + (p.conquests || 0), 0),
        players: players.map((p) => ({ username: p.username, clanTag: p.clanTag })),
      });
    }
    const exactTiles = groups.filter((g) => !g.won && g.alive && !g.dns).every((g) => g.tiles != null);
    groups.sort((a, b) => compareFinish(a, b, exactTiles));
    // equal finishes are neighbours after the sort: one pass
    for (let i = 0; i < groups.length; ) {
      let j = i + 1;
      while (j < groups.length && compareFinish(groups[i], groups[j], exactTiles) === 0) j++;
      for (let k = i; k < j; k++) {
        groups[k].place = i + 1;
        groups[k].tied = j - i > 1;
        groups[k].tiedCount = j - i;
      }
      i = j;
    }
    return groups;
  }

  // Points for one place; tied places share the points of the places they span.
  function placePoints(table, place, tiedCount = 1) {
    let sum = 0;
    for (let i = 0; i < tiedCount; i++) sum += Number(table[place - 1 + i] ?? 0);
    return round1(sum / tiedCount);
  }

  function scoreGame(t, rec, game, ix) {
    if (!rec) return { gameId: game?.id ?? null, state: "missing", rows: [], unmatched: [] };
    const { byPid, unmatched } = matchPlayers(t, rec, game, ix);
    const noResult = !rec.players.some((p) => p.active);
    const rows = noResult ? [] : placeParticipants(byPid);
    const sc = t.scoring;
    for (const r of rows) {
      const win = r.won ? sc.win : 0;
      const place = r.dns ? 0 : placePoints(sc.place, r.place, r.tiedCount);
      const conq = round1(sc.conquest * r.conquests);
      r.parts = { win, place, conq };
      r.points = round1(win + place + conq);
    }
    return { gameId: rec.gameId, state: noResult ? "void" : "ok", rec, rows, unmatched, field: rows.length };
  }

  // Games in the order they were played (record start), then as added.
  function orderedGames(t, records) {
    return t.games
      .map((g, i) => ({ g, i, rec: records.get(g.id) ?? null }))
      .sort((a, b) => (a.rec?.start ?? Infinity) - (b.rec?.start ?? Infinity) || a.i - b.i);
  }

  // ---- standings --------------------------------------------------------------------------------
  // Points, then wins, then average place (lower is better), then head-to-head among
  // exactly those still tied (games where both played: who placed better), then name.
  function scoreAll(t, records) {
    const ix = indexParticipants(t);
    return orderedGames(t, records).map(({ g, rec }) => ({ game: g, ...scoreGame(t, rec, g, ix) }));
  }
  // Average places compared exactly (placeSum/placed as a fraction): 2.34 and
  // 2.30 both show as 2.3 but are not a tie. Nobody placed = worst.
  function compareAvg(a, b) {
    if (!a.placed || !b.placed) return (a.placed ? 0 : 1) - (b.placed ? 0 : 1);
    return a.placeSum * b.placed - b.placeSum * a.placed;
  }
  function standings(t, records, scoredIn) {
    const scored = scoredIn ?? scoreAll(t, records);
    const n = t.participants.length;
    const at = new Map(t.participants.map((p, i) => [p.id, i]));
    const rows = t.participants.map((p) => ({ pid: p.id, name: p.name, color: p.color, points: 0, played: 0, wins: 0, conquests: 0, placeSum: 0, placed: 0, places: [] }));
    // head-to-head counts in flat arrays (64 x 64 x 200 games stays cheap)
    const W = new Int32Array(n * n);
    const L = new Int32Array(n * n);
    const D = new Int32Array(n * n);
    for (const s of scored) {
      const inGame = s.state === "ok" ? new Map(s.rows.map((r) => [r.pid, r])) : null;
      for (const row of rows) {
        const r = inGame?.get(row.pid);
        if (!r) {
          row.places.push(null);
          continue;
        }
        row.places.push({ gameId: s.gameId, place: r.place, tied: r.tied, won: r.won, dns: r.dns, points: r.points, parts: r.parts, field: s.field });
        row.points = round1(row.points + r.points);
        row.played++;
        if (r.won) row.wins++;
        row.conquests += r.conquests;
        if (!r.dns) {
          row.placeSum += r.place;
          row.placed++;
        }
      }
      if (!inGame) continue;
      const idx = s.rows.map((r) => at.get(r.pid));
      for (let i = 0; i < s.rows.length; i++) {
        for (let j = 0; j < s.rows.length; j++) {
          if (i === j) continue;
          const cell = idx[i] * n + idx[j];
          const d = s.rows[i].place - s.rows[j].place;
          if (d < 0) W[cell]++;
          else if (d > 0) L[cell]++;
          else D[cell]++;
        }
      }
    }
    const h2h = new Map(t.participants.map((p) => [p.id, new Map()]));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const cell = i * n + j;
        if (W[cell] || L[cell] || D[cell]) h2h.get(t.participants[i].id).set(t.participants[j].id, { w: W[cell], l: L[cell], d: D[cell] });
      }
    }
    const list = rows;
    for (const r of list) r.avgPlace = r.placed ? round1(r.placeSum / r.placed) : null;
    const primary = (a, b) => b.points - a.points || b.wins - a.wins || compareAvg(a, b);
    list.sort(primary);
    // head-to-head inside each group tied on all three
    const out = [];
    for (let i = 0; i < list.length; ) {
      let j = i + 1;
      while (j < list.length && primary(list[i], list[j]) === 0) j++;
      const group = list.slice(i, j);
      if (group.length > 1) {
        for (const r of group) {
          r.h2h = 0;
          for (const o of group) {
            if (o === r) continue;
            const c = h2h.get(r.pid).get(o.pid);
            if (c) r.h2h += c.w - c.l;
          }
        }
        group.sort((a, b) => b.h2h - a.h2h || a.name.localeCompare(b.name));
      }
      out.push(...group);
      i = j;
    }
    // ranks; what separated each row from the one above it (for a small hint)
    out.forEach((r, i) => {
      const prev = out[i - 1];
      if (!prev) {
        r.rank = 1;
        r.tieBreak = null;
        return;
      }
      if (prev.points !== r.points) r.tieBreak = null;
      else if (prev.wins !== r.wins) r.tieBreak = "wins";
      else if (compareAvg(prev, r) !== 0) r.tieBreak = "avg";
      else if ((prev.h2h ?? 0) !== (r.h2h ?? 0)) r.tieBreak = "h2h";
      else r.tieBreak = "tied";
      r.rank = r.tieBreak === "tied" ? prev.rank : i + 1;
    });
    return { rows: out, games: scored, h2h };
  }

  // ---- bracket (single elimination) ------------------------------------------------------------------
  function seedOrder(size) {
    let seeds = [1, 2];
    while (seeds.length < size) {
      const n = seeds.length * 2 + 1;
      seeds = seeds.flatMap((s) => [s, n - s]);
    }
    return seeds.slice(0, size);
  }
  const BYE = "~bye";
  const need = (bestOf) => Math.floor(bestOf / 2) + 1;
  // Who won a game between two sides: the better placed, if both played it.
  function gameWinner(s, a, b) {
    if (s.state !== "ok") return undefined;
    const ra = s.rows.find((r) => r.pid === a);
    const rb = s.rows.find((r) => r.pid === b);
    if (!ra || !rb) return undefined;
    if (ra.place < rb.place) return a;
    if (rb.place < ra.place) return b;
    return null; // a draw: counts for nobody
  }

  const bracketSize = (n) => {
    let size = 2;
    while (size < n) size *= 2;
    return size;
  };
  // The two sides of first-round match i (0-based) by seeding; BYE for an empty seed.
  function firstRoundPair(pids, i) {
    const order = seedOrder(bracketSize(pids.length));
    const sa = order[2 * i];
    const sb = order[2 * i + 1];
    if (sa == null || sb == null) return null;
    return [sa <= pids.length ? pids[sa - 1] : BYE, sb <= pids.length ? pids[sb - 1] : BYE];
  }
  const realSide = (pid) => Boolean(pid) && pid !== BYE;

  // Hand-set results and game pins name the two SIDES ({a, b} participant ids),
  // never a bracket position: reseeding or a growing bracket cannot move them to
  // other players. A result applies only to the match those two actually play;
  // one that fits no match is ignored (staleRefs lists it for the page).
  function overrideFor(t, a, b) {
    if (!realSide(a) || !realSide(b)) return null;
    const k = pairKey(a, b);
    return (t.overrides ?? []).find((o) => pairKey(o.a, o.b) === k && (o.winner === a || o.winner === b)) ?? null;
  }

  // unplaced: [{gameId, why}] - why: "missing" (record not loaded), "void" (no
  // result), "none" (no open match had both of its sides in the game), "pin"
  // (pinned to a match that is not open, or not in the bracket).
  function bracket(t, records, scoredIn) {
    const scored = scoredIn ?? scoreAll(t, records);
    const n = t.participants.length;
    const why = (s) => (s.state === "missing" ? "missing" : "void");
    if (n < 2) return { rounds: [], champion: null, unplaced: scored.map((s) => ({ gameId: s.gameId ?? s.game.id, why: s.state === "ok" ? "none" : why(s) })), size: 0, BYE };
    const size = bracketSize(n);
    const order = seedOrder(size);
    const seedOf = new Map(t.participants.map((p, i) => [p.id, i + 1]));
    const rounds = [];
    for (let r = 0, count = size / 2; count >= 1; r++, count /= 2) {
      rounds.push(Array.from({ length: count }, (_, i) => ({ id: `r${r + 1}m${i + 1}`, round: r, index: i, a: null, b: null, winsA: 0, winsB: 0, draws: 0, games: [], winner: null, by: null })));
    }
    const first = rounds[0];
    first.forEach((m, i) => {
      const sa = order[2 * i];
      const sb = order[2 * i + 1];
      m.a = sa <= n ? t.participants[sa - 1].id : BYE;
      m.b = sb <= n ? t.participants[sb - 1].id : BYE;
    });
    const bo = t.bestOf;
    const settle = () => {
      rounds.forEach((matches, r) => {
        for (const m of matches) {
          if (r > 0) {
            const fa = rounds[r - 1][2 * m.index];
            const fb = rounds[r - 1][2 * m.index + 1];
            const na = fa.winner ?? null;
            const nb = fb.winner ?? null;
            if (na !== m.a || nb !== m.b) {
              // a side changed (an override upstream): start this match over
              m.a = na;
              m.b = nb;
              m.winsA = m.winsB = m.draws = 0;
              m.games = [];
            }
          }
          m.winner = null;
          m.by = null;
          const o = overrideFor(t, m.a, m.b);
          if (o) {
            m.winner = o.winner;
            m.by = "override";
          } else if (m.a === BYE && m.b === BYE) {
            m.winner = BYE;
            m.by = "bye";
          } else if (m.a === BYE && m.b) {
            m.winner = m.b;
            m.by = "bye";
          } else if (m.b === BYE && m.a) {
            m.winner = m.a;
            m.by = "bye";
          } else if (m.a && m.b) {
            if (m.winsA >= need(bo)) m.winner = m.a;
            else if (m.winsB >= need(bo)) m.winner = m.b;
            if (m.winner) m.by = "games";
          }
        }
      });
    };
    const all = rounds.flat();
    const unplaced = [];
    settle();
    for (const s of scored) {
      const id = s.gameId ?? s.game.id;
      if (s.state !== "ok") {
        unplaced.push({ gameId: id, why: why(s) });
        continue;
      }
      const present = new Set(s.rows.map((r) => r.pid));
      const open = all.filter((m) => !m.winner && realSide(m.a) && realSide(m.b) && present.has(m.a) && present.has(m.b));
      let m;
      if (s.game?.match) {
        // pinned: counts there or nowhere (never moved to another match)
        const k = pairKey(s.game.match.a, s.game.match.b);
        m = open.find((x) => pairKey(x.a, x.b) === k);
        if (!m) {
          unplaced.push({ gameId: id, why: "pin" });
          continue;
        }
      } else m = open.sort((x, y) => x.round - y.round || x.index - y.index)[0];
      if (!m) {
        unplaced.push({ gameId: id, why: "none" });
        continue;
      }
      const w = gameWinner(s, m.a, m.b);
      m.games.push({ gameId: id, winner: w ?? null });
      if (w === m.a) m.winsA++;
      else if (w === m.b) m.winsB++;
      else m.draws++;
      settle();
    }
    for (const m of all) {
      m.seedA = seedOf.get(m.a) ?? null;
      m.seedB = seedOf.get(m.b) ?? null;
      m.need = need(bo);
    }
    const final = rounds.at(-1)[0];
    return { rounds, champion: final.winner && final.winner !== BYE ? final.winner : null, unplaced, size, BYE };
  }

  // Hand-set results and pins whose two sides meet in no match of the bracket as
  // it stands (after a reseed, a removed player, a changed result upstream).
  function staleRefs(t, br) {
    if (t.format !== "bracket" || !br?.rounds?.length) return { overrides: [], pins: [] };
    const pairs = new Set(
      br.rounds
        .flat()
        .filter((m) => realSide(m.a) && realSide(m.b))
        .map((m) => pairKey(m.a, m.b)),
    );
    return {
      overrides: (t.overrides ?? []).filter((o) => !pairs.has(pairKey(o.a, o.b))),
      pins: t.games.filter((g) => g.match && !pairs.has(pairKey(g.match.a, g.match.b))).map((g) => g.id),
    };
  }
  // Sets (winner = a side) or clears (winner = null) the result of a vs b.
  function setOverride(t, a, b, winner) {
    const k = pairKey(a, b);
    t.overrides = (t.overrides ?? []).filter((o) => pairKey(o.a, o.b) !== k);
    if (winner === a || winner === b) t.overrides.push({ a, b, winner });
  }

  // ---- series (best of N between two sides) ------------------------------------------------------------
  function series(t, records, scoredIn) {
    const scored = scoredIn ?? scoreAll(t, records);
    const [pa, pb] = t.participants;
    const out = { a: pa?.id ?? null, b: pb?.id ?? null, winsA: 0, winsB: 0, draws: 0, games: [], winner: null, by: null, need: need(t.bestOf), bestOf: t.bestOf };
    if (!pa || !pb) return out;
    for (const s of scored) {
      const w = gameWinner(s, pa.id, pb.id);
      if (w === undefined) continue;
      const extra = out.winsA >= out.need || out.winsB >= out.need;
      out.games.push({ gameId: s.gameId, winner: w, extra });
      if (extra) continue;
      if (w === pa.id) out.winsA++;
      else if (w === pb.id) out.winsB++;
      else out.draws++;
    }
    if (out.winsA >= out.need) out.winner = pa.id;
    else if (out.winsB >= out.need) out.winner = pb.id;
    if (out.winner) out.by = "games";
    const o = overrideFor(t, pa.id, pb.id);
    if (o) {
      out.winner = o.winner;
      out.by = "override";
    }
    return out;
  }

  // One memoised result per (tournament object, version): the page renders on
  // every keystroke and record; recomputing 200 games each time is waste. The
  // caller bumps `version` whenever the tournament or the records change.
  function computer() {
    let lastT = null;
    let lastV = null;
    let last = null;
    return (t, records, version) => {
      if (t === lastT && version === lastV && last) return last;
      const scored = scoreAll(t, records);
      const st = standings(t, records, scored);
      const br = t.format === "bracket" ? bracket(t, records, scored) : null;
      const se = t.format === "series" ? series(t, records, scored) : null;
      lastT = t;
      lastV = version;
      last = { st, br, se };
      return last;
    };
  }

  // ---- new / validate --------------------------------------------------------------------------------------
  function blank(name = "New tournament") {
    const now = Date.now();
    return {
      id: newId("", 10),
      name,
      format: "league",
      unit: "player",
      bestOf: 3,
      scoring: { preset: "ffa", win: PRESETS.ffa.win, place: [...PRESETS.ffa.place], conquest: PRESETS.ffa.conquest },
      participants: [],
      games: [],
      overrides: [],
      created: now,
      updated: now,
    };
  }
  // Names may come from a game record (any characters a player chose): cleaned
  // here so the tournament always passes validateTournament when read back.
  function newParticipant(t, fields = {}) {
    let id;
    do id = newId("p", 6);
    while (t.participants.some((p) => p.id === id));
    const text = (v, max) => clean(v).trim().slice(0, max).trim();
    const name = text(fields.name, LIMITS.pname) || `${t.unit === "team" ? "Team" : "Player"} ${t.participants.length + 1}`;
    const tags = [...new Set((fields.tags ?? []).map((s) => text(s, LIMITS.tag)).filter((s) => s && TAG_RE.test(s)))].slice(0, LIMITS.tags);
    const members = [...new Set((fields.members ?? []).map((s) => text(s, LIMITS.pname)).filter(Boolean))].slice(0, LIMITS.members);
    return { id, name, tags, members, color: Number.isInteger(fields.color) ? Math.abs(fields.color) % COLORS : t.participants.length % COLORS };
  }

  class Invalid extends Error {}
  const fail = (what) => {
    throw new Invalid(what);
  };
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  function str(v, max, what, { empty = false } = {}) {
    if (typeof v !== "string") fail(`${what}: not text`);
    if (v.length > max) fail(`${what}: longer than ${max}`);
    if (BAD_CHARS.test(v)) fail(`${what}: control characters`);
    const s = v.trim();
    if (!empty && !s) fail(`${what}: empty`);
    return s;
  }
  function num(v, lo, hi, what) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) fail(`${what}: not a number in ${lo}..${hi}`);
    return round1(v);
  }
  function arr(v, max, what) {
    if (!Array.isArray(v)) fail(`${what}: not a list`);
    if (v.length > max) fail(`${what}: more than ${max}`);
    return v;
  }
  // Strict: wrong types, over-long text and too many entries are refused, never
  // coerced. The result is a fresh object with known keys only.
  function validateTournament(input, { keepId = true } = {}) {
    try {
      if (!isObj(input)) fail("not an object");
      const t = {};
      t.id = keepId && typeof input.id === "string" && TID.test(input.id) ? input.id : newId("", 10);
      t.name = str(input.name, LIMITS.name, "name");
      if (!FORMATS.includes(input.format)) fail("format");
      t.format = input.format;
      if (!UNITS.includes(input.unit)) fail("unit");
      t.unit = input.unit;
      if (!BEST_OF.includes(input.bestOf)) fail("bestOf");
      t.bestOf = input.bestOf;
      const sc = input.scoring;
      if (!isObj(sc)) fail("scoring");
      t.scoring = {
        preset: sc.preset === "ffa" || sc.preset === "wins" ? sc.preset : "custom",
        win: num(sc.win, -1000, 1000, "points for a win"),
        place: arr(sc.place, LIMITS.place, "placement points").map((v, i) => num(v, -1000, 1000, `placement points #${i + 1}`)),
        conquest: num(sc.conquest, -100, 100, "points per conquest"),
      };
      const ids = new Set();
      t.participants = arr(input.participants, LIMITS.participants, "participants").map((p, i) => {
        const what = `participant #${i + 1}`;
        if (!isObj(p)) fail(what);
        if (typeof p.id !== "string" || !PID.test(p.id) || ids.has(p.id)) fail(`${what}: id`);
        ids.add(p.id);
        return {
          id: p.id,
          name: str(p.name, LIMITS.pname, `${what} name`),
          tags: arr(p.tags, LIMITS.tags, `${what} tags`).map((v) => {
            const s = str(v, LIMITS.tag, `${what} tag`);
            if (!/^[\p{L}\p{N}_.-]+$/u.test(s)) fail(`${what} tag: letters and digits only`);
            return s;
          }),
          members: arr(p.members, LIMITS.members, `${what} members`).map((v) => str(v, LIMITS.pname, `${what} member`)),
          color: Number.isInteger(p.color) && p.color >= 0 && p.color < COLORS ? p.color : fail(`${what}: colour`),
        };
      });
      const pids = t.participants.map((p) => p.id);
      const notes = [];
      let dropped = 0;
      const sides = (o, what) => {
        if (!isObj(o) || typeof o.a !== "string" || typeof o.b !== "string" || !ids.has(o.a) || !ids.has(o.b) || o.a === o.b) fail(what);
        return [o.a, o.b];
      };
      const seen = new Set();
      t.games = arr(input.games, LIMITS.games, "games").map((g, i) => {
        const what = `game #${i + 1}`;
        if (!isObj(g)) fail(what);
        if (typeof g.id !== "string" || !GAME_ID.test(g.id) || seen.has(g.id)) fail(`${what}: id`);
        seen.add(g.id);
        const out = { id: g.id, assign: {} };
        if (g.assign !== undefined) {
          if (!isObj(g.assign)) fail(`${what}: assignments`);
          const keys = Object.keys(g.assign);
          if (keys.length > LIMITS.assign) fail(`${what}: more than ${LIMITS.assign} assignments`);
          for (const k of keys) {
            const v = g.assign[k];
            if (!CLIENT_ID.test(k)) fail(`${what}: player key`);
            if (v !== "" && !(typeof v === "string" && ids.has(v))) fail(`${what}: assignment`);
            out.assign[k] = v;
          }
        }
        if (g.match !== undefined && g.match !== null) {
          if (typeof g.match === "string") {
            // older builds: a bracket position; kept only where the seeding alone says who plays there
            if (!MATCH_ID.test(g.match)) fail(`${what}: match`);
            const pair = legacyPair(g.match, pids);
            if (pair) out.match = { a: pair[0], b: pair[1] };
            else dropped++;
          } else {
            const pair = sides(g.match, `${what}: match`);
            out.match = { a: pair[0], b: pair[1] };
          }
        }
        return out;
      });
      t.overrides = [];
      if (input.overrides !== undefined) {
        const add = (a, b, winner) => {
          if (winner !== a && winner !== b) fail("override: the winner is not one of the two sides");
          if (t.overrides.some((o) => pairKey(o.a, o.b) === pairKey(a, b))) fail("override: two results for one match");
          t.overrides.push({ a, b, winner });
        };
        if (Array.isArray(input.overrides)) {
          arr(input.overrides, 128, "overrides").forEach((o, i) => {
            const [a, b] = sides(o, `override #${i + 1}`);
            add(a, b, o.winner);
          });
        } else if (isObj(input.overrides)) {
          // older builds: {r1m1: pid, series: pid}, by position
          const keys = Object.keys(input.overrides);
          if (keys.length > 128) fail("overrides: too many");
          for (const k of keys) {
            const v = input.overrides[k];
            if (!MATCH_ID.test(k) || typeof v !== "string" || !ids.has(v)) fail("override");
            const pair = legacyPair(k, pids);
            if (pair && (v === pair[0] || v === pair[1])) add(pair[0], pair[1], v);
            else dropped++;
          }
        } else fail("overrides");
      }
      if (dropped) notes.push(`${dropped} hand-set result${dropped === 1 ? "" : "s"} or pin${dropped === 1 ? "" : "s"} from an older version named a bracket position, not players, and could not be kept`);
      const time = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e14 ? Math.round(v) : Date.now());
      t.created = time(input.created);
      t.updated = time(input.updated);
      return { ok: true, value: t, notes };
    } catch (err) {
      if (err instanceof Invalid) return { ok: false, error: err.message };
      return { ok: false, error: "unreadable" };
    }
  }
  // An older build's position key ("r1m3", "series") -> the two participants the
  // seeding alone puts there, or null (later rounds depend on results).
  function legacyPair(key, pids) {
    if (key === "series") return pids.length >= 2 ? [pids[0], pids[1]] : null;
    const m = /^r1m(\d{1,3})$/.exec(key);
    if (!m || pids.length < 2) return null;
    const pair = firstRoundPair(pids, Number(m[1]) - 1);
    return pair && realSide(pair[0]) && realSide(pair[1]) ? pair : null;
  }

  // ---- storage (pure planning; the page does the chrome.storage calls) ----------------------------------------
  // One key per tournament ("tournament:<id>", so a write stays far below the
  // launcher's 1 MB per request and two tabs editing different tournaments never
  // touch each other's data) plus "tournamentIdx", the order. Anything that fails
  // validation is KEPT in storage as it is and listed as damaged - never dropped.
  const TKEY = "tournament:";
  const TINDEX = "tournamentIdx";
  const OLD_KEY = "tournaments"; // before: one list of every tournament

  function parseStored(id, raw) {
    if (!TID.test(id)) return { ok: false, error: "unknown key" };
    const v = validateTournament(raw);
    if (!v.ok) return v;
    v.value.id = id; // the key is the id
    return v;
  }
  // From everything in chrome.storage.local: what to show, what is damaged, and
  // the writes that move the old single list to one key each (idempotent: a key
  // that already exists is never overwritten, so a half-done move just resumes).
  function planLoad(all) {
    const src = isObj(all) ? all : {};
    const migrate = [];
    const have = new Set(Object.keys(src).filter((k) => k.startsWith(TKEY)));
    if (Array.isArray(src[OLD_KEY])) {
      src[OLD_KEY].forEach((raw, i) => {
        const v = validateTournament(raw);
        const rawId = isObj(raw) && typeof raw.id === "string" && TID.test(raw.id) ? raw.id : null;
        // a damaged one goes over unchanged, under a key that cannot collide
        const id = v.ok && rawId ? rawId : `${v.ok ? "mig" : "old"}${String(i).padStart(3, "0")}`;
        if (have.has(TKEY + id) || migrate.some((w) => w.id === id)) return;
        migrate.push({ id, value: v.ok ? { ...v.value, id } : raw });
      });
    }
    const entries = new Map();
    for (const k of have) entries.set(k.slice(TKEY.length), src[k]);
    for (const w of migrate) entries.set(w.id, w.value);
    const list = [];
    const damaged = [];
    const notes = [];
    for (const [id, raw] of entries) {
      const v = parseStored(id, raw);
      if (v.ok) {
        list.push(v.value);
        for (const n of v.notes ?? []) notes.push(`${v.value.name}: ${n}`);
      } else damaged.push({ id, raw, error: v.error });
    }
    const order = Array.isArray(src[TINDEX]) ? src[TINDEX].filter((x) => typeof x === "string") : [];
    const pos = (id) => {
      const i = order.indexOf(id);
      return i < 0 ? Infinity : i;
    };
    list.sort((a, b) => pos(a.id) - pos(b.id) || b.updated - a.updated);
    const index = mergeIndex([...list.map((t) => t.id), ...damaged.map((d) => d.id)], order, []);
    return { list, damaged, notes, migrate, index, removeOld: OLD_KEY in src };
  }
  // The order to store: ours first, then ids another tab added, minus what we deleted.
  function mergeIndex(mine, theirs, deleted) {
    const gone = new Set(deleted);
    const extra = (Array.isArray(theirs) ? theirs : []).filter((x) => typeof x === "string" && x.length <= 40);
    return [...new Set([...mine, ...extra])].filter((id) => !gone.has(id));
  }
  // Last writer per tournament, by its `updated` stamp: what should this tab hold
  // for one id, given its own copy and what storage (another tab) has?
  //   "keep" ours (write it) - "take" theirs - "gone" (deleted elsewhere)
  function mergeOne(mine, stored, { dirty = false } = {}) {
    if (stored === undefined) return mine && dirty ? { act: "keep" } : { act: "gone" };
    const v = validateTournament(stored);
    if (!v.ok) return mine ? { act: "keep" } : { act: "damaged", error: v.error };
    if (!mine) return { act: "take", value: v.value };
    return v.value.updated > mine.updated ? { act: "take", value: v.value } : { act: "keep" };
  }
  // May one more tournament be saved? (damaged ones still take a place)
  const hasRoom = (count) => count < LIMITS.tournaments;

  // ---- files and share links ---------------------------------------------------------------------------------
  const FILE_FORMAT = "openfront-pro-tournament";
  function exportObject(t) {
    const { id, created, updated, ...rest } = t;
    return { format: FILE_FORMAT, version: 1, tournament: { ...rest, created, updated } };
  }
  function importText(text) {
    if (typeof text !== "string") return { ok: false, error: "not text" };
    if (text.length > LIMITS.fileBytes) return { ok: false, error: "file too big" };
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: "not JSON" };
    }
    if (!isObj(data) || data.format !== FILE_FORMAT || data.version !== 1) return { ok: false, error: "not a tournament file" };
    return validateTournament(data.tournament, { keepId: false });
  }

  const b64url = {
    encode(bytes) {
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    decode(s) {
      if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Invalid("bad characters");
      const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    },
  };
  async function pipe(bytes, stream, cap) {
    const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        reader.cancel().catch(() => {});
        throw new Invalid("too big");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
  const canZip = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

  // "#t=" + "z" (deflate-raw) or "j" (plain JSON, when the browser has no
  // CompressionStream) + base64url. Too long for a link -> {ok:false}: export a file.
  async function encodeShare(t, { zip = canZip() } = {}) {
    const json = JSON.stringify(exportObject(t).tournament);
    const raw = new TextEncoder().encode(json);
    const body = zip ? await pipe(raw, new CompressionStream("deflate-raw"), 4 * LIMITS.shareInflated) : raw;
    const payload = (zip ? "z" : "j") + b64url.encode(body);
    if (payload.length > LIMITS.shareChars) return { ok: false, reason: "too-big", length: payload.length, max: LIMITS.shareChars };
    return { ok: true, hash: `#t=${payload}`, length: payload.length, max: LIMITS.shareChars };
  }
  async function decodeShare(hash) {
    try {
      const m = /^#?t=([zj])([A-Za-z0-9_-]+)$/.exec(String(hash ?? ""));
      if (!m) return { ok: false, error: "not a tournament link" };
      if (m[2].length > LIMITS.shareChars) return { ok: false, error: "link too long" };
      let bytes = b64url.decode(m[2]);
      if (m[1] === "z") {
        if (!canZip()) return { ok: false, error: "this browser cannot unpack the link" };
        bytes = await pipe(bytes, new DecompressionStream("deflate-raw"), LIMITS.shareInflated);
      }
      if (bytes.length > LIMITS.shareInflated) return { ok: false, error: "too big" };
      let data;
      try {
        data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return { ok: false, error: "damaged link" };
      }
      return validateTournament(data, { keepId: false });
    } catch (err) {
      return { ok: false, error: err instanceof Invalid ? err.message : "damaged link" };
    }
  }

  // ---- record cache (LRU plan; the page does the storage calls) ----------------------------------------------
  // index: {gameId: [lastUsedMs, bytes]}. Returns the new index and what to drop.
  // `keep`: ids never evicted (the open tournament's games), even over the caps.
  function cachePlan(index, touch, caps = CACHE_CAPS, keep = null) {
    const next = {};
    for (const [k, v] of Object.entries(index ?? {})) {
      if (GAME_ID.test(k) && Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1])) next[k] = [v[0], v[1]];
    }
    for (const [id, bytes, at] of touch) if (GAME_ID.test(id)) next[id] = [at, bytes ?? next[id]?.[1] ?? 0];
    const evict = [];
    const entries = Object.entries(next).sort((a, b) => a[1][0] - b[1][0]); // oldest first
    let count = entries.length;
    let total = entries.reduce((s, [, v]) => s + v[1], 0);
    for (const [id, v] of entries) {
      if (count <= caps.count && total <= caps.bytes) break;
      if (keep?.has(id)) continue;
      evict.push(id);
      delete next[id];
      count--;
      total -= v[1];
    }
    return { index: next, evict };
  }

  // What storage to free when a save runs out of room: every cached record that is
  // not one of the open tournament's games.
  function evictAllBut(index, keep) {
    const evict = Object.keys(index ?? {}).filter((id) => !keep?.has(id));
    const next = {};
    for (const [k, v] of Object.entries(index ?? {})) if (keep?.has(k)) next[k] = v;
    return { index: next, evict };
  }

  // ---- text for Discord --------------------------------------------------------------------------------------------
  // Names are whatever players and organisers typed: no pings (@everyone,
  // <@id>), no markdown (bold, spoilers, quotes, code, masked links).
  const ZWSP = String.fromCharCode(0x200b);
  const discordSafe = (s) =>
    String(s ?? "")
      .replace(/[\\*_~|>`[\]]/g, "\\$&")
      .replace(/@/g, `@${ZWSP}`);
  function resultsText(t, { st, br, se }) {
    const nameOf = (pid) => discordSafe(t.participants.find((p) => p.id === pid)?.name ?? "?");
    const title = discordSafe(t.name);
    const lines = [];
    const played = st.games.filter((g) => g.state === "ok").length;
    if (t.format === "bracket" && br) {
      lines.push(`🏆 ${title} - bracket${br.champion ? ` - champion: ${nameOf(br.champion)}` : ""}`);
      br.rounds.forEach((matches, r) => {
        const label = r === br.rounds.length - 1 ? "Final" : r === br.rounds.length - 2 ? "Semi-finals" : `Round ${r + 1}`;
        const rows = matches.filter((m) => m.a && m.b && m.a !== br.BYE && m.b !== br.BYE);
        if (!rows.length) return;
        lines.push(`${label}:`);
        for (const m of rows) {
          const score = m.by === "override" ? "(set)" : `${m.winsA}-${m.winsB}`;
          lines.push(`  ${m.winner === m.a ? "▶ " : ""}${nameOf(m.a)} ${score} ${nameOf(m.b)}${m.winner === m.b ? " ◀" : ""}`);
        }
      });
    } else if (t.format === "series" && se) {
      lines.push(`🏆 ${title} - best of ${se.bestOf}`);
      lines.push(`${nameOf(se.a)} ${se.winsA} - ${se.winsB} ${nameOf(se.b)}${se.winner ? `  (${nameOf(se.winner)} wins)` : ""}`);
    } else {
      lines.push(`🏆 ${title} - standings after ${played} game${played === 1 ? "" : "s"}`);
    }
    if (t.format !== "series") {
      if (t.format === "bracket") lines.push("Points:");
      for (const r of st.rows.slice(0, 32)) {
        const medal = ["🥇", "🥈", "🥉"][r.rank - 1] ?? `${r.rank}.`;
        lines.push(`${medal} ${discordSafe(r.name)} - ${r.points} pts · ${r.wins} W · ${r.played} played${r.avgPlace != null ? ` · avg #${r.avgPlace}` : ""}`);
      }
    }
    lines.push("(OpenFront Pro - unofficial - from OpenFront's public game records)");
    return lines.join("\n");
  }

  globalThis.OFR_TOURNEY = {
    LIMITS,
    FORMATS,
    UNITS,
    BEST_OF,
    PRESETS,
    COLORS,
    GAME_ID,
    parseGameRefs,
    idFromToken,
    slimRecord,
    checkSlim,
    teamNames,
    suggestParticipants,
    matchPlayers,
    placeParticipants,
    placePoints,
    scoreGame,
    standings,
    seedOrder,
    bracket,
    series,
    blank,
    newParticipant,
    validateTournament,
    exportObject,
    importText,
    encodeShare,
    decodeShare,
    cachePlan,
    evictAllBut,
    resultsText,
    discordSafe,
    b64url,
    TID,
    TKEY,
    TINDEX,
    OLD_KEY,
    CACHE_CAPS,
    AUTO_FETCH,
    BAD_CHARS,
    clean,
    nameKey,
    pairKey,
    indexParticipants,
    finishKey,
    compareAvg,
    staleRefs,
    setOverride,
    overrideFor,
    computer,
    parseStored,
    planLoad,
    mergeIndex,
    mergeOne,
    hasRoom,
  };
})();
