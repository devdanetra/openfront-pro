// End-to-end test of the Steam launcher's bridge WITHOUT Steam or the game: a
// headless Chrome shows a stand-in page, the real launcher attaches to it (its
// game-origin check is pointed at the stand-in through OFR_LAUNCHER_TEST_ORIGIN),
// and a second DevTools client checks what a content script would see.
//
//   node tools/test-launcher-bridge.mjs
//
// Covers: chrome.* shim in the isolated world (storage, messages to the worker,
// ports), an iframe appearing and disappearing, a page reload, a launcher
// restart with the page left open, no token in the page's resource timing, and
// a request for "//" not killing the launcher. Uses an isolated settings folder.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP = 9397;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};

// the stand-in "game"
const site = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(req.url.startsWith("/frame") ? "<p>frame</p>" : "<!doctype html><title>stand-in</title><body><h1>stand-in game page</h1></body>");
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${site.address().port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofr-bridge-"));
const chrome = spawn(CHROME, [`--user-data-dir=${path.join(tmp, "chrome")}`, `--remote-debugging-port=${CDP}`, "--headless=new", "--no-first-run", "--disable-gpu", `${ORIGIN}/index.html`], { stdio: "ignore" });
const env = { ...process.env, APPDATA: path.join(tmp, "appdata"), OFR_LAUNCHER_TEST_ORIGIN: ORIGIN };
fs.mkdirSync(env.APPDATA, { recursive: true });
// consent already given, so lookups are allowed and no browser tab is opened
fs.mkdirSync(path.join(env.APPDATA, "openfront-pro-launcher"), { recursive: true });
fs.writeFileSync(path.join(env.APPDATA, "openfront-pro-launcher", "storage.json"), JSON.stringify({ sync: { dataConsent: true, themesMigrated: true }, local: {} }));

function startLauncher() {
  const out = [];
  const child = spawn(process.execPath, [path.join(ROOT, "launcher/openfront-pro-launcher.cjs"), "--attach", `--port=${CDP}`], { env });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  return { child, out, base: () => /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}/.exec(out.join(""))?.[0] ?? null };
}

async function client() {
  let list = null;
  for (let i = 0; i < 40 && !list; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    } catch {
      await wait(250);
    }
  }
  const target = list.find((t) => t.type === "page" && t.url.startsWith(ORIGIN));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const contexts = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.executionContextCreated") contexts.set(m.params.context.id, m.params.context);
    else if (m.method === "Runtime.executionContextDestroyed") contexts.delete(m.params.executionContextId);
    else if (m.method === "Runtime.executionContextsCleared") contexts.clear();
  });
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Page.enable");
  const mainFrame = (await send("Page.getFrameTree")).result.frameTree.frame.id;
  await send("Runtime.enable");
  const world = () => [...contexts.values()].filter((c) => c.name === "OpenFront Pro" && c.auxData?.frameId === mainFrame).pop();
  const inWorld = async (expression) => {
    const ctx = world();
    if (!ctx) return "no world";
    const r = await send("Runtime.evaluate", { expression, contextId: ctx.id, awaitPromise: true, returnByValue: true });
    return r.result?.exceptionDetails ? `threw: ${r.result.exceptionDetails.exception?.description}` : r.result?.result?.value;
  };
  const inPage = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return { send, inWorld, inPage, world, mainFrame };
}

const RACE = (p) => `Promise.race([${p}, new Promise((r) => setTimeout(() => r("TIMEOUT"), 4000))])`;
const BRIDGE = `(async () => {
  const set = await ${RACE("chrome.storage.local.set({ bridgeTest: 42 }).then(() => 'set')")};
  const got = await ${RACE("chrome.storage.local.get('bridgeTest')")};
  const settings = await ${RACE("chrome.runtime.sendMessage({ type: 'getSettings' })")};
  const pong = await new Promise((resolve) => { const port = chrome.runtime.connect({ name: "ofr-chat" }); port.onMessage.addListener((m) => { if (m.t === "pong") resolve("pong"); }); port.postMessage({ t: "ping" }); setTimeout(() => resolve("TIMEOUT"), 4000); });
  return { set, got: got?.bridgeTest, settings: settings && typeof settings === "object" ? settings.dataConsent : settings, pong };
})()`;
const okBridge = (r) => r && r.set === "set" && r.got === 42 && r.settings === true && r.pong === "pong";

let L = startLauncher();
const c = await client();
await wait(6000);
console.log("attach");
check("launcher attached", /attached to the game window/.test(L.out.join("")), L.out.join("").split("\n").slice(-2).join(" | "));
check("content scripts ran in the isolated world", (await c.inWorld("typeof globalThis.OFR_SCORING + '/' + typeof globalThis.OFR_CHAT + '/' + typeof chrome.runtime.sendMessage")) === "object/object/function");
check("page world sees neither chrome.* nor the bridge", (await c.inPage("typeof window.chrome?.runtime?.sendMessage + '/' + typeof window.__ofrSend + '/' + typeof window.__ofrReceive")) === "undefined/undefined/undefined");
check("page-probe ran in the page world", (await c.inPage("window.__ofrProbeVersion >= 3")) === true);
let r = await c.inWorld(BRIDGE);
check("storage, worker messages and ports work", okBridge(r), JSON.stringify(r));

console.log("an iframe comes and goes");
await c.inPage(`new Promise((res) => { const f = document.createElement("iframe"); f.id = "x"; f.src = "/frame.html"; f.onload = () => res(1); document.body.appendChild(f); })`);
await wait(1200);
r = await c.inWorld(BRIDGE);
check("bridge still works with an iframe present", okBridge(r), JSON.stringify(r));
await c.inPage(`document.getElementById("x").remove(); 1`);
await wait(800);
r = await c.inWorld(BRIDGE);
check("...and after it is gone", okBridge(r), JSON.stringify(r));

console.log("hostile data");
const echo = await c.inWorld(`chrome.storage.local.set({ evil: { "__proto__": { polluted: true }, "text": "a\\u2028b</script><img src=x onerror=1>" } }).then(() => chrome.storage.local.get("evil")).then((v) => ({ text: v.evil.text, polluted: ({}).polluted === true, keys: Object.keys(v.evil) }))`);
check("strings survive as data, nothing is polluted", echo?.text === "a\u2028b</script><img src=x onerror=1>" && echo.polluted === false, JSON.stringify(echo));

console.log("settings inside the game window");
const st = await c.inWorld(`(async () => {
  globalThis.__ofrOpenSettingsInPage();
  await new Promise((r) => setTimeout(r, 1500));
  const root = globalThis.__ofrSettingsShadow;
  const box = root.getElementById("showGames");
  const before = box.checked;
  box.click();
  await new Promise((r) => setTimeout(r, 600));
  const stored = (await chrome.storage.sync.get("showGames")).showGames;
  const chat = root.getElementById("chatEnabled");
  chat.click();
  await new Promise((r) => setTimeout(r, 300));
  const chatStored = await chrome.storage.sync.get({ chatEnabled: false, chatConsent: false });
  let session = "no area";
  try {
    session = chrome.storage.session ? JSON.stringify(await chrome.storage.session.get(null)) : "no area";
  } catch (err) {
    session = "refused";
  }
  return { overlay: !!document.querySelector(".ofr-settings"), inputs: root.querySelectorAll("input, select").length, themes: root.getElementById("theme").options.length, before, stored, injectHidden: root.getElementById("inject").hidden, status: root.getElementById("status").textContent.slice(0, 40), chatLocked: chat.disabled && !root.getElementById("chatEnabled-lock").hidden, chatOn: chatStored.chatEnabled || chatStored.chatConsent, session };
})()`);
check("the same settings UI mounts in a shadow root and writes to storage", st?.overlay && st.inputs > 15 && st.themes === 9 && st.stored === !st.before && st.injectHidden, JSON.stringify(st));
check("chat cannot be switched on from inside the game window", st?.chatLocked === true && st.chatOn === false, JSON.stringify(st));
check("the game window gets no chrome.storage.session (the worker's chat keys)", st?.session === "no area", String(st?.session));
check("the page cannot look inside it", (await c.inPage(`(() => { const h = document.querySelector(".ofr-settings-box > div:last-child"); return h ? h.shadowRoot === null && !document.querySelector(".ofr-settings input") : false; })()`)) === true);
await c.inWorld(`document.querySelector(".ofr-settings-head button").click(); 1`);

console.log("reload");
await c.send("Page.reload");
await wait(3500);
r = await c.inWorld(BRIDGE);
check("bridge works in the new document", okBridge(r), JSON.stringify(r));

console.log("token stays out of the page");
await c.inWorld(`new Audio(chrome.runtime.getURL("sounds/alert.wav")).play().catch(() => {}); 1`);
await wait(600);
const leaked = await c.inPage(`performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /127\\.0\\.0\\.1:\\d+\\/[0-9a-f]{32}/.test(n)).length`);
check("no launcher URL in the page's resource timing", leaked === 0, String(leaked));

console.log("launcher survives a hostile request");
const base = L.base();
await fetch(`${new URL(base).origin}//`).catch(() => {});
await wait(500);
check('"//" does not kill it', L.child.exitCode === null);
const second = startLauncher();
await wait(2500);
check("a second launcher refuses to start", second.child.exitCode === 1, second.out.join("").trim().split("\n").pop());

console.log("launcher restart, page left open");
L.child.kill();
await wait(1500);
L = startLauncher();
await wait(7000);
r = await c.inWorld(BRIDGE);
check("the page is taken over again", okBridge(r), JSON.stringify(r));
check("getURL points at the NEW launcher", (await c.inWorld(`chrome.runtime.getURL("src/popup.html")`))?.startsWith(L.base() ?? "x"));

L.child.kill();
chrome.kill();
site.close();
await wait(800);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // Chrome may still hold its profile for a moment
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
