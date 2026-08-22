# Sequence — Five in a Row

A complete, **static** web implementation of the board-and-cards classic
*Sequence*. One player hosts from their own browser tab; everyone else joins with
a 4-character code — easiest when everyone is on the same Wi-Fi, though it isn't
required. All game logic and authoritative state live in the host's tab — **no
game server, no accounts** — so the cards never leave the players' devices.
Everyone plays on their own device, so your hand stays yours. Installable as a PWA
that works offline (app shell).

There is an **optional** second way to play: point the app at a small
self-hosted server and the same game runs over the internet instead, so players
don't have to share a network and nobody's tab has to stay open. It is strictly
additive — [`js/config.js`](js/config.js) is the only thing that makes it exist,
and with no server configured (or with the server switched off) the app is
exactly the peer-to-peer game described above. See
[**Playing over the internet**](#playing-over-the-internet-optional-server).

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
- Selecting a card **lights up the spaces it can go**. A host who wants the table
  to read the board for itself can turn that off (see below); the rules don't
  change, and a tap on the wrong space says why it was wrong instead of doing
  nothing.
- The **last move is ringed** in the colour of the team that made it — dashed, so
  it never reads as a space you may play on — and pulses once as it lands, so you
  can see what changed while you were looking at your own hand. A one-eyed Jack's
  removal leaves a hollow chip outline behind, because otherwise the one move whose
  news is what *left* the board would have nothing to look at.
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

Everything above is the game as it comes in the box, and it is what you get if
the host changes nothing. The lobby can change any of it — see **Game modes**
below.

## Game modes

The host sets the rules in the lobby, before the deal. Every player sees the
choices as they are made, the start log records them, and the in-game rules sheet
describes *this* game rather than the official one — so nobody has to remember
which switches were flipped.

Three **presets** set several rules at once:

| Preset | What it is |
| ------ | ---------- |
| **Classic** | The game as it comes in the box. |
| **Quick** | Four in a row, one sequence wins, and the corners are no longer free. |
| **Hard** | Shuffled board, no highlights, and chips keep the card underneath hidden. |

A preset writes *every* rule, not just the ones it mentions, so switching from
Hard to Quick can't leave memory mode behind. Touch any individual switch
afterwards and the row reads **Custom**.

The individual rules, all of which sit under the preset row:

| Rule | Default | What it changes |
| ---- | ------- | --------------- |
| **Chips in a row** | 5 | The length of a sequence — 4, 5 or 6. |
| **Sequences to win** | Auto | Auto follows the official table (two teams need 2, three teams need 1). Set 1–3 to fix it regardless of team count. |
| **Free corners** | On | Off makes the ★ corners ordinary spaces: they stop counting as everyone's chip, so every line needs a full set of real chips, and a two-eyed Jack may cover one. The corner is drawn ☆ and unframed when this is off. |
| **Strict sequences** | Off | On means your two sequences may share **no** chip at all, instead of the official at-most-one. |
| **Cutthroat Jacks** | Off | On lets a one-eyed Jack lift **any** chip, including your own team's. Chips inside a completed sequence stay locked either way. |
| **Dead-card swaps** | 1 | How many dead cards you may swap per turn; 0 switches swapping off. |
| **Highlight matching spaces** | On | Off stops the board pointing at the answer (see below). |
| **Shuffle the board** | Off | On deals a fresh random layout instead of the classic printed one. |
| **Memory mode** | Off | On means chips never reveal what is under them: no tap-to-peek, no **Peek cards**, no free reveal when you hold a one-eyed Jack, and the screen reader says "card hidden" instead of naming it. You have to remember which cards are gone. |

Two of these interact, and the lobby says so on screen rather than quietly fixing
it for you: **four in a row with free corners** means a line through a corner
needs only three real chips, which is very fast. Turn free corners off if you
pick length 4 — which is exactly what the Quick preset does.

**Sequences to win** stays on *Auto* by default for a reason: the team count is
re-derived every time somebody joins or leaves the lobby, so a number you fixed
while there were four players could quietly contradict the official table once a
fifth arrived. Auto follows the table; an explicit 1–3 overrides it and stays put.

One honest limit on memory mode: the move feed still names the last handful of
plays, including which card went where. It keeps only the most recent 14 lines,
so it is short-term table talk rather than a transcript — over a full game you
are still remembering, not reading.

Whatever the host picks, every player's rules sheet describes **that** game — the
line length, who the Jacks can hit, whether the corners are free — so nobody is
reading the official rules for a game that isn't being played.

Turning the highlights off is a house rule about what the app tells you, never
about what it allows: the engine computes the same legal moves either way. What
goes with the ring is everything else that was pointing at the answer — the
one-eyed Jack's free reveal, the keyboard cursor jumping to the first legal
space, and the screen reader's "press to play here" — because leaving any one of
them in would just move the answer somewhere else, or hand it to some players and
not others. Peeking under a chip stays, since it only shows what is printed on
the board anyway.

## How it works

- **Networking:** WebRTC peer-to-peer via [PeerJS](https://peerjs.com/). Star
  topology, **host-authoritative**: the host owns all state, validates every
  intent, and sends each player the public board plus **only their own hand**.
- **One engine, two transports.** Every tap becomes the same little intent object
  (`{ type: 'playCard', … }`), and the only question is where it is applied:
  in the host's own tab, or on a server across a WebSocket. Both sides route it
  through the same dispatcher in [`js/intents.js`](js/intents.js) against the same
  [`js/state.js`](js/state.js) engine, so there is no second implementation of the
  rules to keep in step — the server literally imports the browser's engine.
- **Room codes:** the friendly 4-char code maps directly to the host's Peer ID
  (`localsequence-v1-<CODE>`), so joiners reconstruct it from the code — no
  discovery service needed.
- **One source of truth for legal moves:** `legalTargets()` in
  [`js/rules.js`](js/rules.js) is used both by the engine to validate a move and
  by the view to highlight spaces, so what you can tap and what the host accepts
  can never drift apart. The house rules ride along the same seam — the config
  travels inside the board view object, so a rule reaches validation, the
  highlights and the "can this player move at all?" check together or not at all.
- **Signaling caveat:** PeerJS needs to reach a signaling *broker* once to set up
  the WebRTC handshake; after that, game traffic goes device to device. The
  default broker is PeerJS's public cloud (needs internet for that initial
  handshake). To play **fully offline on a LAN**, run your own broker and point
  the app at it — see [`js/net.js`](js/net.js) (`BROKER_CONFIG`). Losing the
  broker mid-game is survivable and says so on screen: existing connections are
  device-to-device, so only *new* joins stop working while the app retries.
- **Wi-Fi is the reliable case, not the only one.** Nothing restricts a game to
  one network. The broker is public, so a room code is an address anyone can
  reach; STUN hole punching then connects players on different ISPs, and PeerJS's
  default relays cover most of what's left. What Wi-Fi buys you is *certainty* —
  "client isolation" guest networks and some corporate NATs still fail with no
  error from either end, which is why a join attempt gives up after 12s and
  offers **Cancel** rather than spinning forever. The optional server is the
  answer to that case, and it works by not using WebRTC at all: every client
  holds an ordinary WebSocket to it, so hostile NAT stops being anybody's
  problem.
- **A room is reachable from the internet, so it is guarded like it.** Both
  authoritative hosts — the browser tab and the server — apply the same bounds
  from [`js/guards.js`](js/guards.js) (per-connection rate limit, connection
  ceiling, frame size and shape) and the same identity rule from
  [`js/state.js`](js/state.js): mid-game a seat belongs to the joiner's secret
  `clientId`, never to the name printed above it. Two things a peer-to-peer game
  still exposes that server mode doesn't: cross-network WebRTC shows players each
  other's public IP addresses, and a relayed game passes through infrastructure
  that isn't yours (encrypted end to end, so it is forwarded and not read).
- **Reconnect:** rejoining with the same name and code reclaims your seat and
  your hand, and a host reload rehydrates the in-progress game from a saved
  snapshot. Because the host's Peer ID is derived from the room code, a host that
  reloads or blips off Wi-Fi comes back at the *same* address — so players retry
  automatically for ~30s behind a banner, keeping the board on screen, instead of
  being told the game is over.
- **Playable without a mouse or without sight:** the board is a single tab stop
  with a roving cursor — arrows move one space, Home/End run to the ends of a row,
  PageUp/PageDown to the ends of a column — and every space announces its
  coordinate, card, occupant, locked state, whether it was the last move and who
  made it, and whether you can act there.
  Selecting a card parks the cursor on its first legal space. Both of those last
  two track the highlight setting rather than legality, and in memory mode a
  covered space announces "card hidden" rather than naming the card — so a table
  playing a house rule is playing the same game on every device, and the rule
  never hands the withheld thing to some players for free. Chips carry a shape
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

> Everyone must be reaching the same URL — share the link, not a screenshot of
> the code.

## Playing over the internet (optional server)

Peer-to-peer has two limits that no amount of client code can fix: a direct
connection between two devices sometimes cannot be made at all, and the game lives
in the host's tab, so closing it ends the game. The optional server removes both. It is a small Node process —
four files, one dependency (`ws`) — that keeps rooms in memory and **imports the
browser's own game engine**, so it is the same rules, the same board, the same
house-rule switches, just applied on a machine that nobody has to keep a tab open
on.

### How the app decides which one to use

1. At boot the app probes the server once, with a 4-second timeout. Nothing about
   server mode is drawn until that answers.
2. If it answers, the home screen grows a **⬢ Host Online** button and the join
   screen lists open rooms on the server under **Games online**.
3. If it doesn't — no server configured, the server is down, no internet — the app
   says games run over Wi-Fi only and behaves exactly as it always did.
4. **Join** is one button for both kinds of game. A typed code is tried on the
   server first when the server is up; if the server has no such room, the app
   falls through to a peer-to-peer join on the same code. Players never have to
   know which sort of game they were invited to.

In server mode the room code carries a **⬢ Online** badge, and in Wi-Fi mode a
**⌂ Wi-Fi** one, so it is always visible on screen which transport is in play.

### What changes when the server is running the game

- **Nobody is the host.** The player who created the room is its *owner* — they
  get the lobby controls and the end-game buttons — but no browser holds the
  engine, so the owner closing their tab doesn't end anything. They rejoin and
  their hand is still there.
- **Identity is the device, not the name.** Each browser mints a random
  `clientId` on first run and keeps it in `localStorage`, and that is what reclaims
  a seat mid-game — on both transports, since a peer-to-peer room is reachable
  from the internet too. It never appears in the URL or on screen. The server
  additionally enforces it outside the engine, so its own seat map never depends on
  the engine getting it right.
- **Rooms expire.** Six hours idle, or 15 minutes with nobody in them, and the
  room is gone. Nothing is written to disk, ever — a restart is a clean slate.
- **A drop looks like a reconnect.** Losing the socket keeps the board on screen
  behind a *Lost the server — reconnecting…* banner and retries for ~30s, the same
  as losing a peer-to-peer host. A server restarting therefore looks like a blip
  rather than an ending.

## Project layout

```
index.html              app shell (loads PeerJS + fonts, registers SW)
manifest.webmanifest    PWA manifest (relative paths)
sw.js                   service worker — precaches the shell, stale-while-
                          revalidate (never caches the server probes, so a dead
                          server can't look alive from cache)
css/styles.css          dark card-table theme (ivory board on felt)
js/
  board.js              ← the 10x10 board: classic layout, shuffled layout,
                          cell naming and the line geometry (length is a knob)
  rules.js              ← ALL game-rule constants (cards, seating, limits) +
                          the house-rule defaults, limits and presets +
                          pure logic (legal targets, dead cards, sequences)
  state.js              host-authoritative game engine / state machine
  intents.js            ← the one intent dispatcher, shared by the browser host
                          and the server, so the rules can't fork
  guards.js             ← the bounds on anything from another device (rate limit,
                          frame shape, id and patch validation) — also shared,
                          because both hosts face the same internet
  net.js                both transports: PeerJS (BROKER_CONFIG at the top) and
                          the WebSocket client + the server liveness and room
                          list probes
  ui.js                 rendering (pure view layer)
  util.js               helpers (room code, clipboard, persistence, clientId, DOM)
  config.js             ← the server-mode switch: blank the URLs and server mode
                          does not exist
  main.js               controller wiring net + engine + UI together
server/                 the OPTIONAL authoritative server (nothing else needs it)
  index.js              HTTP endpoints + WebSocket bootstrap
  guards.js             origin allowlist, rate limit, frame validation (no deps)
  rooms.js              room registry, codes, ceilings and expiry
  session.js            seats, clientId identity and mid-game reclaim
  smoke.mjs             end-to-end checks over real sockets (see its header)
  Dockerfile            container image definition
  compose.yaml          container configuration
icons/                  app icons (svg + generated png)
scripts/
  gen-icons.js          regenerates the PNG icons (node, no deps)
  test-engine.mjs       headless tests — game engine end to end, plus net.js's
                          broker recovery against a stub peer
  test-server.mjs       headless tests — the wire protocol, the security guards
                          and a whole game played over a stub socket
.github/workflows/
  server.yml            CI for the server image
package.json            npm test / npm run icons (no dependencies)
```

---

*Sequence* is a trademark of its respective owner. This is an unofficial,
non-commercial fan implementation for playing with friends.
