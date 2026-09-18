// Chat between players who have this extension, one room per game. The relay
// sockets and the signing key live in the service worker (background.js); this
// file is the panel, and everything that decides what is shown: muting, flood
// control, the word filter, presence.
//
// What it is careful about:
//   - every string from the network is text, never markup, and is stripped of
//     control / zero-width / bidi-override characters first;
//   - links are never clickable;
//   - names are NOT verified (anyone can type any name), so each one carries a
//     short fingerprint of the sender's key, and no rank badge is ever attached;
//   - it runs during the game too (one room for everyone with the extension in
//     that game, so it is not a private channel); a switch pauses it while you
//     are alive in a running game, and then the panel shows nothing at all;
//   - the page is not trusted either. OpenFront's pages carry third-party ad
//     scripts, which share the DOM with a content script's UI. So the panel lives
//     in a CLOSED shadow root (page scripts cannot read the messages or the input)
//     and only real user input sends or mutes (event.isTrusted) - a script cannot
//     type into the box and press Send for you.
(() => {
  if (globalThis.OFR_CHAT) return;

  const MAX_TEXT = 280;
  const LOG_LIMIT = 200;
  const PRESENCE_TTL = 100000; // a "here" beat arrives every ~45 s
  const FLOOD_WINDOW = 10000;
  const FLOOD_MAX = 6; // messages per sender per window before an automatic mute
  const FLOOD_MUTE = 60000;
  const MUTED_KEY = "chatMuted";
  const OPEN_KEY = "chatOpen";
  const SEEN_NOTE_KEY = "chatNoteSeen";

  // Masked, not blocked: the point is that a slur does not get to land. Kept
  // short on purpose; anything else is what the mute button is for.
  const BAD = [
    "nigger", "nigga", "faggot", "fag", "retard", "retarded", "kike", "spic", "chink", "tranny", "coon",
    "kys", "kill yourself", "rape", "rapist",
    "fuck", "fucking", "fucker", "shit", "bitch", "cunt", "asshole", "whore", "slut", "dick", "pussy",
    "frocio", "negro di merda", "troia", "puttana", "vaffanculo", "stronzo", "coglione", "merda",
  ];
  const BAD_RE = new RegExp(`(^|[^\\p{L}])(${BAD.map((w) => w.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}])`, "giu");

  // Text from the network: drop what can disguise or disrupt a line, keep the rest.
  function clean(value, max) {
    let out = "";
    let marks = 0;
    for (const ch of String(value ?? "")) {
      const c = ch.codePointAt(0);
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) { out += " "; continue; } // controls, newlines
      if (c >= 0x200b && c <= 0x200f) continue; // zero-width, LRM/RLM
      if (c >= 0x202a && c <= 0x202e) continue; // bidi embeddings / overrides
      if (c >= 0x2066 && c <= 0x2069) continue; // bidi isolates
      if (c === 0xfeff || c === 0x00ad) continue; // BOM, soft hyphen
      // zalgo: at most two combining marks in a row (no regex here on purpose -
      // the character class would be invisible characters in this file)
      if (c >= 0x0300 && c <= 0x036f) {
        if (marks >= 2) continue;
        marks++;
      } else marks = 0;
      out += ch;
    }
    return out.replace(/\s+/g, " ").trim().slice(0, max);
  }
  const mask = (text) => text.replace(BAD_RE, (_m, lead, word) => `${lead}${"•".repeat(Math.min(6, word.length))}`);
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const store = {
    async get(key, fallback) {
      try {
        return (await chrome.storage.local.get(key))[key] ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        chrome.storage.local.set({ [key]: value }).catch(() => {});
      } catch {
        // extension reloaded under us
      }
    },
  };

  // ---- state -------------------------------------------------------------------------
  let want = { enabled: false, gameId: null, name: "", mode: "open", filter: true, phase: "lobby" };
  let port = null;
  let joined = null; // game id the worker was told to join
  let pingTimer = null;
  let me = null; // my public key
  let relays = { open: 0, total: 0 };
  let log = []; // { kind: "msg"|"sys", id, pubkey, name, text, at, mine }
  const present = new Map(); // pubkey -> { name, at }
  const recent = new Map(); // pubkey -> timestamps, for flood control
  const tempMuted = new Map(); // pubkey -> until
  let muted = new Set();
  let open = false;
  let unread = 0;
  let noteSeen = true;
  let ui = null;

  // ---- worker link ---------------------------------------------------------------------
  function connect() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: "ofr-chat" });
    } catch {
      port = null; // extension reloaded; the fresh copy of this script takes over
      return;
    }
    port.onMessage.addListener(onWorker);
    port.onDisconnect.addListener(() => {
      port = null;
      joined = null;
      relays = { open: 0, total: relays.total };
      clearInterval(pingTimer);
      pingTimer = null;
      // The worker was restarted (it sleeps when idle). Pick the room up again.
      if (want.enabled && want.gameId) setTimeout(apply, 1500);
      render();
    });
    // A worker with open sockets still gets put to sleep without events of its own.
    pingTimer = setInterval(() => send({ t: "ping" }), 20000);
  }
  function send(msg) {
    try {
      port?.postMessage(msg);
    } catch {
      // disconnected; onDisconnect reconnects
    }
  }
  function disconnect() {
    clearInterval(pingTimer);
    pingTimer = null;
    if (port) {
      send({ t: "leave" });
      try {
        port.disconnect();
      } catch {
        // already gone
      }
    }
    port = null;
    joined = null;
  }

  function isMuted(pubkey) {
    if (muted.has(pubkey)) return true;
    const until = tempMuted.get(pubkey);
    if (until && until > Date.now()) return true;
    if (until) tempMuted.delete(pubkey);
    return false;
  }

  function onWorker(msg) {
    if (msg?.t === "me") me = msg.pubkey;
    else if (msg?.t === "status") relays = { open: msg.open, total: msg.total };
    else if (msg?.t === "here") {
      if (msg.pubkey !== me) present.set(msg.pubkey, { name: clean(msg.name, 32), at: Date.now() });
    } else if (msg?.t === "bye") present.delete(msg.pubkey);
    else if (msg?.t === "msg") {
      if (msg.pubkey === me || isMuted(msg.pubkey)) return;
      const now = Date.now();
      const times = (recent.get(msg.pubkey) ?? []).filter((t) => now - t < FLOOD_WINDOW);
      times.push(now);
      recent.set(msg.pubkey, times);
      if (times.length > FLOOD_MAX) {
        tempMuted.set(msg.pubkey, now + FLOOD_MUTE);
        push({ kind: "sys", text: `${clean(msg.name, 32) || "someone"} was muted for a minute (flooding).`, at: now });
        return;
      }
      const text = clean(msg.text, MAX_TEXT);
      if (!text) return;
      present.set(msg.pubkey, { name: clean(msg.name, 32), at: now });
      push({ kind: "msg", id: msg.id, pubkey: msg.pubkey, name: clean(msg.name, 32) || "anonymous", text, at: msg.at });
      if (!open || want.mode === "paused") unread++;
    } else if (msg?.t === "sent") {
      if (msg.ok) push({ kind: "msg", id: msg.id, pubkey: me, name: want.name, text: clean(msg.text, MAX_TEXT), at: msg.at, mine: true });
      else push({ kind: "sys", text: msg.why === "slow down" ? "Slow down a little." : `Not sent: ${msg.why ?? "unknown"}.`, at: Date.now() });
    } else return;
    render();
  }

  function push(entry) {
    log.push(entry);
    if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
  }

  // ---- reconcile what we want with what is running ---------------------------------------
  function apply() {
    if (!want.enabled || !want.gameId) {
      if (port) disconnect();
      if (ui) {
        ui.host.remove();
        ui = null;
      }
      log = [];
      present.clear();
      unread = 0;
      return;
    }
    connect();
    if (!port) return;
    if (joined !== want.gameId) {
      if (joined) {
        log = [];
        present.clear();
        unread = 0;
      }
      joined = want.gameId;
      send({ t: "join", gameId: want.gameId, name: want.name });
    } else send({ t: "name", name: want.name });
    render();
  }

  // ---- panel ---------------------------------------------------------------------------------
  function build() {
    // The host is all the page can see: an empty <div>. Styles come in through a
    // <link> to the extension's own stylesheet (theme tokens are custom
    // properties on <html>, and those do inherit across the shadow boundary).
    const host = el("div", "ofr-chat-host");
    const shadow = host.attachShadow({ mode: "closed" });
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    try {
      sheet.href = chrome.runtime.getURL("src/content.css");
    } catch {
      // extension reloaded under us; the fresh copy builds its own
    }
    host.style.visibility = "hidden"; // no flash of unstyled panel
    sheet.addEventListener("load", () => (host.style.visibility = ""));
    sheet.addEventListener("error", () => (host.style.visibility = ""));
    const root = el("div", "ofr-chat");
    shadow.append(sheet, root);
    const tab = el("button", "ofr-chat-tab");
    tab.type = "button";
    const panel = el("div", "ofr-chat-panel");
    const head = el("div", "ofr-chat-head");
    const title = el("span", "ofr-chat-title", "Chat");
    const status = el("span", "ofr-chat-status");
    const mutes = el("button", "ofr-chat-mutes");
    mutes.type = "button";
    const reportLink = el("button", "ofr-chat-mutes", "Report");
    reportLink.type = "button";
    reportLink.title = "Report abuse to the extension's maintainers (opens GitHub)";
    reportLink.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      window.open("https://github.com/devdanetra/openfront-pro/issues/new?labels=chat-abuse&title=Chat%20abuse%20report", "_blank", "noopener");
    });
    const fold = el("button", "ofr-chat-fold", "–");
    fold.type = "button";
    fold.title = "Fold";
    head.append(title, status, mutes, reportLink, fold);
    const note = el("div", "ofr-chat-note");
    const list = el("div", "ofr-chat-log");
    list.setAttribute("role", "log");
    list.setAttribute("aria-live", "polite");
    const form = el("form", "ofr-chat-form");
    const input = el("input", "ofr-chat-input");
    input.type = "text";
    input.maxLength = MAX_TEXT;
    input.autocomplete = "off";
    input.placeholder = "Message the lobby…";
    const go = el("button", "ofr-chat-send", "Send");
    go.type = "submit";
    form.append(input, go);
    panel.append(head, note, list, form);
    root.append(tab, panel);

    const setOpen = (next) => {
      open = next;
      store.set(OPEN_KEY, open);
      if (open) unread = 0;
      render();
      if (open && want.mode === "open") input.focus({ preventScroll: true });
    };
    tab.addEventListener("click", () => setOpen(!open));
    fold.addEventListener("click", () => setOpen(false));
    mutes.addEventListener("click", () => {
      muted = new Set();
      tempMuted.clear();
      store.set(MUTED_KEY, []);
      push({ kind: "sys", text: "Mute list cleared.", at: Date.now() });
      render();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!e.isTrusted) return; // a person pressed Enter or clicked Send, or nothing happens
      const text = clean(input.value, MAX_TEXT);
      if (!text || want.mode !== "open") return;
      send({ t: "say", text });
      input.value = "";
    });
    // The game binds hotkeys on the document; typing here must not fire them.
    for (const type of ["keydown", "keyup", "keypress"]) {
      input.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "keydown" && e.key === "Escape") input.blur();
      });
    }
    list.addEventListener("click", (e) => {
      const button = e.target?.closest?.(".ofr-chat-mute");
      if (!button || !e.isTrusted) return;
      const key = button.dataset.pubkey;
      if (!key) return;
      muted.add(key);
      store.set(MUTED_KEY, [...muted].slice(-500));
      log = log.filter((m) => m.pubkey !== key);
      push({ kind: "sys", text: "Muted for this game.", at: Date.now() });
      render();
    });
    note.addEventListener("click", () => {
      noteSeen = true;
      store.set(SEEN_NOTE_KEY, true);
      render();
    });
    return { host, root, tab, panel, title, status, mutes, note, list, form, input, go, setOpen };
  }

  function render() {
    if (!want.enabled || !want.gameId) return;
    if (!ui) {
      ui = build();
      document.body.appendChild(ui.host);
    } else if (!ui.host.isConnected) document.body.appendChild(ui.host);

    const now = Date.now();
    for (const [key, p] of present) if (now - p.at > PRESENCE_TTL || isMuted(key)) present.delete(key);
    const here = present.size + 1;
    const paused = want.mode === "paused";

    ui.root.dataset.open = String(open);
    ui.root.dataset.mode = want.mode;
    ui.tab.textContent = paused ? "Chat ⏸" : unread > 0 ? `Chat · ${unread} new` : here > 1 ? `Chat · ${here}` : "Chat";
    ui.tab.dataset.unread = String(unread > 0 && !paused);
    ui.tab.title = paused ? "Chat is paused while you are playing" : `${here} with OpenFront Pro in this ${want.phase === "lobby" ? "lobby" : "game"}`;
    ui.title.textContent = want.phase === "lobby" ? "Lobby chat" : want.phase === "after" ? "Post-game chat" : "Game chat";
    ui.status.textContent = relays.open ? `${here} here · ${relays.open}/${relays.total} relays` : "connecting…";
    ui.status.dataset.ok = String(relays.open > 0);
    ui.mutes.textContent = muted.size + tempMuted.size ? `${muted.size + tempMuted.size} muted · clear` : "";
    ui.mutes.hidden = muted.size + tempMuted.size === 0;

    if (paused) {
      ui.note.hidden = false;
      ui.note.textContent = "Paused while you are alive in a free-for-all: OpenFront's terms do not allow outside channels for coordinating there. It opens again when you are out or the game ends. (Team games keep it open.)";
      ui.list.replaceChildren();
      ui.list.hidden = true;
      ui.form.hidden = true;
      return;
    }
    ui.list.hidden = false;
    ui.form.hidden = false;
    ui.note.hidden = noteSeen;
    if (!noteSeen) {
      ui.note.textContent =
        "This chat is PUBLIC. Messages travel through public Nostr relays: anyone connected to them can read this room, the relays see your IP address, and nobody can promise they keep nothing. While chat is on, your OpenFront name and clan tag are announced to the room even if you do not type. Names are NOT verified; the letters after a name identify the sender's key for this game. x mutes a sender, Report opens the project's issue page. Click to dismiss.";
    }
    ui.input.placeholder = want.phase === "lobby" ? "Message the lobby…" : "Message the game…";
    ui.input.disabled = relays.open === 0;
    ui.go.disabled = relays.open === 0;

    const stick = ui.list.scrollTop + ui.list.clientHeight >= ui.list.scrollHeight - 24;
    ui.list.replaceChildren(
      ...(log.length
        ? log.map((m) => {
            const row = el("div", `ofr-chat-row ${m.kind === "sys" ? "sys" : m.mine ? "mine" : ""}`);
            if (m.kind === "sys") {
              row.textContent = m.text;
              return row;
            }
            const who = el("span", "ofr-chat-who", m.mine ? "you" : m.name);
            if (!m.mine) who.append(el("span", "ofr-chat-key", ` ${m.pubkey.slice(0, 4)}`));
            row.title = `${clock(m.at)}${m.mine ? "" : " · unverified name"}`;
            row.append(who, el("span", "ofr-chat-text", want.filter ? mask(m.text) : m.text));
            if (!m.mine) {
              const x = el("button", "ofr-chat-mute", "×");
              x.type = "button";
              x.title = "Mute this sender";
              x.dataset.pubkey = m.pubkey;
              row.append(x);
            }
            return row;
          })
        : [el("div", "ofr-chat-row sys", here > 1 ? "Say hi." : "Nobody else with OpenFront Pro is here yet.")]),
    );
    if (stick) ui.list.scrollTop = ui.list.scrollHeight;
  }

  // ---- public ------------------------------------------------------------------------------------
  let loaded = false;
  async function sync(next) {
    want = { ...want, ...next, name: clean(next.name ?? want.name, 32) || "anonymous" };
    if (!loaded) {
      loaded = true;
      muted = new Set(await store.get(MUTED_KEY, []));
      open = (await store.get(OPEN_KEY, false)) === true;
      noteSeen = (await store.get(SEEN_NOTE_KEY, false)) === true;
    }
    apply();
  }

  // The mute list is shared by every OpenFront tab of this browser.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[MUTED_KEY]) return;
      muted = new Set(changes[MUTED_KEY].newValue ?? []);
      log = log.filter((m) => !m.pubkey || !muted.has(m.pubkey));
      if (ui) render();
    });
  } catch {
    // no storage events (test harness)
  }

  // presence ages even when nothing arrives
  setInterval(() => {
    if (ui && want.enabled && want.gameId) render();
  }, 15000);

  // For the dev tools (tools/cdp-chat.mjs), which drive this from the extension's
  // isolated world. The page cannot reach it: globals here are not the page's.
  globalThis.__ofrChatDebug = {
    state: () => ({
      built: !!ui,
      open,
      mode: want.mode,
      phase: want.phase,
      gameId: want.gameId,
      name: want.name,
      relays,
      here: present.size + 1,
      tab: ui?.tab.textContent ?? null,
      rows: ui ? [...ui.list.children].map((r) => r.textContent) : [],
      markup: ui ? ui.list.querySelectorAll("img, b, a, script, iframe").length : 0,
      inputHidden: ui ? ui.form.hidden : null,
      log: log.map((m) => ({ kind: m.kind, name: m.name, text: m.text, mine: !!m.mine, pubkey: m.pubkey?.slice(0, 8) })),
    }),
    say: (text) => send({ t: "say", text: clean(text, MAX_TEXT) }),
    open: () => ui?.setOpen(true),
    mute: (prefix) => {
      const hit = log.find((m) => m.pubkey?.startsWith(prefix));
      if (!hit) return false;
      muted.add(hit.pubkey);
      store.set(MUTED_KEY, [...muted]);
      log = log.filter((m) => m.pubkey !== hit.pubkey);
      render();
      return true;
    },
    unmuteAll: () => {
      muted = new Set();
      tempMuted.clear();
      store.set(MUTED_KEY, []);
      render();
    },
  };

  globalThis.OFR_CHAT = { sync, clean, mask };
})();
