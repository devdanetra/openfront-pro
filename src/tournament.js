// Tournament helper page (opened from the popup's Tools tab: worker "openPage").
// Organisers run a tournament with no server: they add each game's id or link
// once it is played, the worker fetches OpenFront's public record of it
// ({type: "gameRecord"}, behind the dataConsent gate), and everything - who is
// who, points, tie-breaks, the bracket - is computed here by tournament-core.js.
//
// Saved in chrome.storage.local, one key per tournament ("tournament:<id>", order
// in "tournamentIdx"; other open tabs are followed through storage.onChanged and
// merged per tournament by its `updated` stamp); records of finished games are
// cached there too ("tRec:<id>", LRU index "tRecIdx"), since they never change.
// Shared as a .json file or a share code (the "#t=..." fragment carrying the
// whole tournament), pasted under Import. The page is not web-accessible, so a
// link to it clicked on a web page (Discord in the browser) is blocked; and in
// the Steam launcher the page's address holds the launcher's secret token, so
// only the code is ever copied there.
//
// Everything from a record, a file or a link is shown with textContent / title
// only; static markup of our own is built with DOM calls too. Works under the
// Steam launcher's chrome.* shim: storage get/set/remove + onChanged,
// runtime.sendMessage / getURL - no downloads API (files are saved through an
// <a download> of a Blob URL).
(() => {
  const T = globalThis.OFR_TOURNEY;
  const THEMES = globalThis.OFR_THEMES ?? {};
  const $ = (id) => document.getElementById(id);
  const REC_PREFIX = "tRec:";
  const REC_INDEX = "tRecIdx";
  const IN_EXTENSION = location.protocol === "chrome-extension:";
  const FORMAT = {
    league: { icon: "league", label: "League", tip: "Points league / round robin: every game counts" },
    bracket: { icon: "bracket", label: "Bracket", tip: "Single elimination: winners advance from recorded games" },
    series: { icon: "series", label: "Series", tip: "Best of N between two sides" },
  };
  const UNIT = {
    player: { icon: "player", label: "Players" },
    team: { icon: "team", label: "Teams & clans" },
  };

  // ---- DOM helpers (text only, never markup from data) ------------------------------------
  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "k") node.dataset.k = v;
      else if (k === "value") node.value = v;
      else if (k === "data") {
        // null / undefined = no attribute (not data-x="null", which [data-x] would match)
        for (const [dk, dv] of Object.entries(v)) if (dv != null) node.dataset[dk] = String(dv);
      }
      else if (k === "style") node.style.cssText = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
    return node;
  }
  const NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    league: "M3 4h10M3 8h7M3 12h4",
    bracket: "M2 3.5h4v9H2M6 8h4M10 5v6M10 8h4",
    series: "M3 3l10 10M13 3L3 13M3 10l3 3M13 10l-3 3",
    trophy: "M5 2.5h6v3a3 3 0 0 1-6 0zM5 4H3a2 2 0 0 0 2 2.6M11 4h2a2 2 0 0 1-2 2.6M8 8.5v2.5M5.5 13.5h5M6.5 11h3v2.5h-3z",
    player: "M8 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5",
    team: "M6 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM1.5 13.5c.4-2.6 2-4 4.5-4s4.1 1.4 4.5 4M10.5 2.6a2 2 0 0 1 0 3.8M12 9.6c1.5.5 2.3 1.8 2.5 3.9",
    plus: "M8 3v10M3 8h10",
    refresh: "M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5",
    close: "M4 4l8 8M12 4l-8 8",
    link: "M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8",
    download: "M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10",
    copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
    text: "M3 4h10M3 7h10M3 10h6",
    file: "M4 2h5l3 3v9H4zM9 2v3h3",
    chevron: "M4 6l4 4 4-4",
    more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
    up: "M4 10l4-4 4 4",
    down: "M4 6l4 4 4-4",
    games: "M2.5 3.5h11v9h-11zM2.5 6.5h11M5.5 3.5v3",
    edit: "M10.5 2.5l3 3-8 8h-3v-3z",
    share: "M11 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 14.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6.8 7l2.4-1.5M6.8 9l2.4 1.5",
  };
  function icon(name, cls = "") {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", `tn-ico ${cls}`.trim());
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", ICONS[name] ?? "");
    if (name === "more") p.setAttribute("stroke-width", "2.6");
    svg.append(p);
    return svg;
  }
  const btn = (label, onclick, { cls = "", k, id, title, ico, aria, pressed, disabled, expanded } = {}) =>
    el(
      "button",
      { type: "button", class: `ofr-btn ${cls}`.trim(), k, id, title, onclick, "aria-label": aria, "aria-pressed": pressed == null ? null : String(pressed), "aria-expanded": expanded == null ? null : String(expanded), disabled },
      ico ? icon(ico) : null,
      label,
    );
  const iconBtn = (ico, aria, onclick, opts = {}) => btn(null, onclick, { ...opts, ico, aria, title: opts.title ?? aria, cls: `ofr-btn-icon ${opts.cls ?? ""}` });
  const chip = (text, { tone, title, ico, cls = "" } = {}) => el("span", { class: `ofr-chip ${cls}`.trim(), "data-tone": tone, title }, ico ? icon(ico) : null, text);
  function stateBox(kind, title, line, actions = []) {
    const text = el("span", {}, el("span", { class: "ofr-state-title", text: title }), line ?? "");
    if (actions.length) text.append(el("span", { class: "ofr-state-actions" }, actions));
    return el("p", { class: "ofr-state", data: { kind } }, text);
  }
  const dot = (color) => el("span", { class: `tn-dot tn-c${color ?? 5}`, "aria-hidden": "true" });
  const announce = (text) => {
    $("tn-live").textContent = text;
  };
  function flash(button, text, ok = true) {
    if (!button) return;
    const before = [...button.childNodes];
    button.dataset.state = ok ? "ok" : "error";
    button.replaceChildren(text);
    announce(text);
    setTimeout(() => {
      delete button.dataset.state;
      button.replaceChildren(...before);
    }, 1600);
  }

  // ---- state -------------------------------------------------------------------------------------
  const state = {
    list: [], // valid tournaments, in index order
    damaged: [], // [{id, raw, error}] kept in storage untouched, never shown as tournaments
    deleted: new Set(), // ids this tab deleted (kept out of the merged index)
    cur: null,
    transient: false, // opened from a link, not saved yet
    tab: null,
    consent: null,
    records: new Map(), // gameId -> slim record
    status: new Map(), // gameId -> {state, error}
    open: new Set(), // expanded rows / games / overrides
    suggest: { gameId: null, picks: null },
    draft: "",
    addNote: null,
    deleteArm: 0,
    damagedArm: null, // {id, at}
    share: null, // {key, info}
    showAll: new Set(),
    approved: new Set(), // tournaments whose many records may be fetched (clicked)
    rev: 0, // bumped on every change of the open tournament (memoised compute)
    recRev: 0, // bumped whenever state.records changes
    saveError: null,
  };
  const byId = (pid) => state.cur?.participants.find((p) => p.id === pid) ?? null;
  const nameOf = (pid) => byId(pid)?.name ?? "?";
  const LIMIT = T.LIMITS.tournaments;
  const stored = () => state.list.length + state.damaged.length;

  // ---- notices (visible, not only for screen readers) -----------------------------------------------
  function notice(kind, title, text) {
    const box = $("tn-notice");
    if (!title) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    box.replaceChildren(stateBox(kind, title, text ?? "", [btn("OK", () => notice(null), { cls: "ofr-btn-sm ofr-btn-ghost", k: "notice-ok" })]));
    announce(`${title}. ${text ?? ""}`);
  }
  function renderSaveError() {
    const box = $("tn-save");
    const err = state.saveError;
    box.hidden = !err;
    if (!err) return box.replaceChildren();
    box.replaceChildren(
      stateBox("error", "Not saved", `${err} Your changes stay on this page; they are saved again with the next change or Retry.`, [
        btn("Retry", () => flush(), { cls: "ofr-btn-sm ofr-btn-primary", k: "save-retry" }),
      ]),
    );
  }
  function setSaveError(err) {
    const text = err ? (isQuota(err) ? "The browser's storage for the extension is full." : `Storage said: ${String(err?.message ?? err).slice(0, 160)}.`) : null;
    if (text === state.saveError) return;
    state.saveError = text;
    renderSaveError();
    if (text) announce(`Not saved. ${text}`);
  }
  const isQuota = (err) => /quota|QUOTA_BYTES|space|too large|413/i.test(String(err?.message ?? err));

  // ---- storage -------------------------------------------------------------------------------------
  // One key per tournament (T.TKEY + id): a save writes only the tournaments that
  // changed, one per request (the launcher caps a request at 1 MB). Before a
  // write the stored copy is read: if another tab saved that tournament after
  // our last edit, theirs wins (last writer per tournament, by `updated`).
  const dirty = new Set();
  let saveTimer = 0;
  let saving = Promise.resolve();
  function save() {
    if (!state.cur) return;
    if (state.transient) {
      if (!T.hasRoom(stored())) {
        refuseFull();
        return;
      }
      // editing a shared tournament makes it yours
      while (state.list.some((x) => x.id === state.cur.id)) state.cur.id = T.blank().id;
      state.list.unshift(state.cur);
      state.transient = false;
      clearHash();
    }
    dirty.add(state.cur.id);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
  }
  function refuseFull() {
    notice("error", "Not saved", `You already keep ${LIMIT} tournaments (the most this page holds). Delete one in Setup, then keep or edit this one.`);
  }
  function flush() {
    clearTimeout(saveTimer);
    saving = saving.then(flushNow, flushNow);
    return saving;
  }
  async function flushNow() {
    const ids = [...dirty];
    dirty.clear();
    try {
      await writeTournaments(ids);
      setSaveError(null);
    } catch (err) {
      let fail = err;
      // full: free the record cache (not the open tournament's games) and try once more
      if (isQuota(err) && (await freeSpace()) > 0) {
        try {
          await writeTournaments(ids);
          setSaveError(null);
          return;
        } catch (err2) {
          fail = err2;
        }
      }
      for (const id of ids) dirty.add(id);
      setSaveError(fail);
    }
  }
  async function writeTournaments(ids) {
    let took = null;
    if (ids.length) {
      const got = await chrome.storage.local.get(ids.map((id) => T.TKEY + id));
      for (const id of ids) {
        const t = state.list.find((x) => x.id === id);
        if (!t) continue;
        const m = T.mergeOne(t, got[T.TKEY + id], { dirty: true });
        if (m.act === "take") {
          m.value.id = id;
          replaceTournament(m.value);
          took = m.value;
          continue;
        }
        await chrome.storage.local.set({ [T.TKEY + id]: t });
      }
    }
    await writeIndex();
    if (took) {
      notice("empty", "Changed in another tab", `"${took.name}" was saved in another tab after your last change here; that version is shown now.`);
      render();
    }
  }
  async function writeIndex() {
    const theirs = (await chrome.storage.local.get(T.TINDEX))[T.TINDEX];
    const idx = T.mergeIndex([...state.list.map((t) => t.id), ...state.damaged.map((d) => d.id)], theirs, [...state.deleted]);
    await chrome.storage.local.set({ [T.TINDEX]: idx, tournamentLast: state.cur && !state.transient ? state.cur.id : null });
  }
  async function removeStored(id) {
    state.deleted.add(id);
    dirty.delete(id);
    try {
      await chrome.storage.local.remove(T.TKEY + id);
      await writeIndex();
      setSaveError(null);
    } catch (err) {
      setSaveError(err);
    }
  }
  function replaceTournament(v) {
    const i = state.list.findIndex((x) => x.id === v.id);
    if (i >= 0) state.list[i] = v;
    else state.list.unshift(v);
    if (state.cur?.id === v.id && !state.transient) {
      state.cur = v;
      state.rev++;
    }
  }
  // Another tab (or this one) wrote a tournament key.
  function onLocalChange(changes) {
    let changed = false;
    for (const [key, ch] of Object.entries(changes)) {
      if (!key.startsWith(T.TKEY)) continue;
      const id = key.slice(T.TKEY.length);
      const mine = state.list.find((x) => x.id === id) ?? null;
      const m = T.mergeOne(mine, ch.newValue, { dirty: dirty.has(id) });
      const di = state.damaged.findIndex((d) => d.id === id);
      if (m.act === "gone") {
        if (di >= 0) state.damaged.splice(di, 1), (changed = true);
        if (!mine) continue;
        state.list = state.list.filter((x) => x !== mine);
        changed = true;
        if (state.cur === mine) {
          state.cur = state.list[0] ?? null;
          state.tab = null;
          notice("empty", "Deleted in another tab", `"${mine.name}" was deleted in another tab.`);
        }
      } else if (m.act === "take") {
        state.deleted.delete(id); // saved again elsewhere after we deleted it: theirs is newer
        if (di >= 0) state.damaged.splice(di, 1);
        const v = T.parseStored(id, ch.newValue);
        if (!v.ok) continue;
        const wasCur = state.cur?.id === id && !state.transient;
        replaceTournament(v.value);
        changed = true;
        if (wasCur && mine) notice("empty", "Changed in another tab", `"${v.value.name}" was saved in another tab; that version is shown now.`);
      } else if (m.act === "damaged") {
        if (di >= 0) state.damaged[di] = { id, raw: ch.newValue, error: m.error };
        else state.damaged.push({ id, raw: ch.newValue, error: m.error });
        changed = true;
      }
    }
    if (changed) render();
  }
  function mutate(fn, { rerender = true } = {}) {
    if (!state.cur) return;
    if (state.transient && !T.hasRoom(stored())) {
      // a shared tournament is kept on its first edit: no room, so the edit is refused
      refuseFull();
      if (rerender) render();
      return;
    }
    fn(state.cur);
    // strictly increasing: the stamp decides which tab's copy wins
    state.cur.updated = Math.max(Date.now(), state.cur.updated + 1);
    state.rev++;
    pruneStale();
    save();
    if (rerender) render();
  }
  // Hand-set results and pins whose two sides no longer meet in the bracket are
  // removed - but only once every game's record is here (a missing record could
  // still bring those sides together).
  function pruneStale() {
    const t = state.cur;
    if (t.format !== "bracket" || !t.games.every((g) => state.records.has(g.id))) return;
    const stale = T.staleRefs(t, compute().br);
    if (!stale.overrides.length && !stale.pins.length) return;
    const gone = new Set(stale.overrides);
    const names = stale.overrides.map((o) => `${nameOf(o.a)} vs ${nameOf(o.b)}`);
    t.overrides = t.overrides.filter((o) => !gone.has(o));
    for (const g of t.games) {
      if (!stale.pins.includes(g.id)) continue;
      names.push(`${g.id} pinned to ${nameOf(g.match.a)} vs ${nameOf(g.match.b)}`);
      delete g.match;
    }
    state.rev++;
    notice("empty", "Cleared what no longer fits the bracket", `Those players no longer meet: ${names.join(" · ")}.`);
  }
  function clearHash() {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    $("tn-shared").hidden = true;
  }

  // Record cache: finished games never change. One key per game keeps each write
  // small (the launcher caps a request at 1 MB); an LRU index caps the total
  // (250 games, more than one tournament's 200; the open tournament's never go).
  let indexChain = Promise.resolve();
  const touches = [];
  const keepIds = () => new Set(state.cur?.games.map((g) => g.id) ?? []);
  function touch(id, bytes) {
    touches.push([id, bytes, Date.now()]);
    indexChain = indexChain.then(async () => {
      if (!touches.length) return;
      const batch = touches.splice(0);
      try {
        const idx = (await chrome.storage.local.get(REC_INDEX))[REC_INDEX];
        const plan = T.cachePlan(idx, batch, T.CACHE_CAPS, keepIds());
        await chrome.storage.local.set({ [REC_INDEX]: plan.index });
        if (plan.evict.length) await chrome.storage.local.remove(plan.evict.map((id) => REC_PREFIX + id));
      } catch {
        // a full or unavailable storage only costs a refetch later
      }
    });
  }
  // Storage full: drop every cached record but the open tournament's. -> count freed
  async function freeSpace() {
    try {
      const idx = (await chrome.storage.local.get(REC_INDEX))[REC_INDEX];
      const plan = T.evictAllBut(idx, keepIds());
      if (!plan.evict.length) return 0;
      await chrome.storage.local.remove(plan.evict.map((id) => REC_PREFIX + id));
      await chrome.storage.local.set({ [REC_INDEX]: plan.index });
      return plan.evict.length;
    } catch {
      return 0;
    }
  }
  async function cachePut(id, rec) {
    try {
      await chrome.storage.local.set({ [REC_PREFIX + id]: rec });
      touch(id, JSON.stringify(rec).length);
    } catch {
      // not cached; still shown
    }
  }

  // ---- records -------------------------------------------------------------------------------------------
  // Status of a game's record: loading (cache or network), need (not cached;
  // waits for the network queue - or for a click when more than T.AUTO_FETCH are
  // due at once, so a crafted link cannot make this page fire 200 requests),
  // queued, ratelimited (HTTP 429: waiting, then retried), pending (not
  // published yet), error, consent (lookups not agreed), ok.
  const inflight = new Set();
  const setStatus = (id, s, error) => state.status.set(id, { state: s, error });
  const statusOf = (id) => state.status.get(id)?.state;

  function ensureRecords() {
    const t = state.cur;
    if (!t) return;
    const fresh = t.games.filter((g) => !state.records.has(g.id) && !inflight.has(g.id) && !statusOf(g.id)).map((g) => g.id);
    if (fresh.length) readCache(fresh);
    if (state.consent !== true) {
      for (const g of t.games) if (statusOf(g.id) === "need") setStatus(g.id, "consent");
      return;
    }
    const need = t.games.filter((g) => statusOf(g.id) === "need").map((g) => g.id);
    if (need.length && (need.length <= T.AUTO_FETCH || state.approved.has(t.id))) for (const id of need) enqueue(id);
  }
  async function readCache(ids) {
    for (const id of ids) {
      inflight.add(id);
      setStatus(id, "loading");
    }
    let got = {};
    try {
      got = await chrome.storage.local.get(ids.map((id) => REC_PREFIX + id));
    } catch {
      got = {};
    }
    for (const id of ids) {
      inflight.delete(id);
      const rec = T.checkSlim(got[REC_PREFIX + id]);
      if (rec && rec.gameId === id) {
        state.records.set(id, rec);
        state.recRev++;
        setStatus(id, "ok");
        touch(id, JSON.stringify(rec).length);
      } else setStatus(id, "need");
    }
    scheduleRender();
  }

  // The network: at most 2 at a time, starts at least 400 ms apart (the worker
  // does not queue gameRecord), and on HTTP 429 everything waits 2 s, 4 s, 8 s
  // before trying again (4 tries, then "failed").
  const NET = { parallel: 2, gap: 400, tries: 4 };
  const netQueue = [];
  const tries = new Map();
  let netRunning = 0;
  let lastStart = 0;
  let pauseUntil = 0;
  let pumpTimer = 0;
  function enqueue(id) {
    if (netQueue.includes(id) || inflight.has(id)) return;
    setStatus(id, "queued");
    netQueue.push(id);
    pump();
  }
  function pump() {
    clearTimeout(pumpTimer);
    while (netQueue.length && netRunning < NET.parallel) {
      const wait = Math.max(pauseUntil, lastStart + NET.gap) - Date.now();
      if (wait > 0) {
        pumpTimer = setTimeout(pump, wait);
        return;
      }
      lastStart = Date.now();
      fetchRecord(netQueue.shift());
    }
  }
  async function fetchRecord(id) {
    netRunning++;
    inflight.add(id);
    setStatus(id, "loading");
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "gameRecord", gameId: id });
    } catch (err) {
      resp = { error: String(err?.message ?? err) };
    }
    netRunning--;
    inflight.delete(id);
    if (resp?.error === "consent") setStatus(id, "consent");
    else if (/\b429\b/.test(String(resp?.error ?? ""))) {
      const n = (tries.get(id) ?? 0) + 1;
      tries.set(id, n);
      if (n >= NET.tries) setStatus(id, "error", "OpenFront is limiting requests: try again in a minute");
      else {
        pauseUntil = Math.max(pauseUntil, Date.now() + 2000 * 2 ** (n - 1));
        setStatus(id, "ratelimited");
        netQueue.unshift(id);
      }
    } else if (resp?.pending) setStatus(id, "pending");
    else if (resp?.error || !resp) setStatus(id, "error", String(resp?.error ?? "no answer").slice(0, 120));
    else {
      const slim = T.checkSlim(T.slimRecord(resp));
      if (!slim) setStatus(id, "error", "unreadable record");
      else {
        slim.gameId = id;
        tries.delete(id);
        state.records.set(id, slim);
        state.recRev++;
        setStatus(id, "ok");
        // the API publishes a record once the game has ended; it never changes after
        if (slim.end != null || slim.winner.type) cachePut(id, slim);
      }
    }
    scheduleRender();
    pump();
  }
  function retry(ids) {
    if (state.cur) state.approved.add(state.cur.id); // a click: fetch them, however many
    for (const id of ids) {
      if (netQueue.includes(id) || inflight.has(id)) continue;
      tries.delete(id);
      state.status.delete(id);
    }
    render();
  }

  // ---- compute -------------------------------------------------------------------------------------------
  // Memoised: recomputed only when the tournament or its records change.
  const computeFor = T.computer();
  const compute = () => computeFor(state.cur, state.records, `${state.rev}:${state.recRev}`);

  // ---- render --------------------------------------------------------------------------------------------
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }
  function render() {
    // keep keyboard focus (and caret) across a re-render, by element key
    const active = document.activeElement;
    const fk = active?.dataset?.k;
    const caret = fk && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
    renderPicker();
    renderConsent();
    renderDamaged();
    const main = $("tn-main");
    main.replaceChildren(state.cur ? renderTournament() : renderNone());
    if (fk) {
      const again = main.querySelector(`[data-k="${CSS.escape(fk)}"]`) ?? document.querySelector(`[data-k="${CSS.escape(fk)}"]`);
      if (again) {
        again.focus({ preventScroll: true });
        if (caret && "setSelectionRange" in again) {
          try {
            again.setSelectionRange(caret[0], caret[1]);
          } catch {
            // not a text field
          }
        }
      }
    }
    ensureRecords();
    if (state.tab === "share" && state.cur) updateShareInfo();
  }

  function renderPicker() {
    const pick = $("tn-pick");
    const items = [...(state.transient && state.cur ? [state.cur] : []), ...state.list];
    pick.replaceChildren(
      ...items.map((t) => el("option", { value: t.id, text: `${t === state.cur && state.transient ? "↗ " : ""}${t.name}` })),
    );
    pick.hidden = items.length === 0;
    if (state.cur) pick.value = state.cur.id;
  }

  function renderConsent() {
    const box = $("tn-consent");
    const needed = state.consent === false && (state.cur?.games.length ?? 0) > 0;
    box.hidden = !needed;
    if (!needed) return;
    box.replaceChildren(
      stateBox("empty", "Game lookups are off", "Results come from OpenFront's public game records. Agree once to fetch them.", [
        btn("Read and turn on", () => chrome.runtime.sendMessage({ type: "openWelcome" }).catch(() => {}), { cls: "ofr-btn-primary ofr-btn-sm", k: "consent" }),
      ]),
    );
  }

  // Saved tournaments that fail validation: kept in storage exactly as they are,
  // listed here (export to fix by hand, or delete), never shown or rewritten.
  function renderDamaged() {
    const box = $("tn-damaged");
    box.hidden = !state.damaged.length;
    if (!state.damaged.length) return box.replaceChildren();
    const n = state.damaged.length;
    const rows = state.damaged.map((d) => {
      const armed = state.damagedArm?.id === d.id && Date.now() - state.damagedArm.at < 4000;
      const label = typeof d.raw?.name === "string" ? T.clean(d.raw.name).slice(0, 60) || d.id : d.id;
      return el(
        "span",
        { class: "tn-row tn-damaged-row" },
        el("b", { text: label, title: label }),
        el("span", { class: "tn-dim", text: d.error }),
        btn("Export", () => download(new Blob([JSON.stringify({ format: "openfront-pro-tournament", version: 1, tournament: d.raw }, null, 1)], { type: "application/json" }), `damaged-${d.id}.tournament.json`), {
          cls: "ofr-btn-sm",
          ico: "file",
          k: `dmg:${d.id}:export`,
          title: "Save it as a file exactly as stored, to fix by hand and import",
        }),
        btn(armed ? "Press again to delete" : "Delete", () => deleteDamaged(d.id), { cls: "ofr-btn-sm ofr-btn-ghost ofr-btn-danger", ico: "close", k: `dmg:${d.id}:rm` }),
      );
    });
    box.replaceChildren(stateBox("error", `${n} saved tournament${n === 1 ? "" : "s"} could not be read`, "Kept in storage unchanged and not shown. Export to fix it by hand, or delete it.", rows));
  }
  function deleteDamaged(id) {
    if (state.damagedArm?.id !== id || Date.now() - state.damagedArm.at > 4000) {
      state.damagedArm = { id, at: Date.now() };
      renderDamaged();
      setTimeout(() => {
        if (state.damagedArm?.id === id && Date.now() - state.damagedArm.at >= 4000) {
          state.damagedArm = null;
          renderDamaged();
        }
      }, 4100);
      return;
    }
    state.damagedArm = null;
    state.damaged = state.damaged.filter((d) => d.id !== id);
    removeStored(id);
    render();
    announce("Deleted");
  }
  // Many records to fetch at once (a big import, a crafted link): wait for a click.
  function fetchGate() {
    const t = state.cur;
    if (state.consent !== true || state.approved.has(t.id)) return null;
    const need = t.games.filter((g) => statusOf(g.id) === "need").length;
    if (need <= T.AUTO_FETCH) return null;
    return el(
      "div",
      { class: "tn-banner" },
      stateBox("empty", `${need} game records to fetch`, "They are asked from OpenFront's public API a few at a time.", [
        btn(`Fetch ${need}`, () => {
          state.approved.add(t.id);
          render();
        }, { cls: "ofr-btn-sm ofr-btn-primary", ico: "download", k: "fetch-go" }),
      ]),
    );
  }

  function renderNone() {
    return el(
      "div",
      { class: "ofr-card tn-card" },
      stateBox("empty", "No tournament yet", "Create one, add the games after they are played, and the standings build themselves.", [
        btn("New tournament", newTournament, { cls: "ofr-btn-primary", ico: "plus", k: "none-new" }),
        btn("Import", () => toggleImport(true), { k: "none-import" }),
      ]),
    );
  }

  function tabsFor(t) {
    const tabs = [["standings", "Standings"]];
    if (t.format === "bracket") tabs.unshift(["bracket", "Bracket"]);
    if (t.format === "series") tabs.unshift(["series", "Series"]);
    tabs.push(["games", "Games"], ["setup", "Setup"], ["share", "Share"]);
    return tabs;
  }

  function renderTournament() {
    const t = state.cur;
    const tabs = tabsFor(t);
    if (!tabs.some(([id]) => id === state.tab)) state.tab = t.participants.length || t.games.length ? tabs[0][0] : "setup";
    const c = compute();
    const frag = document.createDocumentFragment();
    const gate = fetchGate();
    if (gate) frag.append(gate);
    frag.append(renderHero(t, c));
    const strip = el("div", { class: "ofr-tabs tn-tabs", role: "tablist", "aria-label": "Views" });
    for (const [id, label] of tabs) {
      const on = state.tab === id;
      const b = el(
        "button",
        { type: "button", class: "ofr-tab", role: "tab", id: `tn-tab-${id}`, "aria-selected": String(on), "aria-controls": "tn-panel", tabindex: on ? "0" : "-1", k: `tab:${id}` },
        label,
        id === "games" && t.games.length ? el("span", { class: "ofr-tab-count", text: String(t.games.length) }) : null,
      );
      b.addEventListener("click", () => go(id));
      b.addEventListener("keydown", (e) => {
        const i = tabs.findIndex(([x]) => x === id);
        const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        const to = step ? tabs[(i + step + tabs.length) % tabs.length] : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs.at(-1) : null;
        if (!to) return;
        e.preventDefault();
        go(to[0], true);
      });
      strip.append(b);
    }
    frag.append(strip);
    const panel = el("section", { class: "tn-panel", id: "tn-panel", role: "tabpanel", "aria-labelledby": `tn-tab-${state.tab}` });
    const build = { standings: panelStandings, bracket: panelBracket, series: panelSeries, games: panelGames, setup: panelSetup, share: panelShare }[state.tab];
    panel.append(build(c));
    frag.append(panel);
    return frag;
  }
  function go(tab, focusTab = false) {
    state.tab = tab;
    render();
    if (focusTab) document.querySelector(`[data-k="tab:${tab}"]`)?.focus();
  }

  function renderHero(t, c) {
    const f = FORMAT[t.format];
    const played = c.st.games.filter((g) => g.state === "ok").length;
    const chips = el(
      "div",
      { class: "tn-chips" },
      chip(t.format === "league" ? f.label : `${f.label} · Bo${t.bestOf}`, { ico: f.icon, title: f.tip }),
      chip(String(t.participants.length), { ico: UNIT[t.unit].icon, title: `${t.participants.length} ${UNIT[t.unit].label.toLowerCase()}` }),
      chip(`${played}/${t.games.length}`, { ico: "games", title: `${played} of ${t.games.length} games counted` }),
    );
    const hero = el("section", { class: "ofr-card tn-hero" }, el("div", { class: "tn-hero-main" }, el("h2", { text: t.name }), chips));
    let lead = null;
    let caption = "";
    if (c.br?.champion) [lead, caption] = [c.br.champion, "Champion"];
    else if (c.se?.winner) [lead, caption] = [c.se.winner, "Wins the series"];
    else if (c.se && (c.se.winsA || c.se.winsB)) [lead, caption] = [c.se.winsA >= c.se.winsB ? c.se.a : c.se.b, `Leads ${Math.max(c.se.winsA, c.se.winsB)}-${Math.min(c.se.winsA, c.se.winsB)}`];
    else if (t.format === "league" && played && c.st.rows[0]) [lead, caption] = [c.st.rows[0].pid, `Leader · ${c.st.rows[0].points} pts`];
    if (lead) {
      const p = byId(lead);
      hero.append(el("div", { class: `tn-leader tn-c${p?.color ?? 0}` }, icon("trophy", "tn-ico-lg"), el("span", {}, el("b", { text: p?.name ?? "?", title: p?.name ?? "" }), el("small", { text: caption }))));
    }
    return hero;
  }

  // ---- standings -----------------------------------------------------------------------------------------
  function pipFor(slot, s) {
    if (!slot) return el("span", { class: "tn-pip", data: { kind: "absent" }, title: `${s.gameId}: did not play`, text: "·" });
    if (slot.dns) return el("span", { class: "tn-pip", data: { kind: "dns" }, title: `${s.gameId}: joined, never spawned`, text: "×" });
    const kind = slot.won ? "win" : slot.place <= 3 ? "podium" : "normal";
    return el("span", {
      class: "tn-pip",
      data: { kind },
      title: `${s.gameId}${s.rec?.map ? ` · ${s.rec.map}` : ""}\n${slot.won ? "won · " : ""}#${slot.place}${slot.tied ? " (tied)" : ""} of ${slot.field}\n${slot.points} pts`,
      text: `${slot.tied ? "=" : ""}${slot.place}`,
    });
  }
  const TIE_HINT = { wins: ["W", "Level on points: more wins"], avg: ["avg", "Level on points and wins: better average place"], h2h: ["H2H", "Level on points, wins and average place: better head-to-head"], tied: ["=", "Level on everything"] };

  function panelStandings(c) {
    const t = state.cur;
    const wrap = document.createDocumentFragment();
    if (!t.participants.length) {
      wrap.append(stateBox("empty", "No participants yet", "Add them in Setup, or pick them from a game's players.", [btn("Set up", () => go("setup"), { cls: "ofr-btn-sm", k: "st-setup" })]));
      return wrap;
    }
    if (!t.games.length) wrap.append(el("div", { class: "tn-banner" }, stateBox("empty", "No games yet", "Add each game's id or link once it has been played.", [btn("Add games", () => go("games"), { cls: "ofr-btn-sm ofr-btn-primary", k: "st-games" })])));
    const rows = c.st.rows;
    const games = c.st.games;
    const maxPts = Math.max(1, ...rows.map((r) => Math.abs(r.points)));
    const table = el("table", { class: "tn-table" }, el("caption", { class: "tn-sr", text: "Standings" }));
    table.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { class: "tn-rank", scope: "col", title: "Rank", text: "#" }),
          el("th", { class: "tn-who", scope: "col", text: UNIT[t.unit].label }),
          el("th", { class: "tn-pts", scope: "col", text: "Points" }),
          el("th", { class: "tn-w", scope: "col", title: "Wins", text: "W" }),
          el("th", { scope: "col", title: "Place in each game, in the order played", text: "Games" }),
          el("th", { class: "tn-avg", scope: "col", title: "Average place", text: "Avg" }),
          el("th", { class: "tn-more", scope: "col" }, el("span", { class: "tn-sr", text: "Details" })),
        ),
      ),
    );
    const body = el("tbody");
    for (const r of rows) {
      const key = `row:${r.pid}`;
      const open = state.open.has(key);
      const tb = r.tieBreak ? TIE_HINT[r.tieBreak] : null;
      body.append(
        el(
          "tr",
          { data: { top: r.rank <= 3 && r.played ? "1" : "0" } },
          el("td", { class: "tn-rank", text: String(r.rank) }),
          el("td", { class: "tn-who" }, el("div", { class: `tn-name tn-c${r.color}` }, dot(r.color), el("span", { text: r.name, title: r.name }), tb ? chip(tb[0], { cls: "tn-tb", title: tb[1] }) : null)),
          el(
            "td",
            { class: "tn-pts" },
            el(
              "div",
              { class: `tn-bar tn-c${r.color}` },
              el("span", { class: "tn-bar-track", "aria-hidden": "true" }, el("span", { class: "tn-bar-fill", style: `width:${Math.max(0, (100 * r.points) / maxPts).toFixed(1)}%` })),
              el("b", { text: String(r.points), title: `${r.points} points` }),
            ),
          ),
          el("td", { class: "tn-w" }, el("span", { class: "tn-wins", data: { zero: String(r.wins === 0) }, title: `${r.wins} win${r.wins === 1 ? "" : "s"}` }, icon("trophy"), String(r.wins))),
          el("td", {}, el("div", { class: "tn-pips" }, r.places.map((slot, i) => pipFor(slot, games[i])))),
          el("td", { class: "tn-avg", text: r.avgPlace == null ? "–" : String(r.avgPlace) }),
          el("td", { class: "tn-more" }, iconBtn("chevron", `Games of ${r.name}`, () => toggle(key), { k: key, expanded: open, cls: "ofr-btn-sm" })),
        ),
      );
      if (open) {
        const tiles = [];
        r.places.forEach((slot, i) => {
          if (!slot) return;
          const s = games[i];
          const bits = [];
          if (slot.parts.win) bits.push(`win ${slot.parts.win}`);
          if (slot.parts.place) bits.push(`place ${slot.parts.place}`);
          if (slot.parts.conq) bits.push(`conquests ${slot.parts.conq}`);
          tiles.push(
            el(
              "div",
              { class: "ofr-tile" },
              el("div", { class: "tn-line" }, el("span", { class: "tn-mono", text: s.gameId }), el("b", { text: slot.dns ? "×" : `${slot.won ? "🏆 " : ""}#${slot.place}/${slot.field}` })),
              el("div", { class: "tn-line tn-parts" }, el("span", { text: s.rec?.map ?? "" }), el("b", { text: `${slot.points} pts` })),
              bits.length ? el("div", { class: "tn-parts", text: bits.join(" + ") }) : null,
            ),
          );
        });
        body.append(el("tr", { class: "tn-detail" }, el("td", { colspan: "7" }, tiles.length ? el("div", { class: "tn-games-mini" }, tiles) : el("span", { class: "tn-dim", text: "No games yet." }))));
      }
    }
    table.append(body);
    wrap.append(el("section", { class: "ofr-card tn-card", "aria-label": "Standings" }, el("div", { style: "overflow-x:auto" }, table)));
    // head-to-head: who placed better whenever two met
    const played = games.filter((g) => g.state === "ok" && g.rows.length > 1).length;
    if (played && rows.length >= 2 && rows.length <= 12) {
      const h2h = el("table", { class: "tn-h2h" }, el("caption", { class: "tn-sr", text: "Head-to-head: games where the row placed better - worse than the column" }));
      h2h.append(el("thead", {}, el("tr", {}, el("th"), rows.map((r) => el("th", { scope: "col", title: r.name }, el("span", { class: `tn-c${r.color}` }, dot(r.color)), ` ${r.rank}`)))));
      const hb = el("tbody");
      for (const a of rows) {
        const tr = el("tr", {}, el("th", { scope: "row", title: a.name, text: `${a.rank}. ${a.name}` }));
        for (const b of rows) {
          if (a === b) {
            tr.append(el("td", { data: { v: "self" } }));
            continue;
          }
          const cell = c.st.h2h.get(a.pid)?.get(b.pid);
          if (!cell) {
            tr.append(el("td", { data: { v: "none" }, title: `${a.name} and ${b.name} never met`, text: "·" }));
            continue;
          }
          const v = cell.w > cell.l ? "up" : cell.w < cell.l ? "down" : "even";
          tr.append(el("td", { data: { v }, title: `${a.name} vs ${b.name}: placed better ${cell.w}, worse ${cell.l}${cell.d ? `, level ${cell.d}` : ""}`, text: cell.w || cell.l ? `${cell.w}-${cell.l}` : "=" }));
        }
        hb.append(tr);
      }
      h2h.append(hb);
      wrap.append(el("section", { class: "ofr-card tn-card" }, el("h3", { class: "ofr-eyebrow", text: "Head-to-head" }), el("div", { class: "tn-h2h-wrap" }, h2h)));
    }
    return wrap;
  }
  function toggle(key) {
    if (state.open.has(key)) state.open.delete(key);
    else state.open.add(key);
    render();
  }

  // ---- bracket ------------------------------------------------------------------------------------------------
  const roundName = (r, total) => (r === total - 1 ? "Final" : r === total - 2 ? "Semi-finals" : r === total - 3 ? "Quarter-finals" : `Round ${r + 1}`);
  function panelBracket(c) {
    const t = state.cur;
    const br = c.br;
    if (t.participants.length < 2) return stateBox("empty", "A bracket needs two or more participants", "Seeds follow the order in Setup.", [btn("Set up", () => go("setup"), { cls: "ofr-btn-sm", k: "br-setup" })]);
    const wrap = document.createDocumentFragment();
    const board = el("div", { class: "tn-bracket" });
    br.rounds.forEach((matches, r) => {
      board.append(
        el(
          "div",
          { class: "tn-round" },
          el("h3", { class: "ofr-eyebrow tn-round-title", text: roundName(r, br.rounds.length) }),
          el("div", { class: "tn-round-body" }, matches.map((m) => matchCard(m, br))),
        ),
      );
    });
    const champ = br.champion ? byId(br.champion) : null;
    board.append(
      el(
        "div",
        { class: `tn-champ${champ ? ` tn-c${champ.color}` : ""}`, data: { set: String(Boolean(champ)) } },
        icon("trophy"),
        el("span", { class: "ofr-eyebrow", text: "Champion" }),
        el("b", { text: champ?.name ?? "—", title: champ?.name ?? "Not decided yet" }),
      ),
    );
    wrap.append(el("section", { class: "ofr-card tn-card", "aria-label": "Bracket" }, el("div", { class: "tn-bracket-scroll" }, board)));
    const WHY = {
      none: [null, "No open match had both of its sides in this game (still counts in Standings)"],
      pin: ["warn", "Pinned to a match that is not open (already decided, or those two do not meet): counted nowhere in the bracket. Change the pin in Games."],
      void: ["bad", "The game ended without a result"],
      missing: [null, "Record not loaded yet"],
    };
    const shown = br.unplaced.filter((u) => u.why !== "missing");
    const stale = T.staleRefs(t, br);
    if (shown.length || stale.overrides.length || stale.pins.length) {
      wrap.append(
        el(
          "section",
          { class: "ofr-card tn-card" },
          el("h3", { class: "ofr-eyebrow", text: "Not in the bracket" }),
          el(
            "div",
            { class: "tn-chips" },
            shown.map((u) => chip(`${u.gameId}${u.why === "pin" ? " · pinned" : ""}`, { cls: "tn-mono", tone: WHY[u.why]?.[0], title: WHY[u.why]?.[1] })),
            stale.overrides.map((o) => chip(`${nameOf(o.a)} vs ${nameOf(o.b)}: ${nameOf(o.winner)} (set)`, { tone: "warn", title: "A hand-set result for two sides that do not meet in the bracket now: ignored" })),
          ),
          stale.overrides.length || stale.pins.length
            ? el(
                "div",
                { class: "tn-row", style: "margin-top:8px" },
                btn("Clear what no longer fits", () => mutate((tt) => {
                  const s = T.staleRefs(tt, compute().br);
                  tt.overrides = tt.overrides.filter((o) => !s.overrides.includes(o));
                  for (const g of tt.games) if (s.pins.includes(g.id)) delete g.match;
                }), { cls: "ofr-btn-sm", k: "br:clear-stale", title: "Remove hand-set results and pins whose players no longer meet" }),
              )
            : null,
        ),
      );
    }
    return wrap;
  }
  function matchCard(m, br) {
    const key = `ovr:${m.id}`;
    const open = state.open.has(key);
    const real = (pid) => pid && pid !== br.BYE;
    const side = (pid, seed, wins, other) => {
      if (pid === br.BYE) return el("div", { class: "tn-side" }, el("span", { class: "tn-seed" }), el("span", { class: "tn-n tn-dim", text: "bye" }));
      if (!pid) return el("div", { class: "tn-side", title: "Waiting for the match before" }, el("span", { class: "tn-seed" }), el("span", { class: "tn-n", text: "—" }));
      const p = byId(pid);
      const won = m.winner === pid;
      const score = el("span", { class: "tn-score", title: `${wins} of ${m.need} wins needed` });
      if (real(other) && m.by !== "bye") for (let i = 0; i < m.need; i++) score.append(el("i", { data: { on: String(i < wins || (won && m.by === "override" && i === 0)) } }));
      return el(
        "div",
        { class: `tn-side tn-c${p?.color ?? 5}`, data: { won: String(won), lost: String(Boolean(m.winner) && !won), live: String(!m.winner) } },
        el("span", { class: "tn-seed", text: seed ? String(seed) : "" }),
        dot(p?.color),
        el("span", { class: "tn-n", text: p?.name ?? "?", title: p?.name ?? "" }),
        score,
      );
    };
    const note =
      m.by === "override" ? "set by hand" : m.by === "bye" ? "bye" : m.games.length ? `${m.games.length} game${m.games.length === 1 ? "" : "s"}${m.draws ? ` · ${m.draws} level` : ""}` : real(m.a) && real(m.b) ? "to play" : "";
    const card = el(
      "div",
      { class: "tn-match", data: { open: String(open) }, title: m.games.length ? `Games: ${m.games.map((g) => g.gameId).join(", ")}` : null },
      side(m.a, m.seedA, m.winsA, m.b),
      side(m.b, m.seedB, m.winsB, m.a),
      el(
        "div",
        { class: "tn-match-foot" },
        el("span", { text: note }),
        real(m.a) && real(m.b) ? iconBtn("more", `Set the result of ${nameOf(m.a)} vs ${nameOf(m.b)}`, () => toggle(key), { k: key, expanded: open }) : null,
      ),
    );
    if (open && real(m.a) && real(m.b)) {
      // stored by the two sides, not the position: a reseed cannot hand it to others
      const cur = T.overrideFor(state.cur, m.a, m.b)?.winner;
      const set = (pid) => mutate((t) => T.setOverride(t, m.a, m.b, pid));
      card.append(
        el(
          "div",
          { class: "tn-override", role: "group", "aria-label": "Winner" },
          btn(nameOf(m.a), () => set(m.a), { cls: "ofr-btn-sm", pressed: cur === m.a, k: `${key}:a`, title: `${nameOf(m.a)} wins` }),
          btn(nameOf(m.b), () => set(m.b), { cls: "ofr-btn-sm", pressed: cur === m.b, k: `${key}:b`, title: `${nameOf(m.b)} wins` }),
          btn("Auto", () => set(null), { cls: "ofr-btn-sm ofr-btn-ghost", pressed: !cur, k: `${key}:auto`, title: "From the recorded games" }),
        ),
      );
    }
    return card;
  }

  // ---- series ---------------------------------------------------------------------------------------------------
  function panelSeries(c) {
    const t = state.cur;
    const se = c.se;
    if (t.participants.length < 2) return stateBox("empty", "A series needs two sides", "The first two participants in Setup play it.", [btn("Set up", () => go("setup"), { cls: "ofr-btn-sm", k: "se-setup" })]);
    const A = byId(se.a);
    const B = byId(se.b);
    const wrap = document.createDocumentFragment();
    const sideEl = (p, won) => el("div", { class: `tn-score-side tn-c${p.color}`, data: { won: String(won) } }, dot(p.color), el("b", { text: p.name, title: p.name }));
    const slots = el("div", { class: "tn-slots", role: "img", "aria-label": `${se.winsA} to ${se.winsB}, best of ${se.bestOf}` });
    const counted = se.games.filter((g) => !g.extra);
    for (let i = 0; i < se.bestOf; i++) {
      const g = counted[i];
      const p = g?.winner ? byId(g.winner) : null;
      // data-won only on a won slot (el() leaves null out)
      slots.append(el("span", { class: `tn-slot${p ? ` tn-c${p.color}` : ""}`, data: { won: p ? p.id : null, draw: String(Boolean(g && !g.winner)) }, title: g ? `${g.gameId}: ${p ? `${p.name} won` : "level"}` : `Game ${i + 1}: not played` }));
    }
    const winner = se.winner ? byId(se.winner) : null;
    const card = el(
      "section",
      { class: "ofr-card tn-card", "aria-label": "Series" },
      el(
        "div",
        { class: "tn-score" },
        sideEl(A, se.winner === A.id),
        el("div", { class: "tn-score-num", "aria-label": `${se.winsA} - ${se.winsB}` }, String(se.winsA), el("span", { text: " – " }), String(se.winsB)),
        sideEl(B, se.winner === B.id),
      ),
      slots,
      el(
        "p",
        { class: "tn-row", style: "justify-content:center;margin:12px 0 0" },
        winner ? chip(`${winner.name} wins${se.by === "override" ? " (set by hand)" : ""}`, { tone: "accent", ico: "trophy" }) : chip(`First to ${se.need}`, { title: `Best of ${se.bestOf}` }),
        t.participants.length > 2 ? chip(`first two of ${t.participants.length}`, { tone: "warn", title: "A series is played by the first two participants in Setup" }) : null,
      ),
    );
    wrap.append(card);
    if (se.games.length) {
      wrap.append(
        el(
          "section",
          { class: "ofr-card tn-card" },
          el("h3", { class: "ofr-eyebrow", text: "Games" }),
          el(
            "div",
            { class: "tn-chips" },
            se.games.map((g, i) => {
              const p = g.winner ? byId(g.winner) : null;
              return el(
                "span",
                { class: `ofr-chip${p ? ` tn-c${p.color}` : ""}`, title: `${g.gameId}${g.extra ? " (after the series was decided: not counted)" : ""}` },
                el("span", { class: "tn-dim", text: `${i + 1}` }),
                p ? dot(p.color) : null,
                p ? p.name : "level",
                g.extra ? " ·extra" : "",
              );
            }),
          ),
        ),
      );
    }
    const cur = T.overrideFor(t, A.id, B.id)?.winner;
    const set = (pid) => mutate((tt) => T.setOverride(tt, A.id, B.id, pid));
    wrap.append(
      el(
        "section",
        { class: "ofr-card tn-card" },
        el("h3", { class: "ofr-eyebrow", text: "Result" }),
        el(
          "div",
          { class: "tn-row", role: "group", "aria-label": "Series winner" },
          btn(A.name, () => set(A.id), { cls: "ofr-btn-sm", pressed: cur === A.id, k: "se:a", title: `Set ${A.name} as the winner` }),
          btn(B.name, () => set(B.id), { cls: "ofr-btn-sm", pressed: cur === B.id, k: "se:b", title: `Set ${B.name} as the winner` }),
          btn("Auto", () => set(null), { cls: "ofr-btn-sm ofr-btn-ghost", pressed: !cur, k: "se:auto", title: "From the recorded games" }),
        ),
      ),
    );
    return wrap;
  }

  // ---- games --------------------------------------------------------------------------------------------------------
  function addGames() {
    const { ids, bad } = T.parseGameRefs(state.draft, T.LIMITS.games);
    const t = state.cur;
    const fresh = ids.filter((id) => !t.games.some((g) => g.id === id));
    const room = T.LIMITS.games - t.games.length;
    const added = fresh.slice(0, Math.max(0, room));
    state.addNote = { added: added.length, dup: ids.length - fresh.length, bad, full: fresh.length > added.length };
    state.draft = bad.join(" ");
    if (added.length) mutate((tt) => tt.games.push(...added.map((id) => ({ id, assign: {} }))));
    else render();
    announce(`${added.length} game${added.length === 1 ? "" : "s"} added`);
  }
  function panelGames(c) {
    const t = state.cur;
    const wrap = document.createDocumentFragment();
    const area = el("textarea", {
      class: "ofr-input",
      k: "add",
      rows: "2",
      value: state.draft,
      spellcheck: "false",
      "aria-label": "Game ids or links",
      placeholder: "Game ids or links, one or many:\nhttps://openfront.io/game/AbCd1234   #join=AbCd1234   AbCd1234",
    });
    area.addEventListener("input", () => (state.draft = area.value));
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addGames();
      }
    });
    const note = state.addNote;
    const notes = note
      ? el(
          "div",
          { class: "tn-chips" },
          note.added ? chip(`+${note.added}`, { tone: "good", title: `${note.added} added` }) : null,
          note.dup ? chip(`${note.dup} already in`, {}) : null,
          note.bad.length ? chip(`${note.bad.length} not a game id`, { tone: "bad", title: note.bad.join("\n") }) : null,
          note.full ? chip(`limit ${T.LIMITS.games}`, { tone: "warn" }) : null,
        )
      : null;
    wrap.append(
      el(
        "section",
        { class: "ofr-card tn-card" },
        el("h3", { class: "ofr-eyebrow", text: "Add games" }),
        el("div", { class: "tn-add" }, area, el("div", { class: "tn-add-side" }, btn("Add", addGames, { cls: "ofr-btn-primary", ico: "plus", k: "add-go", title: "Add (Ctrl+Enter)" }), notes)),
      ),
    );
    if (!t.games.length) {
      wrap.append(stateBox("empty", "No games yet", "Paste each game's id or link once it has been played. OpenFront publishes the record when the game ends."));
      return wrap;
    }
    const waiting = t.games.filter((g) => ["pending", "error", "need"].includes(statusOf(g.id))).map((g) => g.id);
    const list = el("section", { class: "ofr-card tn-card", "aria-label": "Games" });
    list.append(
      el(
        "div",
        { class: "tn-row", style: "margin-bottom:8px" },
        el("h3", { class: "ofr-eyebrow", style: "margin:0;flex:1", text: `Games · ${t.games.length}` }),
        waiting.length ? btn(`Retry ${waiting.length}`, () => retry(waiting), { cls: "ofr-btn-sm", ico: "refresh", k: "retry-all", title: "Ask OpenFront again for games not published yet or failed" }) : null,
      ),
    );
    c.st.games.forEach((s, i) => list.append(gameCard(s, i, c)));
    wrap.append(list);
    return wrap;
  }
  function gameCard(s, i, c) {
    const t = state.cur;
    const g = s.game;
    const st = state.status.get(g.id)?.state ?? "loading";
    const rec = state.records.get(g.id);
    const key = `game:${g.id}`;
    const open = state.open.has(key);
    const visual = rec ? (s.state === "void" ? "void" : "ok") : st;
    const head = el("div", { class: "tn-game-head" }, el("span", { class: "tn-num", text: String(i + 1) }), el("span", { class: "tn-mono", text: g.id, title: `Game ${g.id}` }));
    if (rec) {
      if (rec.map) head.append(chip(rec.map, { title: "Map" }));
      if (rec.mode) head.append(chip(rec.teams && /team/i.test(rec.mode) ? `${rec.mode} · ${rec.teams}` : rec.mode, { title: "Mode" }));
      const when = rec.start ?? rec.end;
      if (when) head.append(el("span", { class: "tn-dim", text: new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric" }), title: new Date(when).toLocaleString() }));
      head.append(chip(String(rec.players.filter((p) => p.active).length), { ico: "player", title: "Players who played" }));
    }
    const statusChip = {
      loading: chip("loading", { title: "Asking OpenFront for this game's record" }),
      queued: chip("queued", { title: "Waiting its turn: records are fetched a few at a time" }),
      need: chip("not fetched", { title: "Press Fetch (above) or Retry to ask OpenFront for it" }),
      ratelimited: chip("rate-limited, retrying", { tone: "warn", title: "OpenFront asked us to slow down: waiting, then trying again" }),
      pending: chip("not published yet", { tone: "warn", title: "OpenFront publishes the record when the game ends. Try again later." }),
      error: chip("failed", { tone: "bad", title: state.status.get(g.id)?.error ?? "" }),
      consent: chip("lookups off", { tone: "warn", title: "Agree to game lookups (banner above) to fetch it" }),
      void: chip("no result", { tone: "bad", title: "The game ended without a result: nobody has stats" }),
      ok: null,
    }[visual];
    if (statusChip) head.append(statusChip);
    head.append(el("span", { class: "tn-grow" }));
    if (st === "pending" || st === "error" || st === "need") head.append(iconBtn("refresh", `Retry ${g.id}`, () => retry([g.id]), { k: `${key}:retry`, cls: "ofr-btn-sm" }));
    if (t.format === "bracket" && c.br && t.participants.length > 1) {
      // a pin names the two sides; it counts in their match or nowhere
      const total = c.br.rounds.length;
      const matches = c.br.rounds.flat().filter((m) => m.a && m.b && m.a !== c.br.BYE && m.b !== c.br.BYE);
      const pinKey = g.match ? T.pairKey(g.match.a, g.match.b) : "";
      const known = matches.some((m) => T.pairKey(m.a, m.b) === pinKey);
      const sel = el(
        "select",
        { class: "ofr-input ofr-input-sm tn-pin", k: `${key}:match`, "aria-label": `Bracket match for ${g.id}`, title: "Bracket match: Auto = the earliest open match with both sides in this game" },
        el("option", { value: "", text: "Auto" }),
        matches.map((m) => el("option", { value: T.pairKey(m.a, m.b), text: `${roundName(m.round, total)}: ${nameOf(m.a)} v ${nameOf(m.b)}` })),
        g.match && !known ? el("option", { value: pinKey, text: `${nameOf(g.match.a)} v ${nameOf(g.match.b)} (not in the bracket)` }) : null,
      );
      sel.value = pinKey;
      sel.addEventListener("change", () =>
        mutate(() => {
          const m = matches.find((x) => T.pairKey(x.a, x.b) === sel.value);
          if (m) g.match = { a: m.a, b: m.b };
          else if (!sel.value) delete g.match;
        }),
      );
      head.append(sel);
    }
    const unmatched = s.unmatched?.filter((u) => u.active || u.ambiguous) ?? [];
    const manual = rec ? Object.keys(g.assign).length : 0;
    if (rec && t.participants.length && (unmatched.length || manual)) {
      const amb = unmatched.filter((u) => u.ambiguous).length;
      head.append(
        el(
          "button",
          { type: "button", class: "ofr-chip", "data-tone": amb ? "warn" : null, k: key, "aria-expanded": String(open), title: "Players this game has that no participant claims: assign them", onclick: () => toggle(key) },
          `? ${unmatched.length}`,
          manual ? ` · ✎ ${manual}` : "",
        ),
      );
    }
    head.append(iconBtn("close", `Remove ${g.id}`, () => mutate((tt) => (tt.games = tt.games.filter((x) => x !== g))), { k: `${key}:rm`, cls: "ofr-btn-sm" }));
    const card = el("div", { class: "ofr-tile tn-game", data: { state: visual } }, head);
    if (rec && s.rows.length) {
      const podium = el("div", { class: "tn-podium" });
      for (const r of s.rows.slice(0, 8)) {
        const p = byId(r.pid);
        podium.append(
          el(
            "span",
            { class: `ofr-chip tn-c${p?.color ?? 5}`, "data-tone": r.won ? "accent" : null, title: `${p?.name}: ${r.dns ? "never spawned" : `#${r.place}${r.tied ? " (tied)" : ""}`} · ${r.points} pts\n${r.players.map((x) => (x.clanTag ? `[${x.clanTag}] ` : "") + x.username).join(", ")}` },
            dot(p?.color),
            el("span", { text: `${r.dns ? "×" : `${r.tied ? "=" : ""}${r.place}`} ${p?.name ?? "?"}` }),
          ),
        );
      }
      if (s.rows.length > 8) podium.append(chip(`+${s.rows.length - 8}`));
      card.append(podium);
    } else if (rec && s.state === "ok" && t.participants.length) {
      card.append(el("span", { class: "tn-dim", text: "No participant found in this game." }));
    }
    if (open && rec) card.append(assignBox(g, unmatched, rec));
    return card;
  }
  function assignBox(g, unmatched, rec) {
    const t = state.cur;
    const key = `game:${g.id}`;
    const box = el("div", {});
    const assigned = Object.entries(g.assign);
    if (assigned.length) {
      const chips = assigned.map(([cid, pid]) => {
        const pl = rec.players.find((p) => p.clientID === cid);
        const label = `${pl ? pl.username : cid} → ${pid ? nameOf(pid) : "not in tournament"}`;
        return el(
          "button",
          { type: "button", class: "ofr-chip", k: `${key}:un:${cid}`, title: "Undo this choice", onclick: () => mutate(() => delete g.assign[cid]) },
          label,
          " ✕",
        );
      });
      box.append(el("div", { class: "tn-cands" }, chips));
    }
    const all = state.showAll.has(key);
    const shown = all ? unmatched : unmatched.slice(0, 24);
    const grid = el("div", { class: "tn-unmatched" });
    for (const u of shown) {
      if (!u.key) continue;
      const sel = el(
        "select",
        { class: "ofr-input ofr-input-sm", k: `${key}:as:${u.key}`, "aria-label": `Assign ${u.username}` },
        el("option", { value: "", text: "—" }),
        el("option", { value: "-", text: "Not in tournament" }),
        t.participants.map((p) => el("option", { value: p.id, text: p.name })),
        t.participants.length < T.LIMITS.participants ? el("option", { value: "+", text: "+ New participant" }) : null,
      );
      sel.addEventListener("change", () => {
        const v = sel.value;
        if (!v) return;
        mutate((tt) => {
          if (Object.keys(g.assign).length >= T.LIMITS.assign) return;
          if (v === "-") g.assign[u.key] = "";
          else if (v === "+") {
            const p = T.newParticipant(tt, { name: u.username, tags: u.clanTag && tt.unit === "player" ? [u.clanTag] : [] });
            tt.participants.push(p);
            g.assign[u.key] = p.id;
          } else g.assign[u.key] = v;
        });
      });
      grid.append(
        el(
          "label",
          { title: u.ambiguous ? "Two participants could be this player" : "Not claimed by any participant" },
          u.ambiguous ? el("span", { class: "ofr-chip", "data-tone": "warn", style: "flex:none", text: "2?" }) : null,
          el("span", { text: `${u.clanTag ? `[${u.clanTag}] ` : ""}${u.username}` }),
          sel,
        ),
      );
    }
    box.append(grid);
    if (unmatched.length > shown.length) {
      box.append(btn(`Show all ${unmatched.length}`, () => (state.showAll.add(key), render()), { cls: "ofr-btn-sm ofr-btn-ghost", k: `${key}:all` }));
    }
    return box;
  }

  // ---- setup --------------------------------------------------------------------------------------------------------
  const splitList = (v, re) => String(v).split(re).map((s) => s.trim()).filter(Boolean);
  function seg(label, options, current, onpick, kp) {
    return el(
      "div",
      { class: "tn-seg", role: "group", "aria-label": label },
      options.map(([value, text, ico, title]) => btn(text, () => onpick(value), { pressed: current === value, k: `${kp}:${value}`, ico, title, cls: "ofr-btn-sm" })),
    );
  }
  function panelSetup(c) {
    const t = state.cur;
    const wrap = document.createDocumentFragment();
    const name = el("input", { class: "ofr-input", id: "tn-name", k: "name", value: t.name, maxlength: String(T.LIMITS.name), autocomplete: "off" });
    name.addEventListener("input", () => {
      // control / bidi characters (T.BAD_CHARS) are stripped, never saved
      const v = T.clean(name.value).trim();
      const ok = v.length > 0;
      name.setAttribute("aria-invalid", String(!ok));
      if (ok) mutate((tt) => (tt.name = v), { rerender: false });
    });
    name.addEventListener("change", () => render());
    const sc = t.scoring;
    const numInput = (k, value, label, onok, { min = -1000, max = 1000 } = {}) => {
      const inp = el("input", { class: "ofr-input", type: "number", step: "0.5", min: String(min), max: String(max), k, value: String(value), "aria-label": label });
      inp.addEventListener("input", () => {
        const n = Number(inp.value);
        const ok = inp.value !== "" && Number.isFinite(n) && n >= min && n <= max;
        inp.setAttribute("aria-invalid", String(!ok));
        if (ok) mutate((tt) => onok(tt, Math.round(n * 10) / 10), { rerender: false });
      });
      inp.addEventListener("change", () => render());
      return inp;
    };
    const table = el("input", { class: "ofr-input tn-wide", k: "sc:place", value: sc.place.join(", "), "aria-label": "Points by place: 1st, 2nd, 3rd …", placeholder: "10, 7, 5, 3" });
    table.addEventListener("input", () => {
      const parts = splitList(table.value, /[\s,;]+/);
      const nums = parts.map(Number);
      const ok = parts.length <= T.LIMITS.place && nums.every((n) => Number.isFinite(n) && Math.abs(n) <= 1000);
      table.setAttribute("aria-invalid", String(!ok));
      if (ok) mutate((tt) => ((tt.scoring.place = nums.map((n) => Math.round(n * 10) / 10)), (tt.scoring.preset = "custom")), { rerender: false });
    });
    table.addEventListener("change", () => render());
    const top = Math.max(1, ...sc.place.map(Math.abs));
    const ladder = el(
      "div",
      { class: "tn-ladder", "aria-hidden": "true", title: "Points by place" },
      sc.place.slice(0, 16).map((v) => el("i", { style: `height:${Math.max(4, (40 * Math.max(0, v)) / top)}px` })),
    );
    const presetPick = (id) =>
      mutate((tt) => {
        const p = T.PRESETS[id];
        tt.scoring = { preset: id, win: p.win, place: [...p.place], conquest: p.conquest };
      });
    const form = el(
      "div",
      { class: "tn-form" },
      el("label", { class: "tn-label", for: "tn-name", text: "Name" }),
      name,
      el("span", { class: "tn-label", text: "Format" }),
      seg(
        "Format",
        Object.entries(FORMAT).map(([id, f]) => [id, f.label, f.icon, f.tip]),
        t.format,
        (v) => mutate((tt) => (tt.format = v)),
        "fmt",
      ),
      t.format !== "league" ? el("span", { class: "tn-label", text: "Best of" }) : null,
      t.format !== "league" ? seg("Best of", T.BEST_OF.map((n) => [n, String(n), null, `First to ${Math.floor(n / 2) + 1} wins`]), t.bestOf, (v) => mutate((tt) => (tt.bestOf = v)), "bo") : null,
      el("span", { class: "tn-label", text: "Participants are" }),
      seg(
        "Participants are",
        Object.entries(UNIT).map(([id, u]) => [id, u.label, u.icon, id === "player" ? "Matched by name (clan tag breaks ties)" : "Matched by clan tag or listed members"]),
        t.unit,
        (v) => mutate((tt) => (tt.unit = v)),
        "unit",
      ),
      el("span", { class: "tn-label", text: "Scoring" }),
      el(
        "div",
        {},
        el(
          "div",
          { class: "tn-row" },
          seg("Scoring preset", [...Object.entries(T.PRESETS).map(([id, p]) => [id, p.label, null, `${p.win} per win · places ${p.place.join("/") || "none"} · ${p.conquest} per conquest`])], sc.preset, presetPick, "preset"),
          sc.preset === "custom" ? chip("Custom", { tone: "accent", title: "Your own points" }) : null,
        ),
        el(
          "div",
          { class: "tn-scoring", style: "margin-top:10px" },
          el("label", { class: "tn-field" }, "Win", numInput("sc:win", sc.win, "Points for a win", (tt, n) => ((tt.scoring.win = n), (tt.scoring.preset = "custom")))),
          el("label", { class: "tn-field" }, "Places 1st, 2nd …", table),
          ladder,
          el("label", { class: "tn-field", title: "Per player conquered (eliminated)" }, "Per conquest", numInput("sc:conq", sc.conquest, "Points per player conquered", (tt, n) => ((tt.scoring.conquest = n), (tt.scoring.preset = "custom")), { min: -100, max: 100 })),
        ),
      ),
    );
    wrap.append(el("section", { class: "ofr-card tn-card" }, form));
    wrap.append(participantsCard(c));
    const armed = Date.now() - state.deleteArm < 4000;
    wrap.append(
      el(
        "section",
        { class: "ofr-card tn-card tn-row" },
        btn(armed ? "Press again to delete" : "Delete tournament", deleteTournament, { cls: "ofr-btn-sm ofr-btn-ghost ofr-btn-danger", k: "delete", ico: "close" }),
        el("span", { class: "tn-dim", text: "Saved in this browser only. Export it from Share to keep a copy." }),
      ),
    );
    return wrap;
  }
  function participantsCard() {
    const t = state.cur;
    const card = el("section", { class: "ofr-card tn-card", "aria-label": "Participants" });
    card.append(el("h3", { class: "ofr-eyebrow", text: `${UNIT[t.unit].label} · ${t.participants.length}/${T.LIMITS.participants}` }, t.format === "bracket" ? el("small", { text: "order = seeding" }) : null));
    const list = el("div", { class: "tn-plist" });
    t.participants.forEach((p, i) => {
      const kp = `p:${p.id}`;
      const name = el("input", { class: "ofr-input ofr-input-sm", k: `${kp}:name`, value: p.name, maxlength: String(T.LIMITS.pname), "aria-label": `Name of participant ${i + 1}`, autocomplete: "off", spellcheck: "false" });
      name.addEventListener("input", () => {
        const v = T.clean(name.value).trim();
        const ok = v.length > 0;
        name.setAttribute("aria-invalid", String(!ok));
        if (ok) mutate(() => (p.name = v), { rerender: false });
      });
      name.addEventListener("change", () => render());
      const tags = el("input", { class: "ofr-input ofr-input-sm", k: `${kp}:tags`, value: p.tags.join(" "), placeholder: "clan tags", "aria-label": `Clan tags of ${p.name}`, autocomplete: "off", spellcheck: "false" });
      tags.addEventListener("change", () => {
        const list = splitList(tags.value.replace(/[[\]]/g, " "), /[\s,;]+/).filter((s) => /^[\p{L}\p{N}_.-]{1,10}$/u.test(s));
        mutate(() => (p.tags = [...new Set(list)].slice(0, T.LIMITS.tags)));
      });
      const members =
        t.unit === "team"
          ? el("input", { class: "ofr-input ofr-input-sm tn-members", k: `${kp}:members`, value: p.members.join(", "), placeholder: "players (comma-separated)", "aria-label": `Players of ${p.name}`, autocomplete: "off", spellcheck: "false" })
          : null;
      members?.addEventListener("change", () => {
        const list = splitList(T.clean(members.value), /,/).filter((s) => s.length <= T.LIMITS.pname);
        mutate(() => (p.members = [...new Set(list)].slice(0, T.LIMITS.members)));
      });
      const move = (d) =>
        mutate((tt) => {
          const j = i + d;
          if (j < 0 || j >= tt.participants.length) return;
          [tt.participants[i], tt.participants[j]] = [tt.participants[j], tt.participants[i]];
        });
      list.append(
        el(
          "div",
          { class: "tn-prow", data: { unit: t.unit } },
          el("span", { class: "tn-seedno", text: String(i + 1) }),
          el("button", { type: "button", class: `tn-swatch tn-c${p.color}`, k: `${kp}:color`, "aria-label": `Colour of ${p.name}: change`, title: "Colour", onclick: () => mutate(() => (p.color = (p.color + 1) % T.COLORS)) }),
          name,
          tags,
          members,
          el(
            "span",
            { class: "tn-prow-btns" },
            iconBtn("up", `Move ${p.name} up`, () => move(-1), { k: `${kp}:up`, cls: "ofr-btn-sm", disabled: i === 0 }),
            iconBtn("down", `Move ${p.name} down`, () => move(1), { k: `${kp}:down`, cls: "ofr-btn-sm", disabled: i === t.participants.length - 1 }),
            iconBtn("close", `Remove ${p.name}`, () => removeParticipant(p.id), { k: `${kp}:rm`, cls: "ofr-btn-sm" }),
          ),
        ),
      );
    });
    card.append(list);
    const full = t.participants.length >= T.LIMITS.participants;
    card.append(
      el(
        "div",
        { class: "tn-row", style: "margin-top:10px" },
        btn(t.unit === "team" ? "Team" : "Player", () => addParticipant(), { cls: "ofr-btn-sm", ico: "plus", k: "p-add", disabled: full, title: "Add a participant" }),
      ),
    );
    card.append(suggestBox());
    return card;
  }
  function addParticipant(fields = {}) {
    mutate((t) => {
      if (t.participants.length >= T.LIMITS.participants) return;
      const n = t.participants.length + 1;
      t.participants.push(T.newParticipant(t, { name: fields.name ?? `${t.unit === "team" ? "Team" : "Player"} ${n}`, ...fields }));
    });
    const last = state.cur.participants.at(-1);
    if (last) document.querySelector(`[data-k="p:${last.id}:name"]`)?.focus();
  }
  function removeParticipant(pid) {
    mutate((t) => {
      t.participants = t.participants.filter((p) => p.id !== pid);
      for (const g of t.games) {
        for (const [k, v] of Object.entries(g.assign)) if (v === pid) delete g.assign[k];
        if (g.match && (g.match.a === pid || g.match.b === pid)) delete g.match;
      }
      t.overrides = t.overrides.filter((o) => o.a !== pid && o.b !== pid);
    });
  }
  // Participants from a game's players: names, clan tags, team slots.
  function suggestBox() {
    const t = state.cur;
    const loaded = t.games.map((g) => state.records.get(g.id)).filter(Boolean);
    if (!loaded.length) return el("p", { class: "tn-dim", style: "margin:10px 0 0", text: "Tip: add a game first, then pick participants from its players." });
    const sg = state.suggest;
    if (!sg.gameId || !loaded.some((r) => r.gameId === sg.gameId)) {
      sg.gameId = loaded[0].gameId;
      sg.picks = null;
    }
    const rec = state.records.get(sg.gameId);
    const have = new Set(t.participants.map((p) => T.nameKey(p.name)));
    const cands = T.suggestParticipants(rec, t.unit).filter((p) => !have.has(T.nameKey(p.name)));
    if (!sg.picks || sg.picksFor !== `${sg.gameId}:${t.unit}`) {
      sg.picks = new Set(cands.slice(0, 8).map((p) => p.name));
      sg.picksFor = `${sg.gameId}:${t.unit}`;
    }
    const sel = el(
      "select",
      { class: "ofr-input ofr-input-sm", k: "sg:game", "aria-label": "Game to pick participants from" },
      loaded.map((r) => el("option", { value: r.gameId, text: `${r.gameId}${r.map ? ` · ${r.map}` : ""} · ${r.players.filter((p) => p.active).length}` })),
    );
    sel.value = sg.gameId;
    sel.addEventListener("change", () => {
      sg.gameId = sel.value;
      sg.picks = null;
      render();
    });
    const room = T.LIMITS.participants - t.participants.length;
    const picked = cands.filter((p) => sg.picks.has(p.name)).slice(0, room);
    const box = el(
      "div",
      { style: "margin-top:14px" },
      el("h3", { class: "ofr-eyebrow" }, "From a game", el("small", { text: t.unit === "team" ? "teams and clan tags" : "players, in finishing order" })),
      el("div", { class: "tn-row" }, sel, btn(`Add ${picked.length}`, () => addPicked(picked), { cls: "ofr-btn-sm ofr-btn-primary", ico: "plus", k: "sg:add", disabled: !picked.length })),
    );
    const chips = el("div", { class: "tn-cands", role: "group", "aria-label": "Suggested participants" });
    const showAll = state.showAll.has("sg");
    cands.slice(0, showAll ? 64 : 24).forEach((p, i) => {
      const on = sg.picks.has(p.name);
      chips.append(
        el(
          "button",
          {
            type: "button",
            class: `ofr-chip tn-c${p.color}`,
            k: `sg:${i}`,
            "aria-pressed": String(on),
            title: [p.tags.length ? `tag ${p.tags.join(" ")}` : null, p.members.length ? p.members.join(", ") : null].filter(Boolean).join("\n") || p.name,
            onclick: () => {
              if (on) sg.picks.delete(p.name);
              else sg.picks.add(p.name);
              render();
            },
          },
          dot(p.color),
          p.name,
          p.members.length ? ` ·${p.members.length}` : "",
        ),
      );
    });
    if (!showAll && cands.length > 24) chips.append(btn(`+${Math.min(64, cands.length) - 24}`, () => (state.showAll.add("sg"), render()), { cls: "ofr-btn-sm ofr-btn-ghost", k: "sg:all", title: "Show more players" }));
    if (!cands.length) chips.append(el("span", { class: "tn-dim", text: "Everyone from this game is already in." }));
    box.append(chips);
    return box;
  }
  function addPicked(picked) {
    mutate((t) => {
      for (const p of picked) {
        if (t.participants.length >= T.LIMITS.participants) break;
        t.participants.push(T.newParticipant(t, p));
      }
    });
    state.suggest.picks = null;
    render();
  }
  function deleteTournament() {
    if (Date.now() - state.deleteArm > 4000) {
      const armedAt = Date.now();
      state.deleteArm = armedAt;
      render();
      // the "Press again" label goes back once its window has passed
      setTimeout(() => {
        if (state.deleteArm !== armedAt) return;
        state.deleteArm = 0;
        render();
      }, 4050);
      return;
    }
    state.deleteArm = 0;
    const id = state.cur.id;
    if (state.transient) {
      state.transient = false;
      clearHash();
    } else {
      state.list = state.list.filter((t) => t.id !== id);
      removeStored(id);
    }
    state.cur = state.list[0] ?? null;
    state.tab = null;
    render();
    announce("Tournament deleted");
  }

  // ---- share ----------------------------------------------------------------------------------------------------------
  function panelShare(c) {
    const t = state.cur;
    const wrap = el("div", { class: "tn-share" });
    let canvas = null;
    try {
      canvas = drawResults(t, c);
      canvas.className = "tn-preview";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Results image of ${t.name}`);
    } catch {
      canvas = stateBox("error", "The image could not be drawn", "");
    }
    wrap.append(el("section", { class: "ofr-card tn-card", "aria-label": "Results image" }, el("h3", { class: "ofr-eyebrow", text: "Results image" }), canvas));
    const slug = t.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "tournament";
    const meter = el("div", { class: "tn-meter", id: "tn-share-meter", "aria-hidden": "true" }, el("i", { style: "width:0" }));
    const linkNote = el("p", { class: "tn-dim", id: "tn-share-note", style: "margin:0;font-size:11px" });
    wrap.append(
      el(
        "section",
        { class: "ofr-card tn-card tn-actions", "aria-label": "Share" },
        el("h3", { class: "ofr-eyebrow", text: "Share" }),
        btn("Save PNG", async (e) => {
          const b = e.currentTarget;
          const blob = await toBlob(drawResults(t, compute()));
          download(blob, `${slug}.png`);
          flash(b, "Saved");
        }, { ico: "download", k: "sh:png", cls: "ofr-btn-primary", title: "2x PNG for Discord" }),
        btn("Copy image", async (e) => {
          const b = e.currentTarget;
          try {
            const blob = await toBlob(drawResults(t, compute()));
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            flash(b, "Copied");
          } catch {
            flash(b, "Not allowed here - use Save PNG", false);
          }
        }, { ico: "copy", k: "sh:img" }),
        btn("Copy results text", async (e) => {
          const b = e.currentTarget;
          const ok = await copyText(T.resultsText(t, compute()));
          flash(b, ok ? "Copied" : "Copy failed", ok);
        }, { ico: "text", k: "sh:text" }),
        el("hr", { style: "width:100%;border:0;border-top:1px solid var(--ofr-panel-border);margin:4px 0" }),
        // The code, not a link: this page is not web-accessible (a link clicked on
        // a web page is blocked), and under the launcher its address carries the
        // launcher's secret token. The code is pasted under Import.
        btn("Copy share code", copyCode, { ico: "link", k: "sh:code", id: "tn-share-code", title: "The whole tournament travels in the code: no server. The other organiser pastes it under Import; records are fetched again from OpenFront." }),
        IN_EXTENSION
          ? btn("Copy extension link", copyLink, { ico: "link", cls: "ofr-btn-ghost ofr-btn-sm", k: "sh:link", id: "tn-share-link", title: "Opens only when pasted into the address bar of a Chrome with OpenFront Pro installed from the same place (same extension id). Clicked on a web page, Chrome blocks it." })
          : null,
        meter,
        linkNote,
        btn("Export .json", () => {
          const blob = new Blob([JSON.stringify(T.exportObject(t), null, 1)], { type: "application/json" });
          download(blob, `${slug}.tournament.json`);
        }, { ico: "file", k: "sh:json", title: "A file you can import here or send to a co-organiser" }),
      ),
    );
    return wrap;
  }
  async function updateShareInfo() {
    const t = state.cur;
    const key = `${t.id}:${t.updated}`;
    if (state.share?.key !== key) {
      let info;
      try {
        info = await T.encodeShare(t);
      } catch {
        info = { ok: false, reason: "error", length: 0, max: T.LIMITS.shareChars };
      }
      state.share = { key, info };
    }
    const { info } = state.share;
    const meter = $("tn-share-meter");
    const note = $("tn-share-note");
    const button = $("tn-share-code");
    if (!meter || !note || !button) return;
    meter.dataset.over = String(!info.ok);
    meter.firstChild.style.width = `${Math.min(100, (100 * info.length) / info.max)}%`;
    note.textContent = info.ok
      ? `Paste it under Import. ${info.length} / ${info.max} characters${info.length > 1900 ? " · too long for one Discord message: send the .json file" : ""}`
      : "Too big for a code - export the .json file instead.";
    button.disabled = !info.ok;
    const link = $("tn-share-link");
    if (link) link.disabled = !info.ok;
  }
  async function copyCode(e) {
    const b = e.currentTarget;
    await updateShareInfo();
    const info = state.share?.info;
    if (!info?.ok) return;
    const ok = await copyText(info.hash); // "#t=..." only: never this page's address
    flash(b, ok ? "Copied - paste it under Import" : "Copy failed", ok);
  }
  async function copyLink(e) {
    const b = e.currentTarget;
    if (!IN_EXTENSION) return; // the launcher's address holds its secret token
    await updateShareInfo();
    const info = state.share?.info;
    if (!info?.ok) return;
    const ok = await copyText(chrome.runtime.getURL("src/tournament.html") + info.hash);
    flash(b, ok ? "Copied - paste it in the address bar" : "Copy failed", ok);
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = el("textarea", { value: text, style: "position:fixed;left:-9999px" });
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }
  const toBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png"));
  function download(blob, name) {
    const a = el("a", { href: URL.createObjectURL(blob), download: name, style: "display:none" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---- results image (canvas, 2x) ----------------------------------------------------------------------------------------
  function colours() {
    const probe = el("span", { style: "position:absolute;display:none" });
    document.body.append(probe);
    const test = document.createElement("canvas").getContext("2d");
    const read = (name, fallback) => {
      probe.style.color = `var(${name})`;
      const v = getComputedStyle(probe).color;
      test.fillStyle = "#010203";
      test.fillStyle = v;
      return v && test.fillStyle !== "#010203" ? v : fallback;
    };
    const col = {
      bg: read("--ofr-stage-bg", "#0b0d12"),
      soft: read("--ofr-panel-soft", "rgba(0,0,0,0.3)"),
      line: read("--ofr-panel-border", "rgba(255,255,255,0.12)"),
      track: read("--ofr-track", "rgba(255,255,255,0.13)"),
      text: read("--ofr-text", "#e5e7eb"),
      dim: read("--ofr-text-dim", "#9ca3af"),
      accent: read("--ofr-accent", "#fcd34d"),
      accentInk: read("--ofr-accent-ink", "#fcd34d"),
      onAccent: read("--ofr-on-accent", "#1a1300"),
      good: read("--ofr-good", "#a3e635"),
      elite: read("--ofr-elite", "#fb7185"),
    };
    // participant colour slots, as tournament.css paints them (.tn-c0 ... .tn-c12)
    col.palette = Array.from({ length: T.COLORS }, (_, i) => {
      probe.className = `tn-c${i}`;
      return read("--tn-c", col.accent);
    });
    probe.remove();
    col.font = getComputedStyle(document.documentElement).getPropertyValue("--ofr-ui-font").trim() || "system-ui, sans-serif";
    return col;
  }
  // Text that fits: the font shrinks first (to 70%), then the text wraps at
  // spaces (when lines > 1), and only then is the end replaced by an ellipsis -
  // never a silent cut.
  function textKit(ctx, font) {
    const set = (w, s) => (ctx.font = `${w} ${s}px ${font}`);
    const width = (s) => ctx.measureText(s).width;
    const ellipsize = (s, max) => {
      if (width(s) <= max) return s;
      const chars = Array.from(s);
      while (chars.length > 1 && width(`${chars.join("")}…`) > max) chars.pop();
      return `${chars.join("").trimEnd()}…`;
    };
    function fit(text, max, w, px) {
      let s = px;
      set(w, s);
      while (width(text) > max && s > Math.ceil(px * 0.7)) set(w, --s);
      return { text: ellipsize(String(text), max), size: s };
    }
    function block(text, max, w, px, lines) {
      const one = fit(text, max, w, px);
      if (lines <= 1 || !one.text.endsWith("…") || one.text === String(text)) return { lines: [one.text], size: one.size };
      const s = one.size;
      set(w, s);
      const words = String(text).split(/\s+/).filter(Boolean);
      const out = [];
      let line = "";
      while (words.length && out.length < lines - 1) {
        const next = line ? `${line} ${words[0]}` : words[0];
        if (width(next) <= max) {
          line = next;
          words.shift();
        } else if (!line) {
          out.push(ellipsize(words.shift(), max)); // one word wider than the line
        } else {
          out.push(line);
          line = "";
        }
      }
      const rest = [line, ...words].filter(Boolean).join(" ");
      if (rest) out.push(ellipsize(rest, max));
      return { lines: out, size: s };
    }
    return { set, width, fit, block };
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawResults(t, c) {
    const W = 1200;
    const PX = 2;
    const col = colours();
    const trophy = THEMES[document.documentElement.dataset.ofrTheme ?? "classic"]?.icons?.trophy ?? "🏆";
    const measure = textKit(document.createElement("canvas").getContext("2d"), col.font);
    const title = measure.block(t.name, 900, 800, 54, 2);
    const titleH = title.lines.length * Math.round(title.size * 1.14);
    const headH = 104 + titleH + 28;
    const pcol = (pid) => col.palette[byId(pid)?.color ?? 5];
    const rows = c.st.rows.slice(0, 16);
    let bodyH = 0;
    let bview = null;
    if (t.format === "bracket" && c.br?.rounds.length) {
      const start = Math.max(0, c.br.rounds.length - 4);
      bview = { start, rounds: c.br.rounds.slice(start) };
      // at least the champion box (160) with room above the footer (2 players = 1 match)
      bodyH = Math.max(40 + bview.rounds[0].length * 86, 40 + 160 + 44);
    } else if (t.format === "series" && c.se?.a) bodyH = 330;
    else bodyH = 44 + Math.max(1, rows.length) * 52 + (c.st.rows.length > rows.length ? 34 : 0);
    const H = Math.ceil(headH + bodyH + 84);
    const canvas = document.createElement("canvas");
    canvas.width = W * PX;
    canvas.height = H * PX;
    const ctx = canvas.getContext("2d");
    ctx.scale(PX, PX);
    const tx = textKit(ctx, col.font);
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, W, H);
    const wash = ctx.createLinearGradient(0, 0, W, H);
    ctx.globalAlpha = 0.07;
    wash.addColorStop(0, col.text);
    wash.addColorStop(1, col.bg);
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.fillStyle = col.accent;
    ctx.fillRect(0, 0, 10, H);

    // header
    const played = c.st.games.filter((g) => g.state === "ok").length;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = col.dim;
    ctx.textAlign = "left";
    const eyebrow = tx.fit(`OPENFRONT · TOURNAMENT · ${FORMAT[t.format].label.toUpperCase()}${t.format === "league" ? "" : ` · BEST OF ${t.bestOf}`}`, 700, 600, 20);
    ctx.fillText(eyebrow.text, 60, 70);
    ctx.textAlign = "right";
    tx.set(600, 20);
    ctx.fillText(`${played} game${played === 1 ? "" : "s"} · ${t.participants.length} ${t.unit === "team" ? "teams" : "players"}`, W - 60, 70);
    ctx.textAlign = "left";
    ctx.fillStyle = col.text;
    tx.set(800, title.size);
    title.lines.forEach((line, i) => ctx.fillText(line, 60, 104 + Math.round(title.size * 0.9) + i * Math.round(title.size * 1.14)));
    const y0 = headH;

    if (bview) drawBracket(ctx, tx, col, c.br, bview, y0, bodyH, W, pcol, trophy);
    else if (t.format === "series" && c.se?.a) drawSeries(ctx, tx, col, c.se, y0, W, pcol, trophy);
    else drawTable(ctx, tx, col, c, rows, y0, W, pcol, trophy);

    // footer
    tx.set(700, 22);
    ctx.fillStyle = col.accentInk;
    ctx.fillText("OpenFront Pro", 60, H - 36);
    const bw = tx.width("OpenFront Pro");
    tx.set(500, 18);
    ctx.fillStyle = col.dim;
    ctx.fillText("unofficial · from OpenFront's public game records", 60 + bw + 16, H - 36);
    ctx.textAlign = "right";
    ctx.fillText(new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }), W - 60, H - 36);
    ctx.textAlign = "left";
    return canvas;
  }
  function drawTable(ctx, tx, col, c, rows, y0, W, pcol, trophy) {
    const games = c.st.games;
    const lastN = 8;
    const from = Math.max(0, games.length - lastN);
    tx.set(700, 15);
    ctx.fillStyle = col.dim;
    ctx.fillText("#", 70, y0 + 20);
    ctx.fillText("POINTS", 470, y0 + 20);
    ctx.fillText("WINS", 860, y0 + 20);
    ctx.fillText(games.length > lastN ? `LAST ${lastN} GAMES` : "GAMES", 944, y0 + 20);
    const maxPts = Math.max(1, ...rows.map((r) => Math.abs(r.points)));
    if (!rows.length) {
      tx.set(500, 22);
      ctx.fillText("No participants yet", 60, y0 + 70);
      return;
    }
    rows.forEach((r, i) => {
      const y = y0 + 44 + i * 52;
      if (i % 2 === 0) {
        ctx.fillStyle = col.soft;
        roundRect(ctx, 50, y, W - 100, 46, 10);
        ctx.fill();
      }
      const mid = y + 23;
      ctx.textBaseline = "middle";
      tx.set(800, 24);
      ctx.fillStyle = r.rank <= 3 && r.played ? col.accentInk : col.dim;
      ctx.textAlign = "center";
      ctx.fillText(String(r.rank), 78, mid + 1);
      ctx.textAlign = "left";
      ctx.fillStyle = pcol(r.pid);
      ctx.beginPath();
      ctx.arc(122, mid, 8, 0, Math.PI * 2);
      ctx.fill();
      const nm = tx.fit(r.name, 300, 600, 24);
      ctx.fillStyle = col.text;
      ctx.fillText(nm.text, 140, mid + 1);
      // points bar
      ctx.fillStyle = col.track;
      roundRect(ctx, 470, mid - 7, 270, 14, 7);
      ctx.fill();
      const w = Math.max(0, (270 * r.points) / maxPts);
      if (w > 0) {
        ctx.fillStyle = pcol(r.pid);
        roundRect(ctx, 470, mid - 7, Math.max(14, w), 14, 7);
        ctx.fill();
      }
      tx.set(800, 24);
      ctx.fillStyle = col.text;
      ctx.textAlign = "right";
      ctx.fillText(String(r.points), 840, mid + 1);
      ctx.textAlign = "left";
      tx.set(700, 22);
      ctx.fillStyle = r.wins ? col.text : col.dim;
      if (!r.wins) ctx.globalAlpha = 0.4;
      ctx.fillText(`${trophy} ${r.wins}`, 860, mid + 1);
      ctx.globalAlpha = 1;
      // pips, last games
      r.places.slice(from).forEach((slot, j) => {
        const x = 944 + j * 25;
        if (!slot) {
          ctx.strokeStyle = col.line;
          ctx.lineWidth = 1.5;
          roundRect(ctx, x, mid - 10, 21, 20, 4);
          ctx.stroke();
          return;
        }
        ctx.fillStyle = slot.won ? col.accent : slot.place <= 3 && !slot.dns ? col.good : col.track;
        roundRect(ctx, x, mid - 10, 21, 20, 4);
        ctx.fill();
        tx.set(700, 12);
        ctx.fillStyle = slot.won || (slot.place <= 3 && !slot.dns) ? col.onAccent : col.text;
        ctx.textAlign = "center";
        ctx.fillText(slot.dns ? "×" : String(slot.place), x + 10.5, mid + 1);
        ctx.textAlign = "left";
      });
      ctx.textBaseline = "alphabetic";
    });
    if (c.st.rows.length > rows.length) {
      tx.set(600, 18);
      ctx.fillStyle = col.dim;
      ctx.fillText(`+${c.st.rows.length - rows.length} more`, 140, y0 + 44 + rows.length * 52 + 22);
    }
  }
  function drawBracket(ctx, tx, col, br, view, y0, bodyH, W, pcol, trophy) {
    const k = view.rounds.length;
    const champW = 200;
    const gap = 40;
    const colW = Math.min(300, (W - 120 - champW - gap * k) / k);
    const top = y0 + 40;
    const areaH = bodyH - 40;
    const boxH = 64;
    const xOf = (j) => 60 + j * (colW + gap);
    const cyOf = (j, i) => top + ((i + 0.5) * areaH) / view.rounds[j].length;
    const total = br.rounds.length;
    view.rounds.forEach((matches, j) => {
      const r = view.start + j;
      tx.set(700, 15);
      ctx.fillStyle = col.dim;
      ctx.fillText(roundName(r, total).toUpperCase(), xOf(j), y0 + 20);
      matches.forEach((m, i) => {
        const x = xOf(j);
        const cy = cyOf(j, i);
        // connector to the next round
        if (j < k - 1) {
          const nx = xOf(j + 1);
          const ny = cyOf(j + 1, Math.floor(i / 2));
          ctx.strokeStyle = col.line;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x + colW, cy);
          ctx.lineTo(x + colW + gap / 2, cy);
          ctx.lineTo(x + colW + gap / 2, ny);
          ctx.lineTo(nx, ny);
          ctx.stroke();
        } else {
          ctx.strokeStyle = col.line;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x + colW, cy);
          ctx.lineTo(W - 60 - champW, cy);
          ctx.stroke();
        }
        const y = cy - boxH / 2;
        ctx.fillStyle = col.bg;
        roundRect(ctx, x, y, colW, boxH, 8);
        ctx.fill();
        ctx.fillStyle = col.soft;
        ctx.fill();
        ctx.strokeStyle = col.line;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const sideRow = (pid, seed, wins, ry) => {
          const midY = ry + 16;
          ctx.textBaseline = "middle";
          if (pid === br.BYE || !pid) {
            tx.set(500, 16);
            ctx.fillStyle = col.dim;
            ctx.fillText(pid === br.BYE ? "bye" : "—", x + 34, midY);
            ctx.textBaseline = "alphabetic";
            return;
          }
          const won = m.winner === pid;
          if (won) {
            ctx.fillStyle = pcol(pid);
            ctx.fillRect(x + 1, ry + 3, 4, 26);
          }
          tx.set(600, 12);
          ctx.fillStyle = col.dim;
          ctx.textAlign = "right";
          ctx.fillText(seed ? String(seed) : "", x + 26, midY);
          ctx.textAlign = "left";
          const nm = tx.fit(nameOf(pid), colW - 80, won ? 800 : 600, 18);
          ctx.fillStyle = m.winner && !won ? col.dim : col.text;
          ctx.fillText(nm.text, x + 34, midY + 1);
          if (m.by !== "bye" && (m.games.length || m.by === "override")) {
            tx.set(800, 18);
            ctx.textAlign = "right";
            ctx.fillStyle = won ? col.accentInk : col.dim;
            ctx.fillText(m.by === "override" ? (won ? "✓" : "") : String(wins), x + colW - 12, midY + 1);
            ctx.textAlign = "left";
          }
          ctx.textBaseline = "alphabetic";
        };
        sideRow(m.a, m.seedA, m.winsA, y);
        ctx.strokeStyle = col.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 8, y + boxH / 2);
        ctx.lineTo(x + colW - 8, y + boxH / 2);
        ctx.stroke();
        sideRow(m.b, m.seedB, m.winsB, y + boxH / 2);
      });
    });
    // champion
    const cx = W - 60 - champW;
    const cy = top + areaH / 2;
    const champ = br.champion;
    ctx.fillStyle = col.soft;
    roundRect(ctx, cx, cy - 80, champW, 160, 14);
    ctx.fill();
    ctx.strokeStyle = champ ? col.accent : col.line;
    ctx.lineWidth = champ ? 3 : 1.5;
    ctx.stroke();
    ctx.textAlign = "center";
    tx.set(400, 44);
    ctx.fillStyle = col.accent;
    ctx.fillText(trophy, cx + champW / 2, cy - 20);
    tx.set(700, 14);
    ctx.fillStyle = col.dim;
    ctx.fillText("CHAMPION", cx + champW / 2, cy + 8);
    const nm = tx.fit(champ ? nameOf(champ) : "—", champW - 24, 800, 26);
    ctx.fillStyle = champ ? col.text : col.dim;
    ctx.fillText(nm.text, cx + champW / 2, cy + 46);
    ctx.textAlign = "left";
  }
  function drawSeries(ctx, tx, col, se, y0, W, pcol, trophy) {
    const mid = W / 2;
    const cy = y0 + 110;
    const side = (pid, x, wins) => {
      const won = se.winner === pid;
      ctx.fillStyle = pcol(pid);
      ctx.beginPath();
      ctx.arc(x, cy - 70, 12, 0, Math.PI * 2);
      ctx.fill();
      const b = tx.block(nameOf(pid), 330, 800, 44, 2);
      tx.set(800, b.size);
      ctx.fillStyle = won ? col.accentInk : col.text;
      ctx.textAlign = "center";
      b.lines.forEach((line, i) => ctx.fillText(line, x, cy - 10 + i * Math.round(b.size * 1.1) - ((b.lines.length - 1) * b.size) / 2));
      if (won) {
        tx.set(400, 34);
        ctx.fillText(trophy, x, cy + 70);
      }
      ctx.textAlign = "left";
      return wins;
    };
    side(se.a, 250, se.winsA);
    side(se.b, W - 250, se.winsB);
    tx.set(800, 140);
    ctx.fillStyle = col.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${se.winsA}–${se.winsB}`, mid, cy);
    ctx.textBaseline = "alphabetic";
    const counted = se.games.filter((g) => !g.extra);
    const r = 16;
    const step = 44;
    const startX = mid - ((se.bestOf - 1) * step) / 2;
    for (let i = 0; i < se.bestOf; i++) {
      const g = counted[i];
      const x = startX + i * step;
      ctx.beginPath();
      ctx.arc(x, y0 + 250, r, 0, Math.PI * 2);
      if (g?.winner) {
        ctx.fillStyle = pcol(g.winner);
        ctx.fill();
      } else {
        ctx.strokeStyle = g ? col.dim : col.track;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
    tx.set(600, 22);
    ctx.fillStyle = se.winner ? col.accentInk : col.dim;
    const line = se.winner ? `${nameOf(se.winner)} wins the series` : `Best of ${se.bestOf} · first to ${se.need}`;
    ctx.fillText(tx.fit(line, 900, 600, 22).text, mid, y0 + 310);
    ctx.textAlign = "left";
  }

  // ---- tournaments list, import, links ----------------------------------------------------------------------------------------
  function newTournament() {
    if (!T.hasRoom(stored())) {
      notice("error", "No room for another tournament", `This page keeps at most ${LIMIT}. Delete one first (Setup -> Delete tournament).`);
      return;
    }
    const t = T.blank(`Tournament ${state.list.length + 1}`);
    state.list.unshift(t);
    state.cur = t;
    state.transient = false;
    state.tab = "setup";
    clearHash();
    dirty.add(t.id);
    flush();
    render();
    document.querySelector('[data-k="name"]')?.focus();
    document.querySelector('[data-k="name"]')?.select();
  }
  function select(id) {
    const t = state.list.find((x) => x.id === id);
    if (!t) return;
    if (state.transient) {
      state.transient = false;
      clearHash();
    }
    state.cur = t;
    state.tab = null;
    state.open.clear();
    flush(); // remembers the open one (tournamentLast)
    render();
  }
  function adopt(t, how, notes = []) {
    // an import is always a new tournament next to the others
    if (!T.hasRoom(stored())) {
      importMessage(`At most ${LIMIT} tournaments - delete one first.`);
      return;
    }
    while (state.list.some((x) => x.id === t.id) || state.damaged.some((d) => d.id === t.id)) t.id = T.blank().id;
    state.list.unshift(t);
    state.cur = t;
    state.transient = false;
    state.tab = null;
    dirty.add(t.id);
    flush();
    toggleImport(false);
    render();
    announce(`${how}: ${t.name}`);
    if (notes.length) notice("empty", `${how} with a change`, notes.join(" · "));
  }
  function importMessage(text) {
    const m = $("tn-import-msg");
    m.hidden = !text;
    m.replaceChildren(el("span", {}, el("span", { class: "ofr-state-title", text: "Not imported" }), text ?? ""));
  }
  function toggleImport(on = $("tn-import-bar").hidden) {
    $("tn-import-bar").hidden = !on;
    $("tn-import").setAttribute("aria-expanded", String(on));
    importMessage(null);
    if (on) $("tn-file-btn").focus();
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > T.LIMITS.fileBytes) return importMessage("That file is too big for a tournament.");
    let text;
    try {
      text = await file.text();
    } catch {
      return importMessage("The file could not be read.");
    }
    const res = T.importText(text);
    if (!res.ok) return importMessage(`Not a valid tournament file (${res.error}).`);
    adopt(res.value, "Imported", res.notes);
  }
  async function openShared(hash, { fromLink = false } = {}) {
    const res = await T.decodeShare(hash);
    if (!res.ok) {
      if (fromLink) return importMessage(`That link could not be opened (${res.error}).`);
      const bar = $("tn-shared");
      bar.hidden = false;
      bar.replaceChildren(stateBox("error", "This tournament link could not be opened", res.error));
      return;
    }
    if (fromLink) return adopt(res.value, "Opened", res.notes);
    // from this page's own address: shown, not saved until you keep it (or edit it)
    state.cur = res.value;
    state.transient = true;
    state.tab = null;
    state.rev++;
    const bar = $("tn-shared");
    bar.hidden = false;
    bar.replaceChildren(
      stateBox("ok", "Shared tournament", `Shown from the link. Keep a copy to edit it.${res.notes?.length ? ` (${res.notes.join(" · ")})` : ""}`, [
        btn("Keep a copy", () => {
          save(); // refuses visibly when there is no room
          if (!state.transient) flush();
          render();
        }, { cls: "ofr-btn-primary ofr-btn-sm", k: "keep" }),
        btn("Close", () => {
          state.transient = false;
          state.cur = state.list[0] ?? null;
          clearHash();
          render();
        }, { cls: "ofr-btn-ghost ofr-btn-sm", k: "keep-close" }),
      ]),
    );
    render();
  }

  // The single "tournaments" list of earlier builds -> one key each. The old key
  // goes only after every tournament (damaged ones too, unchanged) has its own.
  async function migrate(plan) {
    if (!plan.removeOld) return;
    try {
      for (const w of plan.migrate) await chrome.storage.local.set({ [T.TKEY + w.id]: w.value });
      await chrome.storage.local.set({ [T.TINDEX]: plan.index });
      await chrome.storage.local.remove(T.OLD_KEY);
    } catch (err) {
      setSaveError(err); // the old list stays; the move is tried again next time
    }
  }

  // ---- theme, consent, start ----------------------------------------------------------------------------------------------------
  function applyTheme(id) {
    if (THEMES[id] && id !== "classic") document.documentElement.dataset.ofrTheme = id;
    else delete document.documentElement.dataset.ofrTheme;
  }
  async function start() {
    $("tn-new").addEventListener("click", newTournament);
    $("tn-import").addEventListener("click", () => toggleImport());
    $("tn-file-btn").addEventListener("click", () => $("tn-file").click());
    $("tn-file").addEventListener("change", (e) => {
      importFile(e.target.files?.[0]);
      e.target.value = "";
    });
    const openLink = () => {
      // a share code ("#t=...", or "t=..." without the #) or any link ending in one
      const m = /(?:^|#)t=([zj][A-Za-z0-9_-]+)\s*$/.exec($("tn-link").value.trim());
      if (!m) return importMessage("Paste a share code: it starts with #t=");
      openShared(`#t=${m[1]}`, { fromLink: true });
    };
    $("tn-link-open").addEventListener("click", openLink);
    $("tn-link").addEventListener("keydown", (e) => e.key === "Enter" && openLink());
    $("tn-pick").addEventListener("change", (e) => select(e.target.value));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("tn-import-bar").hidden) toggleImport(false);
    });

    let sync = { dataConsent: false, theme: "classic" };
    let local = {};
    try {
      // everything: tournament keys are found by prefix, so one missing from the
      // index (two tabs adding at once) is still listed
      [sync, local] = await Promise.all([chrome.storage.sync.get({ dataConsent: false, theme: "classic" }), chrome.storage.local.get(null)]);
    } catch {
      // storage unavailable: an empty page still works for a session
    }
    applyTheme(sync.theme);
    state.consent = sync.dataConsent === true;
    const plan = T.planLoad(local ?? {});
    state.list = plan.list; // never cut to the limit, never dropped: over it, new ones are refused
    state.damaged = plan.damaged;
    state.cur = state.list.find((t) => t.id === local?.tournamentLast) ?? state.list[0] ?? null;
    await migrate(plan);
    // older builds' position-based results that could not be kept: say so, save the rest
    if (plan.notes.length) {
      notice("empty", "Some hand-set results could not be kept", plan.notes.join(" · "));
      for (const t of state.list) dirty.add(t.id);
      flush();
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") return onLocalChange(changes);
      if (area !== "sync") return;
      if (changes.theme) {
        applyTheme(changes.theme.newValue);
        render();
      }
      if (changes.dataConsent) {
        state.consent = changes.dataConsent.newValue === true;
        for (const [id, s] of state.status) if (s.state === "consent") state.status.delete(id);
        render();
      }
    });
    // a link pasted into this already-open page only changes the fragment
    window.addEventListener("hashchange", () => {
      if (location.hash.startsWith("#t=")) openShared(location.hash);
    });
    if (location.hash.startsWith("#t=")) await openShared(location.hash);
    else render();
  }
  start();
})();
