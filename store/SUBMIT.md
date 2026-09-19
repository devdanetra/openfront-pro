# Publishing OpenFront Pro on the Chrome Web Store

Everything to paste is in this folder. The steps that only you can do are marked
**YOU**. Facts below were checked against Google's pages on 2026-09-18.

## 0. Before you start (YOU)

1. A Google account with **2-Step Verification on** (required to publish).
   The account e-mail cannot be changed later and is shown to users as the
   contact, so use one you are happy to expose and that you check.
2. Register at <https://chrome.google.com/webstore/devconsole>: accept the
   developer agreement and pay the **one-time registration fee** (US$5 at the
   time of writing).
3. In *Account*: set a publisher name, verify the contact e-mail, and answer the
   EU trader / non-trader declaration (a hobby project with no revenue is
   normally *non-trader*).

## 1. Upload

*Add new item* -> upload **`openfront-pro-5.11.0.zip`** (built by
`node tools/pack.mjs`; manifest at the root, 27 files including `src/team.js`
and `src/timelapse.js`, no tools/tests). Do **not** upload an older zip: 5.6.x
still asks for permissions that were removed for the store, and the privacy
texts in this folder describe 5.11.0.

## 2. Store listing tab -> `LISTING.md`

- Description, category, language: paste from `LISTING.md`.
- Store icon: `store/store-icon-128.png` (96px artwork + 16px padding).
- Screenshots: `screenshot-1.png` ... `screenshot-5.png` (1280x800).
  They are composed by `python tools/make-store-images.py` from the curated
  captures in `.shots/final/` (lobby badges, dashboard, recap tabs, the nine
  themes, overlay + clan hub + tournaments). `screenshot-1.png`'s lobby is the
  local fixture dressed as a lobby with made-up players; a capture of a real
  lobby from your own browser would still be the better first image.
- Small promo tile: `promo-small-440x280.png`.
- Homepage URL: `https://github.com/devdanetra/openfront-pro`
- Support URL: `https://github.com/devdanetra/openfront-pro/issues`
- Official URL: leave empty (never claim openfront.io).
- Mature content: No.

## 3. Privacy tab -> `PRIVACY-TAB.md`

Single purpose, one justification per permission, "No, I am not using remote
code", the data-usage ticks, the three certifications and the privacy policy
URL. All the text is in `PRIVACY-TAB.md`. **Do not tick "does not collect user
data"** - usernames and chat count as user data, and a mismatch between this
tab, the policy and the code is itself a violation.

## 4. Distribution tab

Free, public, all regions. Consider unticking *publish automatically* so you
choose the moment after approval (you then have 30 days).

## 5. Test instructions tab -> `PRIVACY-TAB.md` (last section)

Paste the reviewer notes. They explain the first-run consent page, that chat is
off, how to reach a lobby without an account, the MAIN-world probe and the
vendored crypto bundle.

## 6. Submit (YOU)

Review usually takes a few days, up to a few weeks for a new developer + new
item. Answer support mail within 3 business days.

## Known risks you chose to keep

- **Name "OpenFront Pro" and the PRO tag under the site's OPENFRONT logo.** The
  audit rated this the most likely cause of a rejection ("impersonation") or of
  a later trademark complaint by OpenFront, because "Pro" reads like the game's
  own paid tier. The listing, the popup, the first-run page and every screenshot
  say "unofficial", which helps. If it is rejected for this, the fix is a rename
  to the "X for OpenFront (unofficial)" pattern (`manifest.json` `name`, the
  popup title, `installNavButton()` in `src/content.js` has a plain-pill
  fallback already) - about ten minutes.
- **Chat** is user-generated content on third-party relays. It is off by
  default, behind its own consent, masked and mutable (the in-panel Report link
  was removed in 5.9; abuse reports go through the repository's issue page named
  in PRIVACY.md). Google has no written UGC rule for extensions, but a harassment
  complaint would land on you. It can be removed from a build by deleting `src/chat.js` from the
  manifest and the Chat block from `src/popup.html`.

## After it is live

- Every update: bump `version` in `manifest.json`, `node tools/pack.mjs`,
  upload, resubmit. Permission changes trigger a re-prompt for users and a
  slower review.
- Keep `PRIVACY.md` true. If the code starts sending anything new, the policy
  and the Privacy tab change first.
