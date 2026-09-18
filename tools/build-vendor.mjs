// Rebuilds src/vendor/nostr-crypto.js: BIP-340 Schnorr (secp256k1) + SHA-256 from
// @noble/curves and @noble/hashes (MIT, audited, no dependencies), bundled (NOT minified, so it can be read and diffed) into
// one classic script that sets globalThis.OFR_NOSTR_CRYPTO. Nothing else is
// vendored, and nothing is fetched at run time.
//
//   node tools/build-vendor.mjs
//
// Pinned versions; esbuild-wasm because the native esbuild binary cannot be
// spawned from every sandbox. The result is checked against BIP-340's first test
// vector before it replaces the old file. `node tools/test-chat.mjs` re-checks it.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, ".vendor-build");
const OUT = path.join(ROOT, "src/vendor/nostr-crypto.js");

fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "package.json"), JSON.stringify({ name: "ofr-vendor-build", private: true, type: "module" }));
fs.writeFileSync(
  path.join(WORK, "entry.js"),
  `import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes } from "@noble/hashes/utils";
globalThis.OFR_NOSTR_CRYPTO = { schnorr, sha256, bytesToHex, hexToBytes, utf8ToBytes, randomBytes };
`,
);
execSync("npm install --no-audit --no-fund --ignore-scripts @noble/curves@1.9.7 @noble/hashes@1.8.0 esbuild-wasm@0.25.10", { cwd: WORK, stdio: "inherit" });
const tmp = path.join(WORK, "nostr-crypto.js");
execSync(`node node_modules/esbuild-wasm/bin/esbuild entry.js --bundle --format=iife --legal-comments=inline --target=chrome110 --outfile=${JSON.stringify(tmp)}`, { cwd: WORK, stdio: "inherit" });
fs.writeFileSync(tmp, `/* OpenFront Pro vendor bundle: @noble/curves 1.9.7 + @noble/hashes 1.8.0 (MIT, (c) Paul Miller). Bundled, NOT minified. Rebuild: node tools/build-vendor.mjs */
${fs.readFileSync(tmp, "utf8")}`);

delete globalThis.OFR_NOSTR_CRYPTO;
await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
const C = globalThis.OFR_NOSTR_CRYPTO;
const sk = "0".repeat(63) + "3";
const zero = "0".repeat(64);
const sig = C.bytesToHex(C.schnorr.sign(zero, sk, C.hexToBytes(zero))).toUpperCase();
if (sig !== "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0") {
  console.error("BIP-340 test vector 0 does not match; NOT installing the bundle");
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(tmp, OUT);
console.log("wrote", path.relative(ROOT, OUT), `${(fs.statSync(OUT).size / 1024).toFixed(1)} KB - BIP-340 vector ok`);
