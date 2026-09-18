#!/usr/bin/env node
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
//   node launcher/openfront-pro-launcher.mjs            start the game and attach
//   node launcher/openfront-pro-launcher.mjs --attach   attach only (game already
//                                                       running with the flag)
//   --port=9322    debugging port (loopback only)
//
// KNOW THE RISKS (see launcher/README.md): a debugging port lets any program on
// this computer drive the game window while it is open, and OpenFront's terms
// restrict third-party software - using this on your Steam account is your call.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const APP_ID = "3560670";
const WORLD = "OpenFront Pro";
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const CDP_PORT = Number(args.port ?? 9322);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8").replace(/^﻿/, ""));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

if (typeof WebSocket !== "function" || typeof fetch !== "function") {
  console.error("Node 22 or newer is required (global WebSocket and fetch).");
  process.exit(1);
}

// ---- storage: chrome.storage.* in a JSON file ---------------------------------------------
const DATA_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), ".config"), "openfront-pro-launcher");
const STORE_FILE = path.join(DATA_DIR, "storage.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
let store = { sync: {}, local: {} };
try {
  store = { sync: {}, local: {}, ...JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) };
} catch {
  // first run
}
store.session = {}; // memory only, like chrome.storage.session
let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify({ sync: store.sync, local: store.local }));
    } catch (err) {
      log("could not save settings:", err.message);
    }
  }, 300);
};
const storageListeners = new Set(); // (changes, area) => void
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function storageGet(area, keys) {
  const data = store[area] ?? {};
  if (keys === null || keys === undefined) return clone(data);
  if (typeof keys === "string") return keys in data ? { [keys]: clone(data[keys]) } : {};
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
  return Object.fromEntries(Object.entries(keys).map(([k, dflt]) => [k, k in data ? clone(data[k]) : dflt]));
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
  for (const [k, v] of Object.entries(items ?? {})) {
    const oldValue = store[area][k];
    if (JSON.stringify(oldValue) === JSON.stringify(v)) continue;
    store[area][k] = clone(v);
    changes[k] = { oldValue, newValue: clone(v) };
  }
  if (area !== "session") save();
  emitChange(area, changes);
}
function storageRemove(area, keys) {
  const changes = {};
  for (const k of [].concat(keys ?? [])) {
    if (!(k in store[area])) continue;
    changes[k] = { oldValue: store[area][k] };
    delete store[area][k];
  }
  if (area !== "session") save();
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

function openExternal(url) {
  // Only our own pages and https links, never a command.
  if (!/^https:\/\//.test(url) && !url.startsWith(httpBase)) return;
  if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

// The stand-in for chrome.* inside the popup / welcome pages (a normal browser tab).
const PAGE_SHIM = `(() => {
  const base = "/" + location.pathname.split("/")[1];
  const api = (op, body) => fetch(base + "/__api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, ...body }) }).then((r) => r.json()).then((r) => r.value);
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
    storage: { sync: area("sync"), local: area("local"), session: area("session"), onChanged: { addListener: (f) => changed.push(f) } },
    tabs: { query: async () => [], create: async ({ url }) => void window.open(url, "_blank", "noopener") },
    permissions: { contains: async () => true, request: async () => true },
  };
  document.documentElement.classList.add("ofr-launcher");
})();`;

function serve(req, res) {
  const deny = (code, text) => {
    res.writeHead(code, { "content-type": "text/plain" });
    res.end(text);
  };
  // Loopback only, and only for someone who knows the token: another website must
  // not be able to read or change settings through the user's browser.
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) return deny(403, "bad host");
  const url = new URL(req.url, httpBase);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.shift() !== TOKEN) return deny(404, "not found");
  const rest = parts.join("/");

  if (rest === "__shim.js") {
    res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
    return res.end(PAGE_SHIM);
  }
  if (rest === "__events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": hello\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (rest === "__api") {
    if (req.method !== "POST") return deny(405, "POST only");
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}`) return deny(403, "bad origin");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let value = null;
      try {
        const m = JSON.parse(body || "{}");
        const area = ["sync", "local", "session"].includes(m.area) ? m.area : "local";
        if (m.op === "storage.get") value = storageGet(area, m.keys);
        else if (m.op === "storage.set") storageSet(area, m.items);
        else if (m.op === "storage.remove") storageRemove(area, m.keys);
        else if (m.op === "message") value = (await dispatchMessage(m.msg, { url: "launcher-page" })) ?? null;
      } catch (err) {
        log("api error:", err.message);
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ value }));
    });
    return;
  }

  // static files of the extension, nothing else
  if (!/^(src|icons|sounds)\/[\w./-]+$/.test(rest) || rest.includes("..")) return deny(404, "not found");
  const file = path.join(ROOT, rest);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return deny(404, "not found");
  const ext = path.extname(file);
  let data = fs.readFileSync(file);
  if (ext === ".html") {
    data = Buffer.from(data.toString("utf8").replace(/<head>/i, `<head><script src="/${TOKEN}/__shim.js"></script>`));
  }
  res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(data);
}
const server = http.createServer(serve);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
httpBase = `http://127.0.0.1:${server.address().port}/${TOKEN}`;
storageListeners.add((changes, area) => {
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
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), sandbox, { filename: f });
};
vm.runInContext(fs.readFileSync(path.join(SRC, "background.js"), "utf8"), sandbox, { filename: "background.js" });

function dispatchMessage(msg, sender) {
  return new Promise((resolve) => {
    let done = false;
    const respond = (value) => {
      if (done) return;
      done = true;
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
    else setTimeout(() => respond(undefined), 60000);
  });
}

// ---- what gets injected into the game window --------------------------------------------------------
const scripts = manifest.content_scripts[0].js;
const cssText = manifest.content_scripts[0].css.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");

// chrome.* for the isolated world, over a CDP binding (__ofrSend) one way and
// Runtime.evaluate (__ofrReceive) the other.
const WORLD_SHIM = `
if (!globalThis.__ofrLauncher) {
  globalThis.__ofrLauncher = true;
  let seq = 0;
  const pending = new Map();
  const changed = [];
  const ports = new Map();
  const send = (o) => globalThis.__ofrSend(JSON.stringify(o));
  const call = (kind, payload) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); send({ id, kind, ...payload }); });
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
      getURL: (p) => ${JSON.stringify("HTTPBASE")} + "/" + String(p).replace(/^\\//, ""),
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
    storage: { sync: area("sync"), local: area("local"), session: area("session"), onChanged: { addListener: (f) => changed.push(f) } },
  };
  globalThis.__ofrCss = ${JSON.stringify("CSSTEXT")};
}
`;

function isolatedSource() {
  const body = scripts.map((f) => `try {\n${fs.readFileSync(path.join(ROOT, f), "utf8")}\n} catch (err) { console.error("[OpenFront Pro launcher] ${f}:", err); }`).join("\n");
  const shim = WORLD_SHIM.replace(JSON.stringify("HTTPBASE"), JSON.stringify(httpBase)).replace(JSON.stringify("CSSTEXT"), JSON.stringify(cssText));
  return `(() => {
  // the game page only: not the splash, the login gate or the tutorial player
  if (location.protocol !== "app:" || location.pathname.startsWith("/__")) return;
  if (globalThis.__ofrInjected) return;
  globalThis.__ofrInjected = true;
  ${shim}
  const run = () => {
    const style = document.createElement("style");
    style.dataset.ofr = "launcher";
    style.textContent = globalThis.__ofrCss;
    (document.head ?? document.documentElement).appendChild(style);
    ${body}
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(run, 50), { once: true });
  else run();
})();`;
}
function mainWorldSource() {
  return `(() => {
  if (location.protocol !== "app:" || location.pathname.startsWith("/__") || window.__ofrProbeInjected) return;
  window.__ofrProbeInjected = true;
  const run = () => { ${fs.readFileSync(path.join(SRC, "page-probe.js"), "utf8")} };
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
  let contextId = null; // our isolated world in the current document
  const ports = new Map(); // portId -> background-side port

  const toPage = (message) => {
    if (contextId === null) return;
    send("Runtime.evaluate", { expression: `globalThis.__ofrReceive?.(${JSON.stringify(message)})`, contextId }).catch(() => {});
  };
  const closePorts = () => {
    for (const p of ports.values()) for (const f of p.onClose) try { f(); } catch {}
    ports.clear();
  };
  const onStorage = (changes, area) => toPage({ kind: "storage-changed", area, changes });
  storageListeners.add(onStorage);

  async function fromPage(payload) {
    let m;
    try {
      m = JSON.parse(payload);
    } catch {
      return;
    }
    const area = ["sync", "local", "session"].includes(m.area) ? m.area : "local";
    if (m.kind === "storage.get") toPage({ kind: "reply", id: m.id, value: storageGet(area, m.keys) });
    else if (m.kind === "storage.set") { storageSet(area, m.items); toPage({ kind: "reply", id: m.id }); }
    else if (m.kind === "storage.remove") { storageRemove(area, m.keys); toPage({ kind: "reply", id: m.id }); }
    else if (m.kind === "message") toPage({ kind: "reply", id: m.id, value: await dispatchMessage(m.msg, { url: "app://openfront" }) });
    else if (m.kind === "port-open") {
      const p = { onMsg: [], onClose: [] };
      ports.set(m.portId, p);
      const port = {
        name: m.name,
        postMessage: (msg) => toPage({ kind: "port-msg", portId: m.portId, msg: clone(msg) }),
        disconnect: () => { ports.delete(m.portId); toPage({ kind: "port-closed", portId: m.portId }); },
        onMessage: { addListener: (f) => p.onMsg.push(f) },
        onDisconnect: { addListener: (f) => p.onClose.push(f) },
      };
      for (const f of bg.connect) try { f(port); } catch (err) { log("connect handler failed:", err.message); }
    } else if (m.kind === "port-post") {
      for (const f of ports.get(m.portId)?.onMsg ?? []) try { f(m.msg); } catch (err) { log("port handler failed:", err.message); }
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
    } else if (msg.method === "Runtime.executionContextCreated") {
      const c = msg.params.context;
      if (c.name === WORLD && c.auxData?.isDefault === false) contextId = c.id;
    } else if (msg.method === "Runtime.executionContextDestroyed") {
      if (msg.params.executionContextId === contextId) {
        contextId = null;
        closePorts(); // the page went away: the chat leaves its room
      }
    } else if (msg.method === "Runtime.executionContextsCleared") {
      contextId = null;
      closePorts();
    } else if (msg.method === "Runtime.bindingCalled" && msg.params.name === "__ofrSend") {
      if (msg.params.executionContextId === contextId || contextId === null) {
        if (contextId === null) contextId = msg.params.executionContextId;
        fromPage(msg.params.payload);
      }
    }
  });
  ws.addEventListener("close", () => {
    storageListeners.delete(onStorage);
    closePorts();
    attached.delete(target.id);
    log("game window closed or debugger detached");
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Runtime.addBinding", { name: "__ofrSend", executionContextName: WORLD });
  const iso = isolatedSource();
  const main = mainWorldSource();
  // every future document of this window...
  await send("Page.addScriptToEvaluateOnNewDocument", { source: iso, worldName: WORLD });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: main });
  // ...and the one that is already there
  const tree = await send("Page.getFrameTree");
  const frameId = tree.result?.frameTree?.frame?.id;
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
    return list.filter((t) => t.type === "page" && String(t.url).startsWith("app://openfront"));
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
