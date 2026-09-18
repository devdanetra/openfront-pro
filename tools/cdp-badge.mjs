// Dev tool, end to end in a debug Chrome with the extension loaded and the
// front page ALREADY open (no page reload, on purpose):
//   1. turns the current PRO tag into an "old build" pill after the last nav
//      link, reloads the extension from disk, and checks the fresh instance
//      replaces it with a working logo tag;
//   2. stores profileLink:"ofstats" (a value older builds could save), adds a
//      lobby to the page, and really clicks a rank badge: the in-page dashboard
//      must open and no tab may appear. Also close + re-click inside a second,
//      and Shift+click.
//   CDP_PORT=9340 node tools/cdp-badge.mjs <outDir> [extensionPath]
import nodePath from "node:path";
import { fileURLToPath as toPath } from "node:url";
const REPO_ROOT = nodePath.resolve(nodePath.dirname(toPath(import.meta.url)), "..");
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9340);
const OUT = process.argv[2];
const EXT = process.argv[3] ?? REPO_ROOT; // the unpacked extension = this repository
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const contexts = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.executionContextCreated") contexts.push(msg.params.context);
    else if (msg.method === "Runtime.executionContextDestroyed") {
      const i = contexts.findIndex((c) => c.id === msg.params.executionContextId);
      if (i !== -1) contexts.splice(i, 1);
    } else if (msg.method === "Runtime.executionContextsCleared") contexts.length = 0;
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return new Promise((r) => ws.addEventListener("open", () => r({ ws, send, contexts }), { once: true }));
}

const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === "page");
const target = (await pages()).find((t) => t.url.includes("openfront.io"));
const { ws, send, contexts } = await connect(target.webSocketDebuggerUrl);
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const evalPage = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
};
// newest live extension context (an orphaned one has no runtime id)
const evalIso = async (expression) => {
  for (const c of [...contexts].reverse()) {
    if (c.auxData?.type !== "isolated" || !/OpenFront Pro/.test(c.name ?? "")) continue;
    const probe = await send("Runtime.evaluate", { expression: "typeof chrome?.storage?.sync === 'object' && !!chrome.runtime?.id", contextId: c.id, returnByValue: true });
    if (probe.result?.result?.value !== true) continue;
    const res = await send("Runtime.evaluate", { expression, contextId: c.id, awaitPromise: true, returnByValue: true });
    return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
  }
  return "no live extension context";
};
const shot = async (name) => {
  const res = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.result.data, "base64"));
};
const click = async (x, y, modifiers = 0) => {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, modifiers });
  }
};
const NAV = `(() => { const nav = document.querySelector("desktop-nav-bar"); const b = [...nav.querySelectorAll(".ofr-nav-btn")];
  const r = b[0]?.getBoundingClientRect();
  return { count: b.length, logoTag: b[0]?.classList.contains("ofr-logo-tag") ?? false, inLogo: !!b[0]?.closest(".ofr-logo-host"), x: r ? r.x + r.width / 2 : 0, y: r ? r.y + r.height / 2 : 0 }; })()`;

// ---- 1. extension reload with the tab left open ---------------------------------
await evalIso(`chrome.storage.sync.set({ siteLayout: "default", profileLink: "ofstats" })`);
await evalPage(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"`);
console.log("before reload      ", JSON.stringify(await evalPage(NAV)));
console.log("made an old pill   ", JSON.stringify(await evalPage(`(() => {
  const nav = document.querySelector("desktop-nav-bar"); const b = nav.querySelector(".ofr-nav-btn");
  b.classList.remove("ofr-logo-tag");
  const clans = [...nav.querySelectorAll("a, button")].find((e) => /^\\s*clans\\s*$/i.test(e.textContent ?? ""));
  (clans?.parentElement ?? nav.querySelector("nav")).appendChild(b);
  return { movedAfter: clans?.textContent.trim() ?? "nav end", stillInLogo: !!b.closest(".ofr-logo-host") }; })()`)));

const browser = await connect((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
browser.ws.close();
console.log("extension reloaded ", JSON.stringify(loaded.result ?? loaded.error));
await wait(6000);
// nudge a scan in case nothing on the page mutates
await evalPage(`document.body.appendChild(document.createComment("nudge")); "ok"`);
await wait(1500);
console.log("version            ", await evalIso("chrome.runtime.getManifest().version"));
const nav = await evalPage(NAV);
console.log("after reload       ", JSON.stringify(nav));
await click(nav.x, nav.y);
await wait(2500);
console.log("tag click          ", JSON.stringify(await evalPage(`({ dash: !!document.querySelector(".ofr-dash"), text: document.querySelector(".ofr-dash")?.innerText.replace(/\\s+/g, " ").slice(0, 90) })`)));
await evalPage(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"`);
await wait(400);

// ---- 2. badge click with a stored profileLink of "ofstats" ------------------------
console.log("stored profileLink ", await evalIso(`chrome.storage.sync.get("profileLink").then((r) => r.profileLink)`));
await evalPage(`(() => {
  document.querySelector("#ofr-e2e-lobby")?.remove();
  const wrap = document.createElement("div");
  wrap.id = "ofr-e2e-lobby";
  wrap.style.cssText = "position:fixed;left:40px;top:160px;width:520px;z-index:99999;background:#14161c;padding:12px;border-radius:10px";
  wrap.innerHTML = '<lobby-player-view><div class="players-list block rounded-lg border border-white/10 bg-white/5 p-2">' +
    ["[LUX] TeNa", "Firedan", "[DFY] Rage"].map((n) => '<span class="player-tag" style="display:block;margin:6px 0"><span class="text-white">' + n + ' </span></span>').join("") +
    "</div></lobby-player-view>";
  document.body.appendChild(wrap);
  window.__opened = [];
  const orig = window.open;
  window.open = (...a) => { window.__opened.push(String(a[0])); return null; };
  return "lobby added";
})()`);
await wait(6000);
const BADGES = `(() => [...document.querySelectorAll("#ofr-e2e-lobby .ofr-badge[data-ofr-profile]")].map((b) => { const r = b.getBoundingClientRect(); return { name: b.dataset.ofrProfile, text: b.textContent.trim(), tip: (b.title || "").split("\\n").pop(), x: r.x + r.width / 2, y: r.y + r.height / 2 }; }))()`;
const badges = await evalPage(BADGES);
console.log("badges             ", JSON.stringify(badges.map((b) => `${b.name}: ${b.text}`)), "| tooltip ends:", JSON.stringify(badges[0]?.tip));
await shot("badge-lobby");

const before = (await pages()).length;
const state = () => evalPage(`({ dash: !!document.querySelector(".ofr-dash"), who: document.querySelector(".ofr-dash")?.innerText.replace(/\\s+/g, " ").slice(0, 60) ?? null, url: location.href, windowOpen: window.__opened })`);
await click(badges[0].x, badges[0].y);
await wait(2500);
console.log("badge click        ", JSON.stringify(await state()), "| tabs", before, "->", (await pages()).length);
await shot("badge-click-dashboard");

// close, and click the same badge again well inside one second
await evalPage(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"`);
await wait(250);
const closed = await evalPage(`!document.querySelector(".ofr-dash")`);
await click(badges[0].x, badges[0].y);
await wait(1200);
console.log("close + re-click   ", JSON.stringify({ closed, reopened: (await state()).dash }));
await evalPage(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"`);
await wait(300);

// Shift+click: watchlist only
await click(badges[1].x, badges[1].y, 8);
await wait(900);
console.log("shift+click        ", JSON.stringify(await evalPage(`({ dash: !!document.querySelector(".ofr-dash"), toast: document.querySelector(".ofr-toast")?.textContent ?? null, windowOpen: window.__opened })`)), "| tabs", (await pages()).length);
await click(badges[1].x, badges[1].y, 8); // un-watch again
await wait(500);

// "Nothing" still means nothing
await evalIso(`chrome.storage.sync.set({ profileLink: "none" })`);
await wait(800);
await click(badges[2].x, badges[2].y);
await wait(1000);
console.log('profileLink "none" ', JSON.stringify({ dash: (await state()).dash }));

await evalIso(`chrome.storage.sync.set({ profileLink: "dashboard" })`);
await evalPage(`document.querySelector("#ofr-e2e-lobby")?.remove(); "cleaned"`);
ws.close();
