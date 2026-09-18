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
      box.hidden = false;
    });
    byId("chat-agree").addEventListener("click", async (e) => {
      if (!e.isTrusted) return; // a person agreed, not a script
      await chrome.storage.sync.set({ chatConsent: true, chatEnabled: true });
      input.checked = true;
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

// Reported values originate in a content script running on a page we do not
// control, so nothing from them reaches innerHTML unescaped.
function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
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
        files: ["src/themes.js", "src/scoring.js", "src/map-viewer.js", "src/charts.js", "src/dashboard.js", "src/timelapse.js", "src/recap.js", "src/chat.js", "src/content.js"],
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

async function status() {
  const el = byId("status");
  const lines = [`<b>v${esc(chrome.runtime.getManifest().version)}</b>`];

  const [worker, api, stored, site, stale] = await Promise.all([
    pingWorker(),
    probeApi(),
    chrome.storage.local.get("lastReport").catch(() => ({})),
    siteAccess(),
    staleLoad(),
  ]);

  if (stale) {
    lines.push(
      `<span class="bad">Files updated to v${esc(stale.onDisk)}, but Chrome still runs v${esc(stale.running)}.</span>\nOpen chrome://extensions and press the reload arrow on OpenFront Pro, then reload the game tab.`,
    );
  }

  lines.push(
    worker.ok
      ? '<span class="good">Worker: running</span>'
      : `<span class="bad">Worker: DOWN</span>\n${esc(worker.error)}`,
  );
  lines.push(
    api.ok === null
      ? `<span>ofstats.io: not checked</span> (${esc(api.error ?? "lookups are off")})`
      : api.ok
        ? '<span class="good">ofstats.io: reachable</span>'
        : `<span class="bad">ofstats.io: FAILED</span>\n${esc(api.error ?? "?")}`,
  );

  if (site.granted === false) {
    lines.push(
      '<span class="bad">Site access: withheld for openfront.io.</span>\nchrome://extensions → this card → Details → Site access → "On all sites".',
    );
  }

  const r = stored?.lastReport;
  if (!r) {
    lines.push(
      '<span class="bad">Page script: never reported.</span>\nPress "Enable on openfront.io" below, then reload the page.',
    );
  } else if (r.crashed) {
    lines.push(
      `<span class="bad">Page script crashed:</span>\n${esc(r.crashed)} (line ${esc(r.line)})`,
    );
  } else if (r.lookupFailed) {
    lines.push(
      `<span class="bad">Lookup failed for ${esc(r.wanted ?? 0)} names:</span>
${esc(r.lookupFailed)}`,
    );
  } else if (r.started) {
    lines.push(`Page script: started ${ago(r.at)}, no lobby scanned yet.`);
  } else {
    lines.push(
      `Last scan ${ago(r.at)}:\nnames ${esc(r.scanned ?? 0)} · ranked ${esc(r.ranked ?? 0)} · badges ${esc(r.badgesOnPage ?? 0)}` +
        `\nmap: ${r.map ? esc(r.map) : "not detected"}` +
        (r.placeholders ? `\nskipped (guest/hidden): ${esc(r.placeholders)}` : "") +
        (r.note ? `\n${esc(r.note)}` : ""),
    );
  }

  el.innerHTML = lines.join("\n");
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
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No one yet";
    list.appendChild(li);
    return;
  }
  for (const name of [...names].sort()) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `★ ${name}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "✕";
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
const PREVIEW_TEXT = [
  (i) => `Top 1% ${i.map}0.5% ${i.hot}`,
  (i) => `Top 9% ${i.smurf}`,
  (i) => "Top 23%",
  (i) => `Top 48% ${i.cold}`,
  (i) => "Top 81%",
  (i) => `${i.star} Top 12%`,
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
    badge.textContent = PREVIEW_TEXT[i]?.(icons) ?? "";
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
    for (const b of buttons) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    for (const pane of ROOT.querySelectorAll(".pane")) pane.dataset.on = String(pane.dataset.pane === name);
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      show(b.dataset.tab);
      chrome.storage.local.set({ popupTab: b.dataset.tab }).catch(() => {});
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

tabs();
load();
consentBanner();
loadTheme();
status();
renderWatchlist();
