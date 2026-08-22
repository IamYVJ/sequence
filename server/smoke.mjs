// ============================================================================
// smoke.mjs — LIVE checks against a RUNNING server, over real WebSockets.
//
// This is not a substitute for scripts/test-server.mjs. That suite drives the
// protocol against stub sockets and needs no dependencies, which is why CI runs it
// and why it covers the game semantics exhaustively. What it cannot cover is the
// part that only exists when a real socket is involved:
//
//   - the HTTP upgrade, and the origin check that refuses it with a real status
//   - `ws`'s own maxPayload enforcement (close code 1009)
//   - the global connection cap, checked before the handshake completes
//   - SIGTERM closing live sockets with 1001 rather than hanging
//
// So this file needs `ws` (cd server && npm install) and a server to talk to. It
// is a hand-run check before a deploy, not part of `npm test`.
//
// USAGE — start one server per group, then run this once. Groups whose env var is
// unset are skipped, so you can run just one.
//
//   # A: permissive, for the protocol-over-a-real-socket group
//   NODE_ENV=development ALLOWED_ORIGINS='*' PORT=9100 node index.js
//   # B: production origin rules
//   NODE_ENV=production ALLOWED_ORIGINS=https://iamyvj.github.io PORT=9101 node index.js
//   # C: wildcard must be ignored in production
//   NODE_ENV=production ALLOWED_ORIGINS='*' PORT=9102 node index.js
//   # D: connection ceiling
//   NODE_ENV=development ALLOWED_ORIGINS='*' MAX_CONNS=1 PORT=9103 node index.js
//
//   SMOKE_DEV=ws://127.0.0.1:9100 SMOKE_PROD=ws://127.0.0.1:9101 \
//   SMOKE_WILD=ws://127.0.0.1:9102 SMOKE_CAP=ws://127.0.0.1:9103 \
//   node smoke.mjs
// ============================================================================

import { WebSocket } from 'ws';
// The phase names come from the engine rather than being spelled out here, for the
// same reason the server imports the engine at all: a constant copied into a test
// is a constant that can quietly stop matching.
import { PHASES } from '../js/state.js';

const DEV = process.env.SMOKE_DEV || '';
const PROD = process.env.SMOKE_PROD || '';
const WILD = process.env.SMOKE_WILD || '';
const CAP = process.env.SMOKE_CAP || '';
const TERM = process.env.SMOKE_TERM || '';
const TERM_PID = process.env.SMOKE_TERM_PID || '';
const ALLOWED = process.env.SMOKE_ORIGIN || 'https://iamyvj.github.io';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${name}`); return; }
  failed++;
  failures.push(name + (detail ? ` — ${detail}` : ''));
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// A tiny client: collects every frame, and lets a test await the next one of a
// given type instead of guessing at timing.
// ---------------------------------------------------------------------------
function client(url, { origin } = {}) {
  const ws = new WebSocket(url, origin ? { headers: { origin } } : {});
  const c = {
    ws,
    frames: [],
    opened: false,
    closeCode: null,
    handshakeError: null,
    waiters: [],
    send(msg) { ws.send(JSON.stringify(msg)); },
    close() { try { ws.close(); } catch (_) {} },
    // Resolves with the next unseen frame of this type, or null after timeoutMs.
    //
    // `where` matters more than it looks: the server broadcasts on every change, so
    // by the time a test asks for "the state after the deal" there is usually an
    // older lobby state already sitting in the queue. Without a predicate the test
    // would assert against that one and report a server bug that isn't there.
    next(type, where = null, timeoutMs = 2000) {
      const matches = (f) => f.type === type && !f.__seen && (!where || where(f));
      const found = c.frames.find(matches);
      if (found) { found.__seen = true; return Promise.resolve(found); }
      return new Promise((resolve) => {
        const w = { type, where, resolve, timer: null };
        w.timer = setTimeout(() => {
          c.waiters = c.waiters.filter((x) => x !== w);
          resolve(null);
        }, timeoutMs);
        c.waiters.push(w);
      });
    },
  };

  ws.on('open', () => { c.opened = true; });
  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch (_) { return; }
    c.frames.push(msg);
    const w = c.waiters.find((x) => x.type === msg.type && (!x.where || x.where(msg)));
    if (w) {
      clearTimeout(w.timer);
      c.waiters = c.waiters.filter((x) => x !== w);
      msg.__seen = true;
      w.resolve(msg);
    }
  });
  ws.on('close', (code) => { c.closeCode = code; });
  // A refused upgrade surfaces here as "Unexpected server response: 403".
  ws.on('error', (err) => { c.handshakeError = err.message; });

  c.settled = new Promise((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('error', () => resolve('error'));
    ws.on('close', () => resolve('closed'));
  });
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A — the protocol over a real socket
// ---------------------------------------------------------------------------
async function groupProtocol(url) {
  console.log(`\nA. protocol over a real socket  (${url})`);

  const ann = client(url);
  await ann.settled;
  ok('handshake succeeds with no Origin in development', ann.opened, ann.handshakeError || '');
  if (!ann.opened) return;

  ann.send({ type: 'createRoom', name: 'Ann', clientId: 'smoke-ann-0001' });
  const welcome = await ann.next('welcome');
  ok('createRoom answers welcome', !!welcome);
  ok('welcome carries a 4-char code', !!welcome && /^[A-Z2-9]{4}$/.test(welcome.code), welcome && welcome.code);
  ok('creator is the owner', !!welcome && welcome.owner === true);

  const first = await ann.next('state');
  ok('welcome is followed by state', !!first);
  ok('state has pub and priv', !!first && !!first.pub && !!first.priv);
  ok('pub leaks no hands, deck or discards',
    !!first && !('hands' in first.pub) && !('deck' in first.pub) && !('discards' in first.pub),
    first && Object.keys(first.pub).join(','));

  const code = welcome && welcome.code;

  // --- a second player, and a broadcast to the first ------------------------
  const bob = client(url);
  await bob.settled;
  bob.send({ type: 'join', code, name: 'Bob', clientId: 'smoke-bob-0001' });
  const bobWelcome = await bob.next('welcome');
  ok('join answers welcome', !!bobWelcome);
  ok('a joiner is not the owner', !!bobWelcome && bobWelcome.owner === false);
  const annSaw = await ann.next('state', (f) => f.pub.players.length === 2);
  ok('the owner is told about the joiner', !!annSaw);

  // --- an owner-only intent from a non-owner -------------------------------
  bob.send({ type: 'randomizeOrder' });
  const refused = await bob.next('error');
  ok('a non-owner cannot use an owner intent', !!refused, refused && refused.message);

  // --- start the game ------------------------------------------------------
  ann.send({ type: 'startGame' });
  const inPlay = (f) => f.pub.phase === PHASES.PLAY;
  const playing = await ann.next('state', inPlay);
  ok('the owner can start the game', !!playing, playing ? '' : 'no state in phase play');
  const bobPlaying = await bob.next('state', inPlay);
  ok('each player is dealt a hand', !!bobPlaying && Array.isArray(bobPlaying.priv.hand)
    && bobPlaying.priv.hand.length > 0);
  ok('and only their own — the deal is not in pub',
    !!playing && !!bobPlaying
      && JSON.stringify(playing.pub) === JSON.stringify(bobPlaying.pub)
      && JSON.stringify(playing.priv.hand) !== JSON.stringify(bobPlaying.priv.hand));

  // --- mid-game drop and reclaim ------------------------------------------
  bob.close();
  await sleep(150);
  const afterDrop = await ann.next('state', (f) => f.pub.players.some((p) => p.online === false));
  ok('a mid-game drop keeps the seat and marks it offline',
    !!afterDrop && afterDrop.pub.players.length === 2);

  const impostor = client(url);
  await impostor.settled;
  impostor.send({ type: 'join', code, name: 'Bob', clientId: 'smoke-evil-0001' });
  const stolen = await impostor.next('rejected');
  ok('a NAME alone cannot reclaim a seat mid-game', !!stolen, stolen && stolen.reason);
  impostor.close();

  const bobBack = client(url);
  await bobBack.settled;
  bobBack.send({ type: 'join', code, name: 'Bob', clientId: 'smoke-bob-0001' });
  const backWelcome = await bobBack.next('welcome');
  const backState = await bobBack.next('state', inPlay);
  ok('the same clientId reclaims the seat', !!backWelcome && backWelcome.playerId === bobWelcome.playerId);
  ok('and the hand comes back', !!backState && Array.isArray(backState.priv.hand) && backState.priv.hand.length > 0);

  // --- junk ---------------------------------------------------------------
  bobBack.send({ type: 'notAThing', x: 1 });
  bobBack.ws.send('this is not json');
  bobBack.ws.send(Buffer.from([1, 2, 3]));
  await sleep(200);
  ok('junk frames do not close the socket', bobBack.ws.readyState === WebSocket.OPEN);

  // --- lobbyQuery ---------------------------------------------------------
  bobBack.send({ type: 'lobbyQuery', code });
  const info = await bobBack.next('lobbyInfo');
  ok('lobbyQuery answers', !!info);
  bobBack.send({ type: 'lobbyQuery', code: 'ZZZZ' });
  const none = await bobBack.next('lobbyInfo');
  ok('lobbyQuery for an unknown code answers null', !!none && none.info === null);

  // --- the payload cap ----------------------------------------------------
  const fat = client(url);
  await fat.settled;
  fat.ws.send(JSON.stringify({ type: 'createRoom', name: 'x'.repeat(100 * 1024), clientId: 'smoke-fat-0001' }));
  await sleep(400);
  ok('an oversize frame closes the socket with 1009', fat.closeCode === 1009, String(fat.closeCode));

  ann.close();
  bobBack.close();
  await sleep(100);
}

// ---------------------------------------------------------------------------
// B — production origin rules
// ---------------------------------------------------------------------------
async function groupOrigins(url) {
  console.log(`\nB. production origin rules  (${url})`);

  const cases = [
    ['the allowed origin connects', ALLOWED, true],
    ['no Origin header is refused', undefined, false],
    ['a localhost origin is refused', 'http://localhost:8000', false],
    ['another site is refused', 'https://evil.example', false],
    ['the allowed origin with a path is refused', `${ALLOWED}/sequence/`, false],
  ];

  for (const [name, origin, shouldOpen] of cases) {
    const c = client(url, { origin });
    await c.settled;
    await sleep(50);
    ok(name, c.opened === shouldOpen, c.handshakeError || (c.opened ? 'opened' : 'refused'));
    // A refusal must be a stated 403 at handshake time. A socket that opens and
    // then closes is the failure mode `noServer` exists to avoid: the browser is
    // told nothing, and the app cannot tell it apart from an unplugged router.
    if (!shouldOpen) {
      ok(`  …refused with a 403, not a silent close`,
        /403/.test(c.handshakeError || ''), c.handshakeError || 'no error reported');
    }
    c.close();
  }
}

// ---------------------------------------------------------------------------
// C — a wildcard must be ignored in production
// ---------------------------------------------------------------------------
async function groupWildcard(url) {
  console.log(`\nC. wildcard ignored in production  (${url})`);
  const c = client(url, { origin: 'https://evil.example' });
  await c.settled;
  await sleep(50);
  ok('ALLOWED_ORIGINS=* does not open the door in production', !c.opened,
    c.handshakeError || (c.opened ? 'opened' : 'refused'));
  c.close();
}

// ---------------------------------------------------------------------------
// D — the global connection ceiling
// ---------------------------------------------------------------------------
async function groupCap(url) {
  console.log(`\nD. connection ceiling, MAX_CONNS=1  (${url})`);
  const one = client(url);
  await one.settled;
  ok('the first connection is accepted', one.opened, one.handshakeError || '');
  const two = client(url);
  await two.settled;
  await sleep(50);
  ok('the second is refused (503) before the handshake completes', !two.opened,
    two.handshakeError || (two.opened ? 'opened' : 'refused'));
  one.close();
  two.close();
}

// ---------------------------------------------------------------------------
// E — SIGTERM closes live sockets cleanly (1001), which is what makes a redeploy
// look like a reconnect to every client instead of a hang they have to time out.
//
// Needs the server's PID, and it KILLS that server, so it runs last and against a
// throwaway instance: SMOKE_TERM=ws://127.0.0.1:9103 SMOKE_TERM_PID=1234.
//
// PLATFORM CAVEAT: on Windows there is no real SIGTERM. process.kill() there
// terminates unconditionally without the handler ever running, so a socket that
// dies with 1006 is inconclusive rather than a failure — the behaviour this checks
// only exists where the container runs. On the Pi, `docker stop sequence-server`
// is the real test.
// ---------------------------------------------------------------------------
async function groupTerm(url, pid) {
  console.log(`\nE. SIGTERM closes sockets cleanly  (${url}, pid ${pid})`);
  const c = client(url);
  await c.settled;
  if (!c.opened) { ok('a socket is open before the signal', false, c.handshakeError || ''); return; }
  ok('a socket is open before the signal', true);

  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch (err) {
    ok('the signal was delivered', false, err.message);
    return;
  }
  await sleep(600);

  if (c.closeCode === 1001) {
    ok('the client sees close 1001 "Server restarting"', true);
  } else if (process.platform === 'win32') {
    console.log(`  n/a  close code ${c.closeCode} — Windows has no real SIGTERM, so the`);
    console.log('       handler cannot run here. Verify with `docker stop` on the Pi.');
  } else {
    ok('the client sees close 1001 "Server restarting"', false, String(c.closeCode));
  }
}

// ---------------------------------------------------------------------------
const started = Date.now();
if (DEV) await groupProtocol(DEV); else console.log('\nA. skipped (set SMOKE_DEV)');
if (PROD) await groupOrigins(PROD); else console.log('\nB. skipped (set SMOKE_PROD)');
if (WILD) await groupWildcard(WILD); else console.log('\nC. skipped (set SMOKE_WILD)');
if (CAP) await groupCap(CAP); else console.log('\nD. skipped (set SMOKE_CAP)');
if (TERM && TERM_PID) await groupTerm(TERM, TERM_PID);
else console.log('\nE. skipped (set SMOKE_TERM and SMOKE_TERM_PID — it kills that server)');

console.log(`\n${passed} passed, ${failed} failed  (${Date.now() - started}ms)`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
