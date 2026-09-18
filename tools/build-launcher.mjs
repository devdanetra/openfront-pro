// Builds the downloadable companion launcher for the Steam build (Windows x64):
//
//   dist/OpenFrontPro-Launcher-<version>.exe           one file, nothing to install.
//        Node's "single executable application": a copy of node.exe with the
//        launcher script and the extension's files embedded as assets.
//   dist/OpenFrontPro-Launcher-<version>-portable.zip  the same thing unpacked:
//        node.exe (still carrying the Node.js project's code signature), the
//        files, and a Start.cmd. For people whose antivirus dislikes unsigned exes.
//   dist/SHA256SUMS.txt
//
//   node tools/build-launcher.mjs
//
// The .exe is NOT code-signed (that needs a paid certificate), so Windows
// SmartScreen shows "unknown publisher" the first time. The build uses the
// node.exe that runs this script, plus postject / resedit (pure JS, pinned, from
// the .vendor-build sandbox: `npm i --ignore-scripts postject resedit pe-library`).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, ".vendor-build");
const DIST = path.join(ROOT, "dist");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const VERSION = manifest.version;
if (process.platform !== "win32") {
  console.error("This builds the Windows launcher; run it on Windows.");
  process.exit(1);
}
fs.mkdirSync(DIST, { recursive: true });
const require = createRequire(path.join(WORK, "package.json"));

// ---- what goes inside --------------------------------------------------------------------
function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (fs.statSync(abs).isFile()) return [rel.replaceAll("\\", "/")];
  return fs.readdirSync(abs).flatMap((name) => walk(path.join(rel, name)));
}
const files = ["manifest.json", ...walk("src"), ...walk("icons"), ...walk("sounds")];
const docs = ["LICENSE", "THIRD_PARTY_NOTICES.md", "PRIVACY.md", "launcher/README.md"];

// Node's own licence travels with anything that contains node.exe.
const nodeLicense = path.join(WORK, `NODE-LICENSE-${process.version}.txt`);
if (!fs.existsSync(nodeLicense)) {
  const res = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!res.ok) throw new Error(`could not fetch Node's LICENSE: HTTP ${res.status}`);
  fs.writeFileSync(nodeLicense, await res.text());
}

// ---- 1. single executable ---------------------------------------------------------------------
const indexFile = path.join(WORK, "sea-index.json");
fs.writeFileSync(indexFile, JSON.stringify(files));
const blob = path.join(WORK, "launcher.blob");
const seaConfig = path.join(WORK, "sea-config.json");
fs.writeFileSync(
  seaConfig,
  JSON.stringify({
    main: path.join(ROOT, "launcher/openfront-pro-launcher.cjs"),
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    assets: { "__index.json": indexFile, ...Object.fromEntries(files.map((f) => [f, path.join(ROOT, f)])) },
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

const exe = path.join(DIST, `OpenFrontPro-Launcher-${VERSION}.exe`);
// The blob first, into a pristine copy of node.exe...
fs.copyFileSync(process.execPath, exe);
{
  const { inject } = require("postject");
  await inject(exe, "NODE_SEA_BLOB", fs.readFileSync(blob), { sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2" });
}

// ...then the icon and version info. pe-library rewrites the resource section
// (the blob lives there too) and drops node.exe's signature, which the blob had
// already invalidated. Doing this AFTER the injection keeps postject working on
// an untouched PE layout.
{
  const PE = require("pe-library");
  const ResEdit = require("resedit");
  const pe = PE.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = PE.NtExecutableResource.from(pe);
  const ico = path.join(ROOT, "launcher", "icon.ico");
  if (fs.existsSync(ico)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map((i) => i.data));
  }
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const [maj, min, pat] = VERSION.split(".").map(Number);
    vi.setFileVersion(maj, min, pat, 0, 1033);
    vi.setProductVersion(maj, min, pat, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: "OpenFront Pro Launcher (unofficial)",
      FileDescription: "OpenFront Pro companion launcher for the Steam build (unofficial). Runs on Node.js.",
      CompanyName: "devdanetra (open source, MIT) - not affiliated with OpenFront or the Node.js project",
      LegalCopyright: "MIT. Contains Node.js (c) Node.js contributors.",
      OriginalFilename: path.basename(exe),
      InternalName: "openfront-pro-launcher",
    });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
}
// ---- 2. portable zip ------------------------------------------------------------------------------
function zip(entries, out) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x0021, 12); // DOS date 1980-01-01
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
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
}
const top = "OpenFrontPro-Launcher";
const START = `@echo off\r\nrem OpenFront Pro companion launcher (unofficial). Read README.md first.\r\ncd /d "%~dp0"\r\nruntime\\node.exe app\\launcher\\openfront-pro-launcher.cjs %*\r\npause\r\n`;
const portable = path.join(DIST, `OpenFrontPro-Launcher-${VERSION}-portable.zip`);
zip(
  [
    { name: `${top}/Start.cmd`, data: Buffer.from(START) },
    { name: `${top}/README.md`, data: fs.readFileSync(path.join(ROOT, "launcher/README.md")) },
    { name: `${top}/runtime/node.exe`, data: fs.readFileSync(process.execPath) },
    { name: `${top}/runtime/NODE-LICENSE.txt`, data: fs.readFileSync(nodeLicense) },
    { name: `${top}/app/launcher/openfront-pro-launcher.cjs`, data: fs.readFileSync(path.join(ROOT, "launcher/openfront-pro-launcher.cjs")) },
    ...files.map((f) => ({ name: `${top}/app/${f}`, data: fs.readFileSync(path.join(ROOT, f)) })),
    ...docs.filter((f) => f !== "launcher/README.md").map((f) => ({ name: `${top}/app/${f}`, data: fs.readFileSync(path.join(ROOT, f)) })),
  ],
  portable,
);
fs.copyFileSync(nodeLicense, path.join(DIST, "NODE-LICENSE.txt"));

// ---- 3. checksums -----------------------------------------------------------------------------------
const sums = [exe, portable]
  .map((f) => `${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}  ${path.basename(f)}`)
  .join("\n");
fs.writeFileSync(path.join(DIST, "SHA256SUMS.txt"), `${sums}\n`);
for (const f of [exe, portable]) console.log(path.relative(ROOT, f), `${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
console.log(sums);
