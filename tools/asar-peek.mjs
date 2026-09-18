// Dev tool. READ-ONLY look inside an Electron app.asar: lists files, prints one.
// Used to learn how the Steam build of the game starts (what its window loads,
// its preload, its CSP) so the companion launcher can attach from outside. It
// never writes to the game's folder.
//   node tools/asar-peek.mjs <app.asar>                 list
//   node tools/asar-peek.mjs <app.asar> <path/in/asar>  print that file
import fs from "node:fs";

const [file, want] = process.argv.slice(2);
const fd = fs.openSync(file, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const json = Buffer.alloc(jsonLen);
fs.readSync(fd, json, 0, jsonLen, 16);
const index = JSON.parse(json.toString("utf8"));
const base = 8 + headerSize;

const files = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p);
    else files.push({ path: p, size: entry.size, offset: entry.offset, unpacked: entry.unpacked === true });
  }
})(index, "");

if (!want) {
  const top = files.filter((f) => !f.path.startsWith("node_modules/"));
  for (const f of top.slice(0, 400)) console.log(String(f.size).padStart(10), f.path);
  console.log(`${files.length} files, ${top.length} outside node_modules`);
} else {
  const f = files.find((x) => x.path === want);
  if (!f) {
    console.error("not in archive:", want);
    process.exit(1);
  }
  if (f.unpacked) {
    console.error("stored unpacked next to the archive");
    process.exit(1);
  }
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, base + Number(f.offset));
  process.stdout.write(buf);
}
fs.closeSync(fd);
