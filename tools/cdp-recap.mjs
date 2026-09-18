// Dev tool. Drives the real recap in a debug Chrome with the extension loaded,
// without playing a game: it points the tab at /game/<id> of a FINISHED public
// game (history.pushState, no navigation) and adds a stand-in <win-modal>, which
// is exactly what the content script waits for. The record, the percentile
// lookups and the rendering are all the real thing.
//   CDP_PORT=9341 node tools/cdp-recap.mjs <outDir>
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9341);
const OUT = process.argv[2];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// [game id, who to be, label, extra]
const CASES = [
  ["5S99ULQP", "TeNa", "ffa-win", { tabs: true, themes: ["neon", "pastel"], card: true }],
  ["ddNXyXafFo", "@eliminated", "ffa-out", { tabs: true, card: true }],
  ["yfMnoHJP", "TeNa", "team-win", { card: true }],
  ["dVLrYJEaGm", "hyLine", "1v1-loss", {}],
  ["dfReijmudi", "USSR", "duplicate-name", {}],
  ["d4tvvVquk6", "@eliminated", "narrow-overlap", { narrow: true }],
  // a game that ended within the hour: the only kind that may enter today's session
  ["@fresh", "@eliminated", "fresh-session", { streamer: true }],
];

// node's fetch sometimes times out on the first (IPv6) address; a retry gets through
const getJson = async (url) => {
  for (let i = 0; ; i++) {
    try {
      return await (await fetch(url, { headers: { accept: "application/json" } })).json();
    } catch (err) {
      if (i >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
};
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null; // run a subset of CASES by label

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
const shotWidget = async (name) => {
  const r = await evalPage(`(() => { const b = document.querySelector(".ofr-recap")?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; })()`);
  if (!r) return false;
  const res = await send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16, scale: 2 } });
  fs.writeFileSync(`${OUT}/recap-${name}.png`, Buffer.from(res.result.data, "base64"));
  return true;
};

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.reload", { ignoreCache: true });
await wait(7000);
console.log("version", await evalIso("chrome.runtime.getManifest().version"));
await evalIso(`chrome.storage.sync.set({ theme: "classic", themeSite: true, showRecap: true, streamerMode: false, layout: "cards", uiSize: "medium" }).then(() => chrome.storage.local.remove(["recapCollapsed", "session"]))`);

for (let [gameId, who, label, opt] of CASES) {
  if (ONLY && !ONLY.includes(label)) continue;
  let name = who;
  if (gameId === "@fresh") {
    const end = new Date();
    const start = new Date(end.getTime() - 90 * 60 * 1000);
    const games = await getJson(`https://api.openfront.io/public/games?start=${start.toISOString()}&end=${end.toISOString()}&type=Public`);
    const pick = games.filter((g) => g.mode === "Free For All" && g.numPlayers >= 20 && g.end).sort((a, b) => new Date(b.end) - new Date(a.end))[0];
    if (!pick) { console.log("[fresh-session] no recent public FFA game found; skipped"); continue; }
    gameId = pick.game;
    console.log(`(fresh game ${gameId} ended ${Math.round((Date.now() - new Date(pick.end)) / 60000)} min ago)`);
  }
  if (who === "@eliminated") {
    const raw = await getJson(`https://api.openfront.io/public/game/${gameId}?turns=false`);
    const dead = raw.info.players.filter((p) => p.stats?.killedAt != null).sort((a, b) => Number(b.stats.killedAt) - Number(a.stats.killedAt));
    const pick = dead.filter((p) => raw.info.players.filter((q) => q.username === p.username).length === 1 && !/^Anon/.test(p.username))[Math.floor(dead.length * 0.25)] ?? dead[0];
    name = pick.username;
  }
  if (opt.narrow) await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 700, deviceScaleFactor: 1, mobile: false });
  await evalPage(`(() => {
    document.querySelector("#ofr-fake-win")?.remove();
    document.querySelector(".ofr-recap")?.remove();
    localStorage.setItem("username", ${JSON.stringify(name)});
    history.pushState({}, "", "/game/${gameId}");
    // a visible child inside the page's OWN <win-modal>: removing or replacing that
    // element breaks the next real game (the client wires it up on start)
    const modal = document.querySelector("win-modal") ?? document.body.appendChild(document.createElement("win-modal"));
    const box = document.createElement("div");
    box.id = "ofr-fake-win";
    box.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:520px;height:380px;background:#1f2937;border-radius:12px;z-index:9000;color:#fff;display:grid;place-items:center;font:600 20px system-ui";
    box.textContent = "stand-in for the game's win modal";
    modal.appendChild(box);
    return "ok";
  })()`);
  // record + up to 40 lookups + the fresh self lookup
  let state = null;
  for (let i = 0; i < 40; i++) {
    await wait(1000);
    state = await evalPage(`(() => { const r = document.querySelector(".ofr-recap"); return r ? { min: r.dataset.min, tabs: r.querySelectorAll(".ofr-recap-tabs button").length, foot: r.querySelector(".ofr-recap-foot")?.childElementCount ?? 0, badges: r.querySelectorAll(".ofr-badge").length } : null; })()`);
    if (state?.tabs && (state.foot > 0 || i > 25)) break;
  }
  const model = await evalIso(`(() => { const m = globalThis.__ofrRecapModel?.(); return m && m.state === "ok" ? { title: m.result.title, of: m.result.of, kicker: m.result.kicker, me: m.me, chips: m.chips.map((c) => c.text + " " + c.label + (c.ranked ? " #" + c.rank : "")), lines: m.lines.map((l) => l.text), awards: m.awards.length, ranked: m.charts.field.ranked, players: m.meta.players } : m; })()`);
  console.log(`\n[${label}] ${gameId} as ${name}`);
  console.log("  dom  ", JSON.stringify(state));
  console.log("  model", JSON.stringify(model));
  console.log("  foot ", JSON.stringify(await evalPage(`[...document.querySelectorAll(".ofr-recap-foot div")].map((d) => d.textContent)`)));
  await shotWidget(`${label}-summary`);
  if (opt.narrow) {
    await wait(500);
    console.log("  folded because it would cover the win modal:", (await evalPage(`document.querySelector(".ofr-recap")?.dataset.min`)) === "true", "| title bar:", await evalPage(`document.querySelector(".ofr-recap-title")?.textContent`));
    await evalPage(`document.querySelector(".ofr-recap-head").click(); "expand"`);
    await wait(400);
    await send("Emulation.setDeviceMetricsOverride", { width: 830, height: 700, deviceScaleFactor: 1, mobile: false }); // a resize re-runs the check
    await wait(500);
    console.log("  the user expanded it, and a resize does not fold it again:", (await evalPage(`document.querySelector(".ofr-recap").dataset.min`)) === "false");
    await evalIso(`chrome.storage.local.remove("recapCollapsed")`);
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  if (opt.streamer) {
    await evalIso(`chrome.storage.sync.set({ streamerMode: true })`);
    await wait(1500);
    const leak = await evalPage(`(() => { const t = document.querySelector(".ofr-recap").innerText; return { namePrinted: t.toLowerCase().includes(${JSON.stringify(name.toLowerCase())}), who: document.querySelector(".ofr-recap-name")?.textContent }; })()`);
    await evalPage(`[...document.querySelectorAll(".ofr-recap-actions button")].find((b) => /My stats/.test(b.textContent)).click(); "ok"`);
    await wait(2500);
    const dash = await evalPage(`({ search: document.querySelector(".ofr-dash input[type=search], .ofr-dash input")?.value ?? null, shown: document.querySelector(".ofr-dash-name")?.textContent ?? null, ofstatsLink: !!document.querySelector(".ofr-dash-link") })`);
    console.log("  streamer mode flipped on while open:", JSON.stringify(leak), "| dashboard:", JSON.stringify(dash));
    await shotWidget(`${label}-streamer`);
    await evalPage(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"`);
    await evalIso(`chrome.storage.sync.set({ streamerMode: false })`);
    await wait(600);
  }
  if (opt.tabs) {
    for (const tab of ["graphs", "awards", "standings"]) {
      await evalPage(`document.querySelector('.ofr-recap-tabs button[data-tab="${tab}"]').click(); "ok"`);
      await wait(400);
      await shotWidget(`${label}-${tab}`);
    }
    await evalPage(`document.querySelector('.ofr-recap-tabs button[data-tab="summary"]').click(); "ok"`);
  }
  for (const theme of opt.themes ?? []) {
    await evalIso(`chrome.storage.sync.set({ theme: ${JSON.stringify(theme)} })`);
    await wait(1200);
    await shotWidget(`${label}-summary-${theme}`);
    await evalPage(`document.querySelector('.ofr-recap-tabs button[data-tab="graphs"]').click(); "ok"`);
    await wait(300);
    await shotWidget(`${label}-graphs-${theme}`);
    if (opt.card) {
      const url = await evalIso(`globalThis.OFR_RECAP.drawCard(globalThis.__ofrRecapModel(), { icon: () => "" }).toDataURL("image/png")`);
      if (typeof url === "string" && url.startsWith("data:")) fs.writeFileSync(`${OUT}/recap-${label}-card-${theme}.png`, Buffer.from(url.split(",")[1], "base64"));
    }
    await evalPage(`document.querySelector('.ofr-recap-tabs button[data-tab="summary"]').click(); "ok"`);
  }
  if (opt.themes) await evalIso(`chrome.storage.sync.set({ theme: "classic" })`);
  if (opt.card) {
    await wait(600);
    const url = await evalIso(`globalThis.OFR_RECAP.drawCard(globalThis.__ofrRecapModel(), { icon: () => "" }).toDataURL("image/png")`);
    if (typeof url === "string" && url.startsWith("data:")) fs.writeFileSync(`${OUT}/recap-${label}-card.png`, Buffer.from(url.split(",")[1], "base64"));
    else console.log("  card:", String(url).slice(0, 200));
  }
}
console.log("\nsession store:", JSON.stringify(await evalIso(`chrome.storage.local.get("session").then((r) => r.session?.games?.map((g) => ({ id: g.gameId, place: g.place, won: g.won })))`)));
await evalPage(`document.querySelector("#ofr-fake-win")?.remove(); document.querySelector(".ofr-recap")?.remove(); history.pushState({}, "", "/"); localStorage.setItem("username", "TeNa"); "cleaned"`);
ws.close();
