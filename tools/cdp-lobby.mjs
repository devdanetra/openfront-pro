// Dev tool. Joins the featured PUBLIC lobby on the live site in a debug Chrome,
// reports what the page and the extension know there (lobby id, own client id,
// chat room, probe payload), screenshots, and LEAVES at once so no slot stays
// taken and no game is entered.
//   CDP_PORT=9343 node tools/cdp-lobby.mjs <outDir> [seconds to stay, default 6]
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9343);
const OUT = process.argv[2];
const STAY = Number(process.argv[3] ?? 6) * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page" && t.url.includes("openfront.io"));
const ws = new WebSocket(target.webSocketDebuggerUrl);
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
const page = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
};
const iso = async (expression) => {
  for (const c of [...contexts].reverse()) {
    if (c.auxData?.type !== "isolated" || !/OpenFront Pro/.test(c.name ?? "")) continue;
    const probe = await send("Runtime.evaluate", { expression: "typeof chrome?.storage?.sync === 'object' && !!chrome.runtime?.id", contextId: c.id, returnByValue: true });
    if (probe.result?.result?.value !== true) continue;
    const res = await send("Runtime.evaluate", { expression, contextId: c.id, awaitPromise: true, returnByValue: true });
    return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
  }
  return "no live extension context";
};

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "https://openfront.io/" });
await wait(Number(process.env.SETTLE ?? 8) * 1000); // the site needs a moment before it lets you join
console.log("extension", await iso("chrome.runtime.getManifest().version"));
await iso(`chrome.storage.sync.set({ chatEnabled: true })`);

const CARDS = `[...document.querySelectorAll("button, [role=button]")].filter((b) => /\\b\\d+\\s*\\/\\s*\\d+\\b/.test(b.textContent || ""))`;
console.log("cards:", JSON.stringify(await page(`${CARDS}.map((b) => b.textContent.replace(/\\s+/g, " ").trim().slice(0, 70)).slice(0, 4)`)));
// a real mouse click: the cards ignore a synthetic element.click()
// Not a locked one (red padlock), and the one with the most time left, so there
// is no risk of being carried into the game before we leave.
const spot = await page(`(() => {
  const secs = (b) => { const t = b.textContent; const m = /([0-9]+) *min/.exec(t); const s = /([0-9]+) *s(?![a-z])/i.exec(t); return (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0); };
  const c = ${CARDS}.filter((b) => !b.querySelector('[class*="red"]')).sort((a, b) => secs(b) - secs(a));
  if (!c.length || secs(c[0]) < 45) return null;
  c[0].scrollIntoView({ block: "center" });
  const r = c[0].getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, card: c[0].textContent.replace(/[^!-~]+/g, " ").trim().slice(0, 60) };
})()`);
if (!spot) { console.log("no unlocked lobby with 45s+ left right now"); process.exit(0); }
for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: spot.x, y: spot.y, button: "left", clickCount: 1 });
console.log("click: real mouse at", JSON.stringify(spot));
await wait(STAY);
console.log(
  "lobby:",
  JSON.stringify(
    await page(`(() => {
      const j = document.querySelector("join-lobby-modal");
      const shown = [...(j?.querySelectorAll("div") ?? [])].some((d) => d.getBoundingClientRect().width > 0);
      const mine = (j?.players ?? []).find((p) => p.clientID === j?.currentClientID) ?? null;
      return {
        url: location.pathname + location.search,
        modalShown: shown,
        lobbyId: j?.currentLobbyId ?? null,
        clientID: j?.currentClientID ?? null,
        players: j?.players?.length ?? null,
        playerKeys: j?.players?.[0] ? Object.keys(j.players[0]) : null,
        myRow: mine,
        probe: document.documentElement.dataset.ofrMap ? JSON.parse(document.documentElement.dataset.ofrMap) : null,
        gameAttr: document.documentElement.dataset.ofrGame ?? null,
        chat: (() => { const c = document.querySelector(".ofr-chat"); return c ? { mode: c.dataset.mode, tab: c.querySelector(".ofr-chat-tab").textContent, title: c.querySelector(".ofr-chat-title").textContent, status: c.querySelector(".ofr-chat-status").textContent } : null; })(),
        error: document.body.innerText.includes("Connection error"),
      };
    })()`),
  ),
);
const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(`${OUT}/lobby-live.png`, Buffer.from(shot.result.data, "base64"));
await send("Page.navigate", { url: "https://openfront.io/" }); // leave: free the slot
await wait(3000);
await iso(`chrome.storage.sync.set({ chatEnabled: false })`);
console.log("left:", await page("location.pathname"));
ws.close();
