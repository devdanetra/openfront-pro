# Team chat: how teammates are verified (protocol v1)

OpenFront Pro has no server. Its chat runs over public Nostr relays, in one public
room per game (`src/nostr.js`: ephemeral kind 20787, a throw-away signing key per
room that lives in the extension's service worker). This document describes the
team channel built on top of it: message text encrypted to the keys of
teammates verified through the game (by you, or through a chain of teammates
who verified each other, at most 8 vouching levels - see Trust), from senders
that were proven to be the players they claim to be. Only the text
is encrypted; everything else the channel sends is public (see Events).

Code: `src/team.js` (all of the logic, no I/O), `src/background.js` (relay and
storage glue), `src/page-probe.js` (`teamFeed`: what the game says), `src/chat.js`
(the Team tab). Tests, including the attacks below: `node tools/test-team.mjs`.

## The problem

OpenFront is a lockstep simulation: every client holds the whole game state, so
there is nothing in the game that teammates know and enemies do not. A room key
derived from the game id and the team name would be computable by everyone.

The only thing an enemy cannot do is **act in the game as one of your teammates**:
the game server stamps every in-game action with the connection it came from. So a
teammate proves who they are by doing something visible in the game that only
they can do and that nobody could have predicted: sending three emojis, which
the two extensions agreed on, **to the teammate who is checking**.

The extension never sends anything into the game. The player clicks the emojis
in the game's own emoji menu; the extension only reads the emoji messages in its
local copy of the game. And nothing asks a player to do so unless that player
pressed **Verify** first.

## Threat model

Attackers: enemy players (possibly running a modified extension or client), anyone
connected to the public relays, the relays themselves. They can read, drop, delay,
replay and inject relay traffic, claim to be any player, use any number of keys,
and see the whole game state including every emoji anyone sends to anyone.

Out of scope:
- a malicious **teammate** - anyone trusted, directly or through the chain -
  entitled to read the channel, can leak it, and can vouch for an outsider, who
  then receives every team message too;
- **any script running in OpenFront's own page** - OpenFront's code, or the
  third-party ad scripts the site loads - and any other extension that can
  touch the page. The roster and the emoji feed come from the page's game
  object, and `page-probe.js` hands them over with `window.postMessage`, which
  such a script can also post. A script that fakes that feed can make a key of
  its choosing look verified as a teammate once the user presses Verify on it,
  and then read the team channel. That holds for the page of any teammate in
  the trust chain too: a key verified there is trusted by everyone who trusts
  that teammate, with no click of theirs. No code on the extension's side can
  fully prevent this: the game objects belong to the page's own JavaScript realm;
- a compromised browser; traffic analysis (who takes part, which slot each key
  claims, who verified whom, which keys each message is encrypted to, and when
  and how long each message is are all public);
- denial of service (anyone can flood a public relay room);
- a teammate **talked into** sending three emojis to you by someone outside the
  extension (voice chat, Discord). The panel says never to do that, and shows no
  emoji from anyone else in the public tab during team games (whether or not the
  reader's own team channel is on), but it cannot stop a person.

Goals (against the attackers above, not what is out of scope):
1. Confidentiality: a non-teammate cannot read team messages.
2. Authenticity: a message shown as coming from teammate P was written by someone
   controlling player P in this game (or by someone vouched for through a chain
   of verified teammates).
3. Read-only: the extension performs no game action, and causes none without a
   click on Verify by the player who then performs it.

## Pieces

### Identity
`K` = the per-room Nostr key (BIP-340 x-only public key, secp256k1). The same key
does ECDH: the x-only key is lifted to the even-Y point, and only the 32-byte X
coordinate of the shared point is used (it is the same for either Y).

Players are named by `smallID` (`sid`): assigned at game start, never reused,
identical on every client. **teammate(sid)** means: a HUMAN player in my local
game view, on my team, and **not me** (`sid !== mySid` - the game's own
`isOnSameTeam()` is true for myself, and a stranger claiming to be me would
otherwise be "verified" by the emojis I send myself). Whether a sid is a teammate
is decided only by the local game view, never by anything from the network. A key
speaks for one sid: the first it named.

### Events
Ordinary signed room events (same kind, room tag, signature and clock checks as
the public chat), with `x` = one of the types below and a JSON body of at most
4096 characters. Keys, ids, numbers and ciphertexts are lowercase hex.

| `x`       | body                                   | meaning |
|-----------|----------------------------------------|---------|
| `t-hello` | `{v, sid, direct:[{k,sid}], deny:[k]}` | "this key is player `sid`" (a claim; proves nothing), the keys I verified **myself** (at most 24), and keys that claimed to be **me** (at most 16). Sent with no click as soon as the game feed first names my sid (spawn phase included), then about every 45 s (checked on each game-feed report, about once a second, and on the 20 s keep-alive), right after a verification or a key claiming to be me, and 1.5 s after a new claimant appears or a trusted sender's message had no entry for me (at most every 8 s). Repeated because relays are not meant to store events. |
| `t-init`  | `{v, to, pid, sid, peer, c}`           | I pressed Verify on key `to` (player `peer`). `pid` = 8 random bytes; `c` = commitment to my 32 random bytes `nI`. Re-sent every 5 s until answered (60 s). |
| `t-resp`  | `{v, to, pid, n}`                      | the other side pressed Verify too: its 32 random bytes `nR`. Re-sent until `t-open` arrives (25 s). |
| `t-open`  | `{v, to, pid, n}`                      | reveals `nI`. Sent once, and again only in answer to a repeated identical `t-resp`. |
| `t-msg`   | `{v, iv, ct, to:{<first 16 hex of key>: wrap}}` | encrypted team message. The recipients' key prefixes and the length of `ct` are readable by everyone. |

Hashes are SHA-256 over `JSON.stringify` of an array of strings and integers, so
no field can run into the next:

    c   = H(["ofpro-commit-v1", room, pid, KI, sidI, KR, sidR, nI])
    SAS = H(["ofpro-sas-v1",    room, pid, KI, sidI, KR, sidR, c, nI, nR, 60])

`room` is the hashed game id. The first 8 bytes of SAS, as a big-endian integer
(BigInt) modulo 56^3, give three indexes into the 56 "polite" entries of
OpenFront's 60-entry emoji table (the middle finger, clown, thumbs-down and rat
are never asked of anyone): 175 616 sequences.

### Pairing
1. Alice presses **Verify** next to Bob's key -> `t-init`. Bob's extension shows
   "asks to verify" and **says nothing on the relay**: no number of Bob's exists
   until Bob clicks.
2. Bob presses **Verify** on Alice's key -> `t-resp` with a fresh `nR`. A pairing
   id is answered once, ever. If both pressed at the same moment, the request of
   the smaller key goes ahead.
3. Alice's extension takes the FIRST valid `t-resp` (a later, different one is
   ignored), computes the SAS, sends `t-open`. Bob's checks the commitment (a
   mismatch ends the pairing) and computes the same SAS.
4. Both panels show the three emojis. Each player sends them **to the other
   player** (hold the emoji key - Alt by default - and click their territory), in
   order. The game allows one emoji per recipient every 5 s; the panel counts down.
5. Each extension watches, in its local game view, the emoji messages **from the
   peer's sid to my sid**. If three consecutive ones are exactly the SAS, all
   created at a game tick >= the pairing's start tick, within 150 s, the peer's
   key is **verified directly**. A wrong emoji in between just means "send the
   three again", but the run must lie within the first 9 emojis the peer sent
   me since the pairing started: once 9 have arrived without it, the pairing
   ends.
   Emojis to other players, broadcasts, and anything sent before the start tick
   never count. Nothing is judged while the client is catching up or replaying,
   and nothing starts during the spawn phase.
6. The verifier publishes `t-hello` with the new key in `direct`. The pairing is
   complete for me when I verified the peer **and** the peer's `t-hello` lists my
   key; if I sent my three and that does not happen, the panel says so.

Start tick: for the responder, its local tick when it sent `t-resp` (from then on
the SAS is fixed, and nobody could know it before); for the initiator, its local
tick when it processed `t-resp`.

Why this holds: `nI` is committed before `nR` exists, and `nR` is chosen before
`nI` is revealed, so to anyone - either side, or a man in the middle running two
pairings - the SAS is a uniformly random value they cannot steer. The SAS is not
secret (everything on the relay is public); what counts is that only the real
player can make their player send it to me, after it was fixed. An impostor gets
one blind guess per **click of the victim**: about `r / 175 616`, where `r` is the
number of 3-emoji windows the real player happens to send to the victim in those
150 s (normally zero). An initiator can look at the SAS before revealing and give
up - but it only ever gets a number from the victim after the victim's own click.

### Trust
- **direct**: keys I verified through the game. Several keys per player are fine
  (a teammate who came back on another browser verifies again).
- **vouched**: level by level from the direct keys (at most 8 levels), the
  `direct` lists of trusted keys. A vouched key is trusted like a direct one,
  as a sender and as a recipient: a teammate I verified - or anyone further
  along the chain - can therefore let someone else read the channel by vouching
  for them.
  Accepted only for a teammate(sid) that has no trusted key yet, never for
  my own sid, never for the voucher's own sid; if two different keys are proposed
  for one player at the same level, neither is believed; and a key that anyone
  claiming to be that player lists in `deny` is not believed on hearsay either.
  ("Verify that player yourself" always works.)
- A team therefore needs a chain of N-1 pairings, not every pair; a late joiner
  pairs once with any verified member.
- If a foreign key claims **my** sid, my extension refuses it, warns me, and
  lists it in `deny` from then on.

Names shown in the team tab come from the local game view for the verified sid -
never from the network.

Saved per room in `chrome.storage.session` (gone when the browser closes; only
the service worker reads it, in the companion launcher too): the direct list,
used pairing ids, the newest message time per sender, and keys that claimed to
be me. A pairing in flight is not saved: after a worker restart, press Verify
again.

### Messages
Recipients: trusted keys (direct and vouched) heard from in the last ~110 s,
direct ones first, at most 12 (the sender is told how many were left out). For
each message: random 32-byte `mk`, random 12-byte `iv`;

    ct   = AES-256-GCM(mk, iv, utf8(JSON{text, sid, ts}), aad = ["ofpro-team-msg-v1", room, senderKey])
    kek  = HKDF-SHA256(ikm = X(ECDH(k, Kr)), salt = room, info = "ofpro-team-v1")
    wrap = iv' ‖ AES-256-GCM(kek, iv', mk, aad = ["ofpro-team-wrap-v1", room, senderKey, Kr])

A receiver only looks at events signed by a trusted key, unwraps its own entry,
decrypts, and requires `sid` to be the sender's verified sid, `ts` within 120 s
of now and newer than the last message shown from that key (replays). A message
from a trusted sender with no entry for me means "they have not verified me yet":
the panel says so instead of showing nothing.

No forward secrecy beyond the fact that every key is per game and session-only.

## What was reviewed
The draft of this protocol was attacked from four angles (protocol, game
mechanics at the deployed tag, trust/abuse, implementation) before the code was
written. What changed because of it: my own sid is never a teammate; both sids
and the commitment are inside the hashes; first-answer-wins and one answer per
pairing id; nothing happens without a click on either side (the draft started
pairings by itself and rationed answers instead); emojis must be addressed to
the verifier (the draft accepted any recipient - which also meant broadcasting
insults and white flags to a whole lobby); sliding-window matching with a cap;
completion is acknowledged; claims are re-announced because relay events are not
stored; one vouched key per player.
