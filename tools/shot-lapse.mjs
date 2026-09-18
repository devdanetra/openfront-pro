// Dev tool. Feeds made-up frames through the real timelapse code (src/timelapse.js)
// in a blank tab of a debug Chrome - no game, no site - and saves what comes out:
// the GIF, the WebM and a PNG of the recap's preview canvas. For checking the
// strip under the map (long names, narrow and wide pictures) and the file sizes.
//   CDP_PORT=9345 node tools/shot-lapse.mjs <outDir> [frameWidth, default 480]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.CDP_PORT ?? 9345);
const OUT = process.argv[2] ?? path.join(ROOT, ".shots");
const FW = Number(process.argv[3] ?? 480);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const made = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(made.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
const page = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return res.result?.exceptionDetails ? `threw: ${res.result.exceptionDetails.exception?.description}` : res.result?.result?.value;
};

await page(fs.readFileSync(path.join(ROOT, "src/timelapse.js"), "utf8"));
const FRAMES = 60;
const feed = `(async () => {
  const W = ${FW}, H = Math.round(${FW} * 0.56);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  const empires = [
    { name: "[UN] TheLongestNameYouEverSawInAGame", rgb: [200, 60, 60], cx: 0.3, cy: 0.4, me: false },
    { name: "firedan", rgb: [60, 120, 220], cx: 0.62, cy: 0.55, me: true },
    { name: "[ITA] Garibaldi the Second", rgb: [240, 190, 40], cx: 0.8, cy: 0.3, me: false },
  ];
  for (let n = 0; n < ${FRAMES}; n++) {
    x.fillStyle = "rgb(71,133,181)"; x.fillRect(0, 0, W, H);
    x.fillStyle = "rgb(190,220,138)"; x.beginPath(); x.ellipse(W / 2, H / 2, W * 0.44, H * 0.4, 0, 0, 7); x.fill();
    empires.forEach((e, i) => { x.fillStyle = "rgb(" + e.rgb.join(",") + ")"; x.beginPath(); x.arc(W * e.cx, H * e.cy, 4 + n * (1.2 + i * 0.5), 0, 7); x.fill(); });
    const blob = await new Promise((r) => c.toBlob(r, "image/webp", 1));
    const total = empires.reduce((a, e, i) => a + (4 + n * (1.2 + i * 0.5)) ** 2, 0);
    const top = empires.map((e, i) => ({ name: e.name, share: 0.6 * (4 + n * (1.2 + i * 0.5)) ** 2 / Math.max(total, 1), rgb: e.rgb, me: e.me })).sort((a, b) => b.share - a.share);
    window.postMessage({ __ofr: "lapse-frame", gameId: "TESTGAME", tick: 300 + n * 30, w: W, h: H, blob, stats: { seconds: 30 + n * 3, aliveHumans: 39 - Math.floor(n / 3), myShare: top.find((t) => t.me).share, top, map: "World" } }, "*");
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 200));
  return { frames: OFR_LAPSE.count(), blobBytes: null };
})()`;
console.log("fed:", JSON.stringify(await page(feed)));

const toB64 = `(blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(blob); })`;
const gif = await page(`OFR_LAPSE.toGif({}).then(${toB64})`);
if (typeof gif === "string" && !gif.startsWith("threw")) {
  fs.writeFileSync(path.join(OUT, `lapse-${FW}.gif`), Buffer.from(gif, "base64"));
  console.log(`lapse-${FW}.gif`, fs.statSync(path.join(OUT, `lapse-${FW}.gif`)).size, "bytes for", FRAMES, "frames");
} else console.log("gif failed:", String(gif).slice(0, 300));

// the preview canvas as the recap shows it (2x on narrow frames), mid-game frame
const png = await page(`(async () => { const p = OFR_LAPSE.player({}); document.body.append(p.canvas); await new Promise((r) => setTimeout(r, 2500)); p.stop(); return p.canvas.toDataURL("image/png").split(",")[1]; })()`);
if (typeof png === "string" && !png.startsWith("threw")) {
  fs.writeFileSync(path.join(OUT, `lapse-${FW}-preview.png`), Buffer.from(png, "base64"));
  console.log(`lapse-${FW}-preview.png`);
} else console.log("preview failed:", String(png).slice(0, 300));
const streamer = await page(`(async () => { const p = OFR_LAPSE.player({ streamer: true }); document.body.append(p.canvas); await new Promise((r) => setTimeout(r, 1500)); p.stop(); return p.canvas.toDataURL("image/png").split(",")[1]; })()`);
if (typeof streamer === "string" && !streamer.startsWith("threw")) fs.writeFileSync(path.join(OUT, `lapse-${FW}-streamer.png`), Buffer.from(streamer, "base64"));

await fetch(`http://127.0.0.1:${PORT}/json/close/${made.id}`);
ws.close();
