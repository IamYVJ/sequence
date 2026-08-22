// ============================================================================
// intents.js — The one dispatcher that turns a wire message into an engine call.
//
// WHY THIS MODULE EXISTS
//   There are two authoritative hosts now: the peer-to-peer host in a player's
//   browser tab, and the Node server on the Pi. Both receive the same messages
//   from the same client code, and both own a GameEngine. If each kept its own
//   switch statement, the two would drift — one would learn a new intent, or read
//   `msg.patch` where the other reads `msg.config`, and the bug would only show up
//   on whichever transport was tested less.
//
//   So the switch lives here, once, and both call it. Same idea as legalTargets()
//   in rules.js being shared by validation and the highlights: if there is only
//   one copy, the copies cannot disagree.
//
// WHAT THIS IS NOT
//   Transport-neutral on purpose: no sockets, no peer ids, no broadcasting. The
//   caller supplies the actor's playerId (having already decided who that is) and
//   deals with the result. `join`, `lobbyQuery` and connection lifecycle stay with
//   the transports, because identity is exactly where the two differ — a peer id
//   from PeerJS versus a server-issued seat bound to a secret clientId.
//
// Node-safe: imports nothing but the engine's own vocabulary and the shared
// input bounds in guards.js, which import nothing at all.
// ============================================================================

import { validConfigPatch } from './guards.js';

// Anyone at the table may send these; the engine's own turn check is the guard.
export const PLAYER_INTENTS = Object.freeze([
  'playCard', 'exchangeDead', 'pass',
]);

// Only the owner (the room's host seat) may send these.
export const OWNER_INTENTS = Object.freeze([
  'setConfig', 'movePlayer', 'randomizeOrder',
  'startGame', 'skipTurn', 'endGame', 'playAgain',
]);

export const GAME_INTENTS = Object.freeze([...PLAYER_INTENTS, ...OWNER_INTENTS]);

// ---------------------------------------------------------------------------
// The owner guard, and why it is here rather than in the engine.
//
// Four of the owner intents already check `actorId !== this.hostId` inside the
// engine: startGame, skipTurn, endGame, playAgain. Three do NOT — setConfig,
// movePlayer and randomizeOrder only check the phase.
//
// That asymmetry was correct before this module existed: those three were
// reachable only from the host's own lobby UI and never from the wire, so there
// was no untrusted caller to guard against. Routing owner controls over the wire
// (which is what "the owner is just a client" means) is what makes them
// reachable, so the guard belongs at the seam that made them reachable — here.
//
// Every remote message on BOTH transports passes through this function, so this
// is a complete guard, not a partial one. The engine's own four checks still fire
// underneath; the belt and the braces disagree about nothing.
// ---------------------------------------------------------------------------
const NEEDS_OWNER_GUARD = new Set(['setConfig', 'movePlayer', 'randomizeOrder']);

/**
 * Apply one game intent.
 *
 * @param engine  the authoritative GameEngine
 * @param actorId the playerId the caller has decided this message came from
 * @param msg     the parsed wire message, already known to be an object
 * @returns { handled, result }
 *          handled=false means the type is not a game intent — the caller's
 *          transport layer owns it (join, lobbyQuery) or it is junk to ignore.
 *          `result` is the engine's usual { ok } / { ok:false, error }.
 */
export function applyGameIntent(engine, actorId, msg) {
  const type = msg && msg.type;
  if (typeof type !== 'string') return { handled: false, result: null };

  if (NEEDS_OWNER_GUARD.has(type) && actorId !== engine.hostId) {
    return { handled: true, result: { ok: false, error: 'Only the host can change the setup.' } };
  }

  switch (type) {
    // --- anyone at the table -------------------------------------------------
    case 'playCard':
      return done(engine.playCard(actorId, msg.cardId, msg.cell));
    case 'exchangeDead':
      return done(engine.exchangeDeadCard(actorId, msg.cardId));
    case 'pass':
      return done(engine.pass(actorId));

    // --- owner only ---------------------------------------------------------
    case 'setConfig': {
      // normalizeConfig rebuilds the config from a known key list, so an unknown
      // or hostile key in `patch` is dropped rather than stored. See rules.js.
      // What that does NOT bound is the SIZE of the object we agree to spread, so
      // that check is here rather than in one transport's own handler — the server
      // already did it in session.js and the P2P host did not, which is exactly
      // the drift this module exists to prevent.
      const patch = validConfigPatch(msg.patch);
      if (!patch) return done({ ok: false, error: 'That setup change was not understood.' });
      return done(engine.setConfig(patch));
    }
    case 'movePlayer':
      return done(engine.movePlayer(msg.playerId, msg.dir));
    case 'randomizeOrder':
      return done(engine.randomizeOrder());
    case 'startGame':
      return done(engine.startGame(actorId));
    case 'skipTurn':
      return done(engine.skipTurn(actorId));
    case 'endGame':
      return done(engine.endGame(actorId));
    case 'playAgain':
      return done(engine.playAgain(actorId));

    default:
      return { handled: false, result: null };
  }
}

// An engine method that returns nothing at all still counts as handled, so the
// caller syncs. Defensive: every current method returns { ok }.
function done(result) {
  return { handled: true, result: result || { ok: true } };
}
