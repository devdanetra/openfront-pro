# Privacy tab - text to paste

## Single purpose

Unofficial companion for the browser game at openfront.io: it shows public player statistics and scouting information on the game's own pages (rank badges in lobbies and in game, lobby and map summaries, a statistics dashboard and a post-game recap), with optional appearance settings for those pages and an optional chat between users of the extension in the same game. It works only on openfront.io.

## Permission justifications

**storage** - Saves the user's settings, agreement flags and watchlist (chrome.storage.sync), a short-lived cache of looked-up public statistics, today's session results and the chat mute list (chrome.storage.local), and a throw-away per-game chat key (chrome.storage.session). Nothing is stored anywhere else.

**scripting** - Injects the extension's own packaged content scripts and stylesheets into openfront.io tabs that were already open when the extension was installed, updated or re-enabled, and when the user presses "Enable on openfront.io" after restricting site access. One packaged file, src/page-probe.js, is injected into the page's main world to READ state that only exists there (the lobby's selected map, countdown, lobby id and the player's public per-game client id, from the game's own custom elements). It sends no input to the game. No remote code is ever injected.

**notifications** - Shows one desktop notification when a player on the user's own watchlist joins the lobby while the OpenFront tab is in the background. Off when "sound and notification" is switched off.

**clipboardWrite (optional permission)** - Requested only when the user ticks "Copy scouting report at 10s on the countdown", which writes the lobby scouting report to the clipboard without a click. Never requested otherwise; all other copy buttons use the standard user-gesture clipboard API.

**Host permission https://openfront.io/* and https://*.openfront.io/*** - The only site the extension works on: content scripts read player names and lobby state there and draw the badges, panels and themes. The wildcard covers the game's own subdomains, including its public API (api.openfront.io) used to read the public record of a finished game for the recap.

**Host permission https://api.ofstats.io/*** - The service worker fetches public player and clan statistics from this third-party community API. It sends no CORS headers, so the request cannot be made from the page. Player names from the user's lobby are sent there, after the user's consent on the first-run page.

## Remote code

No, I am not using remote code. All JavaScript is inside the package. src/vendor/nostr-crypto.js is an unminified bundle of @noble/curves 1.9.7 and @noble/hashes 1.8.0 (MIT), reproducible with tools/build-vendor.mjs in the public repository. WebSocket connections to Nostr relays carry chat data only, never code.

## Data usage - tick these

- **Personally identifiable information** - YES. The user's OpenFront username (and other players' usernames visible in the lobby) is sent to api.ofstats.io for statistics, and to the chat relays if chat is on.
- **Personal communications** - YES. Opt-in chat messages typed by the user are transmitted through public Nostr relays.
- **Website content** - YES. Player names, clan tags, lobby settings and game ids are read from openfront.io pages.
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
- src/page-probe.js runs in the page's main world only to read lobby state from the game's own custom elements; it never sends input to the game.
- src/vendor/nostr-crypto.js is an unminified bundle of the MIT libraries @noble/curves and @noble/hashes, used to sign and verify chat messages; tools/build-vendor.mjs in the public repository rebuilds it.
- The extension is unofficial and says so in its name's description, popup, first-run page and screenshots.
- Source: https://github.com/devdanetra/openfront-pro
