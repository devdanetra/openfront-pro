// Clan hub (src/clans.html): ofstats' weekly clan table, one clan's page, two
// clans side by side, and recruits from players this browser has already seen.
// Opened by the worker's "openPage" route (popup Tools tab, the dashboard's clan
// section), optionally with #tag=XYZ.
//
// Graphics first; exact figures are in hover titles. Every network string goes
// through textContent / title, never markup. Only chrome.storage.sync/local
// get + onChanged, runtime.sendMessage and runtime.getURL are used, so the
// companion launcher's page shim runs this page too.
//
// Network: everything goes through the worker (consent gate, queue, cache):
//   clanTable {week}  - /clans?limit=50[&week=]   (the week shown and the one before, for movers)
//   clan {tag}        - /clans/<TAG>
//   lookup {usernames}- /players/<"[TAG] name">   (members, 6 per batch, at most 50 per clan page, 12 per side in Compare)
// Recruits read one chrome.storage.local key only (the worker's small index of
// untagged players, L.RECRUIT_KEY): no request at all.
(() => {
  const C = globalThis.OFR_CHARTS;
  const S = globalThis.OFR_SCORING;
  const L = globalThis.OFR_CLAN_LOGIC;
  const view = document.getElementById("view");
  const tabsEl = document.getElementById("tabs");
  const bannerEl = document.getElementById("banner");
  const NS = "http://www.w3.org/2000/svg";

  // ---- small helpers --------------------------------------------------------------------------
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };
  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  const lower = (s) => String(s ?? "").toLowerCase();
  const fmtExact = (v) => (fin(v) ? Math.round(v).toLocaleString() : "—");
  const fmtBig = (v) =>
    !fin(v) ? "—" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v));
  const pct0 = (f) => (fin(f) ? `${Math.round(f * 100)}%` : "—");
  const pct1 = (f) => (fin(f) ? `${(f * 100).toFixed(1)}%` : "—");
  const topText = (pct) => `Top ${S.formatPercent(pct)}%`;
  const daysText = (d) => (d == null ? "unknown" : d < 1 ? "today" : d < 2 ? "yesterday" : `${Math.floor(d)} days ago`);
  const shortWeek = (w) => (L.weekNumber(w) ? `W${L.weekNumber(w)}` : String(w ?? ""));
  const dayText = (ms) => (fin(ms) ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
  const playerUrl = (name) => `https://ofstats.io/player/${encodeURIComponent(name)}`;
  const gameUrl = (id) => `https://ofstats.io/game/${encodeURIComponent(id)}`;
  const icon = (name) => C.icon(name);

  function button(text, cls, onClick, { label = null, title = null } = {}) {
    const b = el("button", cls, text);
    b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
  function stateEl(kind, title, text, actions = []) {
    const p = el("p", "ofr-state");
    p.dataset.kind = kind;
    const span = el("span");
    if (title) span.append(el("span", "ofr-state-title", title));
    if (text) span.append(text);
    if (actions.length) {
      const a = el("span", "ofr-state-actions");
      a.append(...actions);
      span.append(a);
    }
    p.append(span);
    return p;
  }
  function card(title, iconName = null, { wide = false, tip = null } = {}) {
    const sec = el("section", `ofr-card hub-card${wide ? " wide" : ""}`);
    const h = el("h2", "ofr-eyebrow");
    if (iconName) h.append(icon(iconName));
    h.append(title);
    if (tip) {
      const i = icon("info");
      const wrap = el("span");
      wrap.title = tip;
      wrap.setAttribute("aria-label", tip);
      wrap.append(i);
      h.append(wrap);
    }
    sec.append(h);
    return sec;
  }
  const goto = (hash) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  };

  // ---- settings, theme, you ---------------------------------------------------------------------
  const settings = { theme: "classic", streamerMode: false, dataConsent: false, enabled: true };
  // Your ofstats name, written locally by the extension on openfront.io
  // (content.js, whenever it reads your name there; also the home card and the
  // dashboard). Used to leave you out of Recruits and, in streamer mode, to
  // show "You" instead of your name. Unknown in streamer mode: every name is
  // masked (L.displayName).
  let self = null;
  function applyTheme() {
    const themes = globalThis.OFR_THEMES ?? {};
    if (settings.theme && settings.theme !== "classic" && themes[settings.theme]) document.documentElement.dataset.ofrTheme = settings.theme;
    else delete document.documentElement.dataset.ofrTheme;
  }
  const who = () => ({ streamer: settings.streamerMode, self });
  const shown = (name) => L.displayName(name, who());
  const hidden = (name) => L.nameHidden(name, who()); // no link, no real name in a tooltip
  const masking = () => settings.streamerMode && !self;
  const myTag = () => L.splitName(self ?? "").tag;

  // ---- data, through the worker -----------------------------------------------------------------
  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return null;
    }
  }
  const refused = (r) => r?.error === "consent" || r?.reason === "consent";
  const tables = new Map();
  function table(week) {
    const k = week ?? "current";
    if (!tables.has(k)) {
      tables.set(
        k,
        send({ type: "clanTable", week: week ?? undefined }).then((r) => {
          if (!r?.found) tables.delete(k);
          return r;
        }),
      );
    }
    return tables.get(k);
  }
  const clans = new Map();
  function clanGet(tag) {
    if (!clans.has(tag)) {
      clans.set(
        tag,
        send({ type: "clan", tag }).then((r) => {
          if (!r?.found) clans.delete(tag);
          return r;
        }),
      );
    }
    return clans.get(tag);
  }
  const players = new Map(); // lowercased ofstats name -> lookup value
  // Names whose lookup got no answer (ofstats or the worker unreachable, no
  // reply at all, refused): shown "offline" rather than pending forever, asked
  // again by Retry or the next time the view opens.
  const failedNames = new Set();
  // Batches of 6 (the worker runs 6 at a time anyway), one after another, so a
  // big clan never floods ofstats; onBatch redraws what depends on them.
  async function lookupMany(names, alive, onBatch) {
    for (let i = 0; i < names.length; i += 6) {
      if (!alive()) return;
      const batch = names.slice(i, i + 6).filter((n) => !players.has(lower(n)));
      if (batch.length) {
        for (const n of batch) failedNames.delete(lower(n)); // pending again while asked
        const r = await send({ type: "lookup", usernames: batch });
        for (const n of batch) {
          const v = r?.[n];
          if (v && v.reason !== "consent" && v.reason !== "error") players.set(lower(n), v);
          else failedNames.add(lower(n));
        }
      }
      if (!alive()) return;
      onBatch?.(Math.min(names.length, i + 6));
    }
  }

  // ---- shared pieces ------------------------------------------------------------------------------
  function spark(values, { title = "", label = "trend", invert = true } = {}) {
    const svg = document.createElementNS(NS, "svg");
    const w = 96;
    const h = 26;
    const pad = 3;
    svg.setAttribute("class", "ofr-chart hub-spark");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => fin(v));
    if (pts.length < 2) return svg;
    const vals = pts.map(([, v]) => v);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const sx = (i) => (pad + ((w - 2 * pad) * i) / Math.max(1, values.length - 1)).toFixed(1);
    const sy = (v) => {
      const t = (v - lo) / (hi - lo || 1);
      return (invert ? pad + (h - 2 * pad) * t : h - pad - (h - 2 * pad) * t).toFixed(1);
    };
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", "ofr-chart-line");
    path.setAttribute("d", pts.map(([i, v], n) => `${n ? "L" : "M"}${sx(i)} ${sy(v)}`).join(" "));
    const [li, lv] = pts[pts.length - 1];
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("class", "ofr-chart-dot");
    dot.setAttribute("cx", sx(li));
    dot.setAttribute("cy", sy(lv));
    dot.setAttribute("r", "2.5");
    if (title) {
      const t = document.createElementNS(NS, "title");
      t.textContent = title;
      svg.append(t);
    }
    svg.append(path, dot);
    return svg;
  }

  function ringCard(frac, value, name, title, { kind = "good", band = null, marker = null } = {}) {
    const box = el("div", "ofr-modering");
    box.title = title;
    box.append(C.ring({ frac, value, size: 86, thickness: 9, kind: band ? null : kind, band, marker, label: title }), el("span", "ofr-modering-name", name));
    return box;
  }

  function badgeFor(info, failed = false) {
    const b = el("span", "ofr-badge");
    if (info === undefined && failed) {
      b.dataset.ofrKind = "missing";
      b.dataset.ofrReason = "error";
      b.textContent = "offline";
      b.title = "ofstats.io did not answer for this member. Retry above the list";
      return b;
    }
    if (info === undefined) {
      b.dataset.ofrKind = "pending";
      b.textContent = "…";
      b.title = "Looking up";
      return b;
    }
    const p = L.profile(info);
    if (p && fin(p.pct)) {
      b.dataset.ofrKind = "percentile";
      b.dataset.ofrBand = p.band;
      b.textContent = topText(p.pct);
      b.title = `${topText(p.pct)} of players (${p.ratio.toFixed(2)}x an average player's wins)`;
    } else if (p) {
      b.dataset.ofrKind = "winrate";
      b.textContent = pct0(p.winRate);
      b.title = `Too few rated games for a rank. ${fmtExact(p.wins)} of ${fmtExact(p.games)} won`;
    } else {
      b.dataset.ofrKind = "missing";
      b.textContent = "new";
      b.title = "No finished public games on ofstats.io under this name";
    }
    return b;
  }

  function stripEl(recent) {
    const strip = el("span", "ofr-dash-strip");
    strip.setAttribute("role", "img");
    const wins = recent.filter((g) => g.won).length;
    strip.setAttribute("aria-label", `Last ${recent.length}: ${wins} won`);
    strip.title = `Last ${recent.length} games, newest first: ${wins} won`;
    for (const g of recent) {
      const c = el("span", "ofr-dash-strip-cell");
      c.dataset.fate = g.won ? "won" : "lost";
      if (g.mode === "team") c.dataset.mode = "team";
      if (g.mode === "ranked") c.dataset.mode = "duel";
      c.title = `${g.won ? "Won" : "Lost"}${g.map ? ` · ${g.map}` : ""}${g.date ? ` · ${dayText(g.date)}` : ""}`;
      strip.append(c);
    }
    return strip;
  }

  // One player as pictures: rank gauge, win rate against an average player in
  // the same lobbies, last ten, modes, last seen. name: the ofstats name.
  function profileEl(p, name) {
    const wrap = el("div", "hub-prof");
    const who = shown(name);
    const hide = hidden(name);
    wrap.append(
      C.ring({
        frac: fin(p.pct) ? 1 - p.pct / 100 : 0,
        sweep: 260,
        size: 76,
        thickness: 9,
        band: p.band,
        pre: fin(p.pct) ? "top" : null,
        value: fin(p.pct) ? `${S.formatPercent(p.pct)}%` : "—",
        label: fin(p.pct) ? `${who}: ${topText(p.pct)}` : `${who}: not ranked`,
        title: fin(p.pct) ? `${topText(p.pct)} of players, from ${fmtExact(p.games)} games` : "Too few rated games for a rank",
      }),
    );
    const body = el("div", "hub-prof-body");
    const l1 = el("div", "hub-prof-line");
    l1.append(el("span", "hub-prof-name", who));
    const seen = el("span", "hub-seen");
    seen.append(icon("clock"), daysText(p.lastSeenDays));
    seen.title = `Last game on ofstats.io: ${daysText(p.lastSeenDays)}`;
    l1.append(seen);
    if (!hide) {
      const a = el("a", "hub-out", "ofstats.io ↗");
      a.href = playerUrl(name);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = `Open ${name} on ofstats.io`;
      l1.append(a);
    }
    body.append(l1);
    const l2 = el("div", "hub-prof-line");
    const wr = C.meter({
      frac: p.winRate ?? 0,
      kind: "good",
      mark: fin(p.expectedRate) ? { frac: p.expectedRate, title: `An average player in the same lobbies: ${pct1(p.expectedRate)}` } : null,
      title: `Win rate ${pct1(p.winRate)}: ${fmtExact(p.wins)} of ${fmtExact(p.games)}${fin(p.expectedRate) ? ` (an average player: ${pct1(p.expectedRate)})` : ""}`,
      label: `win rate ${pct0(p.winRate)}`,
    });
    l2.append(wr, el("span", "hub-dim", pct0(p.winRate)));
    if (p.recent.length) l2.append(stripEl(p.recent));
    body.append(l2);
    const parts = [
      { label: "FFA", value: p.modes.ffa.games, text: `${fmtExact(p.modes.ffa.games)} games, ${fmtExact(p.modes.ffa.wins)} won`, slot: 1 },
      { label: "Team", value: p.modes.team.games, text: `${fmtExact(p.modes.team.games)} games, ${fmtExact(p.modes.team.wins)} won`, slot: 3 },
      { label: "Ranked", value: p.modes.ranked.games, text: `${fmtExact(p.modes.ranked.games)} games, ${fmtExact(p.modes.ranked.wins)} won`, slot: 4 },
    ];
    if (parts.some((x) => x.value > 0)) {
      const l3 = el("div", "hub-prof-line");
      l3.append(C.stacked({ parts }));
      body.append(l3);
    }
    wrap.append(body);
    return wrap;
  }

  // ---- views ---------------------------------------------------------------------------------------
  const TABS = [
    { id: "board", label: "Leaderboard", icon: "trophy" },
    { id: "clan", label: "Clan", icon: "shield" },
    { id: "compare", label: "Compare", icon: "swords" },
    { id: "recruits", label: "Recruits", icon: "target" },
  ];
  const last = { tag: null, a: null, b: null, week: null };
  function hashFor(id) {
    if (id === "board") return last.week ? `#week=${last.week}` : "#board";
    if (id === "clan") return last.tag ? `#tag=${last.tag}` : "#clan";
    if (id === "compare") return last.a ? `#vs=${last.a}${last.b ? `&with=${last.b}` : ""}` : "#vs=";
    return "#recruits";
  }
  // Built once, then only updated: rebuilding on every hashchange dropped the
  // keyboard focus, so the arrow keys moved one tab and stopped.
  function drawTabs(active) {
    if (!tabsEl.childElementCount) {
      tabsEl.append(
        ...TABS.map((t) => {
          const b = el("button", "ofr-tab");
          b.type = "button";
          b.setAttribute("role", "tab");
          b.dataset.tab = t.id;
          b.append(icon(t.icon), t.label);
          b.addEventListener("click", () => goto(hashFor(t.id)));
          return b;
        }),
      );
    }
    for (const b of tabsEl.querySelectorAll(".ofr-tab")) {
      const on = b.dataset.tab === active;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  tabsEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const all = [...tabsEl.querySelectorAll(".ofr-tab")];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    const next = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    next.focus();
    next.click();
  });

  function route() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has("tag")) return { view: "clan", tag: L.normTag(p.get("tag")) };
    if (p.has("clan")) return { view: "clan", tag: null };
    if (p.has("vs")) return { view: "compare", a: L.normTag(p.get("vs")), b: L.normTag(p.get("with")) };
    if (p.has("recruits")) return { view: "recruits" };
    // a real week, a year back at most, this week at the latest; this week = the board
    const w = L.validWeek(p.get("week"));
    return { view: "board", week: w && w !== L.isoWeek(Date.now()) ? w : null };
  }

  function consentGate() {
    const open = button("Read and turn on", "ofr-btn ofr-btn-primary ofr-btn-sm", () => send({ type: "openWelcome" }));
    return stateEl("empty", "Lookups are off", "The clan hub needs ofstats.io. Nothing is sent until you agree.", [open]);
  }
  // the popup's "Everything on / off" switch
  function offGate() {
    const open = button("Open settings", "ofr-btn ofr-btn-sm", () => send({ type: "openSettings" }));
    return stateEl("empty", "OpenFront Pro is switched off", "Turn it back on in the extension's settings to use the clan hub.", [open]);
  }
  // Streamer mode while the hub does not know which name is yours.
  function drawBanner() {
    if (!bannerEl) return;
    if (!masking() || !settings.enabled) {
      bannerEl.replaceChildren();
      bannerEl.hidden = true;
      return;
    }
    const p = el("p", "hub-note hub-banner");
    p.setAttribute("role", "status");
    p.append(icon("info"), "Streamer mode: all player names are hidden, since the hub does not know yours yet. Open openfront.io once with the extension on, and only yours stays hidden.");
    bannerEl.replaceChildren(p);
    bannerEl.hidden = false;
  }
  function failed(r, retry) {
    if (refused(r)) return consentGate();
    if (r?.reason === "no-history") return stateEl("empty", "Nothing on ofstats.io", "No record for this.");
    const again = button("Try again", "ofr-btn ofr-btn-sm", retry);
    const s = stateEl("error", "ofstats.io unreachable", "Try again in a little while.", [again]);
    s.title = r?.error ?? (r?.status ? `HTTP ${r.status}` : "no answer");
    return s;
  }
  const loading = (text = "Loading…") => stateEl("loading", null, text);

  // A tag box: type a tag, Enter opens it (or calls pick).
  function tagInput(value, placeholder, onPick, listId = "hub-tags") {
    const input = el("input", "ofr-input ofr-input-sm hub-input");
    input.value = value ?? "";
    input.placeholder = placeholder;
    input.maxLength = 7;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("list", listId);
    input.setAttribute("aria-label", placeholder);
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const t = L.normTag(input.value);
      if (t) onPick(t);
      else input.setAttribute("aria-invalid", "true");
    });
    return input;
  }
  // tags of the current table, for the tag boxes. One fill at a time: renders
  // in quick succession all call this, and each used to append the whole list.
  let tagFill = null;
  function fillTagList() {
    let list = document.getElementById("hub-tags");
    if (!list) {
      list = el("datalist");
      list.id = "hub-tags";
      document.body.append(list);
    }
    if (list.childElementCount || !settings.dataConsent) return tagFill;
    tagFill ??= table(null).then((cur) => {
      if (!cur?.found) {
        tagFill = null; // asked again on the next render
        return;
      }
      if (list.childElementCount) return;
      list.append(
        ...cur.clans.map((c) => {
          const o = el("option");
          o.value = c.tag;
          return o;
        }),
      );
    });
    return tagFill;
  }

  let token = 0;
  function render() {
    const r = route();
    const my = ++token;
    const alive = () => my === token;
    drawTabs(r.view);
    drawBanner();
    view.replaceChildren();
    if (!settings.enabled) {
      view.append(offGate());
      return;
    }
    if (r.view === "recruits") return renderRecruits(alive);
    if (!settings.dataConsent) {
      view.append(consentGate());
      return;
    }
    fillTagList();
    if (r.view === "clan") {
      if (r.tag) last.tag = r.tag;
      return renderClan(r.tag, alive);
    }
    if (r.view === "compare") {
      last.a = r.a;
      last.b = r.b;
      return renderCompare(r.a, r.b, alive);
    }
    last.week = r.week;
    return renderBoard(r.week, alive);
  }

  // ---- 1. leaderboard ----------------------------------------------------------------------------------
  async function renderBoard(week, alive) {
    view.append(loading());
    // the week before is asked for alongside, for movers (cached like the rest)
    const guess = week ?? L.isoWeek(Date.now());
    const prevGuess = L.shiftWeek(guess, -1);
    const prevP = table(prevGuess);
    const cur = await table(week);
    if (!alive()) return;
    if (!cur?.found) {
      view.replaceChildren(failed(cur, render));
      return;
    }
    const prevWeek = L.shiftWeek(cur.week, -1);
    const prev = await (prevWeek === prevGuess ? prevP : table(prevWeek));
    if (!alive()) return;
    const mv = L.movers(cur.clans, prev?.found ? prev.clans : [], { limit: 4 });
    view.replaceChildren();

    // head: week navigation, clan of the week, open a tag
    const bar = el("div", "hub-bar");
    const nav = el("div", "hub-week");
    const thisWeek = L.isoWeek(Date.now());
    const back = button("‹", "ofr-btn ofr-btn-icon", () => goto(`#week=${prevWeek}`), { label: "Previous week", title: "Previous week" });
    back.disabled = !L.validWeek(prevWeek);
    const nextWeek = L.shiftWeek(cur.week, 1);
    const fwd = button("›", "ofr-btn ofr-btn-icon", () => goto(nextWeek === thisWeek ? "#board" : `#week=${nextWeek}`), {
      label: "Next week",
      title: "Next week",
    });
    // nothing after this week (whatever ofstats says isCurrentWeek is)
    fwd.disabled = cur.isCurrentWeek || !L.validWeek(nextWeek);
    const lbl = el("div", "hub-week-label");
    lbl.append(el("b", null, `Week ${L.weekNumber(cur.week) || "?"}`), el("small", null, cur.isCurrentWeek ? "this week" : `${dayText(cur.weekStart)} – ${dayText(cur.weekEnd - 1)}`));
    lbl.title = `${cur.week}${cur.weekStart ? `: ${new Date(cur.weekStart).toUTCString().slice(0, 16)} to ${new Date(cur.weekEnd - 1).toUTCString().slice(0, 16)} (UTC)` : ""}${fin(cur.total) ? `\n${fmtExact(cur.total)} clans scored` : ""}`;
    nav.append(back, lbl, fwd);
    bar.append(nav);
    if (cur.clanOfTheWeek?.tag) {
      const cotw = cur.clanOfTheWeek;
      const chip = button("", "ofr-chip hub-cotw", () => goto(`#tag=${cotw.tag}`));
      chip.dataset.tone = "accent";
      chip.append(icon("trophy"), `[${cotw.tag}]`);
      chip.title = `Clan of the week ${cotw.week}: [${cotw.tag}], ${fmtExact(cotw.points)} points`;
      bar.append(chip);
    }
    bar.append(el("span", "grow"), tagInput("", "Clan tag", (t) => goto(`#tag=${t}`)));
    view.append(bar);
    if (!cur.clans?.length) {
      view.append(stateEl("empty", "No clans this week", cur.isCurrentWeek ? "No clan has scored points yet this week." : "ofstats.io has no clan points for this week."));
      return;
    }

    const grid = el("div", "hub-grid");
    // movers
    if (mv.known) {
      const movers = card("Movers", "trend", { wide: true, tip: `Rank change against ${prevWeek}` });
      const cols = el("div", "hub-movers");
      const col = (dir, list, extra = []) => {
        const c = el("div", "hub-movers-col");
        c.dataset.dir = dir;
        c.append(icon("trend"));
        for (const m of [...list, ...extra]) {
          const chip = button("", "ofr-chip hub-mover", () => goto(`#tag=${m.tag}`));
          const d = el("span", "hub-delta", m.entered ? "new" : `${m.delta > 0 ? "+" : ""}${m.delta}`);
          d.dataset.dir = m.entered ? "new" : dir;
          chip.append(`[${m.tag}]`, d);
          chip.title = m.entered ? `[${m.tag}]: new in the top ${cur.clans.length}, now #${m.rank}` : `[${m.tag}]: #${m.prevRank} → #${m.rank}`;
          c.append(chip);
        }
        if (c.childElementCount === 1) c.append(el("span", "hub-dim", "—"));
        return c;
      };
      cols.append(col("up", mv.up, mv.entered.slice(0, 3)), col("down", mv.down));
      movers.append(cols);
      grid.append(movers);
    }

    // the table
    const tcard = card(`Top ${cur.clans.length}`, "trophy", { wide: true });
    const rows = el("div", "hub-table");
    rows.setAttribute("role", "table");
    const head = el("div", "hub-row hub-head");
    head.setAttribute("role", "row");
    const hcell = (t, tip) => {
      const s = el("span", null, t);
      s.setAttribute("role", "columnheader");
      if (tip) s.title = tip;
      return s;
    };
    head.append(
      hcell("#"),
      hcell("", "Change since last week"),
      hcell("clan"),
      hcell("points", "Points this week (bar: square-root scale)"),
      hcell("stacked", "Win rate in stacked games: several clan members on one team. Tick: win rate in all games"),
      hcell("games"),
      hcell("active", "Members who played this week"),
      hcell("12 wk", "Rank over the last 12 weeks (top 10 only)"),
    );
    rows.append(head);
    const maxPts = Math.max(1, ...cur.clans.map((c) => c.points ?? 0));
    const series = new Map((cur.timeline?.series ?? []).map((s) => [s.tag.toUpperCase(), s]));
    const mine = myTag();
    for (const c of cur.clans) {
      const row = el("div", "hub-row");
      row.setAttribute("role", "row");
      if (c.rank <= 3) row.dataset.top = "1";
      if (mine && c.tag.toUpperCase() === mine) row.classList.add("mine");
      const m = mv.byTag.get(c.tag.toUpperCase());
      const allRate = L.rate(c.wins, c.games);
      row.title = [
        `[${c.tag}] #${c.rank}${m?.prevRank ? ` (last week #${m.prevRank})` : m?.entered ? " (new in the table)" : ""}`,
        `${fmtExact(c.points)} points${fin(c.pointsPerMember) ? ` · ${c.pointsPerMember} per active member` : ""}`,
        `${fmtExact(c.games)} games · ${fmtExact(c.wins)} won (${pct1(allRate)})`,
        `stacked: ${fmtExact(c.stackedWins)} of ${fmtExact(c.stackedGames)} won (${fin(c.stackedWinRate) ? `${c.stackedWinRate}%` : "—"})`,
        `${fmtExact(c.activeMembers)} members played this week`,
      ].join("\n");
      const delta = el("span", "hub-delta");
      if (m?.entered) {
        delta.textContent = "new";
        delta.dataset.dir = "new";
      } else if (fin(m?.delta) && m.delta !== 0) {
        delta.textContent = `${m.delta > 0 ? "▲" : "▼"}${Math.abs(m.delta)}`;
        delta.dataset.dir = m.delta > 0 ? "up" : "down";
      } else if (mv.known) {
        delta.textContent = "•";
        delta.dataset.dir = "same";
      }
      const tagBtn = button(`[${c.tag}]`, "hub-tagbtn", () => goto(`#tag=${c.tag}`), { title: `Open [${c.tag}]` });
      const pts = el("span", "hub-bar-cell");
      pts.append(C.meter({ frac: L.sqrtFrac(c.points, maxPts), kind: "accent", label: `${fmtExact(c.points)} points` }), el("span", null, fmtBig(c.points)));
      const stk = el("span", "hub-bar-cell");
      stk.append(
        C.meter({
          frac: fin(c.stackedWinRate) ? c.stackedWinRate / 100 : 0,
          kind: "good",
          mark: fin(allRate) ? { frac: allRate } : null,
          label: `stacked win rate ${fin(c.stackedWinRate) ? c.stackedWinRate : "?"}%`,
        }),
        el("span", null, fin(c.stackedWinRate) ? `${Math.round(c.stackedWinRate)}%` : "—"),
      );
      const members = el("span", "hub-members");
      members.append(icon("users"), fmtBig(c.activeMembers));
      const s = series.get(c.tag.toUpperCase());
      const sp = s ? spark(s.ranks, { title: `Rank by week: ${s.ranks.map((r) => (fin(r) ? `#${r}` : "–")).join(" ")}`, label: `rank trend of ${c.tag}` }) : el("span");
      row.append(el("span", "hub-rank", String(c.rank)), delta, tagBtn, pts, stk, el("span", "hub-num", fmtBig(c.games)), members, sp);
      rows.append(row);
    }
    tcard.append(rows);
    const legend = el("div", "hub-legend");
    const key = (cls, text) => {
      const s = el("span");
      s.append(el("i", cls), text);
      return s;
    };
    legend.append(key("accent", "points (√ scale)"), key("good", "stacked win rate"), key("tick", "all games"));
    tcard.append(legend);
    grid.append(tcard);
    view.append(grid);
  }

  // ---- 2. clan page ---------------------------------------------------------------------------------
  const MEMBER_FIRST = 24; // looked up on open
  const MEMBER_CAP = 50; // ofstats' first page of members; the rest only on a click

  async function renderClan(tag, alive) {
    const bar = el("div", "hub-bar");
    bar.append(tagInput(tag ?? "", "Clan tag", (t) => goto(`#tag=${t}`)));
    if (tag) {
      bar.append(el("span", "grow"));
      const cmp = button("", "ofr-btn ofr-btn-sm", () => goto(`#vs=${tag}`));
      cmp.append(icon("swords"), "Compare");
      bar.append(cmp);
    }
    view.append(bar);
    if (!tag) {
      const cur = await table(null);
      if (!alive()) return;
      const picks = (cur?.clans ?? []).slice(0, 12).map((c) => {
        const b = button(`[${c.tag}]`, "ofr-chip", () => goto(`#tag=${c.tag}`));
        b.title = `#${c.rank} this week`;
        return b;
      });
      view.append(stateEl("empty", "Pick a clan", "Type a tag, or one of this week's top clans:", picks));
      return;
    }
    const wait = loading();
    view.append(wait);
    const [clan, cur] = await Promise.all([clanGet(tag), table(null)]);
    if (!alive()) return;
    if (!clan?.found) {
      wait.replaceWith(clan?.reason === "no-history" ? stateEl("empty", `No clan [${tag}]`, "ofstats.io has no games for this tag.") : failed(clan, render));
      return;
    }
    wait.remove();
    const row = cur?.clans?.find((c) => c.tag.toUpperCase() === tag);
    const rates = L.clanRates(clan);

    // hero
    const hero = el("section", "ofr-card hub-card hub-hero");
    hero.append(el("span", "hub-hero-tag", `[${clan.tag ?? tag}]`));
    const chips = el("div", "hub-hero-chips");
    const chip = (iconName, text, title, tone = null) => {
      const c = el("span", "ofr-chip");
      if (tone) c.dataset.tone = tone;
      c.append(icon(iconName), text);
      c.title = title;
      chips.append(c);
    };
    const rank = clan.current?.rank ?? row?.rank;
    const points = clan.current?.points ?? row?.points;
    if (fin(rank)) chip("trophy", `#${rank}`, `Rank this week${clan.current?.week ? ` (${clan.current.week})` : ""}`, rank <= 10 ? "accent" : null);
    if (fin(points)) chip("bolt", fmtBig(points), `${fmtExact(points)} points this week`);
    chip("users", fmtBig(clan.memberCount), `${fmtExact(clan.memberCount)} members on ofstats.io`);
    if (fin(rates.active)) chip("calendar", pct0(rates.active), `${fmtExact(clan.activeMembers)} of ${fmtExact(clan.memberCount)} played in the last month`, "good");
    chip("swords", fmtBig(clan.games), `${fmtExact(clan.games)} games, ${fmtExact(clan.wins)} won`);
    hero.append(chips);
    view.append(hero);

    const grid = el("div", "hub-grid");
    grid.style.marginTop = "14px";
    // win-rate rings
    const rc = card("Win rate", "target");
    const rings = el("div", "hub-rings");
    const t = clan.team ?? {};
    const addRing = (f, word, wins, games, opts = {}) => {
      if (!fin(f)) return;
      rings.append(ringCard(f, pct0(f), word, `${word}: ${fmtExact(wins)} of ${fmtExact(games)} won (${pct1(f)})${opts.extra ?? ""}`, opts));
    };
    addRing(rates.all, "all", clan.wins, clan.games);
    addRing(rates.team, "team", t.wins, t.games, { kind: "average" });
    addRing(rates.stacked, "stacked", t.stackedWins, t.stackedGames, {
      kind: "accent",
      marker: fin(rates.stackedRef) ? { frac: rates.stackedRef, title: `An average stack: ${pct1(rates.stackedRef)}` } : null,
      extra: `${fin(t.avgStack) ? `\naverage stack ${t.avgStack}` : ""}${fin(rates.stackedRef) ? `\ntick: an average stack wins ${pct1(rates.stackedRef)}` : ""}`,
    });
    addRing(rates.recent, "recent", t.recentWins, t.recentGames, { extra: "\nlast team games" });
    rc.append(rings);
    grid.append(rc);

    // points by week
    const wc = card("Points by week", "calendar");
    const weekly = (clan.weekly ?? []).filter((w) => w && w.week);
    if (weekly.length) {
      const nowWeek = clan.current?.week ?? cur?.week;
      wc.append(
        C.columns({
          items: weekly.map((w) => ({
            value: w.points ?? 0,
            cls: w.week === nowWeek ? "accent" : "",
            title: `${w.week}: ${fmtExact(w.points)} points${fin(w.rank) ? ` · #${w.rank}` : ""}${fin(w.activeMembers) ? ` · ${fmtExact(w.activeMembers)} active` : ""}${fin(w.stackedGames) ? ` · stacked ${fmtExact(w.stackedWins)}/${fmtExact(w.stackedGames)}` : ""}`,
          })),
          width: 520,
          height: 130,
          yFormat: fmtBig,
          label: `Points by week for ${tag}`,
        }),
      );
      const axis = el("div", "hub-axis");
      axis.append(el("span", null, shortWeek(weekly[0].week)), el("span", null, shortWeek(weekly[weekly.length - 1].week)));
      wc.append(axis);
    } else wc.append(stateEl("empty", null, "No weekly points yet."));
    grid.append(wc);

    // by stack size
    const hist = (clan.stackHistogram ?? []).filter((h) => fin(h.k) && h.games > 0);
    if (hist.length) {
      const sc = card("By stack size", "users", { tip: "Win rate by how many clan members were on the same team" });
      const list = el("div", "hub-rows");
      for (const h of hist) {
        const f = h.wins / h.games;
        const r = el("div", "hub-mrow");
        r.title = `${h.k === 1 ? "Solo" : `${h.k} clan members together`}: ${fmtExact(h.wins)} of ${fmtExact(h.games)} won (${pct1(f)})`;
        const lab = el("span");
        lab.append(C.pips({ lit: h.k, total: Math.min(6, Math.max(h.k, 1)), glyph: "dot", label: `${h.k}` }));
        r.append(lab, C.meter({ frac: f, kind: "accent", label: `${pct0(f)} won` }), el("span", null, pct0(f)));
        list.append(r);
      }
      sc.append(list);
      grid.append(sc);
    }
    // by mode
    const modes = (Array.isArray(clan.modes) ? clan.modes : []).filter((m) => m && (m.count ?? m.games) > 0);
    if (modes.length) {
      const mc = card("By mode", "flag");
      const list = el("div", "hub-rows");
      const most = Math.max(...modes.map((m) => m.count ?? m.games));
      for (const m of modes) {
        const games = m.count ?? m.games;
        const f = (m.wins ?? 0) / games;
        const r = el("div", "hub-mrow");
        r.title = `${m.name ?? m.mode}: ${fmtExact(m.wins)} of ${fmtExact(games)} won (${pct1(f)})`;
        const meter = C.meter({ frac: f, kind: "good", label: `${pct0(f)} won` });
        meter.style.opacity = String(0.55 + 0.45 * Math.sqrt(games / most));
        r.append(el("span", null, String(m.name ?? m.mode ?? "?")), meter, el("span", null, pct0(f)));
        list.append(r);
      }
      mc.append(list);
      grid.append(mc);
    }
    view.append(grid);

    // members
    const members = [...(clan.members ?? [])].sort((a, b) => (b.games ?? 0) - (a.games ?? 0)).slice(0, MEMBER_CAP);
    if (!members.length) return;
    const aces = new Set((clan.aces ?? []).map((a) => lower(a.username)));
    const mcard = card("Members", "users", { wide: true, tip: `The ${members.length} members with the most games on ofstats.io. Percentiles: each member's own lookup.` });
    const top = el("div", "hub-strength");
    const list = el("div", "hub-mlist");
    const mapsCard = card("Best maps", "flag", { wide: true, tip: "Wins as a multiple of what an average player would win there (bar), summed over the members looked up" });
    const grid2 = el("div", "hub-grid");
    grid2.style.marginTop = "14px";
    mcard.append(top, list);
    grid2.append(mcard);
    view.append(grid2);

    let shownCount = Math.min(MEMBER_FIRST, members.length);
    const rowsByName = new Map();
    // Rows are built once and then updated in place (the button itself is never
    // replaced or moved), so a row with the keyboard focus keeps it while
    // batches of lookups come in.
    const drawRow = (m) => {
      const k = lower(m.username);
      const info = players.get(k);
      const failed = info === undefined && failedNames.has(k);
      let wrap = rowsByName.get(k);
      if (!wrap) {
        wrap = el("div", "hub-member");
        const b = el("button", "hub-member-row");
        b.type = "button";
        b.addEventListener("click", () => {
          wrap.dataset.open = String(wrap.dataset.open !== "true");
          drawRow(m);
        });
        wrap.append(b);
        rowsByName.set(k, wrap);
      }
      const btn = wrap.firstChild;
      const open = wrap.dataset.open === "true";
      const act = L.activityOf(m.lastPlayed);
      btn.setAttribute("aria-expanded", String(open));
      btn.title = `${shown(m.username)}: ${fmtExact(m.wins)} of ${fmtExact(m.games)} won (${fin(m.winRate) ? `${m.winRate.toFixed(1)}%` : "?"})\nlast game ${daysText(act.days)}${aces.has(k) ? "\nace of the clan (ofstats.io)" : ""}\nClick: profile`;
      const dot = el("span", "hub-dot");
      dot.dataset.level = act.level;
      const name = el("span", "name", shown(m.username));
      if (aces.has(k)) name.append(icon("star"));
      btn.replaceChildren(
        dot,
        name,
        badgeFor(info, failed),
        C.meter({ frac: fin(m.winRate) ? m.winRate / 100 : 0, kind: "good", label: `win rate ${fin(m.winRate) ? Math.round(m.winRate) : "?"}%` }),
        el("span", "games", fmtBig(m.games)),
        el("span", "chev", "›"),
      );
      // the profile under an open row: rebuilt only when what it shows changes
      const profKey = open ? `${info ? "info" : failed ? "failed" : "pending"}|${shown(m.username)}` : "";
      if (wrap.dataset.prof !== profKey) {
        wrap.dataset.prof = profKey;
        while (btn.nextSibling) btn.nextSibling.remove();
        if (open) {
          const p = info ? L.profile(info) : null;
          wrap.append(
            p
              ? profileEl(p, m.username)
              : el("div", "hub-prof", info !== undefined ? "No stats under this name." : failed ? "ofstats.io did not answer. Retry above the list." : "Looking up…"),
          );
        }
      }
      return wrap;
    };
    const drawList = () => {
      for (const m of members.slice(0, shownCount)) {
        const w = drawRow(m);
        if (w.parentNode !== list) list.append(w); // new rows only ever go at the end
      }
    };
    const drawTop = () => {
      const infos = members.slice(0, shownCount).map((m) => players.get(lower(m.username)));
      const profs = infos.filter(Boolean).map((i) => L.profile(i));
      const st = L.memberStrength(profs);
      const act = L.memberActivity(members.slice(0, shownCount));
      const items = [];
      const item = (node, label) => {
        const box = el("div", "hub-strength-item");
        box.append(node, el("small", null, label));
        items.push(box);
      };
      if (fin(rates.active)) {
        item(
          C.ring({ frac: rates.active, value: pct0(rates.active), size: 76, thickness: 8, kind: "good", title: `${fmtExact(clan.activeMembers)} of ${fmtExact(clan.memberCount)} members played in the last month`, label: "active this month" }),
          "active",
        );
      }
      item(
        C.pips({ lit: act.week, total: Math.min(act.total, 24), glyph: "dot", label: `${act.week} of the top ${act.total} played this week`, title: `Of these ${act.total}: ${act.week} played this week, ${act.month} earlier this month, ${act.idle} longer ago` }),
        "this week",
      );
      if (fin(st.avgPct)) {
        const band = S.percentBand(st.avgPct);
        item(
          C.ring({ frac: 1 - st.avgPct / 100, sweep: 260, size: 76, thickness: 8, band, pre: "top", value: `${Math.round(st.avgPct)}%`, title: `Average member: Top ${st.avgPct.toFixed(1)}% (median Top ${st.medianPct.toFixed(1)}%), ${st.ranked} ranked of ${st.total} looked up`, label: "average member rank" }),
          "avg member",
        );
      }
      const bands = C.bands({ counts: st.counts, labels: { elite: "5%", strong: "15%", good: "35%", average: "60%", low: "rest", unranked: "?" } });
      bands.title = `Members by rank band (${st.total} looked up)`;
      items.push(bands);
      // progress from what is known, whichever lookup run (first 24, "All",
      // Retry) brought it in
      const keys = members.slice(0, shownCount).map((m) => lower(m.username));
      const done = keys.filter((k) => players.has(k) || failedNames.has(k)).length;
      const off = keys.filter((k) => !players.has(k) && failedNames.has(k)).length;
      if (done < shownCount) {
        const prog = el("div", "hub-progress");
        prog.append(C.meter({ frac: done / shownCount, kind: "accent", label: `${done} of ${shownCount} looked up` }), `${done}/${shownCount}`);
        prog.title = "Members looked up on ofstats.io, 6 at a time";
        items.push(prog);
      }
      if (off) {
        const box = el("div", "hub-offline");
        const again = button("Retry", "ofr-btn ofr-btn-sm", retry, { title: `Look up the ${off} members ofstats.io did not answer for` });
        box.append(badgeFor(undefined, true), el("span", "hub-dim", `${off} not looked up`), again);
        items.push(box);
      }
      top.replaceChildren(...items);
    };
    const drawMaps = () => {
      const infos = members.slice(0, shownCount).map((m) => players.get(lower(m.username))).filter(Boolean);
      const best = L.clanMaps(infos, { minGames: 15, limit: 6 });
      if (!best.length) {
        mapsCard.remove();
        return;
      }
      const listM = el("div", "hub-rows");
      const topRatio = Math.max(...best.map((m) => m.ratio));
      for (const m of best) {
        const r = el("div", "hub-mrow");
        r.title = `${m.map}: ${m.ratio.toFixed(2)}x the wins an average player would get, ${topText(m.pct)} (${fmtExact(m.wins)} wins against ${m.expectedWins.toFixed(1)} expected, ${fmtExact(m.games)} games by ${m.players} members)`;
        r.append(el("span", null, m.map), C.meter({ frac: m.ratio / topRatio, band: S.percentBand(m.pct), label: `${m.ratio.toFixed(1)} times the expected wins` }), el("span", null, `×${m.ratio.toFixed(1)}`));
        listM.append(r);
      }
      mapsCard.replaceChildren(mapsCard.firstChild, listM);
      if (!mapsCard.isConnected) grid2.append(mapsCard);
    };
    const redraw = () => {
      drawTop();
      drawList();
      drawMaps();
    };
    const lookupShown = (from) => lookupMany(members.slice(from, shownCount).map((m) => m.username), alive, redraw);
    // failed names are cleared and asked again (members already known are skipped)
    function retry() {
      for (const m of members.slice(0, shownCount)) failedNames.delete(lower(m.username));
      redraw();
      lookupShown(0);
    }
    redraw();
    if (members.length > shownCount) {
      const more = button(`All ${members.length}`, "ofr-btn ofr-btn-sm hub-more", async () => {
        const from = shownCount;
        shownCount = members.length;
        redraw();
        // the button goes; the keyboard focus moves to the first new row
        rowsByName.get(lower(members[from].username))?.firstChild?.focus();
        more.remove();
        await lookupShown(from);
      });
      more.title = `Show and look up the other ${members.length - shownCount} members`;
      mcard.append(more);
    }
    await lookupShown(0);
  }

  // ---- 3. clan vs clan ---------------------------------------------------------------------------------
  const COMPARE_MEMBERS = 12; // per side

  async function renderCompare(a, b, alive) {
    const pick = el("div", "hub-bar hub-pick");
    const inA = tagInput(a ?? "", "Clan A", () => go());
    const inB = tagInput(b ?? "", "Clan B", () => go());
    const go = () => {
      const ta = L.normTag(inA.value);
      const tb = L.normTag(inB.value);
      if (ta && tb) goto(`#vs=${ta}&with=${tb}`);
      else if (ta) goto(`#vs=${ta}`);
    };
    const swap = button("⇄", "ofr-btn ofr-btn-icon", () => {
      [inA.value, inB.value] = [inB.value, inA.value];
      go();
    }, { label: "Swap", title: "Swap" });
    const vsBtn = button("", "ofr-btn ofr-btn-primary ofr-btn-sm", go);
    vsBtn.append(icon("swords"), "Compare");
    pick.append(inA, swap, inB, vsBtn);
    view.append(pick);
    if (!a || !b || a === b) {
      const cur = await table(null);
      if (!alive()) return;
      const picks = (cur?.clans ?? []).filter((c) => c.tag !== a).slice(0, 10).map((c) =>
        button(`[${c.tag}]`, "ofr-chip", () => goto(a ? `#vs=${a}&with=${c.tag}` : `#vs=${c.tag}`)),
      );
      view.append(stateEl("empty", a ? `[${a}] against…` : "Pick two clans", "Type two tags, or pick from this week's top:", picks));
      return;
    }
    const wait = loading();
    view.append(wait);
    const [ca, cb, cur] = await Promise.all([clanGet(a), clanGet(b), table(null)]);
    if (!alive()) return;
    for (const [c, tag] of [[ca, a], [cb, b]]) {
      if (!c?.found) {
        wait.replaceWith(c?.reason === "no-history" ? stateEl("empty", `No clan [${tag}]`, "ofstats.io has no games for this tag.") : failed(c, render));
        return;
      }
    }
    wait.remove();
    const rowOf = (tag) => cur?.clans?.find((c) => c.tag.toUpperCase() === tag);
    const side = (c, tag) => ({
      tag,
      points: c.current?.points ?? rowOf(tag)?.points ?? null,
      rank: c.current?.rank ?? rowOf(tag)?.rank ?? null,
      rates: L.clanRates(c),
      memberCount: c.memberCount,
      games: c.games,
      avgPct: null,
    });
    const A = side(ca, a);
    const B = side(cb, b);

    // head: tag + overall win-rate ring each
    const head = el("div", "hub-vs");
    const sideEl = (S1, cls, kind) => {
      const box = el("div", `hub-vs-side ${cls}`);
      const f = S1.rates.all;
      box.append(
        C.ring({ frac: f ?? 0, value: pct0(f), size: 84, thickness: 9, kind, label: `[${S1.tag}] win rate`, title: `[${S1.tag}]: ${pct1(f)} of all games won` }),
      );
      const t = button(`[${S1.tag}]`, "hub-tagbtn hub-vs-tag", () => goto(`#tag=${S1.tag}`), { title: `Open [${S1.tag}]` });
      box.append(t);
      return box;
    };
    head.append(sideEl(A, "a", "accent"), el("span", "hub-vs-mid", "vs"), sideEl(B, "b", "average"));
    view.append(head);

    const grid = el("div", "hub-grid");
    const mc = card("Side by side", "swords", { wide: true, tip: "Longer bar = better. Member rank: the average percentile of the members looked up" });
    const mirrorBox = el("div");
    mc.append(mirrorBox);
    const drawMirror = () => {
      const rows = L.compareRows(A, B).map((r) => ({
        label: r.label,
        title: `${r.label}: [${a}] ${r.a.text} · [${b}] ${r.b.text}`,
        a: r.a,
        b: r.b,
      }));
      mirrorBox.replaceChildren(C.mirror({ rows }));
    };
    drawMirror();
    grid.append(mc);

    // weekly points, both
    const weeks = [...new Set([...(ca.weekly ?? []), ...(cb.weekly ?? [])].map((w) => w?.week).filter(Boolean))].sort();
    if (weeks.length > 1) {
      const wc = card("Points by week", "calendar");
      const pts = (c) => {
        const by = new Map((c.weekly ?? []).map((w) => [w.week, w.points]));
        return weeks.map((w, i) => ({ x: i, y: by.get(w) })).filter((p) => fin(p.y));
      };
      const chart = C.line({
        series: [
          { points: pts(ca), cls: "accent", title: `[${a}]` },
          { points: pts(cb), cls: "", title: `[${b}]` },
        ],
        width: 520,
        height: 150,
        xTicks: [0, weeks.length - 1],
        xFormat: (i) => shortWeek(weeks[i]),
        yFormat: fmtBig,
        label: `Weekly points of ${a} and ${b}`,
      });
      chart.classList.add("hub-cmp-line");
      const tip = weeks
        .map((w) => {
          const pa = (ca.weekly ?? []).find((x) => x.week === w)?.points;
          const pb = (cb.weekly ?? []).find((x) => x.week === w)?.points;
          return `${w}: [${a}] ${fmtExact(pa)} · [${b}] ${fmtExact(pb)}`;
        })
        .join("\n");
      const box = el("div");
      box.title = tip;
      box.append(chart);
      const key = el("div", "hub-chart-key");
      key.append(el("span", "a", `[${a}]`), el("span", "b", `[${b}]`));
      wc.append(box, key);
      grid.append(wc);
    }

    // head-to-head
    const hc = card("Head to head", "target", {
      tip: `Games both clans were in, among each clan's 20 latest games on ofstats.io and the last 60 games of up to ${COMPARE_MEMBERS} members per clan. Nothing else is counted. In team games a side's result comes from the members looked up, so a clan split over two teams can be miscounted.`,
    });
    const h2hBox = el("div");
    hc.append(h2hBox);
    grid.append(hc);
    view.append(grid);

    const topMembers = (c) => [...(c.members ?? [])].sort((x, y) => (y.games ?? 0) - (x.games ?? 0)).slice(0, COMPARE_MEMBERS).map((m) => m.username);
    const namesA = topMembers(ca);
    const namesB = topMembers(cb);
    const total = namesA.length + namesB.length;
    const drawH2H = (done) => {
      const pl = (names) => names.map((n) => ({ n, v: players.get(lower(n)) })).filter((x) => x.v?.found).map((x) => ({ name: shown(x.n), recentGames: x.v.recentGames ?? [] }));
      const h = L.headToHead({ tagA: a, tagB: b, clanGamesA: ca.recentGames ?? [], clanGamesB: cb.recentGames ?? [], playersA: pl(namesA), playersB: pl(namesB) });
      const nodes = [];
      if (done < total) {
        const prog = el("div", "hub-progress");
        prog.append(C.meter({ frac: done / total, kind: "accent", label: `${done} of ${total} members looked up` }), `${done}/${total}`);
        prog.title = "Members looked up on ofstats.io, 6 at a time";
        nodes.push(prog);
      }
      if (!h.games.length) {
        if (done >= total) nodes.push(stateEl("empty", "No shared games found", "None in the recent games visible for these two clans."));
        h2hBox.replaceChildren(...nodes);
        return;
      }
      const score = el("div", "hub-score");
      const sa = el("b", "a", String(h.a));
      const sb = el("b", "b", String(h.b));
      score.title = `[${a}] ahead in ${h.a}, [${b}] ahead in ${h.b}, same winning side ${h.allies}, neither won ${h.neither}, result not visible ${h.unknown} (of ${h.games.length} shared games)`;
      score.append(sa, el("span", "sep", "–"), sb);
      nodes.push(score);
      nodes.push(
        C.stacked({
          parts: [
            { label: `[${a}]`, value: h.a, slot: 6 },
            { label: `[${b}]`, value: h.b, slot: 1 },
            { label: "same side", value: h.allies, slot: 3 },
            { label: "neither", value: h.neither, slot: 5 },
            { label: "not visible", value: h.unknown, slot: 7 },
          ],
        }),
      );
      const strip = el("div", "hub-h2h-strip");
      const word = { a: `[${a}] won`, b: `[${b}] won`, allies: "same winning side", neither: "neither won", unknown: "result not visible" };
      for (const g of h.games.slice(0, 60)) {
        const cell = el("a", "hub-h2h-cell");
        cell.dataset.outcome = g.outcome;
        cell.href = gameUrl(g.id);
        cell.target = "_blank";
        cell.rel = "noopener noreferrer";
        const who = [g.playersA.length ? `[${a}] ${g.playersA.join(", ")}` : null, g.playersB.length ? `[${b}] ${g.playersB.join(", ")}` : null].filter(Boolean).join("\n");
        cell.title = `${word[g.outcome]}\n${[dayText(g.date), g.map, g.mode].filter(Boolean).join(" · ")}${who ? `\n${who}` : ""}`;
        strip.append(cell);
      }
      nodes.push(strip);
      h2hBox.replaceChildren(...nodes);
    };
    const strength = () => {
      for (const [names, S1] of [[namesA, A], [namesB, B]]) {
        const st = L.memberStrength(names.map((n) => players.get(lower(n))).filter(Boolean).map((i) => L.profile(i)));
        S1.avgPct = st.avgPct;
      }
    };
    drawH2H(0);
    let doneA = 0;
    await lookupMany(namesA, alive, (n) => {
      doneA = n;
      strength();
      drawMirror();
      drawH2H(doneA);
    });
    await lookupMany(namesB, alive, (n) => {
      strength();
      drawMirror();
      drawH2H(doneA + n);
    });
    if (!alive()) return;
    strength();
    drawMirror();
    drawH2H(total);
  }

  // ---- 4. recruits -------------------------------------------------------------------------------------
  const filters = { maxPct: 15, activeDays: 30, mode: "any", sort: "rank" };
  const RECRUIT_PAGE = 48;

  async function renderRecruits(alive) {
    const note = el("p", "hub-note");
    note.append(icon("info"), "Only players this browser has looked up: in your lobbies and games, recaps, or the dashboard's search. Nothing new is looked up.");
    note.title = `The ${L.RECRUIT_CAP} most recently looked-up players without a clan tag, each kept ${Math.round(L.RECRUIT_MAX_AGE / 86400000)} days. "Clear cached ranks" in the settings empties it.`;
    view.append(note);
    // the worker's recruit index only, never the whole of storage.local
    let index = null;
    try {
      index = (await chrome.storage.local.get(L.RECRUIT_KEY))?.[L.RECRUIT_KEY] ?? null;
    } catch {
      index = null;
    }
    if (!alive()) return;
    const fbar = el("div", "hub-filters");
    const listBox = el("div");
    view.append(fbar, listBox);
    const seg = (iconName, label, key, options) => {
      const g = el("div", "hub-seg");
      g.setAttribute("role", "group");
      g.setAttribute("aria-label", label);
      const lab = el("span", "hub-seg-label");
      lab.title = label;
      lab.append(icon(iconName));
      g.append(lab);
      for (const [value, text, tip] of options) {
        const b = button(text, null, () => {
          filters[key] = value;
          draw();
          // the bar is redrawn: the keyboard focus goes back to the same button
          fbar.querySelector(`[data-key="${key}"][data-value="${String(value)}"]`)?.focus();
        });
        b.dataset.key = key;
        b.dataset.value = String(value);
        b.setAttribute("aria-pressed", String(filters[key] === value));
        if (tip) b.title = tip;
        g.append(b);
      }
      return g;
    };
    let limit = RECRUIT_PAGE;
    const draw = () => {
      fbar.replaceChildren(
        seg("trophy", "Rank", "maxPct", [
          [5, "5%", "Top 5%"],
          [15, "15%", "Top 15%"],
          [35, "35%", "Top 35%"],
          [null, "all", "Any rank"],
        ]),
        seg("clock", "Last played", "activeDays", [
          [7, "7d", "Played in the last 7 days"],
          [30, "30d", "Played in the last 30 days"],
          [null, "any", "Any time"],
        ]),
        seg("flag", "Plays", "mode", [
          ["any", "all", "Any mode"],
          ["ffa", "FFA", "Plays free-for-all (a fifth of their games or more)"],
          ["team", "Team", "Plays team games (a fifth of their games or more)"],
          ["ranked", "1v1", "Plays ranked (a fifth of their games or more)"],
        ]),
        seg("trend", "Sort", "sort", [
          ["rank", "rank", "Best rank first"],
          ["recent", "recent", "Most recently active first"],
          ["games", "games", "Most games first"],
        ]),
      );
      const { list, pool } = L.recruits(index, { ...filters, self });
      const count = el("span", "hub-count", `${list.length} / ${pool}`);
      count.title = `${list.length} match, of ${pool} ranked players without a clan tag (10+ games) this browser has looked up`;
      fbar.append(count);
      if (!pool) {
        listBox.replaceChildren(
          stateEl("empty", "Nobody seen yet", settings.dataConsent ? "Players show up here after lobbies with rank lookups on." : "Rank lookups are off, so no players have been saved.", settings.dataConsent ? [] : [button("Read and turn on", "ofr-btn ofr-btn-primary ofr-btn-sm", () => send({ type: "openWelcome" }))]),
        );
        return;
      }
      if (!list.length) {
        listBox.replaceChildren(stateEl("empty", "No one matches", "Loosen a filter above."));
        return;
      }
      const grid = el("div", "hub-cards");
      for (const p of list.slice(0, limit)) {
        const tile = el("div", "ofr-tile");
        tile.title = [
          shown(p.username),
          fin(p.pct) ? `${topText(p.pct)} of players` : null,
          `${fmtExact(p.wins)} of ${fmtExact(p.games)} won (${pct1(p.winRate)})`,
          `FFA ${fmtExact(p.modes.ffa.games)} · Team ${fmtExact(p.modes.team.games)} · Ranked ${fmtExact(p.modes.ranked.games)}`,
          `last game ${daysText(p.lastSeenDays)}`,
        ]
          .filter(Boolean)
          .join("\n");
        tile.append(profileEl(p, p.username));
        grid.append(tile);
      }
      const nodes = [grid];
      if (list.length > limit) {
        const more = button(`${list.length - limit} more`, "ofr-btn ofr-btn-sm hub-more", () => {
          limit += RECRUIT_PAGE;
          draw();
        });
        nodes.push(more);
      }
      listBox.replaceChildren(...nodes);
    };
    draw();
  }

  // ---- start ---------------------------------------------------------------------------------------------
  Promise.all([
    chrome.storage.sync.get({ theme: "classic", streamerMode: false, dataConsent: false, enabled: true }).catch(() => ({})),
    chrome.storage.local.get("selfStatsName").catch(() => ({})),
  ]).then(([sync, local]) => {
    Object.assign(settings, { theme: sync?.theme ?? "classic", streamerMode: sync?.streamerMode === true, dataConsent: sync?.dataConsent === true, enabled: sync?.enabled !== false });
    self = typeof local?.selfStatsName === "string" && local.selfStatsName ? local.selfStatsName : null;
    applyTheme();
    render();
  });
  window.addEventListener("hashchange", render);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      if (changes.theme) {
        settings.theme = changes.theme.newValue ?? "classic";
        applyTheme();
      }
      let again = false;
      if (changes.streamerMode) {
        settings.streamerMode = changes.streamerMode.newValue === true;
        again = true;
      }
      if (changes.enabled) {
        settings.enabled = changes.enabled.newValue !== false;
        again = true;
      }
      if (changes.dataConsent) {
        settings.dataConsent = changes.dataConsent.newValue === true;
        tables.clear();
        clans.clear();
        tagFill = null;
        failedNames.clear();
        again = true;
      }
      if (again) render();
    } else if (area === "local" && changes.selfStatsName) {
      self = changes.selfStatsName.newValue || null;
      render();
    }
  });
})();
