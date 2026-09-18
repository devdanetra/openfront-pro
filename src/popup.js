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
  "chatEnabled",
  "chatInFfa",
  "chatFilter",
];
// <select> settings, saved by value rather than checked state.
const CHOICES = {
  profileLink: "dashboard",
  layout: "cards",
  uiSize: "medium",
  siteLayout: "default",
};
// Shown inside the page as the settings overlay (an iframe): fill its width.
if (window.top !== window) document.documentElement.classList.add("embedded");
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
  chatEnabled: false,
  chatInFfa: false,
  chatFilter: true,
};

// Switches that need more than a tick.
const EMBEDDED = window.top !== window;
const GUARDED = {
  // Chat talks to third parties and is public: it turns on only after an explicit
  // "I agree" to what that means, and never from the in-page settings overlay - a
  // page script could frame that and trick a click onto it.
  chatEnabled(input) {
    const box = document.getElementById("chat-consent");
    if (EMBEDDED) return lock(input, "chatEnabled-lock");
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
    document.getElementById("chat-agree").addEventListener("click", async () => {
      await chrome.storage.sync.set({ chatConsent: true, chatEnabled: true });
      input.checked = true;
      box.hidden = true;
    });
    document.getElementById("chat-cancel").addEventListener("click", () => (box.hidden = true));
  },
  chatInFfa(input) {
    if (EMBEDDED) return lock(input, "chatEnabled-lock");
    input.addEventListener("change", () => chrome.storage.sync.set({ chatInFfa: input.checked }));
  },
  // Writing to the clipboard without a click needs a permission; it is asked for
  // here, when the feature is switched on, instead of at install.
  autoCopyReport(input) {
    if (EMBEDDED) return lock(input, "autoCopy-lock");
    input.addEventListener("change", async () => {
      if (input.checked) {
        let granted = false;
        try {
          granted = await chrome.permissions.request({ permissions: ["clipboardWrite"] });
        } catch {
          granted = false;
        }
        if (!granted) input.checked = false;
      }
      chrome.storage.sync.set({ autoCopyReport: input.checked });
    });
  },
};
function lock(input, noteId) {
  input.disabled = true;
  input.closest("label")?.classList.add("off");
  const note = document.getElementById(noteId);
  if (note) note.hidden = false;
}

// Rank lookups wait for the user's agreement (welcome.html).
async function consentBanner() {
  const banner = document.getElementById("consent-banner");
  const { dataConsent } = await chrome.storage.sync.get({ dataConsent: false });
  banner.hidden = dataConsent === true;
  document.getElementById("consent-open").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
  });
  document.getElementById("consent-off").hidden = dataConsent !== true;
  document.getElementById("consent-off").addEventListener("click", async () => {
    await chrome.storage.sync.set({ dataConsent: false });
    location.reload();
  });
}

// Everything here reads storage and the network directly instead of going
// through the service worker: when badges are missing, the worker is one of the
// suspects, and a diagnostic that depends on the suspect is useless.

async function load() {
  let settings = DEFAULTS;
  try {
    settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  } catch {
    // fall back to defaults; the checkboxes still work
  }
  for (const key of KEYS) {
    const input = document.getElementById(key);
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
    const select = document.getElementById(key);
    select.value = choices[key];
    // A stored value with no matching option (e.g. "ofstats" from an older
    // version) would leave the select blank: fall back to the default.
    if (select.selectedIndex === -1) select.value = CHOICES[key];
    select.addEventListener("change", () =>
      chrome.storage.sync.set({ [key]: select.value }),
    );
  }
}

document.getElementById("clear").addEventListener("click", async () => {
  const button = document.getElementById("clear");
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

async function probeApi() {
  try {
    const r = await fetch("https://api.ofstats.io/clans", {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const d = await r.json();
    return { ok: (d?.gamesPlayed ?? 0) > 0 };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// Chrome lets the user restrict an extension to "on click" per site. Declared
// content scripts then do not run at all, which looks exactly like a broken
// extension: worker fine, API fine, page script silent.
async function siteAccess() {
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
  const button = document.getElementById("inject");
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
        files: ["src/themes.js", "src/scoring.js", "src/map-viewer.js", "src/charts.js", "src/dashboard.js", "src/recap.js", "src/chat.js", "src/content.js"],
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

document.getElementById("inject").addEventListener("click", injectNow);

async function status() {
  const el = document.getElementById("status");
  const lines = [`<b>v${esc(chrome.runtime.getManifest().version)}</b>`];

  const [worker, api, stored, site] = await Promise.all([
    pingWorker(),
    probeApi(),
    chrome.storage.local.get("lastReport").catch(() => ({})),
    siteAccess(),
  ]);

  lines.push(
    worker.ok
      ? '<span class="good">Worker: running</span>'
      : `<span class="bad">Worker: DOWN</span>\n${esc(worker.error)}`,
  );
  lines.push(
    api.ok
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
  const list = document.getElementById("watchlist");
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
  if (chosen === "classic") delete document.documentElement.dataset.ofrTheme;
  else document.documentElement.dataset.ofrTheme = chosen;
  // Classic IS the game's own colours, so there is nothing to recolour with.
  const blurb = document.getElementById("theme-blurb");
  if (blurb) blurb.textContent = themes[chosen]?.blurb ?? "";
  const site = document.getElementById("themeSite");
  if (site) {
    site.disabled = chosen === "classic";
    document.getElementById("themeSite-row")?.classList.toggle("off", chosen === "classic");
  }
  const icons = themes[chosen]?.icons ?? {};
  const badges = document.querySelectorAll(
    "#theme-preview .ofr-badge:not([data-ofr-kind='missing'])",
  );
  badges.forEach((badge, i) => {
    badge.textContent = PREVIEW_TEXT[i]?.(icons) ?? "";
  });
}

async function loadTheme() {
  const select = document.getElementById("theme");
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

load();
consentBanner();
loadTheme();
status();
renderWatchlist();
