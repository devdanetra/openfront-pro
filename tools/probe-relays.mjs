// Which public Nostr relays will carry the chat? For each candidate: one client
// subscribes to a throw-away room, a second client (another key) publishes one
// ephemeral event there, and we time how long it takes to arrive - or note why it
// did not (auth required, paid, proof-of-work, ephemeral kinds dropped...).
//   node tools/probe-relays.mjs [wss://relay ...]
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await import(pathToFileURL(path.join(ROOT, "src/vendor/nostr-crypto.js")).href);
await import(pathToFileURL(path.join(ROOT, "src/nostr.js")).href);
const N = globalThis.OFR_NOSTR;

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.primal.net",
      "wss://relay.nostr.band",
      "wss://nostr.mom",
      "wss://relay.snort.social",
      "wss://offchain.pub",
      "wss://nostr-pub.wellorder.net",
      "wss://relay.nostr.net",
      "wss://nostr.wine",
      "wss://relay.mostr.pub",
      "wss://nostr.oxtr.dev",
      "wss://relay.nostr.bg",
      "wss://nostr.fmt.wiz.biz",
      "wss://relay.0xchat.com",
    ];

async function probe(url) {
  const room = N.roomOf(`probe-${Math.random().toString(36).slice(2)}`);
  const result = { url, connected: false, delivered: false, ms: null, notice: null };
  const started = Date.now();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000);
    let sentAt = 0;
    const listener = new N.Room({
      relays: [url],
      room,
      secretKey: N.newSecretKey(),
      onMessage: (msg) => {
        if (msg.text === "probe") {
          result.delivered = true;
          result.ms = Date.now() - sentAt;
          clearTimeout(timer);
          resolve();
        }
      },
      onStatus: (s) => {
        if (s.open.length && !result.connected) {
          result.connected = true;
          // the subscription has to be in place before the event is sent
          setTimeout(() => {
            const sender = new N.Room({
              relays: [url],
              room,
              secretKey: N.newSecretKey(),
              onMessage: () => {},
              onStatus: (st) => {
                if (st.notices[url]) result.notice = st.notices[url];
                if (st.open.length && !sentAt) {
                  sentAt = Date.now();
                  sender.publish("msg", "probe", "probe");
                  setTimeout(() => sender.close(), 6000);
                }
              },
            });
          }, 400);
        }
      },
    });
    setTimeout(() => listener.close(), 8200);
  });
  result.connectMs = result.connected ? Date.now() - started : null;
  return result;
}

const results = await Promise.all(CANDIDATES.map(probe));
for (const r of results.sort((a, b) => Number(b.delivered) - Number(a.delivered) || (a.ms ?? 1e9) - (b.ms ?? 1e9))) {
  console.log(`${r.delivered ? "OK  " : r.connected ? "DROP" : "DOWN"} ${r.url.padEnd(34)} ${r.delivered ? `${r.ms} ms` : ""}${r.notice ? `  (${r.notice})` : ""}`);
}
setTimeout(() => process.exit(0), 500);
