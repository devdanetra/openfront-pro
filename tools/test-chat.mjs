// Chat tests, in node.
//   node tools/test-chat.mjs          unit tests only (no network)
//   node tools/test-chat.mjs --live   ...plus two clients talking through the
//                                     real public relays in a throw-away room
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await import(pathToFileURL(path.join(ROOT, "src/vendor/nostr-crypto.js")).href);
await import(pathToFileURL(path.join(ROOT, "src/nostr.js")).href);
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
globalThis.document = {};
await import(pathToFileURL(path.join(ROOT, "src/chat.js")).href);
const N = globalThis.OFR_NOSTR;
const CHAT = globalThis.OFR_CHAT;
const C = globalThis.OFR_NOSTR_CRYPTO;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};
const cp = (...codes) => String.fromCodePoint(...codes);

console.log("crypto (BIP-340 test vector 0)");
{
  const sk = "0".repeat(63) + "3";
  const zero = "0".repeat(64);
  check("public key", C.bytesToHex(C.schnorr.getPublicKey(sk)) === "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9");
  const sig = C.bytesToHex(C.schnorr.sign(zero, sk, C.hexToBytes(zero)));
  check("signature", sig.toUpperCase() === "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0");
}

console.log("events");
{
  const sk = N.newSecretKey();
  const room = N.roomOf("5S99ULQP");
  check("room is lowercase, fixed length, and differs per game", /^ofpro[0-9a-f]{24}$/.test(room) && room !== N.roomOf("5s99ulqp"));
  const ev = N.makeEvent(sk, { room, type: "msg", text: "hello", name: "TeNa" });
  check("kind is in the ephemeral range", ev.kind >= 20000 && ev.kind < 30000);
  const read = N.readEvent(ev, room);
  check("round trip", read?.text === "hello" && read.name === "TeNa" && read.pubkey === N.publicKeyOf(sk) && read.type === "msg");
  check("wrong room is refused", N.readEvent(ev, N.roomOf("other")) === null);
  check("edited text is refused", N.readEvent({ ...ev, content: "hello!" }, room) === null);
  check("edited text with a recomputed id is refused (signature)", (() => { const t = { ...ev, content: "hello!" }; t.id = N.eventId(t); return N.readEvent(t, room) === null; })());
  check("someone else's key on my signature is refused", N.readEvent({ ...ev, pubkey: N.publicKeyOf(N.newSecretKey()) }, room) === null);
  const swapName = { ...ev, tags: ev.tags.map((t) => (t[0] === "name" ? ["name", "Admin"] : t)) };
  check("a relay cannot rename the sender", N.readEvent(swapName, room) === null);
  const old = { ...ev, created_at: ev.created_at - 3600 };
  old.id = N.eventId(old);
  old.sig = C.bytesToHex(C.schnorr.sign(old.id, sk));
  check("a validly signed but hour-old event is refused (replay)", N.readEvent(old, room) === null);
  check("other kinds are refused", N.readEvent({ ...ev, kind: 1 }, room) === null);
  check("unknown message types are refused", (() => { const t = { ...ev, tags: ev.tags.map((x) => (x[0] === "x" ? ["x", "admin"] : x)) }; t.id = N.eventId(t); t.sig = C.bytesToHex(C.schnorr.sign(t.id, sk)); return N.readEvent(t, room) === null; })());
  for (const junk of [null, 1, "x", [], {}, { kind: N.KIND }, { ...ev, tags: "nope" }, { ...ev, sig: "zz" }, { ...ev, created_at: "now" }, { ...ev, content: "a".repeat(5000) }]) {
    check(`junk is refused without throwing: ${JSON.stringify(junk)?.slice(0, 40)}`, N.readEvent(junk, room) === null);
  }
  const long = N.makeEvent(sk, { room, type: "msg", text: "x".repeat(1000), name: "n".repeat(200) });
  check("outgoing text and name are capped", long.content.length === N.MAX_TEXT && long.tags.find((t) => t[0] === "name")[1].length === N.MAX_NAME);
}

console.log("text hygiene");
{
  check("control characters and newlines become spaces", CHAT.clean(`a${cp(7)}b${cp(10)}c`, 50) === "a b c");
  check("bidi overrides and zero-width characters are dropped", CHAT.clean(`ad${cp(0x202e)}nim${cp(0x200b)}${cp(0x2066)}x`, 50) === "adnimx");
  check("stacked combining marks are capped", [...CHAT.clean(`z${cp(0x301).repeat(40)}algo`, 80)].length <= 8);
  check("ordinary accents and emoji survive", CHAT.clean(`caff${cp(0xe8)} ${cp(0x1f600)} ${cp(0x4f60, 0x597d)}`, 50) === `caff${cp(0xe8)} ${cp(0x1f600)} ${cp(0x4f60, 0x597d)}`);
  check("length is capped", CHAT.clean("x".repeat(999), 280).length === 280);
  const masked = CHAT.mask("you fucking idiot, KYS now, kill   yourself");
  check("slurs and the like are masked", !/fuck|kys|kill\s+yourself/i.test(masked), masked);
  check("innocent words containing them are not", CHAT.mask("class assassin Scunthorpe cockpit") === "class assassin Scunthorpe cockpit");
}

if (process.argv.includes("--live")) {
  console.log("live: two clients, real public relays, throw-away room");
  const bg = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
  const relays = [...bg.slice(bg.indexOf("const CHAT_RELAYS"), bg.indexOf("];", bg.indexOf("const CHAT_RELAYS"))).matchAll(/"(wss:[^"]+)"/g)].map((m) => m[1]);
  const room = N.roomOf(`test-${Math.random().toString(36).slice(2)}`);
  const got = { a: [], b: [] };
  const open = { a: 0, b: 0 };
  const a = new N.Room({ relays, room, secretKey: N.newSecretKey(), onMessage: (m) => got.a.push(m), onStatus: (s) => (open.a = s.open.length) });
  const b = new N.Room({ relays, room, secretKey: N.newSecretKey(), onMessage: (m) => got.b.push(m), onStatus: (s) => (open.b = s.open.length) });
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`  relays open: a ${open.a}/${relays.length}, b ${open.b}/${relays.length}`);
  const t0 = Date.now();
  a.publish("msg", "ping from a", "Alice");
  b.publish("here", "", "Bob");
  await new Promise((r) => setTimeout(r, 3000));
  check("at least two relays reachable", open.a >= 2 && open.b >= 2);
  check("b received a's message exactly once (deduplicated across relays)", got.b.filter((m) => m.text === "ping from a").length === 1, `${got.b.length} events in ${Date.now() - t0} ms`);
  check("a received b's presence exactly once", got.a.filter((m) => m.type === "here" && m.name === "Bob").length === 1);
  check("nobody hears their own echo", !got.a.some((m) => m.text === "ping from a"));
  a.close();
  b.close();
  await new Promise((r) => setTimeout(r, 500));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
