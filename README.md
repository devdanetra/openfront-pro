# OpenFront Pro

> **Unofficial.** Not affiliated with, endorsed by, or connected to OpenFront or its developers.

Chrome/Edge extension (Manifest V3) that shows each player's world ranking next
to their name in [OpenFront](https://openfront.io) — in the lobby list, and on
the hover panel during a game.

```
[LUX] TeNa  #87 · Gold      Firedan  #1 · Diamond      [DFY] Rage  #2 · Diamond
```

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open <https://openfront.io> and enter a lobby.

Click the toolbar icon to toggle what the badge shows (global position, tier,
RR) or to clear the rank cache.

## First run, consent and permissions

On install a page opens that says, in plain words, what leaves the browser:
player names from your lobby (yours included) go to `api.ofstats.io`, a
third-party community statistics service, and a finished game's id goes to
OpenFront's public API. **Nothing is looked up until you press "I agree"**; the
worker refuses lookup messages until then (`dataConsent`), and the popup can
switch it off again. Themes and layouts work without it. Chat has its own,
separate agreement. See [PRIVACY.md](PRIVACY.md).

Permissions are the minimum: `storage`, `scripting` (to inject the packaged
scripts into tabs already open at install / update), `notifications` (watchlist
alert), and host access to openfront.io and `api.ofstats.io`. `clipboardWrite`
is *optional* and only requested if you tick "copy the scouting report by
itself". The extension reads the game's pages and never sends a game action.

## Where the ranking comes from

[ofstats.io](https://ofstats.io) aggregates every public OpenFront game by
username, which is the only key the lobby gives us.

`GET https://api.ofstats.io/players/<name>` returns per-map rows with `wins` and
`expectedWins` — and expectedWins already accounts for how many players were in
each lobby. So:

```
skill = (wins + K) / (expectedWins + K)      K = 3
```

is "how many times more often this player wins than an average player would in
the same lobbies", on one scale for a 60-player free-for-all and a 1v1 alike.
K shrinks the figure toward parity so a 4-game hot streak cannot outrank a
1000-game veteran.

That ratio is converted to a percentile through a table calibrated against real
lobby data (`tools/calibrate.mjs`), and shown as `Top 23%`.

**Why not ofstats' own `winsTop`?** It only has the buckets 0.01 / 0.1 / 1 / 5,
so most of a lobby came out as "Top 1%". Measured on 94 rated players sampled
from live public games, the current table gives **58 distinct labels, with the
most common one on 7 of 94 players**, spread across bands:

| Band | Percentile | Colour | Share of sample |
|---|---|---|---|
| elite | Top 5% | red | 3 |
| strong | Top 6–15% | amber | 8 |
| good | Top 16–35% | green | 12 |
| average | Top 36–60% | blue | 30 |
| low | below | grey | 41 |

Players with fewer than 3 rated games fall back to `12.5% WR · 48`. The call is
made from the service worker, because ofstats sends no
`Access-Control-Allow-Origin` and a page-context fetch is blocked.

## Why a name may have no rank

Rather than leaving a blank, the extension marks the reason (turn this off in
the popup):

| Badge | Meaning |
|---|---|
| `hidden` | OpenFront's **Hidden Names** setting is on, so every *other* player's name is replaced on your screen with a tribe name. Nothing real is left to look up — this is the usual reason for "I only see myself". Turn it off in OpenFront settings. |
| `guest` | A generated `Anon…` handle, used by players who never set a name. Thousands of people share each one, so no rank can belong to it. |
| `new` | No finished public games on ofstats yet. |
| `?` | ofstats could not be reached; it retries. |

## Where badges appear

- **Lobby list** — free-for-all tags, team cards, and the unassigned column.
- **In-game hover panel** — the card that follows your cursor over a territory.
- **In-game leaderboard** — the player table in the left sidebar.

That panel and table also cover bots and nations, whose generated names can
collide with a real account's (a nation called "France", a player called
"France"), and nothing in their markup reliably says which is which in every
language and mode. So the extension remembers the lobby roster and only badges
names that were in it. Enable it mid-game with no lobby seen and there is no
roster to check against, so it falls back to badging any name ofstats knows.

## Lobby and team summaries

Above the player list:

```
avg Top 39% · 2 elite · 2 unranked · [LUX] x2 Top 3%
```

— the room's average percentile, how many are elite (Top 5%), how many could not
be ranked, and any clan with more than one player present, strongest first. Each
team card gets its own `team avg Top N%`, so you can see before the game starts
whether your side is outmatched.

The strongest one or two players in the room (elite or strong only) get their
row outlined, in every place they appear. In a weak lobby nobody lights up —
being the least bad is not a threat.

## Map preview

The lobby names the map but never shows it, so the preview puts a thumbnail and
`World · Free For All · Easy · 400 tribes` above the player list.

Thumbnails are content-hashed (`thumbnail.2110da80df3c.webp`), so their URLs
cannot be guessed. The mapping lives in `window.BOOTSTRAP_CONFIG.assetManifest`,
a page global that an isolated content script cannot read — so
`src/page-probe.js` runs in the MAIN world, reads the manifest plus the lobby
element's own state, and publishes `{map, thumbnail, mode, difficulty, bots}` on
a `data-ofr-map` attribute that the content script watches.

Two shapes exist in the live build: the host modal keeps `selectedMap` /
`selectedDifficulty` as flat properties, the join modal carries a `gameConfig`
object. The probe reads both, and polls once a second because the host can
switch maps mid-lobby with no event to hook from outside.

The map folder is the GameMapType *key* lowercased — `New York City` becomes
`newyorkcity`, so the name is stripped of non-alphanumerics rather than
slugified with dashes.

## Zoomable map view

Click the lobby preview to open a full-screen view: scroll to zoom (anchored on
the cursor), drag to pan, `+` / `-` / `Fit` in the bar, Esc to close.

It does not enlarge the 500x250 thumbnail — that turns to mush. It renders the
real terrain: `maps/<map>/map.bin` is one byte per tile (bit 7 land, bit 6
shoreline, bit 5 ocean, low 5 bits elevation) and the map's `manifest.json`
gives the dimensions (2000x1000 for World, one byte each, so the file is exactly
2,000,000 bytes). The colours mirror the game's own `encodeTerrainTile`, so the
view matches what you will play on, and drawing uses nearest-neighbour when
magnified for the same pixel-crisp look the game uses.

The CDN sends permissive CORS headers, so the fetch works from the content
script. If terrain cannot be loaded the view falls back to the thumbnail and
says so.

## Deeper scouting

All of these come from the same single ofstats request per player — no extra
network traffic.

| Badge mark | Meaning |
|---|---|
| `🗺3%` | Skill **on the map being played**, from ofstats' per-map wins vs expected (needs 5+ games on it). |
| `🔥` / `❄` | **Form.** Hot: 3+ win streak, or last-ten wins at least double their norm. Cold: no wins in ten for someone who usually gets one. |
| `⚠` | **Possible smurf:** 5–40 rated games with a raw (unshrunk) ratio of 2.5x+. The percentile shrinks small samples on purpose, which is exactly what hides a strong player on a fresh account. |
| `★` | On your **watchlist**. |

The tooltip adds a **trend sparkline** — win rate in blocks of six games,
oldest to newest, drawn with block glyphs since native tooltips cannot render
markup.

**Watchlist.** Shift+click any badge to star or unstar a player. Starred names
are gold everywhere, a toast appears when one is in your lobby, and a system
notification fires if the tab is in the background. Manage the list in the
popup.

**Copy.** The summary line has a Copy button that puts a Discord-ready scouting
report on the clipboard: map, mode, summary, then every player strongest first
with their numbers and flags.

**Post-game recap.** See [Game recap](#game-recap) below.

The roster is always the lobby currently on screen; it is kept after the game
starts (when the list disappears) because the in-game bot filter needs it.

## Themes

**One theme for everything.** The picker at the top of the popup restyles all
the extension draws - badges, lobby summaries, home card, dashboard, recap,
charts, the share image, and the popup / settings panel itself - and, with
**Recolour OpenFront too** ticked (the default), OpenFront's own pages in the
same palette. Untick it to keep the game's colours and theme only the
extension. The popup preview uses the same stylesheet and icon sets as the
page, so what you see there is what the lobby gets.

| Theme | Look |
|---|---|
| Classic | OpenFront's own colours, the default dark UI and emoji marks |
| Neon | black glass, glowing cyan and magenta |
| Tactical | olive console, monospace, uppercase, square corners |
| Pastel | light: soft lilac panels, filled pills |
| Mono | greyscale; rank reads from brightness alone |
| High contrast | pure black, colour-blind-safe blue/orange, thick borders, **words instead of pictograms** (`HOT`, `SMURF?`, `WIN`) |

A theme is one id in three places, and `src/themes.js` is the catalogue:

- `src/themes.js` - name, one-line description, icon set (icons can't be
  expressed in CSS) and `site`, the recipe for OpenFront's palette: a hue per
  role (primary / success / danger / warning / accent), how tinted the surfaces
  are, a chroma boost, light or dark.
- `src/content.css` - the token block `html[data-ofr-theme="<id>"]`. Every
  colour, radius and font the extension uses is a `--ofr-*` custom property, so
  a theme is only a block of overrides; nothing else carries a colour, charts
  and the canvas share image included (they read the tokens).
- `src/page-themes.css` - **generated** from `site` by
  `node tools/gen-page-themes.mjs`. OpenFront is Tailwind v4, whose palette is
  CSS custom properties on `:root`, so overriding them on
  `<html data-ofr-page-theme>` recolours the page without touching elements.
  It covers every colour variable the site's stylesheets reference - 108 in 26
  families, captured from the live page into `tools/used-colors.json` - because
  a hand-picked subset left `:hover` shades on the original palette and the
  theme visibly dropped under the cursor. The generator also **fails** if the
  three places disagree (a theme without a token block, or the reverse).

Before 5.5 these were two pickers ("Theme" and "Restyle OpenFront itself",
default off). An existing profile is carried over **once** (marker
`themesMigrated`, synced with the settings) so that updating changes nothing on
screen: only the site themed -> that becomes the theme; an extension theme with
the site never themed -> *Recolour OpenFront too* starts **unticked**; both set
-> the theme picker wins and the site follows. After that a stray `pageTheme`
(another machine on the same profile still on 5.4) is ignored rather than
fought over.

The Copy report always uses standard emoji, since it's meant for Discord.

## Home card

On the front page, right under the username field: your percentile badge,
games, win rate, wins vs expected, streak, the last 20 results and today's
session, with a button to the full dashboard. Refreshes at most once a minute.

## Pro dashboard

A **PRO** button in OpenFront's nav bar opens a full-page statistics view for
you (or, from the search box, any player): world percentile with the numbers
behind it, games / wins / expected wins, streak, conquests, nukes, gold, a
win-loss strip of the last 60 games, percentile **per map**, win rate **per
mode**, personal bests, and a table of recent games linking to each game on
ofstats. Clicking a rank badge opens the same view for that player, in the page
(or nothing, if you turn it off in the popup). It never leaves the site: the
player's ofstats.io page is one click further, as the "Open on ofstats.io" link
in the dashboard header.

The way in from the header is the small tilted **PRO** tag under the OPENFRONT
wordmark, next to the version number, so the logo reads "OPENFRONT PRO". If the
header ever changes shape and the logo block cannot be found, it falls back to
a pill after the last nav link.

It costs the same single ofstats request per player as the badges; the payload
already carried everything the dashboard shows.

**Clans.** The lobby summary shows a chip per clan with 2+ players present,
strongest first. Clicking a chip, or opening the dashboard for a tagged player,
adds a clan section from ofstats' `/clans/<TAG>`: games, win rate, members,
monthly actives, team and stacked-game records, and the top members.

## Game recap

When the end screen appears, a panel opens bottom-right with what happened in
the game you just played, from OpenFront's own record of it
(`api.openfront.io/public/game/<id>`) read against everyone's world percentile.

- **Result banner** - `Victory`, `#33 of 71`, `Top 8 of 74` (alive at the end),
  `Defeat` (1v1), or `Team Yellow won`; when you fell and what share of the
  lobby you outlasted; your percentile badge. The coloured edge says how it
  went before you read anything.
- **Your numbers**, each with its rank in the lobby when that rank is a good
  one: players conquered, troops sent, gold, cities captured, nukes landed,
  trade ships captured, warheads shot down, structures built.
- **Players alive** - the survival curve of the whole lobby with your exit
  marked on it.
- **Story lines** - who eliminated you (when the record says so), *seeded #9 of
  45 by world rank, finished #1 among them (+8)*, the higher-ranked players you
  outlasted, an upset or "the favourite delivered", your share of the winning
  team's troops, clan-mates in the same game, and how strong the lobby was.
- **Graphs** tab - you against the winner (or the best of the rest, if you won)
  and the lobby median on gold / troops / conquests / structures; where your
  gold came from (workers, conquest, trade, trains, piracy); the lobby's rank
  bands with yours marked.
- **Awards** tab - Warlord, Executioner, Tycoon, Merchant prince, Pirate king,
  Rail baron, Atomic enthusiast, Doomsday, Iron dome, Admiral, City snatcher,
  Architect, Turtle, Most wanted, Backstabber, Last to fall. One holder each,
  above a floor, ties award nobody, at most two per player (plus *Clean sweep*
  for five or more).
- **Standings** tab - everyone, with badges, time of elimination, conquests and
  gold.
- Footer: your world rank before -> after, and today's session.
- **Share image** - a 1200x630 PNG (the size Discord unfurls) with the result,
  your numbers, the survival curve and the top awards, drawn on a canvas in
  your theme and copied to the clipboard; falls back to a download. It names
  other players only for compliments. **Copy text** copies the same as lines.

It never sits on the game's own dialog: if it would overlap the win modal (small
windows, large UI size) it folds to its title bar, which then carries the
headline; click to open. The fold state is remembered.

What the record can and cannot say (checked against OpenFront's source,
`src/core/StatsSchemas.ts`, and real records - `node tools/test-recap.mjs`):

- A player with no stats never spawned: not ranked, not counted in "of N".
- No elimination tick means *still had land at the end*, not *won*. Usually
  several players do, and the record cannot order them, so they are shown tied
  (`=2`, "Top 8"). Newer records carry `finalTiles`; then the places are exact.
- In a 1v1 the loser usually has no elimination tick at all.
- A team game lists only the winning team's members (older records: only those
  alive at the end). Nobody else's team is recorded, so a player off that list
  is told who won and what happened to them, never "defeat".
- A nation can win; then no human did, and places start at 2.
- Troop numbers are stored x10; conquests count conquer events, so they are
  "players conquered", never "kills"; trade gold is credited to both ends of a
  route, so it is never summed across players; "landed" can exceed "launched",
  so there is no accuracy stat.
- Usernames are not unique. Two players with your name and no clan tag to tell
  them apart means the recap shows the game as a spectator would see it.
- The record is archived when the game *ends*. The win screen also appears
  when you are eliminated while the game goes on, so the recap polls quickly
  for a minute, then every 30 s while that game is still on screen.
- Streamer mode shows you as "You" everywhere, including the image.

## Chat (beta, off by default)

A chat between players who have this extension, one room per game - in the
lobby, after the game, and during team games. There is **no server of
ours**: messages are [Nostr](https://github.com/nostr-protocol/nips) *ephemeral*
events (kind 20787: relays pass them on to whoever is subscribed and store
nothing) on four public relays - `relay.primal.net`, `nos.lol`, `nostr.mom`,
`relay.snort.social` (`node tools/probe-relays.mjs` re-checks which relays
deliver). The room is a hash of the game id, so a lobby stays together when the
game starts.

What that means, plainly:

- The relays are third parties. They see your **IP address** and what you send.
  Other players see only your name and text - not your IP (which is why this is
  relay-based and not peer-to-peer WebRTC).
- **Names are not verified.** Anyone can type any name, and nothing can prove a
  sender is the player of that name. Each name therefore shows a 4-character
  fingerprint of the sender's key, and no rank badge is ever attached.
- Messages are signed by a throw-away key made in your browser **per game**
  (`chrome.storage.session`: memory only, gone when the browser closes), so
  games cannot be linked through it and no key sits on disk. Every incoming event is
  checked - shape, size, room, clock (2 min), id, BIP-340 signature - before it
  is shown; a relay cannot forge, edit or rename a message.
- Text only: no markup, links are not clickable, control / zero-width / bidi
  characters and zalgo stacks are stripped. Slurs and the like are masked
  (switchable). `x` mutes a sender for that game; six messages in ten seconds mutes
  a sender for a minute; you can send one message per 1.2 s, twelve a minute.
  There is nobody to report to - no server - so muting is the tool.
- **During play:** open in team games; **paused while you are alive in a
  free-for-all** (nothing shown, nothing sent) and open again once you are out
  or the game ends. OpenFront's terms forbid outside channels for coordinating
  in free-for-all. "Also while I am alive in a free-for-all" is a separate
  switch, off by default, with that warning on it. Typing in the box does not
  trigger the game's hotkeys.
- It turns on only after an explicit **"I agree"** in the toolbar popup that
  lists what is sent and to whom. The in-page settings overlay cannot switch it
  on: a page script could frame that overlay and steal a click.
- The chat is **public**: anyone connected to those relays can read a room, not
  only users of this extension. While it is on, your name is announced to the
  room about every 45 seconds even if you do not type.
- **Report** in the panel opens the project's issue tracker - there is no
  server, so that and muting are the tools.
- The page itself is not trusted: OpenFront's pages carry third-party ad
  scripts, which share the DOM with any content-script UI. The panel lives in a
  **closed shadow root** (page scripts cannot read messages or the input box) and
  only real user input sends or mutes (`event.isTrusted`).
- Streamer mode sends "Player" instead of your name.

Crypto is `@noble/curves` + `@noble/hashes` (MIT, audited), vendored as one
unminified file by `node tools/build-vendor.mjs`, which refuses to install a bundle that
fails BIP-340's test vector. `node tools/test-chat.mjs [--live]` covers the
event rules and text hygiene, and with `--live` two clients through the real
relays.

## Who "me" is: OpenFront ids, not names

Usernames are not unique, so the recap used to refuse to guess when two players
shared yours. It now uses OpenFront's own ids:

- **client id** - the public, per-game id the page already has (the lobby
  modal's `currentClientID`, or `myPlayer().clientID()` in game; read by
  `page-probe.js`). The game record lists it per player, so the match is exact.
- **public id** - the stable `publicID` the record prints for every player.
  Learnt from a record matched by client id, stored locally, and used when the
  client id is not known (a game settled later, a reloaded tab).
- the name is the last resort, with the old rule: two matches and no clan tag to
  tell them apart means no guess.

The *persistent* id is a secret (it is the anonymous account) and is never read.

## Graphs

`src/charts.js` is a small SVG/DOM chart kit (step/line/area, columns, grouped
comparison bars, stacked bar, band histogram) - no library, since a content
script cannot load one from a CDN. Marks carry classes, colours come from the
theme tokens. Besides the recap it draws the dashboard's **Trends** section:
rolling 10-game win rate against what an average player would win in the same
lobbies, how much of each game you survived, and gold per game.

## Website layout (three templates)

"Website layout" in the settings re-arranges OpenFront's own front page. The
site is Tailwind utilities throughout, so the only stable handles are its custom
elements and the structure around them (`main > div`, `game-mode-selector > div`,
`desktop-nav-bar > nav`, `div:has(> streaming-now)`); `src/site-layouts.css`
documents each. Measured on the live page at 1440px:

| Template | What changes | Content column |
|---|---|---|
| Default | nothing | 756px (the site caps it at `20cm`) |
| **Wide** | lifts the cap; featured map 3:2 with upcoming lobbies two abreast | 1339px |
| **Sidebar** | nav becomes a fixed 232px left rail, PRO tag on the logo at the top, account/bell at the bottom | 1107px |
| **Focus** | one 680px column; news, streams and promos hidden; play buttons directly under the featured lobby, upcoming below | 680px |

None produces horizontal scroll. Ads are left alone in every template: they
fund the game. One trap worth recording: the site pins the play grid's second
row at 360px, so re-ordering rows in Focus needs `grid-template-rows: none` or
the button row inherits a 360px track.

## Pro card layout and size

Separate from the website layout: the Pro card can be **Cards** (stat tiles),
**Compact** (one line) or **Panel** (docked right, dashboard as a side drawer),
and everything the extension draws scales with **Size** (85% / 100% / 120% /
140%, via `zoom` on its containers). The card sits directly under the username
strip; it used to be inserted inside that strip's flex row, which squeezed the
name field down to "T...".

## Settings inside the page

The settings open in the page as an overlay (the popup's own document in an
iframe, so it keeps full `chrome.*` access) from three places: a **Settings**
button on the Pro card, another on the dashboard bar, and an **"OpenFront Pro
settings"** entry added to OpenFront's account dropdown. That dropdown only
exists while open and only for signed-in users, so the entry is (re)added
whenever the menu is on screen without it; it copies a neighbouring item's
classes to look native, and stays above a destructive last item (log out).

## Getting it to run

Chrome does not run declared content scripts when the extension's site access is
set to "on click", and it skips tabs that were already open when the extension
was reloaded. Both look identical to a broken extension. So the worker also
injects on every openfront.io navigation and into already-open tabs at
install/startup. `content.js` is wrapped in a guarded IIFE, so arriving twice in
one page is a no-op rather than a redeclaration crash.

The popup reports what is actually happening — worker state, ofstats
reachability, site access, and the last scan — reading storage and the network
directly rather than through the worker, since the worker is one of the
suspects. **Install only one copy**: two copies each run their own click
listener, which handled each badge click twice (now deduped by stamping the
click event's timestamp on the badge, but the badges still double up).

## Head-to-head

The tooltip adds `Met 3 times recently — you won 1, they won 2` when your last
60 games and theirs overlap. It costs no extra requests: the game ids come from
the same player payload, and the viewer is identified from the lobby's own
"current player" row (falling back to OpenFront's stored username).

Clicking any rank badge opens that player's stats in the page (the Pro
dashboard); Shift+click toggles the watchlist instead.

## How it hooks the page

`LobbyPlayerView` is a Lit element with `createRenderRoot() { return this }`, so
the lobby list lives in the light DOM and a content script can read it. Element
*properties* set by page scripts are not visible across the isolated world, so
names are parsed from direct text nodes of the name elements, for all three list
shapes (free-for-all tags, assigned team cards, unassigned column).

Results are cached in `chrome.storage.local` — 10 min for a hit, 30 min for a
miss — and lookups are queued at 3 concurrent requests, so a 50-player lobby
does not hammer the tracker.

**Reloads and updates.** When the extension is reloaded, the worker injects a
fresh copy of the content script into open tabs, but the copy that was already
running is never unloaded: its listeners keep firing with frozen settings and a
dead `chrome.*`. Every entry point therefore checks `alive()` (is there still a
runtime id?) and an orphan stands down. Click handling is delegated on `window`
in the capture phase, which runs ahead of `document`, so the live copy also gets
to a click before any document-level listener left by an older build, and stops
it there. `tools/cdp-badge.mjs` exercises exactly this: reload the extension
with the tab open, then click the PRO tag and a rank badge.

## Layout

```
manifest.json
src/background.js   ofstats lookups, cache, request queue, auto-injection
src/themes.js       THE theme catalogue: names, icon sets, site palette recipes
src/scoring.js      percentile scoring, shared by badges, dashboard and tools
src/charts.js       SVG/DOM chart kit, themed by tokens
src/dashboard.js    Pro dashboard (with Trends graphs) and home card
src/recap.js        game recap: analysis, panel, share image
src/welcome.html/js first-run disclosure and consent
src/chat.js         chat panel (closed shadow root), muting, filter, presence
src/nostr.js        minimal Nostr client: ephemeral events, verification, relay pool
src/vendor/         nostr-crypto.js - vendored @noble Schnorr + SHA-256
src/dashboard.css   dashboard, home card and settings overlay styling
src/site-layouts.css   the three website layout templates
src/page-themes.css    GENERATED from themes.js: OpenFront's palette per theme
src/page-probe.js   MAIN-world probe for the map preview
src/map-viewer.js   full-screen zoomable terrain view
icons/              extension and notification icons
sounds/alert.wav    watchlist alert
src/content.js      DOM scanning (lobby, hover panel, leaderboard), badges,
                    summaries, threat marks, map preview
src/content.css     tokens + theme blocks; badges, summaries, charts, recap
src/popup.html/js   settings
tools/calibrate.mjs re-derives the percentile table from live data
tools/gen-page-themes.mjs  regenerates src/page-themes.css, checks theme consistency
tools/test-recap.mjs       recap analysis over real game records, in node
tools/test-chat.mjs        chat: event rules, text hygiene, --live relay round trip
tools/probe-relays.mjs     which public relays deliver ephemeral events
tools/build-vendor.mjs     rebuilds src/vendor/nostr-crypto.js (checked against BIP-340)
tools/make-store-images.py Chrome Web Store screenshots and tiles from .shots/
store/                     listing text, privacy-tab answers, submission checklist
tools/cdp-*.mjs     dev: drive a debug Chrome (screenshots, live checks)
test/               fixture page reproducing the lobby markup
```

To run the fixture: `python -m http.server 8931` from this folder, then open
`http://localhost:8931/test/index.html`. It stubs the `chrome` API; live calls
from it fail with CORS by design.

## License

MIT - see [LICENSE](LICENSE). Bundled third-party code and the services the
extension talks to are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Unofficial: not affiliated with, endorsed by or sponsored by OpenFront.
