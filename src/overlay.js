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
  };

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
      state.info = name && s.dataConsent !== true ? { found: false, reason: "consent" } : null;
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
    state.info = info;
    render();
    // the worker's cache holds a hit for 10 minutes: ask again after that
    lookupTimer = setTimeout(() => lookupSelf(), 10 * 60 * 1000);
  }

  function setSelf(raw) {
    const name = raw && typeof raw.name === "string" ? raw.name.slice(0, 60) : null;
    if (name === (state.self?.name ?? null)) return;
    state.self = name ? { name } : null;
    state.info = undefined;
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
      const local = await chrome.storage.local.get(["overlaySelf", "session", "overlayLive", "overlayRecap"]);
      state.session = local.session ?? null;
      state.live = local.overlayLive ?? null;
      state.recap = O.sanitizeRecap(local.overlayRecap);
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
    if (changes.overlayLive) state.live = changes.overlayLive.newValue ?? null;
    if (changes.overlayRecap) state.recap = O.sanitizeRecap(changes.overlayRecap.newValue);
    if (changes.session) {
      state.session = changes.session.newValue ?? null;
      lookupSelf({ soon: true }); // a game was recorded: the rank may have moved
    }
    if (changes.overlayLive || changes.overlayRecap || changes.session) render();
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
  function view(now) {
    const d = opts.demo ? O.demo(now) : null;
    const rank = O.rankView(d ? d.info : state.info, S);
    const session = O.sessionView(d ? d.session : state.session, today(), { maxPips: 10 });
    const hide = streamer();
    return {
      name: showName() ? (d ? d.name : (state.self?.name ?? null)) : null,
      rank: hide ? O.hideRank(rank) : rank,
      session: hide ? { ...session, drift: null } : session,
      live: O.sanitizeLive(d ? d.live : state.live, now),
      recap: O.recapFor(state.recap, masked()),
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

  // Cards are rebuilt only when what they show changes, so their entry animation
  // plays once; the clock and the recap timer are updated in place every second.
  const shown = new Map(); // kind -> { node, sig }
  let ticker = null;
  function render() {
    const now = Date.now();
    const v = view(now);
    const off = state.settings.enabled === false && !opts.demo;
    const kinds = O.layout(opts, { live: v.live, recap: v.recap, rank: v.rank, session: v.session, off }, now);
    const rs = O.recapState(v.recap, v.live, opts.recap, now);
    const nodes = [];
    for (const kind of kinds) {
      let sig;
      let build;
      if (kind === "rank") {
        sig = JSON.stringify([v.name, v.rank, v.session]);
        build = () => rankCard(v);
      } else if (kind === "live") {
        const { at, seconds, ...rest } = v.live;
        sig = JSON.stringify(rest);
        build = () => liveCard(v, now);
      } else {
        sig = `${v.recap.gameId}|${v.recap.at}|${v.recap.streamer}|${v.recap.png.length}|${v.recap.png.slice(-24)}`;
        build = () => recapCard(v, rs);
      }
      let entry = shown.get(kind);
      if (!entry || entry.sig !== sig) {
        const node = build();
        if (entry) node.style.animation = "none"; // an update, not an entrance
        entry = { node, sig };
        shown.set(kind, entry);
      }
      if (kind === "live") {
        const c = entry.node.querySelector("[data-clock]");
        if (c) c.textContent = O.clock(O.liveSeconds(v.live, now));
      }
      if (kind === "recap" && rs.frac != null) {
        const f = entry.node.querySelector(".ov-timer > span");
        if (f) f.style.width = `${(rs.frac * 100).toFixed(1)}%`;
      }
      nodes.push(entry.node);
    }
    for (const kind of [...shown.keys()]) if (!kinds.includes(kind)) shown.delete(kind);
    const same = nodes.length === cardsEl.children.length && nodes.every((n, i) => cardsEl.children[i] === n);
    if (!same) cardsEl.replaceChildren(...nodes);

    // one timer while something moves (the clock, the recap countdown - and a live
    // card also has to go by itself once its tab stops writing); none otherwise
    const moving = Boolean(v.live) || (rs.show && rs.frac != null);
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
    press($("ed-name"), showName());
    $("ed-name").disabled = streamer();
    press($("ed-demo"), opts.demo);
  }

  // One line on what to do, and the state that explains an empty overlay.
  function editorState(v) {
    if (!opts.edit) return;
    $("ed-streamer").hidden = !streamer();
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
      line = v.live ? "The game card follows your game." : "The game card appears when you play.";
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
      setOptions({ widgets: next });
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
