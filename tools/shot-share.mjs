// Dev tool. Renders the recap's share image (drawCard) for saved game records in
// .recap/, offline: the record normaliser and analyse() run in node like
// tools/test-recap.mjs, the card is drawn in a blank headless Chrome tab with
// content.css loaded for the theme tokens. Percentiles are made up (a hash).
//   node tools/shot-share.mjs <outDir> [theme, default classic]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? path.join(ROOT, ".shots", "share");
const THEME = process.argv[3] ?? "classic";
const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9402;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// records -> normalised, the same way test-recap does
const sandbox = vm.createContext({ console, URL, Math, JSON, Date });
const bg = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const block = bg.slice(bg.indexOf("// <record-normaliser>"), bg.indexOf("// </record-normaliser>"));
vm.runInContext(block.replace(/async function fetchGameRecord[\s\S]*?\n}\n/, "") + "\nthis.normaliseRecord = normaliseRecord;", sandbox);
const files = fs.readdirSync(path.join(ROOT, ".recap")).filter((f) => /^game-.*\.json$/.test(f));
const records = files.map((f) => ({ id: f.slice(5, -5), record: sandbox.normaliseRecord(JSON.parse(fs.readFileSync(path.join(ROOT, ".recap", f), "utf8"))) })).filter((r) => r.record?.players?.length);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofr-sh-"));
const chrome = spawn(CHROME, [`--user-data-dir=${tmp}`, `--remote-debugging-port=${PORT}`, "--headless=new", "--disable-gpu", "--no-first-run", "about:blank"], { stdio: "ignore" });
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page");
  } catch {
    await wait(250);
  }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
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
const run = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "threw");
  return r.result?.result?.value;
};

const css = fs.readFileSync(path.join(ROOT, "src/content.css"), "utf8");
await run(`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(css)}; document.head.append(s); ${THEME === "classic" ? "" : `document.documentElement.dataset.ofrTheme = ${JSON.stringify(THEME)};`} return 1; })()`);
for (const f of ["src/scoring.js", "src/recap.js"]) await run(fs.readFileSync(path.join(ROOT, f), "utf8") + "\n1");

for (const { id: gameId, record } of records) {
  // "me": the winner if there is one, else the first player who spawned
  const me = record.players.find((p) => p.winner) ?? record.players.find((p) => p.active) ?? record.players[0];
  const png = await run(`(async () => {
    const pctOf = (name) => { let h = 7; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 1 + (h % 900) / 10; };
    const model = OFR_RECAP.analyse(${JSON.stringify(record)}, { me: ${JSON.stringify(me.username.toLowerCase())}, myClan: ${JSON.stringify(me.clanTag ?? null)}, pctOf });
    if (model.state !== "ok") return null;
    const canvas = OFR_RECAP.drawCard(model, { progress: ["World rank: Top 2.4% -> Top 2.3%", "Today: 3 games, 1 win, avg place #6"] });
    return { w: canvas.width, h: canvas.height, data: canvas.toDataURL("image/png").split(",")[1] };
  })()`);
  if (!png) continue;
  const file = path.join(OUT, `share-${gameId}-${THEME}.png`);
  fs.writeFileSync(file, Buffer.from(png.data, "base64"));
  console.log(path.basename(file), `${png.w}x${png.h}`);
}
ws.close();
chrome.kill();
await wait(800);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // Chrome may still hold its profile
}
process.exit(0);
