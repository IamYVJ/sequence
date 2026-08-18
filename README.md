# Sequence — Five in a Row

A complete, **static** web implementation of the board-and-cards classic
*Sequence*. One player hosts from their own browser tab; everyone else joins with
a 4-character code on the same Wi-Fi. All game logic and authoritative state live
in the host's tab — **no backend, no accounts**. Everyone plays on their own
device, so your hand stays yours. Installable as a PWA that works offline (app
shell).

## How to play

The board shows every playing card **except the Jacks**, printed twice — 96
spaces plus 4 free ★ corners. On your turn you play one card from your hand,
cover a space that matches it with your team's chip, and draw a replacement. Five
of your team's chips in a straight line — across, down or diagonally — is a
**sequence**.

The Jacks are the special cards, and which Jack you hold matters:

| Card | Name | What it does |
| ---- | ---- | ------------ |
| **J♦ J♣** | Two-eyed Jacks | **Wild** — place a chip on any open space on the board. |
| **J♠ J♥** | One-eyed Jacks | **Remove** — lift one opponent chip off the board. |

Key rules the app enforces for you:

- The four **★ corners are free** — they count as a chip for every team, so a
  line through one needs only four real chips.
- A chip inside a **completed sequence is locked**: a one-eyed Jack can never
  remove it. Locked spaces are marked with a ✦.
- A new sequence may **reuse at most one chip** from a sequence your team has
  already completed.
- A card whose two spaces are both covered is **dead** and is marked as such in
  your hand. Select it and tap **Swap** to discard it and draw a fresh one — once
  per turn by default.
- A chip **hides the card printed under it**. Tap the chip to lift it for a
  moment, or use **Peek cards** to hold the whole board open — that's how you
  check whether both spaces for a card in your hand are already gone. Selecting a
  one-eyed Jack reveals every chip it could lift for free, since that is the
  moment the hidden card decides the move.
- **Pass** is only offered when you genuinely have no legal move and no dead card
  to swap, so a hand of unplayable one-eyed Jacks can't deadlock the game.

Teams follow the seating order (teammates are never seated next to each other),
exactly as they do around the physical board — so play always alternates between
teams. Player count, team count and hand size come from the official table:

| Players | Teams | Cards each |
| ------- | ----- | ---------- |
| 2  | 2      | 7 |
| 3  | 3      | 6 |
| 4  | 2      | 6 |
| 6  | 2 or 3 | 5 |
| 8  | 2      | 4 |
| 9  | 3      | 4 |
| 10 | 2      | 3 |
| 12 | 2 or 3 | 3 |

Two teams race to **two** sequences; three teams race to **one**. Counts not in
the table (5, 7, 11) can't split into equal teams and are rejected at the lobby.

**Host-configurable before the game starts:** number of teams (when the player
count allows a choice), whether to use the classic printed board or a freshly
**shuffled** one, and how many dead-card swaps are allowed per turn (default 1;
set 0 to switch swapping off).

## How it works

- **Networking:** WebRTC peer-to-peer via [PeerJS](https://peerjs.com/). Star
  topology, **host-authoritative**: the host owns all state, validates every
  intent, and sends each player the public board plus **only their own hand**.
- **Room codes:** the friendly 4-char code maps directly to the host's Peer ID
  (`localsequence-v1-<CODE>`), so joiners reconstruct it from the code — no
  discovery service needed.
- **One source of truth for legal moves:** `legalTargets()` in
  [`js/rules.js`](js/rules.js) is used both by the engine to validate a move and
  by the view to highlight spaces, so what you can tap and what the host accepts
  can never drift apart.
- **Signaling caveat:** PeerJS needs to reach a signaling *broker* once to set up
  the WebRTC handshake; after that, game traffic is direct P2P on the LAN. The
  default broker is PeerJS's public cloud (needs internet for that initial
  handshake). To play **fully offline on a LAN**, run your own broker and point
  the app at it — see [`js/net.js`](js/net.js) (`BROKER_CONFIG`). Losing the
  broker mid-game is survivable and says so on screen: existing connections are
  device-to-device, so only *new* joins stop working while the app retries.
- **No relay, so: same Wi-Fi.** There is no TURN server — a relay needs
  credentials and somewhere to run, which is the backend this project doesn't
  have. STUN alone connects devices that can reach each other directly, which is
  the design case. Symmetric NAT, mobile data and "client isolation" guest Wi-Fi
  will fail to connect with no error from either end, which is why a join attempt
  gives up after 12s and offers **Cancel** rather than spinning forever.
- **Reconnect:** rejoining with the same name and code reclaims your seat and
  your hand, and a host reload rehydrates the in-progress game from a saved
  snapshot. Because the host's Peer ID is derived from the room code, a host that
  reloads or blips off Wi-Fi comes back at the *same* address — so players retry
  automatically for ~30s behind a banner, keeping the board on screen, instead of
  being told the game is over.
- **Playable without a mouse or without sight:** the board is a single tab stop
  with a roving cursor — arrows move one space, Home/End run to the ends of a row,
  PageUp/PageDown to the ends of a column — and every space announces its
  coordinate, card, occupant, locked state and whether you can act there.
  Selecting a card parks the cursor on its first legal space. Chips carry a shape
  as well as a colour — plain, a bar, a centre dot — and the scoreboard dots
  repeat the same marks, so the board has a legend beside it and hue is never the
  only signal. The rules sheet is a modal dialog that traps Tab, closes on Escape
  and hands focus back where it came from.

## Hosting & joining on the same Wi-Fi

1. The **host** opens the site, enters a name, and taps **Host Game**. A
   4-character room code appears — share it with the table.
2. **Players** open the same site, enter a name, and either pick the host's game
   from the *Games on this network* list or type the 4-character code, then tap
   **Connect**.
3. Once the lobby holds a supported player count, the host taps **Deal & Start**.

> Everyone must be reaching the same URL 

## Project layout

```
index.html              app shell (loads PeerJS + fonts, registers SW)
manifest.webmanifest    PWA manifest (relative paths)
sw.js                   service worker — precaches the shell, cache-first
css/styles.css          dark card-table theme (ivory board on felt)
js/
  board.js              ← the 10x10 board: classic layout, shuffled layout,
                          cell naming and the 5-cell line geometry
  rules.js              ← ALL game-rule constants (cards, seating, limits) +
                          pure logic (legal targets, dead cards, sequences)
  state.js              host-authoritative game engine / state machine
  net.js                PeerJS networking (BROKER_CONFIG lives at the top)
  ui.js                 rendering (pure view layer)
  util.js               helpers (room code, clipboard, persistence, DOM)
  config.js             placeholder server-mode switch (unused in this build)
  main.js               controller wiring net + engine + UI together
icons/                  app icons (svg + generated png)
scripts/
  gen-icons.js          regenerates the PNG icons (node, no deps)
  test-engine.mjs       headless tests — game engine end to end, plus net.js's
                          broker recovery against a stub peer
package.json            npm test / npm run icons (no dependencies)
```

---

*Sequence* is a trademark of its respective owner. This is an unofficial,
non-commercial fan implementation for playing with friends.
