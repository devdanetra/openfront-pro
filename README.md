# OpenFront Pro

> **Unofficial.** Not affiliated with, endorsed by, or connected to OpenFront or its developers.

Chrome/Edge extension (Manifest V3) that shows each player's world ranking next
to their name in [OpenFront](https://openfront.io) — in the lobby list, on the
hover panel during a game and on the in-game leaderboard.

```
[LUX] TeNa  Top 3% 🔥      Firedan  Top 1% 🗺0.5%      [DFY] Rage  Top 2%
```

## Screenshots

![Rank badges next to every player in a lobby, with the lobby summary, a clan chip and the map preview](store/screenshot-1.png)

<table>
  <tr>
    <td width="50%"><img src="store/screenshot-2.png" alt="Stats dashboard: world rank, win rate, last ten games, win streak and rank on every map"></td>
    <td width="50%"><img src="store/screenshot-3.png" alt="Post-game recap: Summary, Graphs and Timelapse tabs"></td>
  </tr>
  <tr>
    <td width="50%"><img src="store/screenshot-4.png" alt="The nine themes side by side: badges, lobby summary and lobby chart"></td>
    <td width="50%"><img src="store/screenshot-5.png" alt="Stream overlay, clan hub leaderboard, tournament bracket and tournament results image"></td>
  </tr>
</table>

<table>
  <tr>
    <td width="33%"><img src="docs/img/overlay.png" alt="Stream overlay cards (rank, live game) over a made-up game map"><br><sub>Stream overlay</sub></td>
    <td width="33%"><img src="docs/img/clan-hub.png" alt="Clan hub: weekly leaderboard with movers"><br><sub>Clan hub</sub></td>
    <td width="33%"><img src="docs/img/tournament.png" alt="Tournament page: an eight-player bracket"><br><sub>Tournaments</sub></td>
  </tr>
</table>

<sub>Lobby players, the game map behind the overlay and the timelapse frames
are made up; dashboard, clan and tournament data come from public records.</sub>

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. On the first-run page that opens, press **"I agree"** (see below).
4. Open <https://openfront.io> and enter a lobby.

Click the toolbar icon for the settings: theme and website layout, which badge
marks and scouting features are on, the recap and timelapse, streamer mode, the
optional chat, your watchlist, a status readout and "Clear cached ranks". The
switch at its top turns everything off.

## First run, consent and permissions

On install a page opens that says, in plain words, what leaves the browser:
player names from your lobby and game (yours included), clan tags and names you
look up in the dashboard go to `api.ofstats.io`, a third-party community
statistics service, and a finished game's id goes to OpenFront's public API.
**Nothing is looked up until you press "I agree"**; the worker refuses lookup
messages until then (`dataConsent`), and the popup can switch it off again
("Turn rank lookups off"). Themes and layouts work without it; ranks, the home
card, the dashboard and the recap stay off. Closing the page without
answering counts as "not now", through every later update too; only a profile
updated from a version before 5.7.0 (which had no first-run page and always
looked names up) keeps lookups on. Chat has its own, separate agreement. See
[PRIVACY.md](PRIVACY.md).

With the popup's top switch (*Everything on / off*) off, nothing is looked up
or sent on its own: no badges, no home card, no recap records, no map preview,
no chat.

Permissions are the minimum: `storage`, `scripting` (to inject the packaged
scripts into every openfront.io page as it loads, which also covers tabs
already open at install / update and site access set to "on click"; see
[Getting it to run](#getting-it-to-run)), `notifications` (watchlist alert,
only with *Sound and notification* on), and host access to openfront.io and
`api.ofstats.io`. `clipboardWrite` is *optional* and only requested if you tick
"Copy the report at 10 s". The extension reads the game's pages and never
sends a game action.

## Where the ranking comes from

[ofstats.io](https://ofstats.io) aggregates every public OpenFront game by
display name, which is the only key the lobby gives us: `[TAG] name` (one
space) for a player with a clan tag, the bare name otherwise. The two are
separate records there - the bare `TeNa` is not `[LUX] TeNa`, and is often
somebody else - so a tagged player is always looked up with the tag (badges,
recap, dashboard, your own card) and never falls back to the bare name.

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
| `offline` | ofstats could not be reached, or answered with an error. A failure is cached for only a minute, so that name is asked again soon (a real "no history" answer is kept for 30 minutes). |

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
are gold everywhere and a toast appears when one is in your lobby. With *Sound
and notification* on, a sound plays too, and a system notification fires if
the tab is in the background; both follow that one switch. Manage the list in
the popup.

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
| Midnight | deep navy with a calm cyan accent; Neon without the glow |
| Ember | warm charcoal, orange and amber, rose for the top band |
| Daylight | light: crisp white and neutral grey, one indigo accent |

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

`node tools/check-theme-contrast.mjs` then checks every token block: all text
tokens and band colours at 4.5:1 on the panel, card and stage backgrounds (and
every band on its own badge fill and under `--ofr-on-band`), and that the five
bands and the loss colour stay apart. `test/themes.html` shows every theme side
by side.

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

On the front page, right under the username field, as pictures rather than
numbers: a small rank gauge, your name with the win streak as flames, today's
games as dots, a win-rate bar with a tick where an average player in your lobbies
would be, and the last 10 results as a strip - plus buttons to the full
dashboard and the settings. Refreshes at most once a minute. It is there (and
looks up your name) only while rank lookups are agreed and the extension is
switched on.

## Pro dashboard

A **PRO** button in OpenFront's nav bar opens a full-page statistics view for
you (or, from the search box, any player). It is drawn, not tabulated - each
section leads with a graphic, the exact figures are in hover tooltips, and a
**Numbers** button per section (closed by default) shows the old tables:

- **Overview** - a world-rank gauge coloured by band, a win-rate ring with a
  tick for an average player in the same lobbies, the last 10 results, the
  streak as flames, and one icon row (games, wins, conquests, nukes, gold).
- **Today's session** - games won today as a ring, one bar per game (taller is a
  better placing), and your rank at the start of the day and now.
- **Recent form** and **Trends** - the last-60 strip, rolling win rate,
  survival and gold charts.
- **By map** - best and weakest five, then a heat grid of every map coloured
  by your percentile band there (fainter when there are few games).
- **By mode** - one win-rate ring per mode. **Personal bests** - icon cards.
- **Recent games** - a row per game with the result, map, mode and two small
  bars (length, conquests), linking to the game on ofstats; 10 shown, the rest
  on request.
- **Clan leaderboard - this week** - ofstats' top ten clans by points, yours
  highlighted, with each clan's stacked win rate as a bar.
- **Compare** - two rank gauges and mirrored bars per measure.

Clicking a rank badge opens the same view for that player, in the page (or
nothing, if you turn it off in the popup). It never leaves the site: the
player's ofstats.io page is one click further, as the "Open on ofstats.io" link
in the dashboard header.

The way in from the header is the small tilted **PRO** tag under the OPENFRONT
wordmark, next to the version number, so the logo reads "OPENFRONT PRO". If the
header ever changes shape and the logo block cannot be found, it falls back to
a pill after the last nav link.

Each player costs the same single ofstats request as the badges (the payload
already carries everything the player sections show); the clan section
(`/clans/<TAG>`), the weekly clan table (`/clans`) and a Compare lookup are one
request each.

**Clans.** The lobby summary shows a chip per clan with 2+ players present,
strongest first. Clicking a chip, or opening the dashboard for a tagged player,
adds a clan section from ofstats' `/clans/<TAG>`: win-rate rings (all games,
team, stacked, recent), members with the share active this month, and the top
members' wins as bars. Its **Clan hub ↗** link opens that clan in the hub.

## Clan hub

A full page of its own (`src/clans.html`, from the popup's *Tools* tab or the
dashboard's clan section; `#tag=LUX` opens a clan), graphics first with the
exact figures on hover:

- **Leaderboard** - ofstats' weekly top 50 by points: rank, the change since
  last week, points, stacked win rate (tick: all games), games, members who
  played that week, and a 12-week rank line for the clans in ofstats'
  timeline. Week arrows go back up to a year; the biggest climbers and fallers,
  and clans new to the top 50, sit above it.
- **Clan** - win-rate rings (all, team, stacked with ofstats' average-stack
  tick, recent), points per week for 12 weeks, win rate by stack size and by
  mode, then members: how many are active, the average member percentile, the
  members by rank band, and a row per member (percentile badge, win rate,
  games, last played) that opens into a mini profile with an ofstats.io link.
  Best maps are summed from the members looked up.
- **Compare** - two clans side by side (mirrored bars: points, rank, win rates,
  members, active share, average member percentile, games), both weekly point
  lines, and a head-to-head from games both clans were in. That comes only
  from what is visible - each clan's 20 latest games on ofstats (with the
  winner's name) and the last 60 games of each looked-up member (with their
  own result) - and a game whose result cannot be told is marked so. In team
  games a side's result rests on the members looked up: a clan split over two
  teams, with its winners not among them, can be miscounted.
- **Recruits** - strong players without a clan tag, filtered by percentile,
  last game and modes played, sorted by rank, activity or games. The list
  comes **only from players this browser has already looked up**: in your
  lobbies and games, in recaps, and names typed into the dashboard's search or
  *Compare* box. The worker keeps a small index for it in `storage.local`
  (`recruitIndex`: one slim record per untagged, ranked player - name,
  percentile, games, wins, last game, games per mode - at most 500, the most
  recently looked up, none older than 60 days; "Clear cached ranks" empties
  it). The page reads that key only and sends nothing.

What it asks ofstats, through the worker (the consent gate, queue and cache
every lookup uses; with lookups not agreed the page shows a button to the
first-run page and sends nothing): `/clans?limit=50[&week=YYYY-Www]` (new
worker message `clanTable`, the week shown and the one before), `/clans/<TAG>`
per clan opened or compared, and `/players/<[TAG] name>` for members, six at a
time: 24 on opening a clan (all 50 of ofstats' first page on request), 12 per
clan in Compare. A member whose lookup gets no answer shows "offline", with a
Retry. In streamer mode your own name shows as "You"; the hub learns it from
openfront.io, where the extension notes it locally (`selfStatsName`) whenever
it reads your name. Until then streamer mode hides every name in the hub, with
a banner saying why. The hub follows the popup's *Everything on / off* switch.
`node tools/test-clans.mjs` tests weeks, movers, the recruit index and
filtering, the comparison and head-to-head maths, and the worker (the
`clanTable` route, the start-up purge of expired cache entries, lookups that
still answer when storage is full); `node tools/shot-clans.mjs` screenshots
every view through the launcher.

## Tournaments

A page for organisers (`src/tournament.html`, popup -> *Tools* ->
*Tournaments*), with no server anywhere: create a tournament, paste each game's
id or link once it is played (`https://openfront.io/game/<id>`, `#join=<id>`
or the bare id), and it reads OpenFront's public record of each game and
works out the rest.

- **Formats:** points league / round robin (with a head-to-head grid),
  single-elimination bracket (seeded by the order you list, byes for the top
  seeds, winners advance from recorded games, any match can be set by hand),
  and a best-of-N series between two sides.
- **Participants:** players (matched by name, case-insensitive; a clan tag
  only breaks ties between namesakes) or teams and clans (matched by clan tag
  or by listed members). They can be picked from a game's players or clan
  tags, and from its team slots where the record has them - only matchmade
  team games do (OpenFront's server stamps `teamIndex` there); private
  lobbies, where tournaments are played, do not. Players a game has that
  nobody claims are listed on that game so you can assign them (or say "not
  in tournament"); two participants claiming one player (namesakes such as
  "Bob" and "bob" included) is never guessed. Hand-set bracket results and
  game pins name the two players, not a bracket position, so reseeding never
  hands them to someone else.
- **Scoring:** points for a win, a placement table and points per player
  conquered; presets *FFA points* (10/7/5/4/3/2/1 + 1 per conquest) and *Team
  wins only*. Places count among the tournament's participants in that game,
  so strangers or bots in the lobby change nothing; tied places share their
  points. Ties in the standings: wins, then average place, then head-to-head.
- **Results:** a 2x PNG for Discord (standings, bracket or series, in your
  theme) and *Copy results text*.
- **Saved** in `chrome.storage.local`, one key per tournament
  (`tournament:<id>` plus the order in `tournamentIdx`, at most 30; the old
  single `tournaments` list is moved over once), so two open tabs editing
  different tournaments never overwrite each other and the same one merges by
  its last-change stamp. A saved tournament that fails validation is kept
  untouched and listed as damaged (export or delete it), never dropped. A
  failed save shows a banner; when storage is full the record cache is
  emptied (except the open tournament's) and the save retried. Finished
  games' records are cached (`tRec:<id>`, LRU, 250 games / ~3 MB, the open
  tournament's never evicted), so reopening a tournament asks OpenFront for
  nothing.
- **Shared** as a `.json` file or a **share code**: `#t=<base64url of
  deflate-raw JSON>` carrying the whole tournament (up to 6000 characters;
  bigger ones say so and point to the file). The other organiser pastes the
  code under *Import*. That is the way to share: `tournament.html` is not
  web-accessible, so a `chrome-extension://…/tournament.html#t=…` link clicked
  on a web page (Discord in the browser included) is blocked by Chrome - it
  only opens when pasted into the address bar of a Chrome with the same
  extension id (the Share tab offers that link too, in the extension only).
  Under the Steam launcher only the code is ever copied (the page's address
  there holds the launcher's secret token). Files and codes are validated
  strictly (types, lengths, counts, no control or bidi characters, a cap on
  the unpacked size) and everything in them is shown as text only.

Game lookups are the same `gameRecord` message the recap uses, so they wait
for the first-run agreement (the page shows a button to it until then). They
go out two at a time, at least 400 ms apart, and back off (2 s, 4 s, 8 s) when
OpenFront answers 429; more than 20 records due at once (a big import, a
crafted code) wait for a click. Game ids follow OpenFront's shape (8-10
letters and digits; a bare word must also contain a digit or mixed case, so a
pasted chat line adds nothing). A game not published yet gets *Retry*.
`node tools/test-tournament.mjs` tests link parsing, matching, scoring,
tie-breaks, the bracket, share codes, storage merging and migration, and the
validation over the real records in `.recap/`; `node tools/shot-tournament.mjs`
screenshots every view through the launcher.

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
  for a minute, then every 30 s while that game is still on screen (up to about
  half an hour). A game still unpublished when you leave is asked for again on
  your next openfront.io page, for up to a day, so today's session stays
  complete.
- Streamer mode shows you as "You" everywhere, including the image.

## Timelapse (GIF / video of your game)

While you play, the extension takes a small picture of the **whole map** - who
owns what, independent of where your camera is - every few seconds, by reading
the game client's tile buffer and terrain, and every player's name, colour and
land share for the strip (page world, read-only: nothing is written, no intent
is sent). It records only when the recap can show it: the recap switched on,
rank lookups agreed, and the *Timelapse* switch on. The recap's **Timelapse**
tab plays it back with a strip under the map: game clock, humans still alive,
your share of the land, and the three biggest empires. The tab is there while
the game's record is still awaited, and for games whose record is never
published (single-player), too. From there:

- **Save video** - WebM, a few hundred KB; Discord and browsers play it inline.
  Ends on your recap card.
- **Save GIF** - works everywhere, bigger. Own encoder (`src/timelapse.js`): one
  256-colour palette, and from the second frame on only the box that changed is
  stored with unchanged pixels transparent, which is most of the size on a map.
  `node tools/test-gif.mjs` decodes what it writes with an independent decoder
  and compares pixel for pixel.

Frames are kept **in memory, in that tab only**, at most 360 (long games keep
every other frame and slow down), and are thrown away with the next game or when
the tab closes. Nothing is uploaded: saving writes a file on your computer.
Streamer mode leaves other players' names out of the strip. Switch: *Game ->
Timelapse*.

## Streamer overlay

An OBS overlay page (`src/overlay.html`), made of cards rather than text:

- **Rank** - your world-rank gauge (with today's drift as an arrow inside it),
  your win streak as flames and today's games as pips (a win filled), wins/games.
- **Live game** - state (live / spawning / out / game over), map and mode, the
  game clock, your place, your land share, humans alive, and bars for the three
  biggest empires against yours (no names).
- **Recap** - when the game's record is in, the recap's share card for a set
  number of seconds (then the live card of the next game takes over).

**Browser extension.** Settings -> *Tools* -> *Streamer overlay* -> **Open** opens
it in a small window of its own on green. In OBS: *Window Capture* -> that
window -> filter *Chroma Key* (green). Its settings panel (the gear on hover,
or `?edit=1`) picks the cards, corner, backdrop, size, how long the recap
stays, whether your name shows, and has sample data for placing it; the choices
live in the address, so a reload keeps them. OBS cannot load extension pages
itself; the panel's *Copy address* is for browser-source plugins that can.
Keep the window uncovered: Chrome stops painting a window that is fully hidden.

**Steam launcher.** The launcher prints the overlay's address (and its
settings page has *Copy* under Tools): OBS -> *Browser Source* -> that address,
1920x1080, backdrop transparent. **The address contains the launcher's secret
key: never show it on stream or share it.** It changes every time the launcher
starts, so paste the new one into OBS after a restart.

Options in the address: `w=rank,live,recap` (which cards, in that order),
`bg=transparent|green|dark`, `pos=tl|tr|bl|br`, `scale=0.5..3`, `recap=20`
(seconds; `0` = until the next game), `name=0` (never show your name),
`streamer=1`. **Streamer mode** always wins: with it on, neither your name nor
your rank is shown (no gauge, no drift arrow; the streak and today's games
stay), as everywhere else in the extension. With streamer mode or `name=0` the
recap card is drawn masked too ("You", no rank); an unmasked card is never shown
on such a page.

How it works, all on this computer: while the overlay page is open it writes a
heartbeat (`overlayEnabled`, a time, every 20 s; `0` when it closes, and
`overlayMask` while it hides your name) to `chrome.storage.local`. Only while
that is fresh (2.5 minutes) does the openfront.io tab publish: your ofstats name
(`overlaySelf`), the running game (`overlayLive`: counts and shares, no names,
from `page-probe.js`, read-only; written when it changes - the clock does not
count, the page runs it - and every 4 s otherwise; removed when you leave the
game) and the recap card once per game (`overlayRecap`, a 1200x630 PNG). With
several openfront.io tabs open, one publishes the game at a time: the one that
started, or the one on screen. A few seconds after the overlay page is gone the
tab removes all of it. The page reacts to storage changes and asks the worker
for your own rank like the home card does (right after a game, bypassing the
10-minute cache). The recap card needs the recap on and rank lookups agreed,
like the recap itself (closing the recap panel does not stop the card; a
replay's end screen never makes one). The openfront.io page can see that an
overlay is open (`data-ofr-overlay="on"` on its root element). The timelapse clip is
not on the overlay: its frames stay in the game tab. `node tools/test-overlay.mjs`
checks the page logic; `node tools/shot-overlay.mjs` runs the whole path against
a stand-in game through the launcher and takes the screenshots.

## Chat (beta, off by default)

A chat between players who have this extension, one room per game - in the
lobby, after the game, and during team games. There is **no server of
ours**: messages are [Nostr](https://github.com/nostr-protocol/nips) *ephemeral*
events (kind 20787: relays are meant to pass them on to whoever is subscribed
and not store them, and each carries a five-minute NIP-40 expiry - but nobody
can guarantee that a third-party relay, or anyone subscribed, keeps no copy) on
four public relays - `relay.primal.net`, `nos.lol`, `nostr.mom`,
`relay.snort.social` (`node tools/probe-relays.mjs` re-checks which relays
deliver). The room is a hash of the game id, so a lobby stays together when the
game starts. Game ids are public, so anyone can tell which game a room belongs
to.

What that means, plainly:

- The relays are third parties. They see your **IP address** and what you send.
  Other players see your name, your text and a per-game key (in team games also
  the player slot it claims and whom it verified) - not your IP (which is why
  this is relay-based and not peer-to-peer WebRTC).
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
  free-for-all**: the tab leaves the room altogether - no relay connection,
  nothing shown, nothing sent (not even the presence signal), nothing received -
  and rejoins the same room once you are out or the game ends. OpenFront's terms
  forbid outside channels for coordinating in free-for-all. "Also while alive in
  a free-for-all" is a separate switch, off by default, with that warning on it.
  Typing in the box does not trigger the game's hotkeys.
- It turns on only after an explicit **"I agree"** in the toolbar popup that
  lists what is sent and to whom. When an update changes what chat sends (5.8
  added the team channel), chat switches itself off once and asks again. No settings copy embedded in a page can switch
  it (or the free-for-all switch) on - not the in-page overlay on openfront.io,
  and not the companion launcher's overlay in the game window; they can only
  switch it off. A page script could cover such an overlay and steer a click
  onto it. In the launcher, chat is switched on from its settings page in your
  normal browser.
- The chat is **public**: anyone connected to those relays can read a room, not
  only users of this extension. While it is on (and not paused), your name is
  announced to the room about every 45-60 seconds even if you do not type.
- There is no server to report to, so muting is the tool.
- The page itself is not trusted: OpenFront's pages carry third-party ad
  scripts, which share the DOM with any content-script UI. The panel lives in a
  **closed shadow root** (page scripts cannot read messages or the input box) and
  only real user input sends or mutes (`event.isTrusted`). What the panel cannot
  protect is what the game tells it: see the team channel's limits below.
- Streamer mode sends "Player" instead of your name. In team games the team
  channel still announces your player slot, and anyone in that game can match
  the slot to your name.

### Team channel (team games)

In a team game the panel gets a second tab, **Team**: the text of messages
there is encrypted to teammates **verified through the game** - by you, or
through a chain of teammates who verified each other (up to about eight
steps) - at most 12 per message, and is shown under the name the *game* gives
that player - not a typed one.

Why it needs verifying: everything in an OpenFront game is public (every client
holds the whole state), so there is no secret only your team knows. What an
enemy cannot do is *act in the game as your teammate*. So:

1. You press **Verify** next to a teammate who has the extension; they press it
   for you. Nothing happens - nothing is even answered on the relay - without
   both clicks.
2. The two extensions agree on **three emojis** with a commit-then-reveal
   exchange, so neither side, nor anyone in between, can steer which three.
3. Each of you sends them **to the other** with the game's own emoji menu (hold
   Alt, click their territory; the game allows one every 5 s per recipient, the
   panel counts down). The extension never sends anything into the game - it
   watches its own copy of the game for exactly that run, from that player, to
   you, after the pairing started.
4. Verified teammates vouch for the keys they verified, and those keys for the
   ones *they* verified (up to about eight steps), so a team needs a chain, not
   every pair. A key vouched for this way also receives your team messages.

What the relay room sees, once the team channel is on in a team game: from the
start of the game and about every 45 s, with no click needed, your key
announces which player slot (the game's per-game player number) it claims, the
keys you verified, and any key that claimed to be you. Pressing Verify
publishes a handshake naming that teammate's key and both player slots. Each
team message lists its recipients' key prefixes and shows its length. Only the
message text is encrypted.

An impostor gets one blind guess per click of yours: about 1 in 175 000. What it
does **not** protect against:

- **any script running in OpenFront's page**, including the third-party ad
  scripts the site loads, and other extensions. The extension learns your
  team's roster and the emojis sent from the page's own game object, and such a
  script can fake that information. After you press Verify once on a key of its
  choosing, it can get that key verified as your teammate and then read the
  team channel. The same goes for the page of any teammate in the chain: a key
  verified there is trusted by you too, with no click of yours. No
  extension-side code can fully prevent this: the page owns the game objects;
- a teammate anywhere in the chain who leaks the channel, or vouches for an
  outsider;
- a teammate who is talked into sending three emojis by someone on voice chat
  (the panel says never to, and during team games shows no emoji from anyone
  else in the public tab, whether or not your team channel is on).

Who takes part is public: the relay room sees which keys claim which player
slot, who verified whom, and who wrote to which keys, when. Full protocol,
threat model and what a pre-implementation red-team review changed:
[docs/TEAM-CHAT.md](docs/TEAM-CHAT.md). `node tools/test-team.mjs` runs honest
pairings and the attacks. Switch: *Chat -> Encrypted team channel* (on by
default once chat is on).

Crypto is `@noble/curves` + `@noble/hashes` (MIT, audited; Schnorr signatures and the
team channel's ECDH - AES-GCM and HKDF are the browser's WebCrypto), vendored as one
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

`src/charts.js` is a small SVG/DOM chart kit - gauges and rings, meters, pips,
mirrored comparison bars, step/line/area, columns, grouped comparison bars,
stacked bar, band histogram, icons - no library, since a content script cannot
load one from a CDN. Marks carry classes, colours come from the theme tokens.
It draws the recap, the home card and every dashboard section; in **Trends**,
for instance, the rolling 10-game win rate against what an average player would
win in the same lobbies, how much of each game you survived, and gold per game.

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

Separate from the website layout: the Pro card can be **Cards** (the default:
rank gauge beside your name, win-rate bar and last-10 strip), **Compact** (the
same card with a smaller gauge and tighter spacing; the dashboard tightens too)
or **Panel** (docked right, dashboard as a side drawer),
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
What talks to third parties - chat and its free-for-all switch - and the
auto-copy (which needs a browser permission) cannot be switched on from this
overlay, only off; that happens in the toolbar popup.

## Getting it to run

Chrome does not run declared content scripts when the extension's site access is
set to "on click", and it skips tabs that were already open when the extension
was reloaded. Both look identical to a broken extension. So the worker also
injects on every openfront.io navigation and into already-open tabs at
install/startup. `content.js` is wrapped in a guarded IIFE, so arriving twice in
one page is a no-op rather than a redeclaration crash.

The popup reports what is actually happening — worker state, ofstats
reachability, site access, and the last scan. Site access and the last scan are
read directly (from Chrome and from storage), not through the worker, since the
worker is one of the suspects. ofstats reachability is asked of the worker,
which contacts `api.ofstats.io` only once rank lookups are agreed and switched
on; until then the line reads "ofstats.io: not checked". **Install only one
copy**: two copies each run their own click
listener, which handled each badge click twice (now deduped by stamping the
click event's timestamp on the badge, but the badges still double up).

## Head-to-head

The tooltip adds `Met 3 times recently — you won 1, they won 2` when your last
60 games and theirs overlap. It costs no extra requests: the game ids come from
the same player payload, and the viewer is identified from the lobby's own
"current player" row (falling back to OpenFront's stored username and clan tag).

Clicking any rank badge opens that player's stats in the page (the Pro
dashboard); Shift+click toggles the watchlist instead.

## How it hooks the page

`LobbyPlayerView` is a Lit element with `createRenderRoot() { return this }`, so
the lobby list lives in the light DOM and a content script can read it. Element
*properties* set by page scripts are not visible across the isolated world, so
names are parsed from direct text nodes of the name elements, for all three list
shapes (free-for-all tags, assigned team cards, unassigned column).

Results are cached in `chrome.storage.local` — 10 min for a hit, 30 min for a
miss or a failed request — and lookups are queued at 6 concurrent requests, so
a 50-player lobby does not hammer the tracker.

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
src/background.js   ofstats lookups, cache, request queue, auto-injection,
                    game records, consent gate, chat relays and team glue
src/themes.js       THE theme catalogue: names, icon sets, site palette recipes
src/scoring.js      percentile scoring, shared by badges, dashboard and tools
src/charts.js       SVG/DOM chart kit, themed by tokens
src/dashboard.js    Pro dashboard and home card, drawn with charts.js (exact
                    figures in folded Numbers boxes)
src/recap.js        game recap: analysis, panel, share image
src/welcome.html/js first-run disclosure and consent
src/clans.html/js   clan hub: weekly table, clan page, clan vs clan, recruits
src/clans-logic.js  the clan hub's pure logic: weeks, movers, comparison, head-to-head, recruits
src/overlay.html/js OBS stream overlay (rank, live game, recap card)
src/overlay-core.js the overlay's pure logic: options, checks, what shows
src/tournament.html/js/css  tournaments: setup, games, standings, bracket, series, share image
src/tournament-core.js      the tournaments' pure logic: links, matching, scoring, bracket, share links, validation
src/chat.js         chat panel (closed shadow root), muting, filter, presence, Team tab
src/team.js         team channel: teammate verification, trust, encryption (worker)
src/timelapse.js    timelapse frames, preview, WebM and GIF export
src/nostr.js        minimal Nostr client: ephemeral events, verification, relay pool
src/vendor/         nostr-crypto.js - vendored @noble Schnorr + ECDH + SHA-256
src/dashboard.css   dashboard, home card and settings overlay styling
src/site-layouts.css   the three website layout templates
src/page-themes.css    GENERATED from themes.js: OpenFront's palette per theme
src/page-probe.js   MAIN-world probe: map preview, timelapse frames, team roster/emoji feed, overlay figures
src/map-viewer.js   full-screen zoomable terrain view
icons/              extension and notification icons
sounds/alert.wav    watchlist alert
src/content.js      DOM scanning (lobby, hover panel, leaderboard), badges,
                    summaries, threat marks, map preview
src/content.css     tokens + theme blocks; badges, summaries, charts, recap
src/popup.html/js   settings
tools/calibrate.mjs re-derives the percentile table from live data
tools/gen-page-themes.mjs  regenerates src/page-themes.css, checks theme consistency
tools/check-theme-contrast.mjs  contrast and band-distinctness check for every theme
tools/test-recap.mjs       recap analysis over real game records, in node
tools/test-overlay.mjs     stream overlay logic, in node
tools/shot-overlay.mjs     stream overlay end to end (stand-in game + launcher) and screenshots
tools/test-clans.mjs       clan hub logic and the worker's clanTable route, in node
tools/shot-clans.mjs       clan hub screenshots with real ofstats data, through the launcher
tools/test-tournament.mjs  tournament logic over the real records in .recap/, in node
tools/shot-tournament.mjs  tournament screenshots (made-up tournaments from .recap/), through the launcher
tools/tournament-fixtures.mjs  shared by those two: loads the logic, the records and the demo tournaments
tools/test-chat.mjs        chat: event rules, text hygiene, --live relay round trip
tools/test-team.mjs        team channel: pairings, trust, encryption, and the attacks
tools/test-gif.mjs         GIF encoder against an independent decoder
docs/TEAM-CHAT.md          team channel protocol and threat model
tools/probe-relays.mjs     which public relays deliver ephemeral events
tools/build-vendor.mjs     rebuilds src/vendor/nostr-crypto.js (checked against BIP-340)
tools/pack.mjs             builds the Chrome Web Store zip (manifest, src/, icons/, sounds/)
tools/build-launcher.mjs   builds the launcher downloads (exe, portable zip, checksums)
tools/make-store-images.py Chrome Web Store screenshots and tiles from .shots/
tools/make-icons.py        draws the icon set (icons/, store/)
tools/asar-peek.mjs        read-only look inside an Electron app.asar
launcher/                  companion launcher for the Steam build
store/                     listing text, privacy-tab answers, submission checklist
tools/cdp-*.mjs     dev: drive a debug Chrome (screenshots, live checks)
test/               fixture page reproducing the lobby markup
```

To run the fixture: `python -m http.server 8931` from this folder, then open
`http://localhost:8931/test/index.html`. It stubs the `chrome` API; live calls
from it fail with CORS by design.

## Steam build

The Steam (Electron) version cannot load extensions. `launcher/` runs this same
code against it from outside, without touching the game's files (settings open
inside the game window) - experimental,
and with caveats worth reading first: [launcher/README.md](launcher/README.md).

## License

MIT - see [LICENSE](LICENSE). Bundled third-party code and the services the
extension talks to are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Unofficial: not affiliated with, endorsed by or sponsored by OpenFront.
