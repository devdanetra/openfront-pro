// Team chat: message text only verified teammates can read. The protocol, its threat
// model and what it does NOT protect against are in docs/TEAM-CHAT.md - read that
// first. In one paragraph:
//
// Everything in an OpenFront game is public, so there is no secret teammates share.
// What an enemy cannot do is ACT in the game as your teammate. Two players press
// Verify on each other; their extensions agree on three emojis with a
// commit-then-reveal exchange over the chat's relay room (so neither side, and
// nobody in the middle, can steer which three); each player sends them TO THE
// OTHER with the game's own emoji menu; and each extension watches, in its own
// copy of the game, for exactly that run from that player to me. A match proves
// the key on the other end belongs to that player. Verified keys vouch for the
// keys they verified, so a team needs a chain, not every pair. Message text is
// encrypted to the trusted keys only (verified by me, or vouched for by a key I
// trust); who talks to whom is public.
//
// This file is the logic, with no I/O of its own: the service worker hands it
// relay events and the game feed and gives it a publish function
// (background.js); tools/test-team.mjs runs several of these against each other
// and against attackers. It never sends anything into the game, and nothing
// here makes the user do so without a click of their own on Verify.
(() => {
  if (globalThis.OFR_TEAM) return;
  const C = globalThis.OFR_NOSTR_CRYPTO;

  // OpenFront's emoji table (src/core/Util.ts at v0.34.10), flattened, as code points.
  const TABLE = [
    [0x1f600], [0x1f60a], [0x1f970], [0x1f607], [0x1f60e], [0x1f61e], [0x1f97a], [0x1f62d], [0x1f631], [0x1f621],
    [0x1f608], [0x1f921], [0x1f971], [0x1fae1], [0x1f595], [0x1f44b], [0x1f44f], [0x270b], [0x1f64f], [0x1f4aa],
    [0x1f44d], [0x1f44e], [0x1faf4], [0x1f90c], [0x1f926, 0x200d, 0x2642, 0xfe0f], [0x1f91d], [0x1f198], [0x1f54a, 0xfe0f], [0x1f3f3, 0xfe0f], [0x23f3],
    [0x1f525], [0x1f4a5], [0x1f480], [0x2622, 0xfe0f], [0x26a0, 0xfe0f], [0x2196, 0xfe0f], [0x2b06, 0xfe0f], [0x2197, 0xfe0f], [0x1f451], [0x1f947],
    [0x2b05, 0xfe0f], [0x1f3af], [0x27a1, 0xfe0f], [0x1f948], [0x1f949], [0x2199, 0xfe0f], [0x2b07, 0xfe0f], [0x2198, 0xfe0f], [0x2764, 0xfe0f], [0x1f494],
    [0x1f4b0], [0x2693], [0x26f5], [0x1f3e1], [0x1f6e1, 0xfe0f], [0x1f3ed], [0x1f682], [0x2753], [0x1f414], [0x1f400],
  ].map((cps) => String.fromCodePoint(...cps));
  // Never asked of anyone: the middle finger, the clown, thumbs down, the rat.
  const RUDE = new Set([14, 11, 21, 59]);
  const ALPHABET = TABLE.map((_, i) => i).filter((i) => !RUDE.has(i)); // 56 -> 175 616 sequences
  const SAS_LEN = 3;
  const VS16 = String.fromCharCode(0xfe0f); // variation selector: there or not, depending on who typed it
  const plain = (emoji) => String(emoji).split(VS16).join("");
  const INDEX = new Map(TABLE.map((e, i) => [plain(e), i]));

  const V = 1;
  const HELLO_MS = 45000;
  const CLAIM_TTL_MS = 110000;
  const REQUEST_MS = 60000; // how long a teammate's request waits for my click
  const RESEND_MS = 5000;
  const OPEN_WAIT_MS = 25000;
  const EMOJI_MS = 150000;
  const UNSEEN_MS = 12000;
  const MAX_PEER_EMOJIS = 9; // the run must be within the peer's first 9 emojis: three honest attempts; more is somebody fishing
  const COOLDOWN_TICKS = 50;
  const MAX_CLAIMS_PER_SID = 4;
  const MAX_RECIPIENTS = 12;
  const MAX_PLAIN_BYTES = 1000; // 280 characters of any script, as UTF-8 JSON; 12 wraps still fit the 4 KB body
  const MAX_SKEW_MS = 120000;
  const HEX64_RE = /^[0-9a-f]{64}$/;
  const HEX16_RE = /^[0-9a-f]{16}$/;
  // Typed: RegExp.test() converts its argument, and {toString: 0} makes it throw.
  const HEX64 = { test: (x) => typeof x === "string" && HEX64_RE.test(x) };
  const HEX16 = { test: (x) => typeof x === "string" && HEX16_RE.test(x) };
  const okSid = (n) => Number.isInteger(n) && n > 0 && n < 4096;

  const hex = (bytes) => C.bytesToHex(bytes);
  const unhex = (text) => C.hexToBytes(text);
  const utf8 = (text) => C.utf8ToBytes(text);
  // Every hash is over a JSON array of strings and integers: unambiguous, no field can run into the next.
  const hashOf = (...parts) => C.sha256(utf8(JSON.stringify(parts)));
  const randomHex = (n) => hex(C.randomBytes(n));

  function sasOf({ room, pid, keyI, sidI, keyR, sidR, c, nI, nR }) {
    const h = hashOf("ofpro-sas-v1", room, pid, keyI, sidI, keyR, sidR, c, nI, nR, TABLE.length);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(h[i]); // 64 bits; the bias of the modulo is ~1e-14
    const base = BigInt(ALPHABET.length);
    v %= base ** BigInt(SAS_LEN);
    const out = [];
    for (let i = 0; i < SAS_LEN; i++) {
      out.unshift(ALPHABET[Number(v % base)]);
      v /= base;
    }
    return out;
  }
  const commitOf = ({ room, pid, keyI, sidI, keyR, sidR, nI }) => hex(hashOf("ofpro-commit-v1", room, pid, keyI, sidI, keyR, sidR, nI));

  // `log`: one sender's emoji messages TO one recipient, in game order. A run is
  // three in a row. Returns the index of the first run from `fromTick` on, or -1.
  function findRun(log, sas, fromTick) {
    const seq = log.filter((e) => e.tick >= fromTick);
    for (let i = 0; i + sas.length <= seq.length; i++) if (sas.every((want, k) => seq[i + k].idx === want)) return i;
    return -1;
  }
  // How far along a sender is: 3 when a run exists, else the longest tail that starts a run.
  function progress(log, sas, fromTick) {
    if (findRun(log, sas, fromTick) !== -1) return sas.length;
    const seq = log.filter((e) => e.tick >= fromTick);
    for (let k = Math.min(sas.length - 1, seq.length); k > 0; k--) if (sas.slice(0, k).every((want, j) => seq[seq.length - k + j].idx === want)) return k;
    return 0;
  }

  function create({ room, secretKey, publish, onState, onMessage, now = () => Date.now(), subtle = globalThis.crypto?.subtle, saved = null, save = () => {}, timers = true }) {
    const myKey = hex(C.schnorr.getPublicKey(secretKey));
    let closed = false;

    // ---- what the game says: the ONLY source of who is on my team and who sent which emoji ----
    let mySid = null;
    let myAlive = false;
    let spawn = true;
    let catchingUp = false;
    let lastTick = 0;
    let roster = new Map(); // sid -> { name, alive }
    const emojis = new Map(); // "from>to" -> [{ idx, tick }], game order

    // ---- what the relay room says: claims. Nothing here is believed by itself. ----
    const claims = new Map(); // key -> { sid, seen, first, vouches: Map(key -> sid), deny: Set(key) }
    const requests = new Map(); // key -> { pid, c, sid, at }: a teammate pressed Verify on me; waits for MY click
    const list = (x) => (Array.isArray(x) ? x : []);
    const direct = new Map(list(saved?.direct).filter((d) => Array.isArray(d) && HEX64.test(d[0]) && okSid(d[1]))); // key -> sid, verified by ME through the game
    const usedPids = new Set(list(saved?.usedPids).filter((p) => HEX16.test(p)));
    const lastTs = new Map(list(saved?.lastTs).filter((d) => Array.isArray(d) && HEX64.test(d[0]) && Number.isFinite(d[1])));
    const impostors = new Set(list(saved?.impostors).filter((k) => HEX64.test(k)).slice(-32)); // keys that claimed to be ME
    const unreadable = new Map(); // sender key -> when I last said "cannot read X"
    let trusted = new Map(); // key -> sid (derived from direct + vouches)
    let pairing = null;
    let lastHello = 0;
    let helloSoon = null;
    let note = "";

    const persist = () => {
      const stamps = [...lastTs].filter(([k]) => k !== myKey).slice(-63);
      if (lastTs.has(myKey)) stamps.push([myKey, lastTs.get(myKey)]); // my own newest stamp must survive a restart (clock steps back)
      save({ direct: [...direct], usedPids: [...usedPids].slice(-64), lastTs: stamps, impostors: [...impostors] });
    };
    // A teammate is a human on my team in MY copy of the game, and never myself:
    // the game's own isOnSameTeam() is true for me, and a stranger who claimed to be
    // me would otherwise be "verified" by the emojis I send myself.
    const isMate = (sid) => okSid(sid) && mySid !== null && sid !== mySid && roster.has(sid);
    const nameOf = (sid) => roster.get(sid)?.name || "your teammate";
    const logOf = (from, to) => emojis.get(`${from}>${to}`) ?? [];

    // Trust: what I verified myself, then level by level what trusted keys vouch for.
    // One player, one vouched key: if two are proposed for the same player, neither
    // is believed (verify that player yourself). Nor is a key that anyone claiming
    // to be that player disowns ("that key says it is me, and it is not"): what I
    // verified myself stands, but hearsay about a disputed player does not.
    function recompute() {
      const next = new Map();
      const sidHasKey = new Set();
      const denied = (key, sid) => [...claims.values()].some((c) => c.sid === sid && c.deny.has(key));
      let level = [];
      for (const [key, sid] of direct) {
        if (!isMate(sid) || impostors.has(key)) continue;
        next.set(key, sid);
        sidHasKey.add(sid);
        level.push(key);
      }
      for (let depth = 0; level.length && depth < 8; depth++) {
        const proposed = new Map(); // key -> sid | null (null: contradictory)
        for (const voucher of level) {
          for (const [key, sid] of claims.get(voucher)?.vouches ?? []) {
            if (key === myKey || next.has(key) || !isMate(sid) || sidHasKey.has(sid) || impostors.has(key)) continue;
            if (sid === next.get(voucher)) continue; // nobody vouches for a second key of their own
            proposed.set(key, proposed.has(key) && proposed.get(key) !== sid ? null : sid);
          }
        }
        const perSid = new Map();
        for (const [key, sid] of proposed) if (sid !== null) perSid.set(sid, [...(perSid.get(sid) ?? []), key]);
        level = [];
        for (const [sid, keys] of perSid) {
          if (keys.length !== 1 || denied(keys[0], sid)) continue;
          next.set(keys[0], sid);
          sidHasKey.add(sid);
          level.push(keys[0]);
        }
      }
      trusted = next;
    }
    const live = (key) => now() - (claims.get(key)?.seen ?? 0) < CLAIM_TTL_MS;
    const trustsMe = (key) => claims.get(key)?.vouches.get(myKey) === mySid;

    // ---- state for the panel ------------------------------------------------------------------
    function snapshot() {
      const t = now();
      for (const [key, r] of requests) if (t - r.at > REQUEST_MS || trusted.has(key)) requests.delete(key);
      const mates = [...roster.entries()]
        .filter(([sid]) => sid !== mySid)
        .map(([sid, r]) => ({
          sid,
          name: r.name,
          alive: r.alive,
          keys: [...claims.entries()]
            .filter(([key, c]) => c.sid === sid && (live(key) || trusted.has(key)))
            .slice(0, MAX_CLAIMS_PER_SID)
            .map(([key]) => ({
              key,
              status: trusted.has(key) ? (direct.has(key) ? "direct" : "vouched") : "claimed",
              mutual: trusted.has(key) && trustsMe(key),
              live: live(key),
              asks: requests.has(key),
            })),
        }));
      let p = null;
      if (pairing) {
        const mineLog = logOf(mySid, pairing.peerSid);
        const lastMine = mineLog.length ? mineLog[mineLog.length - 1].tick : -1000;
        p = {
          peerSid: pairing.peerSid,
          peerName: nameOf(pairing.peerSid),
          peerKey: pairing.peerKey,
          stage: !pairing.sas ? (pairing.role === "I" && !pairing.nPeer ? "asking" : "handshake") : "emojis",
          emojis: pairing.sas ? pairing.sas.map((i) => TABLE[i]) : null,
          mine: pairing.sas ? progress(mineLog, pairing.sas, pairing.startTick) : 0,
          theirs: pairing.theirsDone === true,
          unseen: pairing.unseen === true,
          wait: Math.max(0, Math.ceil((COOLDOWN_TICKS - (lastTick - lastMine)) / 10)), // seconds until the game lets me send them another
          endsAt: pairing.deadline,
        };
      }
      return { ready: mySid !== null, spawn, alive: myAlive, catchingUp, me: mySid, key: myKey, mates, trusted: trusted.size, reachable: [...trusted.keys()].filter((k) => trustsMe(k) && live(k)).length, impersonated: impostors.size > 0, note, pairing: p };
    }
    let lastSnap = "";
    const changed = () => {
      if (closed) return;
      const snap = snapshot();
      const text = JSON.stringify(snap);
      if (text === lastSnap) return;
      lastSnap = text;
      onState(snap);
    };

    // ---- hello: my claim, the keys I verified myself, and keys that claimed to be me ----------------
    function hello() {
      if (closed || mySid === null) return;
      lastHello = now();
      const vouch = [...direct].filter(([k, sid]) => isMate(sid) && !impostors.has(k)).slice(-24).map(([k, sid]) => ({ k, sid }));
      // First the keys someone vouches for as me (the ones hearsay could promote) -
      // taken from the vouches themselves, so a flood of junk claimants cannot push
      // them out - then the newest keys that claimed to be me.
      // (vouches by keys I trust come first: nobody can crowd those out with junk)
      const asMe = (c) => [...c.vouches].filter(([k, sid]) => sid === mySid && k !== myKey).map(([k]) => k);
      const byTrust = [...claims].sort(([a], [b]) => Number(trusted.has(b)) - Number(trusted.has(a)));
      const vouchedAsMe = [...new Set(byTrust.flatMap(([, c]) => asMe(c)))];
      const deny = [...new Set([...vouchedAsMe, ...[...impostors].reverse()])].slice(0, 16);
      publish("t-hello", { v: V, sid: mySid, direct: vouch, deny });
    }
    function helloSoonish() {
      if (!timers || helloSoon || now() - lastHello < 8000) return;
      helloSoon = setTimeout(() => {
        helloSoon = null;
        hello();
      }, 1500);
    }
    function itsMe(key) {
      if (impostors.has(key)) return;
      if (impostors.size >= 32) {
        // full: forget the oldest one nobody vouches for as me, never refuse a new one
        const vouched = new Set([...claims.values()].flatMap((c) => [...c.vouches].filter(([, sid]) => sid === mySid).map(([k]) => k)));
        const old = [...impostors].find((k) => !vouched.has(k)) ?? [...impostors][0];
        impostors.delete(old);
      }
      impostors.add(key);
      direct.delete(key);
      recompute();
      persist();
      note = "Someone else is claiming to be you in this game's team chat. Only ever send emojis that THIS panel asks for, after you pressed Verify yourself.";
      hello(); // teammates who verified me will refuse that key
      changed();
    }

    // ---- pairing ---------------------------------------------------------------------------------
    const canPair = () => mySid !== null && !spawn && !catchingUp;

    function endPairing(why) {
      if (!pairing) return;
      usedPids.add(pairing.pid);
      note = why ?? "";
      pairing = null;
      persist();
      changed();
    }

    const sendInit = () => publish("t-init", { v: V, to: pairing.peerKey, pid: pairing.pid, sid: mySid, peer: pairing.peerSid, c: pairing.commit });
    const sendResp = () => publish("t-resp", { v: V, to: pairing.peerKey, pid: pairing.pid, n: pairing.nMine });
    const sendOpen = () => publish("t-open", { v: V, to: pairing.peerKey, pid: pairing.pid, n: pairing.nMine });

    function initiate(peerKey, peerSid) {
      const pid = randomHex(8);
      const nMine = randomHex(32);
      const commit = commitOf({ room, pid, keyI: myKey, sidI: mySid, keyR: peerKey, sidR: peerSid, nI: nMine });
      pairing = { role: "I", pid, peerKey, peerSid, nMine, nPeer: null, commit, sas: null, startTick: null, deadline: now() + REQUEST_MS, sent: now(), resends: 0 };
      note = "";
      sendInit();
    }
    function respond(peerKey, request) {
      requests.delete(peerKey);
      usedPids.add(request.pid); // this pid is answered once, with one number, ever
      const nMine = randomHex(32);
      // From the moment my random half is out the emojis are fixed, so only emoji
      // messages from this tick on can count - never anything sent before.
      pairing = { role: "R", pid: request.pid, peerKey, peerSid: request.sid, nMine, nPeer: null, commit: request.c, sas: null, startTick: lastTick, deadline: now() + OPEN_WAIT_MS, sent: now(), resends: 0 };
      note = "";
      persist();
      sendResp();
    }

    // The user pressed Verify next to a key. Nothing in a pairing happens without it,
    // on either side: an emoji prompt is always the answer to a click of my own.
    function verify(key) {
      if (closed || !HEX64.test(key)) return false;
      const claim = claims.get(key);
      if (!claim || !isMate(claim.sid) || impostors.has(key)) return false;
      if (!canPair()) {
        note = spawn ? "Teammates can be verified once the spawn phase is over." : "Wait until the game has caught up.";
        changed();
        return false;
      }
      if (pairing && pairing.sas && now() < pairing.deadline) return false; // finish or cancel the running one first
      if (pairing) usedPids.add(pairing.pid);
      pairing = null;
      const request = requests.get(key);
      if (request && now() - request.at < REQUEST_MS && request.sid === claim.sid && !usedPids.has(request.pid)) respond(key, request);
      else initiate(key, claim.sid);
      changed();
      return true;
    }

    function onInit(from, body) {
      if (body.to !== myKey || !HEX16.test(body.pid) || !HEX64.test(body.c) || !okSid(body.sid) || !okSid(body.peer)) return;
      if (mySid === null) return;
      if (body.sid === mySid) return itsMe(from);
      if (body.peer !== mySid || !isMate(body.sid) || impostors.has(from) || usedPids.has(body.pid)) return;
      const claim = claims.get(from);
      if (claim && claim.sid !== body.sid) return; // a key speaks for one player
      if (pairing && pairing.peerKey === from) {
        if (pairing.role === "R" && pairing.pid === body.pid && pairing.commit === body.c) return; // a resend of what I already answered; the resend timer covers it
        // We both pressed Verify at the same moment: the smaller key's request goes ahead.
        if (pairing.role === "I" && !pairing.nPeer && from < myKey && canPair()) {
          usedPids.add(pairing.pid);
          pairing = null;
          respond(from, { pid: body.pid, c: body.c, sid: body.sid, at: now() });
          changed();
        }
        return;
      }
      const known = requests.get(from);
      if (known && known.pid === body.pid) {
        if (known.c === body.c) known.at = now(); // a resend: they are still waiting
        return;
      }
      if (!known && requests.size >= 8) return;
      requests.set(from, { pid: body.pid, c: body.c, sid: body.sid, at: now() });
      if (!claim) noteClaim(from, body.sid);
      changed();
    }

    function onResp(from, body) {
      if (!pairing || pairing.role !== "I" || from !== pairing.peerKey) return;
      if (body.to !== myKey || body.pid !== pairing.pid || !HEX64.test(body.n)) return;
      if (pairing.nPeer) {
        // Their number is fixed by the FIRST answer. The same one again means my t-open got lost.
        if (body.n === pairing.nPeer && pairing.resends < 6) {
          pairing.resends++;
          sendOpen();
        }
        return;
      }
      if (!canPair()) return endPairing("Verification stopped: the game is not in step right now. Try again.");
      pairing.nPeer = body.n;
      pairing.sas = sasOf({ room, pid: pairing.pid, keyI: myKey, sidI: mySid, keyR: from, sidR: pairing.peerSid, c: pairing.commit, nI: pairing.nMine, nR: body.n });
      pairing.startTick = lastTick;
      pairing.deadline = now() + EMOJI_MS;
      pairing.resends = 0;
      sendOpen();
      changed();
    }

    function onOpen(from, body) {
      if (!pairing || pairing.role !== "R" || pairing.sas || from !== pairing.peerKey) return;
      if (body.to !== myKey || body.pid !== pairing.pid || !HEX64.test(body.n)) return;
      if (commitOf({ room, pid: pairing.pid, keyI: from, sidI: pairing.peerSid, keyR: myKey, sidR: mySid, nI: body.n }) !== pairing.commit) return endPairing("Verification failed: the other side changed its number. Do not retry with that key.");
      pairing.nPeer = body.n;
      pairing.sas = sasOf({ room, pid: pairing.pid, keyI: from, sidI: pairing.peerSid, keyR: myKey, sidR: mySid, c: pairing.commit, nI: body.n, nR: pairing.nMine });
      pairing.deadline = now() + EMOJI_MS;
      changed();
    }

    function checkPairing() {
      if (!pairing) return;
      const t = now();
      const name = nameOf(pairing.peerSid);
      if (t > pairing.deadline) {
        if (pairing.theirsDone) return endPairing(trustsMe(pairing.peerKey) ? "" : `You verified ${name}, but ${name} has not verified you yet: they cannot read your team messages until they see your three emojis.`);
        return endPairing(pairing.sas ? `${name} did not send the emojis in time.` : pairing.role === "I" && !pairing.nPeer ? `${name} did not press Verify in time.` : `${name}'s extension stopped answering.`);
      }
      if (!pairing.sas) {
        // relay events get lost: say it again until the next step arrives
        if (t - pairing.sent > RESEND_MS && pairing.resends < 10) {
          pairing.sent = t;
          pairing.resends++;
          if (pairing.role === "I") sendInit();
          else sendResp();
        }
        return;
      }
      if (catchingUp) return; // a fast-forwarding client sees old emojis arrive "now"
      const theirs = logOf(pairing.peerSid, mySid).filter((e) => e.tick >= pairing.startTick);
      if (!pairing.theirsDone) {
        const at = findRun(theirs, pairing.sas, 0);
        if (at !== -1 && at + SAS_LEN <= MAX_PEER_EMOJIS) {
          pairing.theirsDone = true;
          direct.set(pairing.peerKey, pairing.peerSid);
          recompute();
          persist();
          hello(); // tell the team (and the peer) right away
        } else if (theirs.length >= MAX_PEER_EMOJIS) {
          return endPairing(`${name} sent too many emojis that were not the three agreed ones. Verification stopped.`);
        }
      }
      const mineDone = findRun(logOf(mySid, pairing.peerSid), pairing.sas, pairing.startTick) !== -1;
      if (mineDone && !pairing.mineAt) pairing.mineAt = t;
      if (pairing.theirsDone && trustsMe(pairing.peerKey)) return endPairing("");
      // I sent all three, and they still do not vouch for me: their extension did not see them
      pairing.unseen = mineDone && !trustsMe(pairing.peerKey) && t - pairing.mineAt > UNSEEN_MS;
    }

    // ---- messages ------------------------------------------------------------------------------------
    const keks = new Map();
    async function kekFor(peerKey) {
      let key = keks.get(peerKey);
      if (!key) {
        const shared = await subtle.importKey("raw", C.ecdh(secretKey, peerKey), "HKDF", false, ["deriveKey"]);
        key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8(room), info: utf8("ofpro-team-v1") }, shared, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        keks.set(peerKey, key);
      }
      return key;
    }
    const aadMsg = (sender) => utf8(JSON.stringify(["ofpro-team-msg-v1", room, sender]));
    const aadWrap = (sender, recipient) => utf8(JSON.stringify(["ofpro-team-wrap-v1", room, sender, recipient]));

    async function say(text) {
      if (closed || mySid === null) return { ok: false, why: "not in a team game" };
      const shuffle = (keys) => keys.map((k) => [C.randomBytes(4).reduce((a, b) => a * 256 + b, 0), k]).sort((a, b) => a[0] - b[0]).map(([, k]) => k);
      const live_ = [...trusted.keys()].filter(live);
      const all = [...shuffle(live_.filter((k) => direct.has(k))), ...shuffle(live_.filter((k) => !direct.has(k)))];
      const to = all.slice(0, MAX_RECIPIENTS);
      if (!to.length) return { ok: false, why: trusted.size ? "no verified teammate is online" : "no verified teammate yet" };
      const ts = Math.max(now(), (lastTs.get(myKey) ?? 0) + 1);
      const plainBytes = utf8(JSON.stringify({ text: String(text), sid: mySid, ts }));
      if (plainBytes.length > MAX_PLAIN_BYTES) return { ok: false, why: "message too long" };
      const wraps = {};
      let ct;
      const iv = C.randomBytes(12);
      try {
        const mk = C.randomBytes(32);
        const mkKey = await subtle.importKey("raw", mk, "AES-GCM", false, ["encrypt"]);
        ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadMsg(myKey) }, mkKey, plainBytes));
        for (const key of to) {
          try {
            const wiv = C.randomBytes(12);
            const wrapped = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: wiv, additionalData: aadWrap(myKey, key) }, await kekFor(key), mk));
            wraps[key.slice(0, 16)] = hex(wiv) + hex(wrapped);
          } catch {
            // a key that is not a point on the curve: nobody can be behind it
          }
        }
      } catch {
        return { ok: false, why: "encryption failed" };
      }
      const count = Object.keys(wraps).length;
      if (closed || !count) return { ok: false, why: "encryption failed" };
      lastTs.set(myKey, ts);
      persist();
      const sent = publish("t-msg", { v: V, iv: hex(iv), ct: hex(ct), to: wraps });
      return sent ? { ok: true, at: ts, to: count, skipped: all.length - count } : { ok: false, why: "no relay reachable" };
    }

    async function onMsg(from, body, id) {
      const sid = trusted.get(from);
      if (sid === undefined) return; // not a verified teammate: not even tried
      const mine = body.to && typeof body.to === "object" ? body.to[myKey.slice(0, 16)] : null;
      if (typeof mine !== "string") {
        // a verified teammate wrote, but not to me: they have not verified me (or do not know it yet)
        if (now() - (unreadable.get(from) ?? 0) > 60000) {
          unreadable.set(from, now());
          note = trustsMe(from)
            ? `${nameOf(sid)} sent a team message to more than ${MAX_RECIPIENTS} teammates, and you were not among them this time.`
            : `${nameOf(sid)} sent a team message you cannot read: their extension has not verified you yet. Press Verify next to their name.`;
          helloSoonish();
          changed();
        }
        return;
      }
      if (!/^[0-9a-f]{120}$/.test(mine) || typeof body.iv !== "string" || !/^[0-9a-f]{24}$/.test(body.iv)) return;
      if (typeof body.ct !== "string" || body.ct.length > 3000 || !/^([0-9a-f]{2}){17,}$/.test(body.ct)) return;
      try {
        const mk = await subtle.decrypt({ name: "AES-GCM", iv: unhex(mine.slice(0, 24)), additionalData: aadWrap(from, myKey) }, await kekFor(from), unhex(mine.slice(24)));
        const mkKey = await subtle.importKey("raw", mk, "AES-GCM", false, ["decrypt"]);
        const plainBytes = await subtle.decrypt({ name: "AES-GCM", iv: unhex(body.iv), additionalData: aadMsg(from) }, mkKey, unhex(body.ct));
        const msg = JSON.parse(new TextDecoder().decode(plainBytes));
        if (!msg || typeof msg.text !== "string" || msg.sid !== sid || !Number.isFinite(msg.ts)) return;
        if (Math.abs(msg.ts - now()) > MAX_SKEW_MS || msg.ts <= (lastTs.get(from) ?? 0)) return; // stale, or a replay
        if (closed || trusted.get(from) !== sid) return;
        lastTs.set(from, msg.ts);
        persist();
        onMessage({ id, key: from, sid, name: roster.get(sid)?.name ?? "", text: msg.text.slice(0, 400), at: msg.ts });
      } catch {
        // tampered with, or not really for me: nothing to show
      }
    }

    // ---- inputs ---------------------------------------------------------------------------------------
    function noteClaim(key, sid) {
      const same = [...claims.entries()].filter(([k, c]) => c.sid === sid && live(k)).length;
      if (same >= MAX_CLAIMS_PER_SID || claims.size > 256) return null;
      const claim = { sid, seen: now(), first: now(), vouches: new Map(), deny: new Set() };
      claims.set(key, claim);
      helloSoonish(); // a newcomer should not wait 45 s to hear from me
      return claim;
    }

    function onEvent(ev) {
      if (closed || !ev || ev.pubkey === myKey || !HEX64.test(ev.pubkey) || !ev.body || ev.body.v !== V || mySid === null) return;
      const { pubkey: from, body } = ev;
      if (ev.type === "t-hello") {
        if (!okSid(body.sid)) return;
        if (body.sid === mySid) return itsMe(from);
        if (!isMate(body.sid) || impostors.has(from)) return;
        const claim = claims.get(from) ?? noteClaim(from, body.sid);
        if (!claim || claim.sid !== body.sid) return; // a key speaks for one player: the first it named
        claim.seen = now();
        const vouches = new Map();
        for (const item of Array.isArray(body.direct) ? body.direct.slice(0, 24) : []) if (item && HEX64.test(item.k) && okSid(item.sid) && item.k !== from && item.sid !== body.sid) vouches.set(item.k, item.sid);
        claim.vouches = vouches;
        claim.deny = new Set((Array.isArray(body.deny) ? body.deny.slice(0, 16) : []).filter((k) => HEX64.test(k)));
        recompute();
        checkPairing();
        changed();
      } else if (ev.type === "t-init") onInit(from, body);
      else if (ev.type === "t-resp") onResp(from, body);
      else if (ev.type === "t-open") onOpen(from, body);
      else if (ev.type === "t-msg") onMsg(from, body, ev.id);
    }

    // The page's report of the game (src/page-probe.js -> chat.js -> here): the local
    // truth about teams and emojis. It crosses the page, so shapes are checked.
    function feed(data) {
      if (closed || !data || typeof data !== "object") return;
      if (Number.isInteger(data.tick) && data.tick >= 0) {
        if (data.tick + 50 < lastTick) emojis.clear(); // the page was reloaded and is replaying the game
        lastTick = data.tick;
      }
      spawn = data.spawn === true;
      catchingUp = data.catchingUp === true;
      if (Array.isArray(data.roster)) {
        const next = new Map();
        let me = null;
        let alive = false;
        for (const r of data.roster.slice(0, 128)) {
          if (!r || !okSid(r.sid)) continue;
          next.set(r.sid, { name: String(r.name ?? "").slice(0, 40), alive: r.alive === true });
          if (r.me === true) {
            me = me === null ? r.sid : -1;
            alive = r.alive === true;
          }
        }
        if (me !== null && me !== -1 && (mySid === null || mySid === me)) {
          const first = mySid === null;
          roster = next;
          mySid = me;
          myAlive = alive;
          recompute();
          if (first) hello();
        }
      }
      for (const e of Array.isArray(data.emojis) ? data.emojis.slice(0, 32) : []) {
        if (!e || !okSid(e.sid) || !okSid(e.to) || !Number.isInteger(e.tick) || typeof e.emoji !== "string") continue; // broadcasts (to everyone) are not evidence
        const slot = `${e.sid}>${e.to}`;
        const log = emojis.get(slot) ?? [];
        const entry = { idx: INDEX.get(plain(e.emoji)) ?? -1, tick: e.tick };
        if (log.some((x) => x.tick === entry.tick && x.idx === entry.idx)) continue; // reported twice: one emoji
        let at = log.length;
        while (at > 0 && log[at - 1].tick > entry.tick) at--; // game order; same tick keeps arrival order
        log.splice(at, 0, entry);
        emojis.set(slot, log.slice(-48));
      }
      checkPairing();
      changed();
    }

    function cancel() {
      endPairing("Verification cancelled.");
    }
    function tick() {
      if (closed) return;
      checkPairing();
      if (now() - lastHello > HELLO_MS) hello();
      changed();
    }
    function close() {
      closed = true;
      clearTimeout(helloSoon);
    }

    return { key: myKey, onEvent, feed, verify, cancel, say, tick, hello, close, snapshot, _trusted: () => new Map(trusted) };
  }

  globalThis.OFR_TEAM = { create, sasOf, commitOf, findRun, progress, TABLE, ALPHABET };
})();
