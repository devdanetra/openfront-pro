// Team chat tests, in node: several copies of src/team.js talk through an
// in-memory "relay" that carries REAL signed events (src/nostr.js makes and checks
// them), next to a pretend game that says who is on which team and who sent which
// emoji to whom. Honest pairings, then the attacks from docs/TEAM-CHAT.md.
//   node tools/test-team.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["src/vendor/nostr-crypto.js", "src/nostr.js", "src/team.js"]) await import(pathToFileURL(path.join(ROOT, f)).href);
const N = globalThis.OFR_NOSTR;
const TEAM = globalThis.OFR_TEAM;
const C = globalThis.OFR_NOSTR_CRYPTO;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  -> ${detail}`}`);
};
const settle = () => new Promise((r) => setTimeout(r, 25)); // WebCrypto steps are async

// ---- a world: one relay room, one game ----------------------------------------------------------
function world(gameId = "TESTGAME") {
  const room = N.roomOf(gameId);
  const w = { room, clock: Date.now(), tick: 400, spawn: false, catchingUp: false, peers: [], wire: [], drop: null, emojiLog: [] };
  // players: sid -> { name, team }
  w.players = new Map();
  w.addPlayer = (sid, name, team) => w.players.set(sid, { name, team, alive: true });

  w.join = (label, sid, { saved = null, secretKey = N.newSecretKey() } = {}) => {
    const peer = { label, sid, secretKey, states: [], messages: [], savedState: saved };
    const publish = (type, body) => {
      const ev = N.makeEvent(secretKey, { room, type, body });
      w.wire.push({ from: label, type, body, ev });
      if (w.drop && w.drop({ from: label, type, body })) return 1;
      for (const other of w.peers) {
        if (other === peer || other.closed) continue;
        const read = N.readEvent(JSON.parse(JSON.stringify(ev)), room);
        if (read) other.team.onEvent(read);
      }
      return 1;
    };
    peer.team = TEAM.create({ room, secretKey, publish, now: () => w.clock, timers: false, saved, save: (s) => (peer.savedState = JSON.parse(JSON.stringify(s))), onState: (s) => peer.states.push(s), onMessage: (m) => peer.messages.push(m) });
    peer.key = peer.team.key;
    peer.state = () => peer.team.snapshot();
    w.peers.push(peer);
    return peer;
  };
  // an attacker speaks on the relay with any body it likes, under its own key
  w.attacker = () => {
    const secretKey = N.newSecretKey();
    const a = { key: N.publicKeyOf(secretKey), heard: [] };
    a.send = (type, body) => {
      const ev = N.makeEvent(secretKey, { room, type, body });
      for (const other of w.peers) {
        const read = N.readEvent(JSON.parse(JSON.stringify(ev)), room);
        if (read && !other.closed) other.team.onEvent(read);
      }
    };
    a.inbox = (type) => w.wire.filter((x) => x.type === type && x.body.to === a.key);
    return a;
  };
  // what each extension's page reports: its own team, seen from its own player
  w.feed = (fresh = []) => {
    for (const peer of w.peers) {
      if (peer.closed || peer.noGame) continue;
      const mine = w.players.get(peer.sid);
      const roster = [...w.players].filter(([, p]) => p.team === mine.team).map(([sid, p]) => ({ sid, name: p.name, alive: p.alive, me: sid === peer.sid }));
      const sids = new Set(roster.map((r) => r.sid));
      peer.team.feed({ gameId, tick: w.tick, spawn: w.spawn, catchingUp: w.catchingUp, roster, emojis: fresh.filter((e) => sids.has(e.sid) && sids.has(e.to)) });
    }
  };
  w.emoji = (from, to, emoji, tick = w.tick) => {
    w.tick = Math.max(w.tick, tick) + 1;
    w.feed([{ sid: from, to, emoji, tick }]);
  };
  w.sendRun = (from, to, emojis) => {
    for (const e of emojis) {
      w.tick += 55; // the game's cooldown
      w.emoji(from, to, e);
    }
  };
  w.advance = (ms) => {
    w.clock += ms;
    w.tick += Math.round(ms / 100);
    for (const p of w.peers) if (!p.closed) p.team.tick();
    w.feed();
  };
  w.hellos = () => {
    for (const p of w.peers) if (!p.closed) p.team.hello();
  };
  return w;
}
const keyStatus = (peer, otherKey) => peer.state().mates.flatMap((m) => m.keys).find((k) => k.key === otherKey)?.status ?? null;

async function pair(w, a, b) {
  a.team.verify(b.key);
  b.team.verify(a.key);
  const ea = a.state().pairing?.emojis;
  const eb = b.state().pairing?.emojis;
  if (!ea || !eb || ea.join() !== eb.join()) return false;
  w.sendRun(a.sid, b.sid, ea);
  w.sendRun(b.sid, a.sid, eb);
  w.feed();
  return true;
}

// ---- pure parts ---------------------------------------------------------------------------------------
console.log("emoji sequence");
{
  const base = { room: "r", pid: "00".repeat(8), keyI: "a".repeat(64), sidI: 3, keyR: "b".repeat(64), sidR: 4, c: "c".repeat(64), nI: "1".repeat(64), nR: "2".repeat(64) };
  const one = TEAM.sasOf(base);
  check("three indexes from the 56 polite emojis", one.length === 3 && one.every((i) => TEAM.ALPHABET.includes(i)) && ![14, 11, 21, 59].some((i) => TEAM.ALPHABET.includes(i)) && TEAM.ALPHABET.length === 56);
  check("same inputs, same emojis", TEAM.sasOf({ ...base }).join() === one.join());
  const differs = ["room", "pid", "keyI", "keyR", "c", "nI", "nR"].every((f) => TEAM.sasOf({ ...base, [f]: `${base[f]}x` }).join() !== one.join()) && TEAM.sasOf({ ...base, sidI: 5 }).join() !== one.join() && TEAM.sasOf({ ...base, sidR: 5 }).join() !== one.join();
  check("every input changes them (keys, players, numbers, room, pairing id)", differs);
  check("swapping the roles changes them", TEAM.sasOf({ ...base, keyI: base.keyR, keyR: base.keyI, sidI: base.sidR, sidR: base.sidI }).join() !== one.join());
  check("fields cannot run into each other", TEAM.commitOf({ ...base, pid: "ab", keyI: "c" }) !== TEAM.commitOf({ ...base, pid: "a", keyI: "bc" }));
  const seen = [new Set(), new Set(), new Set()];
  for (let i = 0; i < 4000; i++) TEAM.sasOf({ ...base, nR: C.bytesToHex(C.randomBytes(32)) }).forEach((v, k) => seen[k].add(v));
  check("all 56 emojis turn up in every position over random numbers", seen.every((s) => s.size === 56), seen.map((s) => s.size).join("/"));
  const log = (list) => list.map(([idx, tick]) => ({ idx, tick }));
  check("a run is three in a row", TEAM.findRun(log([[1, 10], [2, 11], [3, 12]]), [1, 2, 3], 0) === 0);
  check("an emoji in between breaks it", TEAM.findRun(log([[1, 10], [9, 11], [2, 12], [3, 13]]), [1, 2, 3], 0) === -1);
  check("...and sending the three again completes it", TEAM.findRun(log([[1, 10], [9, 11], [2, 12], [1, 13], [2, 14], [3, 15]]), [1, 2, 3], 0) === 3);
  check("emojis from before the agreed tick never count", TEAM.findRun(log([[1, 10], [2, 11], [3, 12]]), [1, 2, 3], 11) === -1);
  check("progress: repeats handled (1,1,2 after 1,1)", TEAM.progress(log([[1, 1], [1, 2]]), [1, 1, 2], 0) === 2 && TEAM.progress(log([[1, 1], [1, 2], [1, 3]]), [1, 1, 2], 0) === 2 && TEAM.progress(log([[1, 1], [5, 2]]), [1, 1, 2], 0) === 0);
}

console.log("two teammates");
{
  const w = world();
  w.addPlayer(1, "Alice", "Red");
  w.addPlayer(2, "Bob", "Red");
  w.addPlayer(3, "Eve", "Blue");
  const alice = w.join("alice", 1);
  const bob = w.join("bob", 2);
  const eve = w.join("eve", 3); // an enemy running the same extension, in the same relay room
  w.feed();
  w.hellos();
  check("each sees the other as a teammate with the extension, unverified", keyStatus(alice, bob.key) === "claimed" && keyStatus(bob, alice.key) === "claimed");
  check("the enemy is not listed, and lists nobody", keyStatus(alice, eve.key) === null && eve.state().mates.length === 0);
  const before = w.wire.length;
  w.advance(30000);
  check("nothing starts by itself: no pairing, no emoji prompt, without a click", !alice.state().pairing && !bob.state().pairing && !w.wire.slice(before).some((x) => x.type === "t-init"));

  alice.team.verify(bob.key);
  check("Alice pressed Verify: Bob sees the request, and no emojis yet on either side", bob.state().mates[0].keys[0].asks === true && !bob.state().pairing && alice.state().pairing?.stage === "asking" && !alice.state().pairing.emojis);
  check("...and Bob's extension has not answered with its number", !w.wire.some((x) => x.type === "t-resp"));
  bob.team.verify(alice.key);
  const ea = alice.state().pairing?.emojis;
  const eb = bob.state().pairing?.emojis;
  check("Bob pressed Verify too: both are shown the same three emojis", Array.isArray(ea) && ea.length === 3 && ea.join() === eb?.join(), `${ea} / ${eb}`);

  w.tick += 55;
  w.emoji(1, 2, ea[0]);
  check("progress follows my own emojis", alice.state().pairing.mine === 1 && bob.state().pairing.theirs === false);
  check("...with the game's 5 s cooldown for that teammate shown", alice.state().pairing.wait >= 4);
  w.sendRun(1, 2, ea.slice(1));
  check("Bob's extension saw Alice's three: Alice's key is verified", keyStatus(bob, alice.key) === "direct");
  check("Alice is not done: Bob has not sent his", keyStatus(alice, bob.key) === "claimed" && alice.state().pairing.mine === 3);
  w.sendRun(2, 1, eb);
  w.feed();
  check("both verified, both ways, pairing closed", keyStatus(alice, bob.key) === "direct" && alice.state().mates[0].keys[0].mutual && bob.state().mates[0].keys[0].mutual && !alice.state().pairing && !bob.state().pairing);

  const sent = await alice.team.say("attack north at 5:00");
  await settle();
  check("a team message arrives, under the name the GAME gives the sender", sent.ok && bob.messages.length === 1 && bob.messages[0].text === "attack north at 5:00" && bob.messages[0].name === "Alice" && bob.messages[0].sid === 1);
  check("the enemy in the same relay room gets nothing", eve.messages.length === 0);
  const msg = w.wire.filter((x) => x.type === "t-msg").pop();
  check("on the wire: no plain text, one wrapped key, none for the enemy", !JSON.stringify(msg.body).includes("attack") && Object.keys(msg.body.to).length === 1 && !msg.body.to[eve.key.slice(0, 16)]);

  // replay and tampering
  const read = N.readEvent(JSON.parse(JSON.stringify(msg.ev)), w.room);
  bob.team.onEvent(read);
  await settle();
  check("the same event again is not shown twice", bob.messages.length === 1);
  const mallory = w.attacker();
  mallory.send("t-msg", msg.body);
  await settle();
  check("the same ciphertext re-sent under another key is ignored", bob.messages.length === 1);
  const flipped = { ...msg.body, ct: (msg.body.ct[0] === "0" ? "1" : "0") + msg.body.ct.slice(1) };
  bob.team.onEvent({ ...read, id: "f".repeat(64), body: flipped });
  await settle();
  check("a flipped bit in the ciphertext is rejected", bob.messages.length === 1);

  // a message the enemy crafts for Bob, claiming to be Alice
  const eveSay = await eve.team.say("i am alice");
  check("the enemy cannot even send: it has no verified teammate", eveSay.ok === false);

  // persistence across a worker restart
  const again = w.join("alice2", 1, { saved: alice.savedState, secretKey: alice.secretKey });
  alice.closed = true;
  alice.team.close();
  w.feed();
  w.hellos();
  check("after a restart with the saved state, Bob is still verified", keyStatus(again, bob.key) === "direct");
  const bad = w.join("junk", 1, { saved: { direct: [["zz", 2], [bob.key, "x"], null], usedPids: "no", lastTs: [[1]] } });
  w.feed();
  check("junk in the saved state is dropped without throwing", bad.state().trusted === 0);
}

console.log("attacks");
{
  // 1. claiming to be the victim herself (the game says I am on my own team)
  const w = world();
  w.addPlayer(1, "Alice", "Red");
  w.addPlayer(2, "Bob", "Red");
  const alice = w.join("alice", 1);
  const bob = w.join("bob", 2);
  w.feed();
  w.hellos();
  const m = w.attacker();
  m.send("t-hello", { v: 1, sid: 1, direct: [], deny: [] });
  check("a stranger claiming to be ME is never a teammate, and raises the alarm", alice.state().impersonated === true && keyStatus(alice, m.key) === null && alice.team.verify(m.key) === false);
  m.send("t-init", { v: 1, to: alice.key, pid: "ab".repeat(8), sid: 1, peer: 1, c: "c".repeat(64) });
  check("...nor can it ask me to verify it", !alice.state().pairing && !alice.state().mates.some((x) => x.keys.some((k) => k.asks && k.key === m.key)));
  check("my teammates are told to refuse that key", w.wire.some((x) => x.from === "alice" && x.type === "t-hello" && x.body.deny.includes(m.key)));

  // 2. claiming to be Bob towards Alice: Alice even clicks Verify on it
  const imp = w.attacker();
  imp.send("t-hello", { v: 1, sid: 2, direct: [], deny: [] });
  check("two keys now claim to be Bob (the panel shows both)", alice.state().mates[0].keys.length === 2);
  alice.team.verify(imp.key);
  const init = imp.inbox("t-init").pop();
  imp.send("t-resp", { v: 1, to: alice.key, pid: init.body.pid, n: "7".repeat(64) });
  const shown = alice.state().pairing?.emojis;
  check("the handshake completes and Alice is shown emojis", Array.isArray(shown));
  imp.send("t-resp", { v: 1, to: alice.key, pid: init.body.pid, n: "8".repeat(64) });
  check("a second, different answer does not change them (no picking after seeing mine)", alice.state().pairing.emojis.join() === shown.join());
  w.sendRun(1, 2, shown);
  check("Alice sending them proves nothing about the impostor", keyStatus(alice, imp.key) === "claimed");
  // real Bob happens to send emojis: to someone else, broadcast, the wrong ones, or old ones
  w.addPlayer(4, "Carol", "Red");
  w.feed();
  w.sendRun(2, 4, shown);
  check("the right emojis from the real Bob, but sent to another teammate, do not count", keyStatus(alice, imp.key) === "claimed");
  const startTick = w.tick;
  w.feed([{ sid: 2, to: 1, emoji: shown[0], tick: 5 }, { sid: 2, to: 1, emoji: shown[1], tick: 6 }, { sid: 2, to: 1, emoji: shown[2], tick: 7 }]);
  check("...nor do the right emojis from before the pairing", keyStatus(alice, imp.key) === "claimed" && startTick > 7);
  w.advance(160000);
  check("it times out, and the impostor stays unverified", !alice.state().pairing && keyStatus(alice, imp.key) !== "direct" && alice.state().trusted === 0);

  // 3. fishing: the peer sprays emojis hoping to hit the run
  w.hellos();
  alice.team.verify(bob.key);
  bob.team.verify(alice.key);
  const want = alice.state().pairing.emojis;
  const other = TEAM.TABLE.filter((e, i) => TEAM.ALPHABET.includes(i) && !want.includes(e));
  for (let i = 0; i < 9; i++) w.sendRun(2, 1, [other[i]]);
  check("nine wrong emojis from the peer stop the verification", !alice.state().pairing && /too many/.test(alice.state().note) && keyStatus(alice, bob.key) === "claimed");
}
{
  // 4. a changed number after the commitment
  const w = world();
  w.addPlayer(1, "Alice", "Red");
  w.addPlayer(2, "Bob", "Red");
  const alice = w.join("alice", 1);
  w.feed();
  const m = w.attacker();
  m.send("t-hello", { v: 1, sid: 2, direct: [], deny: [] });
  const pid = "12".repeat(8);
  const nI = "3".repeat(64);
  const c = TEAM.commitOf({ room: w.room, pid, keyI: m.key, sidI: 2, keyR: alice.key, sidR: 1, nI });
  m.send("t-init", { v: 1, to: alice.key, pid, sid: 2, peer: 1, c });
  check("a request alone makes my extension say nothing", !w.wire.some((x) => x.from === "alice" && x.type === "t-resp"));
  alice.team.verify(m.key);
  check("after my click it answers once", w.wire.filter((x) => x.from === "alice" && x.type === "t-resp").length === 1);
  m.send("t-open", { v: 1, to: alice.key, pid, n: "4".repeat(64) });
  check("opening with a different number than committed fails the pairing", !alice.state().pairing && /changed its number/.test(alice.state().note));
  m.send("t-init", { v: 1, to: alice.key, pid, sid: 2, peer: 1, c });
  alice.team.verify(m.key);
  const resps = w.wire.filter((x) => x.from === "alice" && x.type === "t-resp");
  check("the same pairing id is never answered twice (no second number for one commitment)", resps.every((r) => r.body.pid !== pid || r === resps[0]) && resps.filter((r) => r.body.pid === pid).length === 1);
}
{
  // 5. while the game is fast-forwarding, old emojis arrive "now": nothing is verified then
  const w = world();
  w.addPlayer(1, "Alice", "Red");
  w.addPlayer(2, "Bob", "Red");
  const alice = w.join("alice", 1);
  const bob = w.join("bob", 2);
  w.feed();
  w.hellos();
  w.spawn = true;
  w.feed();
  check("no verification during the spawn phase", alice.team.verify(bob.key) === false && /spawn/.test(alice.state().note));
  w.spawn = false;
  w.feed();
  alice.team.verify(bob.key);
  bob.team.verify(alice.key);
  const e = alice.state().pairing.emojis;
  w.catchingUp = true;
  w.sendRun(2, 1, e);
  check("emojis seen while catching up are not judged", keyStatus(alice, bob.key) === "claimed");
  w.catchingUp = false;
  w.feed();
  check("...and are judged once the game is in step again", keyStatus(alice, bob.key) === "direct");
}

console.log("a team of four");
{
  const w = world();
  for (const [sid, name] of [[1, "Alice"], [2, "Bob"], [3, "Carol"], [4, "Dan"]]) w.addPlayer(sid, name, "Red");
  w.addPlayer(9, "Eve", "Blue");
  const [alice, bob, carol, dan] = [w.join("alice", 1), w.join("bob", 2), w.join("carol", 3), w.join("dan", 4)];
  w.feed();
  w.hellos();
  check("Alice-Bob pair", await pair(w, alice, bob));
  check("Bob-Carol pair", await pair(w, bob, carol));
  w.hellos();
  check("Alice trusts Carol through Bob, and Carol trusts Alice", keyStatus(alice, carol.key) === "vouched" && keyStatus(carol, alice.key) === "vouched");
  check("Dan, who verified nobody, trusts nobody and is trusted by nobody", dan.state().trusted === 0 && keyStatus(alice, dan.key) === "claimed");
  const r = await alice.team.say("hello team");
  await settle();
  check("Alice's message reaches Bob and Carol, not Dan", r.ok && r.to === 2 && bob.messages.length === 1 && carol.messages.length === 1 && dan.messages.length === 0);
  check("Dan is not told anything either (he trusts no sender)", dan.state().note === "");
  check("Carol-Dan pair", await pair(w, carol, dan));
  w.hellos();
  w.hellos();
  check("one more pairing connects Dan to everyone", dan.state().trusted === 3 && alice.state().trusted === 3);

  // two vouched keys for one player: believe neither
  const w2 = world("GAME2");
  for (const [sid, name] of [[1, "Alice"], [2, "Bob"], [3, "Carol"], [4, "Dan"]]) w2.addPlayer(sid, name, "Red");
  const [a2, b2, c2] = [w2.join("alice", 1), w2.join("bob", 2), w2.join("carol", 3)];
  w2.feed();
  w2.hellos();
  await pair(w2, a2, b2);
  await pair(w2, a2, c2);
  const fake1 = "1".repeat(63) + "a";
  const fake2 = "2".repeat(63) + "b";
  // Bob and Carol (both verified by Alice) vouch for DIFFERENT keys as Dan
  const vouchAs = (peer, k) => {
    const ev = N.makeEvent(peer.secretKey, { room: w2.room, type: "t-hello", body: { v: 1, sid: peer.sid, direct: [{ k: a2.key, sid: 1 }, { k, sid: 4 }], deny: [] } });
    a2.team.onEvent(N.readEvent(ev, w2.room));
  };
  vouchAs(b2, fake1);
  check("one voucher: the key is accepted as Dan", a2.team._trusted().get(fake1) === 4);
  vouchAs(c2, fake2);
  check("two vouchers naming different keys for Dan: neither is believed", !a2.team._trusted().has(fake1) && !a2.team._trusted().has(fake2));
  vouchAs(c2, fake1);
  check("...agreeing again restores it", a2.team._trusted().get(fake1) === 4);
  // the real Dan shows up and disowns the key
  const d2 = w2.join("dan", 4);
  w2.feed();
  const disown = N.makeEvent(d2.secretKey, { room: w2.room, type: "t-hello", body: { v: 1, sid: 4, direct: [], deny: [fake1] } });
  a2.team.onEvent(N.readEvent(disown, w2.room));
  check("a key disowned by someone claiming to be that player is not believed on hearsay", !a2.team._trusted().has(fake1));
  // a verified teammate cannot vouch a key in as ME, or as himself
  const self = N.makeEvent(b2.secretKey, { room: w2.room, type: "t-hello", body: { v: 1, sid: 2, direct: [{ k: a2.key, sid: 1 }, { k: fake2, sid: 1 }, { k: "3".repeat(64), sid: 2 }], deny: [] } });
  a2.team.onEvent(N.readEvent(self, w2.room));
  check("nobody can vouch a key in as me, or as a second self", ![...a2.team._trusted().values()].includes(1) && [...a2.team._trusted()].filter(([, sid]) => sid === 2).length === 1);
}

console.log("lossy relay, crossing clicks, one-sided result");
{
  const w = world();
  w.addPlayer(1, "Alice", "Red");
  w.addPlayer(2, "Bob", "Red");
  const alice = w.join("alice", 1);
  const bob = w.join("bob", 2);
  w.feed();
  w.hellos();
  let dropped = 0;
  w.drop = ({ type }) => (type === "t-resp" || type === "t-open") && dropped++ < 2; // lose the first answer and the first reveal
  alice.team.verify(bob.key);
  bob.team.verify(alice.key);
  check("the first answer was lost: no emojis yet", !alice.state().pairing?.emojis);
  for (let i = 0; i < 4; i++) w.advance(6000);
  check("resends get both sides to the same emojis", alice.state().pairing?.emojis?.join() === bob.state().pairing?.emojis?.join() && !!alice.state().pairing?.emojis, `${alice.state().pairing?.stage}/${bob.state().pairing?.stage}`);
  w.drop = null;

  // only Alice sends her emojis; Bob never does
  w.sendRun(1, 2, alice.state().pairing.emojis);
  w.advance(160000);
  check("one-sided: Bob verified Alice, Alice did not verify Bob, and is told why nothing works yet", keyStatus(bob, alice.key) === "direct" && keyStatus(alice, bob.key) === "claimed" && /did not send/.test(alice.state().note));
  const r = await bob.team.say("can you read this?");
  await settle();
  check("Bob can write to Alice, but Alice does not show a message from a key she has not verified", r.ok && alice.messages.length === 0);

  // both click at the same moment
  const w2 = world("CROSS");
  w2.addPlayer(1, "Alice", "Red");
  w2.addPlayer(2, "Bob", "Red");
  const a = w2.join("a", 1);
  const b = w2.join("b", 2);
  w2.feed();
  w2.hellos();
  let held = [];
  w2.drop = (x) => (x.type === "t-init" ? (held.push(x), true) : false); // both t-inits are "in flight"
  a.team.verify(b.key);
  b.team.verify(a.key);
  w2.drop = null;
  check("both asked at once", a.state().pairing?.stage === "asking" && b.state().pairing?.stage === "asking");
  for (let i = 0; i < 3; i++) w2.advance(6000); // resends cross
  check("crossing requests settle into one pairing with the same emojis", !!a.state().pairing?.emojis && a.state().pairing.emojis.join() === b.state().pairing?.emojis?.join(), `${a.state().pairing?.stage}/${b.state().pairing?.stage}`);
}

console.log("review regressions");
{
  const w = world("REGRESS");
  w.addPlayer(1, "Alice", "Red");
  w.addPlayer(2, "Bob", "Red");
  const alice = w.join("alice", 1);
  const bob = w.join("bob", 2);
  w.feed();
  w.hellos();
  // hostile shapes: objects that throw when turned into strings, arrays where strings belong
  const m = w.attacker();
  const boom = { toString: 0 };
  let threw = null;
  try {
    m.send("t-hello", { v: 1, sid: 2, direct: [{ k: boom, sid: 2 }, { k: ["a".repeat(64)], sid: 2 }], deny: [boom, ["b".repeat(64)]] });
    m.send("t-init", { v: 1, to: alice.key, pid: boom, sid: 2, peer: 1, c: "c".repeat(64) });
    m.send("t-init", { v: 1, to: alice.key, pid: ["ab".repeat(8)], sid: 2, peer: 1, c: "c".repeat(64) });
  } catch (err) {
    threw = err.message;
  }
  check("objects and arrays in place of hex strings are ignored, nothing throws", threw === null, threw);
  check("...and an array pairing id is not accepted as a request", !alice.state().mates.some((x) => x.keys.some((k) => k.key === m.key && k.asks)));
  let created = null;
  try {
    created = w.join("junk2", 1, { saved: { direct: "no", lastTs: { a: 1 }, usedPids: [boom], impostors: 5 } });
  } catch (err) {
    created = err.message;
  }
  check("saved state of the wrong types does not throw", typeof created === "object" && created !== null, String(created));

  // the 9-emoji cap holds even when many emojis are judged at once
  alice.team.verify(bob.key);
  bob.team.verify(alice.key);
  const want = alice.state().pairing.emojis;
  const wrong = TEAM.TABLE.filter((e, i) => TEAM.ALPHABET.includes(i) && !want.includes(e)).slice(0, 12);
  w.catchingUp = true;
  for (const e of [...wrong, ...want]) w.emoji(2, 1, e, w.tick + 55);
  w.catchingUp = false;
  w.feed();
  check("12 wrong emojis and then the right three, judged together: not verified", keyStatus(alice, bob.key) !== "direct" && !alice.state().pairing);

  // my own last timestamp survives a restart
  const w2 = world("STAMP");
  w2.addPlayer(1, "Alice", "Red");
  w2.addPlayer(2, "Bob", "Red");
  const a = w2.join("a", 1);
  const b = w2.join("b", 2);
  w2.feed();
  w2.hellos();
  await pair(w2, a, b);
  await a.team.say("one");
  await settle();
  check("my own newest timestamp is saved", Array.isArray(a.savedState?.lastTs) && a.savedState.lastTs.some(([k]) => k === a.key));
  w2.clock -= 5000; // the clock steps back, then the worker restarts
  a.closed = true;
  a.team.close();
  const a2 = w2.join("a2", 1, { saved: a.savedState, secretKey: a.secretKey });
  w2.feed();
  w2.hellos();
  await a2.team.say("two");
  await settle();
  check("after a restart and a clock step back my next message still arrives", b.messages.map((x) => x.text).join() === "one,two", b.messages.map((x) => x.text).join());

  // impostors of me are remembered across a restart, and denied first
  const imp = w2.attacker();
  imp.send("t-hello", { v: 1, sid: 1, direct: [], deny: [] });
  check("an impostor of me is saved", a2.savedState?.impostors?.includes(imp.key));
  for (let i = 0; i < 20; i++) w2.attacker().send("t-hello", { v: 1, sid: 1, direct: [], deny: [] });
  const vouchEv = N.makeEvent(b.secretKey, { room: w2.room, type: "t-hello", body: { v: 1, sid: 2, direct: [{ k: a2.key, sid: 1 }, { k: imp.key, sid: 1 }], deny: [] } });
  a2.team.onEvent(N.readEvent(vouchEv, w2.room));
  a2.team.hello();
  const last = w2.wire.filter((x) => x.from === "a2" && x.type === "t-hello").pop();
  check("the impostor someone vouched for stays in my deny list despite 20 newer ones", last?.body.deny.includes(imp.key) && last.body.deny.length <= 16);
}

console.log("review regressions, round 2");
{
  const w = world("ROUND2");
  w.addPlayer(1, "Alice", "Red");
  w.addPlayer(2, "Bob", "Red");
  w.addPlayer(3, "Carol", "Red");
  const [alice, bob, carol] = [w.join("alice", 1), w.join("bob", 2), w.join("carol", 3)];
  w.feed();
  w.hellos();
  // 40 junk keys claim to be Alice first, then the real impostor K1, which Bob (talked into it) vouches for
  for (let i = 0; i < 40; i++) w.attacker().send("t-hello", { v: 1, sid: 1, direct: [], deny: [] });
  const k1 = w.attacker();
  k1.send("t-hello", { v: 1, sid: 1, direct: [], deny: [] });
  await pair(w, bob, carol);
  const bobVouches = N.makeEvent(bob.secretKey, { room: w.room, type: "t-hello", body: { v: 1, sid: 2, direct: [{ k: carol.key, sid: 3 }, { k: k1.key, sid: 1 }], deny: [] } });
  // an attacker also vouches 24 random keys as Alice, trying to crowd K1 out of her deny list
  const crowd = w.attacker();
  crowd.send("t-hello", { v: 1, sid: 2, direct: Array.from({ length: 24 }, (_, i) => ({ k: i.toString(16).padStart(64, "a"), sid: 1 })), deny: [] });
  for (const p of [alice, carol]) p.team.onEvent(N.readEvent(bobVouches, w.room));
  alice.team.hello();
  const deny = w.wire.filter((x) => x.from === "alice" && x.type === "t-hello").pop()?.body.deny ?? [];
  check("after 40 junk claimants, the impostor someone vouches for is still denied", deny.includes(k1.key), `deny has ${deny.length}`);
  carol.team.onEvent(N.readEvent(N.makeEvent(alice.secretKey, { room: w.room, type: "t-hello", body: { v: 1, sid: 1, direct: [], deny } }), w.room));
  check("...so a teammate does not trust it as Alice on hearsay", carol.team._trusted().get(k1.key) !== 1);

  // the same emoji reported twice (two probes running) is one emoji: verification still works
  const w2 = world("TWICE");
  w2.addPlayer(1, "Alice", "Red");
  w2.addPlayer(2, "Bob", "Red");
  const a = w2.join("a", 1);
  const b = w2.join("b", 2);
  w2.feed();
  w2.hellos();
  a.team.verify(b.key);
  b.team.verify(a.key);
  const e = a.state().pairing.emojis;
  for (const x of e) {
    w2.tick += 55;
    w2.feed([{ sid: 2, to: 1, emoji: x, tick: w2.tick }, { sid: 2, to: 1, emoji: x, tick: w2.tick }]);
  }
  check("every emoji reported twice: still one run, verified", keyStatus(a, b.key) === "direct");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
