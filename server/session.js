// ============================================================================
// session.js — One connection's worth of state, and the only place a message is
// allowed to turn into an engine call.
//
// THE SHAPE OF THIS FILE
//   Three transport-owned messages are handled here by name — createRoom, join and
//   lobbyQuery — because all three are about IDENTITY, and identity is exactly what
//   the two transports disagree about. Everything else is forwarded to
//   applyGameIntent() in js/intents.js, the same function the P2P host calls, so
//   the two authoritative hosts cannot drift on what `playCard` means.
//
// THE ONE RULE THAT MATTERS MOST
//   A seat is owned by a clientId — a secret random string in the joiner's own
//   localStorage — and never by a display name. Room codes are four characters and
//   the room list is public, so "type Alice's name into her game and take her hand"
//   has to be impossible rather than unlikely.
//
//   The engine now enforces this itself mid-game (state.js addPlayer), because the
//   P2P host turned out to face the same public internet this server does. The
//   fences below predate that and stay anyway: the engine's rule is one line in a
//   file that exists to serve two callers, and this transport should not be relying
//   on it.
//
//   It is made impossible structurally rather than by a check that could be
//   forgotten:
//     - A known clientId reclaims its OWN recorded playerId. No name is consulted.
//     - An unknown clientId is refused outright once the phase leaves the lobby,
//       so there is no mid-game path into addPlayer() at all.
//     - In the lobby, a name that is already at the table is refused BEFORE
//       addPlayer() is called, so the engine's reclaim-by-name branch is
//       unreachable from this transport and cannot be reached by accident later.
//   Three fences, and the innermost one means the engine's own behaviour is never
//   relied upon for security.
//
// Every handler is wrapped in a try/catch by handleFrame: a thrown error must cost
// one message, not the room.
// ============================================================================

import { PHASES } from '../js/state.js';
import { applyGameIntent } from '../js/intents.js';
import { cleanName } from '../js/rules.js';
import { CELL_COUNT } from '../js/board.js';
import { normalizeCode, CODE_LENGTH } from '../js/util.js';
import { send } from './rooms.js';
import {
  TokenBucket, decodeFrame,
  validClientId, validCardId, validPlayerId, validConfigPatch,
} from './guards.js';

// A name arrives before cleanName() has had a chance to bound it, so the raw
// string is length-checked first. 200 is generous for a 20-character field and
// still refuses a payload dressed up as a nickname.
const MAX_RAW_NAME = 200;

// Seats outlive their players in the lobby (a lobby dropout releases the engine
// seat but keeps the clientId's claim on it, so a returning device — and in
// particular a returning OWNER — comes back to the same playerId). That map would
// otherwise grow for as long as people churn through the lobby, so it is capped
// and orphaned entries are pruned. The owner's entry is never pruned: it is what
// makes engine.hostId recoverable.
const MAX_SEATS = 48;

// A refused message is dropped in silence — replying "too fast" to a flood would
// answer every packet of it, which is the amplification the bucket exists to
// prevent. Persistent refusal is not a slow client, though, it is a script, so
// after this many the socket goes.
const MAX_REFUSED = 120;

export class Session {
  constructor(ws, manager, opts = {}) {
    this.ws = ws;
    this.manager = manager;
    this.room = null;
    this.playerId = null;
    this.clientId = null;
    this.bucket = new TokenBucket(opts.rate || {});
    this.refused = 0;
    this.closed = false;
  }

  // -------------------------------------------------------------------------
  // Entry point. Takes a raw frame and returns nothing useful — every reply this
  // connection gets is written to the socket from in here.
  // -------------------------------------------------------------------------
  handleFrame(data, isBinary, now = Date.now()) {
    if (this.closed) return;

    // Rate limit BEFORE decoding. JSON.parse on a 64 KiB frame is real work, and
    // a flood that gets parsed before being refused is a flood that cost us
    // something.
    if (!this.bucket.take(now)) {
      this.refused += 1;
      if (this.refused > MAX_REFUSED) this.terminate(1008, 'Too many messages');
      return;
    }

    const msg = decodeFrame(data, isBinary);
    if (!msg) return;   // binary, unparseable, or not an object with a type

    try {
      this.dispatch(msg, now);
    } catch (err) {
      // A bug in a handler is ours, not the client's. Say nothing useful to the
      // wire, keep the socket, and let the room carry on.
      this.log('handler threw', err && err.message);
      send(this.ws, { type: 'error', message: 'Something went wrong with that action.' });
    }
  }

  dispatch(msg, now) {
    switch (msg.type) {
      case 'createRoom': return this.onCreateRoom(msg, now);
      case 'join':       return this.onJoin(msg, now);
      case 'lobbyQuery': return this.onLobbyQuery(msg);
      default:           return this.onGameIntent(msg, now);
    }
  }

  // -------------------------------------------------------------------------
  // Hosting
  // -------------------------------------------------------------------------
  onCreateRoom(msg, now) {
    if (this.room) return this.error('You are already in a game.');

    const clientId = validClientId(msg.clientId);
    if (!clientId) return this.reject('bad-client', 'This browser could not be identified.');
    const name = this.readName(msg.name);
    if (name === null) return this.reject('bad-name', 'Enter a name first.');

    const made = this.manager.create(now);
    if (!made.ok) return this.reject('server-full', made.error);
    const room = made.room;

    const playerId = room.newPlayerId();
    const seated = room.engine.addPlayer(playerId, name, { isHost: true, clientId });
    if (!seated.ok) {
      // Nothing else has touched this room yet, so the tidiest repair is to
      // forget it rather than leave an ownerless lobby on the list.
      this.manager.drop(room.code);
      return this.reject('bad-name', seated.error);
    }

    room.ownerClientId = clientId;
    room.claimSeat(clientId, playerId, name);
    this.bind(room, playerId, clientId, now);
    send(this.ws, { type: 'welcome', playerId, code: room.code, owner: true });
    room.broadcast();
  }

  // -------------------------------------------------------------------------
  // Joining, and the seat-ownership rules.
  // -------------------------------------------------------------------------
  onJoin(msg, now) {
    if (this.room) return this.error('You are already in a game.');

    const clientId = validClientId(msg.clientId);
    if (!clientId) return this.reject('bad-client', 'This browser could not be identified.');
    const name = this.readName(msg.name);
    if (name === null) return this.reject('bad-name', 'Enter a name first.');

    const code = normalizeCode(typeof msg.code === 'string' ? msg.code : '');
    if (code.length !== CODE_LENGTH) {
      return this.reject('bad-code', 'That room code is not valid.');
    }

    const room = this.manager.get(code);
    // 'no-room' is load-bearing on the client: it is the difference between "the
    // server is up and has never heard of this code" and "the server is down", and
    // the first of those is what makes it safe to fall back to a P2P join with the
    // same code instead of showing a dead end.
    if (!room) return this.reject('no-room', 'No game with that code on the server.');

    const seat = room.seats.get(clientId);
    if (seat) return this.reclaim(room, seat, clientId, name, now);

    // --- A device this room has never seen ---------------------------------
    // The mid-game fence. There is no name to compare, no seat to look up, and
    // nothing below this line that could seat a stranger into a running game.
    if (room.engine.phase !== PHASES.LOBBY) {
      return this.reject('in-progress', 'That game is already under way.');
    }
    if (this.nameTaken(room, name)) {
      return this.reject('name-taken', 'Someone in this game is already using that name.');
    }
    if (!this.makeSeatRoom(room, clientId)) {
      return this.reject('too-many', 'Too many devices have joined this room.');
    }

    const playerId = room.newPlayerId();
    const seated = room.engine.addPlayer(playerId, name, { clientId });
    if (!seated.ok) return this.reject('refused', seated.error);

    room.claimSeat(clientId, playerId, name);
    this.bind(room, playerId, clientId, now);
    send(this.ws, { type: 'welcome', playerId, code: room.code, owner: playerId === room.engine.hostId });
    room.broadcast();
  }

  /**
   * A device coming back to a seat it already owns.
   *
   * Two cases, and the difference is the phase the room was in when the socket
   * dropped. Mid-game the engine kept the seat and the hand, so this is a flag
   * flip. In the lobby the engine RELEASED the seat (an exact player count is what
   * lets Sequence split into equal teams, so a ghost seat would block the start
   * for everybody), so the player has to be re-added — at the very same playerId,
   * which is what keeps engine.hostId valid for a returning owner.
   *
   * Note what is NOT here: a rename. Letting a reclaim carry a new name would
   * route back into the engine's collision check and, worse, would make a name the
   * thing that decides a seat again. You come back as who you were.
   */
  reclaim(room, seat, clientId, name, now) {
    const player = room.engine.getPlayer(seat);

    if (player) {
      // Kick any socket still holding this seat. Its close handler will see that
      // the seat no longer points at it and will leave the seat alone — see
      // detach() — so this cannot knock out the connection that just arrived.
      const stale = room.sockets.get(seat);
      if (stale && stale !== this.ws) {
        send(stale, { type: 'rejected', reason: 'replaced', message: 'You joined this game from another device.' });
        try { stale.close(1000, 'Replaced'); } catch (_) {}
      }
      player.online = true;
      this.bind(room, seat, clientId, now);
      send(this.ws, { type: 'welcome', playerId: seat, code: room.code, owner: seat === room.engine.hostId });
      room.broadcast();
      return;
    }

    // Seat released in the lobby. Defensive: a released seat in any other phase
    // would mean the engine and this map disagree, and re-adding under those
    // circumstances is not something to guess at.
    if (room.engine.phase !== PHASES.LOBBY) {
      return this.reject('in-progress', 'That game is already under way.');
    }

    // The recorded name, not the one on this message. The one case where the
    // recorded name can fail is somebody else having taken it while the seat was
    // empty — names are unique at the table — and that is refused rather than
    // resolved, because resolving it would mean either renaming a stranger or
    // handing this device a seat under a name that is not the one it left with.
    const wasName = room.seatNames.get(seat) || name;
    if (this.nameTaken(room, wasName)) {
      return this.reject('name-taken', `Someone else is using the name ${wasName} now.`);
    }

    const wasOwner = clientId === room.ownerClientId;
    const back = room.engine.addPlayer(seat, wasName, { isHost: wasOwner, clientId });
    if (!back.ok) return this.reject('refused', back.error);

    this.bind(room, seat, clientId, now);
    send(this.ws, { type: 'welcome', playerId: seat, code: room.code, owner: seat === room.engine.hostId });
    room.broadcast();
  }

  // -------------------------------------------------------------------------
  // Lobby probe. Unauthenticated on purpose: it answers exactly what /rooms
  // answers, and a caller has to already know the code. Rate-limited like
  // everything else.
  // -------------------------------------------------------------------------
  onLobbyQuery(msg) {
    const code = normalizeCode(typeof msg.code === 'string' ? msg.code : '');
    const room = code.length === CODE_LENGTH ? this.manager.get(code) : null;
    send(this.ws, { type: 'lobbyInfo', info: room ? room.info() : null });
  }

  // -------------------------------------------------------------------------
  // Everything else: a game intent.
  // -------------------------------------------------------------------------
  onGameIntent(msg, now) {
    if (!this.room || !this.playerId) return;   // not seated; nothing to act as

    // Bound the payload before the engine sees it. This is about work and memory,
    // not legality — the engine already refuses an unknown card and an illegal
    // cell — so a failure here is silent junk rather than a message to the user.
    if (!withinBounds(msg)) return;

    const { handled, result } = applyGameIntent(this.room.engine, this.playerId, msg);
    if (!handled) return;

    this.room.touch(now);
    if (!result.ok) {
      send(this.ws, { type: 'error', message: result.error || 'That move is not allowed.' });
      return;
    }
    this.room.broadcast();
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  bind(room, playerId, clientId, now = Date.now()) {
    this.room = room;
    this.playerId = playerId;
    this.clientId = clientId;
    room.sockets.set(playerId, this.ws);
    room.touch(now);
  }

  /**
   * The socket closed. Release the seat — unless it has already been taken over,
   * which is how a reclaim from a second device avoids being undone by the first
   * device's close event arriving afterwards. The seat map is the single source of
   * truth for "whose socket is this", so comparing against it needs no extra
   * bookkeeping and cannot go stale.
   */
  detach(now = Date.now()) {
    this.closed = true;
    const room = this.room;
    const playerId = this.playerId;
    this.room = null;
    this.playerId = null;
    if (!room || !playerId) return;
    if (room.sockets.get(playerId) !== this.ws) return;

    room.sockets.delete(playerId);
    room.engine.markOffline(playerId);
    room.touch(now);
    room.broadcast();
  }

  terminate(code, reason) {
    this.closed = true;
    try { this.ws.close(code, reason); } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  /** null means "not a usable name". The raw length check comes first so a huge
   *  string is never handed to a regex-driven cleaner. */
  readName(raw) {
    if (typeof raw !== 'string' || raw.length > MAX_RAW_NAME) return null;
    const clean = cleanName(raw);
    return clean || null;
  }

  nameTaken(room, name) {
    const lower = name.toLowerCase();
    return room.engine.players.some((p) => p.name.toLowerCase() === lower);
  }

  /** Make space in the seat map if churn has filled it. Orphans only — a seat with
   *  a live engine player is somebody at the table — and never the owner's, which
   *  is the only thing that can restore engine.hostId. */
  makeSeatRoom(room, clientId) {
    if (room.seats.size < MAX_SEATS) return true;
    for (const [cid, pid] of room.seats) {
      if (cid === room.ownerClientId || cid === clientId) continue;
      if (room.engine.getPlayer(pid)) continue;
      room.dropSeat(cid);
      if (room.seats.size < MAX_SEATS) return true;
    }
    return room.seats.size < MAX_SEATS;
  }

  reject(reason, message) {
    send(this.ws, { type: 'rejected', reason, message });
  }

  error(message) {
    send(this.ws, { type: 'error', message });
  }

  log(...args) {
    // Deliberately not console.error: an attacker should not be able to fill the
    // Pi's journal with red. One line, no payload echoed back into the log.
    console.log('[session]', ...args);
  }
}

// ---------------------------------------------------------------------------
// Payload bounds for the game intents that carry one.
//
// Separate from intents.js because it is a transport concern: the P2P host trusts
// its peers no less than it trusts itself, and the engine is defensive in both
// cases. What this stops is a 60 KiB card id being compared against every card in
// a hand, or a patch with ten thousand keys being spread into an object.
// ---------------------------------------------------------------------------
export function withinBounds(msg) {
  switch (msg.type) {
    case 'playCard':
      return validCardId(msg.cardId) !== null
        && Number.isInteger(msg.cell) && msg.cell >= 0 && msg.cell < CELL_COUNT;
    case 'exchangeDead':
      return validCardId(msg.cardId) !== null;
    case 'setConfig':
      return validConfigPatch(msg.patch) !== null;
    case 'movePlayer':
      return validPlayerId(msg.playerId) !== null && typeof msg.dir === 'number';
    default:
      // pass, randomizeOrder, startGame, skipTurn, endGame, playAgain — no payload
      // at all, so there is nothing to bound. An unknown type falls through to
      // applyGameIntent, which returns handled:false and drops it.
      return true;
  }
}
