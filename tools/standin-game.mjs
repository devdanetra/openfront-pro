// Stand-in "game" pages for the dev tools (shot-overlay.mjs, shot-observer.mjs):
// a fake, read-only GameView on <player-panel>, which the REAL page-probe.js reads
// exactly like OpenFront's client (names verified against .steam-peek/cheatsheet.txt).
// Served from a local http server and attached by the real launcher - never
// openfront.io.
//
//   playerGamePage(gameId, { role })       you are playing (#2 of 57), for the rank /
//                                          live cards; role "spawning" (the spawn
//                                          phase: no PlayerView of yours yet) or
//                                          "eliminated" (yours, not alive)
//   spectatorGamePage(gameId, { team })    you WATCH a game: not on the roster,
//                                          myPlayer() null; a made-up map whose
//                                          empires grow, players eliminated on a
//                                          schedule, gameOver() when the harness sets
//                                          window.__standinOver = true. The map is
//                                          drawn full-page (what the stream shows).
//   seatModel(role, clientID, roster, me)  the seat part of a GameView (below), also
//                                          used by tools/test-observer.mjs in node

// Who this client is in the game, as OpenFront v0.34.10's client has it:
//   GameView.myClientID()   the client id the server gave this connection (none in a replay)
//   GameView.myPlayer()     `_myPlayer ??= playerByClientID(myClientID)`: null until this
//                           client's player spawns, and always null for a spectator
//   GameView.isSpectator()  `!this.myPlayer()?.isAlive() || this._config.isReplay()` - so
//                           TRUE for a player in the spawn phase and for an eliminated one
//   GameView.worker.gameStartInfo.players  the roster frozen at the start (a spectator
//                           has no entry: GameServer.ts); GameView._cosmetics is keyed by it
//   Config.isReplay(), Config.isIntentionalSpectator() (Spectate picked in the lobby)
// role: "player" | "spawning" | "eliminated" | "spectator" | "intentional" | "replay".
// me: () => the page's PlayerView of you (players only). Self-contained on purpose:
// the pages inline it with toString().
export function seatModel(role, clientID, roster, me) {
  const replay = role === "replay";
  const watching = role === "spectator" || role === "intentional";
  const ids = watching ? roster.filter((c) => c !== clientID) : roster.includes(clientID) ? roster.slice() : roster.concat([clientID]);
  const players = ids.map((c) => ({ clientID: c, username: "someone", cosmetics: {} }));
  const spawned = role === "player" || role === "eliminated";
  const game = {
    myClientID: () => (replay ? undefined : clientID),
    myPlayer: () => (spawned && typeof me === "function" ? me() : null),
    inSpawnPhase: () => role === "spawning",
    isSpectator: () => {
      const p = game.myPlayer();
      return !(p && p.isAlive()) || replay;
    },
    worker: { gameStartInfo: { gameID: "x", players } },
    _cosmetics: new Map(players.map((p) => [p.clientID, p.cosmetics])),
  };
  const config = { isReplay: () => replay, isIntentionalSpectator: () => role === "intentional" };
  return { game, config };
}

export function playerGamePage(gameId, { role = "player" } = {}) {
  return `<!doctype html><title>stand-in game</title><body style="background:#355">
<script>
  localStorage.setItem("username", "TeNa");
  localStorage.setItem("clanTag", "LUX");
  const start = Date.now();
  const ROLE = ${JSON.stringify(role)};
  const people = [];
  for (let i = 1; i <= 57; i++) people.push({ id: i, type: i <= 38 ? "HUMAN" : "FAKEHUMAN", alive: i <= 14 || i > 38, tiles: Math.round(40000 / (i + 1.5)) });
  people[1].tiles = 12400; people[0].tiles = 17100; // #1 somebody, #2 me (id 2)
  if (ROLE === "eliminated") { people[1].alive = false; people[1].tiles = 0; }
  const cid = (p) => (p.type === "HUMAN" ? "Cl1ent" + String(p.id).padStart(2, "0") : null);
  const view = (p) => ({ smallID: () => p.id, type: () => p.type, isAlive: () => p.alive, numTilesOwned: () => p.tiles, isMe: () => p.id === 2, clientID: () => cid(p), displayName: () => "P" + p.id });
  const seat = (${seatModel.toString()})(ROLE, "Cl1ent02", people.map(cid).filter(Boolean), () => view(people[1]));
  window.fakeGame = {
    ...seat.game,
    gameID: () => ${JSON.stringify(gameId)},
    ticks: () => (ROLE === "spawning" ? 40 : 7540) + Math.floor((Date.now() - start) / 100),
    elapsedGameSeconds: () => (ROLE === "spawning" ? 0 : 754 + (Date.now() - start) / 1000),
    isCatchingUp: () => false,
    gameOver: () => false,
    playerViews: () => people.filter((p) => ROLE !== "spawning" || p.id !== 2).map(view),
    numLandTiles: () => 100000,
    config: () => ({ ...seat.config, gameConfig: () => ({ gameMode: "Free For All", gameMap: "World" }) }),
  };
  const panel = document.createElement("player-panel");
  panel.g = window.fakeGame;
  document.body.append(panel);
</script></body>`;
}

// Everyone in the watched game. deathAt: game seconds (null: survives). The names
// are what the game SHOWS: tags included, a guest name, one hidden by "Hidden Names".
const CAST = [
  ["[OFP] Kestrel", "HUMAN", [224, 68, 62], 0.23, 0.35, 1.25, null],
  ["Marlowe", "HUMAN", [59, 123, 224], 0.72, 0.3, 1.1, null],
  ["[UN] Mox", "HUMAN", [242, 193, 46], 0.5, 0.7, 1.0, null],
  ["Tsarina", "HUMAN", [22, 160, 133], 0.85, 0.72, 0.9, 520],
  ["Hollow Crown", "HUMAN", [142, 68, 173], 0.12, 0.75, 0.85, null],
  ["Pike", "HUMAN", [230, 126, 34], 0.38, 0.12, 0.8, 330],
  ["Anon42", "HUMAN", [127, 140, 141], 0.62, 0.5, 0.7, 170],
  ["\u{1F464} Wolf Pack", "HUMAN", [236, 240, 241], 0.93, 0.25, 0.75, null],
  ["France", "NATION", [52, 73, 94], 0.3, 0.55, 0.9, 250],
  ["Ottoman Empire", "NATION", [192, 57, 43], 0.62, 0.88, 0.95, null],
  ["Bot Alpha", "BOT", [160, 160, 150], 0.05, 0.1, 0.5, 120],
  ["Bot Beta", "BOT", [150, 150, 160], 0.95, 0.9, 0.5, 200],
];
const TEAMS = [
  ["Red", [214, 69, 65]],
  ["Blue", [52, 120, 214]],
  ["Yellow", [232, 190, 48]],
  ["Green", [58, 170, 92]],
];

export function spectatorGamePage(gameId, { team = false } = {}) {
  return `<!doctype html><title>stand-in game (watching)</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#1b3550}#view{position:fixed;inset:0;width:100%;height:100%;image-rendering:pixelated}</style>
<body><canvas id="view"></canvas>
<script>
(() => {
  localStorage.setItem("username", "TeNa");
  localStorage.setItem("clanTag", "LUX");
  const TEAM = ${team ? "true" : "false"};
  const CAST = ${JSON.stringify(CAST)};
  const TEAMS = ${JSON.stringify(TEAMS)};
  const W = 240, H = 120;
  const SPEED = 20; // game seconds per real second
  const t0 = Date.now();
  const gameSeconds = () => 60 + ((Date.now() - t0) / 1000) * SPEED;
  window.__standinOver = false;
  let overAt = null;
  const clock = () => {
    if (window.__standinOver && overAt === null) overAt = gameSeconds();
    return overAt ?? gameSeconds();
  };

  // terrain: continents from a few waves; bit 7 land, bit 5 ocean, bits 0-4 magnitude
  const terrain = new Uint8Array(W * H);
  let landTiles = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.sin(x * 0.045) + Math.cos(y * 0.09) + 0.8 * Math.sin((x + 2 * y) * 0.03) + 0.35 * Math.cos(x * 0.21 + y * 0.13);
    const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
    const land = v > -0.35 && edge > 3;
    terrain[y * W + x] = land ? 0x80 | Math.min(30, Math.floor(Math.abs(v) * 9 + ((x * 7 + y * 3) % 4))) : 0x20 | Math.min(10, Math.floor(Math.abs(v + 0.35) * 6));
    if (land) landTiles++;
  }

  const people = CAST.map(([name, type, rgb, cx, cy, k, deathAt], i) => {
    const t = TEAM ? (type === "BOT" ? "Bot" : TEAMS[i % 4][0]) : null;
    const trgb = TEAM && type !== "BOT" ? TEAMS[i % 4][1].map((c, j) => Math.max(0, Math.min(255, c + ((i * 13 + j * 7) % 21) - 10))) : rgb;
    return { id: i + 1, name, type, rgb: trgb, cx: cx * W, cy: cy * H, k, deathAt, team: t, tiles: 0 };
  });
  const alive = (p, g) => p.deathAt === null || g < p.deathAt;

  // who owns what: the nearest living empire whose reach covers the tile
  const tiles = new Uint16Array(W * H);
  let builtFor = -1;
  function build() {
    const g = Math.floor(clock());
    if (g === builtFor) return;
    builtFor = g;
    for (const p of people) p.tiles = 0;
    const live = people.filter((p) => alive(p, g));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      tiles[i] = 0;
      if (!(terrain[i] & 0x80)) continue;
      let best = null;
      let bestD = 1;
      for (const p of live) {
        const reach = p.k * (8 + Math.sqrt(g) * 2.1);
        const d = Math.hypot(x - p.cx, (y - p.cy) * 1.6) / reach;
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best) { tiles[i] = best.id; best.tiles++; }
    }
  }

  const view = (p) => ({
    smallID: () => p.id,
    type: () => p.type,
    isAlive: () => (build(), alive(p, clock()) && p.tiles > 0),
    hasSpawned: () => true,
    numTilesOwned: () => (build(), p.tiles),
    isMe: () => false,
    clientID: () => (p.type === "HUMAN" ? "Cl" + String(p.id).padStart(6, "0") : null),
    displayName: () => p.name,
    name: () => p.name.replace(/^\\[[^\\]]*\\]\\s*/, ""),
    team: () => p.team,
    territoryColor: () => ({ toRgb: () => ({ r: p.rgb[0], g: p.rgb[1], b: p.rgb[2], a: 1 }) }),
    // the raw name OpenFront keeps apart: the extension must never read it
    static: { name: "RAW-" + p.id, displayName: "RAW-SECRET-" + p.id },
  });
  // a spectator: this client's id is on no roster (the players' ids are)
  const seat = (${seatModel.toString()})("spectator", "SpecCl01", people.filter((p) => p.type === "HUMAN").map((p) => "Cl" + String(p.id).padStart(6, "0")), null);
  window.fakeGame = {
    ...seat.game,
    inSpawnPhase: () => false, // the spectator joined a running game
    gameID: () => ${JSON.stringify(gameId)},
    ticks: () => Math.floor(clock() * 10),
    elapsedGameSeconds: () => clock(),
    isCatchingUp: () => false,
    gameOver: () => window.__standinOver === true,
    playerViews: () => people.map(view),
    players: () => people.map(view),
    numLandTiles: () => landTiles,
    width: () => W,
    height: () => H,
    terrainByte: (ref) => terrain[ref],
    waterVersion: () => 0,
    tileStateBuffer: () => (build(), tiles),
    config: () => ({
      ...seat.config,
      gameConfig: () => ({ gameMode: TEAM ? "Team" : "Free For All", gameMap: "Europe" }),
      playerTeams: () => (TEAM ? 4 : 0),
    }),
  };
  const panel = document.createElement("player-panel");
  panel.g = window.fakeGame;
  document.body.append(panel);

  // the "game view": the map, drawn the way the client roughly does
  const canvas = document.getElementById("view");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const colour = (b) => {
    if (b & 0x80) { const m = b & 0x1f; return m < 10 ? [190, 220 - 2 * m, 138] : m < 20 ? [220 + 2 * (m - 10), 203 + 2 * (m - 10), 158 + 2 * (m - 10)] : [230, 230, 230]; }
    const m = b & 0x1f; return [71 - m, 133 - m, 181 - m];
  };
  function draw() {
    build();
    for (let i = 0; i < W * H; i++) {
      let c = colour(terrain[i]);
      const o = tiles[i];
      if (o) { const p = people[o - 1].rgb; c = [c[0] * 0.4 + p[0] * 0.6, c[1] * 0.4 + p[1] * 0.6, c[2] * 0.4 + p[2] * 0.6]; }
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  draw();
  setInterval(draw, 500);
})();
</script></body>`;
}
