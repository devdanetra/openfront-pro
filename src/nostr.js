// Minimal Nostr client for the game chat: just enough of NIP-01 to publish and
// receive EPHEMERAL events (kinds 20000-29999: relays forward them to whoever is
// subscribed and store nothing) on a handful of public relays.
//
// Why Nostr: a chat needs a meeting point, and this extension has no server.
// Public relays are that meeting point - third-party, free, no account, and the
// messages are signed by a key that never leaves this browser. The relays see
// your IP address and what you send; other players see neither (unlike WebRTC,
// where every peer learns every other peer's IP).
//
// Runs in the service worker (importScripts) and in node (tools/test-chat.mjs).
// Needs globalThis.OFR_NOSTR_CRYPTO (src/vendor/nostr-crypto.js: @noble/curves
// BIP-340 Schnorr + SHA-256, bundled by tools/build-vendor.mjs).
(() => {
  if (globalThis.OFR_NOSTR) return;
  const C = globalThis.OFR_NOSTR_CRYPTO;

  const KIND = 20787; // ephemeral; the number is arbitrary, the range is what matters
  const MAX_TEXT = 280;
  const MAX_NAME = 32;
  const MAX_SKEW = 120; // seconds a message's clock may differ from ours

  const hex = (bytes) => C.bytesToHex(bytes);
  const sha256hex = (text) => hex(C.sha256(C.utf8ToBytes(text)));

  // The room for one game. Hashed and lowercase: relays may fold the case of "t"
  // tags (they are hashtags), and game ids are case-sensitive.
  const roomOf = (gameId) => `ofpro${sha256hex(`openfront-pro:${gameId}`).slice(0, 24)}`;

  function newSecretKey() {
    return hex(C.schnorr.utils.randomPrivateKey());
  }
  function publicKeyOf(secretKey) {
    return hex(C.schnorr.getPublicKey(secretKey));
  }

  // NIP-01: id = sha256 of this exact JSON array.
  function eventId(ev) {
    return sha256hex(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
  }

  function makeEvent(secretKey, { room, type, text = "", name = "" }) {
    const now = Math.floor(Date.now() / 1000);
    const ev = {
      pubkey: publicKeyOf(secretKey),
      created_at: now,
      kind: KIND,
      tags: [
        ["t", room],
        ["x", type], // "msg" | "here" | "bye"
        ["name", String(name).slice(0, MAX_NAME)],
        ["expiration", String(now + 300)], // NIP-40, for relays that would keep it anyway
      ],
      content: String(text).slice(0, MAX_TEXT),
    };
    ev.id = eventId(ev);
    ev.sig = hex(C.schnorr.sign(ev.id, secretKey));
    return ev;
  }

  // Everything a relay hands us is untrusted: shape, size, id, signature, clock.
  // Returns the parsed message, or null.
  function readEvent(ev, room) {
    try {
      if (!ev || typeof ev !== "object" || ev.kind !== KIND) return null;
      if (typeof ev.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(ev.pubkey)) return null;
      if (typeof ev.sig !== "string" || !/^[0-9a-f]{128}$/.test(ev.sig)) return null;
      if (typeof ev.id !== "string" || typeof ev.content !== "string" || !Array.isArray(ev.tags)) return null;
      if (!Number.isInteger(ev.created_at)) return null;
      if (ev.content.length > MAX_TEXT * 2 || ev.tags.length > 12) return null;
      if (Math.abs(ev.created_at - Date.now() / 1000) > MAX_SKEW) return null;
      const tag = (k) => {
        const t = ev.tags.find((x) => Array.isArray(x) && x[0] === k);
        return t && typeof t[1] === "string" ? t[1] : null;
      };
      if (tag("t") !== room) return null;
      const type = tag("x");
      if (type !== "msg" && type !== "here" && type !== "bye") return null;
      if (eventId(ev) !== ev.id) return null;
      if (!C.schnorr.verify(ev.sig, ev.id, ev.pubkey)) return null;
      return {
        id: ev.id,
        pubkey: ev.pubkey,
        at: ev.created_at * 1000,
        type,
        name: (tag("name") ?? "").slice(0, MAX_NAME),
        text: ev.content.slice(0, MAX_TEXT),
      };
    } catch {
      return null;
    }
  }

  // One room on several relays at once: publish to all, take the first copy of
  // each event. A relay that is down, slow or refuses us is simply not counted.
  class Room {
    constructor({ relays, room, secretKey, onMessage, onStatus, accept, WebSocketImpl }) {
      this.relays = relays;
      this.room = room;
      this.secretKey = secretKey;
      this.onMessage = onMessage;
      this.onStatus = onStatus ?? (() => {});
      this.accept = accept ?? (() => true); // cheap gate run before any signature check
      this.WS = WebSocketImpl ?? globalThis.WebSocket;
      this.sockets = new Map(); // url -> { ws, open, retry }
      this.seen = new Set();
      this.closed = false;
      this.subId = `ofpro-${Math.random().toString(36).slice(2, 10)}`;
      for (const url of relays) this.connect(url);
    }

    connect(url) {
      if (this.closed) return;
      const state = this.sockets.get(url) ?? { ws: null, open: false, retry: 0, notice: null };
      this.sockets.set(url, state);
      let ws;
      try {
        ws = new this.WS(url);
      } catch {
        return;
      }
      state.ws = ws;
      ws.onopen = () => {
        state.open = true;
        state.retry = 0;
        const since = Math.floor(Date.now() / 1000) - 5;
        ws.send(JSON.stringify(["REQ", this.subId, { kinds: [KIND], "#t": [this.room], since }]));
        this.status();
      };
      ws.onmessage = (e) => {
        let data;
        try {
          data = JSON.parse(typeof e.data === "string" ? e.data : "");
        } catch {
          return;
        }
        if (!Array.isArray(data)) return;
        if (data[0] === "EVENT" && data[1] === this.subId) {
          const ev = data[2];
          if (!ev || this.seen.has(ev.id)) return;
          if (!this.accept()) return;
          const msg = readEvent(ev, this.room);
          if (!msg) return;
          this.remember(msg.id);
          this.onMessage(msg, url);
        } else if (data[0] === "OK" && data[2] === false) {
          state.notice = String(data[3] ?? "rejected").slice(0, 120);
          this.status();
        } else if (data[0] === "NOTICE") {
          state.notice = String(data[1] ?? "").slice(0, 120);
        }
      };
      ws.onclose = () => {
        state.open = false;
        this.status();
        if (this.closed) return;
        // back off: 2s, 4s, 8s ... capped at a minute
        const delay = Math.min(60000, 2000 * 2 ** state.retry++);
        setTimeout(() => this.connect(url), delay);
      };
      ws.onerror = () => {};
    }

    remember(id) {
      this.seen.add(id);
      if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    }

    status() {
      const open = [...this.sockets.entries()].filter(([, s]) => s.open).map(([u]) => u);
      this.onStatus({ open, total: this.relays.length, notices: Object.fromEntries([...this.sockets].filter(([, s]) => s.notice).map(([u, s]) => [u, s.notice])) });
    }

    // Returns how many relays took it.
    publish(type, text, name) {
      const ev = makeEvent(this.secretKey, { room: this.room, type, text, name });
      this.remember(ev.id); // our own echo is not news
      let sent = 0;
      for (const state of this.sockets.values()) {
        if (!state.open) continue;
        try {
          state.ws.send(JSON.stringify(["EVENT", ev]));
          sent++;
        } catch {
          // closing; onclose will reconnect
        }
      }
      return { sent, event: ev };
    }

    close() {
      this.closed = true;
      for (const state of this.sockets.values()) {
        try {
          if (state.open) state.ws.send(JSON.stringify(["CLOSE", this.subId]));
          state.ws?.close();
        } catch {
          // already gone
        }
      }
      this.sockets.clear();
    }
  }

  globalThis.OFR_NOSTR = { KIND, MAX_TEXT, MAX_NAME, roomOf, newSecretKey, publicKeyOf, eventId, makeEvent, readEvent, Room };
})();
