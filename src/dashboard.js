// The Pro dashboard: a full-page statistics view drawn over OpenFront's front
// page, opened from a "Pro" button the extension adds to the nav bar. It uses
// the same one-request-per-player ofstats payload as the badges, so opening it
// costs one lookup for you (cached after the first).
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

  function profileUrl(name) {
    return `https://ofstats.io/player/${encodeURIComponent(name)}`;
  }

  function gameUrl(id) {
    return `https://ofstats.io/game/${encodeURIComponent(id)}`;
  }

  // ---- data ------------------------------------------------------------------

  async function lookup(username) {
    const res = await chrome.runtime.sendMessage({
      type: "lookup",
      usernames: [username],
      full: true,
    });
    return res?.[username] ?? null;
  }

  // ---- widgets ---------------------------------------------------------------

  function statTile(label, value, sub) {
    const tile = el("div", "ofr-dash-tile");
    tile.append(el("div", "ofr-dash-tile-value", value));
    tile.append(el("div", "ofr-dash-tile-label", label));
    if (sub) tile.append(el("div", "ofr-dash-tile-sub", sub));
    return tile;
  }

  // A tiny bar chart: rows of label + proportional bar + value.
  function barChart(rows, { valueText = (v) => String(v), max } = {}) {
    const wrap = el("div", "ofr-dash-bars");
    const top = max ?? Math.max(1, ...rows.map((r) => r.value));
    for (const row of rows) {
      const line = el("div", "ofr-dash-bar-row");
      line.append(el("span", "ofr-dash-bar-label", row.label));
      const track = el("span", "ofr-dash-bar-track");
      const fill = el("span", "ofr-dash-bar-fill");
      fill.style.width = `${Math.max(2, (100 * row.value) / top)}%`;
      if (row.band) fill.dataset.ofrBand = row.band;
      track.append(fill);
      line.append(track);
      line.append(el("span", "ofr-dash-bar-value", valueText(row.value, row)));
      wrap.append(line);
    }
    return wrap;
  }

  // Win/loss strip for the recent games, oldest to newest.
  function resultsStrip(games) {
    const strip = el("div", "ofr-dash-strip");
    for (const g of [...games].reverse()) {
      const kind = /team/i.test(g.mode ?? "") ? "team" : /1v1|ranked/i.test(g.mode ?? "") ? "duel" : "ffa";
      const cell = el("span", `ofr-dash-strip-cell ${g.won ? "won" : "lost"}`);
      cell.dataset.mode = kind; // team games are drawn as outlines: a shared win
      cell.title = `${g.map ?? ""} - ${g.mode ?? "?"} - ${g.won ? "won" : "lost"}`;
      strip.append(cell);
    }
    return strip;
  }

  // ---- sections --------------------------------------------------------------

  function headerSection(name, info) {
    const head = el("div", "ofr-dash-header");
    const title = el("div", "ofr-dash-title");
    const shownName = currentOpts.self && currentOpts.streamer ? "You" : name;
    title.append(el("span", "ofr-dash-name", shownName));
    const rank = S.ranked(info);
    if (rank) {
      const badge = el("span", "ofr-badge", `Top ${S.formatPercent(rank.pct)}%`);
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
    cmp.placeholder = "Compare with\u2026";
    cmp.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !cmp.value.trim()) return;
      const other = cmp.value.trim();
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
        sec.append(el("p", "ofr-dash-empty", `No history for "${other}".`));
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

  function overviewSection(info) {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, "Overview"));
    const grid = el("div", "ofr-dash-grid");
    const rank = S.ranked(info);
    grid.append(
      statTile(
        "World percentile",
        rank ? `Top ${S.formatPercent(rank.pct)}%` : "—",
        rank ? `${rank.ratio.toFixed(2)}x expected wins` : "not enough rated games",
      ),
      statTile("Games", fmtBig(info.games)),
      statTile("Wins", fmtBig(info.wins), `${info.winRate.toFixed(1)}% win rate`),
      statTile(
        "Expected wins",
        info.expectedWins != null ? info.expectedWins.toFixed(1) : "—",
        "an average player in your lobbies",
      ),
      statTile("Current streak", info.streak ?? 0, "wins in a row"),
      statTile("Conquests", fmtBig(info.conquests), "players, nations and bots"),
      statTile("Nukes launched", fmtBig(info.nukes)),
      statTile("Gold earned", fmtBig(info.gold)),
    );
    sec.append(grid);
    return sec;
  }

  function formSection(info) {
    const sec = el("section", "ofr-dash-section");
    const games = info.recentGames ?? [];
    sec.append(el("h2", null, `Recent form — last ${games.length} games`));
    if (games.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "No recent games on record."));
      return sec;
    }
    const wins = games.filter((g) => g.won).length;
    const last10 = games.slice(0, 10);
    const last10Wins = last10.filter((g) => g.won).length;
    sec.append(
      el(
        "p",
        "ofr-dash-note",
        `${wins} wins in ${games.length} (${((100 * wins) / games.length).toFixed(0)}%), ` +
          `${last10Wins} in the last ${last10.length}. Oldest on the left. ` +
          `All modes count: ${["ffa", "team", "duel"]
            .map((k) => {
              const of = games.filter((g) => (/team/i.test(g.mode ?? "") ? "team" : /1v1|ranked/i.test(g.mode ?? "") ? "duel" : "ffa") === k);
              return of.length ? `${k === "ffa" ? "free-for-all" : k === "duel" ? "1v1" : "team"} ${of.filter((g) => g.won).length}/${of.length}` : null;
            })
            .filter(Boolean)
            .join(", ")}. Outlined cells are team games, where the win is shared.`,
      ),
    );
    sec.append(resultsStrip(games));
    return sec;
  }

  // Graphs over the recent games (oldest on the left, like the strip above).
  //   - rolling win rate over a 10-game window, against what an average player
  //     would win in the same lobbies (1 / players, or 1 / teams);
  //   - how much of each game they were alive for;
  //   - gold earned per game.
  function trendsSection(info) {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, "Trends"));
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
    const when = (g) => (g.date ? new Date(g.date).toLocaleDateString() : "");
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
    grid.append(
      card(
        `Win rate, rolling ${WINDOW} games`,
        expected != null
          ? `Dashed: ${expected.toFixed(1)}% - what an average player wins in these lobbies.`
          : null,
        C.line({
          series: [{ points, cls: "accent", area: true }],
          width: 420,
          height: 150,
          xMin: 1,
          xMax: games.length,
          yMax: Math.min(100, top),
          xTicks: [1, games.length],
          xFormat: (x) => (x === 1 ? "oldest" : "latest"),
          yFormat: (y) => `${Math.round(y)}%`,
          baseline: expected != null ? { y: expected } : null,
          label: "Rolling win rate over recent games",
        }),
      ),
    );

    // survival per game
    // Eliminated or not comes from killedAt alone. Without the game's length the
    // share is unknown, and such a game is left out rather than drawn as "alive".
    const fate = (g) => (g.won ? "won" : g.killedAt != null ? "lost" : "");
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
    grid.append(
      card(
        "Survival per game",
        `Alive at the end in ${survival.length - died.length} of ${survival.length}` +
          (died.length ? `; when eliminated, ${Math.round(died.reduce((a, s) => a + s.value, 0) / died.length)}% of the way in on average.` : "."),
        C.columns({ items: survival, width: 420, height: 150, yMax: 100, yFormat: (y) => `${y}%`, label: "Share of each game survived" }),
      ),
    );

    // gold per game
    const golds = games.filter((g) => g.gold != null);
    if (golds.length >= 5) {
      const best = golds.reduce((a, g) => (g.gold > a.gold ? g : a), golds[0]);
      grid.append(
        card(
          "Gold earned per game",
          `Best: ${fmtBig(best.gold)} on ${best.map ?? "?"}.`,
          C.columns({
            items: golds.map((g) => ({ value: g.gold, cls: fate(g), title: `${g.map ?? "?"} - ${when(g)}\n${fmtBig(g.gold)} gold${g.won ? ", won" : ""}` })),
            width: 420,
            height: 150,
            yFormat: (y) => fmtBig(y),
            label: "Gold earned per game",
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
    return sec;
  }

  function mapsSection(info) {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, "By map"));
    const rows = (info.maps ?? [])
      .filter((m) => m.games >= 5 && m.expectedWins > 0)
      .map((m) => ({ ...m, rank: S.rowRank(m) }))
      .sort((a, b) => a.rank.pct - b.rank.pct);
    if (rows.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "Play at least 5 games on a map to see it here."));
      return sec;
    }
    sec.append(
      el("p", "ofr-dash-note", "Your percentile on each map. Longer bar = stronger."),
    );
    sec.append(
      barChart(
        rows.map((m) => ({
          label: m.map,
          value: 100 - m.rank.pct,
          band: S.percentBand(m.rank.pct),
          row: m,
        })),
        {
          max: 100,
          valueText: (_v, r) =>
            `Top ${S.formatPercent(r.row.rank.pct)}% · ${r.row.wins}/${r.row.games}`,
        },
      ),
    );
    return sec;
  }

  function modesSection(info) {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, "By mode"));
    const rows = (info.modes ?? []).filter((m) => m.games > 0);
    if (rows.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "No games by mode yet."));
      return sec;
    }
    sec.append(
      barChart(
        rows.map((m) => ({ label: m.mode, value: (100 * m.wins) / m.games, row: m })),
        {
          max: Math.max(10, ...rows.map((m) => (100 * m.wins) / m.games)),
          valueText: (v, r) => `${v.toFixed(1)}% · ${r.row.wins}/${r.row.games}`,
        },
      ),
    );
    return sec;
  }

  function bestsSection(info) {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, "Personal bests"));
    const b = info.bests ?? {};
    const grid = el("div", "ofr-dash-grid");
    if (b.fastestWin) {
      grid.append(
        statTile("Fastest win", fmtDuration(b.fastestWin.value), `${b.fastestWin.map ?? ""} · ${b.fastestWin.players ?? "?"} players`),
      );
    }
    if (b.longestSurvived) {
      grid.append(statTile("Longest survived", fmtDuration(b.longestSurvived.value), b.longestSurvived.map ?? ""));
    }
    if (b.gold) grid.append(statTile("Most gold in a game", fmtBig(b.gold.value), b.gold.map ?? ""));
    if (grid.children.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "No bests recorded yet."));
    } else {
      sec.append(grid);
    }
    return sec;
  }

  function historySection(info) {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, "Recent games"));
    const games = (info.recentGames ?? []).slice(0, 20);
    if (games.length === 0) {
      sec.append(el("p", "ofr-dash-empty", "Nothing yet."));
      return sec;
    }
    const table = el("table", "ofr-dash-table");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["Result", "Map", "Mode", "Players", "Length", "Conquests", "Nukes"]) {
      hr.append(el("th", null, h));
    }
    thead.append(hr);
    table.append(thead);
    const tbody = el("tbody");
    for (const g of games) {
      const tr = el("tr", g.won ? "won" : "lost");
      const result = el("td");
      const link = el("a", null, g.won ? "Win" : g.killedAt ? "Eliminated" : "Lost");
      link.href = gameUrl(g.id);
      link.target = "_blank";
      link.rel = "noopener";
      result.append(link);
      tr.append(
        result,
        el("td", null, g.map ?? "—"),
        el("td", null, g.mode ?? "—"),
        el("td", null, g.players != null ? String(g.players) : "—"),
        el("td", null, fmtDuration(g.duration)),
        el("td", null, g.conquests != null ? String(g.conquests) : "—"),
        el("td", null, g.nukes != null ? String(g.nukes) : "—"),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    sec.append(table);
    return sec;
  }

  async function clanSection(tag) {
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
    const grid = el("div", "ofr-dash-grid");
    const wr = clan.games ? ((100 * clan.wins) / clan.games).toFixed(1) : "0.0";
    grid.append(
      statTile("Clan games", fmtBig(clan.games), `${wr}% win rate`),
      statTile("Members", fmtBig(clan.memberCount), `${fmtBig(clan.activeMembers)} active this month`),
    );
    if (clan.team) {
      const t = clan.team;
      const twr = t.games ? ((100 * t.wins) / t.games).toFixed(1) : "0.0";
      grid.append(
        statTile("Team games", fmtBig(t.games), `${twr}% win rate`),
        statTile("Stacked games", fmtBig(t.stackedGames), `${t.stackedGames ? ((100 * t.stackedWins) / t.stackedGames).toFixed(1) : "0.0"}% won · avg stack ${t.avgStack ?? "?"}`),
        statTile("Recent form", `${t.recentWins}/${t.recentGames}`, "team games"),
      );
    }
    grid.append(statTile("Average game", fmtDuration(clan.avgGameDuration)));
    sec.append(grid);

    if (clan.members?.length) {
      sec.append(el("h2", null, "Top members"));
      const list = el("div", "ofr-dash-members");
      for (const m of [...clan.members].sort((a, b) => b.wins - a.wins).slice(0, 24)) {
        const row = el("div", "ofr-dash-member");
        const name = el("a", null, m.name);
        name.href = "#";
        name.addEventListener("click", (e) => {
          e.preventDefault();
          open(m.name, { clan: tag });
        });
        row.append(name, el("span", null, `${m.wins}/${m.games} · ${m.winRate != null ? m.winRate.toFixed(1) : "?"}%`));
        list.append(row);
      }
      sec.append(list);
    }
    return sec;
  }

  // Today's games, as recorded by the recap (content.js). Only for yourself.
  async function sessionSection() {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, "Today's session"));
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
    const grid = el("div", "ofr-dash-grid");
    grid.append(
      statTile("Games", String(games.length)),
      statTile("Wins", String(wins), `${((100 * wins) / games.length).toFixed(0)}% today`),
      statTile("Average place", avgPlace != null ? `#${avgPlace}` : "\u2014"),
      statTile(
        "Percentile drift",
        session.startPct != null && last
          ? `${S.formatPercent(session.startPct)}% \u2192 ${S.formatPercent(last.pctAfter)}%`
          : "\u2014",
        "start of session vs now",
      ),
    );
    sec.append(grid);
    const strip = el("div", "ofr-dash-session");
    for (const g of games) {
      const chip = el("span", g.won ? "won" : "", g.place != null ? `#${g.place}/${g.total}` : "played");
      chip.title = new Date(g.at).toLocaleTimeString();
      strip.append(chip);
    }
    sec.append(strip);
    return sec;
  }

  // ofstats' weekly clan table, with your clan highlighted.
  async function clanLeaderboardSection(myTag) {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, "Clan leaderboard \u2014 this week"));
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
    if (lb.week) sec.append(el("p", "ofr-dash-note", `Week ${lb.week}, by points (ofstats.io).`));
    const table = el("table", "ofr-dash-lb");
    const head = el("tr");
    for (const h of ["#", "Clan", "Points", "Games", "Wins", "Stacked WR"]) head.append(el("th", null, h));
    const thead = el("thead");
    thead.append(head);
    table.append(thead);
    const tbody = el("tbody");
    for (const c of lb.clans.slice(0, 10)) {
      const tr = el("tr", myTag && c.tag === myTag ? "mine" : "");
      tr.append(
        el("td", null, String(c.rank)),
        el("td", null, `[${c.tag}]`),
        el("td", null, fmtBig(c.points)),
        el("td", null, fmtBig(c.games)),
        el("td", null, fmtBig(c.wins)),
        el("td", null, c.stackedWinRate != null ? `${c.stackedWinRate}%` : "\u2014"),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    sec.append(table);
    return sec;
  }

  // Two players side by side. Better value in green; head-to-head from the
  // shared recent games.
  function compareSection(aName, a, bName, b) {
    const sec = el("section", "ofr-dash-section");
    sec.append(el("h2", null, `${aName} vs ${bName}`));
    const ra = S.ranked(a);
    const rb = S.ranked(b);
    const rows = [
      ["World percentile", ra ? ra.pct : null, rb ? rb.pct : null, (v) => `Top ${S.formatPercent(v)}%`, "low"],
      ["Wins vs expected", ra ? ra.ratio : null, rb ? rb.ratio : null, (v) => `${v.toFixed(2)}x`, "high"],
      ["Games", a.games, b.games, (v) => fmtBig(v), "high"],
      ["Win rate", a.winRate, b.winRate, (v) => `${v.toFixed(1)}%`, "high"],
      ["Current streak", a.streak ?? 0, b.streak ?? 0, (v) => String(v), "high"],
      ["Conquests / game", a.games ? (a.conquests ?? 0) / a.games : null, b.games ? (b.conquests ?? 0) / b.games : null, (v) => v.toFixed(1), "high"],
      ["Nukes / game", a.games ? (a.nukes ?? 0) / a.games : null, b.games ? (b.nukes ?? 0) / b.games : null, (v) => v.toFixed(2), "high"],
    ];
    const table = el("table", "ofr-dash-cmp");
    const head = el("tr");
    for (const h of ["", aName, bName]) head.append(el("th", null, h));
    const thead = el("thead");
    thead.append(head);
    table.append(thead);
    const tbody = el("tbody");
    for (const [label, va, vb, fmt, better] of rows) {
      const tr = el("tr");
      tr.append(el("td", "metric", label));
      const ca = el("td", null, va != null ? fmt(va) : "\u2014");
      const cb = el("td", null, vb != null ? fmt(vb) : "\u2014");
      if (va != null && vb != null && va !== vb) {
        const aWins = better === "high" ? va > vb : va < vb;
        (aWins ? ca : cb).classList.add("better");
      }
      tr.append(ca, cb);
      tbody.append(tr);
    }
    // maps both have played enough to rate
    const mapsA = new Map((a.maps ?? []).filter((m) => m.games >= 5).map((m) => [m.map, m]));
    for (const mb of (b.maps ?? []).filter((m) => m.games >= 5)) {
      const ma = mapsA.get(mb.map);
      if (!ma) continue;
      const pa = S.rowRank(ma)?.pct;
      const pb = S.rowRank(mb)?.pct;
      if (pa == null || pb == null) continue;
      const tr = el("tr");
      tr.append(el("td", "metric", `On ${mb.map}`));
      const ca = el("td", null, `Top ${S.formatPercent(pa)}%`);
      const cb = el("td", null, `Top ${S.formatPercent(pb)}%`);
      if (pa !== pb) (pa < pb ? ca : cb).classList.add("better");
      tr.append(ca, cb);
      tbody.append(tr);
    }
    table.append(tbody);
    sec.append(table);

    const shared = new Map((a.recentGames ?? []).map((g) => [g.id, g.won]));
    let met = 0;
    let aWon = 0;
    let bWon = 0;
    for (const g of b.recentGames ?? []) {
      if (!shared.has(g.id)) continue;
      met++;
      if (shared.get(g.id)) aWon++;
      if (g.won) bWon++;
    }
    sec.append(
      el(
        "p",
        "ofr-dash-note",
        met
          ? `Shared ${met} recent game${met === 1 ? "" : "s"}: ${aName} won ${aWon}, ${bName} won ${bWon}.`
          : "No shared games in either player's last 60.",
      ),
    );
    return sec;
  }

  // ---- dashboard shell -------------------------------------------------------

  function shell() {
    document.querySelector(`.${ROOT_CLASS}`)?.remove();
    const root = el("div", ROOT_CLASS);
    const bar = el("div", "ofr-dash-bar");
    bar.append(el("span", "ofr-dash-brand", "OpenFront Pro"));
    bar.append(el("span", "ofr-dash-unofficial", "unofficial"));
    const search = el("input", "ofr-dash-search");
    search.type = "search";
    search.placeholder = "Look up any player…";
    bar.append(search);
    const close = el("button", "ofr-dash-close", "✕");
    close.type = "button";
    bar.append(close);
    const gear = el("button", "ofr-dash-close", "Settings");
    gear.type = "button";
    gear.addEventListener("click", () => globalThis.__ofrOpenSettings?.());
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
    };
    document.addEventListener("keydown", onKey, true);
    close.addEventListener("click", destroy);
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && search.value.trim()) render(body, search.value.trim());
    });
    return { root, body, search };
  }

  let currentOpts = {};

  async function render(body, name) {
    body.replaceChildren(el("p", "ofr-dash-loading", `Loading ${name}…`));
    let info = null;
    try {
      info = await lookup(name);
    } catch (err) {
      body.replaceChildren(el("p", "ofr-dash-empty", `Lookup failed: ${err?.message ?? err}`));
      return;
    }
    if (!info?.found) {
      body.replaceChildren(
        el("p", "ofr-dash-empty", `No public-game history for "${name}" on ofstats.io.`),
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
      sessionSection().then((sec) => placeholder.replaceWith(sec));
    }
    if (currentOpts.clan && currentOpts.clanStats !== false) {
      const placeholder = el("section", "ofr-dash-section");
      body.insertBefore(placeholder, body.children[currentOpts.self ? 3 : 2]);
      clanSection(currentOpts.clan).then((sec) => placeholder.replaceWith(sec));
    }
    if (currentOpts.clanStats !== false) {
      const placeholder = el("section", "ofr-dash-section");
      body.append(placeholder);
      clanLeaderboardSection(currentOpts.clan ?? null).then((sec) => placeholder.replaceWith(sec));
    }
  }

  function open(name, opts = {}) {
    currentOpts = opts;
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

  // ---- share card ------------------------------------------------------------
  // ---- home-page card --------------------------------------------------------
  // Your stats on OpenFront's front page, without opening anything: percentile,
  // games, win rate, streak, the last 20 results and today's session. Re-rendered
  // by content.js on each scan (the page is a Lit component that re-renders);
  // refetches at most once a minute per name.
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
    const key = name ?? "";
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
    setBtn.addEventListener("click", () => globalThis.__ofrOpenSettings?.());
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

    card.append(el("p", "ofr-home-empty", "Loading\u2026"));
    let info = null;
    try {
      info = await lookup(name);
    } catch {
      info = null;
    }
    if (card.dataset.ofrFor !== key) return; // name changed meanwhile
    card.querySelector(".ofr-home-empty")?.remove();
    if (!info?.found) {
      card.append(el("p", "ofr-home-empty", `No public-game history for "${name}" yet.`));
      return;
    }

    const title = el("div", "ofr-home-title");
    title.append(el("span", "ofr-home-name", opts.streamer ? "You" : name));
    const rank = S.ranked(info);
    if (rank) {
      const badge = el("span", "ofr-badge", `Top ${S.formatPercent(rank.pct)}%`);
      badge.dataset.ofrKind = "percentile";
      badge.dataset.ofrBand = S.percentBand(rank.pct);
      title.append(badge);
    }
    card.append(title);

    const grid = el("div", "ofr-home-grid");
    grid.append(
      statTile("Games", fmtBig(info.games)),
      statTile("Win rate", `${info.winRate.toFixed(1)}%`, `${fmtBig(info.wins)} wins`),
      statTile("vs expected", rank ? `${rank.ratio.toFixed(2)}x` : "\u2014"),
      statTile("Streak", String(info.streak ?? 0), "wins in a row"),
    );
    card.append(grid);

    const recent = (info.recentGames ?? []).slice(0, 20);
    if (recent.length) {
      const wins = recent.filter((g) => g.won).length;
      card.append(el("p", "ofr-home-note", `Last ${recent.length}: ${wins} wins (oldest on the left)`));
      card.append(resultsStrip(recent));
    }

    try {
      const stored = (await chrome.storage.local.get("session")).session;
      if (stored && stored.day === new Date().toDateString() && stored.games.length) {
        const w = stored.games.filter((g) => g.won).length;
        card.append(
          el("p", "ofr-home-note", `Today: ${stored.games.length} game${stored.games.length === 1 ? "" : "s"}, ${w} win${w === 1 ? "" : "s"}`),
        );
      }
    } catch {
      // storage unavailable
    }
  }

  globalThis.__ofrHomeWidget = homeWidget;
  globalThis.__ofrOpenDashboard = open;
})();
