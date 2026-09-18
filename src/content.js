// Guarded IIFE: the popup can inject this file manually when Chrome's
// "site access" setting stops the declared content script from running, and a
// second evaluation in the same isolated world would otherwise redeclare every
// top-level const. The body is left at its original indentation on purpose —
// the wrapper is scaffolding, not structure.
(() => {
if (globalThis.__ofrLoaded) return;
globalThis.__ofrLoaded = true;

// When the extension is reloaded or updated, the worker injects a fresh copy of
// this script into open tabs, in a new isolated world. The copy that was already
// running is not unloaded: its listeners and observers keep firing, with
// settings frozen at whatever they were and a chrome.* API that now throws. So
// every entry point checks alive() first and an orphan quietly stands down.
// (No runtime id at load = the test harness, which is always "alive".)
const HAD_RUNTIME_ID = Boolean(globalThis.chrome?.runtime?.id);
function alive() {
  try {
    return !HAD_RUNTIME_ID || Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

// Annotates player names with their public-game ranking — in the lobby list,
// on the in-game hover panel, and on the in-game leaderboard — plus a summary
// of the lobby as a whole.
//
// These are all Lit components that render into the light DOM (they call
// createRenderRoot() { return this }), so the names are reachable from a
// content script. Element properties set by the page are not, which is why
// names are read from text rather than from the component state.

const LOBBY_SELECTORS = [
  ".players-list .player-tag > span.text-white", // free-for-all + spectators
  ".players-list span.truncate.text-white", // assigned team cards
  ".players-list [class*='mb-1'][class*='text-xs'].text-white", // unassigned column
];

// The panel that follows the cursor over a territory, and the leaderboard in
// the left sidebar (a StatsTable of live players).
const INGAME_SELECTORS = [
  "player-info-overlay span.font-mono.inline-block",
  "player-stats .stats-table-row .stats-table-cell span.truncate",
];

const BADGE_CLASS = "ofr-badge";
const SUMMARY_CLASS = "ofr-summary";
const PREVIEW_CLASS = "ofr-map-preview";
const THREAT_CLASS = "ofr-threat";
const NAME_ATTR = "data-ofr-name";

let settings = {
  enabled: true,
  explainMissing: true,
  showGames: true,
  showSummary: true,
  markThreats: true,
  showMapPreview: true,
  showMapRank: true,
  showForm: true,
  flagSmurfs: true,
  showRecap: true,
  theme: "classic",
  themeSite: true,
  profileLink: "dashboard",
  clanStats: true,
  autoEmbargoTeams: false,
  streamerMode: false,
  soundAlerts: true,
  autoCopyReport: false,
  chatEnabled: false,
  chatDuringGame: true,
  chatFilter: true,
  layout: "cards",
  uiSize: "medium",
  siteLayout: "default",
};
let scheduled = false;

// Layout template and size, as attributes the stylesheets key on.
const LAYOUTS = new Set(["cards", "compact", "panel"]);
const SIZES = new Set(["small", "medium", "large", "xlarge"]);
function applyLayout() {
  const layout = LAYOUTS.has(settings.layout) ? settings.layout : "cards";
  if (layout === "cards") delete document.documentElement.dataset.ofrLayout;
  else document.documentElement.dataset.ofrLayout = layout;
  const size = SIZES.has(settings.uiSize) ? settings.uiSize : "medium";
  if (size === "medium") delete document.documentElement.dataset.ofrSize;
  else document.documentElement.dataset.ofrSize = size;
  // Whole-site template (site-layouts.css): wide | sidebar | focus.
  const site = SITE_LAYOUTS.has(settings.siteLayout) ? settings.siteLayout : "default";
  if (site === "default") delete document.documentElement.dataset.ofrSite;
  else document.documentElement.dataset.ofrSite = site;
}
const SITE_LAYOUTS = new Set(["default", "wide", "sidebar", "focus"]);

// The extension's settings, inside the page: the popup's own document in an
// iframe (it is an extension page, so it keeps full access to chrome.*). Opened
// from the account dropdown, the home card and the dashboard.
function openSettings() {
  document.querySelector(".ofr-settings")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "ofr-settings";
  const box = document.createElement("div");
  box.className = "ofr-settings-box";
  const head = document.createElement("div");
  head.className = "ofr-settings-head";
  const title = document.createElement("span");
  title.textContent = "OpenFront Pro settings";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "x";
  head.append(title, close);
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("src/popup.html");
  frame.title = "OpenFront Pro settings";
  box.append(head, frame);
  overlay.append(box);
  document.body.appendChild(overlay);

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      destroy();
    }
  };
  const destroy = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  document.addEventListener("keydown", onKey, true);
  close.addEventListener("click", destroy);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) destroy();
  });
}
globalThis.__ofrOpenSettings = openSettings;

// An extra entry in OpenFront's account dropdown. That menu only exists while
// it is open (and only for signed-in users), so this runs on every scan and
// adds the item whenever the menu is on screen without it. It borrows the
// classes of a neighbouring item so it looks native in any theme.
const MENU_ITEM_CLASSES =
  "w-full flex items-center gap-3 px-4 py-3 text-left text-sm font-medium normal-case tracking-normal cursor-pointer transition-colors text-white/80 hover:bg-white/10 hover:text-white";

function installAccountMenuItem() {
  const menu = document.querySelector('nav-account-menu [role="menu"]');
  if (!menu || menu.querySelector(".ofr-menu-item")) return;
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  const normal = items.find((i) => !/text-red/.test(i.className));
  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.className = `${normal?.className ?? MENU_ITEM_CLASSES} ofr-menu-item`;
  const iconEl = document.createElement("span");
  iconEl.className = "w-4 h-4 shrink-0";
  iconEl.textContent = "\u2699";
  const label = document.createElement("span");
  label.className = "min-w-0 break-words";
  label.textContent = "OpenFront Pro settings";
  item.append(iconEl, label);
  item.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // close their menu the way Escape does, then open ours
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    openSettings();
  });
  // keep a destructive last item (log out) last
  const last = items[items.length - 1];
  if (last && /text-red/.test(last.className)) last.insertAdjacentElement("beforebegin", item);
  else (items[0]?.parentElement ?? menu).appendChild(item);
}

function isSelf(name) {
  const me = selfName();
  return !!me && !!name && me.toLowerCase() === name.toLowerCase();
}

// Opens the Pro dashboard (dashboard.js) for a player, with their clan when
// the lobby has told us one.
function openDashboard(name) {
  if (typeof globalThis.__ofrOpenDashboard !== "function") return;
  // A guest handle ("AnonRelic3") or a hidden name is nobody in particular;
  // open the empty dashboard with its search box instead of looking it up.
  if (name && placeholderKind(name)) name = null;
  const entry = name ? roster.get(name.toLowerCase()) : null;
  globalThis.__ofrOpenDashboard(name ?? null, {
    clan: entry?.clan ?? null,
    clanStats: settings.clanStats,
    self: !!name && isSelf(name),
    streamer: settings.streamerMode,
  });
}

// The stats card on the front page, placed right under the username field.
// Only on the front page: inside a game there is no username field anyway.
function installHomeWidget() {
  if (currentGameId()) return;
  if (typeof globalThis.__ofrHomeWidget !== "function") return;
  // The username field sits in a horizontal strip (tag / name / "use
  // verified"). Putting the card inside that strip squeezed the name field down
  // to "T..."; it goes directly BELOW the strip instead, full width.
  // Walk up from the field to the first ancestor that sits in a column, so the
  // card becomes the next block below the whole strip (tag / name / verified)
  // rather than another item inside one of its rows.
  const anchor = document.querySelector("username-input");
  if (!anchor) return;
  let strip = anchor;
  while (
    strip.parentElement &&
    strip.parentElement !== document.body &&
    getComputedStyle(strip.parentElement).flexDirection !== "column"
  ) {
    strip = strip.parentElement;
  }
  const host = strip.parentElement;
  if (!host || host === document.body) return;
  const me = selfName();
  const name = me && !placeholderKind(me) ? me : null;
  globalThis.__ofrHomeWidget(host, name, {
    after: strip,
    streamer: settings.streamerMode,
    clan: name ? (roster.get(name.toLowerCase())?.clan ?? null) : null,
    clanStats: settings.clanStats,
  });
}

// A "Pro" button in OpenFront's nav bar. The nav is a Lit component that
// re-renders, so this is re-run on every scan and is a no-op when present.
//
// "Present" means the button THIS script instance made. After the extension is
// reloaded or updated, the worker re-injects into open tabs: the previous
// instance's button is still in the DOM, but its click handler belongs to an
// invalidated context (and, across versions, it may sit in the old spot). So
// any button that is not ours is removed and rebuilt, and an orphaned instance
// stands down instead of fighting the new one over the DOM.
let navButton = null;
function installNavButton() {
  if (!alive()) return;
  const nav = document.querySelector("desktop-nav-bar");
  if (!nav) return;
  if (navButton?.isConnected && nav.contains(navButton)) return;
  for (const stale of nav.querySelectorAll(".ofr-nav-btn")) stale.remove();
  const button = document.createElement("button");
  navButton = button;
  button.type = "button";
  button.className = "ofr-nav-btn";
  button.textContent = "PRO";
  button.title = "OpenFront Pro dashboard (unofficial)";
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation(); // the logo itself is a link home
    openDashboard(selfName());
  });

  // Preferred spot: inside the logo block (wordmark + version), as a small
  // tilted tag under the wordmark, so the header reads "OPENFRONT PRO". The
  // block is the nav's first child and holds the logo <img>.
  const logo = nav.querySelector("nav > div:first-child");
  if (logo?.querySelector("img")) {
    button.classList.add("ofr-logo-tag");
    logo.classList.add("ofr-logo-host");
    logo.appendChild(button);
    return;
  }
  // Fallback if the header changes shape: the old pill after the last nav link.
  const items = [...nav.querySelectorAll("a, button")];
  const clans = items.find((e) => /^\s*clans\s*$/i.test(e.textContent ?? ""));
  (clans?.parentElement ?? nav).appendChild(button);
}

// Theme icon sets come from themes.js (a content script loaded just before this
// one, in the same isolated world), so the popup's preview and the page agree.
const THEMES = globalThis.OFR_THEMES ?? {
  classic: {
    icons: { map: "\u{1F5FA}", hot: "\u{1F525}", cold: "❄", smurf: "⚠", star: "★", trophy: "\u{1F3C6}" },
  },
};

function icon(name) {
  return (THEMES[settings.theme] ?? THEMES.classic).icons[name];
}

// One theme for everything. <html data-ofr-theme> restyles what the extension
// draws (token blocks in content.css); <html data-ofr-page-theme>, set to the
// same id unless "Recolour OpenFront too" is off, restyles OpenFront itself
// (page-themes.css, generated from the same catalogue entry). Classic is the
// game's own look, so it sets neither.
function applyTheme() {
  const root = document.documentElement;
  const theme = THEMES[settings.theme] ? settings.theme : "classic";
  if (theme === "classic") delete root.dataset.ofrTheme;
  else root.dataset.ofrTheme = theme;
  if (theme !== "classic" && settings.themeSite !== false) root.dataset.ofrPageTheme = theme;
  else delete root.dataset.ofrPageTheme;
}

// Players you have starred (Shift+click a badge). Lowercased names, synced
// across your Chrome profiles like the other settings.
let watchlist = new Set();

// Everyone seen in this tab's lobby list. The in-game panels also cover bots
// and nations, whose generated names can collide with a real account's (a
// nation called "France", a player called "France"), and nothing in their
// markup reliably says which is which in every language and mode. The lobby
// roster does: anyone in it is a human who is actually in this game.
const roster = new Map(); // lowercased name -> { name, clan }

// Everything looked up so far this session, for the summary and threat marks.
const known = new Map(); // lowercased name -> info

// Names that identify nobody, so a rank on them would be a rank on a crowd:
//   - "Anon<Word><digit>" is the guest handle OpenFront generates for players
//     who never set one (genAnonUsername), shared by thousands of people.
//   - A "👤 " prefix is OpenFront's local "Hidden Names" setting, which
//     replaces every OTHER player's name with a tribe name on your screen. With
//     it on, your own name is the only real one left, so it is the usual reason
//     for "I only see a badge on myself".
const GUEST_NAME = /^Anon[A-Za-z]*\d*$/u;
const HIDDEN_PREFIX = "\u{1F464}";

function placeholderKind(username) {
  if (username.startsWith(HIDDEN_PREFIX)) return "hidden";
  if (GUEST_NAME.test(username)) return "guest";
  return null;
}

// Names are `[CLAN] username`; ofstats is keyed on the bare username, and
// badges (verified check, host tag, kick button) are separate elements, so
// only direct text nodes count.
function readNameParts(el) {
  let raw = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) raw += node.textContent;
  }
  raw = raw.replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const clanMatch = raw.match(/^\[([A-Za-z0-9]{1,5})\]\s*(.*)$/);
  const name = (clanMatch ? clanMatch[2] : raw).trim();
  if (!name) return null;
  return { name, clan: clanMatch ? clanMatch[1] : null };
}

function readName(el) {
  return readNameParts(el)?.name ?? null;
}

// Labels the lobby renders beside a name — "(host)", the kick "×", a team tag —
// which the fallback below would otherwise mistake for players.
const UI_CHROME = /^(\(.*\)|\[.*\]|[×x✕✖·•\-—]|\d+)$/u;

// Fallback for when the class names above stop matching — OpenFront is in
// alpha and its markup moves. Any element inside a players list that carries
// its own text and no text-bearing child element is a name cell, whatever it is
// called. The count header ("6 players • 3 nations") sits outside .players-list,
// so it is not picked up.
function scanPlayersList(list) {
  const cells = [];
  for (const el of list.querySelectorAll("span, div")) {
    if (el.querySelector(`.${BADGE_CLASS}`)) continue;
    if (
      el.classList.contains(BADGE_CLASS) ||
      el.classList.contains(SUMMARY_CLASS)
    ) {
      continue;
    }
    const own = readName(el);
    if (!own || UI_CHROME.test(own)) continue;
    // Prefer the innermost element holding the name.
    if ([...el.children].some((child) => readName(child))) continue;
    cells.push(el);
  }
  return cells;
}

// The viewer, so head-to-head has something to compare against. The lobby marks
// their own row; localStorage is the fallback once the lobby is gone.
function selfName() {
  const marked = document.querySelector(
    ".player-tag.current-player span.text-white",
  );
  const fromLobby = marked ? readName(marked) : null;
  if (fromLobby) return fromLobby;
  try {
    return localStorage.getItem("username");
  } catch {
    return null;
  }
}

function collectTargets() {
  const seen = new Set();
  const targets = [];

  const lobbyCells = [];
  for (const selector of LOBBY_SELECTORS) {
    lobbyCells.push(...document.querySelectorAll(selector));
  }
  if (lobbyCells.length === 0) {
    for (const list of document.querySelectorAll(".players-list")) {
      lobbyCells.push(...scanPlayersList(list));
    }
  }

  // The roster is whoever is in the lobby on screen *now*. Accumulating every
  // name ever seen in the tab leaked players from earlier lobbies into the
  // summary, the export and the recap. When no lobby list is visible (the game
  // has started) the last roster is kept: the in-game bot filter depends on it.
  const current = new Map();
  for (const el of lobbyCells) {
    if (seen.has(el)) continue;
    seen.add(el);
    // Closed lobby modals stay in the DOM with their lists; their cells have no
    // box and must not count as the lobby you are in.
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const parts = readNameParts(el);
    if (!parts) continue;
    const placeholder = placeholderKind(parts.name);
    if (!placeholder) current.set(parts.name.toLowerCase(), parts);
    targets.push({ el, username: parts.name, placeholder });
  }
  if (current.size > 0) {
    roster.clear();
    for (const [key, value] of current) roster.set(key, value);
  }

  const gameCells = [];
  for (const selector of INGAME_SELECTORS) {
    gameCells.push(...document.querySelectorAll(selector));
  }
  if (gameCells.length === 0) {
    for (const panel of document.querySelectorAll("player-info-overlay")) {
      gameCells.push(...scanPlayersList(panel).slice(0, 1));
    }
  }

  for (const el of gameCells) {
    if (seen.has(el)) continue;
    seen.add(el);
    const parts = readNameParts(el);
    if (!parts) continue;
    const placeholder = placeholderKind(parts.name);
    // Without a roster (extension enabled mid-game, or a lobby that was never
    // on screen) there is nothing to check against, so fall back to annotating
    // whatever ofstats knows.
    if (
      !placeholder &&
      roster.size > 0 &&
      !roster.has(parts.name.toLowerCase())
    ) {
      continue;
    }
    targets.push({ el, username: parts.name, placeholder });
  }

  return targets;
}

// Scoring is shared with the dashboard and share card (scoring.js, loaded just
// before this file in the same isolated world).
const {
  SHRINK_K,
  compactGames,
  skillRatio,
  topPercent,
  percentBand,
  formatPercent,
  ranked,
} = globalThis.OFR_SCORING;

// --- Per-map skill -----------------------------------------------------------
// ofstats keys map rows by display name ("New York City"); the probe reports the
// same display name, but compare loosely in case of spacing/case drift.
function mapKey(name) {
  return String(name ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

// Fewer games than this on one map says more about luck than about the player.
const MIN_MAP_GAMES = 5;

function mapRank(info) {
  const current = readMapInfo()?.map;
  if (!current || !Array.isArray(info?.maps)) return null;
  const row = info.maps.find((m) => mapKey(m.map) === mapKey(current));
  if (!row || row.games < MIN_MAP_GAMES || !(row.expectedWins > 0)) return null;
  const ratio = (row.wins + SHRINK_K) / (row.expectedWins + SHRINK_K);
  return { map: row.map, games: row.games, ratio, pct: topPercent(ratio) };
}

// --- Current form ------------------------------------------------------------
// Ranks are all-time; form says how they are playing *now*. "Hot" means clearly
// above their own norm over the last ten, not merely above average — a strong
// player winning as usual is not news.
const FORM_WINDOW = 10;

function form(info) {
  const recent = (info?.recentGames ?? []).slice(0, FORM_WINDOW);
  if (recent.length < FORM_WINDOW) return null;
  const wins = recent.filter((g) => g.won).length;
  const usual = (info.winRate ?? 0) / 100;
  const expected = usual * recent.length;
  const streak = info.streak ?? 0;
  const hot = streak >= 3 || (wins >= 3 && wins >= expected * 2);
  // Cold only for someone who normally wins at least one in ten.
  const cold = wins === 0 && expected >= 1;
  return { wins, n: recent.length, streak, hot, cold, byMode: winsByMode(recent) };
}

// "3 wins in the last 10" reads very differently when all three were team games
// (one side in a few) rather than free-for-alls (one player in dozens).
function modeKind(mode) {
  if (/team/i.test(mode ?? "")) return "team";
  if (/1v1|ranked/i.test(mode ?? "")) return "1v1";
  return "FFA";
}
function winsByMode(games) {
  const out = {};
  for (const g of games) {
    const k = modeKind(g.mode);
    out[k] ??= { wins: 0, games: 0 };
    out[k].games++;
    if (g.won) out[k].wins++;
  }
  return out;
}

// --- Trend sparkline ---------------------------------------------------------
// Win rate in blocks of six games, oldest to newest, drawn with block glyphs so
// it fits in a native tooltip (which cannot render markup).
const SPARK = "▁▂▃▄▅▆▇█";
const SPARK_BLOCK = 6;

function sparkline(info) {
  const games = [...(info?.recentGames ?? [])].reverse();
  if (games.length < SPARK_BLOCK * 3) return null;
  const rates = [];
  for (let i = 0; i + SPARK_BLOCK <= games.length; i += SPARK_BLOCK) {
    const block = games.slice(i, i + SPARK_BLOCK);
    rates.push(block.filter((g) => g.won).length / block.length);
  }
  // Scale to the player's own best block, so a 10% player's good week is still
  // visibly a peak rather than a flat line at the bottom.
  const top = Math.max(0.34, ...rates);
  return rates
    .map((r) => SPARK[Math.min(SPARK.length - 1, Math.round((r / top) * (SPARK.length - 1)))])
    .join("");
}

// --- Smurf check -------------------------------------------------------------
// The percentile deliberately shrinks small samples toward average, which is
// exactly what hides a strong player on a fresh account. So this looks at the
// raw, unshrunk ratio on a short history instead.
function smurf(info) {
  if (!(info?.expectedWins > 0)) return false;
  const raw = info.ratedWins / info.expectedWins;
  return info.ratedGames >= 5 && info.ratedGames <= 40 && raw >= 2.5;
}

function formatBadge(info) {
  if (!info?.found) return null;

  const rank = ranked(info);
  if (rank) {
    const parts = [`Top ${formatPercent(rank.pct)}%`];
    if (settings.showMapRank) {
      const onMap = mapRank(info);
      if (onMap) parts.push(`${icon("map")}${formatPercent(onMap.pct)}%`);
    }
    if (settings.showForm) {
      const f = form(info);
      if (f?.hot) parts.push(icon("hot"));
      else if (f?.cold) parts.push(icon("cold"));
    }
    if (settings.flagSmurfs && smurf(info)) parts.push(icon("smurf"));
    return {
      text: parts.join(" "),
      kind: "percentile",
      band: percentBand(rank.pct),
    };
  }

  // Too few rated games to place; say what little is known instead.
  if (typeof info.winRate !== "number") return null;
  const text = settings.showGames
    ? `${info.winRate.toFixed(1)}% WR · ${compactGames(info.games)}`
    : `${info.winRate.toFixed(1)}% WR`;
  return { text, kind: "winrate" };
}

// Why a name has no rank, so a blank space is never mistaken for a broken
// extension.
const MISSING_TEXT = {
  hidden: "hidden",
  guest: "guest",
  "no-history": "new",
  error: "?",
};

const MISSING_TOOLTIP = {
  hidden:
    'OpenFront’s "Hidden Names" setting is replacing this player’s name on your screen, so there is nothing to look up. Turn it off in OpenFront settings to see everyone.',
  guest:
    "A generated guest name (this player never set one). Thousands of players share these names, so no rank can belong to it.",
  "no-history": "No finished public games on ofstats.io yet.",
  error: "ofstats.io could not be reached. It will retry.",
};

function formatMissing(placeholder, info) {
  if (!settings.explainMissing) return null;
  const reason = placeholder ?? info?.reason ?? "error";
  const text = MISSING_TEXT[reason];
  if (!text) return null;
  return { text, kind: "missing", reason };
}

// Shared games between the viewer and this player, from the 60 most recent on
// each side — so it only fires for people you actually keep running into.
function headToHead(info) {
  const me = selfName();
  if (!me) return null;
  const mine = known.get(me.toLowerCase());
  if (!mine?.recentGames?.length || !info?.recentGames?.length) return null;
  if (mine === info) return null;

  const myGames = new Map(mine.recentGames.map((g) => [g.id, g.won]));
  let met = 0;
  let iWon = 0;
  let theyWon = 0;
  for (const g of info.recentGames) {
    if (!myGames.has(g.id)) continue;
    met++;
    if (myGames.get(g.id)) iWon++;
    if (g.won) theyWon++;
  }
  return met > 0 ? { met, iWon, theyWon } : null;
}

function tooltip(username, info) {
  const lines = [username];
  lines.push(
    `${info.wins} wins in ${info.games} public games (${info.winRate.toFixed(1)}%)`,
  );
  const rank = ranked(info);
  if (rank) {
    lines.push(
      `${rank.ratio.toFixed(2)}x the wins an average player would get in the same lobbies`,
    );
    lines.push(
      `(${info.ratedWins} wins vs ${info.expectedWins.toFixed(1)} expected over ${info.ratedGames} rated games)`,
    );
  }
  const onMap = mapRank(info);
  if (onMap) {
    lines.push(
      `On ${onMap.map}: Top ${formatPercent(onMap.pct)}% (${onMap.ratio.toFixed(2)}x over ${onMap.games} games)`,
    );
  }
  for (const mode of info.modes ?? []) {
    if (mode.games > 0) lines.push(`  ${mode.mode}: ${mode.wins}/${mode.games}`);
  }
  const f = form(info);
  if (f) {
    const note = f.hot ? " — on fire" : f.cold ? " — cold spell" : "";
    const run = f.streak >= 2 ? `, ${f.streak} wins in a row` : "";
    lines.push(`Form: ${f.wins} wins in last ${f.n}${run}${note}`);
    const split = Object.entries(f.byMode)
      .map(([k, v]) => `${k} ${v.wins}/${v.games}`)
      .join(", ");
    if (Object.keys(f.byMode).length > 1 || !f.byMode.FFA) lines.push(`  of those: ${split} (a team win counts like any other)`);
  }
  const spark = sparkline(info);
  if (spark) lines.push(`Trend (old → new): ${spark}`);
  if (smurf(info)) {
    lines.push(
      `${icon("smurf")} Possible smurf: ${info.ratedWins} wins vs ${info.expectedWins.toFixed(1)} expected in only ${info.ratedGames} games`,
    );
  }
  const h2h = headToHead(info);
  if (h2h) {
    lines.push(
      `Met ${h2h.met} time${h2h.met === 1 ? "" : "s"} recently — you won ${h2h.iWon}, they won ${h2h.theyWon}`,
    );
  }
  lines.push(
    watchlist.has(username.toLowerCase())
      ? `${icon("star")} On your watchlist — Shift+click to remove`
      : "Shift+click to add to your watchlist",
  );
  lines.push("Matched by name — click for their stats");
  return lines.join("\n");
}

function applyBadge(el, username, placeholder, info) {
  // Streamer mode: your own row shows no rank and your name is blurred, so a
  // stream or screenshot gives nothing away about you.
  if (settings.streamerMode && isSelf(username)) {
    el.querySelector(`:scope > .${BADGE_CLASS}`)?.remove();
    el.classList.add("ofr-streamer");
    el.setAttribute(NAME_ATTR, username);
    return;
  }
  el.classList.remove("ofr-streamer");
  const existing = el.querySelector(`:scope > .${BADGE_CLASS}`);
  const formatted = placeholder
    ? formatMissing(placeholder, info)
    : (formatBadge(info) ?? formatMissing(null, info));

  if (!formatted) {
    existing?.remove();
    el.setAttribute(NAME_ATTR, username);
    return;
  }

  const badge = existing ?? document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.dataset.ofrKind = formatted.kind;
  if (formatted.band) badge.dataset.ofrBand = formatted.band;
  else delete badge.dataset.ofrBand;
  if (formatted.reason) badge.dataset.ofrReason = formatted.reason;
  else delete badge.dataset.ofrReason;
  badge.textContent = formatted.text;
  badge.title =
    formatted.kind === "missing"
      ? `${username}\n${MISSING_TOOLTIP[formatted.reason] ?? ""}`
      : tooltip(username, info);

  if (formatted.kind === "missing") {
    delete badge.dataset.ofrProfile;
    badge.removeAttribute("role");
  } else {
    badge.dataset.ofrProfile = username;
    badge.setAttribute("role", "link");
  }
  if (watchlist.has(username.toLowerCase())) {
    badge.dataset.ofrWatched = "true";
    if (!badge.textContent.startsWith(icon("star"))) {
      badge.textContent = `${icon("star")} ${badge.textContent}`;
    }
  } else {
    delete badge.dataset.ofrWatched;
  }

  if (!existing) el.appendChild(badge);
  el.setAttribute(NAME_ATTR, username);
}

async function toggleWatch(name) {
  const key = name.toLowerCase();
  if (watchlist.has(key)) watchlist.delete(key);
  else watchlist.add(key);
  try {
    await chrome.storage.sync.set({ watchlist: [...watchlist] });
  } catch {
    // storage unavailable; the change still applies for this page
  }
  // Re-badge everything so the star shows (or goes) everywhere at once.
  for (const el of document.querySelectorAll(`[${NAME_ATTR}]`)) {
    el.removeAttribute(NAME_ATTR);
  }
  scheduleRefresh();
  toast(
    watchlist.has(key)
      ? `${icon("star")} Watching ${name}`
      : `Removed ${name} from your watchlist`,
  );
}

// A small transient message in the page's corner.
function toast(text, sticky = false) {
  const el = document.createElement("div");
  el.className = "ofr-toast";
  el.textContent = text;
  document.body.appendChild(el);
  if (!sticky) setTimeout(() => el.remove(), 4000);
  return el;
}

// --- Post-game recap -----------------------------------------------------------
// When the end-of-game screen appears, fetch OpenFront's record of the game:
// each player's elimination turn (absent for survivors) plus the winner gives
// the exact finishing order, which is then read against everyone's percentile.
const RECAP_CLASS = "ofr-recap";
const recapDone = new Set();

function winModalShown() {
  const modal = document.querySelector("win-modal");
  if (!modal) return false;
  for (const el of modal.querySelectorAll("div")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return true;
  }
  return false;
}

function currentGameId() {
  const match = location.pathname.match(/\/game\/([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

function checkRecap() {
  if (!settings.showRecap) return;
  const gameId = currentGameId();
  if (!gameId || recapDone.has(gameId) || !winModalShown()) return;
  recapDone.add(gameId);
  rememberPendingRecap(gameId);
  loadRecap(gameId);
}

// The visible <win-modal> box, so the recap can fold itself away instead of
// covering the game's own buttons.
function winModalRect() {
  const modal = document.querySelector("win-modal");
  if (!modal) return null;
  let best = null;
  for (const el of modal.querySelectorAll("div")) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.width >= window.innerWidth * 0.98) continue; // skip the backdrop
    if (!best || r.width * r.height > best.width * best.height) best = r;
  }
  return best;
}

// The panel itself, the analysis and the share image live in recap.js (a content
// script loaded before this one). This side knows who "me" is, what everyone's
// percentile is, and when to ask the worker for the record.
let recapWidget = null;
let lastRecap = null; // the model on screen
let lastRecord = null; // ...and the record behind it, to re-read when streamer mode flips
globalThis.__ofrRecapModel = () => lastRecap; // dev tools (tools/cdp-recap.mjs) read it from the isolated world
const RECAP_MIN_KEY = "recapCollapsed";

// Which client we are, per game (from the lobby modal or the running game, via
// page-probe.js), and our stable OpenFront public id once a record has shown it.
const myClientIds = new Map(); // gameId -> clientID
let myPublicId = null;
const PUBLIC_ID_KEY = "myPublicId";
try {
  chrome.storage.local.get(PUBLIC_ID_KEY).then((r) => {
    if (typeof r?.[PUBLIC_ID_KEY] === "string") myPublicId = r[PUBLIC_ID_KEY];
  });
} catch {
  // storage unavailable
}
function noteClientId() {
  const lobby = readMapInfo();
  const game = readGameState();
  const gameId = lobby?.lobbyId ?? currentGameId();
  const clientId = lobby?.clientId ?? game?.clientId ?? null;
  if (gameId && clientId) myClientIds.set(gameId, clientId);
  if (myClientIds.size > 20) myClientIds.delete(myClientIds.keys().next().value);
}

function recapContext(gameId = currentGameId()) {
  const raw = selfName();
  const me = raw && !placeholderKind(raw) ? raw.replace(/^\[[^\]]*\]\s*/u, "").trim().toLowerCase() : null;
  const lobby = readMapInfo();
  return {
    me,
    myClan: me ? (roster.get(me)?.clan ?? null) : null,
    myClientId: gameId ? (myClientIds.get(gameId) ?? null) : null,
    myPublicId,
    streamer: settings.streamerMode === true,
    map: lobby?.map ?? lastLobbyMap,
    mode: lobby?.mode ?? lastLobbyMode,
    pctOf: (name) => {
      const info = known.get(name);
      return info?.found ? (ranked(info)?.pct ?? null) : null;
    },
  };
}

// Percentiles for players the lobby scan never saw (they joined as the game
// started, or the lobby list was never on screen). Winner and award holders
// first; capped, because this fires for every finished game.
const RECAP_LOOKUP_CAP = 80;
async function lookupRecapPlayers(record, model) {
  const wanted = [];
  const add = (name) => {
    const key = name?.toLowerCase();
    if (!key || known.has(key) || placeholderKind(name) || wanted.includes(name)) return;
    wanted.push(name);
  };
  for (const p of record.players) if (p.winner) add(p.username);
  for (const a of model.awards ?? []) add(a.holder?.username);
  for (const p of record.players) if (p.active) add(p.username);
  const batch = wanted.slice(0, RECAP_LOOKUP_CAP);
  if (batch.length === 0) return false;
  try {
    const res = await chrome.runtime.sendMessage({ type: "lookup", usernames: batch });
    for (const [name, info] of Object.entries(res ?? {})) known.set(name.toLowerCase(), info);
    return true;
  } catch {
    return false; // worker asleep: the recap simply shows fewer badges
  }
}

// A game whose end screen this tab saw but whose record was not published yet.
// OpenFront archives a game when it ENDS; if you are eliminated at minute 8 of a
// 40-minute game and leave, the record arrives long after the panel is gone.
// The session line ("Today: 3 games...") would silently lose every such game, so
// they are parked here and settled later, without UI.
const PENDING_KEY = "recapPending";
const HOUR = 3600 * 1000;

async function readPending() {
  try {
    const list = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
async function writePending(list) {
  try {
    await chrome.storage.local.set({ [PENDING_KEY]: list.slice(-10) });
  } catch {
    // storage unavailable
  }
}
async function rememberPendingRecap(gameId) {
  const ctx = recapContext(gameId);
  if (!ctx.me && !ctx.myClientId) return;
  const list = await readPending();
  if (list.some((g) => g.gameId === gameId)) return;
  list.push({ gameId, me: ctx.me, clan: ctx.myClan, clientId: ctx.myClientId, at: Date.now() });
  await writePending(list);
}
async function forgetPendingRecap(gameId) {
  const list = await readPending();
  if (list.some((g) => g.gameId === gameId)) await writePending(list.filter((g) => g.gameId !== gameId));
}
async function resolvePendingRecaps(exceptId) {
  const R = globalThis.OFR_RECAP;
  if (!R || !alive()) return;
  for (const entry of await readPending()) {
    if (entry.gameId === exceptId) continue;
    if (Date.now() - entry.at > 24 * HOUR) {
      await forgetPendingRecap(entry.gameId);
      continue;
    }
    let record = null;
    try {
      record = await chrome.runtime.sendMessage({ type: "gameRecord", gameId: entry.gameId });
    } catch {
      return; // worker asleep; next time
    }
    if (!record?.players) continue; // still going
    const model = R.analyse(record, { me: entry.me, myClan: entry.clan, myClientId: entry.clientId ?? null, myPublicId, pctOf: () => null });
    rememberPublicId(model);
    await recordSession(model, entry.gameId, entry.at);
    await forgetPendingRecap(entry.gameId);
  }
}

// A record matched by client id tells us our stable public id. Only that match
// is trusted to set it: a name match could be somebody else with the same name.
function rememberPublicId(model) {
  if (model?.matchedBy !== "clientId" || !model.myPublicId || model.myPublicId === myPublicId) return;
  myPublicId = model.myPublicId;
  try {
    chrome.storage.local.set({ [PUBLIC_ID_KEY]: myPublicId }).catch(() => {});
  } catch {
    // extension reloaded under us
  }
}

// One finished game into today's session. Place and result need no lookups, so
// this runs the moment the record is in - closing the panel cannot lose it.
async function recordSession(model, gameId, seenAt = Date.now()) {
  if (model?.state !== "ok" || !model.me) return null; // spectated, or never spawned
  // Watching the replay of an old game also ends on the win screen. Only a game
  // that ended around the time this tab saw its end screen was played now.
  const ended = model.meta.endedAt;
  if (ended != null && Math.abs(seenAt - ended) > 3 * HOUR) return null;
  return recordGame({
    gameId,
    // An exact place only. Tied survivors and team games have none, and a made-up
    // one would poison the average.
    place: model.me.tied ? null : (model.me.place ?? null),
    total: model.meta.field,
    won: model.me.won === true,
    at: seenAt,
  });
}

async function loadRecap(gameId) {
  const R = globalThis.OFR_RECAP;
  if (!R) return;
  recapWidget?.destroy();
  // ...and any panel a previous copy of this script left behind (extension
  // reloaded on the end screen): its buttons are dead.
  for (const stale of document.querySelectorAll(`.${RECAP_CLASS}`)) stale.remove();
  let startMin = false;
  try {
    startMin = (await chrome.storage.local.get(RECAP_MIN_KEY))[RECAP_MIN_KEY] === true;
  } catch {
    // default: open
  }
  const widget = R.createWidget({
    icon,
    startMin,
    avoidRect: winModalRect,
    onDashboard: () => openDashboard(selfName()),
    onToggle: (min) => {
      if (alive()) chrome.storage.local.set({ [RECAP_MIN_KEY]: min }).catch(() => {});
    },
  });
  recapWidget = widget;
  document.body.appendChild(widget.el);
  const lobby = readMapInfo();
  const meta = [lobby?.map ?? lastLobbyMap, lobby?.mode ?? lastLobbyMode].filter(Boolean).join(" · ");
  const seenAt = Date.now();

  // OpenFront archives the record when the game ENDS. The win screen also shows
  // when you are eliminated while the game goes on, so the wait can be long:
  // quick tries first, then a slow poll for as long as this game is on screen.
  const QUICK = 12;
  const MAX = 72; // 1 min quick + ~30 min slow
  let errors = 0;
  for (let attempt = 1; ; attempt++) {
    if (!alive()) return; // orphaned by an extension reload: the new copy takes over
    if (!widget.el.isConnected) return; // closed (the pending entry keeps the session honest)
    if (currentGameId() !== gameId) {
      widget.destroy(); // left the game; nothing to wait for on this page
      return;
    }
    widget.setMessage(
      attempt <= 2
        ? "Fetching the game record…"
        : attempt <= QUICK
          ? `Waiting for OpenFront to publish this game (try ${attempt} of ${QUICK})…`
          : "Not published yet - OpenFront archives a game when it ends, so if it is still going this fills in afterwards.",
      { meta },
    );
    let record = null;
    try {
      record = await chrome.runtime.sendMessage({ type: "gameRecord", gameId });
    } catch {
      // worker asleep; retry
    }
    if (record?.players) {
      let model = R.analyse(record, recapContext(gameId));
      rememberPublicId(model);
      lastRecord = record;
      lastRecap = model;
      if (widget.el.isConnected) widget.setModel(model);
      await recordSession(model, gameId, seenAt);
      await forgetPendingRecap(gameId);
      if (model.state !== "ok") return;
      const meBefore = known.get(recapContext().me ?? "");
      if ((await lookupRecapPlayers(record, model)) && widget.el.isConnected && alive()) {
        model = R.analyse(record, recapContext(gameId));
        lastRecap = model;
        widget.setModel(model);
      }
      appendSelfProgress(widget, model, gameId, meBefore).catch(() => {});
      resolvePendingRecaps(gameId).catch(() => {});
      return;
    }
    if (record?.error) {
      if (++errors >= 3) {
        widget.setMessage(`OpenFront's API answered "${record.error}".`, { meta, retry: () => loadRecap(gameId) });
        return;
      }
    } else errors = 0;
    if (attempt >= MAX) {
      widget.setMessage("OpenFront never published a record for this game (single-player games are not archived).", {
        meta,
        retry: () => loadRecap(gameId),
      });
      return;
    }
    await new Promise((r) => setTimeout(r, attempt < QUICK ? 5000 : 30000));
  }
}

// The lobby's map and mode, remembered past the point where the lobby modal
// (and with it the probe's attribute) goes away at game start.
let lastLobbyMap = null;
let lastLobbyMode = null;

// "Stop trading with all" at the start of a team game, if enabled. The actual
// game action is sent by page-probe.js (it has to run in the page world); this
// side decides *whether*, once per game, and only for a lobby it saw as Team.
const embargoRequested = new Set();

function checkAutoEmbargo() {
  if (!settings.autoEmbargoTeams) return;
  const gameId = currentGameId();
  if (!gameId || embargoRequested.has(gameId)) return;
  if (lastLobbyMode !== "Team") return;
  if (!document.querySelector("player-panel")) return; // game not running yet
  embargoRequested.add(gameId);
  document.dispatchEvent(new CustomEvent("ofr:embargo-reset"));
  document.dispatchEvent(new CustomEvent("ofr:embargo-all"));
  report({ autoEmbargo: "requested", gameId });
}

// A short two-tone beep, from a file in the package. Browsers refuse audio
// before the page has been interacted with; the play() rejection is swallowed.
function playAlert() {
  if (!settings.soundAlerts) return;
  try {
    const audio = new Audio(chrome.runtime.getURL("sounds/alert.wav"));
    audio.volume = 0.5;
    audio.play().catch(() => {});
  } catch {
    // extension reloading
  }
}

// Copies the scouting report by itself when the lobby countdown reaches ten
// seconds, once per lobby. Off by default: it overwrites the clipboard.
const autoCopied = new Set();

function checkAutoCopy() {
  if (!settings.autoCopyReport) return;
  const lobby = readMapInfo();
  if (!lobby || typeof lobby.startsIn !== "number") return;
  const key = location.pathname;
  if (lobby.startsIn > 10 || autoCopied.has(key) || roster.size === 0) return;
  autoCopied.add(key);
  navigator.clipboard.writeText(lobbyReport()).then(
    () => toast("Scouting report copied to the clipboard"),
    () => toast("Could not copy the report (click the page first)"),
  );
}

// --- Session and percentile progress ----------------------------------------
// One record per finished game today, kept in extension storage, so the recap
// and the dashboard can show how the session is going and whether your
// percentile moved. A "session" is a calendar day.
const SESSION_KEY = "session";

async function loadSession() {
  const today = new Date().toDateString();
  try {
    const stored = (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY];
    if (stored && stored.day === today) return stored;
  } catch {
    // storage unavailable
  }
  return { day: today, games: [], startPct: null };
}

async function recordGame(entry) {
  const session = await loadSession();
  // A game settled late (see resolvePendingRecaps) may belong to yesterday.
  if (entry.at && new Date(entry.at).toDateString() !== session.day) return session;
  const existing = session.games.find((g) => g.gameId === entry.gameId);
  if (existing) {
    // the percentile arrives after the placing; fill it in, never overwrite
    for (const key of ["pctBefore", "pctAfter"]) if (entry[key] != null) existing[key] = entry[key];
  } else session.games.push(entry);
  if (session.startPct == null && entry.pctBefore != null) session.startPct = entry.pctBefore;
  try {
    await chrome.storage.local.set({ [SESSION_KEY]: session });
  } catch {
    // storage unavailable
  }
  return session;
}

// After the recap: your percentile before vs after the game (a fresh ofstats
// lookup, bypassing the cache), plus the running session line. Only for a game
// you actually played. The game itself is already in the session by now.
async function appendSelfProgress(widget, model, gameId, beforeInfo) {
  const me = selfName();
  if (!me || placeholderKind(me) || !model?.me) return;
  const key = me.toLowerCase();
  const before = beforeInfo?.found ? (ranked(beforeInfo)?.pct ?? null) : null;

  let after = null;
  let counted = false;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "lookup",
      usernames: [me],
      fresh: true,
    });
    const info = res?.[me];
    if (info?.found) {
      known.set(key, info);
      after = ranked(info)?.pct ?? null;
      // Has ofstats seen this game? Say so from the data, not from "the
      // percentile did not move" - with hundreds of games it often does not.
      counted =
        info.recentGames?.some((g) => g.id === gameId) === true ||
        (beforeInfo?.games != null && info.games > beforeInfo.games);
    }
  } catch {
    // worker unavailable; the session line still stands
  }

  const extra = [];
  if (before != null && after != null && !settings.streamerMode) {
    extra.push(
      Math.abs(after - before) >= 0.05
        ? `World rank: Top ${formatPercent(before)}% -> Top ${formatPercent(after)}%`
        : counted
          ? `World rank: Top ${formatPercent(before)}% (unchanged)`
          : `World rank: Top ${formatPercent(before)}% (ofstats has not counted this game)`,
    );
  }

  let session = await loadSession();
  if (session.games.some((g) => g.gameId === gameId)) {
    session = await recordGame({ gameId, pctBefore: before, pctAfter: after });
  }
  if (session.games.length) {
    const wins = session.games.filter((g) => g.won).length;
    const placed = session.games.filter((g) => g.place != null);
    const avgPlace = placed.length
      ? Math.round(placed.reduce((a, g) => a + g.place, 0) / placed.length)
      : null;
    let line = `Today: ${session.games.length} game${session.games.length === 1 ? "" : "s"}, ${wins} win${wins === 1 ? "" : "s"}`;
    if (avgPlace != null) line += `, avg place #${avgPlace}`;
    if (!settings.streamerMode && session.startPct != null && after != null && Math.abs(after - session.startPct) >= 0.05) {
      line += ` - rank Top ${formatPercent(session.startPct)}% -> Top ${formatPercent(after)}%`;
    }
    extra.push(line);
  }
  if (widget.el.isConnected) widget.setProgress(extra);
}

// Tell you when someone on your watchlist is in the lobby you are looking at.
// Once per player per lobby, and as a system notification too when the tab is
// in the background — which is when you would otherwise miss it.
const announced = new Set();

function announceWatched() {
  const lobby = location.pathname;
  for (const [key, entry] of roster) {
    if (!watchlist.has(key)) continue;
    const id = `${lobby}|${key}`;
    if (announced.has(id)) continue;
    announced.add(id);
    const info = known.get(key);
    const rank = info?.found ? ranked(info) : null;
    const text = `${icon("star")} ${entry.name} is in this lobby${rank ? ` (Top ${formatPercent(rank.pct)}%)` : ""}`;
    toast(text);
    playAlert();
    if (document.hidden) {
      try {
        chrome.runtime.sendMessage({
          type: "notify",
          title: "Watched player in your lobby",
          message: text,
        });
      } catch {
        // worker unavailable; the in-page toast still shows when you return
      }
    }
  }
}

// One delegated listener, rather than per-badge listeners that Lit would throw
// away on its next render.
// Delegated on window, capture phase: that is ahead of any document-level
// listener an older orphaned copy of this script left behind (see alive()), so
// stopPropagation() below also keeps the click away from it.
window.addEventListener(
  "click",
  (e) => {
    if (!alive()) return;
    const badge = e.target?.closest?.(`.${BADGE_CLASS}[data-ofr-profile]`);
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation(); // a lobby row would otherwise treat this as selecting

    if (e.shiftKey) {
      toggleWatch(badge.dataset.ofrProfile);
      return;
    }

    // If a second copy of this extension is installed, its listener runs in its
    // own isolated world and cannot see ours — but both see the DOM, so the
    // badge itself carries the "already handled" mark.
    // The mark is the event's own timestamp: both copies handle the same
    // dispatch, so it matches only that one physical click. (It used to be a
    // one-second window, from when a click opened a tab; with the in-page
    // dashboard that swallowed a quick close-and-click-again.)
    if (settings.profileLink === "none") return;
    const stamp = String(e.timeStamp);
    if (badge.dataset.ofrHandledEvt === stamp) return;
    badge.dataset.ofrHandledEvt = stamp;

    // A badge always opens the in-page stats. It used to be able to open the
    // player's ofstats.io page in a new tab instead; that route now lives only
    // as the "Open on ofstats.io" link inside the dashboard. A stored
    // profileLink of "ofstats" from an older version is treated as "dashboard".
    openDashboard(badge.dataset.ofrProfile);
  },
  true,
);

// Opens the zoom view. Delegated from the document in the capture phase rather
// than bound to the preview element: the lobby modal is a Lit component that
// re-renders around our node, and a listener on the node itself was not firing
// in the live page.
// The waiting screen for a joined game (join-lobby-modal) already shows the map,
// but as an 80x80 square crop next to its name. Clicking that opens the zoom
// view as well — it is where people look for the map.
const LOBBY_THUMBNAIL = "join-lobby-modal img[src*='/thumbnail.']";

window.addEventListener(
  "click",
  (e) => {
    if (!alive()) return;
    const preview =
      e.target?.closest?.(`.${PREVIEW_CLASS}`) ??
      e.target?.closest?.(LOBBY_THUMBNAIL);
    if (!preview) return;
    e.preventDefault();
    e.stopPropagation();
    const current = readMapInfo();
    // map-viewer.js is a separate content script in the same isolated world.
    if (current && typeof globalThis.__ofrOpenMapViewer === "function") {
      globalThis.__ofrOpenMapViewer(current);
    }
  },
  true,
);

function clearDecorations() {
  for (const el of document.querySelectorAll(
    `.${BADGE_CLASS}, .${SUMMARY_CLASS}, .${PREVIEW_CLASS}`,
  )) {
    // Badges inside the recap, the dashboard or the home card belong to those
    // views, not to a scan: a settings change must not strip them.
    if (el.closest(OUR_CONTAINERS)) continue;
    el.remove();
  }
  for (const el of document.querySelectorAll(`[${NAME_ATTR}]`)) {
    el.removeAttribute(NAME_ATTR);
  }
  for (const el of document.querySelectorAll(`.${THREAT_CLASS}`)) {
    el.classList.remove(THREAT_CLASS);
  }
  for (const el of document.querySelectorAll(".ofr-streamer")) {
    el.classList.remove("ofr-streamer");
  }
}

function averagePercent(infos) {
  const pcts = infos.map((i) => ranked(i)?.pct).filter((p) => p != null);
  if (pcts.length === 0) return null;
  return pcts.reduce((a, b) => a + b, 0) / pcts.length;
}

// How strong the room is, and how much of it is an unknown quantity.
// Clans with more than one player in the room, strongest first.
function clanGroups() {
  const clans = new Map();
  for (const [key, entry] of roster) {
    if (!entry.clan) continue;
    const info = known.get(key);
    if (!info?.found || !ranked(info)) continue;
    const list = clans.get(entry.clan) ?? [];
    list.push({ info, name: entry.name });
    clans.set(entry.clan, list);
  }
  return [...clans.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([tag, list]) => ({
      tag,
      n: list.length,
      avg: averagePercent(list.map((m) => m.info)),
      names: list.map((m) => m.name),
    }))
    .sort((a, b) => a.avg - b.avg);
}

function lobbySummary(withClans = true) {
  const infos = [];
  let unranked = 0;
  for (const key of roster.keys()) {
    const info = known.get(key);
    if (info?.found && ranked(info)) infos.push(info);
    else unranked++;
  }
  if (infos.length === 0) return null;

  const avg = averagePercent(infos);
  const elite = infos.filter(
    (i) => percentBand(ranked(i).pct) === "elite",
  ).length;

  const parts = [`avg Top ${formatPercent(avg)}%`];
  if (elite > 0) parts.push(`${elite} elite`);
  if (unranked > 0) parts.push(`${unranked} unranked`);

  if (withClans) {
    for (const g of clanGroups().slice(0, 3)) {
      parts.push(`[${g.tag}] x${g.n} Top ${formatPercent(g.avg)}%`);
    }
  }

  return parts.join(" · ");
}

// Closed lobby modals stay in the DOM with their player lists; decorating one of
// those puts the summary and preview somewhere with zero size. Use the list that
// is actually on screen.
function visiblePlayersList() {
  for (const list of document.querySelectorAll(".players-list")) {
    const r = list.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return list;
  }
  return null;
}

function renderSummary() {
  if (!settings.showSummary) return;
  const list = visiblePlayersList();
  if (!list) return;
  const text = lobbySummary(!settings.clanStats);
  const host = list.parentElement ?? list;
  let el = host.querySelector(`:scope > .${SUMMARY_CLASS}`);

  if (!text) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = SUMMARY_CLASS;
    const label = document.createElement("span");
    label.className = "ofr-summary-text";
    const copy = document.createElement("button");
    copy.className = "ofr-copy";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.title = "Copy this lobby's roster with ranks, formatted for Discord";
    el.append(label, copy);
    host.insertBefore(el, list);
  }
  el.querySelector(".ofr-summary-text").textContent = text;

  // Clan chips: click one to open the dashboard on that clan (via its strongest
  // player in the room), with the clan's own ofstats record.
  for (const chip of el.querySelectorAll(".ofr-clan-chip")) chip.remove();
  if (settings.clanStats) {
    const copy = el.querySelector(".ofr-copy");
    for (const g of clanGroups().slice(0, 4)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ofr-clan-chip";
      chip.textContent = `[${g.tag}] x${g.n} Top ${formatPercent(g.avg)}%`;
      chip.title = `Clan ${g.tag}: ${g.names.join(", ")} - click for clan stats`;
      chip.dataset.ofrClan = g.tag;
      chip.dataset.ofrLead = g.names[0];
      el.insertBefore(chip, copy);
    }
  }
}

window.addEventListener(
  "click",
  (e) => {
    if (!alive()) return;
    const chip = e.target?.closest?.(".ofr-clan-chip");
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof globalThis.__ofrOpenDashboard === "function") {
      globalThis.__ofrOpenDashboard(chip.dataset.ofrLead, {
        clan: chip.dataset.ofrClan,
        clanStats: true,
      });
    }
  },
  true,
);

// A scouting report for Discord: strongest first, with the numbers behind each
// rank and the flags the badges show.
function lobbyReport() {
  const info = readMapInfo();
  const rows = [];
  for (const [key, entry] of roster) {
    const data = known.get(key);
    const rank = data?.found ? ranked(data) : null;
    rows.push({ entry, data, rank });
  }
  rows.sort((a, b) => (a.rank?.pct ?? 999) - (b.rank?.pct ?? 999));

  const title = info
    ? `**OpenFront lobby — ${info.map}${info.mode ? ` (${info.mode})` : ""}**`
    : "**OpenFront lobby**";
  const lines = [title];
  const summary = lobbySummary();
  if (summary) lines.push(summary);
  lines.push("");

  rows.forEach(({ entry, data, rank }, i) => {
    const shown = settings.streamerMode && isSelf(entry.name) ? "You" : entry.name;
    const name = entry.clan ? `[${entry.clan}] ${shown}` : shown;
    if (!rank) {
      lines.push(`${i + 1}. ${name} — unranked`);
      return;
    }
    const extras = [];
    const onMap = mapRank(data);
    if (onMap) extras.push(`${onMap.map} Top ${formatPercent(onMap.pct)}%`);
    const f = form(data);
    if (f?.hot) extras.push("\u{1F525}");
    if (f?.cold) extras.push("❄");
    if (smurf(data)) extras.push("⚠ smurf?");
    if (watchlist.has(entry.name.toLowerCase())) extras.push("★");
    lines.push(
      `${i + 1}. ${name} — Top ${formatPercent(rank.pct)}% (${rank.ratio.toFixed(2)}x, ${compactGames(data.games)} games)` +
        (extras.length ? ` ${extras.join(" ")}` : ""),
    );
  });
  return lines.join("\n");
}

window.addEventListener(
  "click",
  async (e) => {
    if (!alive()) return;
    const button = e.target?.closest?.(".ofr-copy");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(lobbyReport());
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => (button.textContent = "Copy"), 1500);
  },
  true,
);

// Per-team averages, so you can see before the game starts whether your side is
// outmatched. Team cards are the rounded blocks inside the players list.
function renderTeamSummaries() {
  if (!settings.showSummary) return;
  for (const card of document.querySelectorAll(".players-list div.rounded-xl")) {
    const infos = [];
    for (const el of card.querySelectorAll(`[${NAME_ATTR}]`)) {
      const info = known.get(el.getAttribute(NAME_ATTR).toLowerCase());
      if (info?.found && ranked(info)) infos.push(info);
    }
    let el = card.querySelector(`:scope > .${SUMMARY_CLASS}`);
    if (infos.length < 2) {
      el?.remove();
      continue;
    }
    if (!el) {
      el = document.createElement("div");
      el.className = SUMMARY_CLASS;
      card.appendChild(el);
    }
    el.textContent = `team avg Top ${formatPercent(averagePercent(infos))}%`;
  }
}

// The strongest players in the room get their row outlined: the people worth
// not bordering early.
const THREAT_COUNT = 2;

function markThreats() {
  for (const el of document.querySelectorAll(`.${THREAT_CLASS}`)) {
    el.classList.remove(THREAT_CLASS);
  }
  if (!settings.markThreats) return;

  // Rank players, not elements: the same player appears in the lobby list, the
  // hover panel and the leaderboard, and all of their rows should light up.
  const byPlayer = new Map();
  for (const el of document.querySelectorAll(`[${NAME_ATTR}]`)) {
    const key = el.getAttribute(NAME_ATTR).toLowerCase();
    const info = known.get(key);
    const rank = info?.found ? ranked(info) : null;
    if (!rank) continue;
    const entry = byPlayer.get(key) ?? { pct: rank.pct, els: [] };
    entry.els.push(el);
    byPlayer.set(key, entry);
  }

  const top = [...byPlayer.values()]
    .sort((a, b) => a.pct - b.pct)
    .slice(0, THREAT_COUNT);
  for (const { pct, els } of top) {
    // Only a genuinely strong player is worth flagging; in a weak lobby nobody
    // should light up just for being the least bad.
    const band = percentBand(pct);
    if (band !== "elite" && band !== "strong") continue;
    for (const el of els) el.classList.add(THREAT_CLASS);
  }
}

// page-probe.js has to run in the PAGE world to see the asset manifest. The
// worker injects it, but that path fails whenever the worker is asleep or the
// tab was already open — so the content script also loads it as a <script>,
// which is what web_accessible_resources allows. The probe guards itself, so
// whichever arrives first wins and the second is a no-op.
function loadPageProbe() {
  try {
    if (document.querySelector("script[data-ofr-probe]")) return;
    const script = document.createElement("script");
    script.dataset.ofrProbe = "1";
    script.src = chrome.runtime.getURL("src/page-probe.js");
    script.onload = () => script.remove();
    (document.head ?? document.documentElement).appendChild(script);
  } catch {
    // getURL throws while the extension is reloading; the worker still injects
  }
}

// The lobby names the map but never shows it, so you are picking a spawn blind
// unless you already know the map. page-probe.js (page world) publishes the
// selected map and its content-hashed thumbnail URL here.
function readMapInfo() {
  const raw = document.documentElement.dataset.ofrMap;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- Chat (chat.js) ---------------------------------------------------------------
// Which room, under what name, and whether it may be used right now. The room is
// the lobby's id, which is also the game's id once it starts, so a lobby stays
// together. While you are alive in a running game the chat is paused (nothing is
// shown, nothing can be sent) unless "chat during the game" was switched on.
function readGameState() {
  try {
    return JSON.parse(document.documentElement.dataset.ofrGame ?? "null");
  } catch {
    return null;
  }
}

function syncChat() {
  const chat = globalThis.OFR_CHAT;
  if (!chat || !alive()) return;
  if (!settings.enabled || !settings.chatEnabled) {
    chat.sync({ enabled: false, gameId: null });
    return;
  }
  const lobby = readMapInfo(); // present only while a lobby modal is on screen
  const game = readGameState();
  const over = winModalShown();
  // Joining a lobby already moves the URL to /game/<id>, so either source names it.
  const lobbyId = lobby && !game?.running ? (lobby.lobbyId ?? currentGameId()) : null;
  const gameId = lobbyId ?? (game?.running || over ? currentGameId() : null);
  const playing = game?.running === true && (game.spawn === true || game.alive === true) && !over;
  const raw = selfName();
  const plain = raw ? raw.replace(/^\[[^\]]*\]\s*/u, "").trim() : "";
  const clan = plain ? roster.get(plain.toLowerCase())?.clan : null;
  chat.sync({
    enabled: true,
    gameId,
    // Streamer mode keeps your name off the screen; it stays off the wire too.
    name: settings.streamerMode || !plain ? "Player" : `${clan ? `[${clan}] ` : ""}${plain}`,
    mode: playing && !settings.chatDuringGame ? "paused" : "open",
    phase: lobbyId && !game?.running ? "lobby" : over || game?.alive === false ? "after" : "game",
    filter: settings.chatFilter !== false,
  });
}

function renderMapPreview() {
  const list = visiblePlayersList();
  const host = list?.parentElement;

  // Drop any preview left in a modal that has since closed.
  for (const stale of document.querySelectorAll(`.${PREVIEW_CLASS}`)) {
    if (stale.parentElement !== host) stale.remove();
  }
  let el = host?.querySelector(`:scope > .${PREVIEW_CLASS}`);

  const info = settings.showMapPreview ? readMapInfo() : null;
  if (!host || !info?.thumbnail) {
    el?.remove();
    return;
  }

  if (!el) {
    el = document.createElement("div");
    el.className = PREVIEW_CLASS;
    el.innerHTML =
      '<img alt="" referrerpolicy="no-referrer">' +
      '<div class="ofr-map-meta"></div>' +
      '<div class="ofr-map-zoom">Click to enlarge</div>';
    host.insertBefore(el, host.firstChild);
  }

  const img = el.querySelector("img");
  if (img.getAttribute("src") !== info.thumbnail) {
    img.setAttribute("src", info.thumbnail);
    img.alt = info.map;
  }

  const meta = [info.map];
  if (info.mode) meta.push(info.mode);
  if (info.difficulty) meta.push(info.difficulty);
  if (info.maxPlayers) meta.push(`${info.maxPlayers} players`);
  if (info.bots) meta.push(`${info.bots} tribes`);
  el.querySelector(".ofr-map-meta").textContent = meta.join(" · ");
}

// A one-line summary in the page console and in storage, so "I don't see any
// badges" can be answered with what the extension actually found.
let lastReport = "";

function report(detail) {
  const line = JSON.stringify(detail);
  if (line === lastReport) return;
  lastReport = line;
  console.log("[OpenFront Pro]", detail);
  // Written straight to storage rather than messaged to the worker: the popup
  // must still show this when the worker is the thing that is broken.
  try {
    chrome.storage.local.set({
      lastReport: { ...detail, url: location.href, at: Date.now() },
    });
  } catch {
    // extension reloading; the next scan reports again
  }
}

async function refresh() {
  if (!settings.enabled) return;
  const lobby = readMapInfo();
  if (lobby?.map) {
    lastLobbyMap = lobby.map;
    lastLobbyMode = lobby.mode ?? null;
  }
  noteClientId();
  checkRecap();
  checkAutoEmbargo();
  syncChat();
  installNavButton();
  installHomeWidget();
  installAccountMenuItem();
  const targets = collectTargets();
  renderMapPreview();
  if (targets.length === 0) {
    report({
      scanned: 0,
      playersLists: document.querySelectorAll(".players-list").length,
      hoverPanels: document.querySelectorAll("player-info-overlay").length,
      note: "no name cells found",
    });
    return;
  }

  // Lit reuses the same elements across re-renders, so an element may now hold
  // a different player; those need a fresh lookup even though they are stamped.
  const stale = targets.filter(
    (t) => t.el.getAttribute(NAME_ATTR) !== t.username,
  );
  if (stale.length === 0) return;
  for (const { el } of stale) {
    el.querySelector(`:scope > .${BADGE_CLASS}`)?.remove();
  }

  // A placeholder name is answered locally — no request for a name that cannot
  // belong to anyone.
  for (const target of stale.filter((t) => t.placeholder)) {
    if (target.el.isConnected) {
      applyBadge(target.el, target.username, target.placeholder, null);
    }
  }

  const lookups = stale.filter((t) => !t.placeholder);
  const usernames = [...new Set(lookups.map((t) => t.username))];
  // The viewer's own history is what head-to-head compares against, so fetch it
  // even when they are not among the names being scanned.
  const me = selfName();
  if (me && !placeholderKind(me) && !known.has(me.toLowerCase())) {
    usernames.push(me);
  }
  if (usernames.length === 0) return;

  let results;
  try {
    results = await chrome.runtime.sendMessage({ type: "lookup", usernames });
  } catch (err) {
    // The worker does the fetching (ofstats sends no CORS header, so a
    // page-context fetch cannot), which makes a dead worker fatal — say so.
    report({
      lookupFailed: err?.message ?? String(err),
      wanted: usernames.length,
    });
    return;
  }
  if (!results) {
    report({
      lookupFailed:
        chrome.runtime.lastError?.message ?? "worker returned nothing",
      wanted: usernames.length,
    });
    return;
  }

  for (const [name, info] of Object.entries(results)) {
    known.set(name.toLowerCase(), info);
  }

  for (const { el, username } of lookups) {
    if (!el.isConnected) continue;
    if (readName(el) !== username) continue; // re-rendered mid-flight
    applyBadge(el, username, null, results[username]);
  }

  renderSummary();
  renderTeamSummaries();
  renderMapPreview();
  markThreats();
  announceWatched();

  report({
    scanned: targets.length,
    lookedUp: usernames.length,
    ranked: usernames.filter((n) => results[n]?.found).length,
    placeholders: stale.filter((t) => t.placeholder).length,
    noData: usernames.filter((n) => results[n]?.reason === "no-history"),
    errors: usernames.filter((n) => results[n]?.reason === "error"),
    badgesOnPage: document.querySelectorAll(`.${BADGE_CLASS}`).length,
    map: readMapInfo()?.map ?? null,
  });
}

function scheduleRefresh() {
  if (!alive()) {
    observer.disconnect();
    mapObserver.disconnect();
    return;
  }
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    refresh();
  }, 200);
}

const OUR_CONTAINERS = ".ofr-recap, .ofr-dash, .ofr-settings, .ofr-home, .ofr-viewer, .ofr-chat-host";
function isOurMutation(mutation) {
  if (mutation.target?.nodeType === Node.ELEMENT_NODE && mutation.target.closest(OUR_CONTAINERS)) return true;
  const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return (
    nodes.length > 0 &&
    nodes.every(
      (n) =>
        n.nodeType === Node.ELEMENT_NODE &&
        (n.classList?.contains(BADGE_CLASS) ||
          n.classList?.contains(SUMMARY_CLASS) ||
          n.classList?.contains(PREVIEW_CLASS) ||
          n.classList?.contains("ofr-home") ||
          n.classList?.contains("ofr-menu-item") ||
          n.classList?.contains("ofr-nav-btn") ||
          n.classList?.contains("ofr-settings") ||
          n.classList?.contains("ofr-dash") ||
          n.classList?.contains("ofr-recap") ||
          n.classList?.contains("ofr-chat-host") ||
          n.classList?.contains("ofr-toast")),
    )
  );
}

const observer = new MutationObserver((mutations) => {
  if (mutations.every(isOurMutation)) return;
  scheduleRefresh();
});

// The map can change without the player list changing (the host switches maps),
// and page-probe.js signals that by rewriting this attribute.
const mapObserver = new MutationObserver(() => {
  if (!alive()) return;
  noteClientId();
  syncChat(); // the lobby id and the playing / out state both arrive this way
  renderMapPreview();
  checkAutoCopy();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.watchlist) {
    watchlist = new Set(changes.watchlist.newValue ?? []);
  }
  for (const [key, change] of Object.entries(changes)) {
    if (key in settings) settings[key] = change.newValue;
  }
  if (changes.theme || changes.themeSite) applyTheme();
  if (changes.theme) recapWidget?.refresh();
  if (changes.enabled || changes.chatEnabled || changes.chatDuringGame || changes.chatFilter || changes.streamerMode) syncChat();
  if (changes.streamerMode && lastRecord && recapWidget?.el.isConnected && globalThis.OFR_RECAP) {
    lastRecap = globalThis.OFR_RECAP.analyse(lastRecord, recapContext());
    recapWidget.setModel(lastRecap);
  }
  if (changes.layout || changes.uiSize || changes.siteLayout) applyLayout();
  clearDecorations();
  if (settings.enabled) scheduleRefresh();
});

(async function init() {
  try {
    const loaded = await chrome.runtime.sendMessage({ type: "getSettings" });
    if (loaded) settings = { ...settings, ...loaded };
  } catch {
    // keep defaults
  }
  try {
    const stored = await chrome.storage.sync.get({ watchlist: [] });
    watchlist = new Set(stored.watchlist ?? []);
  } catch {
    // no watchlist this session
  }

  applyTheme();
  applyLayout();
  installNavButton();
  installHomeWidget();
  // games whose end screen an earlier page saw before OpenFront archived them
  if (settings.showRecap) resolvePendingRecaps(currentGameId()).catch(() => {});

  let version = "?";
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    // getManifest is unavailable outside a real extension (e.g. test/)
  }

  loadPageProbe();
  observer.observe(document.body, { childList: true, subtree: true });
  mapObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-ofr-map", "data-ofr-game"],
  });
  console.log(
    `[OpenFront Pro] v${version} active on ${location.host} — settings:`,
    settings,
  );
  report({ started: true, version, url: location.href });
  scheduleRefresh();
})();

// A crash in a scan would otherwise be silent; surface it in the popup.
window.addEventListener("error", (e) => {
  if (e.filename?.includes("content.js")) {
    report({ crashed: String(e.message), line: e.lineno });
  }
});

})();
