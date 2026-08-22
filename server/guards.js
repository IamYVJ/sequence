// ============================================================================
// guards.js — What the server refuses that a browser host has no opinion on.
//
// Most of the rules that were once here now live in ../js/guards.js, because the
// peer-to-peer host in a browser tab turned out to face the same internet this
// server does (PeerJS brokers and relays are public), so it needs the same bounds.
// They are re-exported below, which is why nothing else in server/ changed when
// they moved: the imports still read `from './guards.js'`.
//
// What stays here is the part that only exists over HTTP.
//
// Deliberately free of `ws`, `http` and any dependency at all, for two reasons:
//   1. The test harness can exercise every rule in here with `node` alone, so the
//      repo's `npm test` stays install-free (the static client has no deps and
//      shouldn't grow one just to be tested).
//   2. Policy you can read in one file is policy you can audit. These are the
//      Part D controls from the platform playbook, spelled out.
//
// The threat model is worth stating, because it decides which of these matter.
// This server sits behind a Tailscale Funnel on the public internet with no
// accounts and no authentication. So:
//   - Anyone can open a socket. Caps and rate limits are the real defence.
//   - Origin is anti-CSRF only. A non-browser client forges it trivially; it
//     stops a random web page from driving a player's session, nothing more.
//   - Room codes are not secrets (4 characters, and /rooms lists the open ones).
//     Nothing may depend on a code being hard to guess — which is why seat
//     reclaim depends on the secret clientId instead.
// ============================================================================

import { validEnvelope } from '../js/guards.js';

// Shared with the peer-to-peer host. Re-exported rather than imported directly by
// session.js so that "the guards" remains one name to import here.
export {
  TokenBucket, validClientId, validCardId, validPlayerId, validConfigPatch,
} from '../js/guards.js';

// ---------------------------------------------------------------------------
// Origin allowlist. ANTI-CSRF, NOT AUTHENTICATION.
//
// A browser sets Origin honestly and cannot be talked out of it, so this stops
// evil.example from opening a socket in a victim's browser and playing as them.
// A curl or a Node script sets whatever it likes, so this is worth exactly zero
// against a determined attacker — the caps and validators below are what hold.
//
// In production a MISSING Origin is refused too. Non-browser clients are the only
// things that omit it, and none of them are players.
// ---------------------------------------------------------------------------
export function originAllowed(origin, { allowed, production }) {
  // A wildcard is only honoured outside production, so a stray '*' in the Pi's
  // env can't quietly open the door on the real deployment.
  if (!production && (!allowed.length || allowed.includes('*'))) return true;
  if (!origin) return !production;
  if (allowed.includes(origin)) return true;
  // Local development, and only there: a client served from python -m http.server
  // needs to reach a server started with the same NODE_ENV.
  if (!production && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

export function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Frame decoding. Rejects binary and anything that isn't a JSON object.
//
// `ws` hands us a Buffer, and String()-ing a binary frame would produce mojibake
// that JSON.parse then rejects anyway — but explicitly refusing binary means the
// only thing we ever parse is something a client meant as text.
//
// The envelope check itself is shared (../js/guards.js): whether something counts
// as a message at all is not a question the two transports may answer differently.
// No size cap here — `ws` enforces maxPayload before this is reached and closes
// the socket with 1009, which is a better answer than a silently dropped frame.
// ---------------------------------------------------------------------------
export function decodeFrame(data, isBinary) {
  if (isBinary) return null;
  let text;
  try { text = typeof data === 'string' ? data : String(data); } catch (_) { return null; }
  let msg;
  try { msg = JSON.parse(text); } catch (_) { return null; }
  return validEnvelope(msg);
}
