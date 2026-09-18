// The timelapse GIF export has its own LZW encoder (src/timelapse.js). This
// decodes what it produces with an independent, textbook GIF-LZW decoder and
// compares pixel for pixel - flat areas, noise, and inputs long enough to fill
// the 4096-entry dictionary and force a reset.
//   node tools/test-gif.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = { addEventListener() {} };
globalThis.document = { documentElement: { dataset: {} } };
await import(pathToFileURL(path.join(ROOT, "src/timelapse.js")).href);
const lzw = globalThis.OFR_LAPSE._lzw;

function decode(stream) {
  const min = stream[0];
  // join the sub-blocks
  const data = [];
  let p = 1;
  while (stream[p] !== 0) {
    const n = stream[p++];
    for (let i = 0; i < n; i++) data.push(stream[p++]);
  }
  const CLEAR = 1 << min;
  const END = CLEAR + 1;
  let width = min + 1;
  let dict = [];
  const resetDict = () => {
    dict = [];
    for (let i = 0; i < CLEAR; i++) dict[i] = [i];
    dict[CLEAR] = [];
    dict[END] = [];
    width = min + 1;
  };
  resetDict();
  const out = [];
  let bitPos = 0;
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) throw new Error(`the stream ends inside a code (bit ${bitPos}, width ${width})`); // strict: no END made up
      v |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return v;
  };
  let prev = null;
  for (;;) {
    const code = read();
    if (code === END) {
      decode.endWidth = width; // for the width-boundary test
      break;
    }
    if (code === CLEAR) {
      resetDict();
      prev = null;
      continue;
    }
    let entry;
    if (code < dict.length) entry = dict[code];
    else if (code === dict.length && prev) entry = [...prev, prev[0]];
    else throw new Error(`bad code ${code} (dict ${dict.length}, width ${width})`);
    out.push(...entry);
    if (prev && dict.length < 4096) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << width && width < 12) width++;
    }
    prev = entry;
  }
  return out;
}

let failures = 0;
const check = (name, pixels) => {
  const arr = Uint8Array.from(pixels);
  let ok = false;
  let detail = "";
  try {
    const back = decode(lzw(arr));
    ok = back.length === arr.length && back.every((v, i) => v === arr[i]);
    if (!ok) detail = `length ${back.length} vs ${arr.length}`;
  } catch (err) {
    detail = err.message;
  }
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}  (${arr.length} px -> ${lzw(arr).length} bytes) ${detail}`);
};

let seed = 12345;
const rnd = (n) => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) % n;
check("one pixel", [7]);
check("flat colour", new Array(50000).fill(3));
check("two colours, stripes", Array.from({ length: 40000 }, (_, i) => (Math.floor(i / 37) % 2 ? 200 : 12)));
check("noise, 256 colours (fills the dictionary, forces resets)", Array.from({ length: 300000 }, () => rnd(256)));
check("noise, 4 colours", Array.from({ length: 200000 }, () => rnd(4)));
{
  // The code width grows when the table reaches 512 / 1024 / 2048 entries. When the
  // data ends right there, END must be written at the width a decoder reads it with
  // (a mismatch is invisible unless the stream also ends on a byte boundary, so the
  // widths are compared directly). About 1 input in 600 hits the case.
  let tried = 0;
  const bad = [];
  for (let n = 200; n < 3000; n++) {
    for (let v = 0; v < 3; v++) {
      seed = n * 7 + v;
      const arr = Uint8Array.from({ length: n }, () => rnd(256));
      const info = {};
      const stream = lzw(arr, info);
      tried++;
      try {
        const back = decode(stream);
        if (decode.endWidth !== info.endWidth || back.length !== n || back.some((x, i) => x !== arr[i])) bad.push(n);
      } catch {
        bad.push(n);
      }
    }
  }
  if (bad.length) failures++;
  console.log(`  ${bad.length ? "FAIL" : "ok  "} END written at the width the decoder reads it (${tried} noise inputs, strict decoder)${bad.length ? `  -> ${bad.length} wrong, e.g. ${bad.slice(0, 5).join(", ")} px` : ""}`);
}
check("map-like: big regions with noisy borders", Array.from({ length: 480 * 270 }, (_, i) => (rnd(20) === 0 ? rnd(30) : Math.floor(i / 9000) % 12)));

// ---- whole files: delta frames (changed box only, unchanged pixels transparent) ---------------
// A minimal GIF89a reader: walks the blocks, composites every frame onto a canvas
// of indexes the way a viewer would (disposal 1), and hands back each full picture.
function readGif(bytes) {
  const u16 = (p) => bytes[p] | (bytes[p + 1] << 8);
  const header = String.fromCharCode(...bytes.slice(0, 6));
  const W = u16(6);
  const H = u16(8);
  let p = 13 + 768; // header + logical screen + 256-colour table
  const canvas = new Uint8Array(W * H);
  const pictures = [];
  const delays = [];
  let transparent = -1;
  let loops = false;
  for (;;) {
    const block = bytes[p++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) {
        const packed = bytes[p + 1];
        delays.push(u16(p + 2));
        transparent = packed & 1 ? bytes[p + 4] : -1;
        if (((packed >> 2) & 7) !== 1) throw new Error("disposal is not 1");
      } else if (label === 0xff) loops = true;
      while (bytes[p] !== 0) p += bytes[p] + 1;
      p++;
    } else if (block === 0x2c) {
      const x0 = u16(p);
      const y0 = u16(p + 2);
      const w = u16(p + 4);
      const h = u16(p + 6);
      if (bytes[p + 8] !== 0) throw new Error("unexpected local flags");
      p += 9;
      const start = p;
      p++; // min code size
      while (bytes[p] !== 0) p += bytes[p] + 1;
      p++;
      const px = decode(bytes.subarray(start, p));
      if (px.length !== w * h) throw new Error(`frame has ${px.length} px, box is ${w}x${h}`);
      if (x0 + w > W || y0 + h > H) throw new Error("frame box leaves the screen");
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[y * w + x] !== transparent) canvas[(y0 + y) * W + x0 + x] = px[y * w + x];
      pictures.push(canvas.slice());
    } else throw new Error(`unknown block 0x${block.toString(16)} at ${p - 1}`);
  }
  return { header, W, H, pictures, delays, loops };
}

{
  const W = 300;
  const H = 200;
  const palette = Array.from({ length: 256 }, (_, i) => [i, (i * 7) % 256, (i * 13) % 256]);
  // an "empire" growing from the middle, a HUD line changing every frame, one frame identical to the last
  const source = [];
  for (let n = 0; n < 9; n++) {
    // a map of a dozen textured regions that never change...
    const f = Uint8Array.from({ length: W * H }, (_, i) => ((Math.floor((i % W) / 50) + Math.floor(i / W / 50) * 7) % 12) * 2 + ((i * 7) % 5 === 0 ? 1 : 0));
    const r = n === 5 ? 4 * 3 : n * 3; // ...one empire growing in a corner; frame 5 repeats frame 4
    for (let y = 0; y < H - 8; y++) for (let x = 0; x < W; x++) if ((x - 80) ** 2 + (y - 70) ** 2 < r * r) f[y * W + x] = 40 + ((x * 31 + y * 17) % 9 === 0 ? 1 : 0); // textured, but the same texture every frame
    for (let x = 0; x < 30; x++) f[(H - 4) * W + x] = n === 5 ? 104 : 100 + n;
    source.push(f);
  }
  const writer = globalThis.OFR_LAPSE._gifWriter(W, H, palette);
  source.forEach((f, n) => writer.add(f, n === source.length - 1 ? 150 : 8));
  const parts = writer.finish();
  const file = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  parts.reduce((at, part) => (file.set(part, at), at + part.length), 0);
  let fullSize = 0;
  {
    // the same frames without deltas, for the size comparison: a fresh writer per frame has no "previous"
    for (const f of source) {
      const one = globalThis.OFR_LAPSE._gifWriter(W, H, palette);
      one.add(f, 8);
      fullSize += one.finish().reduce((a, b) => a + b.length, 0) - 13 - 768 - 19 - 1;
    }
  }
  let ok = false;
  let detail = "";
  try {
    const gif = readGif(file);
    const same = gif.pictures.length === source.length && gif.pictures.every((pic, n) => pic.every((v, i) => v === source[n][i]));
    ok = gif.header === "GIF89a" && gif.W === W && gif.H === H && gif.loops && same && gif.delays[8] === 150 && gif.delays[0] === 8;
    if (!ok) detail = `frames ${gif.pictures.length}, same ${same}, delays ${gif.delays.join(",")}`;
  } catch (err) {
    detail = err.message;
  }
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} whole file: 9 delta frames decode to the 9 source pictures (${file.length} bytes; ${fullSize} as full frames) ${detail}`);
  const smaller = file.length < fullSize * 0.4;
  if (!smaller) failures++;
  console.log(`  ${smaller ? "ok  " : "FAIL"} delta frames are clearly smaller than full frames`);
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
