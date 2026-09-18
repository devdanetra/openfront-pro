# Privacy tab - text to paste

## Single purpose

Unofficial companion for the browser game at openfront.io: it shows public player statistics and scouting information on the game's own pages (rank badges in lobbies and in game, lobby and map summaries, a statistics dashboard and a post-game recap with a timelapse of the game kept in memory), with optional appearance settings for those pages and an optional chat between users of the extension in the same game. It works only on openfront.io.

## Permission justifications

**storage** - Saves the user's settings, agreement flags and watchlist (chrome.storage.sync); a short-lived cache of looked-up public statistics, today's session results, finished games whose public record is still awaited (at most a day), the user's OpenFront public player id, the chat mute list, the last diagnostic report shown in the popup (it can list player names from the last scan that had no statistics) and a few interface preferences (chrome.storage.local); and, in memory-only chrome.storage.session, a throw-away per-game chat key and, for the optional team chat, the teammate keys verified in that game, used verification ids, message timestamps and keys that claimed to be the user. Nothing is stored anywhere else.

**scripting** - Injects the extension's own packaged content scripts and stylesheets into openfront.io tabs: each time one finishes loading, into those already open when the service worker starts (browser start, install, update, re-enable), and into the current tab when the user presses "Enable on openfront.io". This covers tabs where Chrome skips the declared content scripts (site access "on click", tabs opened before the extension loaded); a second copy does nothing. One packaged file, src/page-probe.js, is injected the same way into the page's main world to READ state that only exists there: lobby settings, countdown, lobby id and the player's per-game client id; in a game, tile ownership and the players' names, colours and land share (for the local timelapse, never uploaded) and, with the optional team chat, the user's team roster and emojis between teammates (to verify them). It never writes game state or sends game input. No remote code is injected.

**notifications** - Shows one desktop notification when a player on the user's own watchlist joins the lobby while the OpenFront tab is in the background. Only while the popup's "Sound and notification" switch is on (and the extension itself is on); the notification and the sound follow that one switch.

**clipboardWrite (optional permission)** - Requested only when the user ticks "Copy the report at 10 s" (the lobby countdown), which writes the lobby scouting report to the clipboard without a click. Never requested otherwise; all other copy buttons use the standard user-gesture clipboard API.

**Host permission https://openfront.io/* and https://*.openfront.io/*** - The only site the extension works on: content scripts read player names, lobby and game state there and draw the badges, panels and themes. The wildcard covers the game's own subdomains, including its public API (api.openfront.io) used to read the public record of a finished game for the recap.

**Host permission https://api.ofstats.io/*** - The service worker fetches public player and clan statistics from this third-party community API. It sends no CORS headers, so the request cannot be made from the page. Player names from the user's lobby and game (the user's own included), names the user types into the dashboard's search or compare box, and clan tags are sent there, only after the user's consent on the first-run page. The weekly clan table and a reachability check when the settings open are requests without any name.

## Remote code

No, I am not using remote code. All JavaScript is inside the package. src/vendor/nostr-crypto.js is an unminified bundle of @noble/curves 1.9.7 and @noble/hashes 1.8.0 (MIT), reproducible with tools/build-vendor.mjs in the public repository. WebSocket connections to Nostr relays carry chat data only, never code.

## Data usage - tick these

- **Personally identifiable information** - YES. The user's OpenFront username (and other players' usernames from the lobby, the game or the dashboard search) is sent to api.ofstats.io for statistics, and to the chat relays if chat is on (the word "Player" instead in streamer mode). With the team chat on in a team game, the user's per-game player slot also goes to the relays, and players in that game can match it to the username.
- **Personal communications** - YES. Opt-in chat messages typed by the user are transmitted through public Nostr relays. Team-chat messages go there too, with only the text encrypted, to teammates verified through the game: by the user, or through a chain of teammates who verified each other (up to about eight steps). A script in the OpenFront page of the user, or of any teammate in that chain, could fake such a verification.
- **Website content** - YES. Player names, clan tags, lobby settings and game ids are read from openfront.io pages, and, during a game, map ownership, players' names, colours and land share, the user's team roster and emoji messages between teammates (read locally). With the team chat on, the user's player slot, the keys of teammates they verified and short verification handshakes go to the chat relays.
- **User activity** - NO. (No clicks, keystrokes, scrolling or network monitoring are collected.)
- **Web history, Location, Authentication information, Health, Financial** - NO. (IP addresses are visible to the contacted services as with any request, but the extension does not collect or transmit location.)

## Certifications - tick all three

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

(The transfers to api.ofstats.io, OpenFront's API and the Nostr relays are the approved case "necessary to provide the item's single purpose", are disclosed before use and require the user's agreement.)

## Privacy policy URL

https://github.com/devdanetra/openfront-pro/blob/main/PRIVACY.md

## Test instructions (paste into the Test instructions tab)

No account or login is needed.
1. After install a first-run page opens ("before you start"). Press "I agree - turn rank lookups on". Until then the extension looks nothing up; themes and layouts still work.
2. Open https://openfront.io . A small "PRO" button appears in the site header: it opens the statistics dashboard (search any player name, e.g. a name from the site's leaderboard).
3. Click any public lobby card on the front page to enter a waiting lobby: rank badges appear next to player names, with a lobby summary line and a map preview. Hover a badge for details; click it for that player's statistics.
4. Extension popup (toolbar icon): themes, website layouts, feature switches, watchlist, a status readout.
5. Chat is OFF by default. To test: popup > Chat > tick the box > a consent panel appears > "I agree - turn chat on". In a lobby a "Chat" tab then appears at the left edge. It is paused while you are alive in a free-for-all game.
Notes for the reviewer:
- src/page-probe.js runs in the page's main world only to READ lobby and game state (lobby settings, the map ownership picture for the local timelapse, the team roster and teammates' emoji messages for team-chat verification); it never writes game state and never sends input to the game.
- src/vendor/nostr-crypto.js is an unminified bundle of the MIT libraries @noble/curves and @noble/hashes, used to sign and verify chat messages and, for the team channel, for ECDH key agreement (AES-GCM and HKDF come from the browser's WebCrypto); tools/build-vendor.mjs in the public repository rebuilds it.
- The extension is unofficial and says so in its name's description, popup, first-run page and screenshots.
- Source: https://github.com/devdanetra/openfront-pro
