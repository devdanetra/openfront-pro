// Dev tool. Two real Chromes (two profiles = two chat keys), the extension loaded
// in both, both pointed at the same finished game's end screen - then they talk
// through the real public relays.
//   node tools/cdp-chat.mjs <outDir> [portA] [portB]
// Checks: off by default; room joins; A -> B and B -> A delivery; names are text
// (an HTML name stays inert); mute; pause while "alive in a running game";
// streamer mode keeps the name off the wire; leaving the game tears it down.
import fs from "node:fs";

const OUT = process.argv[2];
const PORTS = [Number(process.argv[3] ?? 9343), Number(process.argv[4] ?? 9344)];
const GAME = "5S99ULQP";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(port, username) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page" && t.url.includes("openfront.io"));
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
  const shot = async (name) => {
    const res = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 200, width: 420, height: 500, scale: 2 } });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.result.data, "base64"));
  };
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page(`localStorage.setItem("username", ${JSON.stringify(username)}); "ok"`);
  await wait(1500);
  // a clean slate BEFORE the page (and with it the chat's mute list) loads
  await iso(`chrome.storage.sync.set({ showRecap: false, streamerMode: false, chatDuringGame: false, chatFilter: true }).then(() => chrome.storage.sync.remove("chatEnabled")).then(() => chrome.storage.local.remove(["chatMuted", "chatOpen", "chatNoteSeen"]))`);
  await send("Page.reload", { ignoreCache: true });
  await wait(7000);
  // The panel lives in a closed shadow root and ignores synthetic input, so the
  // page world cannot drive it (by design). The extension's isolated world can.
  const say = (text) => iso(`globalThis.__ofrChatDebug.say(${JSON.stringify(text)}); "sent"`);
  const state = async () => {
    const st = await iso(`globalThis.__ofrChatDebug?.state() ?? null`);
    if (!st || !st.built) return null;
    return { open: String(st.open), mode: st.mode, tab: st.tab, status: `${st.here} here · ${st.relays.open}/${st.relays.total} relays`, rows: st.rows, injected: st.markup > 0, inputHidden: st.inputHidden, log: st.log };
  };
  const endScreen = () =>
    page(`(() => { document.querySelector("#ofr-fake-win")?.remove(); history.pushState({}, "", "/game/${GAME}"); const m = document.querySelector("win-modal") ?? document.body.appendChild(document.createElement("win-modal")); const b = document.createElement("div"); b.id = "ofr-fake-win"; b.style.cssText = "position:fixed;left:50%;top:40%;width:300px;height:120px;background:#1f2937;z-index:9000"; m.appendChild(b); return "end screen"; })()`);
  return { page, iso, shot, say, state, endScreen, send, close: () => ws.close() };
}

const A = await attach(PORTS[0], "Alice");
const B = await attach(PORTS[1], '<img src=x onerror=alert(1)><b>Bob</b>');
console.log("versions", await A.iso("chrome.runtime.getManifest().version"), await B.iso("chrome.runtime.getManifest().version"));

for (const X of [A, B]) await X.iso(`chrome.storage.sync.set({ showRecap: false, streamerMode: false, chatDuringGame: false, chatFilter: true }).then(() => chrome.storage.sync.remove("chatEnabled")).then(() => chrome.storage.local.remove(["chatMuted", "chatOpen", "chatNoteSeen"]))`);
await A.endScreen();
await B.endScreen();
await wait(2500);
console.log("1. off by default, no panel, no sockets:", (await A.state()) === null && (await B.state()) === null);

for (const X of [A, B]) await X.iso(`chrome.storage.sync.set({ chatEnabled: true })`);
await wait(6000);
for (const X of [A, B]) await X.iso(`globalThis.__ofrChatDebug.open(); "open"`);
await wait(1500);
console.log("2. joined:", JSON.stringify(await A.state()));

await A.say("hello from Alice");
await wait(2500);
await B.say("hi Alice <script>alert(2)</script> https://evil.example/x");
await wait(3000);
const a1 = await A.state();
const b1 = await B.state();
console.log("3. A sees:", JSON.stringify(a1.rows));
console.log("   B sees:", JSON.stringify(b1.rows));
console.log("   delivered both ways:", a1.rows.some((r) => /hi Alice/.test(r)) && b1.rows.some((r) => /hello from Alice/.test(r)), "| markup stayed text:", !a1.injected && !b1.injected, "| presence:", a1.status, "/", b1.status);
await A.shot("chat-a");

await A.say("you fucking noob");
await wait(2500);
console.log("4. word filter on B:", JSON.stringify((await B.state()).rows.slice(-1)));

// mute: B mutes A, A keeps talking
await B.iso(`globalThis.__ofrChatDebug.mute((globalThis.__ofrChatDebug.state().log.find((m) => m.kind === "msg" && !m.mine) ?? {}).pubkey ?? "none")`);
await wait(500);
await wait(1300);
await A.say("can you still hear me?");
await wait(2500);
console.log("5. after B muted A:", JSON.stringify((await B.state()).rows));

// pause: B is now "alive in a running game"
await B.page(`(() => { document.querySelector("#ofr-fake-win")?.remove(); let p = document.querySelector("player-panel"); if (!p) { p = document.createElement("player-panel"); document.body.appendChild(p); } p.id = "ofr-fake-panel"; p.g = { inSpawnPhase: () => false, myPlayer: () => ({ isAlive: () => true }) }; return "playing"; })()`);
await wait(3000);
await wait(1300);
await A.say("psst, attack red together?");
await wait(2500);
const paused = await B.state();
console.log("6. B alive in a running game:", JSON.stringify({ mode: paused.mode, tab: paused.tab, rows: paused.rows }), "| input hidden:", paused.inputHidden, "| page can see into the panel:", await B.page(`!!document.querySelector(".ofr-chat-host")?.shadowRoot || !!document.querySelector(".ofr-chat-log")`));
await B.shot("chat-b-paused");
await B.page(`document.querySelector("#ofr-fake-panel").g = { inSpawnPhase: () => false, myPlayer: () => ({ isAlive: () => false }) }; "eliminated"`);
await wait(3000);
console.log("   B eliminated -> open again:", (await B.state()).mode);

// streamer mode: the name must not go out
await B.iso(`globalThis.__ofrChatDebug.unmuteAll(); "unmuted"`);
await A.iso(`chrome.storage.sync.set({ streamerMode: true })`);
await wait(1500);
await A.say("who am I?");
await wait(2500);
console.log("7. A in streamer mode, B sees:", JSON.stringify((await B.state()).rows.slice(-1)));
await A.iso(`chrome.storage.sync.set({ streamerMode: false })`);

// leaving the game tears it down
await A.page(`document.querySelector("#ofr-fake-win")?.remove(); history.pushState({}, "", "/"); document.body.appendChild(document.createComment("nudge")); "left"`);
await wait(2500);
console.log("8. A left the game, panel gone:", (await A.state()) === null);
await wait(1500);
console.log("   B's presence after A's bye:", (await B.state()).status);

for (const X of [A, B]) {
  await X.page(`document.querySelector("#ofr-fake-win")?.remove(); (() => { const p = document.querySelector("#ofr-fake-panel"); if (p) { delete p.g; p.removeAttribute("id"); } })(); history.pushState({}, "", "/"); localStorage.setItem("username", "TeNa"); "cleaned"`);
  await X.iso(`chrome.storage.sync.set({ chatEnabled: false, showRecap: true })`);
  X.close();
}
