// The Pro dashboard: a full-page statistics view drawn over OpenFront's front
// page, opened from a "Pro" button the extension adds to the nav bar. It uses
// the same one-request-per-player ofstats payload as the badges, so opening it
// costs one lookup for you (cached after the first).
//
// Graphics first: every section leads with a picture (rings, strips, bars,
// tiles) and keeps the exact figures in hover titles and in a folded "Numbers"
// box, so the page reads at a glance without losing anything for power users.
//
(() => {
  if (globalThis.__ofrDashboardLoaded) return;
  globalThis.__ofrDashboardLoaded = true;

  const S = globalThis.OFR_SCORING;
  const C = globalThis.OFR_CHARTS; // charts.js, loaded just before this file
  const THEMES = globalThis.OFR_THEMES ?? {};
  const ROOT_CLASS = "ofr-dash";

  // ---- helpers ---------------------------------------------------------------

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const fmtBig = (n) => {
    if (n == null) return "—";
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  };

  // exact, for the "Numbers" boxes and hover titles
  const fmtExact = (n) => (n == null ? "—" : Number(n).toLocaleString());

  const fmtDuration = (secs) => {
    if (!secs) return "—";
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const ago = (iso) => {
    if (!iso) return "—";
    const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days < 1) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    if (days < 365) return `${Math.round(days / 30)} months ago`;
    return `${(days / 365).toFixed(1)} years ago`;
  };

  const when = (g) => (g.date ? new Date(g.date).toLocaleDateString() : "");

  // name: the ofstats name, "[TAG] name" for a player with a clan tag
  function profileUrl(name) {
    return `https://ofstats.io/player/${encodeURIComponent(name)}`;
  }

  // Every name the dashboard is given, shows and looks up is a player's ofstats
  // name: "[TAG] name" (one space) when they play with a clan tag, the bare name
  // when they do not (OFR_SCORING.statsName). The two are different records on
  // ofstats, so there is no falling back from one to the other. What someone
  // types is looked up as typed; only the tag's form is put right: one space
  // after it ("[LUX]TeNa" is not a name ofstats knows) and upper case, as
  // OpenFront itself writes tags (sanitizeClanTag).
  const TAGGED = /^\[([A-Za-z0-9]{1,5})\]\s*(.*)$/;
  function tidyName(raw) {
    const text = String(raw ?? "").trim();
    const m = text.match(TAGGED);
    return m && m[2].trim() ? S.statsName(m[2].trim(), m[1].toUpperCase()) : text;
  }
  const bareName = (name) => {
    const m = String(name ?? "").match(TAGGED);
    return m && m[2].trim() ? m[2].trim() : name;
  };
  const hasTag = (name) => bareName(name) !== name;
  // Said under a miss for an untagged name: the usual reason for "no history".
  const TAG_HINT = ' A player with a clan tag is found as "[TAG] name".';

  function gameUrl(id) {
    return `https://ofstats.io/game/${encodeURIComponent(id)}`;
  }

  // Free-for-all, team or 1v1, from ofstats' mode name.
  const modeKind = (g) => (/team/i.test(g.mode ?? "") ? "team" : /1v1|ranked/i.test(g.mode ?? "") ? "duel" : "ffa");
  const MODE_SHORT = { ffa: "FFA", team: "Team", duel: "1v1" };

  // How a game ended for the player. Eliminated or not comes from killedAt alone.
  const fate = (g) => (g.won ? "won" : g.killedAt != null ? "lost" : "");
  const FATE_WORD = { won: "Win", lost: "Out", "": "Lost" };
  const FATE_LONG = { won: "won", lost: "eliminated", "": "alive at the end, no win" };

  const pctOf = (wins, games) => (games > 0 ? (100 * wins) / games : null);
  const winRateOf = (info) => (Number.isFinite(info.winRate) ? info.winRate : pctOf(info.wins ?? 0, info.games ?? 0));
  // What an average player would win in the same (rated) lobbies.
  const expectedRateOf = (info) =>
    info.ratedGames > 0 && info.expectedWins != null ? (100 * info.expectedWins) / info.ratedGames : null;
  // The player's own win rate over those same rated games.
  const ratedRateOf = (info) =>
    info.ratedGames > 0 && Number.isFinite(info.ratedWins) ? (100 * info.ratedWins) / info.ratedGames : null;

  // Win rate against an average player, like with like: when there is an
  // expected rate, the shown rate is the one over the same rated games (so
  // "above average" is ratedWins > expectedWins, the same test as the world
  // rank). Without one, it is the rate over all games and there is no tick.
  // The all-games rate always stays in the hover text.
  function winFigures(info) {
    const all = winRateOf(info);
    const rated = ratedRateOf(info);
    const expected = rated != null ? expectedRateOf(info) : null;
    const vs = expected != null;
    const shown = vs ? rated : all;
    const has = Number.isFinite(shown);
    const allText = `${Number.isFinite(all) ? `${all.toFixed(1)}%` : "—"} (${fmtExact(info.wins)} of ${fmtExact(info.games)})`;
    return {
      shown: has ? shown : null,
      expected,
      above: vs && rated > expected,
      title: !has
        ? "No games yet"
        : vs
          ? `Win rate in rated games ${rated.toFixed(1)}% (${fmtExact(info.ratedWins)} of ${fmtExact(info.ratedGames)})\n` +
            `All games: ${allText}\nTick: an average player in the same lobbies, ${expected.toFixed(1)}%`
          : `Win rate ${allText}`,
      label: !has
        ? "No games yet"
        : vs
          ? `Win rate in rated games ${rated.toFixed(1)} percent; an average player in the same lobbies wins ${expected.toFixed(1)} percent`
          : `Win rate ${shown.toFixed(1)} percent`,
    };
  }

  // ---- rank gauge scale ----------------------------------------------------------
  // The gauge gives each rank band the same room: on a linear 0-100 scale the
  // whole elite band would be squeezed into the last twentieth, and "Top 2%" and
  // "Top 5%" would look the same. The band edges are read off
  // OFR_SCORING.percentBand, so the gauge and the badges never disagree.
  const BAND_EDGES = (() => {
    const edges = [100];
    let prev = S.percentBand(100);
    for (let p = 100; p >= 0; p -= 0.5) {
      const band = S.percentBand(p);
      if (band !== prev) {
        edges.push(p);
        prev = band;
      }
    }
    edges.push(0);
    return edges; // e.g. [100, 60, 35, 15, 5, 0]: low .. elite
  })();
  const GAUGE_SEGMENTS = BAND_EDGES.slice(0, -1).map((hi, i, all) => ({
    from: i / all.length,
    to: (i + 1) / all.length,
    band: S.percentBand((hi + BAND_EDGES[i + 1]) / 2),
    hi,
  }));

  // 0 (bottom of the world) .. 1 (the very top), piecewise linear per band.
  function gaugeFrac(pct) {
    if (!Number.isFinite(pct)) return 0;
    const n = BAND_EDGES.length - 1;
    for (let i = 0; i < n; i++) {
      const hi = BAND_EDGES[i];
      const lo = BAND_EDGES[i + 1];
      if (pct >= lo) return (i + (hi - Math.min(hi, pct)) / (hi - lo || 1)) / n;
    }
    return 1;
  }

  const topText = (pct) => `Top ${S.formatPercent(pct)}%`;

  // ---- data ------------------------------------------------------------------

  // username: an ofstats name, sent exactly as given (see tidyName)
  async function lookup(username) {
    const res = await chrome.runtime.sendMessage({
      type: "lookup",
      usernames: [username],
      full: true,
    });
    return res?.[username] ?? null;
  }

  // ---- widgets ---------------------------------------------------------------

  function section(title) {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, title));
    return sec;
  }

  // Exact figures for whoever wants them, folded away by default and only
  // built when first opened.
  function numbers(build) {
    const box = el("details", "ofr-dash-numbers");
    box.append(el("summary", null, "Numbers"));
    box.addEventListener("toggle", () => {
      if (box.open && box.childElementCount === 1) box.append(build());
    });
    return box;
  }

  // label / value pairs; null values are skipped
  function kv(pairs) {
    const list = el("dl", "ofr-dash-kv");
    for (const [k, v] of pairs) {
      if (v == null) continue;
      const row = el("div");
      row.append(el("dt", null, k), el("dd", null, String(v)));
      list.append(row);
    }
    return list;
  }

  function table(headers, rows, className = "ofr-dash-table") {
    const wrap = el("div", "ofr-dash-tablewrap");
    const t = el("table", className);
    const thead = el("thead");
    const hr = el("tr");
    for (const h of headers) hr.append(el("th", null, h));
    thead.append(hr);
    const tbody = el("tbody");
    for (const row of rows) {
      const tr = el("tr", row.cls ?? "");
      for (const cell of row.cells) {
        const td = el("td");
        if (cell instanceof Node) td.append(cell);
        else td.textContent = cell == null ? "—" : String(cell);
        tr.append(td);
      }
      tbody.append(tr);
    }
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }

  // One graphic with a word under it.
  function heroCard(graphic, word, extra) {
    const card = el("div", "ofr-hero-card");
    const art = el("div", "ofr-hero-art");
    art.append(graphic);
    card.append(art, el("div", "ofr-hero-label", word));
    if (extra) card.append(extra);
    return card;
  }

  function rankGauge(rank, { size = 124, thickness = 11 } = {}) {
    const band = rank ? S.percentBand(rank.pct) : null;
    return C.ring({
      frac: rank ? gaugeFrac(rank.pct) : 0,
      sweep: 270,
      size,
      thickness,
      band,
      segments: GAUGE_SEGMENTS,
      pre: rank ? "top" : null,
      value: rank ? `${S.formatPercent(rank.pct)}%` : "—",
      label: rank ? `World rank: top ${S.formatPercent(rank.pct)} percent (${band})` : "No world rank yet",
      title: rank
        ? `${topText(rank.pct)} of players worldwide\n${rank.ratio.toFixed(2)}x the wins an average player takes in the same lobbies`
        : "Not enough rated games for a world rank",
    });
  }

  function winRing(w, { size = 124, thickness = 11 } = {}) {
    return C.ring({
      frac: w.shown != null ? w.shown / 100 : 0,
      size,
      thickness,
      kind: w.above ? "good" : "average",
      marker: w.expected != null ? { frac: w.expected / 100, title: `An average player in the same lobbies: ${w.expected.toFixed(1)}%` } : null,
      value: w.shown != null ? `${Math.round(w.shown)}%` : "—",
      label: w.label,
      title: w.title,
    });
  }

  // Win/loss strip for the recent games, oldest to newest. Team games are
  // outlined (the win is shared), 1v1s are round.
  function resultsStrip(games, extraClass = "") {
    const strip = el("div", `ofr-dash-strip ${extraClass}`.trim());
    const wins = games.filter((g) => g.won).length;
    strip.setAttribute("role", "img");
    strip.setAttribute("aria-label", `${wins} wins in the last ${games.length} games, oldest first`);
    for (const g of [...games].reverse()) {
      const f = fate(g);
      const cell = el("span", `ofr-dash-strip-cell ${g.won ? "won" : "lost"}`);
      cell.dataset.mode = modeKind(g);
      cell.dataset.fate = f || "plain";
      cell.title = `${g.map ?? "?"} · ${g.mode ?? "?"}\n${FATE_LONG[f]}${g.date ? ` · ${when(g)}` : ""}`;
      strip.append(cell);
    }
    return strip;
  }

  function resultsLegend() {
    const legend = el("div", "ofr-dash-legend");
    const key = (fateKey, mode, text) => {
      const item = el("span", "ofr-dash-legend-item");
      const cell = el("span", "ofr-dash-strip-cell");
      cell.dataset.fate = fateKey;
      cell.dataset.mode = mode;
      item.append(cell, document.createTextNode(text));
      legend.append(item);
    };
    key("won", "ffa", "won");
    key("lost", "ffa", "eliminated");
    key("plain", "ffa", "survived");
    key("won", "team", "team game");
    key("won", "duel", "1v1");
    return legend;
  }

  function streakArt(streak, { max = 10, min = 5 } = {}) {
    const n = Math.max(0, streak ?? 0);
    const lit = Math.min(n, max);
    const wrap = el("div", "ofr-streak");
    wrap.append(el("span", "ofr-streak-num", String(n)));
    wrap.append(
      C.pips({
        lit,
        total: Math.max(min, lit),
        glyph: "flame",
        label: `${n} win${n === 1 ? "" : "s"} in a row`,
        title: n ? `${n} win${n === 1 ? "" : "s"} in a row` : "No current win streak",
      }),
    );
    return wrap;
  }

  function iconStat(iconName, value, word, title) {
    const item = el("div", "ofr-iconstat");
    item.title = title;
    const text = el("div", "ofr-iconstat-text");
    text.append(el("span", "ofr-iconstat-value", value), el("span", "ofr-iconstat-label", word));
    item.append(C.icon(iconName), text);
    return item;
  }

  // ---- sections --------------------------------------------------------------

  function headerSection(name, info) {
    const head = el("div", "ofr-dash-header");
    const title = el("div", "ofr-dash-title");
    const shownName = currentOpts.self && currentOpts.streamer ? "You" : name;
    title.append(el("span", "ofr-dash-name", shownName));
    const rank = S.ranked(info);
    if (rank) {
      const badge = el("span", "ofr-badge", topText(rank.pct));
      badge.dataset.ofrKind = "percentile";
      badge.dataset.ofrBand = S.percentBand(rank.pct);
      title.append(badge);
    }
    head.append(title);

    const meta = el("div", "ofr-dash-meta");
    meta.append(
      el("span", null, `First seen ${ago(info.firstSeen)}`),
      el("span", null, `Last game ${ago(info.lastSeen)}`),
    );
    // (the link's URL carries the name, and a browser shows it on hover)
    if (!(currentOpts.self && currentOpts.streamer)) {
      const link = el("a", "ofr-dash-link", "Open on ofstats.io ↗");
      link.href = profileUrl(name);
      link.target = "_blank";
      link.rel = "noopener";
      meta.append(link);
    }
    const cmp = el("input", "ofr-dash-compare-input");
    cmp.type = "search";
    cmp.placeholder = "Compare with… [TAG] name";
    cmp.title = "Another player's name, with their clan tag if they have one: [TAG] name";
    cmp.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !cmp.value.trim()) return;
      const other = tidyName(cmp.value);
      cmp.disabled = true;
      let b = null;
      try {
        b = await lookup(other);
      } catch {
        b = null;
      }
      cmp.disabled = false;
      const body = head.parentElement;
      body.querySelector(".ofr-dash-section.compare")?.remove();
      let sec;
      if (!b?.found) {
        sec = el("section", "ofr-dash-section compare");
        sec.append(el("h2", null, "Compare"));
        sec.append(el("p", "ofr-dash-empty", `No history for "${other}".${hasTag(other) ? "" : TAG_HINT}`));
      } else {
        sec = compareSection(name, info, other, b);
        sec.classList.add("compare");
      }
      head.insertAdjacentElement("afterend", sec);
    });
    meta.append(cmp);
    head.append(meta);
    return head;
  }

  // World rank, win rate against an average player, the last ten games and the
  // streak, then the career totals as a row of icons.
  function overviewSection(info) {
    const sec = section("Overview");
    const rank = S.ranked(info);
    const rate = winRateOf(info);
    const rated = ratedRateOf(info);
    const expected = expectedRateOf(info);
    const w = winFigures(info);
    const recent = (info.recentGames ?? []).slice(0, 10);

    const hero = el("div", "ofr-hero");
    hero.append(heroCard(rankGauge(rank), "world rank"));
    const key = w.expected != null ? el("div", "ofr-hero-key", "rated games · tick = average player") : null;
    hero.append(heroCard(winRing(w), "win rate", key));
    hero.append(
      heroCard(
        recent.length ? resultsStrip(recent, "big") : el("span", "ofr-hero-none", "no games yet"),
        "last 10",
      ),
    );
    hero.append(heroCard(streakArt(info.streak), "win streak"));
    sec.append(hero);

    const icons = el("div", "ofr-iconrow");
    icons.append(
      iconStat("swords", fmtBig(info.games), "games", `${fmtExact(info.games)} games`),
      iconStat("trophy", fmtBig(info.wins), "wins", `${fmtExact(info.wins)} wins`),
      iconStat("flag", fmtBig(info.conquests), "conquests", `${fmtExact(info.conquests)} conquests: players, nations and bots`),
      iconStat("nuke", fmtBig(info.nukes), "nukes", `${fmtExact(info.nukes)} nukes launched`),
      iconStat("coins", fmtBig(info.gold), "gold", `${fmtExact(info.gold)} gold earned`),
    );
    sec.append(icons);

    sec.append(
      numbers(() =>
        kv([
          ["World percentile", rank ? topText(rank.pct) : "not enough rated games"],
          ["Wins vs expected", rank ? `${rank.ratio.toFixed(2)}x` : null],
          ["Games", fmtExact(info.games)],
          ["Wins", fmtExact(info.wins)],
          ["Win rate", rate != null ? `${rate.toFixed(1)}%` : null],
          ["Rated games", info.ratedGames != null ? fmtExact(info.ratedGames) : null],
          ["Rated wins", info.ratedWins != null ? fmtExact(info.ratedWins) : null],
          ["Win rate in rated games", rated != null ? `${rated.toFixed(1)}%` : null],
          ["Expected wins (average player)", info.expectedWins != null ? info.expectedWins.toFixed(1) : null],
          ["Expected win rate", expected != null ? `${expected.toFixed(1)}%` : null],
          ["Current streak", `${info.streak ?? 0} wins in a row`],
          ["Conquests", fmtExact(info.conquests)],
          ["Nukes launched", fmtExact(info.nukes)],
          ["Gold earned", fmtExact(info.gold)],
        ]),
      ),
    );
    return sec;
  }

  function formSection(info) {
    const sec = section("Recent form");
    const games = info.recentGames ?? [];
    if (games.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "No recent games on record."));
      return sec;
    }
    sec.append(el("p", "ofr-dash-note", `Last ${games.length}, oldest first`));
    sec.append(resultsStrip(games));
    sec.append(resultsLegend());
    sec.append(
      numbers(() => {
        const wins = games.filter((g) => g.won).length;
        const last10 = games.slice(0, 10);
        const pairs = [
          [`Wins in the last ${games.length}`, `${wins} (${((100 * wins) / games.length).toFixed(0)}%)`],
          [`Wins in the last ${last10.length}`, String(last10.filter((g) => g.won).length)],
          ["Eliminated", String(games.filter((g) => fate(g) === "lost").length)],
        ];
        for (const k of ["ffa", "team", "duel"]) {
          const of = games.filter((g) => modeKind(g) === k);
          if (of.length) pairs.push([k === "ffa" ? "Free-for-all" : k === "duel" ? "1v1" : "Team", `${of.filter((g) => g.won).length}/${of.length} won`]);
        }
        return kv(pairs);
      }),
    );
    return sec;
  }

  // Graphs over the recent games (oldest on the left, like the strip above).
  //   - rolling win rate over a 10-game window, against what an average player
  //     would win in the same lobbies (1 / players, or 1 / teams);
  //   - how much of each game they were alive for;
  //   - gold earned per game.
  function trendsSection(info) {
    const sec = section("Trends");
    const games = [...(info.recentGames ?? [])].reverse();
    if (!C || games.length < 5) {
      sec.append(el("p", "ofr-dash-empty", "Not enough recent games to draw a trend."));
      return sec;
    }
    const grid = el("div", "ofr-dash-charts");
    const card = (title, note, chart) => {
      const box = el("div", "ofr-dash-chart");
      box.append(el("h3", null, title), chart);
      if (note) box.append(el("p", "ofr-dash-note", note));
      return box;
    };
    // How many sides could have won: players in a free-for-all, teams otherwise.
    // playerTeams is a number, or a team SIZE in words.
    const SIZES = { duos: 2, trios: 3, quads: 4 };
    const sidesOf = (g) => {
      if (!/team/i.test(g.mode ?? "") && g.teams == null) return g.players;
      const t = g.teams;
      if (typeof t === "number" || /^\d+$/.test(String(t))) return Number(t);
      const size = SIZES[String(t).toLowerCase()];
      if (size && g.players) return Math.ceil(g.players / size);
      if (/humans\s+vs\s+nations/i.test(String(t))) return 2;
      return null; // a team format we do not know: leave it out of the baseline
    };
    const chance = (g) => {
      const sides = sidesOf(g);
      return sides && sides > 1 ? 1 / sides : null;
    };
    const facts = [];

    // rolling win rate
    // Ten games, or fewer when there are not many: a window as long as the
    // history would leave a single point.
    const WINDOW = Math.min(10, Math.max(3, Math.floor(games.length / 2)));
    const points = [];
    for (let i = WINDOW - 1; i < games.length; i++) {
      const slice = games.slice(i - WINDOW + 1, i + 1);
      points.push({ x: i + 1, y: (100 * slice.filter((g) => g.won).length) / WINDOW });
    }
    const chances = games.map(chance).filter((c) => c != null);
    const expected = chances.length ? (100 * chances.reduce((a, b) => a + b, 0)) / chances.length : null;
    const top = C.niceMax(Math.max(...points.map((p) => p.y), expected ?? 0, 10));
    const nowRate = points.length ? points[points.length - 1].y : null;
    facts.push([`Win rate, last ${WINDOW} games`, nowRate != null ? `${Math.round(nowRate)}%` : null]);
    if (expected != null) facts.push(["Average player in these lobbies", `${expected.toFixed(1)}%`]);
    grid.append(
      card(
        "Win rate",
        expected != null ? "Dashed line: an average player" : null,
        C.line({
          series: [
            {
              points,
              cls: "accent",
              area: true,
              title: `Win rate over a rolling ${WINDOW} games${nowRate != null ? `: ${Math.round(nowRate)}% now` : ""}`,
            },
          ],
          width: 420,
          height: 150,
          xMin: 1,
          xMax: games.length,
          yMax: Math.min(100, top),
          xTicks: [1, games.length],
          xFormat: (x) => (x === 1 ? "oldest" : "latest"),
          yFormat: (y) => `${Math.round(y)}%`,
          baseline: expected != null ? { y: expected, title: `An average player in these lobbies: ${expected.toFixed(1)}%` } : null,
          label: `Rolling ${WINDOW}-game win rate over recent games${expected != null ? `, against ${expected.toFixed(1)} percent for an average player` : ""}`,
        }),
      ),
    );

    // survival per game
    // Eliminated or not comes from killedAt alone. Without the game's length the
    // share is unknown, and such a game is left out rather than drawn as "alive".
    const survival = games
      .filter((g) => g.killedAt == null || g.turns > 0)
      .map((g) => {
        const share = g.killedAt == null ? 1 : Math.min(0.99, g.killedAt / g.turns);
        return {
          value: 100 * share,
          dead: g.killedAt != null,
          cls: fate(g),
          title: `${g.map ?? "?"} - ${when(g)}\n${g.killedAt != null ? `eliminated ${Math.round(100 * share)}% of the way in` : g.won ? "won" : "alive at the end"}`,
        };
      });
    const died = survival.filter((s) => s.dead);
    facts.push(["Alive at the end", `${survival.length - died.length} of ${survival.length}`]);
    if (died.length) facts.push(["When eliminated, on average", `${Math.round(died.reduce((a, s) => a + s.value, 0) / died.length)}% of the way in`]);
    grid.append(
      card(
        "Survival",
        "Full bar: alive at the end",
        C.columns({ items: survival, width: 420, height: 150, yMax: 100, yFormat: (y) => `${y}%`, label: `Share of each game survived: alive at the end in ${survival.length - died.length} of ${survival.length}` }),
      ),
    );

    // gold per game
    const golds = games.filter((g) => g.gold != null);
    if (golds.length >= 5) {
      const best = golds.reduce((a, g) => (g.gold > a.gold ? g : a), golds[0]);
      facts.push(["Most gold in these games", `${fmtExact(best.gold)} on ${best.map ?? "?"}`]);
      grid.append(
        card(
          "Gold per game",
          null,
          C.columns({
            items: golds.map((g) => ({ value: g.gold, cls: fate(g), title: `${g.map ?? "?"} - ${when(g)}\n${fmtBig(g.gold)} gold${g.won ? ", won" : ""}` })),
            width: 420,
            height: 150,
            yFormat: (y) => fmtBig(y),
            label: `Gold earned per game; best ${fmtBig(best.gold)} on ${best.map ?? "?"}`,
          }),
        ),
      );
    }
    sec.append(grid);
    const legend = el("div", "ofr-chart-legend");
    for (const [kind, text] of [["won", "won"], ["lost", "eliminated"], ["plain", "alive at the end, no win"]]) {
      const key = el("span", "ofr-chart-key", text);
      key.dataset.col = kind;
      legend.append(key);
    }
    sec.append(legend);
    sec.append(numbers(() => kv(facts)));
    return sec;
  }

  // Best and weakest maps as bars, then every map as a heat tile. Ofstats
  // leaves out maps below its own floor; the few-game ones it does send are
  // drawn fainter rather than hidden.
  function mapsSection(info) {
    const sec = section("By map");
    const all = (info.maps ?? [])
      .filter((m) => m.games > 0 && m.expectedWins > 0)
      .map((m) => ({ ...m, rank: S.rowRank(m) }))
      .filter((m) => m.rank)
      .sort((a, b) => a.rank.pct - b.rank.pct);
    if (all.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "Play at least 5 games on a map to see it here."));
      return sec;
    }
    const confidence = (m) => (m.games < 5 ? "low" : m.games < 10 ? "mid" : "high");
    const mapTitle = (m) =>
      `${m.map}\n${topText(m.rank.pct)} · ${m.wins} win${m.wins === 1 ? "" : "s"} in ${m.games} game${m.games === 1 ? "" : "s"}` +
      `\nan average player: ${m.expectedWins.toFixed(1)} wins${m.games < 10 ? "\nfew games: a rough guide" : ""}`;

    const rated = all.filter((m) => m.games >= 5);
    const best = rated.slice(0, 5);
    const worst = rated.slice(Math.max(best.length, rated.length - 5)).reverse();
    const list = (title, maps) => {
      const box = el("div", "ofr-maplist");
      box.append(el("h3", null, title));
      for (const m of maps) {
        const band = S.percentBand(m.rank.pct);
        const row = el("div", "ofr-maplist-row");
        row.title = mapTitle(m);
        const chip = el("span", "ofr-badge", topText(m.rank.pct));
        chip.dataset.ofrKind = "percentile";
        chip.dataset.ofrBand = band;
        row.append(
          el("span", "ofr-maplist-name", m.map),
          C.meter({ frac: gaugeFrac(m.rank.pct), band, label: `${m.map}: ${topText(m.rank.pct)}` }),
          chip,
        );
        box.append(row);
      }
      return box;
    };
    const lists = el("div", "ofr-maplists");
    if (best.length) lists.append(list("Best maps", best));
    if (worst.length) lists.append(list("Weakest maps", worst));
    if (lists.childElementCount) sec.append(lists);

    const head = el("div", "ofr-dash-subhead");
    head.append(el("h3", null, `All ${all.length} maps`));
    const legend = el("div", "ofr-dash-legend");
    for (const seg of [...GAUGE_SEGMENTS].reverse()) {
      const item = el("span", "ofr-dash-legend-item");
      const sw = el("span", "ofr-maptile-swatch");
      sw.dataset.ofrBand = seg.band;
      item.append(sw, document.createTextNode(seg.hi >= 100 ? "rest" : `top ${seg.hi}%`));
      legend.append(item);
    }
    const faint = el("span", "ofr-dash-legend-item");
    const fsw = el("span", "ofr-maptile-swatch");
    fsw.dataset.ofrBand = GAUGE_SEGMENTS[GAUGE_SEGMENTS.length - 1].band;
    fsw.dataset.conf = "low";
    faint.append(fsw, document.createTextNode("faded: few games"));
    legend.append(faint);
    head.append(legend);
    sec.append(head);

    const grid = el("div", "ofr-maptiles");
    grid.setAttribute("role", "list");
    for (const m of all) {
      const tile = el("span", "ofr-maptile", m.map);
      tile.setAttribute("role", "listitem");
      tile.dataset.ofrBand = S.percentBand(m.rank.pct);
      tile.dataset.conf = confidence(m);
      tile.title = mapTitle(m);
      tile.setAttribute("aria-label", `${m.map}: ${topText(m.rank.pct)}, ${m.wins} of ${m.games} won`);
      grid.append(tile);
    }
    sec.append(grid);

    sec.append(
      numbers(() =>
        table(
          ["Map", "Rank", "Wins", "Games", "Expected wins"],
          all.map((m) => ({ cells: [m.map, topText(m.rank.pct), m.wins, m.games, m.expectedWins.toFixed(1)] })),
        ),
      ),
    );
    return sec;
  }

  function ringCard(frac, value, name, title, { kind = "accent", faint = false, size = 84 } = {}) {
    const card = el("div", "ofr-modering");
    card.title = title;
    if (faint) card.dataset.conf = "low";
    card.append(C.ring({ frac, value, size, thickness: 9, kind, label: title.replace(/\n/g, "; ") }), el("span", "ofr-modering-name", name));
    return card;
  }

  function modesSection(info) {
    const sec = section("By mode");
    // (a mode row may come without a win count: that is no wins, not NaN)
    const rows = (info.modes ?? [])
      .filter((m) => m.games > 0)
      .map((m) => ({ ...m, wins: Number.isFinite(m.wins) ? m.wins : 0 }));
    if (rows.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "No games by mode yet."));
      return sec;
    }
    const wrap = el("div", "ofr-moderings");
    for (const m of rows) {
      const rate = (100 * m.wins) / m.games;
      wrap.append(
        ringCard(rate / 100, `${Math.round(rate)}%`, m.mode, `${m.mode}: won ${m.wins} of ${m.games} (${rate.toFixed(1)}%)`, { faint: m.games < 10 }),
      );
    }
    sec.append(wrap);
    sec.append(
      numbers(() =>
        table(
          ["Mode", "Win rate", "Wins", "Games"],
          rows.map((m) => ({ cells: [m.mode, `${((100 * m.wins) / m.games).toFixed(1)}%`, m.wins, m.games] })),
        ),
      ),
    );
    return sec;
  }

  function bestsSection(info) {
    const sec = section("Personal bests");
    const b = info.bests ?? {};
    const grid = el("div", "ofr-bests");
    const card = (iconName, value, line, title) => {
      const box = el("div", "ofr-best");
      box.title = title;
      const text = el("div", "ofr-best-text");
      text.append(el("div", "ofr-best-value", value), el("div", "ofr-best-line", line));
      box.append(C.icon(iconName), text);
      grid.append(box);
    };
    if (b.fastestWin) {
      card(
        "clock",
        fmtDuration(b.fastestWin.value),
        `Fastest win${b.fastestWin.map ? ` · ${b.fastestWin.map}` : ""}`,
        `Fastest win: ${fmtDuration(b.fastestWin.value)}${b.fastestWin.map ? ` on ${b.fastestWin.map}` : ""}, ${b.fastestWin.players ?? "?"} players`,
      );
    }
    if (b.longestSurvived) {
      card(
        "shield",
        fmtDuration(b.longestSurvived.value),
        `Longest survived${b.longestSurvived.map ? ` · ${b.longestSurvived.map}` : ""}`,
        `Longest survived: ${fmtDuration(b.longestSurvived.value)}${b.longestSurvived.map ? ` on ${b.longestSurvived.map}` : ""}`,
      );
    }
    if (b.gold) {
      card(
        "coins",
        fmtBig(b.gold.value),
        `Most gold${b.gold.map ? ` · ${b.gold.map}` : ""}`,
        `Most gold in a game: ${fmtExact(b.gold.value)}${b.gold.map ? ` on ${b.gold.map}` : ""}`,
      );
    }
    if (grid.children.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "No bests recorded yet."));
    } else {
      sec.append(grid);
    }
    return sec;
  }

  // One row per game: result, map, mode, and two small bars (length and
  // conquests, against the longest / most in the list).
  function historySection(info) {
    const sec = section("Recent games");
    const games = info.recentGames ?? [];
    if (games.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "Nothing yet."));
      return sec;
    }
    const SHOWN = 10;
    const maxLen = Math.max(1, ...games.map((g) => g.duration ?? 0));
    const maxConq = Math.max(1, ...games.map((g) => g.conquests ?? 0));
    const list = el("div", "ofr-games");
    const head = el("div", "ofr-game ofr-game-head");
    const colHead = (iconName, word) => {
      const span = el("span", "ofr-game-colhead");
      span.append(C.icon(iconName), document.createTextNode(word));
      return span;
    };
    head.append(el("span"), el("span"), el("span"), colHead("clock", "length"), colHead("flag", "conquests"));
    list.append(head);
    games.forEach((g, i) => {
      const f = fate(g);
      const row = el(g.id ? "a" : "div", "ofr-game");
      if (g.id) {
        row.href = gameUrl(g.id);
        row.target = "_blank";
        row.rel = "noopener";
      }
      row.dataset.fate = f || "plain";
      if (i >= SHOWN) row.hidden = true;
      row.title =
        `${g.map ?? "?"} · ${g.mode ?? "?"}${g.players != null ? ` · ${g.players} players` : ""}${g.date ? ` · ${when(g)}` : ""}\n` +
        `${FATE_LONG[f]} · ${fmtDuration(g.duration)} long · ${g.conquests ?? "?"} conquests · ${g.nukes ?? "?"} nukes`;
      const mode = el("span", "ofr-game-mode", MODE_SHORT[modeKind(g)]);
      mode.dataset.mode = modeKind(g);
      row.append(
        el("span", "ofr-game-result", FATE_WORD[f]),
        el("span", "ofr-game-map", g.map ?? "—"),
        mode,
        C.meter({ frac: (g.duration ?? 0) / maxLen, kind: "length", label: `length ${fmtDuration(g.duration)}` }),
        C.meter({ frac: (g.conquests ?? 0) / maxConq, kind: "conquests", label: `${g.conquests ?? 0} conquests` }),
      );
      list.append(row);
    });
    sec.append(list);
    if (games.length > SHOWN) {
      const more = el("button", "ofr-dash-more", `Show all ${games.length}`);
      more.type = "button";
      more.addEventListener("click", () => {
        const expand = more.dataset.open !== "true";
        more.dataset.open = String(expand);
        list.querySelectorAll(".ofr-game:not(.ofr-game-head)").forEach((row, i) => {
          row.hidden = !expand && i >= SHOWN;
        });
        more.textContent = expand ? "Show fewer" : `Show all ${games.length}`;
      });
      sec.append(more);
    }
    sec.append(
      numbers(() =>
        table(
          ["Result", "Map", "Mode", "Players", "Length", "Conquests", "Nukes"],
          games.map((g) => {
            let result = g.won ? "Win" : fate(g) === "lost" ? "Eliminated" : "Lost";
            if (g.id) {
              result = el("a", null, result);
              result.href = gameUrl(g.id);
              result.target = "_blank";
              result.rel = "noopener";
            }
            return {
              cls: g.won ? "won" : "lost",
              cells: [result, g.map ?? "—", g.mode ?? "—", g.players, fmtDuration(g.duration), g.conquests, g.nukes],
            };
          }),
        ),
      ),
    );
    return sec;
  }

  // me: your own ofstats name ("[TAG] name"). In streamer mode your entry in
  // the member list says "You" (text, hover and the Numbers table). Members are
  // listed by their bare name and opened by their full one, "[TAG] name", which
  // is how ofstats lists them.
  async function clanSection(tag, { me = null, streamer = false } = {}) {
    const memberKey = (m) => m.username || S.statsName(m.name, tag);
    const isMe = (m) => sameName(memberKey(m), me);
    // masking errs on the side of hiding: your bare name under any tag
    const meBare = me ? bareName(me) : null;
    const shownMember = (m) => (streamer && (isMe(m) || sameName(m.name, meBare)) ? "You" : m.name);
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, `Clan [${tag}]`));
    sec.append(el("p", "ofr-dash-loading", "Loading clan…"));
    let clan = null;
    try {
      clan = await chrome.runtime.sendMessage({ type: "clan", tag });
    } catch {
      clan = null;
    }
    sec.replaceChildren(el("h2", null, `Clan [${tag}]`));
    if (!clan?.found) {
      sec.append(el("p", "ofr-dash-empty", "No clan record on ofstats.io for this tag."));
      return sec;
    }
    const rings = el("div", "ofr-moderings");
    const addRing = (word, wins, games, extra = "") => {
      if (!(games > 0)) return;
      const rate = (100 * (wins ?? 0)) / games;
      rings.append(ringCard(rate / 100, `${Math.round(rate)}%`, word, `${word}: won ${fmtExact(wins ?? 0)} of ${fmtExact(games)} (${rate.toFixed(1)}%)${extra}`));
    };
    addRing("all games", clan.wins, clan.games);
    const t = clan.team;
    if (t) {
      addRing("team games", t.wins, t.games);
      addRing("stacked", t.stackedWins, t.stackedGames, t.avgStack != null ? `\naverage stack ${t.avgStack}` : "");
      addRing("recent", t.recentWins, t.recentGames);
    }
    sec.append(rings);

    const facts = el("div", "ofr-iconrow ofr-iconrow-2");
    const active = clan.memberCount > 0 && clan.activeMembers != null ? clan.activeMembers / clan.memberCount : null;
    const members = iconStat("users", fmtBig(clan.memberCount), "members", `${fmtExact(clan.memberCount)} members, ${fmtExact(clan.activeMembers)} active this month`);
    if (active != null) {
      members.querySelector(".ofr-iconstat-text").append(
        C.meter({ frac: active, kind: "accent", title: `${fmtExact(clan.activeMembers)} active this month`, label: `${fmtExact(clan.activeMembers)} of ${fmtExact(clan.memberCount)} active this month` }),
      );
    }
    facts.append(members, iconStat("clock", fmtDuration(clan.avgGameDuration), "average game", `Average game: ${fmtDuration(clan.avgGameDuration)}`));
    sec.append(facts);

    if (clan.members?.length) {
      sec.append(el("h3", "ofr-dash-h3", "Top members"));
      const top = [...clan.members].sort((a, b) => b.wins - a.wins).slice(0, 24);
      const most = Math.max(1, ...top.map((m) => m.wins ?? 0));
      const list = el("div", "ofr-dash-members");
      for (const m of top) {
        const row = el("div", "ofr-dash-member");
        row.title = `${shownMember(m)}: ${m.wins}/${m.games} won · ${m.winRate != null ? m.winRate.toFixed(1) : "?"}%`;
        const name = el("a", null, shownMember(m));
        name.href = "#";
        name.addEventListener("click", (e) => {
          e.preventDefault();
          // keeps streamer mode; "self" only for your own entry
          open(memberKey(m), { ...currentOpts, clan: tag, self: isMe(m) });
        });
        row.append(name, C.meter({ frac: (m.wins ?? 0) / most, kind: "accent", label: `${m.wins} wins` }));
        list.append(row);
      }
      sec.append(list);
    }
    sec.append(
      numbers(() => {
        const pairs = [
          ["Clan games", `${fmtExact(clan.games)} (${clan.games ? ((100 * clan.wins) / clan.games).toFixed(1) : "0.0"}% won)`],
          ["Members", `${fmtExact(clan.memberCount)} (${fmtExact(clan.activeMembers)} active this month)`],
        ];
        if (t) {
          pairs.push(
            ["Team games", `${fmtExact(t.games)} (${t.games ? ((100 * t.wins) / t.games).toFixed(1) : "0.0"}% won)`],
            ["Stacked games", `${fmtExact(t.stackedGames)} (${t.stackedGames ? ((100 * t.stackedWins) / t.stackedGames).toFixed(1) : "0.0"}% won, average stack ${t.avgStack ?? "?"})`],
            ["Recent team games", `${t.recentWins}/${t.recentGames}`],
          );
        }
        pairs.push(["Average game", fmtDuration(clan.avgGameDuration)]);
        const box = el("div");
        box.append(kv(pairs));
        if (clan.members?.length) {
          box.append(
            table(
              ["Member", "Wins", "Games", "Win rate"],
              [...clan.members].sort((a, b) => b.wins - a.wins).slice(0, 24).map((m) => ({ cells: [shownMember(m), m.wins, m.games, m.winRate != null ? `${m.winRate.toFixed(1)}%` : "?"] })),
            ),
          );
        }
        return box;
      }),
    );
    return sec;
  }

  // Today's games, as recorded by the recap (content.js). Only for yourself.
  // In streamer mode the rank drift stays out, as it does in-game (content.js).
  async function sessionSection({ streamer = false } = {}) {
    const sec = section("Today's session");
    let session = null;
    try {
      session = (await chrome.storage.local.get("session")).session ?? null;
    } catch {
      session = null;
    }
    const today = new Date().toDateString();
    const games = session && session.day === today ? session.games : [];
    if (games.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "No finished games yet today. The recap records each one."));
      return sec;
    }
    const wins = games.filter((g) => g.won).length;
    const placed = games.filter((g) => g.place != null);
    const avgPlace = placed.length
      ? Math.round(placed.reduce((a, g) => a + g.place, 0) / placed.length)
      : null;
    const last = [...games].reverse().find((g) => g.pctAfter != null);
    const drifted = !streamer && session.startPct != null && !!last;

    const row = el("div", "ofr-session");
    row.append(
      heroCard(
        C.ring({
          frac: wins / games.length,
          value: `${wins}/${games.length}`,
          size: 92,
          thickness: 9,
          kind: "good",
          label: `${wins} of ${games.length} games won today`,
          title: `${wins} of ${games.length} won today (${((100 * wins) / games.length).toFixed(0)}%)`,
        }),
        "won today",
      ),
    );

    // one bar per game: taller = better placed; a win is green
    const bars = el("div", "ofr-session-bars");
    bars.setAttribute("role", "img");
    bars.setAttribute("aria-label", `Placings today${avgPlace != null ? `, average place ${avgPlace}` : ""}`);
    for (const g of games) {
      const bar = el("span", `ofr-session-bar${g.won ? " won" : ""}`);
      const time = g.at ? new Date(g.at).toLocaleTimeString() : "";
      if (g.place != null && g.total > 1) {
        bar.style.height = `${Math.max(8, 100 * (1 - (g.place - 1) / (g.total - 1))).toFixed(0)}%`;
        bar.title = `${g.won ? "Won" : `#${g.place} of ${g.total}`}${time ? ` · ${time}` : ""}`;
      } else {
        bar.dataset.noplace = "true";
        bar.title = `${g.won ? "Won" : "Played"} (no single place)${time ? ` · ${time}` : ""}`;
      }
      bars.append(bar);
    }
    row.append(heroCard(bars, "placing", el("div", "ofr-hero-key", "taller = better")));

    if (drifted) {
      const drift = el("div", "ofr-drift");
      // one decimal when whole percents would hide the move
      const exact = S.formatPercent(session.startPct) === S.formatPercent(last.pctAfter) && session.startPct >= 1 && last.pctAfter >= 1;
      const badge = (pct) => {
        const b = el("span", "ofr-badge", exact ? `Top ${pct.toFixed(1)}%` : topText(pct));
        b.dataset.ofrKind = "percentile";
        b.dataset.ofrBand = S.percentBand(pct);
        return b;
      };
      const better = last.pctAfter < session.startPct;
      const same = Math.abs(last.pctAfter - session.startPct) < 0.05;
      const arrow = el("span", "ofr-drift-arrow", same ? "→" : better ? "↗" : "↘");
      arrow.dataset.dir = same ? "same" : better ? "up" : "down";
      drift.append(badge(session.startPct), arrow, badge(last.pctAfter));
      drift.title = `World rank at the start of the session vs now`;
      row.append(heroCard(drift, "rank today"));
    }
    sec.append(row);
    sec.append(
      numbers(() =>
        kv([
          ["Games", String(games.length)],
          ["Wins", `${wins} (${((100 * wins) / games.length).toFixed(0)}%)`],
          ["Average place", avgPlace != null ? `#${avgPlace}` : "—"],
          [
            "Percentile drift",
            streamer ? null : drifted ? `${S.formatPercent(session.startPct)}% → ${S.formatPercent(last.pctAfter)}%` : "—",
          ],
        ]),
      ),
    );
    return sec;
  }

  // ofstats' weekly clan table, with your clan highlighted.
  async function clanLeaderboardSection(myTag) {
    const sec = section("Clan leaderboard — this week");
    let lb = null;
    try {
      lb = await chrome.runtime.sendMessage({ type: "clanLeaderboard" });
    } catch {
      lb = null;
    }
    if (!lb?.found || !lb.clans?.length) {
      sec.append(el("p", "ofr-dash-empty", "Leaderboard unavailable."));
      return sec;
    }
    const clans = lb.clans.slice(0, 10);
    const list = el("div", "ofr-lb");
    const head = el("div", "ofr-lb-row ofr-lb-head");
    head.append(el("span"), el("span"), el("span", null, "points"), el("span", null, "stacked win rate"));
    list.append(head);
    for (const c of clans) {
      const row = el("div", `ofr-lb-row${myTag && c.tag === myTag ? " mine" : ""}`);
      row.title =
        `[${c.tag}] #${c.rank}\n${fmtBig(c.points)} points · ${fmtBig(c.games)} games · ${fmtBig(c.wins)} wins` +
        (c.stackedWinRate != null ? `\nstacked win rate ${c.stackedWinRate}%` : "");
      row.append(
        el("span", "ofr-lb-rank", String(c.rank)),
        el("span", "ofr-lb-tag", `[${c.tag}]`),
        el("span", "ofr-lb-points", fmtBig(c.points)),
        c.stackedWinRate != null
          ? C.meter({ frac: Number(c.stackedWinRate) / 100, kind: "good", label: `stacked win rate ${c.stackedWinRate}%` })
          : el("span", "ofr-dash-dim", "—"),
      );
      list.append(row);
    }
    sec.append(list);
    sec.append(
      numbers(() => {
        const box = el("div");
        if (lb.week) box.append(el("p", "ofr-dash-note", `Week ${lb.week}, by points (ofstats.io).`));
        box.append(
          table(
            ["#", "Clan", "Points", "Games", "Wins", "Stacked WR"],
            clans.map((c) => ({
              cls: myTag && c.tag === myTag ? "mine" : "",
              cells: [c.rank, `[${c.tag}]`, fmtBig(c.points), fmtBig(c.games), fmtBig(c.wins), c.stackedWinRate != null ? `${c.stackedWinRate}%` : "—"],
            })),
            "ofr-dash-lb",
          ),
        );
        return box;
      }),
    );
    return sec;
  }

  // Two players side by side: their rank gauges, then mirrored bars (the
  // better side stands out), shared maps, and head-to-head from the shared
  // recent games.
  function compareSection(aName, a, bName, b) {
    const aShown = currentOpts.self && currentOpts.streamer ? "You" : aName;
    const sec = section(`${aShown} vs ${bName}`);
    const ra = S.ranked(a);
    const rb = S.ranked(b);

    const head = el("div", "ofr-vs");
    const side = (name, rank, which) => {
      const box = el("div", `ofr-vs-side ${which}`);
      box.append(rankGauge(rank, { size: 96, thickness: 10 }), el("span", "ofr-vs-name", name));
      return box;
    };
    head.append(side(aShown, ra, "a"), el("span", "ofr-vs-word", "vs"), side(bName, rb, "b"));
    sec.append(head);

    // [label, a, b, format, "high" | "low" is better, scale max or null for the pair's max]
    const metrics = [
      ["World percentile", ra ? ra.pct : null, rb ? rb.pct : null, (v) => topText(v), "low", "rank"],
      ["Wins vs expected", ra ? ra.ratio : null, rb ? rb.ratio : null, (v) => `${v.toFixed(2)}x`, "high", null],
      ["Win rate", winRateOf(a), winRateOf(b), (v) => `${v.toFixed(1)}%`, "high", 100],
      ["Games", a.games, b.games, (v) => fmtBig(v), "high", null],
      ["Current streak", a.streak ?? 0, b.streak ?? 0, (v) => String(v), "high", null],
      ["Conquests / game", a.games ? (a.conquests ?? 0) / a.games : null, b.games ? (b.conquests ?? 0) / b.games : null, (v) => v.toFixed(1), "high", null],
      ["Nukes / game", a.games ? (a.nukes ?? 0) / a.games : null, b.games ? (b.nukes ?? 0) / b.games : null, (v) => v.toFixed(2), "high", null],
    ];
    const toRow = ([label, va, vb, fmt, better, scale]) => {
      const has = (v) => v != null && Number.isFinite(v);
      const top = scale === "rank" ? 1 : scale ?? Math.max(has(va) ? va : 0, has(vb) ? vb : 0);
      const frac = (v) => (!has(v) ? null : scale === "rank" ? gaugeFrac(v) : top > 0 ? v / top : 0);
      const aWins = has(va) && has(vb) && va !== vb ? (better === "high" ? va > vb : va < vb) : null;
      return {
        label,
        title: `${label}: ${aShown} ${has(va) ? fmt(va) : "—"}, ${bName} ${has(vb) ? fmt(vb) : "—"}`,
        a: { frac: frac(va), text: has(va) ? fmt(va) : "—", better: aWins === true },
        b: { frac: frac(vb), text: has(vb) ? fmt(vb) : "—", better: aWins === false },
      };
    };
    const main = metrics.filter((m) => m[0] !== "World percentile"); // the gauges above show it
    sec.append(C.mirror({ rows: main.map(toRow) }));

    // maps both have played enough to rate, most played first
    const mapsA = new Map((a.maps ?? []).filter((m) => m.games >= 5).map((m) => [m.map, m]));
    const shared = [];
    for (const mb of (b.maps ?? []).filter((m) => m.games >= 5)) {
      const ma = mapsA.get(mb.map);
      if (!ma) continue;
      const pa = S.rowRank(ma)?.pct;
      const pb = S.rowRank(mb)?.pct;
      if (pa == null || pb == null) continue;
      shared.push({ map: mb.map, pa, pb, games: ma.games + mb.games });
    }
    shared.sort((x, y) => y.games - x.games);
    const mapRows = shared.map((m) => [`On ${m.map}`, m.pa, m.pb, (v) => topText(v), "low", "rank"]);
    if (mapRows.length) {
      sec.append(el("h3", "ofr-dash-h3", "Shared maps"));
      sec.append(C.mirror({ rows: mapRows.slice(0, 6).map((r) => ({ ...toRow(r), label: r[0].slice(3) })) }));
    }

    const recentA = new Map((a.recentGames ?? []).map((g) => [g.id, g.won]));
    let met = 0;
    let aWon = 0;
    let bWon = 0;
    for (const g of b.recentGames ?? []) {
      if (!recentA.has(g.id)) continue;
      met++;
      if (recentA.get(g.id)) aWon++;
      if (g.won) bWon++;
    }
    if (met) {
      sec.append(el("h3", "ofr-dash-h3", "Head to head"));
      const top = Math.max(1, aWon, bWon);
      sec.append(
        C.mirror({
          rows: [
            {
              label: `${met} shared game${met === 1 ? "" : "s"}`,
              title: `Shared ${met} recent game${met === 1 ? "" : "s"}: ${aShown} won ${aWon}, ${bName} won ${bWon}`,
              a: { frac: aWon / top, text: `${aWon} won`, better: aWon > bWon },
              b: { frac: bWon / top, text: `${bWon} won`, better: bWon > aWon },
            },
          ],
        }),
      );
    } else {
      sec.append(el("p", "ofr-dash-note", "No shared games in either player's recent games."));
    }

    sec.append(
      numbers(() =>
        table(
          ["", aShown, bName],
          [...metrics, ...mapRows].map((r) => {
            const row = toRow(r);
            const ca = el("span", row.a.better ? "better" : "", row.a.text);
            const cb = el("span", row.b.better ? "better" : "", row.b.text);
            return { cells: [r[0], ca, cb] };
          }),
          "ofr-dash-cmp",
        ),
      ),
    );
    return sec;
  }

  // ---- dashboard shell -------------------------------------------------------

  // Closes the open dashboard, Escape listener included. Opening one over
  // another (a clan member's link) goes through it: removing only the element
  // would leave its capture-phase listener eating the next Escape in the game.
  let destroyCurrent = null;

  function shell() {
    destroyCurrent?.();
    document.querySelector(`.${ROOT_CLASS}`)?.remove(); // one left by an earlier copy of this script
    const root = el("div", ROOT_CLASS);
    const bar = el("div", "ofr-dash-bar");
    bar.append(el("span", "ofr-dash-brand", "OpenFront Pro"));
    bar.append(el("span", "ofr-dash-unofficial", "unofficial"));
    const search = el("input", "ofr-dash-search");
    search.type = "search";
    search.placeholder = "Player name, with [TAG] if they have one";
    search.title = 'ofstats.io counts a player with a clan tag as "[TAG] name", separately from the bare name';
    bar.append(search);
    const close = el("button", "ofr-dash-close", "✕");
    close.type = "button";
    bar.append(close);
    const gear = el("button", "ofr-dash-close", "Settings");
    gear.type = "button";
    gear.addEventListener("click", (e) => e.isTrusted && globalThis.__ofrOpenSettings?.()); // a person, not a page script
    bar.insertBefore(gear, close);
    root.append(bar);
    const body = el("div", "ofr-dash-body");
    root.append(body);
    document.body.appendChild(root);

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        destroy();
      }
    };
    const destroy = () => {
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      if (destroyCurrent === destroy) destroyCurrent = null;
    };
    document.addEventListener("keydown", onKey, true);
    destroyCurrent = destroy;
    close.addEventListener("click", destroy);
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !search.value.trim()) return;
      const query = tidyName(search.value); // "[LUX] TeNa" stays tagged
      // Someone else: what the dashboard was opened with (you, your session,
      // your clan) is not theirs.
      if (!sameName(query, currentName)) {
        currentOpts = { clanStats: currentOpts.clanStats, streamer: currentOpts.streamer, self: sameName(query, ownName()) };
      }
      render(body, query);
    });
    return { root, body, search };
  }

  let currentOpts = {};
  let currentName = null;

  const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

  // Your own ofstats name ("[TAG] name" with a clan tag), so streamer mode can
  // hide it wherever it would show (your page, your clan's member list): the
  // dashboard's player when it is you, else content.js's answer (your lobby
  // row, else the name and TAG field OpenFront keeps in localStorage).
  function ownName() {
    if (currentOpts.self && currentName) return currentName;
    try {
      if (typeof globalThis.__ofrSelfStatsName === "function") return globalThis.__ofrSelfStatsName();
      const name = localStorage.getItem("username");
      const tag = localStorage.getItem("clanTag");
      return name ? S.statsName(name, /^[A-Za-z0-9]{1,5}$/.test(tag ?? "") ? tag : null) : null;
    } catch {
      return null;
    }
  }

  async function render(body, name) {
    currentName = name;
    // Streamer mode: your name only ever shows as "you".
    const hide = currentOpts.self && currentOpts.streamer;
    body.replaceChildren(el("p", "ofr-dash-loading", hide ? "Loading your stats…" : `Loading ${name}…`));
    let info = null;
    try {
      info = await lookup(name);
    } catch (err) {
      body.replaceChildren(el("p", "ofr-dash-empty", `Lookup failed: ${err?.message ?? err}`));
      return;
    }
    // A tagged name with no history stays that: the bare name is someone else's
    // record on ofstats, so it is never shown in its place.
    if (!info?.found) {
      body.replaceChildren(
        el(
          "p",
          "ofr-dash-empty",
          hide ? "No public-game history for you on ofstats.io." : `No public-game history for "${name}" on ofstats.io.${hasTag(name) ? "" : TAG_HINT}`,
        ),
      );
      return;
    }
    body.replaceChildren(
      headerSection(name, info),
      overviewSection(info),
      formSection(info),
      trendsSection(info),
      mapsSection(info),
      modesSection(info),
      bestsSection(info),
      historySection(info),
    );
    if (currentOpts.self) {
      const placeholder = el("section", "ofr-dash-section");
      body.insertBefore(placeholder, body.children[2]);
      sessionSection({ streamer: !!currentOpts.streamer }).then((sec) => placeholder.replaceWith(sec));
    }
    if (currentOpts.clan && currentOpts.clanStats !== false) {
      const placeholder = el("section", "ofr-dash-section");
      body.insertBefore(placeholder, body.children[currentOpts.self ? 3 : 2]);
      clanSection(currentOpts.clan, { me: ownName(), streamer: !!currentOpts.streamer }).then((sec) => placeholder.replaceWith(sec));
    }
    if (currentOpts.clanStats !== false) {
      const placeholder = el("section", "ofr-dash-section");
      body.append(placeholder);
      clanLeaderboardSection(currentOpts.clan ?? null).then((sec) => placeholder.replaceWith(sec));
    }
  }

  // name: the player's ofstats name ("[TAG] name" with a clan tag; content.js
  // builds it); opts.clan: that tag, for the clan section.
  function open(name, opts = {}) {
    // Your own page, however it was reached (a clan member link, a lobby chip):
    // it is "self", so streamer mode hides the name and your session shows.
    currentOpts = { ...opts };
    currentName = null;
    if (name && !currentOpts.self && sameName(name, ownName())) currentOpts.self = true;
    opts = currentOpts;
    const { body, search } = shell();
    if (name) {
      // Streamer mode hides who you are; the search box would spell it out.
      search.value = opts.self && opts.streamer ? "" : name;
      render(body, name);
    } else {
      body.replaceChildren(
        el("p", "ofr-dash-empty", "Set a username in OpenFront, or search for any player above."),
      );
      // The weekly clan table needs no player, so it still has a home here.
      if (opts.clanStats !== false) {
        const placeholder = el("section", "ofr-dash-section");
        body.append(placeholder);
        clanLeaderboardSection(opts.clan ?? null).then((sec) => placeholder.replaceWith(sec));
      }
    }
  }

  // ---- home-page card --------------------------------------------------------
  // Your stats on OpenFront's front page, without opening anything: a rank
  // gauge, the win rate against an average player, the last ten results and
  // today's session. Re-rendered by content.js on each scan (the page is a Lit
  // component that re-renders); refetches at most once a minute per name.
  // name: your ofstats name, "[TAG] name" when OpenFront's TAG field is set.
  async function homeWidget(host, name, opts = {}) {
    let card = document.querySelector(".ofr-home");
    const place = () => {
      if (opts.after?.isConnected) opts.after.insertAdjacentElement("afterend", card);
      else host.appendChild(card);
    };
    if (!card) {
      card = el("div", "ofr-home");
      place();
    } else if (
      card.parentElement !== host ||
      (opts.after?.isConnected && card.previousElementSibling !== opts.after)
    ) {
      place();
    }
    // Streamer mode changes what the card shows (your name), so turning it on
    // re-renders at once instead of after the minute.
    const key = `${name ?? ""}|${opts.streamer ? 1 : 0}`;
    if (
      card.dataset.ofrFor === key &&
      Date.now() - Number(card.dataset.ofrAt ?? 0) < 60000
    ) {
      return;
    }
    card.dataset.ofrFor = key;
    card.dataset.ofrAt = String(Date.now());

    const bar = el("div", "ofr-home-bar");
    bar.append(el("span", "ofr-home-brand", "OpenFront Pro"));
    const openBtn = el("button", "ofr-home-btn", "Dashboard");
    openBtn.type = "button";
    openBtn.addEventListener("click", () => open(name ?? null, { ...opts, self: !!name }));
    const setBtn = el("button", "ofr-home-btn", "Settings");
    setBtn.type = "button";
    setBtn.addEventListener("click", (e) => e.isTrusted && globalThis.__ofrOpenSettings?.()); // a person, not a page script
    const btns = el("span", "ofr-home-btns");
    btns.append(openBtn, setBtn);
    bar.append(btns);
    card.replaceChildren(bar);

    if (!name) {
      card.append(
        el("p", "ofr-home-empty", "Set a username above and your stats will appear here."),
      );
      return;
    }

    card.append(el("p", "ofr-home-empty", "Loading…"));
    let info = null;
    try {
      info = await lookup(name);
    } catch {
      info = null;
    }
    if (card.dataset.ofrFor !== key) return; // name changed meanwhile
    card.querySelector(".ofr-home-empty")?.remove();
    if (!info?.found) {
      card.append(el("p", "ofr-home-empty", opts.streamer ? "No public-game history for you yet." : `No public-game history for "${name}" yet.`));
      return;
    }

    const rank = S.ranked(info);
    const w = winFigures(info);
    const stats = el("div", "ofr-home-stats");
    stats.append(rankGauge(rank, { size: 72, thickness: 11 }));

    const side = el("div", "ofr-home-side");
    const title = el("div", "ofr-home-title");
    title.append(el("span", "ofr-home-name", opts.streamer ? "You" : name));
    if (info.streak > 0) {
      title.append(
        C.pips({
          lit: Math.min(5, info.streak),
          total: Math.min(5, info.streak),
          glyph: "flame",
          label: `${info.streak} wins in a row`,
          title: `${info.streak} win${info.streak === 1 ? "" : "s"} in a row`,
        }),
      );
    }
    const todayBox = el("span", "ofr-home-today");
    title.append(todayBox);
    side.append(title);

    const rateRow = el("div", "ofr-home-row");
    rateRow.append(
      C.icon("trophy"),
      C.meter({
        frac: w.shown != null ? w.shown / 100 : 0,
        kind: w.above ? "good" : "average",
        mark: w.expected != null ? { frac: w.expected / 100, title: `An average player in the same lobbies: ${w.expected.toFixed(1)}%` } : null,
        title: w.title,
        label: w.label,
      }),
    );
    side.append(rateRow);

    const recent = (info.recentGames ?? []).slice(0, 10);
    if (recent.length) side.append(resultsStrip(recent));
    stats.append(side);
    card.append(stats);

    try {
      const stored = (await chrome.storage.local.get("session")).session;
      if (stored && stored.day === new Date().toDateString() && stored.games.length) {
        const w = stored.games.filter((g) => g.won).length;
        const n = stored.games.length;
        const text = `Today: ${n} game${n === 1 ? "" : "s"}, ${w} win${w === 1 ? "" : "s"}`;
        // one dot per game in the order played (the last 12), a win lit
        const dots = el("span", "ofr-pips");
        dots.dataset.glyph = "dot";
        dots.setAttribute("role", "img");
        dots.setAttribute("aria-label", text);
        dots.title = text;
        for (const g of stored.games.slice(-12)) dots.append(el("span", `ofr-pip${g.won ? " on" : ""}`));
        todayBox.append(el("span", "ofr-home-today-word", "today"), dots);
      }
    } catch {
      // storage unavailable
    }
  }

  globalThis.__ofrHomeWidget = homeWidget;
  globalThis.__ofrOpenDashboard = open;
})();
