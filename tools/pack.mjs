// Builds the Chrome Web Store upload: manifest.json, src/ and icons/ only.
//
//   node tools/pack.mjs            -> openfront-pro-<version>.zip
//
// Written by hand rather than with PowerShell's Compress-Archive, which on
// Windows PowerShell 5.1 stores entries as "src\content.js". The zip format
// requires forward slashes, and the store can reject such a package.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // survives spaces in the path
const INCLUDE = ["manifest.json", "src", "icons", "sounds"];

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8").replace(/^﻿/, ""),
);
const out = path.join(ROOT, `openfront-pro-${manifest.version}.zip`);

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs).sort().flatMap((name) => walk(`${rel}/${name}`));
  }
  return [rel];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const files = INCLUDE.flatMap(walk);
const locals = [];
const centrals = [];
let offset = 0;

for (const name of files) {
  const data = fs.readFileSync(path.join(ROOT, name));
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name, "utf8"); // forward slashes, from walk()
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  locals.push(local, nameBuf, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + packed.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

fs.writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`${path.basename(out)}: ${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
for (const f of files) console.log("  " + f);
