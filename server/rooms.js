// ============================================================================
// rooms.js — Room lifecycle, seat ownership, and fan-out.
//
// WHAT LIVES HERE AND WHAT DOESN'T
//   A Room owns a GameEngine — the same GameEngine the P2P host runs in a browser
//   tab, imported from ../js/state.js, not a reimplementation. Everything about
//   *rules* is therefore already written and already tested; what this file adds is
//   the three things a browser host got for free from PeerJS and now has to be
//   spelled out:
//
//     1. Which socket is which seat        (sockets: playerId -> ws)
//     2. Which device owns which seat      (seats: clientId -> playerId)
//     3. When a room stops existing        (sweep)
//
//   Message handling is in session.js. This file never reads a message.
//
// NO `ws` IMPORT, ON PURPOSE
//   A socket here is anything with `.send(string)` and a numeric `.readyState`, so
//   the test harness drives real rooms with stub sockets and `npm test` stays
//   install-free. That is also why OPEN is a literal 1 rather than `WebSocket.OPEN`.
//
// WHY clientId AND NOT NAME
//   The engine's own addPlayer() reclaims a seat by display name, which is correct
//   for the P2P host — a trusted peer, no untrusted lobby to spoof into — and
//   completely wrong here, where anyone on the internet can type a name and a
//   4-character code. So the server keeps its own seat map keyed by the secret
//   clientId and reclaims through THAT, never through the name. The engine's name
//   path is left alone rather than changed, because the P2P transport still needs
//   it and a shared engine that behaved differently for the two callers would be
//   the very drift intents.js exists to prevent.
// ============================================================================

import { GameEngine, PHASES } from '../js/state.js';
import { MAX_PLAYERS } from '../js/rules.js';
import { generateRoomCode } from '../js/util.js';

// A socket that is open. `ws` uses 1 for OPEN and so does the browser; not
// importing `ws` just to name the constant keeps this file testable with stubs.
const OPEN = 1;

// ---------------------------------------------------------------------------
// Lifetimes.
//
// Two different clocks, because "nobody is here" and "nobody is playing" are
// different problems. A room whose last socket closed is garbage in minutes: on
// this transport a closed socket is a real departure, and the only reason to wait
// at all is that a phone locking its screen or a train tunnel looks identical to
// leaving for the first minute or two.
//
// A room that still has sockets attached but has seen no message for hours is a
// table that went to bed with the tab open. That one gets the long clock, because
// a slow game with a lot of thinking is not idle.
// ---------------------------------------------------------------------------
export const DEFAULT_LIMITS = Object.freeze({
  maxRooms: 50,
  emptyTtlMs: 15 * 60 * 1000,       // no sockets attached
  idleTtlMs: 6 * 60 * 60 * 1000,    // sockets attached, no traffic
});

export class Room {
  constructor(code, now = Date.now()) {
    this.code = code;
    this.engine = new GameEngine();
    this.sockets = new Map();       // playerId -> ws
    this.seats = new Map();         // clientId -> playerId
    // The name a seat was claimed under. Kept because a lobby dropout releases the
    // engine's player but not the clientId's claim on the seat, and the device that
    // comes back must come back as who it was rather than as whoever it now says it
    // is — a rename on reclaim would make a name decide a seat again.
    this.seatNames = new Map();     // playerId -> name
    this.ownerClientId = null;
    this.createdAt = now;
    this.lastActivity = now;
    // Seat ids are server-issued and never reused, so a stale message from a
    // socket that lost its seat can't land on somebody else's.
    this._nextSeat = 0;
  }

  newPlayerId() {
    this._nextSeat += 1;
    return `p${this._nextSeat}`;
  }

  touch(now = Date.now()) { this.lastActivity = now; }

  /** Record that a device owns a seat. The two maps are only ever written together,
   *  so they cannot drift out of step. */
  claimSeat(clientId, playerId, name) {
    this.seats.set(clientId, playerId);
    this.seatNames.set(playerId, name);
  }

  dropSeat(clientId) {
    const playerId = this.seats.get(clientId);
    this.seats.delete(clientId);
    if (playerId) this.seatNames.delete(playerId);
  }

  /** Sockets that are still open. A closed socket is dropped on sight. */
  liveSockets() {
    const live = [];
    for (const [playerId, ws] of this.sockets) {
      if (ws && ws.readyState === OPEN) live.push([playerId, ws]);
      else this.sockets.delete(playerId);
    }
    return live;
  }

  get isEmpty() { return this.liveSockets().length === 0; }

  /**
   * Send every attached device the board plus ITS OWN hand, and nothing else.
   *
   * One state message per socket rather than one broadcast, because the private
   * half is different for every recipient. This is the same split publicState() /
   * privateStateFor() already enforce — the point of doing it per socket is that
   * a hand is never serialised into a payload addressed to anyone else, so there
   * is no filtering step that could be got wrong.
   */
  broadcast() {
    const pub = this.engine.publicState();
    for (const [playerId, ws] of this.liveSockets()) {
      send(ws, { type: 'state', pub, priv: this.engine.privateStateFor(playerId) });
    }
  }

  /** The public one-line summary used by /rooms and lobbyQuery. */
  info() {
    const owner = this.engine.getPlayer(this.engine.hostId);
    return {
      code: this.code,
      hostName: owner ? owner.name : '',
      playerCount: this.engine.players.length,
      phase: this.engine.phase,
      joinable: this.engine.phase === PHASES.LOBBY && this.engine.players.length < MAX_PLAYERS,
    };
  }
}

// ---------------------------------------------------------------------------
// Sending. Never throws.
//
// A socket can close between the readyState check and the write, and `ws` throws
// on a write to a closed socket. One dead recipient must not abort the fan-out to
// everyone else, so the failure is swallowed here rather than handled at every
// call site.
// ---------------------------------------------------------------------------
export function send(ws, msg) {
  if (!ws || ws.readyState !== OPEN) return false;
  let text;
  try { text = JSON.stringify(msg); } catch (_) { return false; }
  try { ws.send(text); return true; } catch (_) { return false; }
}

export class RoomManager {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.rooms = new Map();         // code -> Room
  }

  get size() { return this.rooms.size; }

  get(code) { return this.rooms.get(code) || null; }

  /**
   * Open a room, or refuse.
   *
   * The cap is on rooms and not on rooms-per-IP: behind a Tailscale Funnel every
   * connection arrives from the proxy, so there is no client address to count and
   * X-Forwarded-For is whatever the client wrote. A global ceiling is crude but it
   * is the only number that is actually true, and 2GB of Pi is a real limit.
   */
  create(now = Date.now()) {
    // Reclaim dead rooms before refusing a live one, so a day of abandoned lobbies
    // can't lock the server out of service until someone restarts it.
    if (this.rooms.size >= this.limits.maxRooms) this.sweep(now);
    if (this.rooms.size >= this.limits.maxRooms) {
      return { ok: false, error: 'The server is at capacity. Try again in a few minutes.' };
    }
    const code = this._freeCode();
    if (!code) return { ok: false, error: 'Could not allocate a room code. Try again.' };
    const room = new Room(code, now);
    this.rooms.set(code, room);
    return { ok: true, room };
  }

  /** Codes are 4 chars from a 32-char alphabet, so a collision at this scale is a
   *  formality — but an unchecked collision would hand a joiner somebody else's
   *  game, so it is checked. */
  _freeCode() {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  drop(code) { return this.rooms.delete(code); }

  /**
   * Lobbies anyone may join, newest last.
   *
   * NOTE, and it is deliberately in the code rather than only in the README: this
   * list makes every open lobby on the box enumerable by anyone who can reach the
   * URL, and the URL is on the public internet. Room codes were never secrets (4
   * characters, guessable in an afternoon), so this changes the cost of finding a
   * game, not the security model — the things that must not depend on a code being
   * secret already don't. It is a switch on the server (ROOMS_LIST) because
   * "friends only, share the code yourself" is a legitimate way to run this.
   */
  joinable() {
    const out = [];
    for (const room of this.rooms.values()) {
      const info = room.info();
      if (info.joinable) out.push(info);
    }
    return out.sort((a, b) => a.code.localeCompare(b.code));
  }

  /**
   * Drop rooms nobody is coming back to. Returns how many went.
   *
   * Called on a timer and again whenever the room cap is hit, because the timer
   * alone would let a burst of abandoned lobbies wedge the server between ticks.
   */
  sweep(now = Date.now()) {
    let dropped = 0;
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivity;
      const gone = room.isEmpty
        ? idle > this.limits.emptyTtlMs
        : idle > this.limits.idleTtlMs;
      if (gone) { this.rooms.delete(code); dropped += 1; }
    }
    return dropped;
  }
}
