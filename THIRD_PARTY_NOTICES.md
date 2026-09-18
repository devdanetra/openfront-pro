# Third-party notices

OpenFront Pro is MIT licensed (see `LICENSE`). It bundles one third-party
component and talks to a few third-party services.

## Bundled code

`src/vendor/nostr-crypto.js` is an unminified bundle of:

- **@noble/curves** 1.9.7 - MIT License, (c) 2022 Paul Miller (paulmillr.com)
- **@noble/hashes** 1.8.0 - MIT License, (c) 2022 Paul Miller (paulmillr.com)

Only BIP-340 Schnorr, secp256k1 ECDH and SHA-256 are used: to sign and verify
chat messages, and to agree the keys that encrypt team-channel messages (AES-GCM
and HKDF come from the browser's WebCrypto). The bundle is reproducible:
`node tools/build-vendor.mjs` rebuilds it from the pinned npm packages and
refuses to install a result that fails BIP-340's first test vector. The licence
headers are kept inside the bundle.

## Services it talks to (none operated by this project)

- **ofstats.io** (`api.ofstats.io`) - community statistics for public OpenFront
  games; player names and clan tags from your lobby and game, and names you
  search for in the dashboard, are looked up there.
- **OpenFront** (`api.openfront.io`) - the game's own public API, for the record
  of a finished game; and its asset CDN, for the lobby's map preview.
- **Public Nostr relays** (`relay.primal.net`, `nos.lol`, `nostr.mom`,
  `relay.snort.social`) - only if you switch the chat on.

## Names

"OpenFront" is the name of the game this extension is a companion for. This
project is unofficial and is not affiliated with, endorsed by or sponsored by
OpenFront or its developers.
