// ============================================================================
// config.js — Placeholder for the optional authoritative-server endpoint.
//
// This build is pure peer-to-peer: one player hosts from their browser tab and
// everyone else connects over the local network. There is no server, so both
// values below are empty and nothing imports this file yet.
//
// It exists as the documented seam for later. To give the game an online mode,
// follow Part E of the game-server platform playbook: stand up `server/`,
// point SERVER_URL at it (the TRAILING SLASH IS REQUIRED — the reverse proxy
// strips the `/sequence` prefix, so the upgrade must land on `/sequence/`), add
// a `serverTransport` to js/net.js, and gate every piece of server UI behind the
// boot health probe. The peer-to-peer path must keep working untouched when the
// server is unreachable.
//
//   SERVER_URL    — e.g. 'wss://<host>/sequence/'
//   SERVER_HEALTH — e.g. 'https://<host>/sequence/health'
// ============================================================================

export const SERVER_URL    = '';
export const SERVER_HEALTH = '';

/** True when a server endpoint is configured at all. */
export function serverConfigured() {
  return !!(SERVER_URL && SERVER_HEALTH);
}
