# Privacy policy - OpenFront Pro

_Last updated: 18 September 2026_

OpenFront Pro is an unofficial browser extension for the game at openfront.io.
It is not affiliated with, endorsed by or sponsored by OpenFront.

**The short version:** the developer of this extension runs no server and
receives nothing from you. There are no accounts, no analytics, no advertising
and no tracking. Everything the extension remembers stays in your browser.
To do its job it asks two public services about public game data - only after
you agree on the first-run screen - and, only if you separately switch the chat
on and agree to its notice, it sends your chat messages through public relays.

## What the extension sends, to whom, and why

Nothing in this table happens before you press **"I agree"** on the extension's
first-run page (or the same switch in its popup). You can withdraw that at any
time from the popup ("Turn rank lookups off").

| What | To | When | Why |
|---|---|---|---|
| **Player names shown in your lobby or game, including your own OpenFront username**, and clan tags seen there | `api.ofstats.io` - an independent, third-party community statistics service for public OpenFront games | while you look at a lobby, the in-game player panels, the dashboard or the recap | to fetch each player's public game statistics and show a rank |
| **The id of a game you just finished** | OpenFront's own public API (`api.openfront.io`) | when the end-of-game screen appears and the recap is enabled | to read the public record of that game |
| Map image files for the lobby's map | OpenFront's own asset CDN, the same files the game page itself loads | when the map preview or zoom view is used | to draw the map preview |

**Chat (off by default; its own "I agree" step).** While chat is on and you are
in a lobby or game, the extension sends to four public
[Nostr](https://github.com/nostr-protocol/nips) relays - `relay.primal.net`,
`nos.lol`, `nostr.mom`, `relay.snort.social`:

- the messages you type;
- the name you chat under: **your OpenFront username and clan tag** (or the word
  "Player" in streamer mode). It is announced to the room with a presence signal
  about every 45 seconds **even if you do not type**;
- a public key. The key pair is random, made in your browser **for that one
  game**, kept only in memory-backed session storage and discarded when the
  browser closes; it is a pseudonym, not a credential;
- a room tag: a one-way hash of the game's id.

Like any web request, each of these connections reveals your **IP address** to
the service contacted. Those services are operated by third parties under their
own policies; this project does not control them and receives none of that
data. Chat messages are sent as *ephemeral* events carrying a five-minute
expiry, which relays are meant to forward and not store, but the developer
cannot guarantee what a third-party relay, or anyone listening on one, does
with them. **Treat chat as public**: anyone connected to those relays can read
a room, not only users of this extension. Do not share personal information
there. Names in chat are not verified.

The extension reads OpenFront's pages in your browser (player names, lobby
settings, your username from the page's own storage, your per-game public
client id and public player id) in order to work. It never reads OpenFront's
secret *persistent id*, your login, cookies or payment details, and it does not
run on, or read, any other website.

## What is stored, and where

Only in your browser, through Chrome's extension storage:

- **`chrome.storage.sync`** - your settings, your agreement flags, and your
  watchlist of player names. Chrome syncs this through your own Google account
  if you have Chrome sync turned on; the developer has no access to it.
- **`chrome.storage.local`** (this device only) - a cache of looked-up public
  statistics (10 minutes for a hit, 30 for a miss), today's session results,
  games waiting for their record to be published (at most a day), your OpenFront
  public player id, your chat mute list, the last diagnostic line shown in the
  popup (site name only, no page address) and a few interface preferences.
- **`chrome.storage.session`** (memory only, gone when the browser closes) - the
  per-game chat key.

Removing the extension deletes all of it. "Clear cached ranks" in the popup
clears the cache at any time.

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
determining creditworthiness or for lending; and no human - including the
developer - reads it, since none of it ever reaches the developer.

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
