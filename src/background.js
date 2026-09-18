// Ranking lookups run here so they are subject to the extension's
// host_permissions instead of the page's CORS policy (ofstats sends no
// Access-Control-Allow-Origin, so a page-context fetch is blocked).
//
// ofstats aggregates every public OpenFront game by display name, the only key
// the lobby gives us: "[TAG] name" for a player with a clan tag, the bare name
// otherwise (OFR_SCORING.statsName builds it; callers send it, this worker
// looks up and caches whatever name it is given). It answers for nearly every
// player who has played before: measured on a real 94-player lobby roster, 29
// of the 32 names that were not throwaway guest handles had data.

// Chat: BIP-340 signing (vendored @noble) and the small Nostr client built on it.
importScripts("vendor/nostr-crypto.js", "nostr.js", "team.js");

const OFSTATS_API = "https://api.ofstats.io";

const HIT_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 30 * 60 * 1000;
const MAX_CONCURRENT = 6;
// ofs6: lookups became "[TAG] name" for tagged players; ofs5 held bare-name
// entries (and clan members without their full name), so none is served again.
const CACHE_PREFIX = "ofs6:";

const memoryCache = new Map();
const inFlight = new Map();
const queue = [];
let active = 0;

const DEFAULT_SETTINGS = {
  enabled: true,
  explainMissing: true, // mark names that cannot be ranked, instead of silence
  showGames: true, // append the game count to the win rate
  showSummary: true, // lobby-wide and per-team summary lines
  markThreats: true, // outline the strongest players in the room
  showMapPreview: true, // thumbnail of the lobby's map
  showMapRank: true, // skill on the map being played, next to the overall rank
  showForm: true, // hot / cold markers from the last ten games
  flagSmurfs: true, // strong results on a short history
  showRecap: true, // finishing order vs rank after a game
  theme: "classic", // the one theme: extension UI + (if themeSite) OpenFront itself
  themeSite: true, // recolour OpenFront's own pages with the theme
  profileLink: "dashboard", // what clicking a badge opens: dashboard | none (a stored "ofstats" from before 5.4 acts as dashboard)
  clanStats: true, // clan section on the dashboard, clan chips in the lobby
  streamerMode: false, // hide your own rank and blur your name
  soundAlerts: true, // beep when a watched player joins
  autoCopyReport: false, // copy the scouting report at 10s on the countdown
  // Nothing is looked up anywhere until the user has read what is sent and agreed
  // (src/welcome.html, opened on install). Themes and layouts work without it.
  dataConsent: false,
  timelapse: true, // record a whole-map timelapse of each game (memory only, never uploaded)
  chatEnabled: false, // opt-in: talks to third-party relays...
  chatConsent: false, // ...and only after agreeing to the chat's own disclosure
  chatInFfa: false, // chat while alive in a free-for-all (OpenFront's terms forbid coordinating there)
  chatFilter: true, // mask slurs and the like in incoming messages
  chatTeam: true, // team games: an encrypted channel for teammates verified through the game (docs/TEAM-CHAT.md)
  layout: "cards", // cards | compact | panel
  uiSize: "medium", // small | medium | large | xlarge
  siteLayout: "default", // default | wide | sidebar | focus (site-layouts.css)
};

// Before 5.5 there were two pickers: `theme` (the extension's look) and
// `pageTheme` (OpenFront's colours, default "off", so usually not stored at
// all). Now `theme` drives both and `themeSite` says whether the site follows.
// An existing profile is carried over ONCE, so that updating changes nothing on
// screen:
//   - only the site was themed              -> that becomes the theme;
//   - an extension theme, site never themed -> keep the site untouched
//     (themeSite: false) - "off" was the default, stored or not;
//   - both were set                         -> the theme picker wins, site follows.
// The marker is synced with the settings. After it is set a stray `pageTheme`
// (another machine on the same profile still running 5.4 writes one) is left
// alone: rewriting `theme` from it, or deleting it, on every worker start would
// make the two machines fight.
async function migrateThemes() {
  try {
    const s = await chrome.storage.sync.get(["theme", "pageTheme", "themeSite", "themesMigrated"]);
    if (s.themesMigrated === true) return;
    const patch = { themesMigrated: true };
    const hasTheme = Boolean(s.theme) && s.theme !== "classic";
    const sitePicked = Boolean(s.pageTheme) && s.pageTheme !== "off";
    if (sitePicked && !hasTheme) patch.theme = s.pageTheme;
    if (hasTheme && !sitePicked && s.themeSite === undefined) patch.themeSite = false;
    await chrome.storage.sync.set(patch);
    if (s.pageTheme !== undefined) await chrome.storage.sync.remove("pageTheme");
  } catch {
    // storage unavailable; the defaults still give one coherent theme
  }
}
const themesMigrated = migrateThemes();

// Chat consent covers what chat sends. 5.8 added the team channel's public data
// (player slot, verifications, encrypted team messages), so an agreement given to
// an older text is asked for again once: chat stays off until "I agree" is pressed
// on the current text. New installs are simply marked current.
const CHAT_CONSENT_REV = 2;
const chatConsentChecked = chrome.storage.sync
  .get({ chatConsentRev: 1, chatConsent: false })
  .then((st) => {
    if (st.chatConsentRev >= CHAT_CONSENT_REV) return;
    return chrome.storage.sync.set({ chatConsentRev: CHAT_CONSENT_REV, ...(st.chatConsent ? { chatConsent: false, chatEnabled: false } : {}) });
  })
  .catch(() => {});

// Entries written under an older CACHE_PREFIX can never be read again.
chrome.storage.local
  .get(null)
  .then((all) => {
    const stale = Object.keys(all).filter((k) => /^ofs\d+:/.test(k) && !k.startsWith(CACHE_PREFIX));
    if (stale.length) return chrome.storage.local.remove(stale);
  })
  .catch(() => {});

async function getSettings() {
  await themesMigrated;
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function cacheGet(key) {
  const hit = memoryCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) memoryCache.delete(key);

  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (entry && entry.expiresAt > Date.now()) {
    memoryCache.set(key, entry);
    return entry.value;
  }
  if (entry) await chrome.storage.local.remove(key);
  return undefined;
}

async function cacheSet(key, value) {
  const ttl = value && value.found ? HIT_TTL_MS : MISS_TTL_MS;
  const entry = { value, expiresAt: Date.now() + ttl };
  memoryCache.set(key, entry);
  await chrome.storage.local.set({ [key]: entry });
}

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const { task, resolve, reject } = queue.shift();
    active++;
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function fetchStats(username) {
  // limit=60 costs the same one request and gives head-to-head a real chance
  // of overlapping with the viewer's own recent games.
  const res = await fetch(
    `${OFSTATS_API}/players/${encodeURIComponent(username)}?limit=60`,
    { headers: { accept: "application/json" } },
  );
  // 404 is the ordinary answer for a name that has never finished a public
  // game, so it is a result, not a failure.
  if (res.status === 404) return { found: false, reason: "no-history" };
  if (!res.ok) return { found: false, reason: "error", status: res.status };

  const data = await res.json();
  const games = data?.gamesPlayed ?? 0;
  if (games < 1) return { found: false, reason: "no-history" };

  const milestones = data.highlights?.milestones ?? {};
  const modes = Array.isArray(data.modes) ? data.modes : [];

  // Per-map expectedWins already accounts for how many players were in each
  // lobby, so wins/expectedWins is a skill figure that a 60-player free-for-all
  // and a 1v1 can both feed into. Raw win rate cannot do that.
  const rows = Array.isArray(data.maps?.rows) ? data.maps.rows : [];
  const ratedWins = rows.reduce((sum, r) => sum + (r.wins ?? 0), 0);
  const expectedWins = rows.reduce((sum, r) => sum + (r.expectedWins ?? 0), 0);
  const ratedGames = rows.reduce((sum, r) => sum + (r.games ?? 0), 0);

  return {
    found: true,
    username: data.username ?? username,
    games,
    wins: data.wins ?? 0,
    winRate: (100 * (data.wins ?? 0)) / games,
    ratedGames,
    ratedWins,
    expectedWins,
    // ofstats reports "top X%" only for players notable enough to place, in
    // buckets of 0.01/0.1/1/5 — too coarse to separate a lobby.
    winsTop: typeof milestones.winsTop === "number" ? milestones.winsTop : null,
    modes: modes.map((m) => ({ mode: m.mode, games: m.games, wins: m.wins })),
    // Newest first (verified against ofstats' `date` field). Used for
    // head-to-head, current form, the trend sparkline and the dashboard's
    // history table.
    recentGames: (Array.isArray(data.games) ? data.games : [])
      .slice(0, 60)
      .map((g) => ({
        id: g.gameId,
        won: g.isWinner === true,
        map: g.map ?? null,
        mode: g.mode ?? null,
        date: g.date ?? null,
        duration: g.durationSecs ?? null,
        players: g.playerCount ?? null,
        conquests: g.conquestsTotal ?? null,
        nukes: g.nukesLaunched ?? null,
        killedAt: g.killedAt ?? null, // game tick; null = alive at the end
        turns: g.numTurns ?? null, // length of the game in ticks
        teams: g.playerTeams ?? null, // a number, or "Duos" | "Trios" | "Quads" | "Humans Vs Nations"
        gold: g.goldEarned ?? null,
      })),
    // Profile extras shown on the Pro dashboard.
    firstSeen: data.firstSeen ?? null,
    lastSeen: data.lastSeen ?? null,
    conquests: data.totalConquestsTotal ?? null,
    nukes: data.totalNukesLaunched ?? null,
    gold: data.totalGoldEarned ?? null,
    bests: data.bests ?? null,
    // Current consecutive-wins run, as ofstats computes it.
    streak:
      typeof data.highlights?.streak === "number" ? data.highlights.streak : 0,
    // Per-map wins vs expected, so a badge can speak to the map being played.
    // ofstats omits maps with too few games ("belowFloor"); those just fall
    // back to the overall figure.
    maps: rows.map((r) => ({
      map: r.map,
      games: r.games ?? 0,
      wins: r.wins ?? 0,
      expectedWins: r.expectedWins ?? 0,
    })),
  };
}

// ofstats keys clans on the bare tag. Members come back as "[TAG] name", which
// is also their player key there: `username` keeps it for lookups, `name` is
// the bare name for display.
async function fetchClan(tag) {
  const res = await fetch(`${OFSTATS_API}/clans/${encodeURIComponent(tag)}`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return { found: false, reason: "no-history" };
  if (!res.ok) return { found: false, reason: "error", status: res.status };
  const d = await res.json();
  const strip = (name) => String(name ?? "").replace(/^\[[A-Za-z0-9]{1,5}\]\s*/, "");
  return {
    found: true,
    tag: d.clanTag ?? tag,
    games: d.gamesPlayed ?? 0,
    wins: d.totalWins ?? 0,
    firstSeen: d.firstSeen ?? null,
    lastSeen: d.lastSeen ?? null,
    memberCount: d.memberCount ?? null,
    activeMembers: d.monthlyActiveMembers ?? null,
    avgGameDuration: d.avgGameDuration ?? null,
    team: d.team ?? null,
    weekly: d.weekly ?? null,
    modes: Array.isArray(d.modeBreakdown) ? d.modeBreakdown : d.modeBreakdown ?? null,
    members: (Array.isArray(d.members) ? d.members : []).slice(0, 50).map((m) => ({
      name: strip(m.username),
      username: String(m.username ?? ""),
      games: m.gamesPlayed ?? 0,
      wins: m.wins ?? 0,
      winRate: m.winRate ?? null,
      lastPlayed: m.lastPlayed ?? null,
    })),
  };
}

// ofstats' weekly clan table: /clans (this week, by points).
async function lookupClanLeaderboard() {
  const key = `${CACHE_PREFIX}clans:week`;
  const cached = await cacheGet(key);
  if (cached !== undefined) return cached;
  const promise = schedule(async () => {
    const res = await fetch(`${OFSTATS_API}/clans`, { headers: { accept: "application/json" } });
    if (!res.ok) return { found: false, reason: "error", status: res.status };
    const d = await res.json();
    return {
      found: true,
      week: d.week ?? null,
      isCurrentWeek: d.isCurrentWeek ?? null,
      clans: (Array.isArray(d.clans) ? d.clans : []).slice(0, 15).map((c) => ({
        rank: c.rank,
        tag: c.clanTag,
        points: c.points ?? null,
        games: c.games ?? null,
        wins: c.wins ?? null,
        stackedWinRate: c.stackedWinRate ?? null,
      })),
    };
  })
    .catch((err) => ({ found: false, reason: "error", error: String(err) }))
    .then(async (value) => {
      await cacheSet(key, value);
      return value;
    });
  return promise;
}

async function lookupClan(tag) {
  const key = `${CACHE_PREFIX}clan:${tag.toUpperCase()}`;
  const cached = await cacheGet(key);
  if (cached !== undefined) return cached;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = schedule(() => fetchClan(tag))
    .catch((err) => ({ found: false, reason: "error", error: String(err) }))
    .then(async (value) => {
      await cacheSet(key, value);
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function lookup(username, fresh = false) {
  const key = `${CACHE_PREFIX}${username.toLowerCase()}`;
  if (!fresh) {
    const cached = await cacheGet(key);
    if (cached !== undefined) return cached;
  }
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = schedule(() => fetchStats(username))
    .catch((err) => ({ found: false, reason: "error", error: String(err) }))
    .then(async (value) => {
      await cacheSet(key, value);
      return value;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

// Belt and braces for the declared content script. Chrome does not run declared
// scripts when the user has set this extension to "on click" for the site, and
// it also skips tabs that were already open when the extension was reloaded.
// Injecting on navigation covers both; content.js guards itself, so landing
// twice in one page is a no-op.
const OPENFRONT = /^https:\/\/([a-z0-9-]+\.)?openfront\.io\//i;

async function ensureInjected(tabId, url) {
  if (!OPENFRONT.test(url ?? "")) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/content.css", "src/dashboard.css", "src/site-layouts.css", "src/page-themes.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/themes.js", "src/scoring.js", "src/map-viewer.js", "src/charts.js", "src/dashboard.js", "src/timelapse.js", "src/recap.js", "src/chat.js", "src/content.js"],
    });
    // The map preview needs the page's own asset manifest and the lobby
    // element's gameConfig, neither of which an isolated world can see.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/page-probe.js"],
      world: "MAIN",
    });
  } catch (err) {
    // Usually "Cannot access contents of the page" when site access is
    // withheld; the popup reports that case with instructions.
    lastInjectError = String(err?.message ?? err);
  }
}

let lastInjectError = null;

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== "complete") return;
  ensureInjected(tabId, tab.url);
});

// Tabs already open when the extension is installed or reloaded.
async function injectExisting() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://*.openfront.io/*" });
    const bare = await chrome.tabs.query({ url: "https://openfront.io/*" });
    for (const tab of [...tabs, ...bare]) await ensureInjected(tab.id, tab.url);
  } catch (err) {
    lastInjectError = String(err?.message ?? err);
  }
}

// "5.6.1" < "5.7.0", numerically per part; anything unreadable counts as NOT before.
function versionBefore(version, than) {
  if (!/^\d+(\.\d+)*$/.test(String(version ?? ""))) return false;
  const a = String(version).split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    if (details.reason === "install") {
      // First run: say what is sent where, and ask, before anything is sent.
      await chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
    } else if (details.reason === "update" && versionBefore(details.previousVersion, "5.7.0")) {
      // People already using the lookups before the consent screen existed (it
      // came with 5.7.0) keep them. Anyone else who has not answered - someone who
      // closed the welcome tab, say - stays "not agreed" through every update.
      // (Chat consent is never assumed.)
      const stored = await chrome.storage.sync.get(["dataConsent"]);
      if (stored.dataConsent === undefined) await chrome.storage.sync.set({ dataConsent: true });
    }
  } catch {
    // storage or tabs unavailable; the popup offers the same screen
  }
  injectExisting();
});
chrome.runtime.onStartup.addListener(injectExisting);
injectExisting();

// Post-game recap: OpenFront's own record of a finished game carries each
// player's elimination turn (`stats.killedAt`, absent for survivors) and the
// winner's clientID — the exact finishing order. The record is archived a few
// seconds after the game ends, so the caller retries.
// <record-normaliser> (tools/test-recap.mjs evaluates this block)
// OpenFront's own record of a finished game, flattened for the recap.
//
// Stat arrays are positional (src/core/StatsSchemas.ts in the game's source):
//   attacks   [sent, received, cancelled]            troops x10 (internal units)
//   conquests [humans, nations, bots]                players eliminated
//   gold      [workers, war, trade, stolen, own trains, others' trains]
//   bombs.*   [launched, landed, intercepted]        abomb | hbomb | mirv | mirvw
//   boats.*   [sent, arrived, captured, destroyed]   trans | trade
//   units.*   [built, destroyed, captured, lost, upgraded]
// Values are bigint-as-decimal-string; keys (and whole `stats`) are simply
// absent when zero. killedAt is a game tick and absent for anyone still alive.
//
// info.winner is ["player", clientID] or ["team", teamName, ...clientIDs]; the
// losing teams' members are not recorded anywhere.
function statNum(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function statAt(arr, i) {
  return Array.isArray(arr) ? statNum(arr[i]) : 0;
}

function flattenStats(stats) {
  const st = stats ?? {};
  const gold = {
    work: statAt(st.gold, 0),
    war: statAt(st.gold, 1),
    trade: statAt(st.gold, 2),
    steal: statAt(st.gold, 3),
    trainSelf: statAt(st.gold, 4),
    trainOther: statAt(st.gold, 5),
  };
  gold.total = gold.work + gold.war + gold.trade + gold.steal + gold.trainSelf + gold.trainOther;
  const conquests = {
    humans: statAt(st.conquests, 0),
    nations: statAt(st.conquests, 1),
    bots: statAt(st.conquests, 2),
  };
  conquests.total = conquests.humans + conquests.nations + conquests.bots;
  const bombs = st.bombs ?? {};
  const nukes = {
    atom: statAt(bombs.abomb, 0),
    hydrogen: statAt(bombs.hbomb, 0),
    mirv: statAt(bombs.mirv, 0),
  };
  // MIRV warheads (mirvw) are the MIRV's own payload, not separate launches.
  // "Landed" can exceed "launched" (launches at unowned tiles are not counted),
  // so the two are never divided into an accuracy.
  nukes.launched = nukes.atom + nukes.hydrogen + nukes.mirv;
  nukes.landed = statAt(bombs.abomb, 1) + statAt(bombs.hbomb, 1);
  nukes.mirvLanded = statAt(bombs.mirv, 1);
  nukes.warheads = statAt(bombs.mirvw, 1);
  let built = 0;
  let destroyed = 0;
  let captured = 0;
  let lost = 0;
  for (const unit of Object.values(st.units ?? {})) {
    built += statAt(unit, 0);
    destroyed += statAt(unit, 1);
    captured += statAt(unit, 2);
    lost += statAt(unit, 3);
  }
  return {
    // The engine counts troops in tenths; /10 matches what the player saw.
    attacksSent: Math.round(statAt(st.attacks, 0) / 10),
    attacksRecv: Math.round(statAt(st.attacks, 1) / 10),
    betrayals: statNum(st.betrayals),
    conquests,
    gold,
    nukes,
    built,
    destroyed,
    captured,
    lost,
    attacksCancelled: Math.round(statAt(st.attacks, 2) / 10),
    citiesCaptured: statAt(st.units?.city, 2),
    defPosts: statAt(st.units?.defp, 0),
    boatsSent: statAt(st.boats?.trans, 0),
    boatsArrived: statAt(st.boats?.trans, 1),
    tradeDelivered: statAt(st.boats?.trade, 1),
    tradeCaptured: statAt(st.boats?.trade, 2),
    // transports + trade ships + warships this player sank
    sunk: statAt(st.boats?.trans, 3) + statAt(st.boats?.trade, 3) + statAt(st.units?.wshp, 1),
    // warheads shot down by this player's SAMs (credited to the interceptor)
    intercepted:
      statAt(bombs.abomb, 2) + statAt(bombs.hbomb, 2) + statAt(bombs.mirv, 2) + statAt(bombs.mirvw, 2),
  };
}

async function fetchGameRecord(gameId) {
  const res = await fetch(
    `https://api.openfront.io/public/game/${encodeURIComponent(gameId)}?turns=false`,
    { headers: { accept: "application/json" } },
  );
  if (res.status === 404) return { pending: true };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return normaliseRecord(await res.json(), gameId);
}

// Pure, so tools/test-recap.mjs can run it over saved records.
function normaliseRecord(data, gameId) {
  const info = data?.info ?? {};
  const config = info.config ?? {};
  const w = Array.isArray(info.winner) ? info.winner : [];
  // "nation": an AI nation won; nobody in players[] did. No winner at all: the
  // game ended without a vote (everyone left), and then nobody has stats either.
  const winner =
    w[0] === "team"
      ? { type: "team", name: String(w[1] ?? ""), ids: w.slice(2).map(String) }
      : w[0] === "player"
        ? { type: "player", name: null, ids: w.slice(1).map(String) }
        : w[0] === "nation"
          ? { type: "nation", name: String(w[1] ?? ""), ids: [] }
          : { type: null, name: null, ids: [] };
  const winners = new Set(winner.ids);
  return {
    gameId: info.gameID ?? gameId,
    map: config.gameMap ?? null,
    mode: config.gameMode ?? null,
    teams: config.playerTeams ?? null,
    difficulty: config.difficulty ?? null,
    duration: statNum(info.duration) || null, // seconds
    turns: statNum(info.num_turns) || null, // ticks; duration / turns = seconds per tick
    start: info.start ?? null,
    end: info.end ?? null, // ms; tells a game that just ended from a replay of an old one
    winner,
    players: (info.players ?? [])
      .filter((p) => p.username)
      .map((p) => ({
        // The bare name and the tag, separately. The archive keeps the real tag
        // even where the lobby hid it (clan tags disabled, names anonymised:
        // toWireGameStartInfo in the game's src/core/Util.ts). ofstats knows the
        // player as "[clanTag] username" when there is a tag: OFR_SCORING.statsName.
        username: p.username,
        clanTag: p.clanTag ?? null,
        clientID: p.clientID ?? null,
        // stable across games, public by design (the API prints it for everyone)
        publicID: typeof p.publicID === "string" ? p.publicID : null,
        // No stats object at all = joined the lobby but never spawned or acted.
        // Such a player has no killedAt either, so without this flag they would
        // rank as a survivor.
        active: p.stats != null,
        killedAt: p.stats?.killedAt != null ? Number(p.stats.killedAt) : null,
        // Newer builds only; feature-detected by the recap.
        finalTiles: p.stats?.finalTiles != null ? Number(p.stats.finalTiles) : null,
        killedBy: p.stats && "killedBy" in p.stats ? (p.stats.killedBy ?? "") : undefined,
        // {victim clientID, tick}. A player can be conquered, regain land and be
        // conquered again, so the same victim may appear several times.
        kills: Array.isArray(p.stats?.kills)
          ? p.stats.kills.map((k) => ({ victim: String(k?.victim ?? ""), tick: Number(k?.tick ?? NaN) }))
          : [],
        winner: winners.has(String(p.clientID)),
        stats: flattenStats(p.stats),
      })),
    // Newer builds list every human conquest as a kill. Then "players conquered"
    // can be counted as distinct victims; conquests[0] alone counts EVENTS (one
    // player conquered nine times is nine).
    hasKills: (info.players ?? []).some((p) => Array.isArray(p.stats?.kills)),
  };
}
// </record-normaliser>

// ---- chat over Nostr -------------------------------------------------------------------
// One room per game, carried by public Nostr relays as EPHEMERAL events (see
// nostr.js for why). The sockets live here rather than in the page: a content
// script's connections answer to the page's CSP, and the signing key stays out
// of any page. Each chat-enabled tab holds a port; closing it leaves the room.
//
// The relays are third parties. They see this browser's IP address and
// everything sent. Other players see what is sent: in the public room a name
// (unverified - anyone can type any name), a key fingerprint and the text; with
// the team channel in a team game also the player slot the key claims, whom it
// verified, and encrypted team messages (docs/TEAM-CHAT.md lists what is public).
const CHAT_RELAYS = [
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://nostr.mom",
  "wss://relay.snort.social",
];
const CHAT_KEY = "chatKey";
const CHAT_MIN_GAP_MS = 1200; // between two messages of yours
const CHAT_PER_MINUTE = 12;
const CHAT_PRESENCE_MS = 45000;
const CHAT_INBOUND_PER_SEC = 25; // across the room, before any signature is checked

// A fresh signing key per room, kept in memory-only session storage: games
// cannot be linked to each other through the key, and no key sits on disk.
// (It survives a worker restart within the browser session, so you stay the
// same sender for the length of a game.)
async function chatSecretKey(room) {
  const slot = `${CHAT_KEY}:${room}`;
  try {
    const stored = (await chrome.storage.session.get(slot))[slot];
    if (typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored)) return stored;
    const fresh = OFR_NOSTR.newSecretKey();
    await chrome.storage.session.set({ [slot]: fresh });
    return fresh;
  } catch {
    return OFR_NOSTR.newSecretKey(); // no session storage: a key for this connection only
  }
}
// the long-lived key older versions kept on disk
chrome.storage.local.remove(CHAT_KEY).catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ofr-chat") return;
  let room = null;
  let roomGameId = null;
  let roomName = null;
  let secretKey = null;
  let team = null; // the verified-teammates channel of this room (team.js); team games only
  let teamWanted = false; // the page says: a running team game, team channel switched on
  let joinSeq = 0; // a join awaits storage; a newer join (or a leave) supersedes it
  let name = "";
  let lastSent = 0;
  let sentTimes = [];
  let lastHere = 0;
  let inboundWindow = 0;
  let inboundCount = 0;
  const post = (msg) => {
    try {
      port.postMessage(msg);
    } catch {
      // the tab went away; onDisconnect cleans up
    }
  };
  const closeTeam = () => {
    if (!team) return;
    team.close();
    team = null;
    post({ t: "team", state: null });
  };
  const leave = () => {
    closeTeam();
    roomGameId = roomName = secretKey = null;
    if (!room) return;
    const closing = room;
    room = null;
    try {
      closing.publish("bye", "", name);
    } catch {
      // sockets already closing
    }
    // Detach it now: for the 300 ms it lingers (and in its sockets' onclose), nothing
    // from the old room may reach this tab or count against the next room's budget.
    closing.onMessage = () => {};
    closing.onStatus = () => {};
    closing.accept = () => false;
    post({ t: "status", open: 0, total: CHAT_RELAYS.length });
    setTimeout(() => closing.close(), 300); // let "bye" out first
  };
  const announce = () => {
    if (!room) return;
    lastHere = Date.now();
    room.publish("here", "", name);
  };
  // Rate limit shared by the public and the team box: one message per 1.2 s, twelve a minute.
  const allowed = () => {
    const now = Date.now();
    sentTimes = sentTimes.filter((t) => now - t < 60000);
    return !(now - lastSent < CHAT_MIN_GAP_MS || sentTimes.length >= CHAT_PER_MINUTE);
  };
  const spend = () => {
    lastSent = Date.now();
    sentTimes.push(lastSent);
  };

  // The team channel follows the page's request AND the setting, both of which can
  // change mid-game; it lives and dies with the room it was made for.
  async function syncTeam() {
    const seq = joinSeq;
    const mine = room;
    if (!mine) return;
    const on = teamWanted && (await getSettings()).chatTeam !== false;
    if (seq !== joinSeq || room !== mine) return;
    if (!on) return closeTeam();
    if (team) return post({ t: "team", state: team.snapshot() });
    // what the team channel must not forget if this worker is restarted mid-game:
    // who I verified, which pairings were used up, the newest message per sender
    const slot = `chatTeam:${roomName}`;
    let saved = null;
    try {
      saved = (await chrome.storage.session.get(slot))[slot] ?? null;
    } catch {
      // no session storage: trust lasts as long as this connection
    }
    if (seq !== joinSeq || room !== mine || team) return;
    const made = OFR_TEAM.create({
      room: roomName,
      secretKey,
      saved,
      save: (state) => chrome.storage.session.set({ [slot]: state }).catch(() => {}),
      publish: (type, body) => (room === mine && team === made ? mine.publish(type, "", "", body).sent : 0),
      onState: (state) => team === made && post({ t: "team", state }),
      onMessage: (m) => team === made && post({ t: "team-msg", id: m.id, key: m.key, sid: m.sid, name: m.name, text: m.text, at: m.at }),
    });
    team = made;
    post({ t: "team", state: team.snapshot() });
  }

  port.onMessage.addListener(async (msg) => {
    if (msg?.t === "join") {
      leave();
      teamWanted = false; // the page says again for this game (its "team" message follows the join)
      const seq = ++joinSeq;
      const gameId = String(msg.gameId ?? "");
      if (!/^[A-Za-z0-9]{4,16}$/.test(gameId)) return;
      name = String(msg.name ?? "").slice(0, OFR_NOSTR.MAX_NAME);
      await chatConsentChecked; // an agreement to an older consent text does not count
      const settings = await getSettings();
      if (seq !== joinSeq) return;
      if (!settings.chatEnabled || !settings.chatConsent) return; // checked here too, not only in the page
      const key = await chatSecretKey(OFR_NOSTR.roomOf(gameId));
      if (seq !== joinSeq) return; // left, or joined another room, while we were reading storage
      post({ t: "me", pubkey: OFR_NOSTR.publicKeyOf(key) });
      let announced = false;
      roomGameId = gameId;
      roomName = OFR_NOSTR.roomOf(gameId);
      secretKey = key;
      room = new OFR_NOSTR.Room({
        relays: CHAT_RELAYS,
        room: roomName,
        secretKey: key,
        onStatus: (status) => {
          post({ t: "status", open: status.open.length, total: status.total });
          if (status.open.length && !announced) {
            announced = true;
            setTimeout(announce, 500);
          }
        },
        // Flood guard IN FRONT of the signature check: a Schnorr verify costs
        // milliseconds, and a hostile relay or room could send thousands.
        accept: () => {
          const now = Date.now();
          if (now - inboundWindow > 1000) {
            inboundWindow = now;
            inboundCount = 0;
          }
          return ++inboundCount <= CHAT_INBOUND_PER_SEC;
        },
        onMessage: (m) => {
          if (OFR_NOSTR.TEAM_TYPES.has(m.type)) team?.onEvent(m);
          else post({ t: m.type, id: m.id, pubkey: m.pubkey, name: m.name, text: m.text, at: m.at });
        },
      });
      syncTeam();
    } else if (msg?.t === "say") {
      if (!room) return post({ t: "sent", ok: false, why: "not connected" });
      const text = String(msg.text ?? "").trim().slice(0, OFR_NOSTR.MAX_TEXT);
      if (!text) return;
      if (!allowed()) return post({ t: "sent", ok: false, why: "slow down" });
      const { sent, event } = room.publish("msg", text, name);
      if (!sent) return post({ t: "sent", ok: false, why: "no relay reachable" });
      spend();
      post({ t: "sent", ok: true, id: event.id, text, at: event.created_at * 1000, relays: sent });
    } else if (msg?.t === "team") {
      teamWanted = msg.on === true;
      syncTeam();
    } else if (msg?.t === "team-feed") {
      // the page's view of the game (roster of my team, emojis between teammates), for this room's game only
      if (team && msg.data && msg.data.gameId === roomGameId) {
        team.feed(msg.data);
        team.tick(); // about once a second: keeps the 45 s hello on time
      }
    } else if (msg?.t === "team-verify") {
      team?.verify(String(msg.key ?? ""));
    } else if (msg?.t === "team-cancel") {
      team?.cancel();
    } else if (msg?.t === "team-say") {
      const mine = team;
      if (!room || !mine) return post({ t: "team-sent", ok: false, why: "not connected" });
      const text = String(msg.text ?? "").trim().slice(0, OFR_NOSTR.MAX_TEXT);
      if (!text) return;
      if (!allowed()) return post({ t: "team-sent", ok: false, why: "slow down" });
      const result = await mine.say(text);
      if (mine !== team) return; // left that game while encrypting
      if (result.ok) spend(); // a refused send does not use up the budget
      post({ t: "team-sent", ...result, text });
    } else if (msg?.t === "name") {
      name = String(msg.name ?? "").slice(0, OFR_NOSTR.MAX_NAME);
    } else if (msg?.t === "ping") {
      // Keeps this worker awake while a chat is open, and paces the presence beat.
      if (room && Date.now() - lastHere > CHAT_PRESENCE_MS) announce();
      team?.tick();
      post({ t: "pong" });
    } else if (msg?.t === "leave") {
      joinSeq++;
      leave();
    }
  });
  port.onDisconnect.addListener(() => {
    joinSeq++;
    leave();
  });
});

// Last thing a content script said about itself, so the popup can answer
// "is it even running?" without anyone reading a console log.
let lastReport = null;

function onMessage(msg, _sender, sendResponse) {
  if (msg?.type === "report") {
    lastReport = { ...msg.detail, url: msg.url, at: Date.now() };
    return false;
  }
  if (msg?.type === "clanLeaderboard") {
    lookupClanLeaderboard().then(sendResponse);
    return true;
  }
  if (msg?.type === "clan") {
    lookupClan(String(msg.tag ?? "")).then(sendResponse);
    return true;
  }
  if (msg?.type === "gameRecord") {
    fetchGameRecord(String(msg.gameId ?? ""))
      .catch((err) => ({ error: String(err?.message ?? err) }))
      .then(sendResponse);
    return true;
  }
  if (msg?.type === "notify") {
    // Only used when the OpenFront tab is in the background, so a watched
    // player joining your lobby still reaches you. Follows the same switch as
    // the sound ("Sound and notification"), checked here too.
    getSettings()
      .then((st) => {
        if (!st.enabled || !st.soundAlerts) return;
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: String(msg.title ?? "OpenFront Pro").slice(0, 80),
          message: String(msg.message ?? "").slice(0, 200),
        });
      })
      .catch(() => {});
    return false;
  }
  if (msg?.type === "openSettings") {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/popup.html") });
    return false;
  }
  if (msg?.type === "openWelcome") {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
    return false;
  }
  if (msg?.type === "getStatus") {
    // Reachability only: a neutral endpoint, nobody's name, and not at all
    // before the user has agreed to lookups.
    getSettings()
      .then((st) => (st.dataConsent && st.enabled ? fetch(`${OFSTATS_API}/clans`, { headers: { accept: "application/json" } }) : null))
      .then((res) => (res ? { ok: res.ok, probe: res.ok ? null : `HTTP ${res.status}` } : { ok: null, probe: "lookups are off" }))
      .catch((err) => ({ ok: false, probe: String(err) }))
      .then((api) =>
        sendResponse({
          version: chrome.runtime.getManifest().version,
          lastReport,
          api,
          lastInjectError,
        }),
      );
    return true;
  }
  if (msg?.type === "getSettings") {
    getSettings().then(sendResponse);
    return true;
  }
  if (msg?.type === "lookup") {
    const usernames = Array.isArray(msg.usernames) ? msg.usernames : [];
    Promise.all(
      usernames.map((username) =>
        lookup(username, msg.fresh === true).then((value) => [username, value]),
      ),
    ).then((entries) => sendResponse(Object.fromEntries(entries)));
    return true;
  }
  if (msg?.type === "clearCache") {
    memoryCache.clear();
    chrome.storage.local.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
      chrome.storage.local
        .remove(keys)
        .then(() => sendResponse({ cleared: keys.length }));
    });
    return true;
  }
  return false;
}

// Lookups leave the browser (ofstats, OpenFront's game API), so they wait for
// the user's agreement (src/welcome.html). Everything else is local.
const LOOKUP_MESSAGES = new Set(["lookup", "clan", "clanLeaderboard", "gameRecord"]);
let dataConsent = null; // null until storage has been read
const consentReady = chrome.storage.sync
  .get({ dataConsent: false })
  .then((r) => (dataConsent = r.dataConsent === true))
  .catch(() => (dataConsent = false));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.dataConsent) dataConsent = changes.dataConsent.newValue === true;
});
function refuseLookup(msg) {
  if (msg.type !== "lookup") return { error: "consent" };
  const names = Array.isArray(msg.usernames) ? msg.usernames : [];
  return Object.fromEntries(names.map((n) => [n, { found: false, reason: "consent" }]));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!LOOKUP_MESSAGES.has(msg?.type) || dataConsent === true) return onMessage(msg, sender, sendResponse);
  if (dataConsent === false) {
    sendResponse(refuseLookup(msg));
    return false;
  }
  consentReady.then(() => {
    if (dataConsent) onMessage(msg, sender, sendResponse);
    else sendResponse(refuseLookup(msg));
  });
  return true;
});
