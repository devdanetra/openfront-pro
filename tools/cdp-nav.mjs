// Dev tool. On the live front page in a debug Chrome: checks the tilted "PRO"
// tag inside the logo block (default and Sidebar website layouts), screenshots
// the nav close-up, then clicks the tag and confirms the dashboard opens.
//   CDP_PORT=9340 node tools/cdp-nav.mjs <outDir> [username]
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9340);
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
const shot = async (name, clip) => {
  const res = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 3 } } : {}) });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.result.data, "base64"));
};

const MEASURE = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const nav = document.querySelector("desktop-nav-bar nav");
  const host = nav?.querySelector(".ofr-logo-host");
  const tag = nav?.querySelector(".ofr-logo-tag");
  const img = host?.querySelector("img");
  const version = host ? [...host.querySelectorAll("div,span")].find((e) => /v?\\d+\\.\\d+/.test(e.textContent) && !e.children.length) : null;
  return { tags: document.querySelectorAll(".ofr-nav-btn").length, inLogo: !!tag && tag.parentElement === host,
    host: r(host), img: r(img), version: r(version), versionText: version?.textContent.trim() ?? null, tag: r(tag),
    transform: tag ? getComputedStyle(tag).transform : null, text: tag?.textContent.trim() ?? null,
    hostOverflow: host ? getComputedStyle(host).overflow : null, hostTag: host?.tagName ?? null,
    hScroll: document.documentElement.scrollWidth > window.innerWidth + 2 };
})()`;

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evalPage(`localStorage.setItem("username", ${JSON.stringify(USERNAME)}); "ok"`);
await send("Page.reload", { ignoreCache: true });
await wait(7000);
console.log("version:", await evalIso("chrome.runtime.getManifest().version"));

for (const site of ["default", "sidebar"]) {
  await evalIso(`chrome.storage.sync.set({ siteLayout: ${JSON.stringify(site)}, theme: "classic" })`);
  await wait(1500);
  await evalPage("window.scrollTo(0,0)");
  const m = await evalPage(MEASURE);
  console.log(site.padEnd(8), JSON.stringify(m));
  if (m?.host) {
    await shot(`nav-${site}`, { x: Math.max(0, m.host.x - 16), y: Math.max(0, m.host.y - 14), width: site === "sidebar" ? 240 : 420, height: m.host.h + 40 });
  }
  await shot(`nav-${site}-full`);
}

// real click on the tag (default layout) -> dashboard, no new tab
await evalIso(`chrome.storage.sync.set({ siteLayout: "default" })`);
await wait(1200);
const m = await evalPage(MEASURE);
const before = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === "page").length;
const cx = m.tag.x + m.tag.w / 2, cy = m.tag.y + m.tag.h / 2;
for (const type of ["mousePressed", "mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: cx, y: cy, button: "left", clickCount: 1 });
}
await wait(2500);
const after = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === "page").length;
const dash = await evalPage(`({ dash: !!document.querySelector(".ofr-dash"), title: document.querySelector(".ofr-dash h2, .ofr-dash .ofr-dash-name")?.textContent ?? null, url: location.href })`);
console.log("tag click ->", JSON.stringify(dash), "pages before/after:", before, after);
await shot("nav-click-dashboard");
await evalPage(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"`);
ws.close();
