// Dev tool. Unified theme checks in a debug Chrome with the extension loaded:
//   1. migration: an old profile with theme:"classic" + pageTheme:"tactical"
//      must come out as theme:"tactical", no pageTheme, after a reload;
//   2. one setting drives both <html data-ofr-theme> and data-ofr-page-theme;
//      "Recolour OpenFront too" off drops only the second; classic drops both;
//   3. screenshots: front page, dashboard (with the Trends graphs) and the
//      popup, per theme.
//   CDP_PORT=9341 node tools/cdp-themes.mjs <outDir> [extensionPath] [themes]
import nodePath from "node:path";
import { fileURLToPath as toPath } from "node:url";
const REPO_ROOT = nodePath.resolve(nodePath.dirname(toPath(import.meta.url)), "..");
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9341);
const OUT = process.argv[2];
const EXT = process.argv[3] ?? REPO_ROOT; // the unpacked extension = this repository
const THEMES = (process.argv[4] ?? "classic,neon,tactical,pastel,mono,contrast").split(",");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

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

const browserUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
const reloadExtension = async () => {
  const b = await connect(browserUrl);
  const res = await b.send("Extensions.loadUnpacked", { path: EXT });
  b.ws.close();
  return res.result?.id ?? JSON.stringify(res.error);
};

const target = (await list()).find((t) => t.type === "page" && t.url.includes("openfront.io"));
const { ws, send, contexts } = await connect(target.webSocketDebuggerUrl);
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const evalPage = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
};
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
const shot = async (name, s = send) => {
  const res = await s("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.result.data, "base64"));
};
const ATTRS = `({ theme: document.documentElement.dataset.ofrTheme ?? null, page: document.documentElement.dataset.ofrPageTheme ?? null })`;

// ---- 1. migration -------------------------------------------------------------------
await evalPage(`localStorage.setItem("username", "TeNa"); "ok"`);
console.log("seed old profile  ", await evalIso(`chrome.storage.sync.remove(["themeSite", "themesMigrated"]).then(() => chrome.storage.sync.set({ theme: "classic", pageTheme: "tactical", siteLayout: "default" })).then(() => "theme:classic + pageTheme:tactical")`));
const extId = await reloadExtension();
await wait(5000);
await send("Page.reload", { ignoreCache: true });
await wait(7000);
console.log("version           ", await evalIso("chrome.runtime.getManifest().version"));
console.log("after migration   ", JSON.stringify(await evalIso(`chrome.storage.sync.get(["theme", "pageTheme", "themeSite"])`)), JSON.stringify(await evalPage(ATTRS)));

// explicit "off" with a widget theme keeps the site untouched
await evalIso(`chrome.storage.sync.remove(["themeSite", "themesMigrated"]).then(() => chrome.storage.sync.set({ theme: "neon", pageTheme: "off" }))`);
await reloadExtension();
await wait(5000);
await send("Page.reload", { ignoreCache: true });
await wait(7000);
console.log("neon + site 'off' ", JSON.stringify(await evalIso(`chrome.storage.sync.get(["theme", "pageTheme", "themeSite"])`)), JSON.stringify(await evalPage(ATTRS)));

// the common 5.4 profile: a badge theme, the site picker never touched (nothing stored)
await evalIso(`chrome.storage.sync.remove(["themeSite", "themesMigrated", "pageTheme"]).then(() => chrome.storage.sync.set({ theme: "pastel" }))`);
await reloadExtension();
await wait(5000);
await send("Page.reload", { ignoreCache: true });
await wait(7000);
console.log("pastel, site never themed ", JSON.stringify(await evalIso(`chrome.storage.sync.get(["theme", "pageTheme", "themeSite", "themesMigrated"])`)), JSON.stringify(await evalPage(ATTRS)));
// migrated once: a stray pageTheme written later by a 5.4 machine changes nothing here
await evalIso(`chrome.storage.sync.set({ pageTheme: "mono" })`);
await reloadExtension();
await wait(5000);
await send("Page.reload", { ignoreCache: true });
await wait(7000);
console.log("stray pageTheme afterwards", JSON.stringify(await evalIso(`chrome.storage.sync.get(["theme", "pageTheme", "themeSite"])`)), JSON.stringify(await evalPage(ATTRS)));
await evalIso(`chrome.storage.sync.remove("pageTheme")`);

// ---- 2. one setting drives both -------------------------------------------------------
await evalIso(`chrome.storage.sync.set({ theme: "neon", themeSite: true })`);
await wait(800);
console.log("neon, site on     ", JSON.stringify(await evalPage(ATTRS)));
await evalIso(`chrome.storage.sync.set({ themeSite: false })`);
await wait(800);
console.log("neon, site off    ", JSON.stringify(await evalPage(ATTRS)));
await evalIso(`chrome.storage.sync.set({ theme: "classic", themeSite: true })`);
await wait(800);
console.log("classic           ", JSON.stringify(await evalPage(ATTRS)));

// ---- 3. screenshots ---------------------------------------------------------------------
const b = await connect(browserUrl);
const popupTarget = await b.send("Target.createTarget", { url: `chrome-extension://${extId}/src/popup.html` });
b.ws.close();
await wait(1500);
const popupInfo = (await list()).find((t) => t.id === popupTarget.result?.targetId);
const popup = popupInfo ? await connect(popupInfo.webSocketDebuggerUrl) : null;
if (popup) await popup.send("Emulation.setDeviceMetricsOverride", { width: 290, height: 900, deviceScaleFactor: 2, mobile: false });

for (const theme of THEMES) {
  await evalIso(`chrome.storage.sync.set({ theme: ${JSON.stringify(theme)}, themeSite: true })`);
  await wait(1500);
  await evalPage(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); window.scrollTo(0, 0); "ok"`);
  await wait(300);
  await shot(`theme-${theme}-home`);
  await evalIso(`globalThis.__ofrOpenDashboard("TeNa", { self: false, clanStats: false }); "open"`);
  await wait(3500);
  const trends = await evalPage(`(() => { const secs = [...document.querySelectorAll(".ofr-dash-section")]; const t = secs.find((s) => /Trends/.test(s.querySelector("h2")?.textContent ?? "")); t?.scrollIntoView({ block: "start" }); return { charts: t ? t.querySelectorAll("svg.ofr-chart").length : 0, cols: t ? t.querySelectorAll(".ofr-chart-col").length : 0, line: !!t?.querySelector(".ofr-chart-line") }; })()`);
  await wait(500);
  await shot(`theme-${theme}-dashboard`);
  console.log(theme.padEnd(9), "attrs", JSON.stringify(await evalPage(ATTRS)), "trends", JSON.stringify(trends));
  if (popup) {
    await popup.send("Page.reload", {});
    await wait(1200);
    await shot(`theme-${theme}-popup`, popup.send);
  }
}
if (popup) {
  const r = await popup.send("Runtime.evaluate", { expression: `({ theme: document.getElementById("theme").value, blurb: document.getElementById("theme-blurb").textContent, siteChecked: document.getElementById("themeSite").checked, siteDisabled: document.getElementById("themeSite").disabled, pageThemeSelect: !!document.getElementById("pageTheme") })`, returnByValue: true });
  console.log("popup state       ", JSON.stringify(r.result?.result?.value));
  popup.ws.close();
  const bb = await connect(browserUrl);
  await bb.send("Target.closeTarget", { targetId: popupTarget.result.targetId });
  bb.ws.close();
}
await evalPage(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"`);
await evalIso(`chrome.storage.sync.set({ theme: "classic", themeSite: true })`);
ws.close();
