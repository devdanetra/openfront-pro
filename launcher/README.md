# Companion launcher - OpenFront Pro on the Steam build

The Steam version of OpenFront is an Electron app, and Electron apps cannot load
browser extensions. This launcher runs the **same extension code** against the
Steam build from the outside, through Chromium's DevTools protocol. It changes
**no file** of the game.

> **Status: experimental.** The launcher's own parts are tested (the extension's
> worker running under Node, the local settings server and its guards). Attaching
> to the live game window has not been verified yet - expect rough edges, and
> report what you see.

## Read this first

- **OpenFront's terms restrict third-party software.** This does what the
  browser extension does - reads the game's pages and draws panels, never sends
  a game action - but on a paid, account-linked Steam copy the risk is yours.
- **A debugging port is a door.** While the game runs with
  `--remote-debugging-port`, any program on *this computer* can drive the game
  window. Chromium binds the port to 127.0.0.1 only, so it is not reachable from
  the network. Do not use this on a shared or untrusted machine.
- The map preview may not work here: the Steam build ships its map files inside
  the app instead of fetching them from the CDN.

## Use

Needs [Node.js](https://nodejs.org) 22 or newer. Steam must be running.

```bash
node launcher/openfront-pro-launcher.mjs
```

(or double-click `launcher/run.cmd` on Windows). It starts OpenFront through
Steam with the debugging flag, waits for the game window and attaches. On the
first run your browser opens the same "before you start" page the extension
shows on install: nothing is looked up until you agree there.

Settings open in your normal browser (the game window cannot host extension
pages): press **Settings** in the Pro card / dashboard, or open the address the
launcher prints. Settings live in
`%APPDATA%\openfront-pro-launcher\storage.json`, separate from the browser
extension's.

If Steam asks whether to allow launch parameters, allow it. If the game starts
without the port (the launcher says so after a minute): close the game, put

```
--remote-debugging-port=9322
```

into *Steam > OpenFront > Properties > General > Launch options*, start the game
normally and run `node launcher/openfront-pro-launcher.mjs --attach`.

## How it works

| Browser extension | Here |
|---|---|
| content scripts in an isolated world | the same files, injected with `Page.addScriptToEvaluateOnNewDocument` into a named isolated world |
| `src/page-probe.js` in the page's main world | the same file, injected into the main world |
| service worker (`src/background.js`) | the same file in a `node:vm` context, behind a stand-in for `chrome.*` |
| `chrome.runtime` messages and ports | a CDP binding one way, `Runtime.evaluate` the other |
| `chrome.storage` | a JSON file (`session` stays in memory) |
| popup / first-run page | served on `127.0.0.1` behind a random token, opened in your browser; other origins and other hosts are refused |

The game's window loads its bundled client from `app://openfront/` with no
content-security policy, which is why styles and panels can be added the same
way as on the website. The launcher skips the splash, login gate and tutorial
pages (`/__…`).
