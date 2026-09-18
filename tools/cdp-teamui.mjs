// Dev tool. Screenshots the chat panel's Team tab in three made-up states (a
// teammate asks; the three emojis; verified with messages) in a debug Chrome that
// has the extension loaded, on the site's home page. No game is joined and no
// relay is contacted: the panel is frozen on the state by chat.js' debug hook.
//   CDP_PORT=9345 node tools/cdp-teamui.mjs <outDir> [theme]
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9345);
const OUT = process.argv[2] ?? ".shots";
const THEME = process.argv[3] ?? null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page" && t.url.includes("openfront.io"));
if (!target) throw new Error("no openfront.io tab in the debug Chrome");
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
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
const iso = async (expression) => {
  for (const c of [...contexts].reverse()) {
    if (c.auxData?.type !== "isolated" || !/OpenFront Pro/.test(c.name ?? "")) continue;
    const probe = await send("Runtime.evaluate", { expression: "typeof globalThis.__ofrChatDebug === 'object' && !!chrome.runtime?.id", contextId: c.id, returnByValue: true });
    if (probe.result?.result?.value !== true) continue;
    const res = await send("Runtime.evaluate", { expression, contextId: c.id, awaitPromise: true, returnByValue: true });
    return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
  }
  return "no live extension context";
};

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: "https://openfront.io/" });
await wait(8000);
console.log("extension", await iso("chrome.runtime.getManifest().version"));
if (THEME) {
  await iso(`chrome.storage.sync.set({ theme: ${JSON.stringify(THEME)} })`);
  await wait(800);
}

const K = (ch) => ch.repeat(64);
const base = { ready: true, spawn: false, alive: true, catchingUp: false, me: 3, key: K("0"), trusted: 0, reachable: 0, impersonated: false, note: "", pairing: null };
const states = {
  "1-asks": {
    state: { ...base, mates: [{ sid: 5, name: "[UN] Garibaldi", alive: true, keys: [{ key: K("a"), status: "claimed", mutual: false, live: true, asks: true }] }, { sid: 7, name: "TeNa", alive: true, keys: [{ key: K("b"), status: "claimed", mutual: false, live: true, asks: false }] }, { sid: 9, name: "Anon42", alive: true, keys: [] }] },
    messages: [],
  },
  "2-emojis": {
    state: { ...base, mates: [{ sid: 5, name: "[UN] Garibaldi", alive: true, keys: [{ key: K("a"), status: "claimed", mutual: false, live: true, asks: false }] }, { sid: 7, name: "TeNa", alive: true, keys: [{ key: K("b"), status: "claimed", mutual: false, live: true, asks: false }] }], pairing: { peerSid: 5, peerName: "[UN] Garibaldi", peerKey: K("a"), stage: "emojis", emojis: [String.fromCodePoint(0x1f525), String.fromCodePoint(0x1f451), String.fromCodePoint(0x2693)], mine: 1, theirs: false, unseen: false, wait: 4, endsAt: Date.now() + 131000 } },
    messages: [],
  },
  "3-verified": {
    state: { ...base, trusted: 2, reachable: 2, mates: [{ sid: 5, name: "[UN] Garibaldi", alive: true, keys: [{ key: K("a"), status: "direct", mutual: true, live: true, asks: false }] }, { sid: 7, name: "TeNa", alive: true, keys: [{ key: K("b"), status: "vouched", mutual: true, live: true, asks: false }] }, { sid: 8, name: "Mallory?", alive: true, keys: [{ key: K("c"), status: "claimed", mutual: false, live: true, asks: false }, { key: K("d"), status: "claimed", mutual: false, live: true, asks: true }] }] },
    messages: [{ kind: "msg", name: "[UN] Garibaldi", text: "push east, I cover the coast", at: Date.now() - 40000 }, { kind: "msg", name: "you", text: "ok - sending boats at 6:00", at: Date.now() - 20000, mine: true, to: 2, skipped: 0 }, { kind: "msg", name: "TeNa", text: "nuke ready in 30s", at: Date.now() - 5000 }],
  },
};
for (const [name, s] of Object.entries(states)) {
  console.log(name, await iso(`(globalThis.__ofrChatDebug.demoTeam(${JSON.stringify(s.state)}, ${JSON.stringify(s.messages)}), JSON.stringify(globalThis.__ofrChatDebug.state().teamRows).slice(0, 300))`));
  await wait(700);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 120, width: 340, height: 520, scale: 1 } });
  fs.writeFileSync(`${OUT}/team-${name}.png`, Buffer.from(shot.result.data, "base64"));
}
await send("Page.navigate", { url: "https://openfront.io/" }); // drops the frozen demo panel
ws.close();
