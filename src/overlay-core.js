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
//   overlayReplay   { gameId, at, streamer, gif, note }  the game's timelapse as a
//                   GIF once the game is over (gif null + note when it was skipped;
//                   at most 1.5 MB, written once per game and masking, the previous
//                   game's replay and recap removed first)
//   session         today's games (content.js recordSession)
//
// Observer mode: while you WATCH a game (a spectator), overlayLive also carries
// `caster` - the leaderboard, team totals and eliminations of that game - and the
// "caster" card shows it. `delay` holds everything that reflects a game back by N
// seconds in this page's memory - the game cards, the recap and replay, and the
// rank card's session pips, streak and rank - so viewers cannot relay live
// information to players in that game. Left to its default it is 90 s whenever the
// overlay shows a game you watch, whatever the cards.
(() => {
  if (globalThis.OFR_OVERLAY) return;

  const WIDGETS = ["rank", "live", "caster", "recap"];
  const DEFAULT_WIDGETS = ["rank", "live", "recap"];
  const BGS = ["transparent", "green", "dark"];
  const CORNERS = ["tl", "tr", "bl", "br"];
  const PHASES = ["spawn", "playing", "out", "ended", "watching"];
  const DEFAULTS = Object.freeze({ widgets: DEFAULT_WIDGETS, bg: "transparent", scale: 1, pos: "tr", recap: 20, replay: 25, delay: 0, delayAuto: true, name: true, streamer: false, edit: false, demo: false });
  // A game you WATCH is someone else's game: what the overlay shows of it is held
  // back by 90 s unless the address sets a delay (delay=0 turns it off). The caster
  // card always comes with it; with the other cards it applies whenever the game on
  // the overlay is a watched one (delayAuto: no delay= in the address).
  const CASTER_DELAY = 90;
  const MAX_DELAY = 600;
  const defaultDelay = (widgets) => (widgets.includes("caster") ? CASTER_DELAY : 0);
  // overlayLive of a game you watch (content.js: phase "watching", caster data)
  const isWatched = (raw) => Boolean(raw && typeof raw === "object" && (raw.phase === "watching" || (raw.caster && typeof raw.caster === "object")));
  // A watched game is on the overlay now, or still in its delay buffer.
  const spectated = (buf, current) => isWatched(current) || (Array.isArray(buf) && buf.some((e) => isWatched(e?.value)));
  // The delay in force, in seconds: the address's, or - left to the default - 90 s
  // while a watched game is on the overlay (or still playing out), else the cards' default.
  function effectiveDelay(o, watched) {
    const auto = o.delayAuto ?? o.delay === defaultDelay(o.widgets);
    if (!auto) return o.delay;
    return watched ? CASTER_DELAY : defaultDelay(o.widgets);
  }

  // The heartbeat: the page writes the time every BEAT_MS; a tab stops publishing
  // once it is older than STALE_MS. Generous, because a hidden window's timers
  // are throttled by the browser (down to once a minute).
  const BEAT_MS = 20000;
  const STALE_MS = 150000;
  // overlayLive is rewritten at least every ~4 s; older than this, its tab is gone.
  const LIVE_STALE_MS = 12000;
  const MAX_PNG = 1_600_000; // characters of the data URL (~1.2 MB of image)
  // The replay GIF: content.js keeps it at or under this many characters of data
  // URL (1.5 MB of storage, ~1.1 MB of GIF), shrinking frames and size until it
  // fits. Every storage listener (the worker, each openfront.io tab, the launcher's
  // pages) gets it with each change, and it shares storage.local with the recap
  // card and the tournament cache.
  const MAX_GIF = 1_500_000;
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
  //   replay=25           seconds the replay GIF plays after the recap card (0: off)
  //   w=caster            observer mode: the watched game's leaderboard
  //   delay=90            seconds everything game-related is held back (0..600;
  //                       by default 90 with the caster card or while the game
  //                       on the overlay is one you watch, 0 otherwise)
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
    const replay = Number(p.get("replay"));
    if (p.has("replay") && p.get("replay") !== "" && finite(replay)) o.replay = clamp(Math.round(replay), 0, 600);
    const delay = Number(p.get("delay"));
    const delaySet = p.has("delay") && p.get("delay") !== "" && finite(delay);
    o.delay = delaySet ? clamp(Math.round(delay), 0, MAX_DELAY) : defaultDelay(o.widgets);
    o.delayAuto = !delaySet;
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
    if (o.replay !== DEFAULTS.replay) p.set("replay", String(o.replay));
    // a delay set by hand is written out even when it equals a default (delay=0
    // keeps a watched game undelayed); an automatic one never is
    if (!(o.delayAuto ?? o.delay === defaultDelay(o.widgets))) p.set("delay", String(o.delay));
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
      caster: sanitizeCaster(raw.caster),
    };
  }

  // ---- observer mode: the watched game (content.js -> overlayLive.caster) --------------
  // Player names go on the broadcast: control characters and bidi overrides out,
  // 40 characters at most, and they only ever reach the page through textContent.
  const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g;
  const plain = (v, max = 40) => {
    const s = typeof v === "string" ? v.replace(BAD_CHARS, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
    return s || null;
  };
  const BANDS = ["elite", "strong", "good", "average", "low"];
  const rgbOf = (v) => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(finite) ? v.slice(0, 3).map((c) => clamp(Math.round(c), 0, 255)) : null);
  const share01 = (v) => (finite(v) ? clamp(v, 0, 1) : 0);
  function sanitizeCaster(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.board)) return null;
    return {
      teamGame: raw.teamGame === true,
      playersAlive: count(raw.playersAlive, 5000),
      humansAlive: count(raw.humansAlive, 5000),
      humansTotal: count(raw.humansTotal, 5000),
      more: count(raw.more, 5000) ?? 0,
      board: raw.board.slice(0, 12).filter((r) => r && typeof r === "object").map((r) => ({
        place: count(r.place, 5000) || null,
        name: plain(r.name),
        team: label(r.team) || null,
        share: share01(r.share),
        frac: share01(r.frac),
        alive: r.alive === true,
        outAt: finite(r.outAt) && r.outAt >= 0 ? Math.min(r.outAt, 172800) : null,
        rgb: rgbOf(r.rgb),
        band: BANDS.includes(r.band) ? r.band : null,
      })),
      teams: (Array.isArray(raw.teams) ? raw.teams : []).slice(0, 12).filter((t) => t && typeof t === "object" && label(t.name)).map((t) => ({
        name: label(t.name),
        share: share01(t.share),
        frac: share01(t.frac),
        alive: count(t.alive, 5000) ?? 0,
        total: count(t.total, 5000) ?? 0,
        rgb: rgbOf(t.rgb),
      })),
      feed: (Array.isArray(raw.feed) ? raw.feed : []).slice(0, 8).filter((f) => f && typeof f === "object" && finite(f.at)).map((f) => ({
        at: clamp(f.at, 0, 172800),
        name: plain(f.name),
        team: label(f.team) || null,
        human: f.human === true,
        rgb: rgbOf(f.rgb),
      })),
    };
  }

  // ---- the delay (observer mode against ghosting) ----------------------------------------
  // Every overlayLive this page receives is kept in memory with the time it came in,
  // and the page shows the one from `delay` seconds ago. Nothing extra is stored.
  // A null entry is "no game any more" - it is played out late too.
  const DELAY_KEEP = 2400; // entries: 600 s at one write every ~0.25 s at most
  function delayPush(buf, value, got, delayMs) {
    const list = Array.isArray(buf) ? buf : [];
    if (!finite(got)) return list;
    const cutoff = got - delayMs;
    // the newest entry at or before the cutoff is still needed: it is what shows now
    let firstKept = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].got <= cutoff) {
        firstKept = i;
        break;
      }
    }
    const next = list.slice(firstKept).filter((e) => e.got <= got);
    next.push({ got, value: value ?? null });
    return next.slice(-DELAY_KEEP);
  }
  function delayPick(buf, now, delayMs) {
    if (!Array.isArray(buf)) return null;
    const cutoff = now - delayMs;
    for (let i = buf.length - 1; i >= 0; i--) if (buf[i].got <= cutoff) return buf[i].value;
    return null;
  }
  // Something newer is waiting in the buffer (the page keeps ticking until it shows).
  const delayPending = (buf, now, delayMs) => Array.isArray(buf) && buf.some((e) => e.got > now - delayMs && e.value);

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
  // and never over a different game that is being played now. `now` is the time the
  // overlay shows (its delay taken off): a card made after it is about a moment the
  // delayed stream has not reached yet - it comes then (startsIn), and the game's
  // live card runs until it does.
  function recapState(recap, live, secs, now = Date.now()) {
    if (!recap) return { show: false };
    if (live && live.gameId !== recap.gameId && live.phase !== "ended") return { show: false };
    const age = now - recap.at;
    if (age < 0) return -age <= (MAX_DELAY + 60) * 1000 ? { show: false, startsIn: -age } : { show: false };
    if (!secs) return { show: age < 6 * 3600 * 1000, frac: null };
    const total = secs * 1000;
    if (age >= total) return { show: false };
    return { show: true, remain: total - Math.max(0, age), frac: clamp(1 - Math.max(0, age) / total, 0, 1) };
  }

  // ---- the replay (content.js -> overlayReplay) ----------------------------------------
  // The game's timelapse as a GIF, made in the game tab once the game is over. gif is
  // null when it was skipped (too big for storage even small, no timelapse): `note`
  // says why, for the settings panel.
  const NOTES = ["size", "frames", "error"];
  function sanitizeReplay(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.gameId !== "string" || !GAME_ID.test(raw.gameId) || !finite(raw.at)) return null;
    const gif = typeof raw.gif === "string" && raw.gif.length <= MAX_GIF && /^data:image\/gif;base64,[A-Za-z0-9+/]+=*$/.test(raw.gif) ? raw.gif : null;
    if (typeof raw.gif === "string" && !gif) return null; // something else in its place
    return { gameId: raw.gameId, at: raw.at, gif, streamer: raw.streamer === true, note: NOTES.includes(raw.note) ? raw.note : null };
  }
  // Like the recap card: a page that hides names only shows a replay drawn masked.
  const replayFor = (replay, masked) => (!replay ? null : masked && replay.streamer !== true ? null : replay);

  // After the recap card (when that game has one and this page shows recaps), for
  // `opts.replay` seconds, then gone. Never over a different game being played now;
  // with recap=0 the card stays until the next game and there is no replay.
  function replayState(replay, recap, live, opts, now = Date.now()) {
    if (!replay?.gif || !opts.replay) return { show: false };
    if (live && live.gameId !== replay.gameId && live.phase !== "ended") return { show: false };
    if (now - replay.at > 6 * 3600 * 1000 || replay.at - now > 60000) return { show: false };
    let start = replay.at;
    if (recap && recap.gameId === replay.gameId && opts.widgets.includes("recap")) {
      if (!opts.recap) return { show: false };
      start = Math.max(start, recap.at + opts.recap * 1000);
    }
    const total = opts.replay * 1000;
    if (now < start) return { show: false, startsIn: start - now };
    if (now - start >= total) return { show: false, done: true };
    return { show: true, remain: total - (now - start), frac: clamp(1 - (now - start) / total, 0, 1) };
  }

  // What is on screen. The recap replaces the live card of the game it is about, and
  // the replay follows the recap; the caster card is the watched game's live card.
  function layout(opts, { live, recap, rank, session, replay = null, off = false }, now = Date.now()) {
    if (off) return [];
    const r = recapState(recap, live, opts.recap, now);
    const p = replayState(replay, recap, live, opts, now);
    const aboutLive = (card, shown) => shown && live && card && card.gameId === live.gameId;
    // ...and once the replay of a finished game has played, that game's card is done too
    const coveredLive = aboutLive(recap, r.show && opts.widgets.includes("recap")) || aboutLive(replay, p.show) || (aboutLive(replay, p.done) && live.phase === "ended");
    const cards = [];
    for (const w of opts.widgets) {
      if (w === "rank" && ((rank && (rank.kind === "ok" || rank.kind === "unranked" || rank.kind === "hidden")) || (session && session.games > 0))) cards.push("rank");
      if (w === "live" && live && !coveredLive) cards.push("live");
      if (w === "caster" && live?.caster && !coveredLive) cards.push("caster");
      if (w === "recap" && r.show) cards.push("recap");
    }
    if (p.show) cards.push("replay");
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
      // observer mode: a watched game
      watch: {
        gameId: "demo0007",
        at: now,
        phase: "watching",
        seconds: 1312,
        map: "Europe",
        mode: "Free For All",
        humans: 11,
        humansTotal: 42,
        players: 19,
        place: null,
        share: null,
        top: [],
        caster: {
          teamGame: false,
          playersAlive: 19,
          humansAlive: 11,
          humansTotal: 42,
          more: 13,
          board: [
            ["[OFP] Kestrel", 0.214, [224, 68, 62], "elite"],
            ["Marlowe", 0.162, [59, 123, 224], "strong"],
            ["[UN] Mox", 0.118, [242, 193, 46], "good"],
            ["Tsarina", 0.087, [22, 160, 133], null],
            ["Hollow Crown", 0.061, [142, 68, 173], "average"],
            ["Pike", 0.044, [230, 126, 34], null],
          ].map(([name, share, rgb, band], i) => ({ place: i + 1, name, share, frac: share / 0.214, alive: true, rgb, band })),
          teams: [],
          feed: [
            { at: 1290, name: "Garibaldi", human: true, rgb: [236, 240, 241] },
            { at: 1204, name: "France", human: false, rgb: [52, 73, 94] },
            { at: 1133, name: "Anon42", human: true, rgb: [127, 140, 141] },
          ],
        },
      },
    };
  }

  globalThis.OFR_OVERLAY = {
    WIDGETS,
    DEFAULT_WIDGETS,
    BGS,
    CORNERS,
    DEFAULTS,
    CASTER_DELAY,
    MAX_DELAY,
    defaultDelay,
    isWatched,
    spectated,
    effectiveDelay,
    BEAT_MS,
    STALE_MS,
    LIVE_STALE_MS,
    MAX_PNG,
    MAX_GIF,
    sanitizeCaster,
    sanitizeReplay,
    replayFor,
    replayState,
    delayPush,
    delayPick,
    delayPending,
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
