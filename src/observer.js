// Observer page (src/observer.html): paste a game or lobby link, see whether that
// game is running, and watch it.
//
// The check goes through the worker ({ type: "observerCheck" }, behind the same
// rank-lookup agreement as the recap): OpenFront's own public endpoints are asked
// whether the game is there and what it is (map, mode, how many are in it, when it
// starts) - only the game id is sent. Watching is opening the game's link in a new
// tab: OpenFront seats anyone who opens a RUNNING game's link as a spectator. A
// lobby that has not started would seat you as a PLAYER (unless you pick Spectate
// in the lobby yourself), so it is never opened by itself: the page says so and
// offers "Remind me when it starts" (a gentle poll: every 15 s, 30 minutes at most,
// one per game across observer tabs; it stops by itself when there is nothing to
// wait for, or after a few answers that cannot tell - a game without a start time)
// or "Open lobby anyway". Watch is offered only once the start time is well past
// (OpenFront's own clock), with somebody playing. Nothing on openfront.io is
// clicked, nothing is sent to the game. Strings from the network only ever go
// through textContent.
(() => {
  const O = globalThis.OFR_OBSERVER;
  const THEMES = globalThis.OFR_THEMES ?? {};
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }
  // line icons (static paths of our own)
  function icon(paths, extra = []) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "ob-ico");
    for (const d of paths) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      s.append(p);
    }
    for (const [cx, cy, r] of extra) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", cx);
      c.setAttribute("cy", cy);
      c.setAttribute("r", r);
      s.append(c);
    }
    return s;
  }
  const ICONS = {
    map: [["M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z", "M9 4v14M15 6v14"]],
    mode: [["M4 20l6-6M14 10l6-6M4 4l16 16", "M15 4h5v5M4 15v5h5"]],
    players: [["M4 20c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6", "M16 14.6c2.4.3 4 2.2 4 4.9"], [[10, 8.5, 3.5], [16.5, 8, 2.5]]],
    eye: [["M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"], [[12, 12, 3]]],
    door: [["M5 21V4l9-1.5V21", "M14 5h5v16", "M11 12h.01"]],
    bell: [["M6 16V11a6 6 0 0 1 12 0v5l2 2H4z", "M10 20a2 2 0 0 0 4 0"]],
    retry: [["M4 12a8 8 0 0 1 14-5.3L20 9", "M20 4v5h-5", "M20 12a8 8 0 0 1-14 5.3L4 15", "M4 20v-5h5"]],
  };
  const ic = (name) => icon(...ICONS[name]);
  function button(text, onClick, { cls = "", iconName = null, disabled = false, title = null } = {}) {
    const b = el("button", `ofr-btn ${cls}`.trim());
    b.type = "button";
    if (iconName) b.append(ic(iconName));
    b.append(document.createTextNode(text));
    b.disabled = disabled;
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
  const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
  const MODE_SHORT = { "Free For All": "FFA" };

  const state = {
    id: null,
    status: null, // OFR_OBSERVER.gameStatus
    at: 0, // when it was fetched (local clock)
    busy: false,
    fullAt: null, // server time this game was first seen full (it started by filling up)
    remind: null, // { since, timer, next, unsure } while "Remind me when it starts" runs
    remindNote: null, // why the reminder stopped by itself (shown under the card)
    follow: null, // the one re-check when a known start is due
    notified: false,
  };
  const TITLE = document.title;
  // Observer pages in other tabs: one reminder per game, one notification per game.
  const TAB = `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  let channel = null;
  try {
    channel = new BroadcastChannel("ofr-observer");
  } catch {
    // no channel here: this page reminds on its own
  }
  const tell = (msg) => {
    try {
      channel?.postMessage({ ...msg, tab: TAB });
    } catch {
      // closed
    }
  };

  // ---- checking ---------------------------------------------------------------------------
  async function check(id, { quiet = false } = {}) {
    state.id = id;
    state.busy = !quiet;
    if (!quiet) render();
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: "observerCheck", gameId: id });
    } catch {
      res = { id, error: "the extension's worker did not answer" };
    }
    if (state.id !== id) return; // another game was asked for meanwhile
    state.busy = false;
    state.at = Date.now();
    state.status = O.gameStatus(res, state.at, { fullAt: state.fullAt });
    if (!state.status.id) state.status.id = id;
    if (Number.isFinite(state.status.fullAt)) state.fullAt = state.status.fullAt;
    // one follow-up of our own when a known start is due (the Watch button needs
    // it), however far away; the reminder's own checks take over while it runs
    clearTimeout(state.follow);
    state.follow = null;
    const due = O.followUpIn(state.status);
    if (due != null && !state.remind) state.follow = setTimeout(() => state.id === id && !state.remind && check(id, { quiet: true }), due);
    render();
    if (state.remind) remindStep();
  }

  function submit(e) {
    e?.preventDefault();
    const { id, error } = O.parseLink($("ob-link").value);
    const hint = $("ob-hint");
    if (!id) {
      hint.dataset.tone = "error";
      hint.textContent = error === "empty" ? "Paste a game link or its id first." : "That is not a game link or id (OpenFront ids are 8 to 10 letters and digits).";
      return;
    }
    delete hint.dataset.tone;
    hint.textContent = "A game link, a lobby link (#join=…, /join/…) or the id.";
    stopRemind();
    clearTimeout(state.follow);
    state.follow = null;
    if (id !== state.id) state.fullAt = null;
    state.notified = false;
    state.remindNote = null;
    state.status = null;
    check(id);
  }

  // ---- "Remind me when it starts" ------------------------------------------------------------
  function startRemind() {
    stopRemind();
    // the reminder's checks replace the page's own follow-up
    clearTimeout(state.follow);
    state.follow = null;
    state.remindNote = null;
    state.remind = { since: Date.now(), timer: null, next: null, unsure: 0 };
    tell({ kind: "remind", id: state.id }); // another tab reminding of this game stops
    remindStep();
    render();
  }
  function stopRemind() {
    if (state.remind?.timer) clearTimeout(state.remind.timer);
    state.remind = null;
    document.title = TITLE;
  }
  // One notification per game, however many observer pages wait for it: the first
  // to see the start claims it (storage, then the channel for pages open now).
  async function notifyOnce(s) {
    if (state.notified) return;
    state.notified = true;
    const id = state.id;
    tell({ kind: "started", id });
    try {
      const got = (await chrome.storage.local.get("observerNotified"))?.observerNotified;
      if (got && got.id === id && Date.now() - got.at < O.REMIND_FOR_MS) return;
      await chrome.storage.local.set({ observerNotified: { id, at: Date.now() } });
    } catch {
      // no storage: notify anyway
    }
    chrome.runtime.sendMessage({ type: "notify", title: "The game you are waiting for started", message: [s.map, s.mode, "Watch it from the observer page"].filter(Boolean).join(" · ") }).catch(() => {});
  }
  const REMIND_NOTES = {
    unsure: "Reminder stopped: OpenFront gives no start time for this game, so its start cannot be told. Check again later.",
    missing: "Reminder stopped: OpenFront has no game with this id any more.",
    legacy: "Reminder stopped: an old-style id, nothing will start.",
    ended: "Reminder stopped: the game is over.",
    time: "Reminder stopped after 30 minutes.",
    moved: "The reminder for this game now runs in another observer tab.",
  };
  function remindStep() {
    const r = state.remind;
    if (!r) return;
    clearTimeout(r.timer);
    const s = state.status;
    r.unsure = s?.state === "unknown" ? r.unsure + 1 : 0;
    if (O.canWatch(s)) {
      // it started: say so, and leave the watching to the user
      stopRemind();
      document.title = `● Live · ${TITLE}`;
      notifyOnce(s);
      render();
      return;
    }
    const wait = O.remindNext(s, r.since, Date.now(), r.unsure);
    if (wait == null) {
      // 30 minutes, nothing left to wait for, or no way to tell
      state.remindNote = s?.state === "unknown" ? REMIND_NOTES.unsure : (REMIND_NOTES[s?.state] ?? (s && ["consent", "off"].includes(s.state) ? null : REMIND_NOTES.time));
      stopRemind();
      render();
      return;
    }
    r.timer = setTimeout(() => check(state.id, { quiet: true }), wait);
    r.next = Date.now() + wait;
  }
  channel?.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object" || m.tab === TAB || typeof m.id !== "string" || m.id !== state.id) return;
    if (m.kind === "remind" && state.remind) {
      stopRemind(); // the newest reminder of a game wins
      state.remindNote = REMIND_NOTES.moved;
      render();
    } else if (m.kind === "started") {
      state.notified = true; // that page notified
      if (state.remind) {
        stopRemind();
        check(state.id, { quiet: true });
      }
    }
  });

  // ---- drawing ------------------------------------------------------------------------------
  const STATUS_TEXT = {
    started: "Live",
    starting: "Starting",
    countdown: "In the lobby",
    unknown: "State unknown",
    empty: "No one is playing",
    ended: "Game over",
    missing: "Not found",
    legacy: "Old game id",
    error: "No answer",
    consent: "Not checked",
    off: "Switched off",
  };
  function tile(iconName, label, value, sub = null, fill = null) {
    const t = el("div", "ob-tile");
    const lab = el("span", "ob-tile-lab");
    lab.append(ic(iconName), document.createTextNode(label));
    const val = el("span", "ob-tile-val", value);
    if (sub) val.append(el("small", null, sub));
    t.append(lab, val);
    if (fill != null) {
      const bar = el("div", "ob-fill");
      const f = el("span");
      f.style.width = `${Math.round(Math.max(0.02, Math.min(1, fill)) * 100)}%`;
      bar.append(f);
      t.append(bar);
    }
    return t;
  }
  function warn(title, line) {
    const box = $("ob-warn");
    const text = el("span");
    text.append(el("span", "ofr-state-title", title), line);
    box.replaceChildren(text);
    box.hidden = false;
  }
  const openGame = () => {
    const url = O.watchUrl(state.id);
    if (url) chrome.tabs.create({ url });
  };

  function render() {
    const card = $("ob-game");
    const s = state.status;
    card.hidden = !state.busy && !s;
    if (card.hidden) return;
    const since = (Date.now() - state.at) / 1000;
    card.dataset.busy = String(state.busy);
    $("ob-id").textContent = state.id ?? "";
    $("ob-warn").hidden = true;
    $("ob-remind").hidden = !state.remind;
    const actions = $("ob-actions");
    actions.replaceChildren();
    const tiles = $("ob-tiles");
    tiles.replaceChildren();
    if (state.busy || !s) {
      card.dataset.state = "busy";
      $("ob-status").textContent = "Checking…";
      return;
    }
    card.dataset.state = s.state;
    let status = STATUS_TEXT[s.state] ?? "No answer";
    // a countdown that ran out waits for its re-check (O.followUpIn): not "0:00"
    if (s.state === "countdown") status = s.startsIn - since > 0 ? `Starts in ${mmss(s.startsIn - since)}` : "Starting…";
    if (s.state === "started" && Number.isFinite(s.since)) status = `Live · ${mmss(s.since + since)}`;
    $("ob-status").textContent = status;

    if (s.map || s.mode || s.players != null) {
      const teams = typeof s.teams === "number" && s.teams > 1 ? `${s.teams} teams` : typeof s.teams === "string" ? s.teams : null;
      tiles.append(
        tile("map", "Map", s.map || "?"),
        tile("mode", "Mode", teams ?? MODE_SHORT[s.mode] ?? (s.mode || "?")),
        tile("players", "Players", String(s.players ?? "?"), s.maxPlayers ? `/${s.maxPlayers}` : null, s.maxPlayers ? (s.players ?? 0) / s.maxPlayers : null),
      );
      if (s.spectators) tiles.append(tile("eye", "Watching", String(s.spectators)));
    }

    if (O.canWatch(s)) {
      actions.append(button("Watch", openGame, { cls: "ofr-btn-primary ofr-btn-lg", iconName: "eye" }));
      actions.append(el("p", "ob-note", "Opens the game's link in a new tab: you join as a spectator. The caster panel opens there."));
    } else if (s.state === "starting") {
      const wait = Math.max(1, Math.ceil(s.watchIn - since));
      actions.append(
        button(`Watch in ${wait} s`, () => {}, {
          cls: "ofr-btn-primary ofr-btn-lg",
          iconName: "eye",
          disabled: true,
          title: "OpenFront starts the game a few seconds after its start time (a join before that is a player's) and refuses any other join for 5 s after it",
        }),
      );
    } else if (s.state === "countdown") {
      warn(
        "Not started yet.",
        " Opening it now joins the lobby as a player, unless you choose Spectate in the lobby yourself. Once the game runs, its link seats you as a spectator.",
      );
      if (!state.remind) actions.append(button("Remind me when it starts", startRemind, { cls: "ofr-btn-primary ofr-btn-lg", iconName: "bell" }));
      actions.append(button("Open lobby anyway", openGame, { cls: "ofr-btn-lg", iconName: "door", title: "You join the lobby as a player unless you pick Spectate there" }));
    } else if (s.state === "unknown") {
      if (s.reason === "clock") warn("Cannot tell whether it started.", " OpenFront's answer carried no server time. If it is still a lobby, opening it joins as a player.");
      else
        warn(
          "No start time.",
          " This game is either still in its lobby (waiting for its host) or it started when the lobby filled up - OpenFront does not say which. If it is a lobby, opening it joins as a player, unless you choose Spectate there.",
        );
      actions.append(button("Check again", () => check(state.id), { cls: "ofr-btn-primary ofr-btn-lg", iconName: "retry" }));
      if (!state.remind && s.reason !== "clock") actions.append(button("Remind me when it starts", startRemind, { cls: "ofr-btn-lg", iconName: "bell", title: `Checks every 15 s for a start countdown or a full lobby; stops after ${O.REMIND_UNSURE_TRIES} checks that still cannot tell` }));
      actions.append(button("Open anyway", openGame, { iconName: "door", title: "A lobby seats you as a player unless you pick Spectate there" }));
    } else if (s.state === "empty") {
      actions.append(el("p", "ob-note", "Its start time has passed, but nobody is connected as a player: OpenFront does not start a game without players, and joining now could seat you as one."));
      actions.append(button("Check again", () => check(state.id), { cls: "ofr-btn-primary", iconName: "retry" }));
    } else if (s.state === "ended") {
      actions.append(el("p", "ob-note", "This game is over: there is nothing to watch live. Its record is on OpenFront."));
    } else if (s.state === "missing") {
      actions.append(el("p", "ob-note", "OpenFront has no running game or lobby with this id, and no finished one."));
    } else if (s.state === "legacy") {
      actions.append(el("p", "ob-note", "An old-style id (8 characters): games running now have 10. Nothing to watch."));
    } else if (s.state === "consent") {
      actions.append(el("p", "ob-note", "Checking a game sends its id to OpenFront, so it waits for your agreement to lookups."));
      actions.append(button("Read and turn on", () => chrome.runtime.sendMessage({ type: "openWelcome" }).catch(() => {}), { cls: "ofr-btn-primary" }));
    } else if (s.state === "off") {
      actions.append(el("p", "ob-note", "OpenFront Pro is switched off (its settings, top switch)."));
    } else {
      warn("OpenFront did not answer.", " If you open it anyway: a running game seats you as a spectator, a lobby as a player.");
      const retry = button("Try again", () => check(state.id), { cls: "ofr-btn-primary", iconName: "retry" });
      if (s.detail) retry.title = s.detail;
      actions.append(retry, button("Open anyway", openGame, { iconName: "door" }));
    }
    if (state.remindNote && !state.remind) actions.append(el("p", "ob-note ob-remind-note", state.remindNote));

    if (state.remind) {
      const left = O.REMIND_FOR_MS - (Date.now() - state.remind.since);
      $("ob-remind-title").textContent = s.state === "countdown" && s.startsIn - since > 0 ? `Waiting for the start · ${mmss(s.startsIn - since)}` : "Waiting for the start";
      const next = Math.max(0, Math.round(((state.remind.next ?? Date.now()) - Date.now()) / 1000));
      $("ob-remind-line").textContent = `Next check in ${next} s · gives up in ${mmss(left / 1000)}`;
      $("ob-ring").setAttribute("stroke-dasharray", `${((1 - left / O.REMIND_FOR_MS) * 100).toFixed(1)} 100`);
    }
  }

  // ---- start ----------------------------------------------------------------------------------
  function applyTheme(id) {
    if (THEMES[id] && id !== "classic") document.documentElement.dataset.ofrTheme = id;
    else delete document.documentElement.dataset.ofrTheme;
  }
  async function start() {
    $("ob-form").addEventListener("submit", submit);
    $("ob-remind-stop").addEventListener("click", () => {
      stopRemind();
      render();
    });
    $("ob-overlay").addEventListener("click", () => chrome.runtime.sendMessage({ type: "openPage", page: "overlay", hash: "#w=caster" }).catch(() => {}));
    try {
      const sync = await chrome.storage.sync.get({ theme: "classic" });
      applyTheme(sync.theme);
    } catch {
      // defaults
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.theme) applyTheme(changes.theme.newValue);
      // the worker answers "off" / "consent" by itself: just ask again
      if ((changes.dataConsent || changes.enabled) && state.id && !state.busy) check(state.id, { quiet: true });
    });
    // the countdowns tick here; the network is asked only on a check, by the one
    // follow-up when a known start is due, or by the reminder
    setInterval(() => {
      const s = state.status;
      if (state.remind || s?.state === "countdown" || s?.state === "starting" || s?.state === "started") render();
    }, 1000);
    $("ob-link").focus();
  }
  start();
})();
