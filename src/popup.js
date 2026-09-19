const KEYS = [
  "enabled",
  "showGames",
  "explainMissing",
  "showSummary",
  "markThreats",
  "showMapPreview",
  "showMapRank",
  "showForm",
  "flagSmurfs",
  "showRecap",
  "clanStats",
  "soundAlerts",
  "streamerMode",
  "autoCopyReport",
  "themeSite",
  "timelapse",
  "casterPanel",
  "chatEnabled",
  "chatInFfa",
  "chatFilter",
  "chatTeam",
];
// <select> settings, saved by value rather than checked state.
const CHOICES = {
  profileLink: "dashboard",
  layout: "cards",
  uiSize: "medium",
  siteLayout: "default",
};
// Where these settings are drawn: the popup's own document, or - in the Steam
// companion launcher, where there are no extension pages - a shadow root inside
// the game window (launcher sets __ofrSettingsRoot before running this file).
const ROOT = globalThis.__ofrSettingsRoot ?? document;
const IN_PAGE = ROOT !== document;
const byId = (id) => ROOT.getElementById(id);

// Shown inside the page as the settings overlay (an iframe): fill its width.
if (!IN_PAGE && window.top !== window) document.documentElement.classList.add("embedded");
const DEFAULTS = {
  enabled: true,
  showGames: true,
  explainMissing: true,
  showSummary: true,
  markThreats: true,
  showMapPreview: true,
  showMapRank: true,
  showForm: true,
  flagSmurfs: true,
  showRecap: true,
  clanStats: true,
  soundAlerts: true,
  streamerMode: false,
  autoCopyReport: false,
  themeSite: true,
  timelapse: true,
  casterPanel: true,
  chatEnabled: false,
  chatInFfa: false,
  chatFilter: true,
  chatTeam: true,
};

// Switches that need more than a tick.
// EMBEDDED: this page is inside a web page - framed on openfront.io, or mounted
// into the Steam build's game window by the companion launcher (IN_PAGE). A script
// on that page could cover it and steer a real click onto a switch, so what talks
// to third parties is never switched ON from here. Off always works.
const EMBEDDED = IN_PAGE || window.top !== window;
const GUARDED = {
  // Chat talks to third parties and is public: it turns on only after an explicit
  // "I agree" to what that means, and never from an embedded copy of this page.
  chatEnabled(input) {
    const box = byId("chat-consent");
    if (EMBEDDED) return offOnly(input, "chatEnabled", "chatEnabled-lock");
    input.addEventListener("change", async () => {
      if (!input.checked) {
        box.hidden = true;
        await chrome.storage.sync.set({ chatEnabled: false });
        return;
      }
      const { chatConsent } = await chrome.storage.sync.get({ chatConsent: false });
      if (chatConsent) return chrome.storage.sync.set({ chatEnabled: true });
      input.checked = false;
      refreshDeps();
      box.hidden = false;
    });
    byId("chat-agree").addEventListener("click", async (e) => {
      if (!e.isTrusted) return; // a person agreed, not a script
      await chrome.storage.sync.set({ chatConsent: true, chatEnabled: true });
      input.checked = true;
      refreshDeps();
      box.hidden = true;
    });
    byId("chat-cancel").addEventListener("click", () => (box.hidden = true));
  },
  chatInFfa(input) {
    if (EMBEDDED) return offOnly(input, "chatInFfa", "chatEnabled-lock");
    input.addEventListener("change", () => chrome.storage.sync.set({ chatInFfa: input.checked }));
  },
  // Writing to the clipboard without a click needs a permission; it is asked for
  // here, when the feature is switched on, instead of at install.
  autoCopyReport(input) {
    // The launcher's game window writes to the clipboard without a permission;
    // only a framed copy on openfront.io has to leave this to the toolbar popup.
    if (EMBEDDED && !IN_PAGE) return lock(input, "autoCopy-lock");
    input.addEventListener("change", async () => {
      if (input.checked) {
        let granted = false;
        try {
          // (no permissions API in the launcher: the game window decides by itself)
          granted = chrome.permissions ? await chrome.permissions.request({ permissions: ["clipboardWrite"] }) : true;
        } catch {
          granted = false;
        }
        if (!granted) input.checked = false;
      }
      chrome.storage.sync.set({ autoCopyReport: input.checked });
    });
  },
};
// On: can be switched off here. Off: locked, with a note saying where to switch it on.
function offOnly(input, key, noteId) {
  if (!input.checked) return lock(input, noteId);
  input.addEventListener("change", () => {
    if (input.checked) return void (input.checked = false);
    chrome.storage.sync.set({ [key]: false });
    lock(input, noteId);
  });
}
function lock(input, noteId) {
  input.disabled = true;
  input.closest("label")?.classList.add("off");
  const note = byId(noteId);
  if (note && IN_PAGE && noteId === "chatEnabled-lock") note.textContent = "Chat can only be switched on (and the free-for-all override changed) from the launcher's settings page in your browser - the address the launcher prints.";
  if (note) note.hidden = false;
}

// Rank lookups wait for the user's agreement (welcome.html).
async function consentBanner() {
  const banner = byId("consent-banner");
  const { dataConsent } = await chrome.storage.sync.get({ dataConsent: false });
  banner.hidden = dataConsent === true;
  byId("consent-open").addEventListener("click", () => {
    // An extension page can open the tab itself. The in-page overlays (the
    // launcher's especially) have no chrome.tabs: there the worker opens it.
    if (!IN_PAGE && typeof chrome.tabs?.create === "function") {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") }).catch(() => chrome.runtime.sendMessage({ type: "openWelcome" }).catch(() => {}));
    } else chrome.runtime.sendMessage({ type: "openWelcome" }).catch(() => {});
  });
  byId("consent-off").hidden = dataConsent !== true;
  byId("consent-off").addEventListener("click", async () => {
    await chrome.storage.sync.set({ dataConsent: false });
    if (IN_PAGE) globalThis.__ofrRemountSettings?.();
    else location.reload();
  });
}

// Most of this reads storage directly instead of going through the service
// worker: when badges are missing, the worker is one of the suspects. The one
// exception is the ofstats check, which asks the worker - it is the part that
// knows whether lookups were agreed to, and nothing may reach ofstats before.

async function load() {
  let settings = DEFAULTS;
  try {
    settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  } catch {
    if (IN_PAGE) {
      // The launcher's game window with the launcher closed: showing defaults as if
      // they were the settings, and dropping every change, would be worse than saying so.
      const note = document.createElement("p");
      note.className = "warn-note";
      note.textContent = "The launcher is not running, so the settings cannot be read or changed. Start it again, then reopen this.";
      (ROOT.querySelector(".top") ?? ROOT.firstElementChild)?.after(note);
      for (const input of ROOT.querySelectorAll("input, select, button")) input.disabled = true;
      return;
    }
    // fall back to defaults; the checkboxes still work
  }
  for (const key of KEYS) {
    const input = byId(key);
    input.checked = Boolean(settings[key]);
    if (GUARDED[key]) {
      GUARDED[key](input);
      continue;
    }
    input.addEventListener("change", () =>
      chrome.storage.sync.set({ [key]: input.checked }),
    );
  }
  let choices = CHOICES;
  try {
    choices = { ...CHOICES, ...(await chrome.storage.sync.get(CHOICES)) };
  } catch {
    // defaults
  }
  for (const key of Object.keys(CHOICES)) {
    const select = byId(key);
    select.value = choices[key];
    // A stored value with no matching option (e.g. "ofstats" from an older
    // version) would leave the select blank: fall back to the default.
    if (select.selectedIndex === -1) select.value = CHOICES[key];
    select.addEventListener("change", () =>
      chrome.storage.sync.set({ [key]: select.value }),
    );
  }
  // Presentation only: dim what an off switch makes moot, and say On/Off next to
  // the master switch. Nothing here changes a setting.
  for (const parent of new Set(Object.values(DEPENDS))) byId(parent)?.addEventListener("change", refreshDeps);
  byId("enabled")?.addEventListener("change", refreshDeps);
  refreshDeps();
}

// Settings that only matter while another one is on. Their rows are dimmed (not
// disabled: they stay operable) while it is off.
const DEPENDS = { chatFilter: "chatEnabled", chatTeam: "chatEnabled", chatInFfa: "chatEnabled", timelapse: "showRecap" };
function refreshDeps() {
  for (const [key, parent] of Object.entries(DEPENDS)) {
    const on = byId(parent)?.checked !== false;
    byId(key)?.closest("label")?.classList.toggle("dep-off", !on);
  }
  const master = byId("enabled-state");
  if (master) master.textContent = byId("enabled")?.checked ? "On" : "Off";
}

byId("clear").addEventListener("click", async () => {
  const button = byId("clear");
  try {
    const all = await chrome.storage.local.get(null);
    // Any generation of the cache ("ofs<N>:"): the prefix is bumped whenever the
    // cached shape changes, and this button must not silently fall behind it.
    const keys = Object.keys(all).filter((k) => /^ofs\d+:/.test(k));
    await chrome.storage.local.remove(keys);
    // The worker also holds a copy in memory; best effort, it may be asleep.
    chrome.runtime.sendMessage({ type: "clearCache" }).catch(() => {});
    button.textContent = `Cleared ${keys.length} entries`;
  } catch (err) {
    button.textContent = "Clear failed";
  }
  setTimeout(() => (button.textContent = "Clear cached ranks"), 1500);
});

function ago(ts) {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

// Chrome reports a dead worker by resolving undefined and setting lastError,
// rather than by rejecting — so the message has to be dug out explicitly.
async function pingWorker() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "getSettings" });
    if (res === undefined) {
      return { ok: false, error: chrome.runtime.lastError?.message ?? "no response" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// Always through the worker: it contacts ofstats only after the user agreed to
// lookups (this page used to fetch it directly, before any agreement - and read a
// field the endpoint does not have, so it reported FAILED while ofstats was fine).
// ok: true / false / null (not checked: lookups are off).
async function probeApi() {
  const st = await chrome.runtime.sendMessage({ type: "getStatus" }).catch(() => null);
  if (!st) return { ok: false, error: "the worker did not answer" };
  if (!st.api || st.api.ok === null) return { ok: null, error: st.api?.probe ?? "lookups are off" };
  return { ok: st.api.ok === true, error: st.api.probe ?? null };
}

// An unpacked extension serves its pages from disk but keeps the manifest and
// worker it was LOADED with until Reload is pressed on chrome://extensions. After
// the files are updated the two disagree, and new buttons talk to an old worker.
async function staleLoad() {
  if (IN_PAGE) return null;
  try {
    const onDisk = (await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).json())?.version;
    const running = chrome.runtime.getManifest().version;
    return typeof onDisk === "string" && onDisk !== running ? { onDisk, running } : null;
  } catch {
    return null;
  }
}

// Chrome lets the user restrict an extension to "on click" per site. Declared
// content scripts then do not run at all, which looks exactly like a broken
// extension: worker fine, API fine, page script silent.
async function siteAccess() {
  if (!chrome.permissions) return { granted: true };
  try {
    const granted = await chrome.permissions.contains({
      origins: ["https://openfront.io/*"],
    });
    return { granted };
  } catch (err) {
    return { granted: null, error: err?.message ?? String(err) };
  }
}

// Works around exactly that: inject into the tab the user is looking at.
// Asks Chrome for access to openfront.io again (the user may have set the site to
// "on click"), then injects the packaged scripts into the current tab.
async function injectNow() {
  const button = byId("inject");
  try {
    // Ask for the site once, rather than making the user inject on every page:
    // with the origin granted, the declared content script runs by itself and
    // the worker keeps injecting on navigation.
    const granted = await chrome.permissions.request({
      origins: ["https://openfront.io/*", "https://*.openfront.io/*"],
    });
    if (!granted) {
      button.textContent = "Permission declined";
      setTimeout(() => (button.textContent = "Enable on openfront.io"), 3000);
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes("openfront.io")) {
      button.textContent = "Enabled — open openfront.io";
    } else {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["src/content.css", "src/dashboard.css", "src/site-layouts.css", "src/page-themes.css"],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/themes.js", "src/scoring.js", "src/map-viewer.js", "src/charts.js", "src/dashboard.js", "src/timelapse.js", "src/recap.js", "src/chat.js", "src/observer-core.js", "src/caster.js", "src/content.js"],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/page-probe.js"],
        world: "MAIN",
      });
      button.textContent = "Enabled — reload the page";
      setTimeout(status, 1200);
    }
  } catch (err) {
    button.textContent = `Failed: ${err?.message ?? err}`;
  }
  setTimeout(() => (button.textContent = "Enable on openfront.io"), 3000);
}

if (IN_PAGE) byId("inject").hidden = true; // nothing to inject into: the launcher did that
else byId("inject").addEventListener("click", injectNow);

// One status line: a dot (ok true = green, false = red, "" = neutral, null = no
// dot), a label, a value on the right and optional detail lines under it. Every
// string goes in as textContent: reported values come from a content script
// running on a page we do not control.
function statusRow(ok, label, value, detail) {
  const row = document.createElement("div");
  row.className = "status-row";
  if (ok !== null) row.dataset.ok = ok === "" ? "" : String(ok);
  const dot = document.createElement("span");
  dot.className = "dot";
  const b = document.createElement("b");
  b.textContent = label;
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = value;
  row.append(dot, b, val);
  const nodes = [row];
  if (detail) {
    const d = document.createElement("div");
    d.className = "status-detail";
    d.textContent = detail;
    nodes.push(d);
  }
  return nodes;
}

async function status() {
  const el = byId("status");
  const rows = [statusRow(null, "Version", `v${chrome.runtime.getManifest().version}`)];

  const [worker, api, stored, site, stale] = await Promise.all([
    pingWorker(),
    probeApi(),
    chrome.storage.local.get("lastReport").catch(() => ({})),
    siteAccess(),
    staleLoad(),
  ]);

  if (stale) {
    rows.push(
      statusRow(false, "Files", `v${stale.onDisk} on disk, v${stale.running} running`,
        "Open chrome://extensions and press the reload arrow on OpenFront Pro, then reload the game tab."),
    );
  }

  rows.push(worker.ok ? statusRow(true, "Worker", "running") : statusRow(false, "Worker", "DOWN", String(worker.error)));
  rows.push(
    api.ok === null
      ? statusRow("", "ofstats.io", "not checked", String(api.error ?? "lookups are off"))
      : api.ok
        ? statusRow(true, "ofstats.io", "reachable")
        : statusRow(false, "ofstats.io", "FAILED", String(api.error ?? "?")),
  );

  if (site.granted === false) {
    rows.push(
      statusRow(false, "Site access", "withheld for openfront.io",
        'chrome://extensions → this card → Details → Site access → "On all sites".'),
    );
  }

  const r = stored?.lastReport;
  if (!r) {
    rows.push(statusRow(false, "Page script", "never reported", 'Press "Enable on openfront.io" below, then reload the page.'));
  } else if (r.crashed) {
    rows.push(statusRow(false, "Page script", "crashed", `${r.crashed} (line ${r.line})`));
  } else if (r.lookupFailed) {
    rows.push(statusRow(false, "Lookup", `failed for ${r.wanted ?? 0} names`, String(r.lookupFailed)));
  } else if (r.started) {
    rows.push(statusRow("", "Page script", `started ${ago(r.at)}`, "No lobby scanned yet."));
  } else {
    rows.push(
      statusRow(true, "Last scan", ago(r.at),
        `names ${r.scanned ?? 0} · ranked ${r.ranked ?? 0} · badges ${r.badgesOnPage ?? 0}` +
          `\nmap: ${r.map ? r.map : "not detected"}` +
          (r.placeholders ? `\nskipped (guest/hidden): ${r.placeholders}` : "") +
          (r.note ? `\n${r.note}` : "")),
    );
  }

  el.replaceChildren(...rows.flat());
}

// Starred players, with a remove button each. Built with DOM methods, not
// innerHTML: names are user-chosen strings.
async function renderWatchlist() {
  const list = byId("watchlist");
  let names = [];
  try {
    names = (await chrome.storage.sync.get({ watchlist: [] })).watchlist ?? [];
  } catch {
    // leave empty
  }
  list.replaceChildren();
  if (names.length === 0) {
    // the shared empty state (content.css .ofr-state), compact inside the list
    const li = document.createElement("li");
    li.className = "empty ofr-state ofr-state-compact";
    li.dataset.kind = "empty";
    const text = document.createElement("span");
    text.textContent = "No one yet. Shift+click a rank badge in a lobby to watch a player.";
    li.appendChild(text);
    list.appendChild(li);
    return;
  }
  for (const name of [...names].sort()) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `★ ${name}`;
    label.title = name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ofr-btn ofr-btn-icon ofr-btn-sm";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.title = `Remove ${name}`;
    remove.addEventListener("click", async () => {
      const next = names.filter((n) => n !== name);
      await chrome.storage.sync.set({ watchlist: next });
      renderWatchlist();
    });
    li.append(label, remove);
    list.appendChild(li);
  }
}

// Theme picker. The popup loads the same content.css and themes.js as the page,
// so the preview badges are rendered exactly the way they will look in a lobby.
// Same structure as content.js' badges: the main text, then an optional map
// segment (span.ofr-badge-seg), then the flags. The watched star comes from CSS.
const PREVIEW_TEXT = [
  { main: "Top 1%", seg: (i) => `${i.map ?? ""}0.5%`, flags: (i) => i.hot },
  { main: "Top 9%", flags: (i) => i.smurf },
  { main: "Top 23%" },
  { main: "Top 48%", flags: (i) => i.cold },
  { main: "Top 81%" },
  { main: "Top 12%" },
];

function previewTheme(theme) {
  const themes = globalThis.OFR_THEMES ?? {};
  const chosen = themes[theme] ? theme : "classic";
  // In the page the content script applies the theme (it listens to storage);
  // only the popup's own document needs it set here.
  if (!IN_PAGE) {
    if (chosen === "classic") delete document.documentElement.dataset.ofrTheme;
    else document.documentElement.dataset.ofrTheme = chosen;
  }
  // Classic IS the game's own colours, so there is nothing to recolour with.
  const blurb = byId("theme-blurb");
  if (blurb) blurb.textContent = themes[chosen]?.blurb ?? "";
  const site = byId("themeSite");
  if (site) {
    site.disabled = chosen === "classic";
    byId("themeSite-row")?.classList.toggle("off", chosen === "classic");
  }
  const icons = themes[chosen]?.icons ?? {};
  const badges = ROOT.querySelectorAll(
    "#theme-preview .ofr-badge:not([data-ofr-kind='missing'])",
  );
  badges.forEach((badge, i) => {
    const entry = PREVIEW_TEXT[i];
    if (!entry) return void badge.replaceChildren();
    const nodes = [document.createTextNode(entry.main)];
    const seg = entry.seg?.(icons);
    if (seg) {
      const s = document.createElement("span");
      s.className = "ofr-badge-seg";
      s.textContent = seg;
      nodes.push(s);
    }
    const flags = entry.flags?.(icons);
    if (flags) nodes.push(document.createTextNode(` ${flags}`));
    badge.replaceChildren(...nodes);
  });
}

async function loadTheme() {
  const select = byId("theme");
  const themes = globalThis.OFR_THEMES ?? {};
  for (const [id, theme] of Object.entries(themes)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = theme.label;
    select.appendChild(option);
  }
  let current = "classic";
  try {
    current = (await chrome.storage.sync.get({ theme: "classic" })).theme;
  } catch {
    // default
  }
  select.value = themes[current] ? current : "classic";
  previewTheme(select.value);
  select.addEventListener("change", () => {
    previewTheme(select.value);
    chrome.storage.sync.set({ theme: select.value });
  });
}

// Tabs; the last one used is remembered.
function tabs() {
  const buttons = [...ROOT.querySelectorAll(".tabs button[data-tab]")];
  const show = (name) => {
    for (const b of buttons) {
      const on = b.dataset.tab === name;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1; // one tab stop for the strip; arrows move within it
    }
    for (const pane of ROOT.querySelectorAll(".pane")) pane.dataset.on = String(pane.dataset.pane === name);
    postHeight();
  };
  const pick = (b) => {
    show(b.dataset.tab);
    chrome.storage.local.set({ popupTab: b.dataset.tab }).catch(() => {});
  };
  for (const b of buttons) {
    b.addEventListener("click", () => pick(b));
    b.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      const to = step
        ? buttons[(buttons.indexOf(b) + step + buttons.length) % buttons.length]
        : e.key === "Home" ? buttons[0] : e.key === "End" ? buttons.at(-1) : null;
      if (!to) return;
      e.preventDefault();
      pick(to);
      to.focus();
    });
  }
  show("look");
  // popup.html#chat opens on that tab (links from the page, screenshots)
  const wanted = IN_PAGE ? "" : location.hash.slice(1);
  if (!IN_PAGE) {
    window.addEventListener("hashchange", () => {
      const next = location.hash.slice(1);
      if (buttons.some((b) => b.dataset.tab === next)) show(next);
    });
  }
  if (buttons.some((b) => b.dataset.tab === wanted)) return show(wanted);
  chrome.storage.local.get({ popupTab: "look" }).then(
    (st) => show(buttons.some((b) => b.dataset.tab === st.popupTab) ? st.popupTab : "look"),
    () => {},
  );
}

// Framed on openfront.io (the in-page settings overlay): tell the page how tall
// the content is, so the box fits the active tab. Only a number is sent.
function postHeight() {
  if (IN_PAGE || window.top === window) return;
  const h = Math.ceil(document.body.getBoundingClientRect().height);
  if (h > 0) parent.postMessage({ ofrSettingsHeight: h }, "*");
}
if (!IN_PAGE && window.top !== window) {
  window.addEventListener("load", postHeight);
  if (typeof ResizeObserver === "function") new ResizeObserver(() => postHeight()).observe(document.body);
  // Keys pressed in here never reach the page, so its "Close (Esc)" hears Esc
  // this way. Only a boolean is sent.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) parent.postMessage({ ofrSettingsClose: true }, "*");
  });
}

tabs();
// Tools tab: each button opens one of the extension's own pages (the worker opens
// it, so this works from the toolbar popup, the in-page overlay and the launcher).
for (const button of ROOT.querySelectorAll("[data-open]")) {
  button.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    chrome.runtime.sendMessage({ type: "openPage", page: button.dataset.open }).catch(() => {});
  });
}
// The launcher's settings page (in your browser, never the copy inside the game
// window, which is what gets streamed): the overlay's OBS Browser Source address.
// It carries the launcher's secret key, so it is copied, not shown.
if (!IN_PAGE && document.documentElement.classList.contains("ofr-launcher") && byId("overlay-obs")) {
  byId("overlay-obs").hidden = false;
  byId("overlay-obs-copy").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    let ok = false;
    try {
      await navigator.clipboard.writeText(chrome.runtime.getURL("src/overlay.html") + "?bg=transparent");
      ok = true;
    } catch {
      ok = false;
    }
    b.dataset.state = ok ? "ok" : "error";
    b.textContent = ok ? "Copied ✓" : "Failed";
    setTimeout(() => {
      delete b.dataset.state;
      b.textContent = "Copy";
    }, 1800);
  });
}

load();
consentBanner();
loadTheme();
status();
renderWatchlist();
