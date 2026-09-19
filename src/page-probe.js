// Runs in the PAGE world (chrome.scripting with world: "MAIN"), which the
// content script cannot reach: element properties set by Lit and the page's
// own globals live here.
//
// Only available from this side:
//   - window.BOOTSTRAP_CONFIG.assetManifest maps "maps/africa/thumbnail.webp"
//     to its content-hashed URL, so thumbnails cannot be guessed without it.
//   - the lobby modal's `gameConfig` property says which map is actually
//     selected; the DOM shows the map name only in some modes.
//   - during a game, the client's GameView: the tile-ownership buffer, terrain
//     and every player's name, colour and land share (timelapse, only while
//     data-ofr-lapse is "on"), and my team's roster and the emoji messages
//     between teammates (team chat, only while data-ofr-team is "on"), a few
//     counts for the stream overlay (only while data-ofr-overlay is "on") and,
//     when watching a game, every player's shown name, team, land share and
//     state (observer mode, only while data-ofr-caster is "on").
//
// All of it is read-only: it never writes game state and sends no input.
// Lobby and game state go out on data attributes, the game views with
// window.postMessage. Both worlds can read them; page scripts can fake them.
(() => {
  // Versioned: after an extension update in an open tab the old probe is still here,
  // and a plain "already there" flag would keep the new one (and what it adds) out.
  const VERSION = 6; // 4: stream overlay figures; 5: observer mode (caster feed, spectator/over flags); 6: spectator = not on the roster (not isSpectator()), spawn-phase clock
  if ((window.__ofrProbeVersion ?? 0) >= VERSION) return;
  window.__ofrProbeVersion = VERSION;
  window.__ofrProbe = true;
  // Every loop of this copy stops once a newer probe has taken over the tab, so
  // two copies never report the same things twice.
  const every = (fn, ms) => {
    const id = setInterval(() => {
      if (window.__ofrProbeVersion !== VERSION) return clearInterval(id);
      fn();
    }, ms);
  };

  const ATTR = "ofrMap";

  // FetchGameMapLoader resolves a map to its folder by lowercasing the
  // GameMapType *key*: GameMapType.NewYorkCity = "New York City" -> newyorkcity.
  function mapFolder(mapValue) {
    return String(mapValue)
      .replace(/[^A-Za-z0-9]/g, "")
      .toLowerCase();
  }

  // Two shapes in the live build: the join modal carries the server's
  // `gameConfig`, while the host modal keeps the host's choices in flat
  // properties (`selectedMap`, `gameMode`, …). Read whichever is populated.
  // Every lobby modal stays in the DOM while closed, and the Create Lobby one
  // keeps a default map ("World") the whole time — so reading the first modal
  // found reported "World" while you sat in a Levant lobby. Only a modal with
  // something on screen counts.
  function isShown(el) {
    for (const child of el.querySelectorAll("div")) {
      const r = child.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return true;
    }
    return false;
  }

  function findGameConfig() {
    const selectors = [
      "join-lobby-modal",
      "host-lobby-modal",
      "single-player-modal",
      "game-config-settings",
    ];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!isShown(el)) continue;
        const config = el?.gameConfig;
        if (config?.gameMap) {
          return {
            gameMap: config.gameMap,
            gameMode: config.gameMode ?? null,
            difficulty: config.difficulty ?? null,
            maxPlayers: config.maxPlayers ?? null,
          };
        }
        if (el?.selectedMap) {
          return {
            gameMap: el.selectedMap,
            gameMode: el.gameMode ?? null,
            // The host modal names this one differently from the join modal.
            difficulty: el.selectedDifficulty ?? el.difficulty ?? null,
            maxPlayers: el.maxPlayers ?? null,
            bots: typeof el.bots === "number" ? el.bots : null,
          };
        }
      }
    }
    return null;
  }

  function assetUrl(relative) {
    const cfg = window.BOOTSTRAP_CONFIG ?? {};
    const manifest = cfg.assetManifest ?? {};
    const base = (cfg.cdnBase ?? "").replace(/\/+$/, "");
    const path = manifest[relative];
    if (!path) return null;
    return base ? `${base}${path}` : path;
  }

  function mapAssets(mapValue) {
    const folder = mapFolder(mapValue);
    return {
      thumbnail: assetUrl(`maps/${folder}/thumbnail.webp`),
      // Full-resolution terrain (one byte per tile) and the manifest that gives
      // its dimensions — what the zoom view renders instead of upscaling the
      // 500x250 thumbnail.
      terrain: assetUrl(`maps/${folder}/map.bin`),
      terrainManifest: assetUrl(`maps/${folder}/manifest.json`),
    };
  }

  function publish() {
    const config = findGameConfig();
    if (!config?.gameMap) {
      if (document.documentElement.dataset[ATTR]) {
        delete document.documentElement.dataset[ATTR];
      }
      return;
    }

    // Seconds until the public lobby starts, from the join modal's own clock,
    // for the auto-copy of the scouting report at ten seconds.
    let startsIn = null;
    const join = document.querySelector("join-lobby-modal");
    if (join && typeof join.lobbyStartAt === "number") {
      const offset = typeof join.serverTimeOffset === "number" ? join.serverTimeOffset : 0;
      startsIn = Math.max(0, Math.round((join.lobbyStartAt - (Date.now() + offset)) / 1000));
    }

    // The lobby's id doubles as the game's id once it starts (/game/<id>): the
    // chat uses it as the room, so the people in a lobby stay together.
    // ...and our own client id for this game. OpenFront gives every player a fresh
    // public client id per game and lists it in the game's record, so it says
    // exactly which row is "me" - names are not unique. (This is NOT the
    // persistent id, which is a secret and is never read.)
    let lobbyId = null;
    let clientId = null;
    const okId = (v) => typeof v === "string" && /^[A-Za-z0-9]{4,16}$/.test(v);
    for (const tagName of ["join-lobby-modal", "host-lobby-modal"]) {
      const el = document.querySelector(tagName);
      if (!el || !isShown(el)) continue;
      const id = el.currentLobbyId ?? el.lobbyId;
      if (okId(id)) lobbyId = id;
      const cid = el.currentClientID ?? el.clientID;
      if (okId(cid)) clientId = cid;
    }

    const assets = mapAssets(config.gameMap);
    const payload = {
      startsIn,
      lobbyId,
      clientId,
      map: String(config.gameMap),
      thumbnail: assets.thumbnail,
      terrain: assets.terrain,
      terrainManifest: assets.terrainManifest,
      mode: config.gameMode ? String(config.gameMode) : null,
      difficulty: config.difficulty ? String(config.difficulty) : null,
      maxPlayers:
        typeof config.maxPlayers === "number" ? config.maxPlayers : null,
      bots: typeof config.bots === "number" ? config.bots : null,
    };
    if (!payload.thumbnail) return;

    const next = JSON.stringify(payload);
    if (document.documentElement.dataset[ATTR] !== next) {
      document.documentElement.dataset[ATTR] = next;
    }
  }

  // The lobby's map can change while you sit in it (the host switches maps, or
  // you move to the next public lobby), and there is no event to hook from out
  // here — so poll, cheaply.
  publish();
  every(publish, 1000);

  const call = (o, m, ...a) => {
    try {
      return typeof o?.[m] === "function" ? o[m](...a) : undefined;
    } catch {
      return undefined;
    }
  };

  // Watching (a spectator's seat, or a replay) rather than playing. NOT the client's
  // own GameView.isSpectator(): in OpenFront v0.34.10 that is
  // `!myPlayer()?.isAlive() || isReplay()`, true for every PLAYER during the spawn
  // phase (there is no PlayerView of yours until you spawn) and for a player who was
  // eliminated. What really says "watching":
  //   - a replay (Config.isReplay);
  //   - Spectate picked in the lobby (Config.isIntentionalSpectator);
  //   - this client not on the game's roster: the server freezes the players into
  //     gameStartInfo.players at the start, and a spectator never has an entry there
  //     (GameServer.ts). The client keeps that list on its worker
  //     (WorkerClient.gameStartInfo) and keyed by client id in GameView._cosmetics.
  // Without a readable roster: no PlayerView of mine once the spawn phase is over.
  function rosterIds(game) {
    try {
      const players = game?.worker?.gameStartInfo?.players;
      if (Array.isArray(players)) {
        const ids = new Set();
        for (const p of players) if (typeof p?.clientID === "string") ids.add(p.clientID);
        return ids;
      }
      const cosmetics = game?._cosmetics;
      if (cosmetics instanceof Map) return new Set([...cosmetics.keys()].filter((k) => typeof k === "string"));
    } catch {
      // not readable in this build
    }
    return null;
  }
  function watchingGame(game) {
    const cfg = call(game, "config");
    if (call(cfg, "isReplay") === true || call(cfg, "isIntentionalSpectator") === true) return true;
    const cid = call(game, "myClientID");
    const roster = typeof cid === "string" && cid ? rosterIds(game) : null;
    if (roster && roster.size > 0) return !roster.has(cid);
    if (call(game, "inSpawnPhase") !== false) return false; // spawning (or unknown): a player has no PlayerView yet
    return (call(game, "myPlayer") ?? null) === null;
  }
  // The game clock: 0 through the spawn phase (GameView.elapsedGameSeconds), ticks
  // only when the call is not there.
  function gameSeconds(game) {
    const s = call(game, "elapsedGameSeconds");
    if (typeof s === "number" && Number.isFinite(s) && s >= 0) return s;
    return Math.round((Number(call(game, "ticks")) || 0) / 10);
  }

  // Whether a game is running in this tab and whether you are still in it. The
  // chat pauses while you are alive in a running free-for-all (a free-text side
  // channel there would be an unfair one), and opens again once you are out.
  const GAME_ATTR = "ofrGame";
  function publishGame() {
    const game = document.querySelector("player-panel")?.g ?? null;
    let next = "";
    if (game) {
      let spawn = false;
      let alive = null;
      let clientId = null;
      try {
        spawn = game.inSpawnPhase?.() === true;
        const me = game.myPlayer?.() ?? null;
        alive = me ? me.isAlive?.() === true : null; // null: not a player here (spectating)
        const cid = me?.clientID?.();
        if (typeof cid === "string" && /^[A-Za-z0-9]{4,16}$/.test(cid)) clientId = cid;
      } catch {
        // mid-teardown; report what we have
      }
      let mode = null;
      try {
        const m = game.config?.()?.gameConfig?.()?.gameMode;
        if (typeof m === "string") mode = m.slice(0, 40);
      } catch {
        // not readable in this build
      }
      // Observer mode: watching (a spectator's seat, or a replay) rather than playing
      // (watchingGame above - never the client's isSpectator()); and whether the game
      // is over (sticky in the client). Read-only, like the rest.
      let spectator = false;
      let over = false;
      let replay = false;
      try {
        replay = game.config?.()?.isReplay?.() === true;
        spectator = replay || watchingGame(game);
        over = game.gameOver?.() === true;
      } catch {
        // not readable in this build: playing, not over
      }
      next = JSON.stringify({ running: true, spawn, alive, clientId, mode, spectator, over, replay });
    }
    if ((document.documentElement.dataset[GAME_ATTR] ?? "") !== next) {
      if (next) document.documentElement.dataset[GAME_ATTR] = next;
      else delete document.documentElement.dataset[GAME_ATTR];
    }
  }
  publishGame();
  every(publishGame, 1000);

  // --- Read-only views of the running game, for the timelapse and the team chat ---------
  // Everything below only READS the client's GameView (names verified against the
  // game's source at the deployed tag): no intent, no event, no write to any
  // buffer. Results go to the extension's isolated world with window.postMessage.
  // None of it is secret - it is what the game already shows - but the page can
  // see those messages and any script in it can fake them. The other side checks
  // their shape only: a faked team feed can make a key look verified as a
  // teammate (docs/TEAM-CHAT.md, "Out of scope"). (`call` is defined further up.)
  const liveGame = () => document.querySelector("player-panel")?.g ?? document.querySelector("win-modal")?.game ?? null;
  const post = (kind, data, transfer) => {
    try {
      window.postMessage({ __ofr: kind, ...data }, location.origin === "null" ? "*" : location.origin, transfer);
    } catch {
      // not cloneable / window going away
    }
  };

  // ---- timelapse: a small whole-map ownership picture every few seconds ----------------
  const FRAME_W = 480;
  const TERRAIN = { bg: [60, 60, 60], ocean: [71, 133, 181], sand: [204, 203, 158], plains: [190, 220, 138], high: [220, 203, 158], mount: [230, 230, 230] };
  const FALLOUT = [13, 140, 18];
  const lapse = { gameId: null, stride: 1, fw: 0, fh: 0, terrain: null, water: -1, lastTick: -1, canvas: null, ctx: null, image: null };

  function terrainColour(byte) {
    const land = (byte & 0x80) !== 0;
    const shore = (byte & 0x40) !== 0;
    const mag = byte & 0x1f;
    if (land) {
      if (mag === 31) return TERRAIN.bg;
      if (shore) return TERRAIN.sand;
      if (mag < 10) return [TERRAIN.plains[0], TERRAIN.plains[1] - 2 * mag, TERRAIN.plains[2]];
      if (mag < 20) return TERRAIN.high.map((c) => Math.min(255, c + 2 * (mag - 10)));
      return TERRAIN.mount.map((c) => Math.min(255, c + Math.floor(mag / 2)));
    }
    if (shore) return TERRAIN.ocean.map((c) => Math.round(0.7 * c + 76.5));
    return TERRAIN.ocean.map((c) => Math.max(0, c - Math.min(mag, 10)));
  }

  function lapseFrame() {
    if (document.documentElement.dataset.ofrLapse !== "on") return;
    const game = liveGame();
    const gameId = call(game, "gameID");
    const tick = call(game, "ticks");
    const W = call(game, "width");
    const H = call(game, "height");
    const tiles = call(game, "tileStateBuffer");
    if (!game || typeof gameId !== "string" || !(tick > 0) || !(W > 0) || !(H > 0) || !(tiles instanceof Uint16Array) || tiles.length < W * H) return;
    if (call(game, "inSpawnPhase") === true || call(game, "isCatchingUp") === true) return;
    const every = Number(document.documentElement.dataset.ofrLapseEvery) || 30; // ticks; the other side widens it on long games
    if (lapse.gameId === gameId && tick - lapse.lastTick < every && tick >= lapse.lastTick) return;

    if (lapse.gameId !== gameId || !lapse.canvas) {
      lapse.gameId = gameId;
      lapse.stride = Math.max(1, Math.ceil(W / FRAME_W), Math.ceil(H / FRAME_W)); // both sides: a tall map must fit too
      lapse.fw = Math.floor(W / lapse.stride);
      lapse.fh = Math.floor(H / lapse.stride);
      lapse.canvas = document.createElement("canvas");
      lapse.canvas.width = lapse.fw;
      lapse.canvas.height = lapse.fh;
      lapse.ctx = lapse.canvas.getContext("2d");
      lapse.image = lapse.ctx.createImageData(lapse.fw, lapse.fh);
      lapse.terrain = null;
      lapse.water = -1;
    }
    lapse.lastTick = tick;
    const { stride, fw, fh } = lapse;

    // terrain underlay, recomputed only when the map's water changes (water nukes)
    const water = call(game, "waterVersion") ?? 0;
    if (!lapse.terrain || lapse.water !== water) {
      if (typeof game.terrainByte !== "function") return;
      const t = new Uint8Array(fw * fh * 3);
      try {
        for (let y = 0; y < fh; y++) {
          for (let x = 0; x < fw; x++) {
            const c = terrainColour(game.terrainByte(y * stride * W + x * stride));
            const i = (y * fw + x) * 3;
            t[i] = c[0];
            t[i + 1] = c[1];
            t[i + 2] = c[2];
          }
        }
      } catch {
        return;
      }
      lapse.terrain = t;
      lapse.water = water;
    }

    // colours can change mid-game: rebuild the small-id -> rgb table every frame
    const colours = new Map();
    const players = call(game, "playerViews") ?? call(game, "players") ?? [];
    let aliveHumans = 0;
    const board = [];
    for (const p of players) {
      const id = call(p, "smallID");
      if (!(id > 0)) continue;
      const rgb = call(call(p, "territoryColor"), "toRgb");
      colours.set(id, rgb && Number.isFinite(rgb.r) ? [rgb.r, rgb.g, rgb.b] : [(id * 97) % 256, (id * 57) % 256, (id * 151) % 256]);
      const alive = call(p, "isAlive") === true;
      const human = call(p, "type") === "HUMAN";
      if (alive && human) aliveHumans++;
      // the name the game shows (anonymised under OpenFront's "Hidden Names"), not the raw one
      if (alive) board.push({ id, name: String(call(p, "displayName") ?? call(p, "name") ?? "").slice(0, 32), tiles: Number(call(p, "numTilesOwned")) || 0, me: call(p, "isMe") === true });
    }

    const px = lapse.image.data;
    const terr = lapse.terrain;
    for (let y = 0; y < fh; y++) {
      const row = y * stride * W;
      for (let x = 0; x < fw; x++) {
        const v = tiles[row + x * stride];
        const o = (y * fw + x) * 4;
        const owner = v & 0xfff;
        let c;
        if ((v & 0x2000) !== 0) c = FALLOUT;
        else if (owner !== 0) c = colours.get(owner);
        if (c) {
          px[o] = c[0];
          px[o + 1] = c[1];
          px[o + 2] = c[2];
        } else {
          const i = (y * fw + x) * 3;
          px[o] = terr[i];
          px[o + 1] = terr[i + 1];
          px[o + 2] = terr[i + 2];
        }
        px[o + 3] = 255;
      }
    }
    lapse.ctx.putImageData(lapse.image, 0, 0);

    const land = Number(call(game, "numLandTiles")) || 0;
    board.sort((a, b) => b.tiles - a.tiles);
    const mine = board.find((b) => b.me) ?? null;
    const stats = {
      seconds: gameSeconds(game),
      aliveHumans,
      myShare: mine && land ? mine.tiles / land : null,
      top: board.slice(0, 3).map((b) => ({ name: b.name, share: land ? b.tiles / land : 0, rgb: colours.get(b.id), me: b.me })),
      map: (() => {
        try {
          return String(game.config().gameConfig().gameMap ?? "");
        } catch {
          return "";
        }
      })(),
    };
    lapse.canvas.toBlob(
      (blob) => {
        if (blob) post("lapse-frame", { gameId, tick, w: fw, h: fh, stats, blob });
      },
      "image/webp",
      1, // quality 1 = lossless in Chrome: flat colours stay flat, which the GIF's delta frames rely on
    );
  }
  every(lapseFrame, 1000);

  // ---- stream overlay: a few live figures once a second -------------------------------
  // Only while the extension asks (data-ofr-overlay="on": its overlay page is open).
  // Counts and land shares only - no names - read like the timelapse above.
  function overlayStats() {
    if (document.documentElement.dataset.ofrOverlay !== "on") return;
    const game = liveGame();
    const gameId = call(game, "gameID");
    if (!game || typeof gameId !== "string") return;
    const myId = call(call(game, "myPlayer"), "smallID");
    const players = call(game, "playerViews") ?? call(game, "players") ?? [];
    let humans = 0;
    let humansTotal = 0;
    const board = [];
    for (const p of players) {
      const id = call(p, "smallID");
      if (!(id > 0)) continue;
      const human = call(p, "type") === "HUMAN";
      if (human) humansTotal++;
      if (call(p, "isAlive") !== true) continue;
      if (human) humans++;
      board.push({ tiles: Number(call(p, "numTilesOwned")) || 0, me: id === myId || call(p, "isMe") === true });
    }
    board.sort((a, b) => b.tiles - a.tiles);
    const land = Number(call(game, "numLandTiles")) || 0;
    const mine = board.findIndex((b) => b.me);
    let map = "";
    try {
      map = String(game.config().gameConfig().gameMap ?? "").slice(0, 40);
    } catch {
      // not readable in this build
    }
    post("overlay-stats", {
      gameId,
      seconds: gameSeconds(game),
      spawn: call(game, "inSpawnPhase") === true,
      humans,
      humansTotal,
      players: board.length,
      place: mine >= 0 ? mine + 1 : null,
      share: mine >= 0 && land ? board[mine].tiles / land : null,
      top: board.slice(0, 3).map((b) => ({ share: land ? b.tiles / land : 0, me: b.me })),
      map,
    });
  }
  every(overlayStats, 1000);

  // ---- observer mode: every player's standing, once a second --------------------------
  // Only while the extension asks (data-ofr-caster="on": you are watching a game - a
  // spectator's seat or a replay - and its caster panel or overlay wants the data),
  // and only while this client really is watching (watchingGame: never a player in
  // the spawn phase or one who was eliminated). Names are the ones the game
  // SHOWS (displayName / name, which the client anonymises when "Hidden Names" is
  // on), never the raw p.static ones, so hidden names stay hidden.
  function casterFeed() {
    if (document.documentElement.dataset.ofrCaster !== "on") return;
    const game = liveGame();
    const gameId = call(game, "gameID");
    if (!game || typeof gameId !== "string") return;
    const replay = call(call(game, "config"), "isReplay") === true;
    if (!replay && !watchingGame(game)) return;
    const tick = Number(call(game, "ticks")) || 0;
    const players = [];
    for (const p of call(game, "playerViews") ?? call(game, "players") ?? []) {
      const sid = call(p, "smallID");
      if (!(Number.isInteger(sid) && sid > 0)) continue;
      const type = call(p, "type");
      const alive = call(p, "isAlive") === true;
      const tiles = Number(call(p, "numTilesOwned")) || 0;
      if (type === "BOT" && !(alive && tiles > 0)) continue; // hundreds of fallen bots say nothing
      const name = call(p, "displayName") ?? call(p, "name");
      const team = call(p, "team");
      const rgb = call(call(p, "territoryColor"), "toRgb");
      players.push({
        sid,
        name: typeof name === "string" ? name.slice(0, 48) : "",
        team: typeof team === "string" ? team.slice(0, 40) : null,
        tiles,
        alive,
        human: type === "HUMAN",
        type: typeof type === "string" ? type : null,
        rgb: rgb && Number.isFinite(rgb.r) ? [rgb.r, rgb.g, rgb.b] : null,
      });
    }
    players.sort((a, b) => b.tiles - a.tiles);
    let mode = "";
    let teams = null;
    let map = "";
    try {
      const cfg = game.config().gameConfig();
      mode = String(cfg.gameMode ?? "").slice(0, 40);
      map = String(cfg.gameMap ?? "").slice(0, 40);
    } catch {
      // not readable in this build
    }
    const pt = call(call(game, "config"), "playerTeams");
    if (typeof pt === "number" || typeof pt === "string") teams = pt;
    post("caster-state", {
      gameId,
      tick,
      seconds: gameSeconds(game),
      spawn: call(game, "inSpawnPhase") === true,
      over: call(game, "gameOver") === true,
      replay,
      mode,
      teams,
      map,
      land: Number(call(game, "numLandTiles")) || 0,
      players: players.slice(0, 400),
    });
  }
  every(casterFeed, 1000);

  // ---- team chat: my teammates, and the emoji messages we send -------------------------
  // Teammates prove who they are to each other's extension by sending each other
  // an agreed emoji sequence with the game's own emoji menu (docs/TEAM-CHAT.md).
  // This side only WATCHES: the roster of my team once a second, and new emoji
  // messages between its human members four times a second - and only while the
  // extension asks for it (data-ofr-team="on", team games only).
  const team = { gameId: null, seen: new Map(), beat: 0, lastTick: -1 };
  function teamFeed() {
    // "on:<time>", refreshed by the extension every 10 s: a stale one (the extension
    // was reloaded under the tab) means nobody is listening any more.
    const flag = document.documentElement.dataset.ofrTeam ?? "";
    if (!flag.startsWith("on:") || Math.abs(Date.now() - Number(flag.slice(3))) > 40000) return;
    const game = liveGame();
    const gameId = call(game, "gameID");
    const tick = call(game, "ticks");
    if (!game || typeof gameId !== "string" || !(tick >= 0)) return;
    const me = call(game, "myPlayer") ?? null;
    const myTeam = call(me, "team");
    if (!me || typeof myTeam !== "string") return;
    if (team.gameId !== gameId || tick < team.lastTick) {
      team.gameId = gameId;
      team.seen = new Map();
    }
    team.lastTick = tick;

    const mates = [];
    for (const p of call(game, "playerViews") ?? call(game, "players") ?? []) {
      if (call(p, "type") !== "HUMAN") continue;
      const mine = call(p, "isMe") === true;
      if (!mine && call(me, "isOnSameTeam", p) !== true) continue;
      const sid = call(p, "smallID");
      if (!(Number.isInteger(sid) && sid > 0)) continue;
      mates.push({ p, sid, mine });
    }

    // Two sources, merged: emoji messages live 5 s in the sender's state (the raw
    // state is not blanked by the user's "disable emojis" setting; the method is),
    // and the last tick's update stream carries them too. Each is reported once,
    // with who it was sent TO: only an emoji sent to me counts as proof to me.
    const fresh = [];
    const sids = new Set(mates.map((m) => m.sid));
    const take = (e) => {
      if (!e || typeof e.message !== "string" || !Number.isInteger(e.createdAt) || !sids.has(e.senderID)) return;
      if (!Number.isInteger(e.recipientID) || !sids.has(e.recipientID)) return; // broadcasts and emojis to outsiders prove nothing
      const key = `${e.senderID}|${e.recipientID}|${e.createdAt}|${e.message}`;
      if (team.seen.has(key)) return;
      team.seen.set(key, e.createdAt);
      fresh.push({ sid: e.senderID, to: e.recipientID, emoji: e.message.slice(0, 16), tick: e.createdAt });
    };
    for (const { p, sid } of mates) {
      const raw = Array.isArray(p?.state?.outgoingEmojis) ? p.state.outgoingEmojis : call(p, "outgoingEmojis");
      if (!Array.isArray(raw)) continue;
      // newest first in the game's list: walk it backwards to report in sending order
      for (let i = raw.length - 1; i >= 0; i--) take(raw[i]?.senderID === undefined ? { ...raw[i], senderID: sid } : raw[i]);
    }
    const updates = call(game, "updatesSinceLastTick");
    if (updates && typeof updates === "object") {
      for (const list of Object.values(updates)) {
        if (!Array.isArray(list) || !list.length || typeof list[0]?.emoji?.message !== "string") continue;
        for (const u of list) take(u?.emoji);
      }
    }
    fresh.sort((a, b) => a.tick - b.tick);
    if (team.seen.size > 400) for (const [key, at] of team.seen) if (tick - at > 200) team.seen.delete(key);

    const beat = ++team.beat % 4 === 0;
    if (!fresh.length && !beat) return;
    post("team-state", {
      gameId,
      tick,
      spawn: call(game, "inSpawnPhase") === true,
      catchingUp: call(game, "isCatchingUp") === true || call(call(game, "config"), "isReplay") === true,
      team: myTeam.slice(0, 40),
      roster: beat
        ? mates.slice(0, 128).map(({ p, sid, mine }) => ({
            sid,
            me: mine,
            name: String(p?.static?.displayName ?? call(p, "displayName") ?? "").slice(0, 40),
            alive: call(p, "isAlive") === true,
          }))
        : null,
      emojis: fresh.slice(0, 32),
    });
  }
  every(teamFeed, 250);
})();
