# Privacy policy - OpenFront Pro

_Last updated: 18 September 2026_

OpenFront Pro is an unofficial browser extension for the game at openfront.io.
It is not affiliated with, endorsed by or sponsored by OpenFront.

**The short version:** the developer of this extension runs no server and
receives nothing from you. There are no accounts, no analytics, no advertising
and no tracking. Everything the extension remembers stays in your browser (with
the Steam companion launcher: in a file on your computer, see below).
To do its job it asks two public services about public game data - only after
you agree on the first-run screen - and, only if you separately switch the chat
on and agree to its notice, it sends your chat messages through public relays.

## What the extension sends, to whom, and why

Nothing in this table happens before you press **"I agree"** on the extension's
first-run page (the popup's "Read and turn on" button opens that same page);
closing that page without answering counts as "not now", also after updates.
The one exception is a profile updated from a version older than 5.7.0 - before
this first-run page existed, when lookups were simply on: it keeps them on
until you switch them off. You can withdraw your agreement at any time from the
popup ("Turn rank lookups off", under *About*). While the switch at the top of
the popup (*Everything on / off*) is off, none of this happens on its own
either, and neither does the map preview below.

| What | To | When | Why |
|---|---|---|---|
| **Player names**: the names shown in your lobby or game (including your own OpenFront username), the players named in a game's recap, and any name you type into the dashboard's search or *Compare* box; and **clan tags** seen there or opened in the dashboard | `api.ofstats.io` - an independent, third-party community statistics service for public OpenFront games | while you look at a lobby, the in-game player panels, the dashboard or the recap; your own name also on OpenFront's front page (your stats card, at most once a minute) and again after each game you played (for the rank change). Without any name: the weekly clan table in the dashboard, and a reachability check each time you open the settings | to fetch public player and clan statistics and show ranks |
| **The id of a game whose end screen you saw** (played, spectated or a replay) | OpenFront's own public API (`api.openfront.io`) | when the end-of-game screen appears, then every 5 s for a minute and every 30 s after that while the game stays on screen (up to about 30 minutes), until OpenFront publishes the record; a game whose record was not published yet is asked for again when you next open an openfront.io page, for up to 24 hours. Only while the recap is switched on | to read the public record of that game |

Map images for the lobby preview and its zoom view come from OpenFront's own
asset CDN - the same files the game page itself loads. This does not wait for
the agreement above; switch *Map preview* (or everything) off in the popup to
stop it.

**Chat (off by default; its own "I agree" step, asked again whenever an update
changes what chat sends).** While chat is on and you are
in a lobby or game, the extension sends to four public
[Nostr](https://github.com/nostr-protocol/nips) relays - `relay.primal.net`,
`nos.lol`, `nostr.mom`, `relay.snort.social` - the items below. The exception
is a free-for-all game while you are alive (unless you switched chat on for
that too): the tab then leaves the room altogether, with no relay connection,
and nothing is sent or received until the pause ends.

- the messages you type;
- the name you chat under: **your OpenFront username and clan tag** (or the word
  "Player" in streamer mode). It is announced to the room with a presence signal
  about every 45-60 seconds **even if you do not type**;
- a public key. The key pair is random, made in your browser **for that one
  game**, kept only in memory-backed session storage and discarded when the
  browser closes; it is a pseudonym, not a credential;
- a room tag computed from the game's id. Game ids are public (they are in the
  game's address and OpenFront's lobby list), so anyone, the relays included,
  can tell which game a room belongs to;
- **in team games, with "Encrypted team channel" on (it is by default once chat
  is on):** from the start of the game and about every 45 seconds, with no
  click needed, your key announces which player slot of that game it claims
  (the game's small per-game player number), the keys of teammates you
  verified, and any keys that claimed to be you. When you press **Verify**, the
  handshake messages of that verification name the teammate's key and both
  player slots, with a commitment and random numbers. Your team messages are
  **encrypted** to the keys trusted as your teammates: the ones you verified
  yourself through the game, the ones those teammates verified, the ones *they*
  verified, and so on - a chain of teammates who verified each other, up to
  about eight steps from you. So anyone in that chain can let someone else read
  the channel. Each message goes to at most 12 of them. Only the message text
  is encrypted: that you take part, which slot you claim, who verified whom,
  which keys (by a short prefix) each message is encrypted to, when it was sent
  and roughly how long it is **are** public. In streamer mode too: anyone in
  that game can match your player slot to your name.
  Verification itself happens in the game: you send three emojis to a teammate
  with the game's own emoji menu, and the extension only watches for them.
  **Limitation:** the extension learns who is on your team, and which emojis
  were sent, from OpenFront's page. Any script running in that page - including
  the third-party ad scripts OpenFront loads - could fake that information, get
  a key of its own verified as your teammate once you press Verify on it, and
  then read your team messages. The same is true of the page of any teammate in
  that chain: a script there can get its key verified by that teammate, and so
  trusted by you, without any click of yours. The extension cannot prevent this.

Like any web request, each of these connections reveals your **IP address** to
the service contacted. Those services are operated by third parties under their
own policies; this project does not control them and receives none of that
data. Chat messages are sent as *ephemeral* events carrying a five-minute
expiry, which relays are meant to forward and not store, but the developer
cannot guarantee what a third-party relay, or anyone listening on one, does
with them. **Treat chat as public**: anyone connected to those relays can read
a room, not only users of this extension. Do not share personal information
there. Names in chat are not verified.

The extension reads OpenFront's pages in your browser in order to work: player
names, lobby settings, your username and clan tag from the page's own storage, your per-game
public client id and public player id, and, while a game runs, who owns which
part of the map and every player's name, colour and share of the land (for the
timelapse, when it records), and your team's roster with each player's
per-game number and the emoji messages between you and your teammates (for the
team channel, when it is on). Of these, only what is listed above ever leaves
the browser. It only reads: it never changes the game and sends no input to
it. It never reads OpenFront's secret *persistent id*, your login, cookies or
payment details, and it does not run on, or read, any other website.

## What is stored, and where

Only in your browser, through Chrome's extension storage (for the Steam
companion launcher, see the end of this section):

- **`chrome.storage.sync`** - your settings, your agreement flags, and your
  watchlist of player names. Chrome syncs this through your own Google account
  if you have Chrome sync turned on; the developer has no access to it.
- **`chrome.storage.local`** (this device only) - a cache of looked-up public
  statistics (10 minutes for a hit, 30 for a miss or a failed lookup), today's
  session results, games waiting for their record to be published (at most a
  day), your OpenFront public player id, your chat mute list, the last
  diagnostic report shown in the popup (site name only, no page address; it can
  list the player names from the last scan that had no statistics or whose
  lookup failed) and a few interface preferences.
- **`chrome.storage.session`** (memory only, gone when the browser closes) - the
  per-game chat key, and for the team channel the teammate keys you verified
  in that game, used verification ids, the time of the newest team message
  from each sender and any keys that claimed to be you.
- **Timelapse frames** (small pictures of the map, taken while you play when
  the *Timelapse* switch is on - and only while the recap is on and rank
  lookups are agreed, since the recap is where it is shown) are kept in the
  tab's memory only, never written to storage and never sent anywhere; saving
  a GIF or video writes a file on your computer.

Removing the extension deletes all of it. "Clear cached ranks" in the popup
clears the cache at any time.

**Steam companion launcher.** If you use the launcher (`launcher/`) instead of
the browser extension, what the extension keeps in `chrome.storage.sync` and
`chrome.storage.local` above - except the rank cache - is saved in a plain-text
JSON file, `%APPDATA%\openfront-pro-launcher\storage.json`, on your computer
(with `launcher.lock` next to it while the launcher runs, and a
`storage.json.corrupt-<time>` copy if the file was ever found damaged). The
rank cache stays in the launcher's memory, and so do the chat keys and the
team-channel state, which only the launcher's copy of the extension's worker
can read. The launcher is a portable program: deleting it does not delete that
folder; delete the folder yourself to remove the data.

## What the extension does not do

- No data is sent to the developer. There is no developer server.
- No analytics, telemetry, advertising identifiers or fingerprinting.
- No remote code: everything the extension runs is inside the package, and the
  full source is public.

## Limited use

OpenFront Pro's use of user data complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use),
including the Limited Use requirements. Specifically: data is used only to
provide the features described on this page; it is not sold, and not
transferred to anyone except the services named above, which is necessary for
those features to work; it is not used or transferred for advertising, for
determining creditworthiness or for lending; and no human at or working for
the developer reads it, since none of it ever reaches the developer. (Chat
messages and the name you chat under are, by design, read by other players,
and can be read by anyone connected to the relays.)

## Children

The extension is not directed at children under 13 (OpenFront's own minimum
age). Chat is off by default; when on it masks common slurs, lets you mute
anyone and links to an abuse report page, but it runs on unmoderated
third-party infrastructure.

## Source and contact

The full source is public: <https://github.com/devdanetra/openfront-pro>.
Questions, requests or chat-abuse reports:
<https://github.com/devdanetra/openfront-pro/issues>.

Changes to this policy are published in that repository, with the date above
updated.
