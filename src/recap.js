// The post-game recap: what happened in the game you just finished, read from
// OpenFront's own record of it (normalised by background.js) against everyone's
// world percentile.
//
// Three parts, deliberately separate:
//   analyse(record, ctx)  pure: record in, a plain "model" out. No DOM, no
//                         chrome.*, so tools/test-recap.mjs runs it in node over
//                         saved records.
//   createWidget(opts)    the panel: result banner, your numbers with their rank
//                         in the lobby, tabs for graphs / awards / standings.
//   share(model)          the 1200x630 image for Discord, drawn on a canvas.
//
// Rules the record forces on us (all verified against real records):
//   - a player without a stats object never spawned: not a survivor, not counted;
//   - no killedAt means "still had land when the game ended", NOT "won": several
//     players usually do, and they cannot be ordered (unless the record carries
//     finalTiles, newer builds) - so they are shown tied, never invented places;
//   - in a 1v1 the loser normally has no killedAt at all;
//   - a team game only lists the winning team's members; who else was on which
//     team is not recorded, so losers are never assigned a team;
//   - usernames are not unique; two matches for "me" means we cannot tell.
(() => {
  if (globalThis.OFR_RECAP) return;

  const S = globalThis.OFR_SCORING;
  const band = (pct) => (pct == null ? null : S.percentBand(pct));
  const topText = (pct) => `Top ${S.formatPercent(pct)}%`;

  const fmtBig = (n) => {
    if (n == null || !Number.isFinite(n)) return "0";
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
  };
  const mmss = (secs) => {
    const s = Math.max(0, Math.round(secs));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const median = (values) => {
    if (values.length === 0) return 0;
    const v = [...values].sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };

  // What a player can be ranked on inside one lobby. Order = priority when two
  // metrics tie for a chip slot.
  const METRICS = [
    { key: "conq", label: "players conquered", one: "player conquered", get: (s) => s.conquests.humans },
    { key: "troops", label: "troops sent", get: (s) => s.attacksSent },
    { key: "gold", label: "gold earned", get: (s) => s.gold.total },
    { key: "cities", label: "cities captured", one: "city captured", get: (s) => s.citiesCaptured },
    { key: "nukes", label: "nukes landed", one: "nuke landed", get: (s) => s.nukes.landed + s.nukes.mirvLanded },
    { key: "pirate", label: "trade ships captured", one: "trade ship captured", get: (s) => s.tradeCaptured },
    { key: "sam", label: "warheads shot down", one: "warhead shot down", get: (s) => s.intercepted },
    { key: "built", label: "structures built", one: "structure built", get: (s) => s.built },
  ];

  // Lobby awards: the single best player on one number, above a floor so a quiet
  // game does not crown someone for two nukes... or rather, for nothing.
  const AWARDS = [
    { key: "warlord", title: "Warlord", get: (s) => s.attacksSent, min: 100000, text: (v, share) => `${fmtBig(v)} troops sent${share ? ` - ${share}% of the lobby's` : ""}`, share: true },
    { key: "executioner", title: "Executioner", get: (s) => s.conquests.humans, min: 2, text: (v) => `conquered ${plural(v, "player")}` },
    { key: "tycoon", title: "Tycoon", get: (s) => s.gold.total, min: 1e6, text: (v) => `${fmtBig(v)} gold earned` },
    { key: "merchant", title: "Merchant prince", get: (s) => s.gold.trade, min: 1e6, text: (v, _s, p) => `${fmtBig(v)} gold from trade, ${fmtBig(p.stats.tradeDelivered)} ships delivered` },
    { key: "pirate", title: "Pirate king", get: (s) => s.tradeCaptured, min: 5, text: (v, _s, p) => `captured ${plural(v, "trade ship")}, stole ${fmtBig(p.stats.gold.steal)} gold` },
    { key: "rail", title: "Rail baron", get: (s) => s.gold.trainSelf + s.gold.trainOther, min: 1e6, text: (v) => `${fmtBig(v)} gold from trains` },
    { key: "atomic", title: "Atomic enthusiast", get: (s) => s.nukes.landed, min: 2, text: (v) => `${plural(v, "bomb")} landed` },
    { key: "doomsday", title: "Doomsday", get: (s) => s.nukes.mirvLanded, min: 1, text: (v, _s, p) => `${plural(v, "MIRV")}, ${fmtBig(p.stats.nukes.warheads)} warheads landed` },
    { key: "dome", title: "Iron dome", get: (s) => s.intercepted, min: 3, text: (v) => `shot down ${plural(v, "warhead")}` },
    { key: "admiral", title: "Admiral", get: (s) => s.sunk, min: 5, text: (v) => `sank ${plural(v, "ship")}` },
    { key: "snatcher", title: "City snatcher", get: (s) => s.citiesCaptured, min: 5, text: (v) => `captured ${plural(v, "city").replace("citys", "cities")}` },
    { key: "architect", title: "Architect", get: (s) => s.built, min: 10, text: (v) => `built ${plural(v, "structure")}` },
    { key: "turtle", title: "Turtle", get: (s) => s.defPosts, min: 10, text: (v) => `built ${plural(v, "defense post")}` },
    { key: "wanted", title: "Most wanted", get: (s) => s.attacksRecv, min: 100000, text: (v) => `absorbed ${fmtBig(v)} incoming troops` },
    // Not a compliment: shown in the panel, but never put next to someone else's
    // name on the image that gets pasted into a Discord channel.
    { key: "backstab", title: "Backstabber", get: (s) => s.betrayals, min: 1, selfOnlyOnCard: true, text: (v) => `broke ${plural(v, "alliance")}` },
  ];

  // ---- analysis ------------------------------------------------------------------
  function analyse(record, ctx = {}) {
    const everyone = record?.players ?? [];
    const pctOf = ctx.pctOf ?? (() => null);
    // With a kill list, "players conquered" = distinct victims. Without one only
    // conquer EVENTS are known (the same player can be conquered repeatedly), and
    // the wording below says "conquests" instead.
    const exactConquests = record?.hasKills === true;
    const rows = everyone
      .filter((p) => p.active)
      .map((p) => {
        const distinct = new Set((p.kills ?? []).map((k) => k.victim).filter(Boolean)).size;
        const humans = exactConquests && distinct > 0 ? distinct : p.stats.conquests.humans;
        return {
          ...p,
          stats: { ...p.stats, conquests: { ...p.stats.conquests, humans, total: humans + p.stats.conquests.nations + p.stats.conquests.bots } },
          pct: pctOf(p.username.toLowerCase()),
        };
      });
    const N = rows.length;
    const tps = record.turns && record.duration ? record.turns / record.duration : 10;
    const secsAt = (tick) => tick / tps;
    const duration = record.duration ?? (record.turns ? record.turns / tps : null);
    const winner = record.winner ?? { type: null, name: null, ids: [] };
    const isTeam = winner.type === "team" || /team/i.test(record.mode ?? "");
    const is1v1 = !isTeam && (N === 2 || /1v1/i.test(record.mode ?? ""));
    const tag = (p) => `${p.clanTag ? `[${p.clanTag}] ` : ""}${p.username}`;

    const meta = {
      gameId: record.gameId ?? null,
      map: record.map ?? ctx.map ?? null,
      mode: is1v1 ? "1v1" : isTeam ? teamLabel(record.teams) : (record.mode ?? ctx.mode ?? null),
      duration,
      players: N,
      absent: everyone.length - N,
      field: N + (winner.type === "nation" ? 1 : 0), // what places are "of"
      endedAt: record.end ?? (record.start != null && duration != null ? record.start + duration * 1000 : null),
    };
    const model = { state: "ok", meta, isTeam, is1v1 };
    if (N === 0) {
      return {
        ...model,
        state: "nostats",
        message:
          everyone.length === 0
            ? "This game's record lists no players."
            : "This game ended without a result, so OpenFront recorded no stats for it.",
      };
    }

    // -- finishing order -------------------------------------------------------------
    const winners = rows.filter((p) => p.winner);
    const survivors = rows.filter((p) => !p.winner && p.killedAt == null);
    const eliminated = rows.filter((p) => !p.winner && p.killedAt != null).sort((a, b) => b.killedAt - a.killedAt);
    const survivorsOrdered = survivors.length > 0 && survivors.every((p) => p.finalTiles != null);
    if (survivorsOrdered) survivors.sort((a, b) => b.finalTiles - a.finalTiles);
    const ahead = winner.type === "nation" ? 1 : is1v1 || !isTeam ? Math.min(1, winners.length) : 0;
    for (const p of winners) Object.assign(p, { status: "winner", place: isTeam ? null : 1, tied: false });
    survivors.forEach((p, i) => {
      const lost1v1 = is1v1;
      Object.assign(p, {
        status: lost1v1 ? "lost" : "survivor",
        place: isTeam ? null : lost1v1 ? 2 : survivorsOrdered ? ahead + 1 + i : ahead + 1,
        tied: !isTeam && !lost1v1 && !survivorsOrdered && survivors.length > 1,
      });
    });
    for (const p of eliminated) {
      const later = rows.filter((q) => q !== p && (q.killedAt == null || q.killedAt > p.killedAt)).length;
      Object.assign(p, { status: "eliminated", place: isTeam ? null : later + 1 + (winner.type === "nation" ? 1 : 0), tied: false });
    }
    const order = [...winners, ...survivors, ...eliminated];
    // A nation that won sits in first place without being a row.
    const nationExtra = winner.type === "nation" ? 1 : 0;
    const fieldSize = N + nationExtra;
    // Still on the map at the end. Not "winners + survivors": newer records list
    // dead members of the winning team as winners too.
    const standing = rows.filter((p) => p.killedAt == null).length + nationExtra;
    // Exact places can be compared; tied survivors and same-tick deaths cannot.
    const better = (a, b) => a.place != null && b.place != null && a.place < b.place;

    // -- who am I ---------------------------------------------------------------------
    const findMe = (list) => {
      // Ids first: the client id this tab had in THIS game, then the public id
      // learnt from an earlier game. Either is exact; a name is only a guess.
      if (ctx.myClientId) {
        const hit = list.find((p) => p.clientID && p.clientID === ctx.myClientId);
        if (hit) return hit;
      }
      if (ctx.myPublicId) {
        const hits = list.filter((p) => p.publicID && p.publicID === ctx.myPublicId);
        if (hits.length === 1) return hits[0];
      }
      if (!ctx.me) return null;
      const hits = list.filter((p) => p.username.toLowerCase() === ctx.me);
      if (hits.length <= 1) return hits[0] ?? null;
      // Several players with my name: only a KNOWN clan tag can tell them apart.
      // (Unknown is not "no clan" - that would confidently pick the wrong one.)
      if (!ctx.myClan) return null;
      const clan = ctx.myClan.toLowerCase();
      const narrowed = hits.filter((p) => (p.clanTag ?? "").toLowerCase() === clan);
      return narrowed.length === 1 ? narrowed[0] : null;
    };
    const mine = findMe(order);
    const sat = !mine && findMe(everyone.filter((p) => !p.active));
    const meName = ctx.streamer ? "You" : (mine?.username ?? null);
    const nameOf = (p) => (ctx.streamer && (p === mine || (ctx.me && p.username.toLowerCase() === ctx.me)) ? "You" : tag(p));
    const winnerLabel =
      winner.type === "team"
        ? `Team ${winner.name}`.replace(/^Team Team /, "Team ")
        : winner.type === "nation"
          ? `${winner.name} (nation)`
          : winners[0]
            ? nameOf(winners[0])
            : null;

    // -- headline ------------------------------------------------------------------------
    const beforeMe = mine
      ? mine.killedAt != null
        ? eliminated.filter((p) => p.killedAt < mine.killedAt).length
        : eliminated.length
      : 0;
    // "outlasted 0%" is only an insult; say it when there is something to say.
    const outlasted = mine && N > 2 && beforeMe > 0 ? Math.round((100 * beforeMe) / (N - 1)) : null;
    let result;
    if (!mine) {
      result = {
        kind: sat ? "sat" : "spectator",
        tone: "neutral",
        title: winnerLabel ? `${winnerLabel} won` : "No winner",
        of: null,
        kicker: sat
          ? "You were in the lobby but never spawned, so there is nothing of yours to show."
          : `${plural(N, "player")}${duration ? ` - ${mmss(duration)}` : ""}`,
      };
    } else if (mine.winner) {
      result = {
        kind: "win",
        tone: "win",
        title: "Victory",
        of: null,
        kicker: isTeam
          ? `${winnerLabel} won${duration ? ` in ${mmss(duration)}` : ""}`
          : is1v1
            ? `beat ${order.find((p) => p !== mine) ? nameOf(order.find((p) => p !== mine)) : "your opponent"}${duration ? ` in ${mmss(duration)}` : ""}`
            : `first of ${N}${duration ? ` in ${mmss(duration)}` : ""}`,
      };
    } else if (is1v1) {
      result = { kind: "loss", tone: "loss", title: "Defeat", of: null, kicker: winnerLabel ? `${winnerLabel} won${duration ? ` in ${mmss(duration)}` : ""}` : "" };
    } else if (isTeam) {
      // Not on the winners' list. Older records list only members alive at the
      // end, so a dead member of the winning team looks the same as a loser:
      // say who won, and what happened to you, without calling it a defeat.
      result = {
        kind: "team",
        tone: "neutral",
        title: winnerLabel ? `${winnerLabel} won` : "Game over",
        of: null,
        kicker:
          mine.killedAt != null
            ? `you fell at ${mmss(secsAt(mine.killedAt))}${outlasted != null ? ` - outlasted ${outlasted}% of players` : ""}`
            : "you were still standing at the end",
      };
    } else if (mine.killedAt == null) {
      result = {
        kind: "survived",
        tone: "good",
        title: mine.tied ? `Top ${standing}` : `#${mine.place}`,
        of: `of ${fieldSize}`,
        kicker: `alive at the end${winnerLabel ? ` - ${winnerLabel} won` : ""}`,
      };
    } else {
      result = {
        kind: "eliminated",
        tone: N >= 4 && mine.place <= Math.max(3, Math.ceil(N * 0.1)) ? "good" : "neutral",
        title: `#${mine.place}`,
        of: `of ${fieldSize}`,
        kicker: `fell at ${mmss(secsAt(mine.killedAt))}${outlasted != null ? ` - outlasted ${outlasted}% of the lobby` : ""}`,
      };
    }

    // -- my numbers, ranked inside the lobby --------------------------------------------
    // Whose numbers the graphs show when they are not mine: the winner; in a team
    // game the listed winner who did the most (the list can include a team-mate
    // who died in minute two); with no human winner, the most active player.
    const byTroops = (list) => [...list].sort((a, b) => b.stats.attacksSent - a.stats.attacksSent)[0];
    const subject = mine ?? (winners.length ? byTroops(winners) : byTroops(rows));
    const subjectTitle = mine
      ? "You against the lobby"
      : winners.length && !isTeam
        ? "The winner against the lobby"
        : `${nameOf(subject)} against the lobby`;
    const chips = [];
    if (mine) {
      const scored = METRICS.map((m, i) => {
        const value = m.get(mine.stats);
        const rank = 1 + rows.filter((q) => m.get(q.stats) > value).length;
        const label = m.key === "conq" && !exactConquests ? (value === 1 ? "player conquest" : "player conquests") : value === 1 && m.one ? m.one : m.label;
        return { key: m.key, label, value, text: fmtBig(value), rank, of: N, i, ranked: rank <= Math.max(3, Math.ceil(N / 4)) };
      }).filter((c) => c.value > 0);
      scored.sort((a, b) => a.rank - b.rank || a.i - b.i);
      chips.push(...scored.slice(0, 4));
    }

    // -- awards ------------------------------------------------------------------------------
    const awards = [];
    if (N >= 4) {
      for (const def of AWARDS) {
        const sorted = [...rows].sort((a, b) => def.get(b.stats) - def.get(a.stats));
        const best = def.get(sorted[0].stats);
        const second = def.get(sorted[1].stats);
        if (best < def.min || best === second) continue; // nobody, or a tie
        const total = def.share ? rows.reduce((a, q) => a + def.get(q.stats), 0) : 0;
        const share = def.share && total > 0 ? Math.round((100 * best) / total) : null;
        awards.push({
          key: def.key,
          title: def.title,
          who: nameOf(sorted[0]),
          holder: sorted[0],
          mine: sorted[0] === mine,
          text: def.key === "executioner" && !exactConquests ? `${plural(best, "player conquest")}` : def.text(best, share, sorted[0]),
          dominance: second > 0 ? best / second : best,
          selfOnlyOnCard: def.selfOnlyOnCard === true,
        });
      }
      if (eliminated.length > 0 && N >= 8) {
        const last = eliminated[0];
        awards.push({ key: "last", title: "Last to fall", who: nameOf(last), holder: last, mine: last === mine, text: `held out until ${mmss(secsAt(last.killedAt))}`, dominance: 1 });
      }
      // One strong player would otherwise fill the whole list: two awards each,
      // the two they won by the widest margin, and a "clean sweep" line when
      // there were five or more.
      const byHolder = new Map();
      for (const a of awards) byHolder.set(a.holder, [...(byHolder.get(a.holder) ?? []), a]);
      for (const [holder, list] of byHolder) {
        if (list.length <= 2) continue;
        list.sort((a, b) => b.dominance - a.dominance);
        for (const extra of list.slice(2)) awards.splice(awards.indexOf(extra), 1);
        if (list.length >= 5) {
          awards.push({ key: "sweep", title: "Clean sweep", who: nameOf(holder), holder, mine: holder === mine, text: `led the lobby in ${list.length} categories`, dominance: 99 });
        }
      }
      awards.sort((a, b) => Number(b.mine) - Number(a.mine) || b.dominance - a.dominance);
    }

    // -- story lines ---------------------------------------------------------------------------
    const lines = [];
    const rankedRows = rows.filter((p) => p.pct != null);
    const enoughRanked = rankedRows.length >= Math.max(4, Math.ceil(N * 0.4));

    if (mine && mine.killedAt != null) {
      const byId = (id) => rows.find((p) => p.clientID && p.clientID === id);
      let killer = null;
      if (typeof mine.killedBy === "string" && mine.killedBy) killer = byId(mine.killedBy);
      if (!killer && mine.clientID) {
        // A kill list entry only means "conquered me at tick t"; I may have come
        // back afterwards. The one that counts is the conquest that coincides
        // with my elimination (the engine logs it a tick before killedAt).
        let bestGap = Infinity;
        for (const p of rows) {
          if (p === mine) continue;
          for (const k of p.kills ?? []) {
            if (k.victim !== String(mine.clientID) || !Number.isFinite(k.tick)) continue;
            const gap = mine.killedAt - k.tick;
            if (gap >= 0 && gap <= 10 && gap < bestGap) {
              bestGap = gap;
              killer = p;
            }
          }
        }
      }
      if (killer) lines.push({ kind: "killer", text: `Eliminated by ${nameOf(killer)}${killer.pct != null ? ` (${topText(killer.pct)})` : ""}` });
      else if (mine.killedBy === "") lines.push({ kind: "killer", text: "Eliminated by a bot or a nation" });
    }
    let seed = null;
    // (streamer mode hides the viewer's rank, and a seed is a rank)
    if (mine && mine.pct != null && !isTeam && !is1v1 && enoughRanked && !mine.tied && !ctx.streamer) {
      const s = 1 + rankedRows.filter((q) => q.pct < mine.pct).length;
      const f = 1 + rankedRows.filter((q) => q !== mine && better(q, mine)).length;
      seed = { seed: s, finish: f, of: rankedRows.length, delta: s - f };
      lines.push({
        kind: "seed",
        text:
          `Seeded #${s} of ${rankedRows.length} by world rank, finished #${f} among them` +
          (seed.delta > 0 ? ` (+${seed.delta})` : seed.delta < 0 ? ` (${seed.delta})` : ""),
      });
      const beaten = rankedRows.filter((q) => q.pct < mine.pct && better(mine, q));
      if (beaten.length) {
        lines.push({
          kind: "giant",
          text: `Outlasted ${plural(beaten.length, "player")} ranked above you: ${beaten.slice(0, 3).map(nameOf).join(", ")}${beaten.length > 3 ? "..." : ""}`,
        });
      }
    }
    if (mine?.winner && isTeam) {
      const team = winners.filter((p) => p.active);
      const sum = team.reduce((a, p) => a + p.stats.attacksSent, 0);
      // Worth a line when you pulled more than your share of the listed team.
      if (team.length >= 2 && sum > 0 && mine.stats.attacksSent / sum >= Math.max(0.25, 1.5 / team.length)) {
        lines.push({ kind: "carry", text: `You sent ${Math.round((100 * mine.stats.attacksSent) / sum)}% of ${winnerLabel}'s troops (${team.length} listed members)` });
      }
    }
    if (enoughRanked && !isTeam && winners[0]) {
      const favourite = [...rankedRows].sort((a, b) => a.pct - b.pct)[0];
      const w = winners[0];
      const typicalPct = median(rankedRows.map((p) => p.pct));
      // my own rank stays out of it in streamer mode
      const rankNote = (p) => (p === mine && ctx.streamer ? "" : ` (${topText(p.pct)})`);
      if (favourite === w && N > 2) lines.push({ kind: "favourite", text: `The favourite delivered: ${nameOf(w)}${rankNote(w)}` });
      else if (w.pct != null && w.pct > 50 && w.pct > typicalPct) lines.push({ kind: "upset", text: `Upset: ${nameOf(w)}${rankNote(w)} won it` });
      else if (favourite && favourite !== mine) {
        lines.push({ kind: "paper", text: `Strongest on paper: ${nameOf(favourite)} (${topText(favourite.pct)}) finished ${placeText(favourite, standing)}` });
      }
    }
    if (rankedRows.length >= Math.max(5, Math.ceil(N * 0.3))) {
      const typical = median(rankedRows.map((p) => p.pct));
      const label = typical <= 30 ? "strong" : typical <= 55 ? "typical" : "soft";
      lines.push({ kind: "lobby", text: `Lobby: ${label} - median ${topText(typical)}, ${rankedRows.length} of ${N} ranked` });
    }
    const myClan = (mine?.clanTag ?? "").toUpperCase();
    if (mine && myClan && !ctx.streamer) {
      const mates = order.filter((p) => p !== mine && (p.clanTag ?? "").toUpperCase() === myClan);
      if (mates.length) {
        lines.push({
          kind: "clan",
          text: `[${myClan}] x${mates.length + 1} in this game: ${mates.slice(0, 3).map((p) => `${p.username} ${p.winner ? "won" : placeText(p, standing)}`).join(", ")}${mates.length > 3 ? "..." : ""}`,
        });
      }
    }

    // -- graphs --------------------------------------------------------------------------------
    const deaths = rows.filter((p) => p.killedAt != null).sort((a, b) => a.killedAt - b.killedAt);
    let alive = N;
    const curve = [{ x: 0, y: N }];
    for (const p of deaths) curve.push({ x: secsAt(p.killedAt), y: --alive });
    const end = duration ?? (deaths.length ? secsAt(deaths[deaths.length - 1].killedAt) : 0);
    curve.push({ x: end, y: alive });
    const survival = {
      show: !is1v1 && deaths.length >= 4 && end > 0,
      points: curve,
      end,
      players: N,
      me: mine ? { x: mine.killedAt != null ? secsAt(mine.killedAt) : end, y: mine.killedAt != null ? curve.find((c) => c.x === secsAt(mine.killedAt))?.y ?? alive : alive, alive: mine.killedAt == null } : null,
    };

    // you vs the reference player vs the lobby's median
    let ref = null;
    let refLabel = null;
    if (is1v1) {
      ref = order.find((p) => p !== subject) ?? null;
      refLabel = ref ? nameOf(ref) : null;
    } else if (mine && !mine.winner && winners.length) {
      ref = isTeam ? [...winners].sort((a, b) => b.stats.attacksSent - a.stats.attacksSent)[0] : winners[0];
      refLabel = isTeam ? `${nameOf(ref)} (their top player)` : `${nameOf(ref)} (winner)`;
    }
    // When you won there is no single rival to name (survivors are tied), so the
    // middle bar is the best anyone else managed on each number.
    const bestOfRest = mine?.winner && !is1v1 && N > 2;
    if (bestOfRest) refLabel = "best of the rest";
    const compareMetrics = [METRICS[2], METRICS[1], { key: "conqAll", label: "conquests", get: (s) => s.conquests.total }, METRICS[7]];
    const compare = {
      title: subjectTitle,
      legend: [
        { kind: "me", label: mine ? (ctx.streamer ? "You" : "you") : nameOf(subject) },
        ...(ref || bestOfRest ? [{ kind: "winner", label: refLabel }] : []),
        { kind: "lobby", label: "lobby median" },
      ],
      rows: compareMetrics
        .map((m) => {
          const v = m.get(subject.stats);
          const med = median(rows.map((q) => m.get(q.stats)));
          const rank = 1 + rows.filter((q) => m.get(q.stats) > v).length;
          return {
            label: m.label,
            note: `#${rank} of ${N}`,
            bars: [
              { kind: "me", value: v, text: fmtBig(v) },
              ...(ref || bestOfRest
                ? [(() => {
                    const rv = ref ? m.get(ref.stats) : Math.max(0, ...rows.filter((q) => q !== subject).map((q) => m.get(q.stats)));
                    return { kind: "winner", value: rv, text: fmtBig(rv) };
                  })()]
                : []),
              { kind: "lobby", value: med, text: fmtBig(med) },
            ],
          };
        })
        .filter((r) => r.bars.some((b) => b.value > 0)),
    };

    const g = subject.stats.gold;
    const gold = {
      who: mine ? "Your" : `${nameOf(subject)}'s`,
      total: g.total,
      parts: [
        { label: "workers", value: g.work, slot: 1 },
        { label: "conquest", value: g.war, slot: 2 },
        { label: "trade", value: g.trade, slot: 3 },
        { label: "trains", value: g.trainSelf + g.trainOther, slot: 4 },
        { label: "piracy", value: g.steal, slot: 6 },
      ].map((p) => ({ ...p, text: fmtBig(p.value) })),
    };

    const counts = { elite: 0, strong: 0, good: 0, average: 0, low: 0, unranked: 0 };
    for (const p of rows) counts[band(p.pct) ?? "unranked"]++;
    const field = {
      counts,
      mine: mine ? (band(mine.pct) ?? "unranked") : null,
      ranked: rankedRows.length,
      typical: rankedRows.length ? median(rankedRows.map((p) => p.pct)) : null,
    };

    // -- standings -----------------------------------------------------------------------------------
    const standings = order.map((p) => ({
      place: p.winner ? (isTeam ? "W" : "1") : p.place == null ? "" : `${p.tied ? "=" : ""}${p.place}`,
      name: nameOf(p),
      pct: p === mine && ctx.streamer ? null : p.pct,
      band: p === mine && ctx.streamer ? null : band(p.pct),
      time: p.killedAt != null ? mmss(secsAt(p.killedAt)) : p.status === "lost" ? "lost" : "alive",
      conquests: p.stats.conquests.humans,
      gold: fmtBig(p.stats.gold.total),
      me: p === mine,
      winner: p.winner,
    }));

    return {
      ...model,
      result,
      streamer: ctx.streamer === true,
      // how "me" was found, and the stable id to remember for next time
      matchedBy: mine ? (ctx.myClientId && mine.clientID === ctx.myClientId ? "clientId" : ctx.myPublicId && mine.publicID === ctx.myPublicId ? "publicId" : "name") : null,
      myPublicId: mine?.publicID ?? null,
      me: mine ? { name: meName, pct: ctx.streamer ? null : mine.pct, band: ctx.streamer ? null : band(mine.pct), place: mine.place, tied: mine.tied, won: mine.winner, alive: mine.killedAt == null } : null,
      winnerLabel,
      chips,
      awards,
      lines,
      seed,
      charts: { survival, compare, gold, field },
      standings,
    };
  }

  function teamLabel(teams) {
    if (teams == null) return "Team";
    return typeof teams === "number" || /^\d+$/.test(String(teams)) ? `${teams} teams` : String(teams);
  }
  function placeText(p, standing) {
    if (p.winner) return "won";
    if (p.place == null) return p.killedAt == null ? "alive at the end" : "eliminated";
    return p.tied ? `in the top ${standing}` : `#${p.place}`;
  }

  // Plain text, for "Copy text" and the session log.
  function textLines(model, progress = []) {
    if (model.state !== "ok") return [model.message];
    const out = [];
    const m = model.meta;
    out.push(["OpenFront", m.map, m.mode, m.duration ? mmss(m.duration) : null].filter(Boolean).join(" - "));
    out.push(`${model.result.title}${model.result.of ? ` ${model.result.of}` : ""} - ${model.result.kicker}`);
    if (model.me?.pct != null) out.push(`${model.me.name}: ${topText(model.me.pct)}`);
    for (const c of model.chips) out.push(`${c.text} ${c.label}${c.ranked ? ` (#${c.rank} of ${c.of})` : ""}`);
    for (const l of model.lines) out.push(l.text);
    for (const a of model.awards.slice(0, 5)) out.push(`${a.title}: ${a.who} - ${a.text}`);
    out.push(...progress);
    return out;
  }

  // ---- widget ---------------------------------------------------------------------------
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const badge = (pct) => {
    const b = el("span", "ofr-badge", pct == null ? "unranked" : topText(pct));
    b.dataset.ofrKind = pct == null ? "missing" : "percentile";
    if (pct != null) b.dataset.ofrBand = band(pct);
    return b;
  };

  function createWidget({ icon = () => "", onDashboard = null, onClose = null, onToggle = null, avoidRect = null, startMin = false, gameId = null, streamer = false } = {}) {
    const C = globalThis.OFR_CHARTS;
    const root = el("div", "ofr-recap");
    let model = null;
    let progress = [];
    let tab = "summary";
    let userToggled = false;

    const head = el("div", "ofr-recap-head");
    const title = el("span", "ofr-recap-title", "Game recap");
    const metaLine = el("span", "ofr-recap-meta");
    const min = el("button", null, "–");
    min.type = "button";
    min.title = "Minimise";
    const close = el("button", null, "✕");
    close.type = "button";
    close.title = "Close";
    const headText = el("div", "ofr-recap-headtext");
    headText.append(title, metaLine);
    head.append(headText, min, close);

    const hero = el("div", "ofr-recap-hero");
    const tabs = el("div", "ofr-recap-tabs");
    const body = el("div", "ofr-recap-body");
    const foot = el("div", "ofr-recap-foot");
    const actions = el("div", "ofr-recap-actions");
    root.append(head, hero, tabs, body, foot, actions);

    const setMin = (on, byUser = false) => {
      root.dataset.min = on ? "true" : "false";
      if (byUser) {
        userToggled = true;
        try {
          onToggle?.(on);
        } catch {
          // the extension was reloaded under us; folding still has to work
        }
      }
      // Folded, the title bar is all there is: let it carry the headline.
      const r = model?.state === "ok" ? model.result : null;
      title.textContent = on && r ? `${r.title}${r.of ? ` ${r.of}` : ""} · Recap` : "Game recap";
      min.textContent = on ? "▴" : "–";
      min.title = on ? "Expand" : "Minimise";
    };
    min.addEventListener("click", (e) => {
      e.stopPropagation();
      setMin(root.dataset.min !== "true", true);
    });
    head.addEventListener("click", () => {
      if (root.dataset.min === "true") setMin(false, true);
    });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      destroy();
      onClose?.();
    });

    // Never sit on top of the game's own end-of-game dialog: if we would, fold
    // down to the title bar (unless the user has opened us on purpose).
    const avoid = () => {
      if (userToggled || !avoidRect || root.dataset.min === "true") return;
      const other = avoidRect();
      if (!other) return;
      const r = root.getBoundingClientRect();
      const overlap = r.left < other.right && r.right > other.left && r.top < other.bottom && r.bottom > other.top;
      if (overlap) setMin(true);
    };
    const onResize = () => avoid();
    window.addEventListener("resize", onResize);

    function destroy() {
      lapsePlayer?.stop();
      unsubscribeLapse?.();
      window.removeEventListener("resize", onResize);
      root.remove();
    }

    const button = (label, tip, handler) => {
      const b = el("button", null, label);
      b.type = "button";
      if (tip) b.title = tip;
      b.addEventListener("click", () => handler(b));
      return b;
    };
    const flash = (b, text, restore, ms = 2500) => {
      b.textContent = text;
      setTimeout(() => (b.textContent = restore), ms);
    };

    function renderHero() {
      hero.replaceChildren();
      if (!model || model.state !== "ok") return;
      const r = model.result;
      root.dataset.tone = r.tone;
      const top = el("div", "ofr-recap-result");
      const big = el("span", "ofr-recap-big", r.kind === "win" ? `${icon("trophy")} ${r.title}`.trim() : r.title);
      top.append(big);
      if (r.of) top.append(el("span", "ofr-recap-of", r.of));
      if (model.me) {
        const who = el("span", "ofr-recap-who");
        who.append(el("span", "ofr-recap-name", model.me.name));
        if (!model.streamer) who.append(badge(model.me.pct));
        top.append(who);
      }
      hero.append(top, el("div", "ofr-recap-kicker", r.kicker));
    }

    function summaryPane() {
      const pane = el("div", "ofr-recap-pane");
      if (model.chips.length) {
        const grid = el("div", "ofr-recap-chips");
        for (const c of model.chips) {
          const chip = el("div", "ofr-recap-chip");
          if (c.rank <= 3) chip.dataset.top = "true";
          chip.append(el("span", "ofr-recap-chip-value", c.text), el("span", "ofr-recap-chip-label", c.label));
          if (c.ranked) chip.append(el("span", "ofr-recap-chip-rank", `#${c.rank} of ${c.of}`));
          grid.append(chip);
        }
        pane.append(grid);
      }
      if (model.charts.survival.show && C) pane.append(survivalChart(118));
      else if (model.is1v1 && C && model.charts.compare.rows.length) {
        const box = el("div", "ofr-recap-chart");
        box.append(el("h4", null, "Tale of the tape"), C.compare(model.charts.compare));
        pane.append(box);
      }
      if (model.lines.length) {
        const list = el("ul", "ofr-recap-lines");
        for (const l of model.lines) list.append(el("li", null, l.text));
        pane.append(list);
      }
      const top = model.awards.slice(0, 3);
      if (top.length) {
        pane.append(el("h4", null, "Awards"));
        pane.append(awardList(top));
        if (model.awards.length > top.length) {
          const more = button(`All ${model.awards.length} awards`, null, () => show("awards"));
          more.className = "ofr-recap-more";
          pane.append(more);
        }
      }
      if (!pane.childElementCount) pane.append(el("p", "ofr-recap-note", "Nothing else was recorded for this game."));
      return pane;
    }

    function survivalChart(height) {
      const s = model.charts.survival;
      const box = el("div", "ofr-recap-chart");
      box.append(el("h4", null, "Players alive"));
      const markers = [];
      if (s.me) markers.push({ x: s.me.x, y: s.me.y, kind: "me", label: s.me.alive ? "you, alive" : `you ${mmss(s.me.x)}` });
      const quarter = s.end / 4;
      box.append(
        C.line({
          series: [{ points: s.points, step: true, area: true }],
          width: 340,
          height,
          xMin: 0,
          xMax: s.end,
          yMax: s.players,
          yTicks: [0, Math.round(s.players / 2), s.players],
          xTicks: [0, quarter * 2, s.end],
          xFormat: (x) => mmss(x),
          yFormat: (y) => String(Math.round(y)),
          markers,
          label: "Players alive over the course of the game",
        }),
      );
      return box;
    }

    function graphsPane() {
      const pane = el("div", "ofr-recap-pane");
      if (!C) {
        pane.append(el("p", "ofr-recap-note", "Charts are unavailable."));
        return pane;
      }
      const ch = model.charts;
      if (ch.compare.rows.length) {
        const box = el("div", "ofr-recap-chart");
        box.append(el("h4", null, ch.compare.title));
        box.append(C.compare(ch.compare));
        pane.append(box);
      }
      if (ch.gold.total > 0) {
        const box = el("div", "ofr-recap-chart");
        box.append(el("h4", null, `${ch.gold.who} gold: ${fmtBig(ch.gold.total)}`));
        box.append(C.stacked({ parts: ch.gold.parts }));
        pane.append(box);
      }
      const box = el("div", "ofr-recap-chart");
      box.append(el("h4", null, "Lobby strength"));
      box.append(
        C.bands({
          counts: ch.field.counts,
          mine: ch.field.mine,
          labels: { elite: "top 5%", strong: "top 15%", good: "top 35%", average: "top 60%", low: "rest", unranked: "no rank" },
        }),
      );
      box.append(
        el(
          "p",
          "ofr-recap-note",
          ch.field.typical != null
            ? `${ch.field.ranked} of ${model.meta.players} players have a world rank; the typical one is ${topText(ch.field.typical)}.`
            : "Nobody in this lobby has a world rank yet.",
        ),
      );
      pane.append(box);
      return pane;
    }

    function awardList(list) {
      const ul = el("ul", "ofr-recap-awards");
      for (const a of list) {
        const li = el("li");
        if (a.mine) li.dataset.mine = "true";
        li.append(el("span", "ofr-recap-award-title", a.title), el("span", "ofr-recap-award-who", a.who), el("span", "ofr-recap-award-text", a.text));
        ul.append(li);
      }
      return ul;
    }

    function awardsPane() {
      const pane = el("div", "ofr-recap-pane");
      if (model.awards.length) pane.append(awardList(model.awards));
      else pane.append(el("p", "ofr-recap-note", model.meta.players < 4 ? "Awards need at least four players." : "Nobody stood out enough for an award this game."));
      return pane;
    }

    function standingsPane() {
      const pane = el("div", "ofr-recap-pane");
      const table = el("table", "ofr-recap-table");
      const headRow = el("tr");
      for (const h of ["#", "Player", model.is1v1 ? "" : "Out", "Conq.", "Gold"]) headRow.append(el("th", null, h));
      table.append(headRow);
      for (const row of model.standings) {
        const tr = el("tr");
        if (row.me) tr.dataset.me = "true";
        if (row.winner) tr.dataset.winner = "true";
        const name = el("td", "ofr-recap-cell-name");
        name.append(el("span", null, row.name));
        if (row.pct != null) name.append(badge(row.pct));
        tr.append(el("td", null, row.place), name, el("td", null, row.time), el("td", null, String(row.conquests)), el("td", null, row.gold));
        table.append(tr);
      }
      pane.append(table);
      const notes = [];
      if (model.standings.some((r) => r.place.startsWith("="))) notes.push("= : still alive at the end; the record does not say who held more land.");
      if (model.isTeam) notes.push("W: on the winning team's list. Other players' teams are not in the record.");
      if (model.meta.absent) notes.push(`${plural(model.meta.absent, "player")} joined but never spawned and are left out.`);
      for (const n of notes) pane.append(el("p", "ofr-recap-note", n));
      return pane;
    }

    // The whole-map timelapse recorded by timelapse.js, if there is one for this game.
    // It does not need the game's published record: while the record is awaited (or
    // never comes - single-player games are not archived) it is offered next to the
    // status message. An export in progress survives the pane being rebuilt.
    let lapsePlayer = null;
    let lapseJob = null; // { status } while an export runs
    let lapseStatus = "";
    let streamerNow = streamer === true;
    let lapseStreamerShown = null; // what the running preview was started with
    const lapseId = () => model?.meta?.gameId ?? gameId;
    const lapseStreamer = () => streamerNow || model?.streamer === true;
    function lapsePane() {
      const L = globalThis.OFR_LAPSE;
      const pane = el("div", "ofr-recap-pane");
      lapsePlayer?.stop();
      lapseStreamerShown = lapseStreamer();
      lapsePlayer = L.player({ streamer: lapseStreamerShown, gameId: lapseId() });
      pane.append(lapsePlayer.canvas);
      pane.append(el("p", "ofr-recap-note", `${L.count(lapseId())} frames over ${mmss(L.seconds())} of play. Made in your browser; nothing is uploaded.`));
      const row = el("div", "ofr-recap-actions ofr-lapse-actions");
      const status = el("p", "ofr-recap-note", lapseStatus);
      row.dataset.busy = String(!!lapseJob);
      const say = (text) => {
        lapseStatus = text;
        if (status.isConnected) status.textContent = text;
        for (const other of body.querySelectorAll(".ofr-lapse-status")) other.textContent = text; // a rebuilt pane
      };
      status.classList.add("ofr-lapse-status");
      const run = (label, ext, make) =>
        button(label, null, async () => {
          if (lapseJob) return;
          lapseJob = { label };
          for (const r of body.querySelectorAll(".ofr-lapse-actions")) r.dataset.busy = "true";
          const id = lapseId();
          try {
            const blob = await make((f) => say(`${label}: ${Math.round(100 * f)}%`));
            L.save(blob, `openfront-${id ?? "game"}.${ext}`);
            say(`Saved ${(blob.size / 1048576).toFixed(1)} MB ${ext.toUpperCase()}.`);
          } catch (err) {
            say(`Failed: ${err?.message ?? err}`);
          }
          lapseJob = null;
          for (const r of body.querySelectorAll(".ofr-lapse-actions")) r.dataset.busy = "false";
        });
      row.append(
        run("Save video", "webm", (onProgress) => L.toWebM({ gameId: lapseId(), onProgress, streamer: lapseStreamer(), endCard: model?.state === "ok" ? drawCard(model, { icon, progress }) : null })),
        run("Save GIF", "gif", (onProgress) => L.toGif({ gameId: lapseId(), onProgress, streamer: lapseStreamer() })),
      );
      pane.append(row, status, el("p", "ofr-recap-note", "Video plays inline on Discord and is small; the GIF is several times bigger. The video is recorded in real time (it pauses while this tab is hidden), so it takes as long as it plays."));
      return pane;
    }
    const hasLapse = () => (globalThis.OFR_LAPSE?.count(lapseId()) ?? 0) >= 5;
    // While only a message is shown, the Timelapse tab appears once there is something to show.
    let unsubscribeLapse = globalThis.OFR_LAPSE?.onFrame?.(() => {
      if (!model && message && hasLapse() && !tabs.childElementCount) setMessage(message.text, message.opts);
    });
    let message = null;
    function statusPane() {
      const pane = el("div", "ofr-recap-pane");
      pane.append(el("p", "ofr-recap-note ofr-recap-wait", message?.text ?? ""));
      if (message?.opts?.retry) {
        const again = button("Try again", null, () => message.opts.retry());
        again.className = "ofr-recap-more";
        pane.append(again);
      }
      return pane;
    }

    const PANES = { summary: ["Summary", summaryPane], graphs: ["Graphs", graphsPane], awards: ["Awards", awardsPane], standings: ["Standings", standingsPane], lapse: ["Timelapse", lapsePane], status: ["Status", statusPane] };

    function show(next) {
      tab = next;
      if (tab !== "lapse") lapsePlayer?.stop();
      for (const b of tabs.children) b.dataset.on = String(b.dataset.tab === tab);
      body.replaceChildren(PANES[tab][1]());
      body.scrollTop = 0;
      const mineRow = tab === "standings" ? body.querySelector('tr[data-me="true"]') : null;
      if (mineRow) body.scrollTop = Math.max(0, mineRow.offsetTop - body.clientHeight / 2);
    }

    function renderFoot() {
      foot.replaceChildren(...progress.map((line) => el("div", null, line)));
    }

    function renderActions() {
      actions.replaceChildren();
      if (!model || model.state !== "ok") return;
      const shareBtn = button("Share image", "Copy a 1200x630 result card to the clipboard, ready to paste into Discord", async (b) => {
        b.textContent = "Rendering...";
        try {
          const r = await share(model, { icon, progress });
          flash(b, r.how === "clipboard" ? "Copied - paste in Discord" : "Saved as PNG", "Share image", 3000);
        } catch (err) {
          flash(b, `Failed: ${err?.message ?? err}`, "Share image", 3000);
        }
      });
      const copyBtn = button("Copy text", null, async (b) => {
        try {
          await navigator.clipboard.writeText(textLines(model, progress).join("\n"));
          flash(b, "Copied", "Copy text", 1500);
        } catch {
          flash(b, "Copy failed", "Copy text", 1500);
        }
      });
      actions.append(shareBtn, copyBtn);
      if (onDashboard) actions.append(button("My stats", "Open your Pro dashboard", () => onDashboard()));
    }

    function setMessage(text, opts = {}) {
      const tabKeys = [...tabs.children].map((b) => b.dataset.tab).join(",");
      const same = !model && message && tabKeys === "status,lapse" && hasLapse();
      message = { text, opts };
      model = null;
      root.dataset.tone = "neutral";
      hero.replaceChildren();
      actions.replaceChildren();
      foot.replaceChildren();
      metaLine.textContent = opts.meta ?? "";
      if (!hasLapse()) {
        tabs.replaceChildren();
        lapsePlayer?.stop();
        body.replaceChildren(statusPane());
        return;
      }
      // A timelapse is there: the message becomes one tab, the timelapse the other.
      if (same && (tab === "lapse" || tab === "status")) {
        if (tab === "status") body.replaceChildren(statusPane());
        return; // do not restart the player (or lose an export) on every poll
      }
      tabs.replaceChildren(
        ...["status", "lapse"].map((key) => {
          const b = button(PANES[key][0], null, () => show(key));
          b.dataset.tab = key;
          return b;
        }),
      );
      show(tab === "lapse" ? "lapse" : "status");
    }

    function setModel(next) {
      if (next.state !== "ok") {
        model = null;
        setMessage(next.message);
        return;
      }
      model = next;
      message = null;
      const m = model.meta;
      metaLine.textContent = [m.map, m.mode, m.duration ? mmss(m.duration) : null].filter(Boolean).join(" · ");
      renderHero();
      tabs.replaceChildren(
        ...Object.entries(PANES).filter(([key]) => key !== "status" && (key !== "lapse" || hasLapse())).map(([key, [label]]) => {
          const b = button(key === "awards" && model.awards.length ? `${label} ${model.awards.length}` : label, null, () => show(key));
          b.dataset.tab = key;
          return b;
        }),
      );
      if (tab === "lapse" && hasLapse() && body.querySelector(".ofr-lapse-canvas")?.isConnected && lapseStreamerShown === lapseStreamer()) {
        // keep the running preview (and any export) when the recap refreshes around it
        for (const b of tabs.children) b.dataset.on = String(b.dataset.tab === tab);
      } else show(PANES[tab] && tab !== "status" && (tab !== "lapse" || hasLapse()) ? tab : "summary");
      renderFoot();
      renderActions();
      setMin(root.dataset.min === "true"); // refresh the folded headline
      requestAnimationFrame(avoid);
    }

    function setProgress(lines) {
      progress = lines;
      renderFoot();
    }

    // The icon set follows the theme, and the theme can change while we are open.
    function refresh() {
      if (model?.state === "ok") setModel(model);
    }

    setMin(startMin || window.innerWidth < 720);
    function setStreamer(on) {
      streamerNow = on === true;
      if (tab === "lapse" && lapseStreamerShown !== lapseStreamer() && body.querySelector(".ofr-lapse-canvas")) show("lapse");
    }

    return { el: root, setMessage, setModel, setProgress, refresh, destroy, avoid, setStreamer, get model() { return model; }, lines: () => (model ? textLines(model, progress) : []) };
  }

  // ---- share image ---------------------------------------------------------------------------
  function drawCard(model, { icon = () => "", progress = [] } = {}) {
    const W = 1200;
    const H = 630;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const col = {
      bg: token("--ofr-stage-bg", "#0b0d12"),
      soft: token("--ofr-panel-soft", "rgba(255,255,255,0.05)"),
      line: token("--ofr-panel-border", "rgba(255,255,255,0.12)"),
      text: token("--ofr-text", "#e5e7eb"),
      dim: token("--ofr-text-dim", "#9ca3af"),
      accent: token("--ofr-accent", "#fcd34d"),
      good: token("--ofr-good", "#a3e635"),
      average: token("--ofr-average", "#7dd3fc"),
      elite: token("--ofr-elite", "#fb7185"),
      strong: token("--ofr-strong", "#fbbf24"),
      low: token("--ofr-low", "#9ca3af"),
    };
    const font = token("--ofr-ui-font", "system-ui, sans-serif");
    const setFont = (weight, size) => (ctx.font = `${weight} ${size}px ${font}`);
    const fit = (text, max) => {
      let t = String(text);
      if (ctx.measureText(t).width <= max) return t;
      while (t.length > 1 && ctx.measureText(`${t}...`).width > max) t = t.slice(0, -1);
      return `${t}...`;
    };
    const round = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, W, H);
    const wash = ctx.createLinearGradient(0, 0, W, H);
    ctx.globalAlpha = 0.07;
    wash.addColorStop(0, col.text);
    wash.addColorStop(1, col.bg);
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    const toneColor = { win: col.accent, good: col.good, loss: col.elite, neutral: col.average }[model.result.tone] ?? col.average;
    ctx.fillStyle = toneColor;
    ctx.fillRect(0, 0, 10, H);

    // top strip
    const m = model.meta;
    setFont(600, 24);
    ctx.fillStyle = col.dim;
    ctx.textAlign = "left";
    ctx.fillText(fit(["OPENFRONT", m.map, m.mode].filter(Boolean).join(" · ").toUpperCase(), 700), 60, 76);
    ctx.textAlign = "right";
    ctx.fillText([m.duration ? mmss(m.duration) : null, plural(m.players, "player")].filter(Boolean).join(" · "), W - 60, 76);
    ctx.textAlign = "left";

    // result
    const r = model.result;
    const big = r.kind === "win" ? `${icon("trophy")} ${r.title}`.trim() : r.title;
    setFont(800, r.title.length > 12 ? 72 : 116);
    ctx.fillStyle = r.tone === "win" ? col.accent : col.text;
    const bigText = fit(big, 640);
    ctx.fillText(bigText, 60, 210);
    if (r.of) {
      const w = ctx.measureText(bigText).width;
      setFont(600, 44);
      ctx.fillStyle = col.dim;
      ctx.fillText(r.of, 60 + w + 22, 210);
    }
    let y = 276;
    if (model.me) {
      setFont(700, 42);
      ctx.fillStyle = col.text;
      const name = fit(model.me.name, 420);
      ctx.fillText(name, 60, y);
      if (model.me.pct != null) {
        const w = ctx.measureText(name).width;
        setFont(800, 42);
        ctx.fillStyle = col[model.me.band] ?? col.low;
        ctx.fillText(topText(model.me.pct), 60 + w + 24, y);
      }
      y += 48;
    }
    setFont(500, 28);
    ctx.fillStyle = col.dim;
    ctx.fillText(fit(r.kicker, 640), 60, y);

    // chips
    const chips = model.chips.slice(0, 3);
    const chipW = 204;
    chips.forEach((c, i) => {
      const x = 60 + i * (chipW + 16);
      const top = 388;
      ctx.fillStyle = col.soft;
      round(x, top, chipW, 136, 14);
      ctx.fill();
      ctx.strokeStyle = c.rank <= 3 ? col.accent : col.line;
      ctx.lineWidth = 2;
      ctx.stroke();
      setFont(800, 46);
      ctx.fillStyle = col.text;
      ctx.fillText(fit(c.text, chipW - 32), x + 16, top + 56);
      setFont(500, 20);
      ctx.fillStyle = col.dim;
      ctx.fillText(fit(c.label, chipW - 32), x + 16, top + 86);
      if (c.ranked) {
        setFont(700, 20);
        ctx.fillStyle = c.rank <= 3 ? col.accent : col.dim;
        ctx.fillText(`#${c.rank} of ${c.of}`, x + 16, top + 116);
      }
    });

    // right column: survival curve, then awards / story
    const rx = 760;
    const rw = W - 60 - rx;
    let ry = 120;
    const s = model.charts.survival;
    if (s.show) {
      setFont(600, 20);
      ctx.fillStyle = col.dim;
      ctx.fillText("PLAYERS ALIVE", rx, ry);
      const gx = rx;
      const gy = ry + 16;
      const gw = rw;
      const gh = 170;
      const sx = (x) => gx + (gw * x) / (s.end || 1);
      const sy = (v) => gy + gh - (gh * v) / (s.players || 1);
      ctx.beginPath();
      s.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(sx(p.x), sy(p.y));
        else {
          ctx.lineTo(sx(p.x), sy(s.points[i - 1].y));
          ctx.lineTo(sx(p.x), sy(p.y));
        }
      });
      ctx.strokeStyle = col.average;
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.lineTo(sx(s.end), sy(0));
      ctx.lineTo(sx(0), sy(0));
      ctx.closePath();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = col.average;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, sy(0));
      ctx.lineTo(gx + gw, sy(0));
      ctx.stroke();
      if (s.me) {
        ctx.fillStyle = col.accent;
        ctx.beginPath();
        ctx.arc(sx(s.me.x), sy(s.me.y), 8, 0, Math.PI * 2);
        ctx.fill();
        setFont(700, 18);
        const right = s.me.x > s.end / 2;
        ctx.textAlign = right ? "right" : "left";
        ctx.fillText(s.me.alive ? "alive at the end" : `out ${mmss(s.me.x)}`, sx(s.me.x) + (right ? -14 : 14), sy(s.me.y) - 12);
        ctx.textAlign = "left";
      }
      setFont(500, 16);
      ctx.fillStyle = col.dim;
      ctx.fillText("0:00", gx, gy + gh + 22);
      ctx.textAlign = "right";
      ctx.fillText(mmss(s.end), gx + gw, gy + gh + 22);
      ctx.textAlign = "left";
      ry = gy + gh + 62;
    }
    const notes = [
      ...model.awards.filter((a) => a.mine || !a.selfOnlyOnCard).slice(0, s.show ? 3 : 5).map((a) => ({ head: a.title.toUpperCase(), body: `${a.who} - ${a.text}`, mine: a.mine })),
      ...model.lines.filter((l) => ["seed", "giant", "carry", "upset"].includes(l.kind)).map((l) => ({ head: null, body: l.text, mine: false })),
      ...progress.slice(0, 1).map((p) => ({ head: null, body: p, mine: false })),
    ];
    for (const n of notes) {
      if (ry > H - 110) break;
      if (n.head) {
        setFont(700, 17);
        ctx.fillStyle = n.mine ? col.accent : col.dim;
        ctx.fillText(n.head, rx, ry);
        ry += 26;
      }
      setFont(500, 22);
      ctx.fillStyle = col.text;
      ctx.fillText(fit(n.body, rw), rx, ry);
      ry += n.head ? 38 : 34;
    }

    // footer
    setFont(700, 24);
    ctx.fillStyle = col.accent;
    ctx.fillText("OpenFront Pro", 60, H - 46);
    const bw = ctx.measureText("OpenFront Pro").width;
    setFont(500, 20);
    ctx.fillStyle = col.dim;
    ctx.fillText("unofficial · stats by ofstats.io", 60 + bw + 18, H - 46);
    return canvas;
  }

  async function share(model, opts) {
    const canvas = drawCard(model, opts);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return { ok: true, how: "clipboard" };
    } catch {
      // Clipboard images need a user gesture and a secure context; fall back to
      // a download so the card is never lost.
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `openfront-recap-${model.meta.gameId ?? "game"}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return { ok: true, how: "download" };
    }
  }

  globalThis.OFR_RECAP = { analyse, textLines, createWidget, drawCard, share, METRICS, AWARDS };
})();
