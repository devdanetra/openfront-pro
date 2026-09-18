// Runs in the PAGE world (chrome.scripting with world: "MAIN"), which the
// content script cannot reach: element properties set by Lit and the page's
// own globals live here.
//
// Two things are only available from this side:
//   - window.BOOTSTRAP_CONFIG.assetManifest maps "maps/africa/thumbnail.webp"
//     to its content-hashed URL, so thumbnails cannot be guessed without it.
//   - the lobby modal's `gameConfig` property says which map is actually
//     selected; the DOM shows the map name only in some modes.
//
// It publishes what it finds on a data attribute, which both worlds can read.
(() => {
  if (window.__ofrProbe) return;
  window.__ofrProbe = true;

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
  setInterval(publish, 1000);

  // Whether a game is running in this tab and whether you are still in it. The
  // chat stays shut while you are alive in a running game (a free-text side
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
      next = JSON.stringify({ running: true, spawn, alive, clientId, mode });
    }
    if ((document.documentElement.dataset[GAME_ATTR] ?? "") !== next) {
      if (next) document.documentElement.dataset[GAME_ATTR] = next;
      else delete document.documentElement.dataset[GAME_ATTR];
    }
  }
  publishGame();
  setInterval(publishGame, 1000);
})();
