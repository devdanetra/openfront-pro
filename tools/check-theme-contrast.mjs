// Contrast and distinctness check for every theme's token block in src/content.css.
//
//   node tools/check-theme-contrast.mjs            (all themes)
//   node tools/check-theme-contrast.mjs midnight   (some themes)
//
// For each theme (classic = :root alone, the others = :root + their block) it
// resolves var() and color-mix(in srgb, ...) and checks, at WCAG 4.5:1 (all our
// text is under 18 px):
//   - the text tokens (text, text-dim, summary-text, accent-ink) and the band
//     colours used as text (elite, strong, good, average, low, loss) on
//     --ofr-panel-bg, --ofr-panel-soft and --ofr-stage-bg (translucent panels
//     composited over the stage);
//   - each band on its own badge fill (--ofr-badge-bg, currentColor = the band);
//   - --ofr-on-band on each filled band (threat badge) and --ofr-on-accent on the accent.
// And that the five bands plus the loss colour are told apart: the smallest
// OKLab distance between any two of them (win is --ofr-good by design).
// Exit code 1 if a theme named on the command line (or any theme, without
// arguments) fails.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(ROOT, "src/content.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selectorRe) {
  const m = selectorRe.exec(css);
  if (!m) return null;
  const start = css.indexOf("{", m.index) + 1;
  let depth = 1, i = start;
  while (depth && i < css.length) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
  const body = css.slice(start, i - 1);
  const tokens = {};
  for (const d of body.matchAll(/(--ofr-[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[d[1]] = d[2].trim();
  return tokens;
}
const root = block(/^:root\s*\{/m);
const ids = [...css.matchAll(/html\[data-ofr-theme="([a-z0-9-]+)"\]\s*\{/g)].map((m) => m[1]);
const THEMES = { classic: { ...root } };
for (const id of ids) THEMES[id] = { ...root, ...block(new RegExp(`html\\[data-ofr-theme="${id}"\\]\\s*\\{`)) };

// ---- colour parsing -----------------------------------------------------------
function splitTop(s) { // split on top-level commas
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function resolveVars(v, tok, current, seen = new Set()) {
  let guard = 0;
  while (/var\(/.test(v) && guard++ < 50) {
    v = v.replace(/var\((--[a-z0-9-]+)(?:\s*,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_, name, fb) => {
      if (seen.has(name)) throw new Error("cycle " + name);
      return tok[name] ?? fb ?? "transparent";
    });
  }
  return v.replace(/currentColor/gi, current ?? "transparent");
}
function parse(v, tok, current) {
  v = resolveVars(v.trim(), tok, current);
  if (v === "transparent") return [0, 0, 0, 0];
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/i.exec(v))) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  if ((m = /^rgba?\((.*)\)$/i.exec(v))) {
    const p = m[1].replace("/", " ").split(/[\s,]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  if ((m = /^color-mix\(in srgb,(.*)\)$/i.exec(v))) {
    const [a, b] = splitTop(m[1]);
    const pa = /\s(\d+(?:\.\d+)?)%$/.exec(a), pb = /\s(\d+(?:\.\d+)?)%$/.exec(b);
    const ca = parse(pa ? a.slice(0, pa.index) : a, tok, current);
    const cb = parse(pb ? b.slice(0, pb.index) : b, tok, current);
    let wa = pa ? +pa[1] / 100 : pb ? 1 - +pb[1] / 100 : 0.5;
    const wb = 1 - wa;
    // premultiplied interpolation, as CSS does
    const alpha = ca[3] * wa + cb[3] * wb;
    if (!alpha) return [0, 0, 0, 0];
    const ch = (i) => (ca[i] * ca[3] * wa + cb[i] * cb[3] * wb) / alpha;
    return [ch(0), ch(1), ch(2), alpha];
  }
  throw new Error("cannot parse colour: " + v);
}
const over = (fg, bg) => { // composite fg over an opaque bg
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1);
};
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function oklab(c) {
  const [r, g, b] = [lin(c[0]), lin(c[1]), lin(c[2])];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const dE = (a, b) => { const p = oklab(a), q = oklab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

// ---- checks ---------------------------------------------------------------------
const MIN = 4.5;
const MIN_DE = 0.08; // OKLab distance; about where two small badges stop being confusable
const BANDS = ["elite", "strong", "good", "average", "low"];
const TEXT = ["text", "text-dim", "summary-text", "accent-ink", ...BANDS, "loss"];
const want = process.argv.slice(2);
let failed = false;

for (const [id, tok] of Object.entries(THEMES)) {
  if (want.length && !want.includes(id)) continue;
  const col = (name, current) => parse(tok[`--ofr-${name}`], tok, current);
  const stage = over(col("stage-bg"), [0, 0, 0, 1]);
  const panel = over(col("panel-bg"), stage);
  const soft = over(col("panel-soft"), panel);
  const float = over(col("float-bg"), stage);
  const bgs = { panel, soft, stage, float };
  const fails = [];
  let worst = Infinity;
  const rows = [];
  for (const t of TEXT) {
    const fg = col(t);
    const cells = Object.entries(bgs).map(([bn, bg]) => {
      const r = ratio(over(fg, bg), bg);
      worst = Math.min(worst, r);
      if (r < MIN) fails.push(`${t} on ${bn} ${r.toFixed(2)}`);
      return `${bn} ${r.toFixed(2)}`;
    });
    rows.push(`    ${t.padEnd(13)} ${cells.join("  ")}`);
  }
  for (const b of BANDS) {
    const fg = col(b);
    const hex = tok[`--ofr-${b}`];
    const fill = over(col("badge-bg", hex), stage);
    const r = ratio(over(fg, fill), fill);
    if (r < MIN) fails.push(`${b} badge on its fill ${r.toFixed(2)}`);
    const onBand = ratio(col("on-band"), over(fg, stage));
    if (onBand < MIN) fails.push(`on-band on filled ${b} ${onBand.toFixed(2)}`);
    rows.push(`    ${(b + " badge").padEnd(13)} on fill ${r.toFixed(2)}  on-band on it ${onBand.toFixed(2)}`);
  }
  const acc = over(col("accent"), stage);
  const onAcc = ratio(col("on-accent"), acc);
  if (onAcc < MIN) fails.push(`on-accent on accent ${onAcc.toFixed(2)}`);

  // bands against each other, then the loss colour against every band (the win
  // colour IS --ofr-good, so it needs no separate check)
  const mark = Object.fromEntries([...BANDS, "loss"].map((n) => [n, over(col(n), panel)]));
  let closest = [Infinity, ""];
  for (let i = 0; i < BANDS.length; i++) for (let j = i + 1; j < BANDS.length; j++) {
    const d = dE(mark[BANDS[i]], mark[BANDS[j]]);
    if (d < closest[0]) closest = [d, `${BANDS[i]}/${BANDS[j]}`];
  }
  let lossClosest = [Infinity, ""];
  for (const b of BANDS) {
    const d = dE(mark.loss, mark[b]);
    if (d < lossClosest[0]) lossClosest = [d, `loss/${b}`];
  }
  if (closest[0] < MIN_DE) fails.push(`bands too alike: ${closest[1]} dE ${closest[0].toFixed(3)}`);
  if (lossClosest[0] < MIN_DE) fails.push(`loss too close to a band: ${lossClosest[1]} dE ${lossClosest[0].toFixed(3)}`);

  const ok = !fails.length;
  if (!ok && (!want.length || want.includes(id))) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${id.padEnd(9)} worst text ${worst.toFixed(2)}:1  on-accent ${onAcc.toFixed(2)}  closest bands ${closest[1]} dE ${closest[0].toFixed(3)}  ${lossClosest[1]} dE ${lossClosest[0].toFixed(3)}`);
  if (process.env.VERBOSE) console.log(rows.join("\n"));
  for (const f of fails) console.log("    - " + f);
}
process.exit(failed ? 1 : 0);
