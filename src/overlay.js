// Stream overlay page (src/overlay.html): your rank, today's session, the game
// you are playing and the recap card, drawn for OBS.
//
// Two ways in: the extension opens it in a small window of its own (OBS: Window
// Capture + Chroma Key), and the Steam companion launcher serves it on its
// loopback address (OBS: Browser Source). Either way it only reads
// chrome.storage (onChanged, no polling) and asks the worker for your own rank;
// the openfront.io tab publishes the live game here while this page's heartbeat
// (overlayEnabled) is fresh. Everything stays on this computer.
//
// Only chrome.storage.sync/local get/set/onChanged, runtime.sendMessage and
// runtime.getURL are used: that is what the launcher's page shim provides.
// Strings from storage or the network always go through textContent.
(() => {
  const O = globalThis.OFR_OVERLAY;
  const S = globalThis.OFR_SCORING;
  const THEMES = globalThis.OFR_THEMES ?? {};
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const cardsEl = $("cards");
  const LAUNCHER = root.classList.contains("ofr-launcher");
  const NS = "http://www.w3.org/2000/svg";

  let opts = O.parseOptions(location.search, location.hash);
  const state = {
    settings: { theme: "classic", streamerMode: false, enabled: true, dataConsent: false },
    self: null, // { name }
    info: undefined, // worker lookup answer for self.name (undefined: not asked yet)
    session: null,
    live: null, // raw overlayLive
    recap: null, // sanitised overlayRecap
    replay: null, // sanitised overlayReplay
    // every overlayLive received, with when it came (memory only): what `delay` plays late
    buffer: [],
    // ...and the same for what the rank card shows of your games (today's pips, the
    // streak and rank after a game): the first value is history and shows at once
    sessionBuf: [],
    infoBuf: [],
  };
  // a delay left to its default can become 90 s at any moment (a watched game): keep that much
  const keepMs = () => (Math.max(opts.delay, opts.delayAuto ? O.CASTER_DELAY : 0, 30) + 10) * 1000;
  // the delay in force now, in seconds
  const delayNow = () => (opts.demo ? 0 : O.effectiveDelay(opts, O.spectated(state.buffer, state.live)));
  function receiveLive(raw, got = Date.now()) {
    state.live = raw ?? null;
    state.buffer = O.delayPush(state.buffer, state.live, got, keepMs());
  }
  function hold(key, value, got = Date.now()) {
    const buf = state[key];
    state[key] = O.delayPush(buf, value, buf.length ? got : 0, keepMs());
  }
  function setInfo(info) {
    state.info = info;
    if (info !== undefined) hold("infoBuf", info);
  }
  function setSession(session) {
    state.session = session ?? null;
    hold("sessionBuf", state.session);
  }
  // what the rank card shows: the newest, or with a delay the one from that long ago
  const delayed = (key, newest, now, delayMs) => (delayMs > 0 && state[key].length ? O.delayPick(state[key], now, delayMs) : newest);

  // ---- small DOM helpers (static class names; text via textContent) ------------
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }
  function icon(paths, cls) {
    const s = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    if (cls) s.setAttribute("class", cls);
    for (const d of paths) s.append(svg("path", { d }));
    return s;
  }
  const ICONS = {
    place: ["M9 8h6v13H9z", "M2.5 13h6v8h-6z", "M15.5 15h6v6h-6z", "M12 1.8l1.2 2.4 2.6.4-1.9 1.8.5 2.6L12 7.8 9.6 9l.5-2.6-1.9-1.8 2.6-.4z"],
    land: ["M11 3.1A9 9 0 1 0 20.9 13H11z", "M13 1.1V11h9.9A10 10 0 0 0 13 1.1z"],
    humans: ["M12 3.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8z", "M4 21c0-4.2 3.6-7.2 8-7.2s8 3 8 7.2z"],
    arrow: ["M4 10.5h11.2l-4.6-4.6L12 4.5l7 7-7 7-1.4-1.4 4.6-4.6H4z"],
    today: ["M7 2h2v2h6V2h2v2h3a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3zM5 9v10h14V9z", "M7 11h4v4H7z"],
    clock: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z", "M11 6h2v5.6l3.7 2.2-1 1.7L11 12.7z"],
  };
  function flame(on) {
    const s = svg("svg", { viewBox: "0 0 20 24", class: "ov-flame", "data-on": String(on), "aria-hidden": "true" });
    s.append(
      svg("path", { class: "o", d: "M10 1c.8 3.6-1.6 5.5-3.3 7.6C5.3 10.4 4 12.3 4 15.1 4 19.5 6.7 23 10 23s6-3.5 6-7.9c0-2.7-1.2-5.2-2.8-6.9.1 2.1-.7 3.5-2 4 .8-4.6-.3-8.6-1.2-11.2z" }),
      svg("path", { class: "i", d: "M10 23c-2 0-3.5-1.7-3.5-3.9 0-1.8 1-3.1 2.3-4.3.2 1.3.9 2.2 1.9 2.4.1-1.4.7-2.6 1.5-3.4.9 1.2 1.3 2.7 1.3 4.2 0 2.8-1.5 5-3.5 5z" }),
    );
    return s;
  }

  // ---- options -------------------------------------------------------------------
  function applyOptions() {
    root.dataset.bg = opts.bg;
    root.dataset.pos = opts.pos;
    root.dataset.edit = String(opts.edit);
    root.style.setProperty("--ofr-ov-scale", String(opts.scale));
    $("edit").hidden = !opts.edit;
    syncEditor();
  }
  // The address bar keeps the options, so a reload (and OBS) keeps them.
  function setOptions(patch) {
    const wasMasked = masked();
    opts = { ...opts, ...patch };
    if (masked() !== wasMasked) beat(); // the tab redraws the recap card to match
    try {
      history.replaceState(null, "", location.pathname + O.buildQuery(opts));
    } catch {
      // some embedders refuse; the page still works
    }
    applyOptions();
    render();
  }

  function applyTheme() {
    const t = state.settings.theme;
    if (t && t !== "classic" && THEMES[t]) root.dataset.ofrTheme = t;
    else delete root.dataset.ofrTheme;
  }

  const streamer = () => state.settings.streamerMode === true || opts.streamer;
  const showName = () => opts.name && !streamer();
  // your name kept off this page: the recap card too must be one drawn masked
  const masked = () => !showName();

  // ---- data ------------------------------------------------------------------------
  const today = () => new Date().toDateString();

  let lookupTimer = null;
  let lookupFor = null;
  let freshAt = 0;
  // soon: a game was just recorded. That lookup skips the worker's 10-minute
  // cache (at most once a minute; the recap's own fresh lookup refills the cache).
  async function lookupSelf({ soon = false, fresh = false } = {}) {
    clearTimeout(lookupTimer);
    if (soon) {
      lookupTimer = setTimeout(() => lookupSelf({ fresh: Date.now() - freshAt > 60000 }), 3000);
      return;
    }
    const name = state.self?.name ?? null;
    const s = state.settings;
    if (!name || s.enabled === false || s.dataConsent !== true) {
      setInfo(name && s.dataConsent !== true ? { found: false, reason: "consent" } : null);
      render();
      return;
    }
    lookupFor = name;
    if (fresh) freshAt = Date.now();
    let info = null;
    try {
      const res = await chrome.runtime.sendMessage(fresh ? { type: "lookup", usernames: [name], fresh: true } : { type: "lookup", usernames: [name] });
      info = res?.[name] ?? null;
    } catch {
      info = { found: false, reason: "error" };
    }
    if (lookupFor !== name) return; // the name changed meanwhile
    setInfo(info);
    render();
    // the worker's cache holds a hit for 10 minutes: ask again after that
    lookupTimer = setTimeout(() => lookupSelf(), 10 * 60 * 1000);
  }

  function setSelf(raw) {
    const name = raw && typeof raw.name === "string" ? raw.name.slice(0, 60) : null;
    if (name === (state.self?.name ?? null)) return;
    state.self = name ? { name } : null;
    state.info = undefined;
    state.infoBuf = []; // someone else's rank: nothing of the old one to play out
    lookupSelf();
  }

  async function load() {
    try {
      const sync = await chrome.storage.sync.get({ theme: "classic", streamerMode: false, enabled: true, dataConsent: false });
      state.settings = { ...state.settings, ...sync };
    } catch {
      // defaults
    }
    applyTheme();
    try {
      const local = await chrome.storage.local.get(["overlaySelf", "session", "overlayLive", "overlayRecap", "overlayReplay"]);
      setSession(local.session);
      const at = local.overlayLive?.at;
      receiveLive(local.overlayLive, typeof at === "number" && at <= Date.now() ? at : Date.now());
      state.recap = O.sanitizeRecap(local.overlayRecap);
      state.replay = O.sanitizeReplay(local.overlayReplay);
      setSelf(local.overlaySelf);
    } catch {
      // nothing stored yet
    }
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      let touched = false;
      const wasMasked = masked();
      for (const k of ["theme", "streamerMode", "enabled", "dataConsent"]) {
        if (!changes[k]) continue;
        state.settings[k] = changes[k].newValue ?? (k === "enabled" ? true : k === "theme" ? "classic" : false);
        touched = true;
      }
      if (masked() !== wasMasked) beat();
      if (changes.theme) applyTheme();
      if (changes.enabled || changes.dataConsent) lookupSelf();
      if (touched) render();
      return;
    }
    if (area !== "local") return;
    // another overlay page closed and said so: this one is still open
    if (changes.overlayEnabled && !changes.overlayEnabled.newValue && !closing) beat();
    if (changes.overlaySelf) setSelf(changes.overlaySelf.newValue);
    if (changes.overlayLive) receiveLive(changes.overlayLive.newValue);
    if (changes.overlayRecap) state.recap = O.sanitizeRecap(changes.overlayRecap.newValue);
    if (changes.overlayReplay) state.replay = O.sanitizeReplay(changes.overlayReplay.newValue);
    if (changes.session) {
      setSession(changes.session.newValue);
      lookupSelf({ soon: true }); // a game was recorded: the rank may have moved
    }
    if (changes.overlayLive || changes.overlayRecap || changes.overlayReplay || changes.session) render();
  });

  // ---- heartbeat -----------------------------------------------------------------
  // While this page is open, openfront.io tabs publish the live game and the recap
  // card. They stop by themselves once the heartbeat is O.STALE_MS old, or at once
  // when the page closes (0), and then remove what they published.
  // overlayMask: this page hides your name, so the recap card is drawn masked.
  let closing = false;
  let maskSent = false;
  function beat() {
    if (closing) return;
    const now = Date.now();
    const items = { overlayEnabled: now };
    if (masked()) items.overlayMask = now;
    else if (maskSent) items.overlayMask = 0;
    maskSent = "overlayMask" in items && items.overlayMask > 0;
    chrome.storage.local.set(items).catch(() => {});
  }
  beat();
  setTimeout(beat, 2500); // after a reload, the old page's "closed" (0) can land after the first beat
  setInterval(beat, O.BEAT_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") beat();
  });
  window.addEventListener("pagehide", () => {
    closing = true;
    const items = { overlayEnabled: 0 };
    if (maskSent) items.overlayMask = 0;
    try {
      chrome.storage.local.set(items).catch(() => {});
    } catch {
      // extension reloaded under us
    }
  });
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return; // back from the back/forward cache: open again
    closing = false;
    beat();
  });

  // ---- cards -----------------------------------------------------------------------
  // Streamer mode: no name and no rank (gauge, drift) - the streak and today's
  // games stay. name=0 or streamer mode: only a recap card drawn masked.
  // `vnow` is the time the game cards show: `delay` seconds ago (the delay against
  // ghosting; 90 s by default while the game on the overlay is one you watch). The
  // live state then comes from this page's buffer, the recap and the replay appear
  // that much later too, and so does what the rank card shows of a game that just
  // ended (today's pips, the streak, the rank).
  function view(now) {
    const d = opts.demo ? O.demo(now) : null;
    const delay = delayNow();
    const delayMs = delay * 1000;
    const rank = O.rankView(d ? d.info : delayed("infoBuf", state.info, now, delayMs), S);
    const session = O.sessionView(d ? d.session : delayed("sessionBuf", state.session, now, delayMs), today(), { maxPips: 10 });
    const hide = streamer();
    const vnow = now - delayMs;
    const raw = d ? (opts.widgets.includes("caster") ? d.watch : d.live) : delay ? O.delayPick(state.buffer, now, delayMs) : state.live;
    let live = O.sanitizeLive(raw, vnow);
    // this page hides names: none on the caster card either, whatever the tab sent
    if (live?.caster && masked()) {
      live = {
        ...live,
        caster: { ...live.caster, board: live.caster.board.map((r) => ({ ...r, name: null, band: null })), feed: live.caster.feed.map((f) => ({ ...f, name: f.human ? null : f.name })) },
      };
    }
    return {
      vnow,
      delay,
      name: showName() ? (d ? d.name : (state.self?.name ?? null)) : null,
      rank: hide ? O.hideRank(rank) : rank,
      session: hide ? { ...session, drift: null } : session,
      live,
      recap: O.recapFor(state.recap, masked()),
      replay: O.replayFor(state.replay, masked()),
      waiting: !d && delay > 0 && !live && O.delayPending(state.buffer, now, delayMs),
      // something newer than what shows is waiting in one of the buffers
      pending: !d && delay > 0 && ["buffer", "sessionBuf", "infoBuf"].some((k) => O.delayPending(state[k], now, delayMs)),
    };
  }

  function rankCard(v) {
    const card = el("section", "ov-card ov-rank");
    card.setAttribute("aria-label", "World rank and today's session");
    const r = v.rank;
    if (r.kind === "ok" || r.kind === "unranked") {
      const gauge = el("div", "ov-gauge");
      gauge.dataset.kind = r.kind;
      const ring = svg("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" });
      ring.append(svg("circle", { class: "ov-gauge-track", cx: 50, cy: 50, r: 44 }));
      if (r.kind === "ok") {
        card.dataset.band = r.band;
        ring.append(svg("circle", { class: "ov-gauge-arc", cx: 50, cy: 50, r: 44, pathLength: 100, "stroke-dasharray": `${(r.frac * 100).toFixed(1)} 100` }));
      }
      const text = el("div", "ov-gauge-text");
      if (r.kind === "ok") {
        const val = el("span", "ov-gauge-val", r.text);
        val.append(el("small", null, "%"));
        text.append(el("span", "ov-gauge-top", "TOP"), val);
        gauge.title = `World rank: Top ${r.text}%`;
        // how far the rank moved today, in percentile points (smaller is better)
        const drift = v.session.drift;
        if (drift && drift.dir !== "same") {
          const moved = Math.abs(drift.delta);
          const d = el("span", "ov-gauge-drift");
          d.dataset.dir = drift.dir;
          d.append(icon(ICONS.arrow), document.createTextNode(moved < 10 ? moved.toFixed(1) : String(Math.round(moved))));
          gauge.title += `\nToday: Top ${S.formatPercent(drift.from)}% → Top ${S.formatPercent(drift.to)}%`;
          text.append(d);
        }
      } else {
        text.append(el("span", "ov-gauge-top", "RANK"), el("span", "ov-gauge-val", "new"));
      }
      gauge.append(ring, text);
      card.append(gauge);
    }
    const side = el("div", "ov-side");
    if (v.name) side.append(el("div", "ov-name", v.name));

    // win streak: five flames, lit per win in a row (and the count past five)
    if (r.kind === "ok" || r.kind === "unranked" || r.kind === "hidden") {
      const row = el("div", "ov-row");
      row.setAttribute("role", "img");
      row.setAttribute("aria-label", `${r.streak} win streak`);
      row.title = `${r.streak} win${r.streak === 1 ? "" : "s"} in a row`;
      const flames = el("span", "ov-flames");
      for (let i = 0; i < 5; i++) flames.append(flame(i < r.streak));
      row.append(flames);
      if (r.streak > 5) row.append(el("span", "ov-more", `×${r.streak}`));
      side.append(row);
    }

    // today: one pip per game (a win filled), then wins / games
    const s = v.session;
    const row = el("div", "ov-row");
    row.title = "Today's games";
    row.append(icon(ICONS.today, "ov-ico"));
    if (s.games) {
      const pips = el("span", "ov-pips");
      pips.setAttribute("role", "img");
      pips.setAttribute("aria-label", `${s.wins} of ${s.games} games won today`);
      for (const p of s.pips) {
        const pip = el("span", "ov-pip");
        pip.dataset.won = String(p.won);
        pips.append(pip);
      }
      row.append(pips);
    }
    const score = el("span", "ov-score", s.games ? String(s.wins) : "–");
    if (s.games) score.append(el("small", null, `/${s.games}`));
    row.append(score);
    side.append(row);
    card.append(side);
    return card;
  }

  const PHASE_TEXT = { spawn: "Spawning", playing: "Live", out: "Out", ended: "Game over", watching: "Watching" };
  const MODE_SHORT = { "Free For All": "FFA" };
  function liveCard(v, now) {
    const l = v.live;
    const card = el("section", "ov-card ov-live");
    card.dataset.phase = l.phase;
    card.setAttribute("aria-label", "Current game");
    const head = el("div", "ov-head");
    head.append(el("span", "ov-state", PHASE_TEXT[l.phase] ?? "Live"));
    head.append(el("span", "ov-where", [l.map, MODE_SHORT[l.mode] ?? l.mode].filter(Boolean).join(" · ")));
    const clock = el("span", "ov-clock", O.clock(O.liveSeconds(l, now)));
    clock.dataset.clock = "1";
    head.append(clock);
    card.append(head);

    const tiles = el("div", "ov-tiles");
    const tile = (iconPaths, label, value, sub, dim = false) => {
      const t = el("div", "ov-tile");
      const lab = el("span", "ov-tile-lab");
      lab.append(icon(iconPaths), el("span", "ov-label", label));
      const val = el("span", "ov-val", value);
      if (dim) val.dataset.dim = "true";
      if (sub) val.append(el("small", null, sub));
      t.append(lab, val);
      return t;
    };
    const out = l.phase === "out";
    tiles.append(
      tile(ICONS.place, "Place", out ? "out" : l.place != null ? `#${l.place}` : "–", !out && l.place != null && l.players ? `/${l.players}` : null, out),
      tile(ICONS.land, "Land", out ? "0%" : (O.sharePct(l.share) ?? "–"), null, out),
      tile(ICONS.humans, "Humans", l.humans != null ? String(l.humans) : "–", l.humansTotal != null ? `/${l.humansTotal}` : null),
    );
    card.append(tiles);

    const rows = O.leaderRows(l);
    if (rows.length && l.phase !== "spawn") {
      const bars = el("div", "ov-bars");
      bars.setAttribute("aria-label", "Land of the biggest empires");
      for (const r of rows) {
        const row = el("div", "ov-bar-row");
        row.dataset.me = String(r.me);
        const bar = el("span", "ov-bar");
        const fill = el("span");
        fill.style.width = `${(r.frac * 100).toFixed(1)}%`;
        bar.append(fill);
        row.append(el("span", null, r.me ? "you" : `#${r.place}`), bar, el("span", null, O.sharePct(r.share) ?? ""));
        bars.append(row);
      }
      card.append(bars);
    }
    return card;
  }

  function recapCard(v, r) {
    const card = el("section", "ov-card ov-recap");
    card.setAttribute("aria-label", "Game recap");
    const img = el("img");
    img.alt = "Game recap";
    img.decoding = "async";
    img.src = v.recap.png;
    card.append(img);
    if (r.frac != null) {
      const timer = el("div", "ov-timer");
      const fill = el("span");
      fill.style.width = `${(r.frac * 100).toFixed(1)}%`;
      timer.append(fill);
      card.append(timer);
    }
    return card;
  }

  // ---- observer mode: the watched game ----------------------------------------------
  // A player's (or team's) colour from the game: a swatch, set as data.
  function swatch(rgb, cls = "ov-sw") {
    const s = el("span", cls);
    if (Array.isArray(rgb)) s.style.setProperty("--ov-sw", `rgb(${rgb.join(" ")})`);
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  const SKULL = ["M12 2.5c-4.7 0-8 3.2-8 7.6 0 2.6 1.2 4.6 3 5.8V19a1 1 0 0 0 1 1h1.5v-2h1.5v2h2v-2h1.5v2H16a1 1 0 0 0 1-1v-3.1c1.8-1.2 3-3.2 3-5.8 0-4.4-3.3-7.6-8-7.6zm-3.2 7a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8zm6.4 0a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8z"];
  const PLAY = ["M8 5.5v13l10.5-6.5z"];
  function casterCard(v, now) {
    const l = v.live;
    const c = l.caster;
    const card = el("section", "ov-card ov-live ov-caster");
    card.dataset.phase = l.phase;
    card.setAttribute("aria-label", "Watched game: leaderboard and eliminations");
    const head = el("div", "ov-head");
    head.append(el("span", "ov-state", l.phase === "watching" ? "Live" : (PHASE_TEXT[l.phase] ?? "Live")));
    head.append(el("span", "ov-where", [l.map, MODE_SHORT[l.mode] ?? l.mode].filter(Boolean).join(" · ")));
    const clk = el("span", "ov-clock", O.clock(O.liveSeconds(l, now)));
    clk.dataset.clock = "1";
    head.append(clk);
    card.append(head);

    const meta = el("div", "ov-cmeta");
    const chip = (paths, value, sub, title) => {
      const s = el("span", "ov-cchip");
      s.title = title;
      s.append(icon(paths), el("b", null, value));
      if (sub) s.append(el("small", null, sub));
      return s;
    };
    if (c.humansAlive != null) meta.append(chip(ICONS.humans, String(c.humansAlive), c.humansTotal != null ? `/${c.humansTotal}` : null, "Humans still in"));
    if (c.playersAlive != null) meta.append(chip(ICONS.land, String(c.playersAlive), null, "Players with land"));
    card.append(meta);

    if (c.teamGame && c.teams.length) {
      const split = el("div", "ov-split");
      split.setAttribute("role", "img");
      split.setAttribute("aria-label", c.teams.map((t) => `${t.name} ${O.sharePct(t.share)}`).join(", "));
      for (const t of c.teams) {
        if (!(t.share > 0)) continue;
        const seg = swatch(t.rgb, "ov-seg");
        seg.style.flexGrow = String(t.share);
        split.append(seg);
      }
      card.append(split);
      const teams = el("div", "ov-teams");
      for (const t of c.teams.slice(0, 8)) {
        const row = el("div", "ov-team");
        row.dataset.out = String(t.alive === 0);
        const pips = el("span", "ov-tpips");
        pips.title = `${t.alive} of ${t.total} still in`;
        for (let i = 0; i < Math.min(t.total, 8); i++) {
          const pip = el("span", "ov-tpip");
          pip.dataset.on = String(i < t.alive);
          pips.append(pip);
        }
        row.append(swatch(t.rgb), el("span", "ov-tname", t.name), pips, el("span", "ov-tpct", O.sharePct(t.share) ?? ""));
        teams.append(row);
      }
      card.append(teams);
    }

    const board = el("ol", "ov-board");
    board.setAttribute("aria-label", "Leaderboard by land");
    for (const r of c.board.slice(0, c.teamGame ? 6 : 10)) {
      const li = el("li", "ov-crow");
      li.dataset.alive = String(r.alive);
      const who = r.name ?? r.team ?? "Player";
      const name = el("span", "ov-cname", who);
      if (!r.name) name.dataset.masked = "true";
      const cell = el("span", "ov-cwho");
      cell.append(name);
      if (r.band && r.alive) {
        const dot = el("span", "ov-band");
        dot.dataset.band = r.band;
        dot.title = "World rank band";
        cell.append(dot);
      }
      const bar = el("span", "ov-cbar");
      const fill = el("span");
      fill.style.width = `${(r.frac * 100).toFixed(1)}%`;
      bar.append(fill);
      li.append(el("span", "ov-cplace", r.alive ? String(r.place ?? "") : "✕"), swatch(r.rgb), cell, bar, el("span", "ov-cpct", r.alive ? (O.sharePct(r.share) ?? "") : r.outAt != null ? O.clock(r.outAt) : "out"));
      board.append(li);
    }
    card.append(board);
    if (c.more) card.append(el("div", "ov-cmore", `+${c.more}`));

    if (c.feed.length) {
      const feed = el("ol", "ov-feed");
      feed.setAttribute("aria-label", "Eliminations, newest first");
      for (const f of c.feed.slice(0, 4)) {
        const li = el("li", "ov-out");
        const who = f.name ?? f.team ?? (f.human ? "Player" : "Nation");
        const name = el("span", "ov-cname", who);
        if (!f.name) name.dataset.masked = "true";
        li.append(icon(SKULL, "ov-skull"), el("span", "ov-otime", O.clock(f.at)), swatch(f.rgb), name);
        feed.append(li);
      }
      card.append(feed);
    }
    return card;
  }

  // The replay: the game's timelapse GIF, after the recap card, for opts.replay s.
  function replayCard(v, p) {
    const card = el("section", "ov-card ov-recap ov-replay");
    card.setAttribute("aria-label", "Replay of the game");
    const img = el("img");
    img.alt = "Replay of the game (timelapse)";
    img.decoding = "async";
    img.src = v.replay.gif; // a fresh element each time it shows: the GIF starts from its first frame
    const tag = el("span", "ov-replay-tag");
    tag.append(icon(PLAY), document.createTextNode("Replay"));
    card.append(img, tag);
    if (p.frac != null) {
      const timer = el("div", "ov-timer");
      const fill = el("span");
      fill.style.width = `${(p.frac * 100).toFixed(1)}%`;
      timer.append(fill);
      card.append(timer);
    }
    return card;
  }

  // Cards are rebuilt only when what they show changes, so their entry animation
  // plays once; the clock and the recap timer are updated in place every second.
  const shown = new Map(); // kind -> { node, sig }
  let ticker = null;
  function render() {
    const now = Date.now();
    const v = view(now);
    const vnow = v.vnow;
    const off = state.settings.enabled === false && !opts.demo;
    const kinds = O.layout(opts, { live: v.live, recap: v.recap, rank: v.rank, session: v.session, replay: v.replay, off }, vnow);
    const rs = O.recapState(v.recap, v.live, opts.recap, vnow);
    const ps = O.replayState(v.replay, v.recap, v.live, opts, vnow);
    const nodes = [];
    for (const kind of kinds) {
      let sig;
      let build;
      if (kind === "rank") {
        sig = JSON.stringify([v.name, v.rank, v.session]);
        build = () => rankCard(v);
      } else if (kind === "live") {
        const { at, seconds, caster, ...rest } = v.live;
        sig = JSON.stringify(rest);
        build = () => liveCard(v, vnow);
      } else if (kind === "caster") {
        const { at, seconds, top, share, place, ...rest } = v.live;
        sig = JSON.stringify(rest);
        build = () => casterCard(v, vnow);
      } else if (kind === "replay") {
        sig = `${v.replay.gameId}|${v.replay.at}|${v.replay.streamer}|${v.replay.gif.length}|${v.replay.gif.slice(-24)}`;
        build = () => replayCard(v, ps);
      } else {
        sig = `${v.recap.gameId}|${v.recap.at}|${v.recap.streamer}|${v.recap.png.length}|${v.recap.png.slice(-24)}`;
        build = () => recapCard(v, rs);
      }
      let entry = shown.get(kind);
      if (!entry || entry.sig !== sig) {
        const node = build();
        if (entry && kind !== "replay") node.style.animation = "none"; // an update, not an entrance
        entry = { node, sig };
        shown.set(kind, entry);
      }
      if (kind === "live" || kind === "caster") {
        const c = entry.node.querySelector("[data-clock]");
        if (c) c.textContent = O.clock(O.liveSeconds(v.live, vnow));
      }
      const timer = kind === "recap" ? rs : kind === "replay" ? ps : null;
      if (timer && timer.frac != null) {
        const f = entry.node.querySelector(".ov-timer > span");
        if (f) f.style.width = `${(timer.frac * 100).toFixed(1)}%`;
      }
      nodes.push(entry.node);
    }
    for (const kind of [...shown.keys()]) if (!kinds.includes(kind)) shown.delete(kind);
    const same = nodes.length === cardsEl.children.length && nodes.every((n, i) => cardsEl.children[i] === n);
    if (!same) cardsEl.replaceChildren(...nodes);

    // "delayed 90s", small, while the game cards run late
    const badge = $("delay");
    badge.hidden = !(v.delay > 0) || off;
    if (!badge.hidden) {
      const txt = v.waiting ? `delayed ${v.delay}s · buffering` : `delayed ${v.delay}s`;
      if (badge.lastChild?.textContent !== txt) badge.replaceChildren(icon(ICONS.clock), el("span", null, txt));
      badge.title = "The game cards run this many seconds late, so viewers cannot pass live information to players in that game.";
    }

    // one timer while something moves (the clock, the recap / replay countdowns, a
    // recap or a delayed state still to come - and a live card also has to go by
    // itself once its tab stops writing); none otherwise
    const moving = Boolean(v.live) || v.waiting || v.pending || (rs.show && rs.frac != null) || rs.startsIn != null || ps.show || ps.startsIn != null;
    if (moving && !ticker) ticker = setInterval(render, 1000);
    else if (!moving && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    editorState(v);
  }

  // ---- settings panel (?edit=1) ----------------------------------------------------
  function press(button, on) {
    button.setAttribute("aria-pressed", String(on));
    if (on) button.dataset.tone = "accent";
    else delete button.dataset.tone;
  }
  function syncEditor() {
    for (const b of $("ed-widgets").querySelectorAll("[data-w]")) press(b, opts.widgets.includes(b.dataset.w));
    for (const b of $("ed-pos").querySelectorAll("[data-pos]")) press(b, opts.pos === b.dataset.pos);
    for (const b of $("ed-bg").querySelectorAll("[data-bg]")) press(b, opts.bg === b.dataset.bg);
    $("ed-scale").value = String(opts.scale);
    $("ed-scale-out").textContent = `${Math.round(opts.scale * 100)}%`;
    if (document.activeElement !== $("ed-recap")) $("ed-recap").value = String(opts.recap);
    press($("ed-replay-on"), opts.replay > 0);
    $("ed-replay").disabled = !(opts.replay > 0);
    if (document.activeElement !== $("ed-replay")) $("ed-replay").value = String(opts.replay || O.DEFAULTS.replay);
    if (document.activeElement !== $("ed-delay")) $("ed-delay").value = String(opts.delay);
    press($("ed-name"), showName());
    $("ed-name").disabled = streamer();
    press($("ed-demo"), opts.demo);
  }

  const REPLAY_NOTES = {
    size: "The last replay was skipped: even small it was too big to hand over.",
    frames: "No replay for the last game: it needs Game > Timelapse on (with the recap and rank lookups) while the game runs.",
    error: "The last replay could not be made.",
  };
  // One line on what to do, and the state that explains an empty overlay.
  function editorState(v) {
    if (!opts.edit) return;
    $("ed-streamer").hidden = !streamer();
    // why the last replay did not come (the game tab says so in overlayReplay.note)
    const note = state.replay && !state.replay.gif && opts.replay > 0 ? REPLAY_NOTES[state.replay.note] ?? REPLAY_NOTES.error : "";
    $("ed-replay-note").hidden = !note;
    $("ed-replay-note").textContent = note;
    const box = $("ed-state");
    const s = state.settings;
    let title = null;
    let line = "";
    let kind = "empty";
    if (s.enabled === false) {
      title = "OpenFront Pro is switched off.";
      line = "Switch it on in its settings; the overlay stays empty until then.";
    } else if (opts.demo) {
      title = "Sample data.";
      line = "Made-up numbers to place the overlay. Switch it off before going live.";
    } else if (!state.self) {
      title = "Waiting for openfront.io.";
      line = "Open (or reload) openfront.io with this page open: the overlay learns your name and game from that tab.";
    } else if (s.dataConsent !== true) {
      title = "Rank lookups are off.";
      line = "The rank card shows today's games only.";
    } else if (v.rank.kind === "error") {
      kind = "error";
      title = "ofstats.io unreachable.";
      line = "Your rank comes back by itself once it answers.";
    } else {
      kind = "ok";
      title = "Ready.";
      if (opts.widgets.includes("caster")) line = v.live?.caster ? "The caster card follows the game you watch." : v.waiting ? `Buffering: the game shows ${v.delay} s late.` : "Watch a game (Tools, Observer): the caster card appears here.";
      else if (v.delay > 0 && opts.delayAuto) line = v.waiting ? `A game you watch: it shows ${v.delay} s late (delay=0 in the address turns that off).` : `A game you watch runs ${v.delay} s late.`;
      else line = v.live ? "The game card follows your game." : "The game card appears when you play.";
    }
    box.dataset.kind = kind;
    const text = el("span");
    text.append(el("span", "ofr-state-title", title), line);
    box.replaceChildren(text);
    box.hidden = false;
  }

  // The address for OBS: transparent, no settings panel, no sample data.
  function obsAddress() {
    return chrome.runtime.getURL("src/overlay.html") + O.buildQuery({ ...opts, bg: "transparent", demo: false }, { forObs: true });
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // not focused, or no permission: the old way
      const area = el("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  function setupEditor() {
    const how = $("ed-how");
    if (LAUNCHER) {
      how.append("OBS → ", el("b", null, "Browser source"), " → paste the address below → 1920×1080.");
      $("ed-url-label").textContent = "OBS address";
      const note = $("ed-url-note");
      note.dataset.tone = "warn";
      note.textContent = "It contains the launcher's secret key: never show it on stream or share it. It changes each time the launcher starts.";
    } else {
      how.append("OBS → ", el("b", null, "Window Capture"), " → this window → ", el("b", null, "Chroma Key"), " (green).");
      $("ed-url-note").textContent = "For a browser-source plugin that can open extension pages. Otherwise capture this window.";
      $("ed-window").hidden = false;
      try {
        chrome.windows?.getCurrent?.().then((w) => {
          if (w?.type === "popup") $("ed-window").hidden = true;
        }, () => {});
      } catch {
        // no windows API here
      }
    }

    $("ed-widgets").addEventListener("click", (e) => {
      const b = e.target.closest("[data-w]");
      if (!b) return;
      const on = opts.widgets.includes(b.dataset.w);
      const next = on ? opts.widgets.filter((w) => w !== b.dataset.w) : O.WIDGETS.filter((w) => w === b.dataset.w || opts.widgets.includes(w));
      // the caster card comes with its delay (and goes with it) unless one was set by hand
      const delay = opts.delayAuto ? O.defaultDelay(next) : opts.delay;
      setOptions({ widgets: next, delay });
    });
    $("ed-pos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pos]");
      if (b) setOptions({ pos: b.dataset.pos });
    });
    $("ed-bg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-bg]");
      if (b) setOptions({ bg: b.dataset.bg });
    });
    $("ed-scale").addEventListener("input", () => setOptions({ scale: Number($("ed-scale").value) || 1 }));
    $("ed-recap").addEventListener("change", () => {
      const n = Number($("ed-recap").value);
      setOptions({ recap: Number.isFinite(n) ? Math.max(0, Math.min(600, Math.round(n))) : O.DEFAULTS.recap });
    });
    $("ed-replay-on").addEventListener("click", () => setOptions({ replay: opts.replay > 0 ? 0 : Number($("ed-replay").value) || O.DEFAULTS.replay }));
    $("ed-replay").addEventListener("change", () => {
      const n = Number($("ed-replay").value);
      setOptions({ replay: Number.isFinite(n) ? Math.max(0, Math.min(600, Math.round(n))) : O.DEFAULTS.replay });
    });
    $("ed-delay").addEventListener("change", () => {
      const n = Number($("ed-delay").value);
      // a number typed in is a delay set by hand (0 included); an empty field goes back to automatic
      if ($("ed-delay").value.trim() === "" || !Number.isFinite(n)) setOptions({ delay: O.defaultDelay(opts.widgets), delayAuto: true });
      else setOptions({ delay: Math.max(0, Math.min(O.MAX_DELAY, Math.round(n))), delayAuto: false });
    });
    $("ed-name").addEventListener("click", () => setOptions({ name: !opts.name }));
    $("ed-demo").addEventListener("click", () => setOptions({ demo: !opts.demo }));
    $("ed-done").addEventListener("click", () => setOptions({ edit: false, demo: false }));
    $("gear").addEventListener("click", () => setOptions({ edit: true }));
    $("ed-copy").addEventListener("click", async (e) => {
      const b = e.currentTarget;
      const ok = await copy(obsAddress());
      b.dataset.state = ok ? "ok" : "error";
      b.textContent = ok ? "Copied ✓" : "Copy failed";
      setTimeout(() => {
        delete b.dataset.state;
        b.textContent = "Copy address";
      }, 1800);
    });
    $("ed-window").addEventListener("click", () => {
      const win = { ...opts, bg: opts.bg === "transparent" ? "green" : opts.bg, edit: true };
      chrome.runtime.sendMessage({ type: "openPage", page: "overlay", hash: `#${O.buildQuery(win).slice(1)}` }).catch(() => {});
    });
  }

  setupEditor();
  applyOptions();
  load();
})();
