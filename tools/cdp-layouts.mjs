// Dev tool. Screenshots the live front page under each layout template, with a real
// username set so the home card is populated. Output: <out>/layout-<name>.png
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9338);
const OUT = process.argv[2];
const USERNAME = process.argv[3] ?? "TeNa";
const LAYOUTS = (process.argv[4] ?? "cards,compact,panel").split(",");

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
  } else if (msg.method === "Runtime.executionContextCreated") {
    contexts.push(msg.params.context);
  } else if (msg.method === "Runtime.executionContextsCleared") {
    contexts.length = 0;
    isoCached = null;
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evalPage = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
    .result?.result?.value;
// Newest matching context: after an extension reload the old, dead isolated
// world is still listed, and evaluating there returns nothing useful.
// Several isolated worlds can carry the extension's name (dead ones from before
// a reload, and ones without the chrome.* APIs); the right one is whichever can
// see chrome.storage. Probed once, newest first.
let isoCached = null;
const isoContext = async () => {
  if (isoCached && contexts.includes(isoCached)) return isoCached;
  const candidates = [...contexts]
    .reverse()
    .filter((c) => c.auxData?.type === "isolated" && /OpenFront Pro/.test(c.name ?? ""));
  for (const c of candidates) {
    const res = await send("Runtime.evaluate", {
      expression: "typeof chrome?.storage?.sync", contextId: c.id, returnByValue: true,
    });
    if (res.result?.result?.value === "object") {
      isoCached = c;
      return c;
    }
  }
  return null;
};
const evalIso = async (expression) => {
  const ctx = await isoContext();
  if (!ctx) return "no isolated context with chrome.storage";
  const res = await send("Runtime.evaluate", {
    expression, contextId: ctx.id, awaitPromise: true, returnByValue: true,
  });
  if (res.error) return `cdp error: ${res.error.message}`;
  if (res.result?.exceptionDetails) return `threw: ${res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text}`;
  return res.result?.result?.value;
};

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// A username, so the card has someone to show; then a fresh load.
await evalPage(`localStorage.setItem("username", ${JSON.stringify(USERNAME)}); "set"`);
await send("Page.reload", { ignoreCache: true });
await wait(7000);

for (const layout of LAYOUTS) {
  const r = await evalIso(`(async () => {
    await chrome.storage.sync.set({ layout: ${JSON.stringify(layout)}, uiSize: "medium" });
    await new Promise(r => setTimeout(r, 400));
    // make the card refetch/re-render under the new layout
    document.querySelector(".ofr-home")?.remove();
    document.body.appendChild(document.createComment("relayout"));
    await new Promise(r => setTimeout(r, 2500));
    const c = document.querySelector(".ofr-home");
    const b = c?.getBoundingClientRect();
    if (c) c.scrollIntoView({ block: "center" });
    return { layoutAttr: document.documentElement.dataset.ofrLayout ?? "cards", card: !!c, w: Math.round(b?.width ?? 0), h: Math.round(b?.height ?? 0), name: c?.querySelector(".ofr-home-name")?.textContent ?? null };
  })()`);
  await wait(600);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/layout-${layout}.png`, Buffer.from(shot.result.data, "base64"));
  console.log(layout, JSON.stringify(r));
}

// Size check on the default layout.
await evalIso(`chrome.storage.sync.set({ layout: "cards", uiSize: "large" })`);
await wait(800);
const big = await evalIso(`(() => { const b = document.querySelector(".ofr-home")?.getBoundingClientRect(); return { w: Math.round(b?.width ?? 0), h: Math.round(b?.height ?? 0) }; })()`);
console.log("large size card:", JSON.stringify(big));
await evalIso(`chrome.storage.sync.set({ uiSize: "medium" })`);
ws.close();
