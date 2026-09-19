// Streamer overlay, the pure half: page options, what each card shows, and the
// checks on data that arrives through storage. No DOM and no chrome.* here, so
// tools/test-overlay.mjs runs it in node. src/overlay.html loads it before
// overlay.js; it is exposed on globalThis.OFR_OVERLAY.
//
// Data flow (all of it inside this computer, in chrome.storage.local):
//   overlayEnabled  0 | time of the overlay page's last heartbeat (the page
//                   refreshes it while open and sets 0 when it closes; content.js
//                   publishes only while fresh and clears the keys below after)
//   overlayMask     0 | heartbeat time of a page that hides your name (name=0,
//                   streamer=1): while fresh the recap card is drawn masked
//   overlaySelf     { name }  your ofstats name, from the openfront.io tab
//   overlayLive     the running game (content.js), on change and every ~4 s;
//                   `owner` is the tab that wrote it (one tab at a time)
//   overlayRecap    { gameId, at, png, streamer }  the recap share card, once per
//                   game (streamer: drawn with your name and rank masked)
//   session         today's games (content.js recordSession)
(() => {
  if (globalThis.OFR_OVERLAY) return;

  const WIDGETS = ["rank", "live", "recap"];
  const BGS = ["transparent", "green", "dark"];
  const CORNERS = ["tl", "tr", "bl", "br"];
  const PHASES = ["spawn", "playing", "out", "ended", "watching"];
  const DEFAULTS = Object.freeze({ widgets: WIDGETS, bg: "transparent", scale: 1, pos: "tr", recap: 20, name: true, streamer: false, edit: false, demo: false });

  // The heartbeat: the page writes the time every BEAT_MS; a tab stops publishing
  // once it is older than STALE_MS. Generous, because a hidden window's timers
  // are throttled by the browser (down to once a minute).
  const BEAT_MS = 20000;
  const STALE_MS = 150000;
  // overlayLive is rewritten at least every ~4 s; older than this, its tab is gone.
  const LIVE_STALE_MS = 12000;
  const MAX_PNG = 1_600_000; // characters of the data URL (~1.2 MB of image)
  const GAME_ID = /^[A-Za-z0-9]{4,16}$/;
  // Map and mode names go on the broadcast, and a script in the openfront.io page
  // can fake them: plain names only (content.js applies the same rule).
  const LABEL = /^[A-Za-z0-9 .'()&-]{1,40}$/;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const count = (v, max = 100000) => (finite(v) && v >= 0 ? Math.min(max, Math.round(v)) : null);
  const label = (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return LABEL.test(s) ? s : "";
  };

  // ---- page options (URL query, so an OBS source keeps them; the hash overrides) ----
  //   w=rank,live,recap   which cards, in this order
  //   bg=transparent|green|dark
  //   scale=0.5..3        pos=tl|tr|bl|br
  //   recap=20            seconds the recap card stays (0: until the next game)
  //   name=0              never show your name (streamer mode always hides it)
  //   streamer=1          same as streamer mode, for this page only
  //   edit=1              the settings panel (never part of the OBS address)
  //   demo=1              sample data, to place the overlay without a game
  function parseOptions(search = "", hash = "") {
    const p = new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
    for (const [k, v] of new URLSearchParams(String(hash ?? "").replace(/^#/, ""))) p.set(k, v);
    const o = { ...DEFAULTS, widgets: [...DEFAULTS.widgets] };
    if (p.has("w")) {
      const list = [];
      for (const w of String(p.get("w")).toLowerCase().split(/[\s,+]+/)) if (WIDGETS.includes(w) && !list.includes(w)) list.push(w);
      o.widgets = list;
    }
    if (BGS.includes(p.get("bg"))) o.bg = p.get("bg");
    if (CORNERS.includes(p.get("pos"))) o.pos = p.get("pos");
    const scale = Number(p.get("scale"));
    if (p.has("scale") && finite(scale) && scale > 0) o.scale = Math.round(clamp(scale, 0.5, 3) * 100) / 100;
    const recap = Number(p.get("recap"));
    if (p.has("recap") && p.get("recap") !== "" && finite(recap)) o.recap = clamp(Math.round(recap), 0, 600);
    const flag = (k) => ["1", "true", "yes", "on"].includes(String(p.get(k)).toLowerCase());
    const off = (k) => ["0", "false", "no", "off"].includes(String(p.get(k)).toLowerCase());
    if (p.has("name") && off("name")) o.name = false;
    o.streamer = flag("streamer");
    o.edit = flag("edit");
    o.demo = flag("demo");
    return o;
  }

  // Only what differs from the defaults. An OBS address never carries edit/demo.
  function buildQuery(o, { forObs = false } = {}) {
    const p = new URLSearchParams();
    if (o.widgets.join(",") !== DEFAULTS.widgets.join(",")) p.set("w", o.widgets.join(",") || "none");
    if (o.bg !== DEFAULTS.bg) p.set("bg", o.bg);
    if (o.pos !== DEFAULTS.pos) p.set("pos", o.pos);
    if (o.scale !== DEFAULTS.scale) p.set("scale", String(o.scale));
    if (o.recap !== DEFAULTS.recap) p.set("recap", String(o.recap));
    if (!o.name) p.set("name", "0");
    if (o.streamer) p.set("streamer", "1");
    if (!forObs && o.edit) p.set("edit", "1");
    if (!forObs && o.demo) p.set("demo", "1");
    const s = p.toString();
    return s ? `?${s}` : "";
  }

  // ---- formatting ----------------------------------------------------------------
  function clock(secs) {
    if (!finite(secs) || secs < 0) return "0:00";
    const s = Math.floor(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }
  function sharePct(share) {
    if (!finite(share) || share < 0) return null;
    const v = 100 * share;
    if (v > 0 && v < 0.1) return "<0.1%";
    return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
  }

  function heartbeatFresh(beat, now = Date.now()) {
    return finite(beat) && beat > 0 && now - beat < STALE_MS && beat - now < 60000;
  }

  // ---- the live game (content.js -> overlayLive) ----------------------------------
  // The tab that wrote it checked the probe's figures; this is the second line: a
  // shape check, clamps, and nothing older than LIVE_STALE_MS.
  function sanitizeLive(raw, now = Date.now()) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.gameId !== "string" || !GAME_ID.test(raw.gameId)) return null;
    if (!finite(raw.at) || now - raw.at > LIVE_STALE_MS || raw.at - now > 60000) return null;
    const phase = PHASES.includes(raw.phase) ? raw.phase : "playing";
    const share = finite(raw.share) ? clamp(raw.share, 0, 1) : null;
    const players = count(raw.players, 5000);
    let place = count(raw.place, 5000);
    if (place === 0 || (place != null && players != null && place > players)) place = null;
    const humans = count(raw.humans, 5000);
    let humansTotal = count(raw.humansTotal, 5000);
    if (humansTotal != null && humans != null && humansTotal < humans) humansTotal = humans;
    return {
      gameId: raw.gameId,
      at: raw.at,
      phase,
      seconds: finite(raw.seconds) && raw.seconds >= 0 ? Math.min(raw.seconds, 86400 * 2) : 0,
      map: label(raw.map),
      mode: label(raw.mode),
      humans,
      humansTotal,
      players,
      place,
      share,
      top: (Array.isArray(raw.top) ? raw.top : []).slice(0, 3).map((t) => ({ share: finite(t?.share) ? clamp(t.share, 0, 1) : 0, me: t?.me === true })),
    };
  }

  // The page runs the clock itself between two writes (the tab leaves the clock out
  // of what counts as a change) while the game does; a state older than
  // LIVE_STALE_MS is dropped anyway.
  function liveSeconds(live, now = Date.now()) {
    if (!live) return 0;
    const running = live.phase === "playing" || live.phase === "out" || live.phase === "watching";
    return live.seconds + (running ? clamp((now - live.at) / 1000, 0, LIVE_STALE_MS / 1000) : 0);
  }

  // Leader bars: the three biggest empires, plus you when you are not among them.
  function leaderRows(live) {
    if (!live) return [];
    const rows = live.top.map((t, i) => ({ place: i + 1, share: t.share, me: t.me }));
    if (!rows.some((r) => r.me) && live.share != null && live.place != null && live.phase !== "out") rows.push({ place: live.place, share: live.share, me: true });
    const max = Math.max(0.0001, ...rows.map((r) => r.share));
    return rows.map((r) => ({ ...r, frac: clamp(r.share / max, 0.02, 1) }));
  }

  // ---- today's session (content.js "session") ------------------------------------
  function sessionView(session, today, { maxPips = 12 } = {}) {
    const games = session && typeof session === "object" && session.day === today && Array.isArray(session.games) ? session.games.filter((g) => g && typeof g === "object") : [];
    const wins = games.filter((g) => g.won === true).length;
    const pips = games.slice(-maxPips).map((g) => ({ won: g.won === true, place: count(g.place), total: count(g.total) }));
    const last = [...games].reverse().find((g) => finite(g.pctAfter));
    let drift = null;
    if (finite(session?.startPct) && last) {
      const from = session.startPct;
      const to = last.pctAfter;
      const delta = from - to; // positive: a better (smaller) percentile
      drift = { from, to, delta, dir: Math.abs(delta) < 0.05 ? "same" : delta > 0 ? "up" : "down" };
    }
    return { games: games.length, wins, pips, more: Math.max(0, games.length - pips.length), drift };
  }

  // ---- your rank (worker "lookup" answer) ----------------------------------------
  // S: OFR_SCORING. kind: ok | unranked | none | consent | error | loading
  function rankView(info, S) {
    if (info === undefined) return { kind: "loading" };
    if (!info || typeof info !== "object") return { kind: "none" };
    if (!info.found) return { kind: info.reason === "consent" ? "consent" : info.reason === "error" ? "error" : "none" };
    const streak = count(info.streak, 999) ?? 0;
    const r = S?.ranked?.(info);
    if (!r) return { kind: "unranked", streak, games: count(info.games) };
    return {
      kind: "ok",
      pct: r.pct,
      band: S.percentBand(r.pct),
      text: S.formatPercent(r.pct),
      frac: clamp(1 - r.pct / 100, 0.03, 1),
      streak,
      games: count(info.games),
    };
  }

  // Streamer mode keeps your own rank off the stream, as everywhere else in the
  // extension: no gauge and no drift, only the streak and today's games.
  function hideRank(rank) {
    if (!rank || (rank.kind !== "ok" && rank.kind !== "unranked")) return rank;
    return { kind: "hidden", streak: rank.streak, games: rank.games };
  }

  // ---- the recap card (content.js -> overlayRecap) -------------------------------
  function sanitizeRecap(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.gameId !== "string" || !GAME_ID.test(raw.gameId) || !finite(raw.at)) return null;
    if (typeof raw.png !== "string" || raw.png.length > MAX_PNG || !/^data:image\/(png|webp);base64,[A-Za-z0-9+/]+=*$/.test(raw.png)) return null;
    return { gameId: raw.gameId, at: raw.at, png: raw.png, streamer: raw.streamer === true };
  }

  // A page that hides your name (name=0, streamer mode) shows only a card that was
  // drawn masked (your name and rank left out); the tab redraws it so when asked.
  function recapFor(recap, masked) {
    if (!recap) return null;
    return masked && recap.streamer !== true ? null : recap;
  }

  // Shown for `secs` seconds from when it was made (0: until the next game starts),
  // and never over a different game that is being played now.
  function recapState(recap, live, secs, now = Date.now()) {
    if (!recap) return { show: false };
    if (live && live.gameId !== recap.gameId && live.phase !== "ended") return { show: false };
    const age = now - recap.at;
    if (age < -60000) return { show: false };
    if (!secs) return { show: age < 6 * 3600 * 1000, frac: null };
    const total = secs * 1000;
    if (age >= total) return { show: false };
    return { show: true, remain: total - Math.max(0, age), frac: clamp(1 - Math.max(0, age) / total, 0, 1) };
  }

  // What is on screen. The recap replaces the live card of the game it is about.
  function layout(opts, { live, recap, rank, session, off = false }, now = Date.now()) {
    if (off) return [];
    const r = recapState(recap, live, opts.recap, now);
    const cards = [];
    for (const w of opts.widgets) {
      if (w === "rank" && ((rank && (rank.kind === "ok" || rank.kind === "unranked" || rank.kind === "hidden")) || (session && session.games > 0))) cards.push("rank");
      if (w === "live" && live && !(r.show && opts.widgets.includes("recap") && recap.gameId === live.gameId)) cards.push("live");
      if (w === "recap" && r.show) cards.push("recap");
    }
    return cards;
  }

  // Sample data for placing the overlay (edit panel "Sample").
  function demo(now = Date.now()) {
    const today = new Date(now).toDateString();
    return {
      name: "[OFP] Streamer",
      info: { found: true, games: 412, wins: 61, ratedGames: 400, ratedWins: 60, expectedWins: 31, streak: 3 },
      session: {
        day: today,
        startPct: 6.4,
        games: [
          { gameId: "demo0001", won: false, place: 5, total: 40 },
          { gameId: "demo0002", won: true, place: 1, total: 38 },
          { gameId: "demo0003", won: false, place: 3, total: 44 },
          { gameId: "demo0004", won: true, place: 1, total: 41 },
          { gameId: "demo0005", won: true, place: 1, total: 36, pctAfter: 5.1 },
        ],
      },
      live: {
        gameId: "demo0006",
        at: now,
        phase: "playing",
        seconds: 754,
        map: "World",
        mode: "Free For All",
        humans: 14,
        humansTotal: 38,
        players: 57,
        place: 2,
        share: 0.124,
        top: [{ share: 0.171 }, { share: 0.124, me: true }, { share: 0.083 }],
      },
    };
  }

  globalThis.OFR_OVERLAY = {
    WIDGETS,
    BGS,
    CORNERS,
    DEFAULTS,
    BEAT_MS,
    STALE_MS,
    LIVE_STALE_MS,
    MAX_PNG,
    parseOptions,
    buildQuery,
    clock,
    sharePct,
    heartbeatFresh,
    label,
    sanitizeLive,
    liveSeconds,
    leaderRows,
    sessionView,
    rankView,
    hideRank,
    sanitizeRecap,
    recapFor,
    recapState,
    layout,
    demo,
  };
})();
