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
//     that game, so it is not a private channel); while you are alive in a
//     free-for-all it pauses (unless switched on there too): the tab leaves the
//     room altogether - nothing sent or received - and the panel shows nothing;
//   - team games add a second tab: the message text is encrypted to teammates
//     who were verified THROUGH THE GAME, by the user or through a chain of
//     teammates who verified each other (docs/TEAM-CHAT.md; src/team.js in the service
//     worker). This file shows its state and forwards the clicks; names there
//     come from the game, never from the network;
//   - the page is not trusted either. OpenFront's pages carry third-party ad
//     scripts, which share the DOM with a content script's UI. So the panel lives
//     in a CLOSED shadow root (page scripts cannot read the messages or the input)
//     and only real user input sends or mutes (event.isTrusted) - a script cannot
//     type into the box and press Send for you.
(() => {
  if (globalThis.OFR_CHAT) return;

  const MAX_TEXT = 280;
  const LOG_LIMIT = 200;
  const PRESENCE_TTL = 100000; // a "here" beat arrives every 45-60 s
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
  let want = { enabled: false, gameId: null, name: "", mode: "open", filter: true, phase: "lobby", team: false, teamGame: false };
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
  // team channel (team games only)
  let view = "all"; // which tab is showing: "all" | "team"
  const drafts = { all: "", team: "" }; // what was typed in each tab: text meant for the team never lands in the public box
  let lastGame = null; // the game the panel is about; unlike `joined`, a worker restart does not clear it
  let teamSent = null; // what the worker was last told about the team channel (on/off)
  let lastTeamKey = null;
  const teamRefs = { cancel: null, status: null };
  let teamState = null; // the worker's snapshot (team.js snapshot())
  let teamLog = []; // { kind, name, text, at, mine }
  let teamUnread = 0;
  let teamFeeding = false;

  // ---- worker link ---------------------------------------------------------------------
  function connect() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: "ofr-chat" });
    } catch {
      port = null; // extension reloaded; the fresh copy of this script takes over
      return;
    }
    teamSent = null;
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
    } else if (msg?.t === "team") {
      if (!want.team) return;
      const was = teamState;
      teamState = msg.state && typeof msg.state === "object" ? msg.state : null;
      // something needs the user: a teammate asked, or emojis are waiting to be sent
      const asks = (st) => (st?.mates ?? []).some((m) => (m.keys ?? []).some((k) => k.asks));
      if (view !== "team" || !open) if ((asks(teamState) && !asks(was)) || (teamState?.pairing?.emojis && !was?.pairing?.emojis)) teamUnread++;
    } else if (msg?.t === "team-msg") {
      if (!want.team) return;
      const text = clean(msg.text, MAX_TEXT);
      if (!text) return;
      pushTeam({ kind: "msg", name: clean(msg.name, 40) || "teammate", text, at: msg.at });
      if (!open || view !== "team") teamUnread++;
    } else if (msg?.t === "team-sent") {
      if (msg.ok) pushTeam({ kind: "msg", name: "you", text: clean(msg.text, MAX_TEXT), at: msg.at, mine: true, to: msg.to, skipped: msg.skipped });
      else pushTeam({ kind: "sys", text: msg.why === "slow down" ? "Slow down a little." : `Not sent: ${msg.why ?? "unknown"}.`, at: Date.now() });
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
  function pushTeam(entry) {
    teamLog.push(entry);
    if (teamLog.length > LOG_LIMIT) teamLog = teamLog.slice(-LOG_LIMIT);
  }

  // The page-world probe reports my team's roster and the emojis teammates send each
  // other (page-probe.js) while data-ofr-team is "on"; the worker decides what they
  // prove. Any script in the top page (OpenFront's own code, or the third-party ad
  // scripts it loads) can post these messages too: a forged roster or emoji run
  // makes a key of its choosing look verified once the user presses Verify on it,
  // and that key then receives team messages. Nothing here can tell a fake apart;
  // docs/TEAM-CHAT.md lists it as out of scope. Shapes are checked in team.js.
  // The attribute carries a time and is refreshed while the channel is on: a copy of
  // this script orphaned by an extension reload cannot switch it off, so the probe
  // stops by itself once it is stale.
  function feedTeam(on) {
    if (on) document.documentElement.dataset.ofrTeam = `on:${Date.now()}`;
    else delete document.documentElement.dataset.ofrTeam;
    if (on === teamFeeding) return;
    teamFeeding = on;
    if (!on) {
      teamState = null;
      teamLog = [];
      teamUnread = 0;
      showView("all");
      drafts.team = "";
    }
  }
  function showView(next) {
    if (next === view) return;
    if (ui) {
      drafts[view] = ui.input.value;
      ui.input.value = drafts[next] ?? "";
    }
    view = next;
  }
  globalThis.window?.addEventListener?.("message", (e) => {
    if (e.source !== window || !teamFeeding || !port) return;
    const m = e.data;
    if (!m || m.__ofr !== "team-state" || m.gameId !== joined || typeof m.gameId !== "string") return;
    send({ t: "team-feed", data: { gameId: m.gameId, tick: m.tick, spawn: m.spawn === true, catchingUp: m.catchingUp === true, roster: Array.isArray(m.roster) ? m.roster.slice(0, 128) : null, emojis: Array.isArray(m.emojis) ? m.emojis.slice(0, 32) : [] } });
  });

  // ---- reconcile what we want with what is running ---------------------------------------
  function apply() {
    if (!want.enabled || !want.gameId) {
      feedTeam(false);
      if (port) disconnect();
      if (ui) {
        ui.host.remove();
        ui = null;
      }
      log = [];
      present.clear();
      unread = 0;
      lastGame = null;
      drafts.all = drafts.team = "";
      return;
    }
    if (lastGame !== want.gameId) {
      // another game: another room, another team, another channel
      feedTeam(false);
      if (lastGame) {
        log = [];
        present.clear();
        unread = 0;
      }
      lastGame = want.gameId;
    }
    if (want.mode === "paused") {
      // Paused (alive in a free-for-all): out of the room altogether - no relay
      // connection, nothing sent, nothing received. It rejoins when it opens again.
      feedTeam(false);
      if (port) disconnect();
      relays = { open: 0, total: relays.total };
      render();
      return;
    }
    connect();
    if (!port) return;
    if (joined !== want.gameId) {
      joined = want.gameId;
      teamSent = null;
      send({ t: "join", gameId: want.gameId, name: want.name });
    } else send({ t: "name", name: want.name });
    const wantTeam = want.team === true;
    feedTeam(wantTeam);
    if (teamSent !== wantTeam) {
      teamSent = wantTeam;
      send({ t: "team", on: wantTeam });
    }
    render();
  }

  // ---- panel ---------------------------------------------------------------------------------
  function build() {
    // The host is all the page can see: an empty <div>. Styles come in through a
    // <link> to the extension's own stylesheet (theme tokens are custom
    // properties on <html>, and those do inherit across the shadow boundary).
    const host = el("div", "ofr-chat-host");
    const shadow = host.attachShadow({ mode: "closed" });
    let sheet = document.createElement("link");
    if (typeof globalThis.__ofrCss === "string") {
      // companion launcher: the stylesheet text is handed over directly
      sheet = document.createElement("style");
      sheet.textContent = globalThis.__ofrCss;
    } else {
      sheet.rel = "stylesheet";
      try {
        sheet.href = chrome.runtime.getURL("src/content.css");
      } catch {
        // extension reloaded under us; the fresh copy builds its own
      }
      host.style.visibility = "hidden"; // no flash of unstyled panel
      sheet.addEventListener("load", () => (host.style.visibility = ""));
      sheet.addEventListener("error", () => (host.style.visibility = ""));
    }
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
    const fold = el("button", "ofr-btn ofr-btn-icon ofr-chat-fold", "−");
    fold.type = "button";
    fold.title = "Fold chat";
    fold.setAttribute("aria-label", "Fold chat");
    head.append(title, status, mutes, fold);
    const tabs = el("div", "ofr-chat-tabs ofr-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Chat rooms");
    const tabAll = el("button", "ofr-tab ofr-chat-view", "Everyone");
    const tabTeam = el("button", "ofr-tab ofr-chat-view", "Team");
    tabAll.type = tabTeam.type = "button";
    for (const t of [tabAll, tabTeam]) t.setAttribute("role", "tab");
    tabs.append(tabAll, tabTeam);
    const teamBox = el("div", "ofr-team");
    const note = el("div", "ofr-chat-note");
    const list = el("div", "ofr-chat-log");
    list.setAttribute("role", "log");
    list.setAttribute("aria-live", "polite");
    const form = el("form", "ofr-chat-form");
    const input = el("input", "ofr-input ofr-chat-input");
    input.type = "text";
    input.maxLength = MAX_TEXT;
    input.autocomplete = "off";
    input.placeholder = "Message the lobby…";
    input.setAttribute("aria-label", "Message");
    const go = el("button", "ofr-btn ofr-chat-send", "Send");
    go.type = "submit";
    form.append(input, go);
    panel.append(head, tabs, note, teamBox, list, form);
    panel.classList.add("ofr-float");
    root.append(tab, panel);

    const setView = (next) => {
      showView(next);
      if (view === "team") teamUnread = 0;
      else unread = 0;
      render();
    };
    tabAll.addEventListener("click", () => setView("all"));
    tabTeam.addEventListener("click", () => setView("team"));
    // Left / Right move between the two tabs, like any tab strip.
    tabs.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopPropagation(); // not a game hotkey
      const next = view === "team" ? tabAll : tabTeam;
      next.focus();
      setView(next === tabTeam ? "team" : "all");
    });
    // Verify / Cancel: real clicks only. A pairing makes the user act in the game,
    // so a script on the page must not be able to start one.
    teamBox.addEventListener("click", (e) => {
      const button = e.target?.closest?.("button[data-act]");
      if (!button || !e.isTrusted) return;
      if (button.dataset.act === "verify" && /^[0-9a-f]{64}$/.test(button.dataset.key ?? "")) send({ t: "team-verify", key: button.dataset.key });
      else if (button.dataset.act === "cancel") send({ t: "team-cancel" });
    });

    const setOpen = (next) => {
      open = next;
      store.set(OPEN_KEY, open);
      if (open && view === "team") teamUnread = 0;
      else if (open) unread = 0;
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
      if (view === "team") {
        if (!want.team) return; // never let team text go out in the public room
        send({ t: "team-say", text });
      } else send({ t: "say", text });
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
    // "Got it" is the only way to dismiss the notice (a stray click on the text
    // must not). The button is rebuilt with the note, so the listener is here.
    note.addEventListener("click", (e) => {
      if (!e.target?.closest?.("[data-act='got-it']")) return;
      noteSeen = true;
      store.set(SEEN_NOTE_KEY, true);
      render();
    });
    lastTeamKey = null;
    return { host, root, tab, panel, title, status, mutes, note, list, form, input, go, setOpen, tabs, tabAll, tabTeam, teamBox };
  }

  // In a team game, emojis in the PUBLIC tab could be someone talking a player into
  // "just send these three" (that is how a stranger would get a key verified as your
  // teammate) - in one line, spread over several, or inside a name. So in a team
  // game (your own team channel on or not) the public tab shows no emoji from
  // anyone else at all.
  const PICTO = /\p{Extended_Pictographic}/gu;
  const noEmoji = (text) => String(text).replace(PICTO, "▫");

  // Two status lines under the emojis: where you are, and where your teammate is.
  function pairStatus(p) {
    const peer = p.peerName || "your teammate";
    const mine = p.mine >= 3 ? "You 3/3 ✓" : p.wait > 0 && p.mine > 0 ? `You ${p.mine}/3 · next in ${p.wait} s` : `You ${p.mine}/3`;
    return [el("div", null, mine), el("div", null, `${peer}: ${p.theirs ? "done" : "waiting"}`)];
  }
  function cancelText(p) {
    const left = Math.max(0, Math.round((p.endsAt - Date.now()) / 1000));
    return `Cancel (${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")})`;
  }
  function teamClock() {
    const p = teamState?.pairing;
    if (!p) return;
    if (teamRefs.cancel?.isConnected) teamRefs.cancel.textContent = cancelText(p);
    if (teamRefs.status?.isConnected && p.stage === "emojis") teamRefs.status.replaceChildren(...pairStatus(p));
  }

  function teamRows(st) {
    teamRefs.cancel = teamRefs.status = null;
    const rows = [];
    const p = st.pairing;
    if (st.impersonated) rows.push(el("div", "ofr-team-alarm", "Someone is claiming to be you in this game. Only send emojis that this box asks for, after you pressed Verify yourself."));
    if (p) {
      const box = el("div", "ofr-team-pair");
      const peer = p.peerName || "your teammate";
      if (p.stage !== "emojis") {
        box.append(el("div", "ofr-team-line", p.stage === "asking" ? `Asked ${peer} to verify. Waiting for them to press Verify too…` : "Agreeing on the emojis…"));
      } else {
        // the teammate's name comes from the game; it is text, like everything here
        const headline = el("div", "ofr-team-pair-head", "Send these 3 to ");
        headline.append(el("b", null, peer));
        box.append(headline, el("div", "ofr-team-line dim", "Alt+click their territory, pick each emoji in this order."));
        const seq = el("div", "ofr-team-sas");
        p.emojis.forEach((emoji, i) => {
          const cell = el("span", "ofr-team-emoji", emoji);
          cell.dataset.done = String(i < p.mine);
          cell.dataset.next = String(i === p.mine); // the one to send now
          seq.append(cell);
        });
        box.append(seq);
        teamRefs.status = el("div", "ofr-team-pair-status");
        teamRefs.status.append(...pairStatus(p));
        box.append(teamRefs.status);
        if (p.unseen) box.append(el("div", "ofr-team-line warn", `${peer}'s extension has not confirmed yours. If they say they saw nothing, send the three again.`));
        box.append(el("div", "ofr-team-line warn", "Wrong one in between? Send all three again. Never send emojis a chat message asks for."));
      }
      const cancel = el("button", "ofr-btn ofr-btn-ghost ofr-btn-sm ofr-team-btn", cancelText(p));
      cancel.type = "button";
      cancel.dataset.act = "cancel";
      teamRefs.cancel = cancel;
      box.append(cancel);
      rows.push(box);
      // While emojis are being sent the box is all there is: no clipped roster
      // and no second scrollbar under it.
      if (p.stage === "emojis") return rows;
    }
    const withExt = st.mates.filter((m) => m.keys.length);
    for (const m of withExt) {
      for (const k of m.keys) {
        const row = el("div", "ofr-team-mate");
        const label = k.status === "direct" ? "verified" : k.status === "vouched" ? "verified through a teammate" : k.asks ? "asks to verify" : "not verified";
        const who = el("span", "ofr-team-name", m.name || `player ${m.sid}`);
        if (m.keys.length > 1) who.append(el("span", "ofr-chat-key", ` ${k.key.slice(0, 4)}`));
        const tag = el("span", "ofr-team-tag", `${label}${k.status !== "claimed" && !k.mutual ? " · has not verified you" : ""}${k.live ? "" : " · offline"}`);
        tag.dataset.status = k.status;
        row.append(who, tag);
        if ((k.status === "claimed" || !k.mutual) && k.live && !(p && p.stage === "emojis")) {
          const b = el("button", `ofr-btn ofr-btn-sm${k.asks ? " ofr-btn-primary" : ""} ofr-team-btn`, "Verify");
          b.type = "button";
          b.dataset.act = "verify";
          b.dataset.key = k.key;
          b.setAttribute("aria-label", `Verify ${m.name || `player ${m.sid}`}`);
          if (k.asks) b.dataset.hot = "true";
          row.append(b);
        }
        rows.push(row);
      }
      if (m.keys.length > 1) rows.push(el("div", "ofr-team-line warn", `${m.keys.length} different senders say they are ${m.name}. At most one is: verifying shows which.`));
    }
    const without = st.mates.length - withExt.length;
    if (!withExt.length) rows.push(el("div", "ofr-team-line dim", st.mates.length ? "None of your teammates has OpenFront Pro with team chat on (yet)." : "No human teammates in this game."));
    else if (without > 0) rows.push(el("div", "ofr-team-line dim", `${without} more teammate${without === 1 ? "" : "s"} without the extension.`));
    if (st.spawn) rows.push(el("div", "ofr-team-line dim", "Verifying starts after the spawn phase (the game sends no emojis before)."));
    if (st.note) rows.push(el("div", "ofr-team-line warn", st.note));
    return rows;
  }

  // The notice above the log: the public-chat warning (dismissed with "Got it"
  // only) or the paused explanation. Rebuilt only when it changes kind.
  const NOTE_PUBLIC =
    "Messages go through public Nostr relays: anyone can read them, and relays see your IP. Your name and clan tag are announced while chat is on. Names aren't verified; the 4 letters after a name identify the sender. Hover a message and press × to mute.";
  const NOTE_PAUSED =
    "Paused while you're alive in a free-for-all: OpenFront's rules don't allow outside coordination. It reopens when you're out or the game ends.";
  function setNote(kind) {
    if (ui.note.dataset.kind === kind) return;
    ui.note.dataset.kind = kind;
    if (kind === "paused") {
      ui.note.replaceChildren(document.createTextNode(NOTE_PAUSED));
      return;
    }
    const flag = el("span", "ofr-chip ofr-chat-flag", "PUBLIC");
    flag.dataset.tone = "warn";
    const actions = el("div", "ofr-chat-note-actions");
    const ok = el("button", "ofr-btn ofr-btn-ghost ofr-btn-sm", "Got it");
    ok.type = "button";
    ok.dataset.act = "got-it";
    actions.append(ok);
    ui.note.replaceChildren(flag, document.createTextNode(NOTE_PUBLIC), actions);
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
    const teamOn = want.team === true && !paused;
    if (!teamOn && view === "team") showView("all");
    const inTeam = view === "team";
    const news = unread + teamUnread;

    ui.root.dataset.open = String(open);
    ui.root.dataset.mode = want.mode;
    ui.root.dataset.view = view;
    ui.tab.textContent = paused ? "Chat ⏸" : news > 0 ? `Chat · ${news} new` : here > 1 ? `Chat · ${here}` : "Chat";
    ui.tab.dataset.unread = String(news > 0 && !paused);
    ui.tab.title = paused ? "Chat is paused while you are playing" : `${here} with OpenFront Pro in this ${want.phase === "lobby" ? "lobby" : "game"}`;
    ui.title.textContent = want.phase === "lobby" ? "Lobby chat" : want.phase === "after" ? "Post-game chat" : "Game chat";
    ui.status.textContent = paused ? "paused while you play" : relays.open ? `${here} here · ${relays.open}/${relays.total} relays` : "connecting…";
    ui.status.dataset.ok = paused ? "paused" : String(relays.open > 0);
    ui.mutes.textContent = muted.size + tempMuted.size ? `${muted.size + tempMuted.size} muted · clear` : "";
    ui.mutes.hidden = muted.size + tempMuted.size === 0 || inTeam;

    ui.tabs.hidden = !teamOn;
    for (const [t, on] of [[ui.tabAll, !inTeam], [ui.tabTeam, inTeam]]) {
      t.dataset.on = String(on);
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    // unread: the dot (data-unread); a count only for how many teammates are reachable
    ui.tabAll.textContent = "Everyone";
    ui.tabAll.dataset.unread = String(unread > 0 && inTeam);
    const reach = teamState?.reachable ?? 0;
    ui.tabTeam.textContent = `Team${reach > 0 ? " (encrypted)" : ""}`;
    if (reach > 0) ui.tabTeam.append(el("span", "ofr-tab-count", String(reach)));
    ui.tabTeam.title = reach > 0 ? `Encrypted to ${reach} verified teammate${reach === 1 ? "" : "s"}` : "Team chat, encrypted to verified teammates";
    ui.tabTeam.dataset.unread = String(teamUnread > 0 && !inTeam);

    if (paused) {
      ui.note.hidden = false;
      setNote("paused");
      ui.teamBox.hidden = true;
      ui.list.replaceChildren();
      ui.list.hidden = true;
      ui.form.hidden = true;
      return;
    }
    ui.list.hidden = false;
    ui.form.hidden = false;
    ui.teamBox.hidden = !inTeam;
    if (inTeam) {
      ui.note.hidden = true;
      const st = teamState;
      // Rebuilt only when something in it changes (a click that lands while the
      // buttons are replaced is lost); the countdown and the cooldown tick in place.
      const key = JSON.stringify(st ? { ...st, pairing: st.pairing ? { ...st.pairing, wait: 0 } : null } : null);
      if (key !== lastTeamKey) {
        lastTeamKey = key;
        ui.teamBox.replaceChildren(...(st?.ready ? teamRows(st) : [el("div", "ofr-team-line dim", "Waiting for the game… The team channel opens once you are in a running team game.")]));
      }
      teamClock();
      const can = relays.open > 0 && (st?.trusted ?? 0) > 0;
      ui.input.placeholder = can ? "Message verified teammates…" : "Verify a teammate to write here";
      ui.input.disabled = !can;
      ui.go.disabled = !can;
    } else {
      ui.note.hidden = noteSeen;
      if (!noteSeen) setNote("public");
      ui.input.placeholder = want.phase === "lobby" ? "Message the lobby…" : "Message the game…";
      ui.input.disabled = relays.open === 0;
      ui.go.disabled = relays.open === 0;
    }

    const shown = inTeam ? teamLog : log;
    const stick = ui.list.scrollTop + ui.list.clientHeight >= ui.list.scrollHeight - 24;
    ui.list.replaceChildren(
      ...(shown.length
        ? shown.map((m) => {
            const row = el("div", `ofr-chat-row ${m.kind === "sys" ? "sys" : m.mine ? "mine" : ""}`);
            const hide = !inTeam && want.teamGame === true && !m.mine; // see noEmoji
            if (m.kind === "sys") {
              row.textContent = hide ? noEmoji(m.text) : m.text;
              return row;
            }
            const who = el("span", "ofr-chat-who", m.mine ? "you" : hide ? noEmoji(m.name) : m.name);
            if (inTeam) {
              row.title = `${clock(m.at)}${m.mine ? ` · encrypted to ${m.to} verified teammate${m.to === 1 ? "" : "s"}${m.skipped ? ` (${m.skipped} more not reached)` : ""}` : " · verified teammate (name from the game)"}`;
              row.append(who, el("span", "ofr-chat-text", want.filter ? mask(m.text) : m.text));
              return row;
            }
            if (!m.mine) who.append(el("span", "ofr-chat-key", ` ${m.pubkey.slice(0, 4)}`));
            row.title = `${clock(m.at)}${m.mine ? "" : " · unverified name"}`;
            const text = want.filter ? mask(m.text) : m.text;
            row.append(who, el("span", "ofr-chat-text", hide ? noEmoji(text) : text));
            if (!m.mine) {
              const x = el("button", "ofr-chat-mute", "×");
              x.type = "button";
              x.title = "Mute this sender";
              x.setAttribute("aria-label", `Mute ${m.name}`); // an attribute: text, never markup
              x.dataset.pubkey = m.pubkey;
              row.append(x);
            }
            return row;
          })
        : [el("div", "ofr-chat-row sys", inTeam ? ((teamState?.trusted ?? 0) > 0 ? "Encrypted to your verified teammates. Say hi." : "Messages here are encrypted to teammates verified through the game: by you, or through a chain of teammates who verified each other.") : here > 1 ? "Say hi." : "Nobody else with OpenFront Pro is here yet.")]),
    );
    if (stick) ui.list.scrollTop = ui.list.scrollHeight;
  }

  // ---- public ------------------------------------------------------------------------------------
  let loaded = false;
  let demo = false; // tools/cdp-teamui.mjs froze the panel on a made-up state
  async function sync(next) {
    if (demo) return;
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
  // ...a running verification shows a countdown, and the probe's switch is kept fresh
  setInterval(() => {
    if (ui && open && view === "team") teamClock();
  }, 1000);
  setInterval(() => {
    let live = false;
    try {
      live = !!chrome.runtime?.id;
    } catch {
      // orphaned by an extension reload
    }
    if (teamFeeding && live) document.documentElement.dataset.ofrTeam = `on:${Date.now()}`;
  }, 10000);

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
      view,
      team: teamState,
      teamRows: ui ? [...ui.teamBox.children].map((r) => r.textContent) : [],
      teamLog: teamLog.map((m) => ({ kind: m.kind, name: m.name, text: m.text, mine: !!m.mine })),
      log: log.map((m) => ({ kind: m.kind, name: m.name, text: m.text, mine: !!m.mine, pubkey: m.pubkey?.slice(0, 8) })),
    }),
    say: (text) => send({ t: "say", text: clean(text, MAX_TEXT) }),
    // Shows the Team tab on a made-up state, without a game or a relay (screenshots).
    demoTeam: (state, messages = []) => {
      demo = true;
      want = { ...want, enabled: true, gameId: "DEMO", team: true, mode: "open", phase: "game", name: "you" };
      relays = { open: 3, total: 4 };
      teamState = state;
      teamLog = messages;
      view = "team";
      open = true;
      render();
    },
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
