// Dev tool. On the live front page in a debug Chrome: screenshots each website
// layout template, then proves a page theme also covers :hover by forcing the
// pseudo-class on the SOLO button and reading its computed background.
//   CDP_PORT=9339 node tools/cdp-site.mjs <outDir> [username]
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9339);
const OUT = process.argv[2];
const USERNAME = process.argv[3] ?? "TeNa";

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("openfront.io"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map();
const contexts = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.executionContextCreated") contexts.push(msg.params.context);
  else if (msg.method === "Runtime.executionContextsCleared") contexts.length = 0;
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evalPage = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.text}` : res.result?.result?.value;
};
let iso = null;
const evalIso = async (expression) => {
  if (!iso || !contexts.includes(iso)) {
    iso = null;
    for (const c of [...contexts].reverse()) {
      if (c.auxData?.type !== "isolated" || !/OpenFront Pro/.test(c.name ?? "")) continue;
      const probe = await send("Runtime.evaluate", { expression: "typeof chrome?.storage?.sync", contextId: c.id, returnByValue: true });
      if (probe.result?.result?.value === "object") { iso = c; break; }
    }
  }
  if (!iso) return "no extension context";
  const res = await send("Runtime.evaluate", { expression, contextId: iso.id, awaitPromise: true, returnByValue: true });
  return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
};
const shot = async (name) => {
  const res = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.result.data, "base64"));
};

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evalPage(`localStorage.setItem("username", ${JSON.stringify(USERNAME)}); "ok"`);
await send("Page.reload", { ignoreCache: true });
await wait(7000);
console.log("version:", await evalIso("chrome.runtime.getManifest().version"));

for (const site of ["default", "wide", "sidebar", "focus"]) {
  await evalIso(`chrome.storage.sync.set({ siteLayout: ${JSON.stringify(site)}, layout: "cards", uiSize: "medium" })`);
  await wait(1500);
  const info = await evalPage(`(() => {
    const col = document.querySelector("main > div")?.getBoundingClientRect();
    const nav = document.querySelector("desktop-nav-bar")?.getBoundingClientRect();
    const gms = document.querySelector("game-mode-selector")?.getBoundingClientRect();
    window.scrollTo(0, 0);
    return { attr: document.documentElement.dataset.ofrSite ?? "default",
      column: col ? Math.round(col.width) : null,
      nav: nav ? Math.round(nav.width) + "x" + Math.round(nav.height) : null,
      play: gms ? Math.round(gms.width) + "x" + Math.round(gms.height) : null,
      newsShown: !!document.querySelector("news-box")?.getClientRects().length,
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 2 };
  })()`);
  await wait(400);
  await shot(`site-${site}`);
  console.log(site.padEnd(8), JSON.stringify(info));
}

// ---- hover proof --------------------------------------------------------------
await evalIso(`chrome.storage.sync.set({ siteLayout: "default", theme: "neon", themeSite: true })`);
await wait(1200);
await send("DOM.enable");
await send("CSS.enable");
const doc = await send("DOM.getDocument", { depth: 1 });
const found = await send("DOM.querySelector", {
  nodeId: doc.result.root.nodeId,
  selector: "game-mode-selector button",
});
const nodeId = found.result?.nodeId;
const read = () => evalPage(`(() => { const b = [...document.querySelectorAll("game-mode-selector button")].find(x => /solo/i.test(x.textContent)) ?? document.querySelector("game-mode-selector button"); return getComputedStyle(b).backgroundColor; })()`);
// force :hover on every play button so whichever one SOLO is gets it
const all = await send("DOM.querySelectorAll", { nodeId: doc.result.root.nodeId, selector: "game-mode-selector button" });
const base = await read();
for (const n of all.result?.nodeIds ?? [nodeId]) {
  await send("CSS.forcePseudoState", { nodeId: n, forcedPseudoClasses: ["hover"] });
}
await wait(400);
const hovered = await read();
await shot("theme-neon-hover");
console.log("neon SOLO button  base:", base, " hover:", hovered);
for (const n of all.result?.nodeIds ?? [nodeId]) {
  await send("CSS.forcePseudoState", { nodeId: n, forcedPseudoClasses: [] });
}
await evalIso(`chrome.storage.sync.set({ theme: "classic" })`);
ws.close();
