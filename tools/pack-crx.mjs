// Wraps the extension zip (tools/pack.mjs) into a signed CRX3 package.
//
//   node tools/pack-crx.mjs            -> openfront-pro-<version>.crx
//
// The signing key is created on first use at .keys/crx-private.pem. KEEP IT AND
// NEVER COMMIT IT (.keys/ is git-ignored): the key is what gives the package its
// extension id, and whoever holds it can publish "updates" under that id.
//
// Know what a .crx is good for: Chrome on Windows and macOS refuses to install a
// .crx that does not come from the Chrome Web Store (it is disabled on restart).
// It works on Linux, in Chromium builds, and through enterprise policy. For
// everyone else the .zip + "Load unpacked" is the way, until the store listing.
//
// CRX3: "Cr24" | u32 3 | u32 header length | CrxFileHeader (protobuf) | zip
//   CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
//                   bytes signed_header_data = 10000; }   // SignedData { bytes crx_id = 1 }
//   signature = RSA-SHA256( "CRX3 SignedData\0" | u32le(len(signed_header_data)) | signed_header_data | zip )
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const zipFile = path.join(ROOT, `openfront-pro-${version}.zip`);
if (!fs.existsSync(zipFile)) {
  console.error(`${path.basename(zipFile)} not found - run: node tools/pack.mjs`);
  process.exit(1);
}
const keyDir = path.join(ROOT, ".keys");
const keyFile = path.join(keyDir, "crx-private.pem");
if (!fs.existsSync(keyFile)) {
  fs.mkdirSync(keyDir, { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log("created a new signing key:", path.relative(ROOT, keyFile), "(back it up; never commit it)");
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });

const varint = (n) => {
  const out = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
};
const field = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]); // wire type 2: length-delimited

const MAGIC = Buffer.concat([Buffer.from("CRX3 SignedData"), Buffer.from([0])]); // NUL-terminated
const zip = fs.readFileSync(zipFile);
const crxId = crypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);
const signedData = field(1, crxId);
const len = Buffer.alloc(4);
len.writeUInt32LE(signedData.length);
const signature = crypto.sign("sha256", Buffer.concat([MAGIC, len, signedData, zip]), privateKey);
const header = Buffer.concat([field(2, Buffer.concat([field(1, publicKey), field(2, signature)])), field(10000, signedData)]);

const pre = Buffer.alloc(12);
pre.write("Cr24", 0, "latin1");
pre.writeUInt32LE(3, 4);
pre.writeUInt32LE(header.length, 8);
const out = path.join(ROOT, `openfront-pro-${version}.crx`);
fs.writeFileSync(out, Buffer.concat([pre, header, zip]));

// the id Chrome shows: the first 16 bytes of the key hash, written in a-p
const id = [...crxId].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
// self-check: what we wrote verifies
const ok = crypto.verify("sha256", Buffer.concat([MAGIC, len, signedData, zip]), crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" }), signature);
console.log(`${path.basename(out)}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB  id ${id}  signature ${ok ? "verifies" : "DOES NOT VERIFY"}`);
if (!ok) process.exit(1);
