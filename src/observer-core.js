// Observer mode, the pure half: no DOM and no chrome.* here, so node runs it
// (tools/test-observer.mjs). Loaded by the observer page (src/observer.html), the
// worker (background.js, for the route to a game's server), the overlay page and
// the openfront.io content scripts (caster panel). Exposed on
// globalThis.OFR_OBSERVER.
//
//   - links: which game a pasted link or id names (src/tournament-core.js's parser
//     when that file is loaded, as on the observer page);
//   - route: where OpenFront's own public "is this game there" endpoint lives for
//     an id (docs/MultiServer.md of OpenFront v0.34.10: a 10-character id starts
//     with the letter of the server that runs it, and the worker on that server is
//     hash(id) % numWorkers - the same rule the site's JoinLobbyModal uses);
//   - status: what OpenFront's gameInfo says (started, starting, countdown, unknown,
//     nobody playing);
//   - the reminder's polling schedule;
//   - the caster data: every player's standing from page-probe.js ("caster-state"),
//     reduced to a leaderboard, team totals and an eliminations feed.
(() => {
  if (globalThis.OFR_OBSERVER) return;

  // OpenFront's GAME_ID_REGEX (src/core/Schemas.ts)
  const GAME_ID = /^[A-Za-z0-9]{8,10}$/;
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Control characters and the bidi overrides a name could use to turn text around.
  const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g;
  const text = (v, max) => (typeof v === "string" ? v.replace(BAD_CHARS, "").replace(/\s+/g, " ").trim().slice(0, max) : "");
  // Map, mode and team names: plain words only (the overlay's LABEL rule).
  const LABEL = /^[A-Za-z0-9 .'()&-]{1,40}$/;
  const label = (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return LABEL.test(s) ? s : "";
  };

  // ---- links ---------------------------------------------------------------------------
  // https://openfront.io/game/<id>, /w3/game/<id>, #join=<id>, /join/<id>, ?gameId=<id>
  // or the bare id. A pasted line may carry more words: the first token that names a
  // game wins. Without tournament-core.js (worker, tests of this file alone) a
  // smaller parser does the common shapes.
  function fallbackId(token) {
    const t = String(token).trim().replace(/^[<("'`]+|[>)"'`.,;!?]+$/g, "");
    if (GAME_ID.test(t)) return t;
    const m = /(?:^|[/#?&])(?:game|join|gameId)[=/]([A-Za-z0-9]{8,10})(?:$|[/?#&])/.exec(t);
    if (!m) return null;
    if (/^https?:\/\//i.test(t) && !/^https?:\/\/(?:[\w-]+\.)*openfront\.io(?:[/?#:]|$)/i.test(t)) return null;
    return m[1];
  }
  function parseLink(input) {
    const raw = String(input ?? "").trim();
    if (!raw) return { id: null, error: "empty" };
    const T = globalThis.OFR_TOURNEY;
    for (const token of raw.split(/\s+/).slice(0, 20)) {
      let id = null;
      try {
        id = typeof T?.idFromToken === "function" ? T.idFromToken(token) : fallbackId(token);
      } catch {
        id = null; // a malformed link ("%E0"): the next token may still name a game
      }
      if (id && GAME_ID.test(id)) return { id };
    }
    return { id: null, error: "bad" };
  }

  // ---- route -----------------------------------------------------------------------------
  // OpenFront's simpleHash (src/core/Util.ts), bit for bit: 32-bit wrap, then abs.
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
  // Only hosts the extension already has access to (manifest: https://*.openfront.io/*).
  const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+openfront\.io$/;
  // cluster: https://api.openfront.io/cluster.json?site=openfront.io
  //   { servers: { <letter>: { host, numWorkers, version, state } } }
  function gameRoute(id, cluster) {
    if (typeof id !== "string" || !GAME_ID.test(id)) return { kind: "bad" };
    // 8-character ids are from before the multi-server ids (archived games) or a
    // single-player game: no server runs them now.
    if (id.length < 10) return { kind: "legacy" };
    const servers = cluster && typeof cluster === "object" && cluster.servers && typeof cluster.servers === "object" ? cluster.servers : null;
    if (!servers) return { kind: "no-list" };
    const letter = id[0];
    const entry = /^[a-z]$/.test(letter) && Object.hasOwn(servers, letter) ? servers[letter] : null;
    if (!entry || typeof entry !== "object") return { kind: "unknown-letter" };
    const host = typeof entry.host === "string" ? entry.host.toLowerCase() : "";
    const workers = entry.numWorkers;
    if (!HOST.test(host) || !Number.isInteger(workers) || workers < 1 || workers > 4096) return { kind: "unsupported" };
    const base = `https://${host}/w${simpleHash(id) % workers}/api/game/${id}`;
    return { kind: "ok", host, worker: simpleHash(id) % workers, exists: `${base}/exists`, info: base };
  }

  // The address that opens a game in the browser. /game/<id> works for every id: the
  // site re-resolves the server and worker from the id when it joins.
  const watchUrl = (id) => (typeof id === "string" && GAME_ID.test(id) ? `https://openfront.io/game/${id}` : null);

  // ---- status ----------------------------------------------------------------------------
  // res: what the worker's "observerCheck" answered:
  //   { id, route, exists: true|false|null, info: gameInfo|null, ended: bool, error }
  // gameInfo (OpenFront src/server/GameServer.ts gameInfo()): gameID, clients[]
  // ({ username, clanTag, clientID, spectator? }, the CONNECTED clients, anonymised
  // when the lobby hides names), gameConfig ({ gameMap, gameMode, playerTeams,
  // maxPlayers, gameType, ... }), startsAt (set when a start countdown runs - public
  // lobbies, a private lobby once its host starts it, a listed lobby at its
  // auto-start deadline; NOT when a lobby starts because it filled up), serverTime.
  // There is no "started" flag in it.
  //
  // How a game starts (GameManager.ts tick(), once a second, and GameServer.ts):
  // once startsAt has passed (or the lobby reached maxPlayers) the next tick sends
  // "prestart" and calls start() 2 s later - so the real start is ~2-3 s after
  // startsAt; with nobody connected it does not start at all (it waits, or holds
  // the start until someone is back). Until the real start a join is a join to the
  // LOBBY: you are seated as a PLAYER. For LATE_JOIN_MS after it, a join that is not
  // a spectator's is REFUSED ("game-started", the server's LATE_JOIN_GRACE_MS) - it
  // is not seated at all; after that anyone opening the link joins as a spectator.
  // So Watch waits until WATCH_AFTER_MS past the start time: up to 3 s for the real
  // start, the 5 s of refusals, 1 s to spare.
  const LATE_JOIN_MS = 5000;
  const WATCH_AFTER_MS = LATE_JOIN_MS + 4000;
  // memo: what this page learned of the same game in earlier checks -
  //   { fullAt }  the server time it was first seen full (a lobby that fills up
  //               starts at once and gets no startsAt; the server's "reached max
  //               players" never goes back, so the game is started from then on).
  // The answer carries `fullAt` for the caller to keep.
  function gameStatus(res, now = Date.now(), memo = {}) {
    if (!res || typeof res !== "object") return { state: "error" };
    if (res.error === "consent") return { state: "consent" };
    if (res.error === "off") return { state: "off" };
    const id = typeof res.id === "string" && GAME_ID.test(res.id) ? res.id : null;
    const info = res.info && typeof res.info === "object" ? res.info : null;
    if (!info) {
      if (res.ended === true) return { state: "ended", id };
      if (res.route === "legacy") return { state: "legacy", id };
      if (res.exists === false) return { state: "missing", id };
      return { state: "error", id, detail: text(res.error ?? "", 80) };
    }
    const cfg = info.gameConfig && typeof info.gameConfig === "object" ? info.gameConfig : {};
    const clients = Array.isArray(info.clients) ? info.clients.filter((c) => c && typeof c === "object") : [];
    const spectators = clients.filter((c) => c.spectator === true).length;
    const teams = cfg.playerTeams;
    const clock = finite(info.serverTime) && info.serverTime > 0;
    const out = {
      id,
      map: label(cfg.gameMap),
      mode: label(cfg.gameMode),
      teams: finite(teams) ? clamp(Math.round(teams), 0, 1000) : label(teams) || null,
      type: label(cfg.gameType),
      players: clients.length - spectators,
      spectators,
      maxPlayers: finite(cfg.maxPlayers) && cfg.maxPlayers > 0 ? Math.round(cfg.maxPlayers) : null,
      // the server said what time it is: without that nothing is declared started
      clock,
      // how far the local clock is off the server's, so a countdown runs right
      skew: clock ? info.serverTime - (finite(res.fetchedAt) ? res.fetchedAt : now) : 0,
    };
    const serverNow = now + out.skew;
    // past its start time: running, starting, or a start that never came (nobody there)
    const past = (from, extra) => {
      if (!clock) return { ...out, ...extra, state: "unknown", reason: "clock" };
      if (out.players < 1) return { ...out, ...extra, state: "empty" };
      const since = serverNow - from;
      if (since < WATCH_AFTER_MS) return { ...out, ...extra, state: "starting", watchIn: Math.max(1, Math.ceil((WATCH_AFTER_MS - since) / 1000)) };
      return { ...out, ...extra, state: "started", since: extra.filled ? null : Math.floor(since / 1000) };
    };
    if (finite(info.startsAt) && info.startsAt > 0) {
      if (info.startsAt > serverNow) return { ...out, state: "countdown", startsIn: Math.ceil((info.startsAt - serverNow) / 1000) };
      return past(info.startsAt, {});
    }
    // no start time: a full lobby (now, or seen before) started by filling up
    const full = out.maxPlayers != null && out.players >= out.maxPlayers;
    const seen = finite(memo?.fullAt) && memo.fullAt > 0 ? memo.fullAt : null;
    if (seen != null || (full && clock)) {
      const fullAt = seen ?? serverNow;
      return past(fullAt, { filled: true, fullAt });
    }
    // Either still in its lobby (a private one waiting for its host) or started when
    // it filled up before anyone here looked - gameInfo does not say which.
    return { ...out, state: "unknown", reason: clock ? "no-start" : "clock" };
  }
  // Watching by link is safe (a spectator seat) only once the game really runs:
  // started, somebody playing, and the server's clock said so.
  const canWatch = (status) => status?.state === "started" && status.players > 0 && status.clock === true;

  // ---- reminder --------------------------------------------------------------------------
  // "Remind me when it starts": a gentle poll of the same endpoint, every 15 s for
  // up to 30 minutes; during a known countdown, one check just after the watch
  // window. It stops by itself once there is nothing to wait for (started, over,
  // not found, an old id, refused), and after REMIND_UNSURE_TRIES answers in a row
  // that cannot say whether the game started ("unknown": no start time).
  const REMIND_EVERY_MS = 15000;
  const REMIND_FOR_MS = 30 * 60 * 1000;
  const REMIND_UNSURE_TRIES = 8;
  const REMIND_STOP = ["started", "ended", "consent", "off", "missing", "legacy"];
  function remindNext(status, since, now = Date.now(), unsure = 0) {
    if (!status || now - since >= REMIND_FOR_MS) return null; // gave up
    if (REMIND_STOP.includes(status.state)) return null;
    if (status.state === "unknown" && unsure >= REMIND_UNSURE_TRIES) return null;
    let wait = REMIND_EVERY_MS;
    if (status.state === "countdown" && finite(status.startsIn)) wait = clamp(status.startsIn * 1000 + WATCH_AFTER_MS + 500, 3000, REMIND_EVERY_MS);
    if (status.state === "starting" && finite(status.watchIn)) wait = clamp(status.watchIn * 1000 + 500, 1000, REMIND_EVERY_MS);
    return Math.min(wait, Math.max(0, since + REMIND_FOR_MS - now));
  }
  // The observer page's own re-check (no reminder running): when a start it knows of
  // is due - at the end of any countdown (plus the watch window) or of the starting
  // window. null: nothing due.
  function followUpIn(status) {
    if (status?.state === "starting" && finite(status.watchIn)) return status.watchIn * 1000 + 500;
    if (status?.state === "countdown" && finite(status.startsIn)) return Math.max(0, status.startsIn) * 1000 + WATCH_AFTER_MS + 500;
    return null;
  }

  // ---- caster data -------------------------------------------------------------------------
  // page-probe.js "caster-state": { gameId, tick, seconds, spawn, over, replay, mode,
  // teams, map, land, players: [{ sid, name, team, tiles, alive, human, type, rgb }] }.
  // It comes over window.postMessage, which the page can fake: shape and range checks.
  const TYPES = ["HUMAN", "NATION", "BOT"];
  const MAX_PLAYERS = 400;
  function sanitizeCasterMsg(m) {
    if (!m || typeof m !== "object") return null;
    if (typeof m.gameId !== "string" || !/^[A-Za-z0-9]{4,16}$/.test(m.gameId)) return null;
    if (!finite(m.tick) || m.tick < 0 || !Array.isArray(m.players)) return null;
    const land = finite(m.land) && m.land > 0 ? m.land : 0;
    const seen = new Set();
    const players = [];
    for (const p of m.players.slice(0, MAX_PLAYERS)) {
      if (!p || typeof p !== "object" || !Number.isInteger(p.sid) || p.sid < 1 || p.sid > 4095 || seen.has(p.sid)) continue;
      seen.add(p.sid);
      const tiles = finite(p.tiles) && p.tiles > 0 ? Math.round(p.tiles) : 0;
      const type = TYPES.includes(p.type) ? p.type : p.human === true ? "HUMAN" : "BOT";
      players.push({
        sid: p.sid,
        name: text(p.name, 40),
        team: label(p.team) || null,
        tiles,
        share: land ? clamp(tiles / land, 0, 1) : 0,
        alive: p.alive === true,
        human: type === "HUMAN",
        type,
        rgb: Array.isArray(p.rgb) && p.rgb.length >= 3 && p.rgb.slice(0, 3).every(finite) ? p.rgb.slice(0, 3).map((c) => clamp(Math.round(c), 0, 255)) : null,
      });
    }
    return {
      gameId: m.gameId,
      tick: Math.round(m.tick),
      seconds: finite(m.seconds) && m.seconds >= 0 ? Math.min(m.seconds, 172800) : Math.round(m.tick / 10),
      spawn: m.spawn === true,
      over: m.over === true,
      replay: m.replay === true,
      mode: label(m.mode),
      teams: finite(m.teams) ? clamp(Math.round(m.teams), 0, 1000) : label(m.teams) || null,
      map: label(m.map),
      players,
    };
  }

  // One more state into what is known about the game. Eliminations are seen as a
  // player who was alive (with land) last time and is not any more; bots are left
  // out of the feed (hundreds of them fall in a big game). A new game, or a clock
  // that went backwards, starts over. Plain objects only (storage, tests).
  const FEED_KEEP = 60;
  function casterReduce(prev, raw) {
    const m = sanitizeCasterMsg(raw);
    if (!m) return prev ?? null;
    const fresh = !prev || prev.gameId !== m.gameId || m.tick < prev.tick;
    const was = fresh ? {} : prev.alive; // sid -> what we knew while alive
    const outAt = fresh ? {} : { ...prev.outAt };
    const feed = fresh ? [] : [...prev.feed];
    const alive = {};
    const byId = new Map(m.players.map((p) => [p.sid, p]));
    for (const p of m.players) if (p.alive && p.tiles > 0) alive[p.sid] = { name: p.name, team: p.team, type: p.type, rgb: p.rgb };
    for (const [key, info] of Object.entries(was)) {
      const sid = Number(key);
      if (alive[sid]) continue;
      const now = byId.get(sid);
      if (now?.alive && now.tiles > 0) continue;
      outAt[sid] = m.seconds;
      if (info.type !== "BOT") feed.push({ sid, at: m.seconds, name: now?.name || info.name, team: now?.team ?? info.team, human: info.type === "HUMAN", rgb: now?.rgb ?? info.rgb });
    }
    // a player seen out and then back (a replay's catch-up, a faked feed) leaves no trace
    for (const sid of Object.keys(alive)) delete outAt[sid];
    return {
      gameId: m.gameId,
      tick: m.tick,
      seconds: m.seconds,
      spawn: m.spawn,
      over: m.over,
      replay: m.replay,
      mode: m.mode,
      teams: m.teams,
      map: m.map,
      players: m.players,
      alive,
      outAt,
      feed: feed.slice(-FEED_KEEP),
    };
  }

  // What the caster panel and the overlay draw: the leaderboard (alive by land,
  // then the most recent eliminations while there is room), team totals in team
  // games, the feed newest first. masked: player names left out (streamer mode,
  // an overlay page that hides names) - nations keep theirs, they are no one's.
  // pctOf(name): a known world percentile, or null.
  const isTeamGame = (s) => /team/i.test(s?.mode ?? "") || s?.players?.some((p) => p.team && p.team !== "Bot");
  function casterView(state, { limit = 12, feedLimit = 6, masked = false, pctOf = null } = {}) {
    if (!state) return null;
    const nameOf = (p) => (masked && p.type === "HUMAN" ? null : p.name || null);
    const alive = state.players.filter((p) => p.alive && p.tiles > 0);
    const everyone = state.players.filter((p) => p.type !== "BOT" || (p.alive && p.tiles > 0));
    const humans = state.players.filter((p) => p.human);
    const lead = Math.max(0.0001, ...alive.map((p) => p.share));
    const row = (p, place) => {
      const pct = !masked && p.human && typeof pctOf === "function" ? pctOf(p.name) : null;
      return {
        place,
        sid: p.sid,
        name: nameOf(p),
        team: p.team,
        type: p.type,
        share: p.share,
        frac: p.alive ? clamp(p.share / lead, 0.02, 1) : 0,
        alive: p.alive && p.tiles > 0,
        outAt: finite(state.outAt?.[p.sid]) ? state.outAt[p.sid] : null,
        rgb: p.rgb,
        pct: finite(pct) ? pct : null,
      };
    };
    const board = alive.slice(0, limit).map((p, i) => row(p, i + 1));
    const room = limit - board.length;
    if (room > 0) {
      const outs = state.players
        .filter((p) => !(p.alive && p.tiles > 0) && p.type !== "BOT" && finite(state.outAt?.[p.sid]))
        .sort((a, b) => state.outAt[b.sid] - state.outAt[a.sid])
        .slice(0, room);
      for (const p of outs) board.push(row(p, null));
    }
    let teams = [];
    if (isTeamGame(state)) {
      const by = new Map();
      for (const p of everyone) {
        if (!p.team || p.team === "Bot") continue;
        const t = by.get(p.team) ?? { name: p.team, share: 0, alive: 0, total: 0, rgb: null, best: -1 };
        t.share += p.alive ? p.share : 0;
        t.total += 1;
        if (p.alive && p.tiles > 0) t.alive += 1;
        if (p.rgb && p.tiles > t.best) {
          t.rgb = p.rgb;
          t.best = p.tiles;
        }
        by.set(p.team, t);
      }
      teams = [...by.values()].sort((a, b) => b.share - a.share || b.alive - a.alive || a.name.localeCompare(b.name));
      const top = Math.max(0.0001, ...teams.map((t) => t.share));
      teams = teams.slice(0, 12).map(({ best, ...t }, i) => ({ ...t, share: clamp(t.share, 0, 1), place: i + 1, frac: t.share > 0 ? clamp(t.share / top, 0.02, 1) : 0 }));
    }
    const feed = [...state.feed]
      .reverse()
      .slice(0, feedLimit)
      .map((f) => ({ at: f.at, name: masked && f.human ? null : f.name || null, team: f.team, human: f.human, rgb: f.rgb }));
    return {
      gameId: state.gameId,
      seconds: state.seconds,
      phase: state.over ? "ended" : state.spawn ? "spawn" : "watching",
      replay: state.replay,
      map: state.map,
      mode: state.mode,
      teamGame: teams.length > 1,
      playersAlive: alive.length,
      humansAlive: humans.filter((p) => p.alive && p.tiles > 0).length,
      humansTotal: humans.length,
      more: Math.max(0, alive.length - limit),
      board,
      teams,
      feed,
    };
  }

  globalThis.OFR_OBSERVER = {
    GAME_ID,
    LATE_JOIN_MS,
    WATCH_AFTER_MS,
    REMIND_EVERY_MS,
    REMIND_FOR_MS,
    REMIND_UNSURE_TRIES,
    FEED_KEEP,
    parseLink,
    simpleHash,
    gameRoute,
    watchUrl,
    gameStatus,
    canWatch,
    remindNext,
    followUpIn,
    sanitizeCasterMsg,
    casterReduce,
    casterView,
    text,
    label,
  };
})();
