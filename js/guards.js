// ============================================================================
// guards.js — Bounds on anything that arrived from another device.
//
// WHY THIS IS IN js/ AND NOT IN server/
//   These rules started life as server-only, on the reasoning that the server is
//   the thing exposed to the internet while a peer-to-peer host only ever hears
//   from people on the same Wi-Fi. That second half was never true: PeerJS
//   signalling goes through a broker on the public internet and the data channel
//   falls back to a relay, so a browser host is reachable from anywhere by anyone
//   who has (or guesses) the room code. Both authoritative hosts face the same
//   traffic, so they get the same bounds — the same reason js/intents.js and
//   js/state.js are shared rather than reimplemented per transport.
//
//   server/guards.js keeps the rules that only make sense over HTTP (the origin
//   allowlist) and re-exports these, so the server's imports are unchanged.
//
// WHAT THESE ARE FOR, AND WHAT THEY ARE NOT
//   Not rule enforcement. The engine is already defensive on its own account: an
//   unknown cardId matches nothing, an out-of-range cell is not in legalTargets(),
//   and normalizeConfig() rebuilds the config from a fixed key list so a hostile
//   KEY is dropped rather than stored. These bound *work and memory* instead — a
//   60 KiB card id would be compared against every card in a hand, and a patch
//   with ten thousand keys would be spread into an object.
//
//   Neither are they authentication. Nothing here decides who you are; that is
//   the clientId rule in state.js and session.js.
//
// Imports nothing, from anywhere, so `node` alone can exercise every rule and the
// browser can load it without a build step.
// ============================================================================

// A type is a short verb like 'playCard'. Anything longer is not a type, whatever
// else it might be.
export const MAX_TYPE_LEN = 40;

/**
 * The shape every wire message must have, checked after parsing and before any
 * dispatch. Shared so the two transports cannot disagree about what counts as a
 * message at all.
 *
 * An ARRAY parses fine as JSON and would sail past a `typeof === 'object'` check
 * while having no `.type`, so it is excluded by name.
 */
export function validEnvelope(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.type !== 'string' || msg.type.length > MAX_TYPE_LEN) return null;
  return msg;
}

// ---------------------------------------------------------------------------
// Per-connection message rate limit.
//
// The point is not to stop one client from being annoying to itself — it is that
// every accepted message fans out into a broadcast to the whole room. Without a
// limit, one socket sending in a loop multiplies its own flood by the number of
// players before it leaves the box. So the bucket sits in front of the dispatch,
// not behind it. On the peer-to-peer host "the box" is somebody's phone, which is
// the weaker of the two machines and the one with a battery.
//
// A refill rate rather than a fixed window, because real play is bursty: tapping
// a card and then a space is two messages in a fraction of a second, and a lobby
// host nudging a stepper sends one per tap.
// ---------------------------------------------------------------------------
export class TokenBucket {
  constructor({ capacity = 40, refillPerSec = 15, now = Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.stamp = now;
  }

  /** True if this message may proceed. Costs one token. */
  take(now = Date.now()) {
    const elapsed = Math.max(0, now - this.stamp) / 1000;
    this.stamp = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Input validation. Every one of these returns a value or null — never throws,
// and never hands back something half-cleaned.
// ---------------------------------------------------------------------------

// Long enough that collisions across a friend group are impossible, short enough
// to be obviously not a payload. The character class rules out anything that could
// confuse a log line or a JSON key.
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function validClientId(raw) {
  return typeof raw === 'string' && CLIENT_ID_RE.test(raw) ? raw : null;
}

export function validCardId(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null;
}

export function validPlayerId(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null;
}

// A config patch as the lobby UI sends it: one or two keys per tap, or a whole
// preset.
const MAX_PATCH_KEYS = 16;

export function validConfigPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.length > MAX_PATCH_KEYS) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Frame decoding for the PeerJS transport.
//
// The server's equivalent lives in server/guards.js because its signature is
// `ws`-shaped (it is handed a Buffer and an isBinary flag). This one is shaped
// for a DataConnection, which hands back whatever the sender's serializer
// produced: this app sends JSON.stringify()'d text, so a string is the normal
// case, but PeerJS's own BinaryPack serializer would deliver an already-decoded
// object and a custom client could send binary.
//
// The size cap can only be applied to the text case, and that is not a gap worth
// pretending away: by the time an object arrives, PeerJS has already allocated it,
// so the cap would be closing the door on an empty room. The cap that matters for
// the object path is the connection ceiling in net.js, which stops the flood
// rather than each frame in it.
// ---------------------------------------------------------------------------
export const MAX_FRAME_BYTES = 65536;

export function decodePeerFrame(raw, { maxBytes = MAX_FRAME_BYTES } = {}) {
  if (typeof raw === 'string') {
    // Compared against the character count rather than the encoded byte length:
    // multi-byte characters make this stricter than the stated cap, never looser,
    // and it avoids allocating a TextEncoder for every frame of every game.
    if (raw.length > maxBytes) return null;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return null; }
    return validEnvelope(msg);
  }
  // ArrayBuffer, Blob, TypedArray: something no version of this client sends.
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return null;
  return validEnvelope(raw);
}
