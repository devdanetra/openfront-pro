# Companion launcher - OpenFront Pro on the Steam build

The Steam version of OpenFront is an Electron app, and Electron apps cannot load
browser extensions. This launcher runs the **same extension code** against the
Steam build from the outside, through Chromium's DevTools protocol. It changes
**no file** of the game and never sends a game action.

> **Status: experimental.** Tested: the extension's worker running under Node,
> the local settings server and its guards, and the whole page bridge against a
> real Chromium (`node tools/test-launcher-bridge.mjs`). **Not yet verified:
> attaching to the live game window.** Expect rough edges and report what you see.

## Read this first

- **OpenFront's terms restrict third-party software.** This does what the
  browser extension does - reads the game's pages and draws panels - but on a
  paid, account-linked Steam copy the risk is yours.
- **A debugging port is a door, and it stays open until the GAME closes** - not
  just while the launcher runs. While it is open, any program running on *this
  computer* can control the game window and read what is in it, including the
  game's login token. Chromium binds the port to 127.0.0.1, so it is not
  reachable from the network. Do not use this on a shared or untrusted machine.
- If you ever put `--remote-debugging-port` into the game's Steam launch
  options (the manual fallback below), **remove it when you stop using the
  launcher**, or the door stays open every time you play.
- Windows builds are **not code-signed** (that needs a paid certificate).
  SmartScreen will say "unknown publisher"; some antivirus tools dislike an
  unsigned program that attaches a debugger to a game. The portable zip uses the
  unmodified, signed `node.exe` from the Node.js project plus readable script
  files, if you prefer that. Check downloads against `SHA256SUMS.txt`.

## Use

Steam must be running.

- **Single file:** run `OpenFrontPro-Launcher-<version>.exe`.
- **Portable zip:** unzip anywhere, run `Start.cmd`.
- **From source:** `node launcher/openfront-pro-launcher.cjs` (Node.js 22+), or
  `launcher/run.cmd`.

It starts OpenFront through Steam with the debugging flag, waits for the game
window and attaches. If Steam asks whether to allow launch parameters, allow it.
A console window shows what it is doing; closing it detaches (the game keeps
running). Only one launcher runs at a time.

On the first run your browser opens the same "before you start" page the
extension shows on install: nothing is looked up until you agree there.
**Settings open inside the game**: press *Settings* in the Pro card or the
dashboard and the same settings page appears as an overlay in the game window.
(Chat, and its free-for-all switch, can only be switched **on** - with chat's
own "I agree" - on the launcher's settings page in your normal browser, at the
address the launcher prints; in the game window they can only be switched off,
because a script in the game's page could cover the overlay and steer a click.
That page lives on 127.0.0.1 behind a random address that changes every run;
other websites cannot read or change it. The scouting report's auto-copy can be
switched on in the game window too: the game window writes the clipboard
without a browser permission.)

Settings, agreement flags, the watchlist, your public player id, today's
results, games waiting for their record, the chat mute list, the last
diagnostic report shown in the settings (it can list player names from the last
scan that had no statistics) and a few interface preferences are stored in
plain text in `%APPDATA%\openfront-pro-launcher\storage.json`, separate from the
browser extension's (plus `launcher.lock` while the launcher runs, and a
`storage.json.corrupt-<time>` copy if the file was ever found damaged). The rank
cache, the chat keys and the team-channel state stay in memory. The launcher is
portable: deleting the exe or the zip's folder does **not** remove
`%APPDATA%\openfront-pro-launcher` - delete that folder yourself to remove the
data. The game's own files are never written.

### If the game starts without the port

The launcher says so after a minute. Close the game, put

```
--remote-debugging-port=9322
```

into *Steam > OpenFront > Properties > General > Launch options*, start the game
normally, then run the launcher with `--attach`. Remember the warning above about
removing it afterwards.

## What does not work here

- The map preview: the Steam build ships its map files inside the app instead of
  fetching them from the CDN.
- Desktop notifications for the watchlist (the sound still plays while *Sound
  and notification* is on).
- macOS / Linux: untested. The code has branches for them, but the Steam launch
  is Windows-only; start the game yourself with the flag and use `--attach`.

## How it works

| Browser extension | Here |
|---|---|
| content scripts in an isolated world | the same files, injected with `Page.addScriptToEvaluateOnNewDocument` into a named isolated world of the main frame only |
| `src/page-probe.js` in the page's main world | the same file, injected into the main world |
| service worker (`src/background.js`) | the same file in a `node:vm` context, behind a stand-in for `chrome.*` |
| `chrome.runtime` messages and ports | a CDP binding one way, `Runtime.evaluate` of JSON *data* the other |
| `chrome.storage` | a plain JSON file, written atomically (the rank cache stays in memory; so does `session` - chat signing keys, team-channel state - which only the worker can read, never the game window or the settings page) |
| popup / first-run page | served on `127.0.0.1` behind a random token with a strict CSP; other hosts, origins and frames are refused |

The game's window loads its bundled client from `app://openfront/` with no
content-security policy, which is why styles and panels can be added the same
way as on the website. The launcher skips the splash, login gate and tutorial
pages (`/__…`). The page's own scripts can see neither `chrome.*` nor the bridge.

## Build the downloads

```bash
node tools/build-launcher.mjs
```

writes `dist/OpenFrontPro-Launcher-<version>.exe` (Node's single-executable
format: `node.exe` + the launcher + the extension's files as embedded assets),
the portable zip and `SHA256SUMS.txt`. It needs the pure-JS build helpers in
`.vendor-build` (`npm i --ignore-scripts postject resedit pe-library`).
