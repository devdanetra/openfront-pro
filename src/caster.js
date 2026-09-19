// Observer mode: the caster panel on openfront.io while you WATCH a game (you
// opened a running game's link and sit in a spectator's seat, or a replay). Docked
// on the right edge, foldable to a tab, drawn from OFR_OBSERVER.casterView():
// the leaderboard with land bars and rank badges, team totals in team games, who
// was eliminated when, the clock and the players still in it. Graphics first.
//
// Content script (isolated world), loaded before content.js, which feeds it. It
// only adds its own nodes; every name comes from the game and goes in through
// textContent / title. Player colours are the game's own (data, not theme).
// Exposed on globalThis.OFR_CASTER.
(() => {
  if (globalThis.OFR_CASTER) return;
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function icon(paths, cls) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    if (cls) s.setAttribute("class", cls);
    for (const d of paths) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      s.append(p);
    }
    return s;
  }
  const ICONS = {
    humans: ["M12 3.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8z", "M4 21c0-4.2 3.6-7.2 8-7.2s8 3 8 7.2z"],
    flag: ["M5 2h2v20H5z", "M8 3h11l-2.5 4L19 11H8z"],
    skull: ["M12 2.5c-4.7 0-8 3.2-8 7.6 0 2.6 1.2 4.6 3 5.8V19a1 1 0 0 0 1 1h1.5v-2h1.5v2h2v-2h1.5v2H16a1 1 0 0 0 1-1v-3.1c1.8-1.2 3-3.2 3-5.8 0-4.4-3.3-7.6-8-7.6zm-3.2 7a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8zm6.4 0a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8z"],
  };

  const clock = (secs) => {
    const s = Math.max(0, Math.floor(Number(secs) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };
  const pct = (share) => {
    const v = 100 * (Number(share) || 0);
    if (v > 0 && v < 0.1) return "<0.1%";
    return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
  };
  // A player's (or team's) colour from the game: a swatch, set as data.
  function swatch(rgb) {
    const s = el("span", "ofr-caster-sw");
    if (Array.isArray(rgb)) s.style.setProperty("--ofr-sw", `rgb(${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c)))).join(" ")})`);
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  const PHASE = { watching: "Live", spawn: "Spawning", ended: "Game over" };
  const MODE_SHORT = { "Free For All": "FFA" };

  // onToggle(open): the user folded / opened it (remembered by content.js).
  // badge(row): { text, band, title } for a known world rank, or null.
  function createPanel({ startOpen = true, onToggle = null, badge = null } = {}) {
    const root = el("aside", "ofr-caster");
    root.setAttribute("aria-label", "Caster panel (OpenFront Pro)");
    const tab = el("button", "ofr-caster-tab");
    tab.type = "button";
    tab.title = "Caster panel: leaderboard, teams, eliminations";
    tab.setAttribute("aria-label", "Open the caster panel");
    const tabIcon = icon(ICONS.flag, "ofr-caster-tab-ico");
    const tabText = el("span", null, "Caster");
    tab.append(tabIcon, tabText);

    const panel = el("section", "ofr-caster-panel ofr-float");
    const head = el("div", "ofr-caster-head");
    const state = el("span", "ofr-caster-state", "Live");
    const clk = el("span", "ofr-caster-clock", "0:00");
    clk.title = "Game clock";
    const humans = el("span", "ofr-caster-count");
    humans.append(icon(ICONS.humans));
    const humansText = el("span");
    humans.append(humansText);
    const fold = el("button", "ofr-btn ofr-btn-icon ofr-btn-sm ofr-caster-fold", "−");
    fold.type = "button";
    fold.title = "Fold the caster panel";
    fold.setAttribute("aria-label", "Fold the caster panel");
    head.append(state, clk, humans, fold);
    const where = el("div", "ofr-caster-where");
    const teams = el("div", "ofr-caster-teams");
    const board = el("ol", "ofr-caster-board");
    board.setAttribute("aria-label", "Leaderboard by land");
    const more = el("div", "ofr-caster-more");
    const feedHead = el("h4", "ofr-eyebrow ofr-caster-feedhead");
    feedHead.append(icon(ICONS.skull), document.createTextNode("Eliminated"));
    const feed = el("ol", "ofr-caster-feed");
    feed.setAttribute("aria-label", "Eliminations, newest first");
    const foot = el("p", "ofr-caster-foot");
    panel.append(head, where, teams, board, more, feedHead, feed, foot);
    root.append(tab, panel);

    const setOpen = (open, byUser = false) => {
      root.dataset.open = open ? "true" : "false";
      tab.setAttribute("aria-expanded", String(open));
      if (byUser) {
        try {
          onToggle?.(open);
        } catch {
          // extension reloaded under us: folding still works
        }
      }
    };
    tab.addEventListener("click", () => setOpen(true, true));
    fold.addEventListener("click", () => setOpen(false, true));
    setOpen(startOpen);

    let lastSig = "";
    // view: OFR_OBSERVER.casterView(...); masked: player names left out.
    function update(view, { masked = false } = {}) {
      if (!view) return;
      root.dataset.phase = view.phase;
      state.textContent = PHASE[view.phase] ?? "Live";
      clk.textContent = clock(view.seconds);
      humansText.textContent = `${view.humansAlive}/${view.humansTotal}`;
      humans.title = `${view.humansAlive} of ${view.humansTotal} humans still in · ${view.playersAlive} players with land`;
      tabText.textContent = `Caster · ${clock(view.seconds)}`;
      // the lists are rebuilt only when what they show changes (not for the clock)
      const sig = JSON.stringify([view.board, view.teams, view.feed, view.more, view.map, view.mode, masked]);
      if (sig === lastSig) return;
      lastSig = sig;
      where.textContent = [view.map, MODE_SHORT[view.mode] ?? view.mode, view.replay ? "replay" : null].filter(Boolean).join(" · ");

      // team games: one bar split by land, then a row per team
      teams.replaceChildren();
      teams.hidden = !view.teamGame;
      if (view.teamGame) {
        const bar = el("div", "ofr-caster-split");
        bar.setAttribute("role", "img");
        bar.setAttribute("aria-label", view.teams.map((t) => `${t.name} ${pct(t.share)}`).join(", "));
        for (const t of view.teams) {
          if (!(t.share > 0)) continue;
          const seg = swatch(t.rgb);
          seg.classList.add("ofr-caster-seg");
          seg.style.flexGrow = String(t.share);
          seg.title = `${t.name}: ${pct(t.share)} of the land`;
          bar.append(seg);
        }
        teams.append(bar);
        for (const t of view.teams) {
          const row = el("div", "ofr-caster-team");
          row.dataset.out = String(t.alive === 0);
          const name = el("span", "ofr-caster-name", t.name);
          const pips = el("span", "ofr-caster-pips");
          pips.title = `${t.alive} of ${t.total} still in`;
          pips.setAttribute("aria-label", pips.title);
          for (let i = 0; i < Math.min(t.total, 8); i++) {
            const pip = el("span", "ofr-caster-pip");
            pip.dataset.on = String(i < t.alive);
            pips.append(pip);
          }
          if (t.total > 8) pips.append(el("small", null, `${t.alive}/${t.total}`));
          row.append(swatch(t.rgb), name, pips, el("span", "ofr-caster-pct", pct(t.share)));
          teams.append(row);
        }
      }

      board.replaceChildren();
      for (const r of view.board) {
        const li = el("li", "ofr-caster-row");
        li.dataset.alive = String(r.alive);
        const place = el("span", "ofr-caster-place", r.alive ? String(r.place) : "✕");
        const who = r.name ?? (r.team ? r.team : r.type === "NATION" ? "Nation" : "Player");
        const name = el("span", "ofr-caster-name", who);
        if (!r.name) name.dataset.masked = "true";
        name.title = [r.name ?? (masked ? "Name hidden (streamer mode)" : who), r.team ? `Team ${r.team}` : null, r.alive ? `${pct(r.share)} of the land` : r.outAt != null ? `Eliminated at ${clock(r.outAt)}` : "Eliminated"].filter(Boolean).join("\n");
        const cell = el("span", "ofr-caster-who");
        cell.append(name);
        const b = r.alive && badge ? badge(r) : null;
        if (b) {
          const tag = el("span", "ofr-badge ofr-caster-badge", b.text);
          tag.dataset.ofrKind = "percentile";
          if (b.band) tag.dataset.ofrBand = b.band;
          tag.title = b.title ?? b.text;
          cell.append(tag);
        }
        const bar = el("span", "ofr-caster-bar");
        const fill = el("span");
        fill.style.width = `${(Math.max(0, Math.min(1, r.frac)) * 100).toFixed(1)}%`;
        bar.append(fill);
        const right = el("span", "ofr-caster-pct", r.alive ? pct(r.share) : r.outAt != null ? clock(r.outAt) : "out");
        li.append(place, swatch(r.rgb), cell, bar, right);
        board.append(li);
      }
      more.textContent = view.more ? `+${view.more} more with land` : "";
      more.hidden = !view.more;

      feed.replaceChildren();
      for (const f of view.feed) {
        const li = el("li", "ofr-caster-out");
        const who = f.name ?? (f.team ? f.team : f.human ? "Player" : "Nation");
        const name = el("span", "ofr-caster-name", who);
        if (!f.name) name.dataset.masked = "true";
        name.title = who;
        li.append(el("span", "ofr-caster-time", clock(f.at)), swatch(f.rgb), name);
        feed.append(li);
      }
      if (!view.feed.length) feed.append(el("li", "ofr-caster-none", "Nobody yet"));
      foot.textContent = masked ? "Names hidden: streamer mode" : "Names as the game shows them";
    }

    function destroy() {
      root.remove();
    }
    return { el: root, update, setOpen, destroy };
  }

  globalThis.OFR_CASTER = { createPanel };
})();
