# Store listing - text to paste

## Name (from manifest.json)

OpenFront Pro

## Summary (from manifest.json `description`, max 132 characters)

Unofficial. Player rankings, form, map preview and scouting for OpenFront lobbies. Not affiliated with OpenFront.

## Category

Just for Fun  (alternative: Tools)

## Language

English

## Detailed description

OpenFront Pro is an unofficial companion for the browser strategy game at openfront.io. It shows public player statistics and scouting information on the game's own pages. It is not affiliated with, endorsed by or sponsored by OpenFront.

DATA AND PRIVACY - READ FIRST
- To show ranks, the player names in your lobby and game (including your own username), clan tags, and any name you search for in the dashboard are looked up at api.ofstats.io, an independent community statistics service. After a game, that game's id is looked up at the game's own public API for the recap. Nothing is looked up until you agree on the first-run page, and you can switch it off again.
- There is no developer server, no account, no analytics, no ads and no tracking. Settings and caches stay in your browser.
- Chat is optional, off by default, asks for its own agreement and is public: it runs over third-party Nostr relays, which see your IP address. Relays are meant to forward messages without storing them, but nobody can guarantee that.
- In team games, an encrypted team channel (on by default once chat is on) also publishes, automatically, which player slot you are in that game and which teammates you verified. Only the message text is encrypted, to teammates verified through the game: by you, or through a chain of teammates who verified each other (up to about eight steps). A script running in OpenFront's page (yours or that of a teammate in the chain) could fake a verification and read that channel.
- Privacy policy: https://github.com/devdanetra/openfront-pro/blob/main/PRIVACY.md
- Source code (MIT): https://github.com/devdanetra/openfront-pro

WHAT IT ADDS
- A world-rank badge next to each player name in the lobby, on the in-game player panel and on the leaderboard, based on wins against expected wins in public games. Hover for games, win rate, rank on this map, recent form and head-to-head.
- Lobby and team summaries: average strength, strongest players, clan groups, and a copyable scouting report.
- Map preview in the waiting lobby, with a zoomable full-resolution terrain view.
- A visual stats dashboard inside the site: a world-rank gauge, your win rate against an average player, your rank on every map as a heat grid, win rate per mode, rolling win-rate, survival and gold trends, recent games, today's session, clan statistics with the weekly clan table, and a side-by-side player comparison.
- A game recap when a match ends: your result, your numbers ranked within the lobby, the survival curve, awards, full standings, a share image for Discord, and a timelapse of the whole map you can save as a video or GIF (recorded and kept in your browser's memory, never uploaded).
- Watchlist with an optional sound and notification when a watched player joins your lobby.
- Themes (Classic, Neon, Tactical, Pastel, Mono, High contrast) for the extension and, if you want, the site's colours; three front-page layouts (Wide, Sidebar, Focus). Ads are never hidden.
- Streamer mode hides your own name and rank (in team games the team channel still announces your player slot, which players in that game can match to your name).
- Optional chat with other users of the extension in the same lobby or game. During play it stays open in team games and pauses in free-for-all while you are alive (it leaves the room until then), in line with the game's rules on outside coordination.

GOOD TO KNOW
- It only runs on openfront.io.
- Ranks come from public game history collected by ofstats.io; guests and brand-new names have none.
- Names in chat are not verified.
- The extension reads the game's pages; it does not play for you or send any game action.
