#!/usr/bin/env node
"use strict";
// OpenFront Pro companion launcher for the Steam (Electron) build of OpenFront.
//
// The Steam build cannot load browser extensions. This program runs the SAME
// extension code against it from the outside, through Chromium's DevTools
// protocol, without touching a single file of the game:
//
//   1. starts the game through Steam with --remote-debugging-port (the game
//      relaunches itself through Steam, so the flag has to go in that way);
//   2. attaches to the game window and runs the extension's content scripts in an
//      ISOLATED world (same isolation a browser gives content scripts) and
//      src/page-probe.js in the page's main world;
//   3. plays the part of the extension's service worker: src/background.js runs
//      here, in a node:vm context, behind a small stand-in for the chrome.* APIs
//      (storage in a JSON file, runtime messages and ports over a CDP binding);
//   4. serves the popup / first-run page on 127.0.0.1 so settings open in your
//      normal browser.
//
// Read-only, like the extension: it reads the game's pages and draws panels; it
// never sends a game action. Requires Node 22+ (global fetch and WebSocket).
//
//   node launcher/openfront-pro-launcher.cjs            start the game and attach
//   node launcher/openfront-pro-launcher.cjs --attach   attach only (game already
//                                                       running with the flag)
//   --port=9322    debugging port (loopback only)
//
// KNOW THE RISKS (see launcher/README.md): a debugging port lets any program on
// this computer drive the game window while it is open, and OpenFront's terms
// restrict third-party software - using this on your Steam account is your call.
const { spawn, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

// Two ways to run: from the repository (files read from disk), or as the single
// executable built by tools/build-launcher.mjs, where the extension's files are
// embedded as assets (node:sea). Everything below reads through asset().
let sea = null;
try {
  const s = require("node:sea");
  if (s.isSea()) sea = s;
} catch {
  // not a single-executable build
}
const ROOT = sea ? null : path.resolve(__dirname, "..");
const SEA_KEYS = sea ? new Set(JSON.parse(Buffer.from(sea.getAsset("__index.json")).toString("utf8"))) : null;
function hasAsset(rel) {
  if (sea) return SEA_KEYS.has(rel);
  const file = path.join(ROOT, rel);
  return file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile();
}
function asset(rel) {
  return sea ? Buffer.from(sea.getAsset(rel)) : fs.readFileSync(path.join(ROOT, rel));
}
const text = (rel) => asset(rel).toString("utf8");
const APP_ID = "3560670";
// Where the game lives. Overridable ONLY for tools/test-launcher-bridge.mjs, which
// points the launcher at a stand-in page in a headless Chrome.
const GAME_PREFIX = process.env.OFR_LAUNCHER_TEST_ORIGIN || "app://openfront";
const WORLD = "OpenFront Pro";
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const CDP_PORT = Number(args.port ?? 9322);
const manifest = JSON.parse(text("manifest.json").replace(new RegExp("^" + String.fromCharCode(0xfeff)), ""));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

if (typeof WebSocket !== "function" || typeof fetch !== "function") {
  console.error("Node 22 or newer is required (global WebSocket and fetch).");
  process.exit(1);
}

process.on("uncaughtException", (err) => console.error("[launcher] unexpected error (continuing):", err?.stack ?? err));
process.on("unhandledRejection", (err) => console.error("[launcher] unhandled rejection (continuing):", err?.stack ?? err));

async function main() {
// ---- storage: chrome.storage.* in a JSON file ---------------------------------------------
const DATA_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), ".config"), "openfront-pro-launcher");
const STORE_FILE = path.join(DATA_DIR, "storage.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
// Null-prototype areas and own-key checks: a key called "__proto__" or
// "constructor" is just a key, never the object's machinery.
const bare = (o) => Object.assign(Object.create(null), o && typeof o === "object" ? o : {});
let store = { sync: bare(), local: bare() };
if (fs.existsSync(STORE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    store = { sync: bare(saved.sync), local: bare(saved.local) };
  } catch (err) {
    // Damaged (a crash mid-write, a disk problem). Keep it for the user instead of
    // silently overwriting their settings and consent with a fresh file.
    const kept = `${STORE_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(STORE_FILE, kept);
    } catch {
      // cannot even rename it; carry on with defaults
    }
    log(`settings file was unreadable (${err.message}); kept as ${kept}, starting with defaults`);
  }
}

// One launcher at a time: two would both attach to the game window and handle
// every message (and every chat line) twice.
const LOCK_FILE = path.join(DATA_DIR, "launcher.lock");
try {
  const pid = Number(fs.readFileSync(LOCK_FILE, "utf8"));
  if (pid && pid !== process.pid) {
    process.kill(pid, 0); // throws if that process is gone
    console.error(`OpenFront Pro launcher is already running (process ${pid}). Close it first.`);
    process.exit(1);
  }
} catch (err) {
  if (err?.code === "EPERM") {
    console.error("OpenFront Pro launcher is already running. Close it first.");
    process.exit(1);
  }
  // no lock, or a stale one
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
store.session = bare(); // memory only, like chrome.storage.session
let saveTimer = null;
// The rank cache ("ofs<N>:" keys, ~16 KB per player, minutes of life) stays in
// memory: persisting it made the file grow by a megabyte per lobby. So does what the
// game window hands the stream overlay (the live state every few seconds, the recap card).
const VOLATILE = /^(ofs\d+:|overlay(Live|Recap|Enabled|Self|Mask)$)/;
// a change to memory-only keys alone never touches the file
const memoryOnly = (area, keys) => area === "session" || (area === "local" && keys.every((k) => VOLATILE.test(k)));
const persisted = () => JSON.stringify({ sync: store.sync, local: Object.fromEntries(Object.entries(store.local).filter(([k]) => !VOLATILE.test(k))) });
const writeNow = () => {
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, persisted());
  fs.renameSync(tmp, STORE_FILE);
};
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(store.local)) if (/^ofs\d+:/.test(k) && v && typeof v.expiresAt === "number" && v.expiresAt < now) delete store.local[k];
}, 60000).unref();
const shutdown = (code) => {
  try {
    if (saveTimer) writeNow();
    fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    // best effort
  }
  if (code !== undefined) process.exit(code);
};
process.on("exit", () => shutdown());
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeNow(); // write-then-rename: a crash mid-write must not eat settings and consent
    } catch (err) {
      log("could not save settings:", err.message);
    }
  }, 300);
};
const storageListeners = new Set(); // (changes, area) => void
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function storageGet(area, keys) {
  const data = store[area] ?? bare();
  const has = (k) => Object.hasOwn(data, k);
  if (keys === null || keys === undefined) return clone({ ...data });
  if (typeof keys === "string") return has(keys) ? { [keys]: clone(data[keys]) } : {};
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => typeof k === "string" && has(k)).map((k) => [k, clone(data[k])]));
  if (typeof keys !== "object") return {};
  return Object.fromEntries(Object.entries(keys).map(([k, dflt]) => [k, has(k) ? clone(data[k]) : dflt]));
}
function emitChange(area, changes) {
  if (!Object.keys(changes).length) return;
  for (const fn of storageListeners) {
    try {
      fn(clone(changes), area);
    } catch (err) {
      log("storage listener failed:", err.message);
    }
  }
}
function storageSet(area, items) {
  const changes = {};
  if (!items || typeof items !== "object") return;
  for (const [k, v] of Object.entries(items)) {
    if (k === "__proto__") continue;
    const oldValue = store[area][k];
    if (JSON.stringify(oldValue) === JSON.stringify(v)) continue;
    store[area][k] = clone(v);
    changes[k] = { oldValue, newValue: clone(v) };
  }
  if (!Object.keys(changes).length) return; // nothing changed: no write, no event
  if (!memoryOnly(area, Object.keys(changes))) save(); // no disk write for the overlay's traffic
  emitChange(area, changes);
}
function storageRemove(area, keys) {
  const changes = {};
  for (const k of [].concat(keys ?? [])) {
    if (typeof k !== "string" || !Object.hasOwn(store[area], k)) continue;
    changes[k] = { oldValue: store[area][k] };
    delete store[area][k];
  }
  if (!Object.keys(changes).length) return;
  if (!memoryOnly(area, Object.keys(changes))) save();
  emitChange(area, changes);
}
const areaApi = (area) => ({
  get: async (keys) => storageGet(area, keys),
  set: async (items) => storageSet(area, items),
  remove: async (keys) => storageRemove(area, keys),
});

// ---- local web server: popup / first-run page in your own browser ----------------------------
const TOKEN = crypto.randomBytes(16).toString("hex");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".wav": "audio/wav" };
let httpBase = "";
const sseClients = new Set();

let lastOpened = 0;
function openExternal(raw) {
  // https links and our own pages only. The URL goes through the URL parser and
  // is handed to the OS as ONE argument, never through a shell: with "cmd /c
  // start", an & or | inside a URL would have run as a command. At most one every
  // two seconds - this can be triggered from inside the game page.
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return;
  }
  if (u.protocol !== "https:" && u.origin !== new URL(httpBase).origin) return;
  const now = Date.now();
  if (now - lastOpened < 2000) return;
  lastOpened = now;
  const [cmd, cmdArgs] =
    process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", u.href]] : process.platform === "darwin" ? ["open", [u.href]] : ["xdg-open", [u.href]];
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // nothing to open it with; the address is in the log
  }
}

// The stand-in for chrome.* inside the popup / welcome pages (a normal browser tab).
const PAGE_SHIM = `(() => {
  const base = "/" + location.pathname.split("/")[1];
  // keepalive (small bodies only, the browser caps it): a write made while the page
  // closes - the stream overlay's "closed" - still gets out
  const api = (op, body) => { const data = JSON.stringify({ op, ...body }); return fetch(base + "/__api", { method: "POST", headers: { "content-type": "application/json" }, body: data, keepalive: data.length < 16000 }).then((r) => r.json()).then((r) => r.value); };
  const changed = [];
  const area = (name) => ({
    get: (keys) => api("storage.get", { area: name, keys: keys === undefined ? null : keys }),
    set: (items) => api("storage.set", { area: name, items }),
    remove: (keys) => api("storage.remove", { area: name, keys }),
  });
  new EventSource(base + "/__events").onmessage = (e) => {
    const m = JSON.parse(e.data);
    for (const f of changed) { try { f(m.changes, m.area); } catch {} }
  };
  window.chrome = {
    runtime: {
      id: "openfront-pro-launcher",
      lastError: undefined,
      getManifest: () => (${JSON.stringify(manifest)}),
      getURL: (p) => location.origin + base + "/" + String(p).replace(/^\\//, ""),
      sendMessage: (msg) => api("message", { msg }),
    },
    storage: { sync: area("sync"), local: area("local"), onChanged: { addListener: (f) => changed.push(f) } },
    tabs: { query: async () => [], create: async ({ url }) => void window.open(url, "_blank", "noopener") },
    permissions: { contains: async () => true, request: async () => true },
  };
  document.documentElement.classList.add("ofr-launcher");
})();`;

// Sent with everything: no Referer towards sites linked from the settings page
// (it would give away the port), no sniffing, and for pages the same script
// policy an extension page has.
const SECURITY = { "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" };
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.ofstats.io; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const MAX_BODY = 1_000_000;

function serve(req, res) {
  const deny = (code, text) => {
    res.writeHead(code, { "content-type": "text/plain", ...SECURITY });
    res.end(text);
  };
  // Loopback only, and only for someone who knows the token: another website must
  // not be able to read or change settings through the user's browser.
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) return deny(403, "bad host");
  let url;
  try {
    url = new URL(req.url, httpBase);
  } catch {
    return deny(400, "bad request"); // e.g. "//": new URL() throws on it
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.shift() !== TOKEN) return deny(404, "not found");
  const rest = parts.join("/");

  if (rest === "__shim.js") {
    res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store", ...SECURITY });
    return res.end(PAGE_SHIM);
  }
  if (rest === "__events") {
    if (sseClients.size >= 8) return deny(429, "too many listeners");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...SECURITY });
    res.write(": hello\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (rest === "__api") {
    if (req.method !== "POST") return deny(405, "POST only");
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}`) return deny(403, "bad origin");
    let body = "";
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      body += c;
      if (body.length > MAX_BODY) {
        tooBig = true;
        res.writeHead(413, { connection: "close", ...SECURITY });
        res.end();
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (tooBig) return;
      let value = null;
      try {
        const m = JSON.parse(body || "{}");
        // chrome.storage.session holds the chat signing keys: the worker's alone, as in Chrome
        if (m.area === "session") throw new Error("session storage is not available to pages");
        const area = ["sync", "local"].includes(m.area) ? m.area : "local";
        if (m.op === "storage.get") value = storageGet(area, m.keys);
        else if (m.op === "storage.set") storageSet(area, m.items);
        else if (m.op === "storage.remove") storageRemove(area, m.keys);
        else if (m.op === "message") value = (await dispatchMessage(m.msg, { url: "launcher-page" })) ?? null;
      } catch (err) {
        log("api error:", err.message);
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SECURITY });
      res.end(JSON.stringify({ value }));
    });
    return;
  }

  // static files of the extension, nothing else
  if (!/^(src|icons|sounds)\/[\w./-]+$/.test(rest) || rest.includes("..")) return deny(404, "not found");
  if (!hasAsset(rest)) return deny(404, "not found");
  const ext = path.extname(rest);
  let data = asset(rest);
  if (ext === ".html") {
    data = Buffer.from(data.toString("utf8").replace(/<head>/i, `<head><script src="/${TOKEN}/__shim.js"></script>`));
  }
  res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store", ...SECURITY, ...(ext === ".html" ? { "content-security-policy": PAGE_CSP } : {}) });
  res.end(data);
}
const server = http.createServer((req, res) => {
  try {
    serve(req, res);
  } catch (err) {
    log("http:", err.message);
    if (!res.headersSent) res.writeHead(500, SECURITY);
    res.end();
  }
});
server.headersTimeout = 10000;
server.requestTimeout = 20000;
server.on("clientError", (_err, socket) => socket.destroy());
await new Promise((r) => server.listen(0, "127.0.0.1", r));
httpBase = `http://127.0.0.1:${server.address().port}/${TOKEN}`;
storageListeners.add((changes, area) => {
  if (area === "session") return; // the worker's alone (chat signing keys)
  const line = `data: ${JSON.stringify({ area, changes })}\n\n`;
  for (const res of sseClients) res.write(line);
});

// ---- the extension's service worker, run here ----------------------------------------------------
const bg = { message: [], connect: [] };
const fakeChrome = {
  runtime: {
    id: "openfront-pro-launcher",
    lastError: undefined,
    getManifest: () => manifest,
    getURL: (p) => `${httpBase}/${String(p).replace(/^\//, "")}`,
    onMessage: { addListener: (f) => bg.message.push(f) },
    onConnect: { addListener: (f) => bg.connect.push(f) },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  storage: {
    sync: areaApi("sync"),
    local: areaApi("local"),
    session: areaApi("session"),
    onChanged: { addListener: (f) => storageListeners.add(f) },
  },
  tabs: { query: async () => [], create: async ({ url }) => openExternal(url), onUpdated: { addListener() {} } },
  scripting: { executeScript: async () => [], insertCSS: async () => {} },
  notifications: { create() {} },
  permissions: { contains: async () => true, request: async () => true },
};
const sandbox = vm.createContext({
  chrome: fakeChrome,
  console,
  fetch,
  WebSocket,
  Headers,
  Request,
  Response,
  URL,
  URLSearchParams,
  AbortController,
  TextEncoder,
  TextDecoder,
  crypto: globalThis.crypto,
  performance,
  structuredClone,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.importScripts = (...files) => {
  for (const f of files) vm.runInContext(text(`src/${f}`), sandbox, { filename: f });
};
vm.runInContext(text("src/background.js"), sandbox, { filename: "background.js" });

function dispatchMessage(msg, sender) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const respond = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(clone(value));
    };
    let async = false;
    for (const fn of bg.message) {
      try {
        if (fn(msg, sender, respond) === true) async = true;
      } catch (err) {
        log("background message handler failed:", err.message);
      }
    }
    if (!async) respond(undefined);
    else timer = setTimeout(() => respond(undefined), 60000);
  });
}

// ---- what gets injected into the game window --------------------------------------------------------
const scripts = manifest.content_scripts[0].js;
const cssText = manifest.content_scripts[0].css.map((f) => text(f)).join("\n");

// chrome.* for the isolated world, over a CDP binding (__ofrSend) one way and
// Runtime.evaluate (__ofrReceive) the other.
const WORLD_SHIM = `
if (!globalThis.__ofrLauncher) {
  globalThis.__ofrLauncher = true;
  let seq = 0;
  const pending = new Map();
  const changed = [];
  const ports = new Map();
  const send = (o) => {
    try {
      if (typeof globalThis.__ofrSend !== "function") return false;
      globalThis.__ofrSend(JSON.stringify(o));
      return true;
    } catch {
      return false; // the launcher is not attached right now; it re-attaches by itself
    }
  };
  // A call fails at once when the launcher is not there, and a storage call after
  // 10 s without an answer (the launcher was closed): nothing waits forever.
  const call = (kind, payload) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, resolve);
      if (!send({ id, kind, ...payload })) {
        pending.delete(id);
        return reject(new Error("the launcher is not running"));
      }
      if (kind.startsWith("storage.")) setTimeout(() => pending.delete(id) && reject(new Error("the launcher did not answer")), 10000);
    });
  globalThis.__ofrReceive = (m) => {
    if (m.kind === "reply") { const r = pending.get(m.id); pending.delete(m.id); r?.(m.value); }
    else if (m.kind === "storage-changed") { for (const f of changed) { try { f(m.changes, m.area); } catch {} } }
    else if (m.kind === "port-msg") { for (const f of ports.get(m.portId)?.onMsg ?? []) { try { f(m.msg); } catch {} } }
    else if (m.kind === "port-closed") { const p = ports.get(m.portId); ports.delete(m.portId); for (const f of p?.onClose ?? []) { try { f(); } catch {} } }
  };
  const area = (name) => ({
    get: (keys) => call("storage.get", { area: name, keys: keys === undefined ? null : keys }),
    set: (items) => call("storage.set", { area: name, items }),
    remove: (keys) => call("storage.remove", { area: name, keys }),
  });
  globalThis.chrome = {
    runtime: {
      id: "openfront-pro-launcher",
      lastError: undefined,
      getManifest: () => (${JSON.stringify(manifest)}),
      // Files the page needs are handed over as data (the alert sound), so no URL
      // with the launcher's port and token ever shows up in the PAGE's own
      // resource timing. Anything else resolves against the current launcher.
      getURL: (p) => globalThis.__ofrAssets[String(p).replace(/^\\//, "")] ?? globalThis.__ofrBase + "/" + String(p).replace(/^\\//, ""),
      sendMessage: (msg) => call("message", { msg }),
      connect: ({ name } = {}) => {
        const portId = ++seq;
        const p = { onMsg: [], onClose: [] };
        ports.set(portId, p);
        send({ kind: "port-open", portId, name });
        return {
          name,
          postMessage: (msg) => send({ kind: "port-post", portId, msg }),
          disconnect: () => { ports.delete(portId); send({ kind: "port-close", portId }); },
          onMessage: { addListener: (f) => p.onMsg.push(f) },
          onDisconnect: { addListener: (f) => p.onClose.push(f) },
        };
      },
    },
    storage: { sync: area("sync"), local: area("local"), onChanged: { addListener: (f) => changed.push(f) } },
  };
  globalThis.__ofrCss = ${JSON.stringify("CSSTEXT")};
}
`;

function isolatedSource() {
  const body = scripts.map((f) => `try {\n${text(f)}\n} catch (err) { console.error("[OpenFront Pro launcher] ${f}:", err); }`).join("\n");
  const shim = WORLD_SHIM.replace(JSON.stringify("CSSTEXT"), JSON.stringify(cssText));
  const sound = `data:audio/wav;base64,${asset("sounds/alert.wav").toString("base64")}`;
  // Settings INSIDE the game window: popup.html's markup and popup.js's code, in a
  // closed shadow root (the page's own scripts cannot look inside). popup.js reads
  // its root from __ofrSettingsRoot, so it is the very same code as the extension's.
  const popupHtml = text("src/popup.html");
  const popupStyle = [...popupHtml.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
    .replace(/(^|[\s,}])body(\s*\{)/g, "$1.ofr-settings-body$2")
    // every embedded-only popup rule ("html.embedded ...") applies in the game window too
    .replace(/html\.embedded\s+/g, "");
  const popupBody = (/<body>([\s\S]*?)<\/body>/.exec(popupHtml)?.[1] ?? "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    // relative to the extension page; in the game window it has to be self-contained
    .replace('src="../icons/icon48.png"', `src="data:image/png;base64,${asset("icons/icon48.png").toString("base64")}"`);
  const settingsSource = `
  globalThis.__ofrMountSettings = (root) => {
    globalThis.__ofrSettingsRoot = root;
    ${text("src/popup.js")}
  };
  globalThis.__ofrOpenSettingsInPage = () => {
    document.querySelector(".ofr-settings")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "ofr-settings";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "OpenFront Pro settings");
    const box = document.createElement("div");
    box.className = "ofr-settings-box";
    const head = document.createElement("div");
    head.className = "ofr-settings-head";
    const title = document.createElement("span");
    title.textContent = "Settings";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "\u2715";
    close.setAttribute("aria-label", "Close settings");
    close.title = "Close (Esc)";
    head.append(title, close);
    const host = document.createElement("div");
    host.style.cssText = "flex:1;min-height:0;overflow:auto";
    box.append(head, host);
    overlay.append(box);
    const shut = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
    close.addEventListener("click", shut);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) shut(); });
    document.addEventListener("keydown", onKey, true);
    // typing in here must not reach the game's hotkeys
    for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => { if (e.key !== "Escape") e.stopPropagation(); });
    const shadow = host.attachShadow({ mode: "closed" });
    const css = document.createElement("style");
    css.textContent = globalThis.__ofrCss + "\\n" + ${JSON.stringify("POPUPSTYLE")} + "\\n.ofr-settings-body{width:auto!important;box-sizing:border-box;min-height:100%}";
    const body = document.createElement("div");
    body.className = "ofr-settings-body";
    // our own packaged markup (src/popup.html), parsed inertly and adopted
    const parsed = new DOMParser().parseFromString(${JSON.stringify("POPUPBODY")}, "text/html");
    body.append(...[...parsed.body.childNodes].map((n) => document.importNode(n, true)));
    shadow.append(css, body);
    globalThis.__ofrSettingsShadow = shadow; // isolated world only; lets the bridge test look inside
    document.body.appendChild(overlay);
    globalThis.__ofrRemountSettings = () => { shut(); globalThis.__ofrOpenSettingsInPage(); };
    try { globalThis.__ofrMountSettings(shadow); } catch (err) { console.error("[OpenFront Pro launcher] settings:", err); }
  };`.replace(JSON.stringify("POPUPSTYLE"), JSON.stringify(popupStyle)).replace(JSON.stringify("POPUPBODY"), JSON.stringify(`<body>${popupBody}</body>`));
  return `(() => {
  // the game page only: not the splash, the login gate or the tutorial player
  if (!location.href.startsWith(${JSON.stringify(GAME_PREFIX)}) || location.pathname.startsWith("/__")) return;
  // refreshed on every attach: a restarted launcher has a new port and token
  globalThis.__ofrBase = ${JSON.stringify(httpBase)};
  globalThis.__ofrAssets = { "sounds/alert.wav": ${JSON.stringify(sound)} };
  if (globalThis.__ofrInjected) return;
  globalThis.__ofrInjected = true;
  ${shim}
  const run = () => {
    const style = document.createElement("style");
    style.dataset.ofr = "launcher";
    style.textContent = globalThis.__ofrCss;
    (document.head ?? document.documentElement).appendChild(style);
    ${body}
    try {${settingsSource}
    } catch (err) { console.error("[OpenFront Pro launcher] settings setup:", err); }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(run, 50), { once: true });
  else run();
})();`;
}
function mainWorldSource() {
  return `(() => {
  if (!location.href.startsWith(${JSON.stringify(GAME_PREFIX)}) || location.pathname.startsWith("/__")) return; // the probe guards against itself, by version
  const run = () => { ${text("src/page-probe.js")} };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(run, 50), { once: true });
  else run();
})();`;
}

// ---- one attached game window -----------------------------------------------------------------------
const attached = new Map(); // targetId -> session

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("could not open the debugging socket")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  let contextId = null; // our isolated world in the MAIN frame's current document
  let mainFrameId = null; // an iframe (an ad, an embed) gets a world of the same name: never that one
  const ports = new Map(); // portId -> background-side port

  // The message travels as DATA (a JSON string, parsed on the other side), never
  // as source code: names and chat text come from strangers. And it only goes to
  // the context it is meant for - a reply for a document that has been replaced
  // is dropped, not delivered to its successor.
  const toPage = (message, ctx = contextId) => {
    if (ctx === null || ctx !== contextId) return;
    send("Runtime.evaluate", { expression: `globalThis.__ofrReceive?.(JSON.parse(${JSON.stringify(JSON.stringify(message))}))`, contextId: ctx }).catch(() => {});
  };
  const closePorts = (tellPage) => {
    for (const [portId, p] of ports) {
      if (tellPage) toPage({ kind: "port-closed", portId });
      for (const f of p.onClose) try { f(); } catch {}
    }
    ports.clear();
  };
  const onStorage = (changes, area) => area !== "session" && toPage({ kind: "storage-changed", area, changes }); // session: the worker's alone
  storageListeners.add(onStorage);

  async function fromPage(payload, ctx) {
    let m;
    try {
      m = JSON.parse(payload);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (typeof m.kind === "string" && m.kind.startsWith("storage.") && m.area === "session") return toPage({ kind: "reply", id: m.id, value: m.kind === "storage.get" ? {} : undefined }, ctx); // the worker's alone
    const area = ["sync", "local"].includes(m.area) ? m.area : "local";
    if (m.kind === "storage.get") toPage({ kind: "reply", id: m.id, value: storageGet(area, m.keys) }, ctx);
    else if (m.kind === "storage.set") { storageSet(area, m.items); toPage({ kind: "reply", id: m.id }, ctx); }
    else if (m.kind === "storage.remove") { storageRemove(area, m.keys); toPage({ kind: "reply", id: m.id }, ctx); }
    else if (m.kind === "message") toPage({ kind: "reply", id: m.id, value: await dispatchMessage(m.msg, { url: "app://openfront" }) }, ctx);
    else if (m.kind === "port-open") {
      const p = { onMsg: [], onClose: [] };
      ports.set(m.portId, p);
      const port = {
        name: m.name,
        postMessage: (msg) => toPage({ kind: "port-msg", portId: m.portId, msg: clone(msg) }, ctx),
        disconnect: () => { ports.delete(m.portId); toPage({ kind: "port-closed", portId: m.portId }, ctx); },
        onMessage: { addListener: (f) => p.onMsg.push(f) },
        onDisconnect: { addListener: (f) => p.onClose.push(f) },
      };
      for (const f of bg.connect) try { f(port); } catch (err) { log("connect handler failed:", err.message); }
    } else if (m.kind === "port-post") {
      const p = ports.get(m.portId);
      // A port this launcher does not know (it was restarted, or the port was
      // dropped): say so, and the chat reconnects instead of talking into the void.
      if (!p) return toPage({ kind: "port-closed", portId: m.portId }, ctx);
      for (const f of p.onMsg) try { f(m.msg); } catch (err) { log("port handler failed:", err.message); }
    } else if (m.kind === "port-close") {
      const p = ports.get(m.portId);
      ports.delete(m.portId);
      for (const f of p?.onClose ?? []) try { f(); } catch {}
    }
  }

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Page.frameNavigated") {
      if (!msg.params.frame.parentId) mainFrameId = msg.params.frame.id;
    } else if (msg.method === "Runtime.executionContextCreated") {
      const c = msg.params.context;
      if (c.name === WORLD && c.auxData?.isDefault === false && c.auxData.frameId === mainFrameId) {
        if (contextId !== null && contextId !== c.id) closePorts(false); // a new document replaced the old one
        contextId = c.id;
      }
    } else if (msg.method === "Runtime.executionContextDestroyed") {
      if (msg.params.executionContextId === contextId) {
        contextId = null;
        closePorts(false); // the page went away: the chat leaves its room
      }
    } else if (msg.method === "Runtime.executionContextsCleared") {
      contextId = null;
      closePorts(false);
    } else if (msg.method === "Runtime.bindingCalled" && msg.params.name === "__ofrSend") {
      // only our world in the main frame; an iframe's world of the same name is ignored
      if (msg.params.executionContextId === contextId) fromPage(msg.params.payload, contextId).catch((err) => log("bridge:", err.message));
    }
  });
  ws.addEventListener("close", () => {
    storageListeners.delete(onStorage);
    closePorts(false);
    attached.delete(target.id);
    log("game window closed or debugger detached");
  });

  // Learn which frame is the main one BEFORE contexts start being reported.
  await send("Page.enable");
  mainFrameId = (await send("Page.getFrameTree")).result?.frameTree?.frame?.id ?? null;
  await send("Runtime.enable");
  await send("Runtime.addBinding", { name: "__ofrSend", executionContextName: WORLD });
  const iso = isolatedSource();
  const main = mainWorldSource();
  // every future document of this window...
  await send("Page.addScriptToEvaluateOnNewDocument", { source: iso, worldName: WORLD });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: main });
  // ...and the one that is already there
  const frameId = mainFrameId;
  if (frameId) {
    const world = await send("Page.createIsolatedWorld", { frameId, worldName: WORLD });
    const ctx = world.result?.executionContextId;
    if (ctx) {
      contextId = ctx;
      const r = await send("Runtime.evaluate", { expression: iso, contextId: ctx });
      if (r.result?.exceptionDetails) log("inject (isolated world) threw:", r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    }
    const r2 = await send("Runtime.evaluate", { expression: main });
    if (r2.result?.exceptionDetails) log("inject (page world) threw:", r2.result.exceptionDetails.exception?.description ?? r2.result.exceptionDetails.text);
  }
  attached.set(target.id, { ws });
  log(`attached to the game window (${target.url})`);
}

// ---- find / start the game ------------------------------------------------------------------------------
async function targets() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.filter((t) => t.type === "page" && String(t.url).startsWith(GAME_PREFIX));
  } catch {
    return null; // nothing is listening
  }
}

function steamExe() {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamExe"], { encoding: "utf8" });
    const m = /SteamExe\s+REG_SZ\s+(.+)/.exec(out);
    return m ? m[1].trim().replaceAll("/", "\\") : null;
  } catch {
    return null;
  }
}

log(`OpenFront Pro launcher ${manifest.version} - settings page: ${httpBase}/src/popup.html`);
// The stream overlay as an OBS "Browser Source". The address carries the secret key
// and changes with every start; its page (?edit=1) has the same address with a Copy button.
log(`stream overlay for OBS (Browser Source, 1920x1080) - SECRET, never show it on stream or share it:`);
log(`    ${httpBase}/src/overlay.html?bg=transparent`);
if ((await targets()) === null && !args.attach) {
  const steam = steamExe();
  if (steam && fs.existsSync(steam)) {
    log("starting OpenFront through Steam with the debugging port...");
    spawn(steam, ["-applaunch", APP_ID, `--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: "ignore" }).unref();
  } else {
    log("Steam was not found. Start the game yourself with this launch option (Steam > OpenFront > Properties > Launch options):");
    log(`    --remote-debugging-port=${CDP_PORT}`);
  }
}

// First run: the same disclosure page the extension opens on install.
if (store.sync.dataConsent === undefined) {
  storageSet("sync", { dataConsent: false });
  openExternal(`${httpBase}/src/welcome.html`);
}

let waited = 0;
let everAttached = false;
setInterval(async () => {
  const list = await targets();
  if (list === null) {
    waited += 3;
    if (everAttached && attached.size === 0) {
      log("the game has closed - bye");
      process.exit(0);
    }
    if (waited === 60 && !everAttached) {
      log(`still no debugging port on 127.0.0.1:${CDP_PORT}. If the game is running, it was started without the flag:`);
      log(`close it, put  --remote-debugging-port=${CDP_PORT}  in its Steam launch options, start it, then run this with --attach.`);
    }
    return;
  }
  for (const t of list) {
    if (attached.has(t.id)) continue;
    attached.set(t.id, { pending: true });
    try {
      await attach(t);
      everAttached = true;
    } catch (err) {
      attached.delete(t.id);
      log("attach failed:", err.message);
    }
  }
}, 3000);
}

main().catch((err) => {
  console.error("launcher failed:", err);
  process.exit(1);
});
