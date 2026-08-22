// Headless end-to-end test of the Sequence SERVER. No browser, no `ws`, no
// install:
//   node scripts/test-server.mjs
//
// The server is deliberately arranged so that this is possible. guards.js is pure
// policy with no imports at all; rooms.js talks to anything with `.send()` and a
// numeric `.readyState`; session.js takes a frame and a clock. Only index.js knows
// about sockets, and nothing here imports it — so `npm test` stays dependency-free
// and every rule below is exercised against the real code rather than a mock of it.
//
// Two halves:
//   1. A whole game played over the wire, by stub sockets, through the same
//      Session.handleFrame() a real client reaches — proving the shared engine and
//      the shared intent dispatcher work on this transport too.
//   2. The Part D hardening checklist, one assertion at a time. These are the tests
//      that matter: this server sits on the public internet with no accounts, so
//      every one of them is a hole that would otherwise be open.

import { GameEngine, PHASES } from '../js/state.js';
import { MAX_PLAYERS } from '../js/rules.js';
import { RoomManager, Room, send } from '../server/rooms.js';
import { Session, withinBounds } from '../server/session.js';
import {
  originAllowed, parseOrigins, TokenBucket, decodeFrame,
  validClientId, validCardId, validPlayerId, validConfigPatch,
} from '../server/guards.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function section(t) { console.log('\n— ' + t); }

// Same deterministic RNG as the engine tests, and for the same reason: the deal is
// shuffled through crypto.getRandomValues, so an unseeded run plays a different
// game every time and a failure could not be reproduced. Room codes come from the
// same stream, which is why the tests below read the code out of the `welcome`
// message instead of assuming one.
let prng = 0;
function seed(n) { prng = n >>> 0; }
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    getRandomValues(buf) {
      for (let i = 0; i < buf.length; i++) {
        prng = (prng + 0x6D2B79F5) >>> 0;
        let t = prng;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        buf[i] = (t ^ (t >>> 14)) >>> 0;
      }
      return buf;
    },
  },
});
seed(7);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Everything a socket has to be for rooms.js and session.js to use it.
 *
 * `send` THROWS if the socket is closed, which is what the real `ws` does — so a
 * write to a departed player is a test failure here rather than something the
 * production code discovers on the Pi. rooms.send() checks readyState first, so a
 * throw means that check was skipped.
 */
class StubSocket {
  constructor(label = '') {
    this.label = label;
    this.readyState = 1;            // OPEN
    this.sent = [];
    this.closes = [];
  }

  send(text) {
    if (this.readyState !== 1) throw new Error(`send() on a closed socket (${this.label})`);
    this.sent.push(JSON.parse(text));
  }

  close(code, reason) {
    this.readyState = 3;            // CLOSED
    this.closes.push({ code, reason });
  }

  /** Most recent message, optionally of one type. */
  last(type) {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (!type || this.sent[i].type === type) return this.sent[i];
    }
    return null;
  }

  all(type) { return this.sent.filter((m) => m.type === type); }
  clear() { this.sent.length = 0; return this; }
}

/** A connected client: the socket, its Session, and a way to speak. */
function connect(manager, label, opts) {
  const ws = new StubSocket(label);
  const session = new Session(ws, manager, opts);
  return {
    ws, session, label,
    send(msg, now) { session.handleFrame(JSON.stringify(msg), false, now); return this; },
    raw(data, isBinary, now) { session.handleFrame(data, isBinary, now); return this; },
    drop(now) { session.detach(now); ws.close(1001, 'gone'); return this; },
    get state() { return this.ws.last('state'); },
    get playerId() { const w = this.ws.all('welcome'); return w.length ? w[w.length - 1].playerId : null; },
  };
}

/**
 * A room with `names.length` players in it, the first of them the owner.
 * Returns the manager, the code, and one client per name.
 */
function table(names = ['Alice', 'Bob', 'Cara', 'Dan'], limits) {
  const manager = new RoomManager(limits);
  const clients = [];
  const owner = connect(manager, names[0]);
  owner.send({ type: 'createRoom', name: names[0], clientId: cid(names[0]) });
  const code = owner.ws.last('welcome').code;
  clients.push(owner);
  for (const name of names.slice(1)) {
    const c = connect(manager, name);
    c.send({ type: 'join', code, name, clientId: cid(name) });
    clients.push(c);
  }
  return { manager, code, room: manager.get(code), clients, owner };
}

/** A clientId of the shape guards.js will accept: 8-64 of [A-Za-z0-9_-]. */
function cid(name) { return `client-${name.toLowerCase()}-0001`; }

// ===========================================================================
section('guards: the origin allowlist is anti-CSRF, and fails closed in production');
// ===========================================================================
{
  const prod = { allowed: ['https://iamyvj.github.io'], production: true };
  const dev = { allowed: ['https://iamyvj.github.io'], production: false };

  ok(originAllowed('https://iamyvj.github.io', prod), 'the real client origin is allowed');
  ok(!originAllowed('https://evil.example', prod), 'another site is refused');
  ok(!originAllowed('https://iamyvj.github.io.evil.example', prod),
    'a suffix attack on the allowed origin is refused');
  ok(!originAllowed('http://iamyvj.github.io', prod), 'the same host over http is a different origin');

  // A browser cannot omit Origin on a WebSocket handshake. Something that omits it
  // is a script, and no script is a player.
  ok(!originAllowed(undefined, prod), 'a missing Origin is refused in production');
  ok(!originAllowed('', prod), 'an empty Origin is refused in production');
  ok(originAllowed(undefined, dev), 'a missing Origin is allowed outside production');

  // A stray '*' in the Pi's environment must not open the door on the real
  // deployment — which is the whole reason production is a separate flag rather
  // than just an empty allowlist.
  ok(!originAllowed('https://evil.example', { allowed: ['*'], production: true }),
    'a wildcard is ignored in production');
  ok(originAllowed('https://evil.example', { allowed: ['*'], production: false }),
    'a wildcard is honoured outside production');
  ok(!originAllowed('https://evil.example', { allowed: [], production: true }),
    'an empty allowlist refuses everything in production');

  ok(originAllowed('http://localhost:8000', dev), 'localhost is allowed in development');
  ok(!originAllowed('http://localhost:8000', prod), 'localhost is refused in production');
  ok(!originAllowed('http://localhost.evil.example', dev),
    'a host that merely starts with localhost is refused');

  const parsed = parseOrigins(' https://a.example , https://b.example ,, ');
  ok(parsed.length === 2 && parsed[0] === 'https://a.example' && parsed[1] === 'https://b.example',
    'parseOrigins trims, splits and drops blanks');
  ok(parseOrigins(undefined).length === 0, 'parseOrigins survives a missing variable');
}

// ===========================================================================
section('guards: the token bucket sits in front of the broadcast, not behind it');
// ===========================================================================
{
  const b = new TokenBucket({ capacity: 5, refillPerSec: 10, now: 1000 });
  let allowed = 0;
  for (let i = 0; i < 20; i++) if (b.take(1000)) allowed++;
  ok(allowed === 5, `a burst is capped at the capacity (got ${allowed})`);

  ok(!b.take(1000), 'an empty bucket refuses');
  ok(b.take(1100), 'a tenth of a second at 10/s buys exactly one message');
  ok(!b.take(1100), 'and only one');

  // Real play is bursty — tap a card, tap a space — so the refill has to give
  // back a burst rather than pace messages out one at a time.
  const c = new TokenBucket({ capacity: 40, refillPerSec: 15, now: 0 });
  for (let i = 0; i < 40; i++) c.take(0);
  let after = 0;
  for (let i = 0; i < 40; i++) if (c.take(10_000)) after++;
  ok(after === 40, 'ten idle seconds refill the whole bucket, not more');

  // A clock that goes backwards (NTP, a suspended laptop) must not mint tokens.
  const d = new TokenBucket({ capacity: 3, refillPerSec: 1, now: 5000 });
  d.take(5000); d.take(5000); d.take(5000);
  ok(!d.take(1000), 'a backwards clock does not refill the bucket');
}

// ===========================================================================
section('guards: frame decoding refuses everything that is not a text JSON object');
// ===========================================================================
{
  ok(decodeFrame(JSON.stringify({ type: 'pass' }), false).type === 'pass', 'a good frame decodes');
  ok(decodeFrame(Buffer.from(JSON.stringify({ type: 'pass' })), false).type === 'pass',
    'a text frame arriving as a Buffer decodes');

  ok(decodeFrame(Buffer.from([0x00, 0x01, 0xff]), true) === null, 'a binary frame is refused');
  ok(decodeFrame('not json at all', false) === null, 'garbage is refused');
  ok(decodeFrame('', false) === null, 'an empty frame is refused');
  ok(decodeFrame('null', false) === null, 'JSON null is refused');
  ok(decodeFrame('42', false) === null, 'a bare number is refused');
  ok(decodeFrame('"pass"', false) === null, 'a bare string is refused');
  // An array is JSON, is typeof 'object', and has no .type — it would sail past a
  // naive check, so it is excluded by name.
  ok(decodeFrame('[{"type":"pass"}]', false) === null, 'an array is refused');
  ok(decodeFrame('{"nope":1}', false) === null, 'an object with no type is refused');
  ok(decodeFrame('{"type":123}', false) === null, 'a non-string type is refused');
  ok(decodeFrame(`{"type":"${'x'.repeat(41)}"}`, false) === null, 'an over-long type is refused');
  ok(decodeFrame(`{"type":"${'x'.repeat(40)}"}`, false) !== null, 'a 40-character type is the limit');
}

// ===========================================================================
section('guards: the validators bound work and memory');
// ===========================================================================
{
  ok(validClientId('abcd1234') === 'abcd1234', 'an 8-character clientId is accepted');
  ok(validClientId('abcd123') === null, 'a 7-character clientId is refused');
  ok(validClientId('x'.repeat(64)) !== null && validClientId('x'.repeat(65)) === null,
    'the clientId length ceiling is 64');
  ok(validClientId('has space 1') === null, 'a clientId with a space is refused');
  ok(validClientId('drop/../table') === null, 'a clientId with punctuation is refused');
  ok(validClientId(null) === null && validClientId(12345678) === null,
    'a non-string clientId is refused');

  ok(validCardId('AS#1') === 'AS#1', 'a card id is accepted');
  ok(validCardId('') === null, 'an empty card id is refused');
  ok(validCardId('x'.repeat(65)) === null, 'a 64-byte ceiling on card ids');
  ok(validPlayerId('p12') === 'p12' && validPlayerId('x'.repeat(65)) === null,
    'player ids are bounded the same way');

  ok(validConfigPatch({ showTargets: false }) !== null, 'a one-key patch is accepted');
  ok(validConfigPatch({}) === null, 'an empty patch is refused');
  ok(validConfigPatch([]) === null, 'an array is not a patch');
  ok(validConfigPatch(null) === null, 'null is not a patch');
  ok(validConfigPatch('showTargets') === null, 'a string is not a patch');
  const wide = {};
  for (let i = 0; i < 17; i++) wide['k' + i] = i;
  ok(validConfigPatch(wide) === null, 'a 17-key patch is refused');
}

// ===========================================================================
section('guards: intent payload bounds');
// ===========================================================================
{
  ok(withinBounds({ type: 'playCard', cardId: 'AS#1', cell: 0 }), 'cell 0 is in range');
  ok(withinBounds({ type: 'playCard', cardId: 'AS#1', cell: 99 }), 'cell 99 is in range');
  ok(!withinBounds({ type: 'playCard', cardId: 'AS#1', cell: 100 }), 'cell 100 is out of range');
  ok(!withinBounds({ type: 'playCard', cardId: 'AS#1', cell: -1 }), 'a negative cell is refused');
  ok(!withinBounds({ type: 'playCard', cardId: 'AS#1', cell: 1.5 }), 'a fractional cell is refused');
  ok(!withinBounds({ type: 'playCard', cardId: 'AS#1', cell: '5' }), 'a stringy cell is refused');
  ok(!withinBounds({ type: 'playCard', cardId: 'x'.repeat(9999), cell: 5 }),
    'a huge card id is refused before the engine compares it against a hand');
  ok(!withinBounds({ type: 'exchangeDead', cardId: '' }), 'a swap needs a real card id');
  ok(!withinBounds({ type: 'movePlayer', playerId: 'p1', dir: 'up' }), 'a direction must be a number');
  ok(withinBounds({ type: 'pass' }), 'a payload-free intent has nothing to bound');
  ok(withinBounds({ type: 'startGame' }), 'startGame passes the bounds check');
}

// ===========================================================================
section('rooms: allocation, listing and the caps');
// ===========================================================================
{
  const m = new RoomManager({ maxRooms: 3 });
  const a = m.create(0), b = m.create(0), c = m.create(0);
  ok(a.ok && b.ok && c.ok, 'rooms open up to the cap');
  const d = m.create(0);
  ok(!d.ok && /capacity/i.test(d.error), 'the room after the cap is refused with a reason');
  ok(m.size === 3, 'the refused room was not created');

  const codes = new Set([a.room.code, b.room.code, c.room.code]);
  ok(codes.size === 3, 'codes are unique');
  ok([...codes].every((code) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code)),
    'codes use the unambiguous 4-character alphabet');
  ok(m.get(a.room.code) === a.room, 'a room can be found by its code');
  ok(m.get('ZZZZ') === null, 'an unknown code returns null rather than throwing');

  // 500 codes from the real generator, all distinct: the collision check in
  // _freeCode is doing its job and the alphabet is not degenerate.
  const many = new RoomManager({ maxRooms: 600 });
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(many.create(0).room.code);
  ok(seen.size === 500, `500 rooms got 500 distinct codes (got ${seen.size})`);
}

// ===========================================================================
section('rooms: idle collection, on two different clocks');
// ===========================================================================
{
  const m = new RoomManager({ maxRooms: 10, emptyTtlMs: 1000, idleTtlMs: 100_000 });

  // An empty room — every socket closed — is garbage in minutes.
  const empty = m.create(0).room;
  ok(empty.isEmpty, 'a room with no sockets reports itself empty');
  ok(m.sweep(500) === 0, 'an empty room survives inside the short TTL');
  ok(m.sweep(2000) === 1 && m.size === 0, 'an empty room is collected past the short TTL');

  // A room with a socket attached but no traffic is a table thinking hard, or one
  // that went to bed with the tab open. It gets hours, not minutes.
  const live = m.create(0).room;
  live.sockets.set('p1', new StubSocket('live'));
  ok(!live.isEmpty, 'a room with an open socket is not empty');
  ok(m.sweep(2000) === 0, 'a live room is not collected on the short TTL');
  ok(m.sweep(200_000) === 1, 'a live room is collected once it is genuinely idle');

  // A closed socket is a departure, not an occupant.
  const stale = m.create(300_000).room;
  const dead = new StubSocket('dead');
  stale.sockets.set('p1', dead);
  dead.close();
  ok(stale.isEmpty, 'a closed socket does not keep a room alive');
  ok(stale.sockets.size === 0, 'and it is dropped from the socket map on sight');

  // Hitting the cap sweeps first, so a day of abandoned lobbies cannot lock the
  // server out of service until somebody restarts it.
  const tight = new RoomManager({ maxRooms: 2, emptyTtlMs: 1000, idleTtlMs: 1000 });
  tight.create(0); tight.create(0);
  const after = tight.create(50_000);
  ok(after.ok && tight.size === 1, 'a room at the cap sweeps the dead ones and then opens');
}

// ===========================================================================
section('rooms: fan-out gives every device the board and only its own hand');
// ===========================================================================
{
  const room = new Room('TEST', 0);
  room.engine.addPlayer('p1', 'Alice', { isHost: true });
  room.engine.addPlayer('p2', 'Bob');
  room.engine.startGame('p1');

  const a = new StubSocket('a'), b = new StubSocket('b');
  room.sockets.set('p1', a);
  room.sockets.set('p2', b);
  room.broadcast();

  const sa = a.last('state'), sb = b.last('state');
  ok(sa && sb, 'both sockets got a state message');
  ok(sa.priv.playerId === 'p1' && sb.priv.playerId === 'p2', 'each private half is addressed to its own seat');
  ok(sa.priv.hand.length === 7 && sb.priv.hand.length === 7, 'both hands were dealt');
  ok(JSON.stringify(sa.pub) === JSON.stringify(sb.pub), 'the public half is identical for everyone');
  ok(!('hands' in sa.pub) && !('deck' in sa.pub) && !('discards' in sa.pub),
    'the public half carries no cards at all');

  // The real test of the split: Alice's payload must not contain Bob's cards
  // anywhere in it, not merely under a different key.
  const bobCards = sb.priv.hand.map((c) => c.id);
  const alicePayload = JSON.stringify(sa);
  ok(bobCards.every((id) => !alicePayload.includes(id)),
    "no card of Bob's appears anywhere in the payload addressed to Alice");

  // A departed socket must not be written to. StubSocket throws on that, so the
  // absence of a throw here is the assertion.
  b.close();
  let threw = false;
  try { room.broadcast(); } catch (_) { threw = true; }
  ok(!threw, 'a closed socket is skipped rather than written to');
  ok(room.sockets.size === 1, 'and is dropped from the room');

  ok(send(null, { type: 'x' }) === false, 'send() to nothing returns false rather than throwing');
  const circular = {}; circular.self = circular;
  ok(send(new StubSocket('c'), circular) === false, 'send() survives an unserialisable payload');
}

// ===========================================================================
section('session: hosting and joining');
// ===========================================================================
{
  const { manager, code, clients, owner } = table(['Alice', 'Bob']);
  const welcome = owner.ws.all('welcome')[0];
  ok(welcome.owner === true, 'the creator is told it owns the room');
  ok(welcome.playerId === 'p1', 'seats are server-issued, starting at p1');
  ok(manager.get(code).engine.hostId === 'p1', 'and the engine agrees who the host is');
  ok(clients[1].ws.last('welcome').owner === false, 'a joiner is told it does not own the room');
  ok(clients[1].playerId === 'p2', 'the second seat is p2');

  const pub = clients[1].state.pub;
  ok(pub.players.length === 2 && pub.players[1].name === 'Bob', 'the join was broadcast to everybody');

  // One room per socket. A connection that could hold two would be a connection
  // that could hold fifty.
  owner.ws.clear();
  owner.send({ type: 'createRoom', name: 'Alice', clientId: cid('Alice') });
  ok(owner.ws.last('error'), 'a second createRoom on the same socket is refused');
  ok(manager.size === 1, 'and no second room was created');
  owner.ws.clear();
  owner.send({ type: 'join', code, name: 'Alice', clientId: cid('Alice') });
  ok(owner.ws.last('error'), 'so is a join on a socket that already has a seat');

  // Bad input on the way in.
  const bad = connect(manager, 'bad');
  bad.send({ type: 'join', code: 'NOPE', name: 'X', clientId: cid('x') });
  ok(bad.ws.last('rejected').reason === 'bad-code', 'a code outside the alphabet is refused');
  bad.ws.clear();
  bad.send({ type: 'join', code, name: 'Zoe', clientId: 'short' });
  ok(bad.ws.last('rejected').reason === 'bad-client', 'a malformed clientId is refused');
  bad.ws.clear();
  bad.send({ type: 'join', code, name: '   ', clientId: cid('zoe') });
  ok(bad.ws.last('rejected').reason === 'bad-name', 'a blank name is refused');
  bad.ws.clear();
  bad.send({ type: 'join', code, name: 'x'.repeat(500), clientId: cid('zoe') });
  ok(bad.ws.last('rejected').reason === 'bad-name', 'a name that is really a payload is refused');
  bad.ws.clear();

  // 'no-room' is the signal the client falls back to P2P on, so it has to be
  // distinguishable from every other refusal.
  bad.send({ type: 'join', code: 'ZZZZ', name: 'Zoe', clientId: cid('zoe') });
  ok(bad.ws.last('rejected').reason === 'no-room', 'an unknown code says no-room, not bad-code');

  // Names are unique at a table, and in the lobby the refusal must come before the
  // engine's reclaim-by-name branch is reachable.
  bad.ws.clear();
  bad.send({ type: 'join', code, name: 'alice', clientId: cid('zoe') });
  ok(bad.ws.last('rejected').reason === 'name-taken', 'a duplicate name is refused, case-insensitively');
  ok(manager.get(code).engine.players.length === 2, 'and the table did not change');
  ok(manager.get(code).engine.players[0].id === 'p1', "and Alice's seat is untouched");
}

// ===========================================================================
section('session: lobbyQuery answers only public facts');
// ===========================================================================
{
  const { manager, code, owner } = table(['Alice', 'Bob']);
  const probe = connect(manager, 'probe');
  probe.send({ type: 'lobbyQuery', code });
  const info = probe.ws.last('lobbyInfo').info;
  ok(info && info.hostName === 'Alice' && info.playerCount === 2 && info.joinable === true,
    'lobbyQuery reports the host name, the count and whether it is joinable');
  ok(!('players' in info) && !('layout' in info), 'and nothing else');

  probe.ws.clear();
  probe.send({ type: 'lobbyQuery', code: 'ZZZZ' });
  ok(probe.ws.last('lobbyInfo').info === null, 'an unknown code returns null rather than an error');
  probe.ws.clear();
  probe.send({ type: 'lobbyQuery', code: 12345 });
  ok(probe.ws.last('lobbyInfo').info === null, 'a non-string code returns null');

  owner.send({ type: 'startGame' });
  probe.ws.clear();
  probe.send({ type: 'lobbyQuery', code });
  ok(probe.ws.last('lobbyInfo').info.joinable === false, 'a started game is not joinable');
  ok(manager.joinable().length === 0, 'and it drops off the public room list');
}

// ===========================================================================
section('session: the room list lists only joinable lobbies');
// ===========================================================================
{
  const m = new RoomManager();
  const a = connect(m, 'a');
  a.send({ type: 'createRoom', name: 'Alice', clientId: cid('alice') });
  const codeA = a.ws.last('welcome').code;
  const b = connect(m, 'b');
  b.send({ type: 'createRoom', name: 'Bea', clientId: cid('bea') });
  const codeB = b.ws.last('welcome').code;

  ok(m.joinable().length === 2, 'both open lobbies are listed');

  // Fill one to MAX_PLAYERS and it should drop off.
  const room = m.get(codeB);
  for (let i = 1; i < MAX_PLAYERS; i++) room.engine.addPlayer('x' + i, 'Extra' + i);
  ok(room.engine.players.length === MAX_PLAYERS, 'the room filled up');
  const list = m.joinable();
  ok(list.length === 1 && list[0].code === codeA, 'a full lobby is not offered');
  ok(list[0].hostName === 'Alice' && typeof list[0].playerCount === 'number',
    'the listing carries a host name and a count');
  ok(!('seats' in list[0]) && !JSON.stringify(list[0]).includes('client'),
    'and no seat or device identifiers');
}

// ===========================================================================
section('SECURITY: a seat belongs to a clientId, never to a name');
// ===========================================================================
{
  const { manager, code, clients, owner } = table(['Alice', 'Bob', 'Cara', 'Dan']);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });
  ok(room.engine.phase === PHASES.PLAY, 'the game started');

  const aliceHand = clients[0].state.priv.hand.map((c) => c.id);
  ok(aliceHand.length === 6, 'Alice holds a full hand');

  // THE attack this server exists to refuse. Room codes are four characters and
  // /rooms publishes the open ones, so "type Alice's name into her game and take
  // her hand" must be impossible rather than unlikely.
  const attacker = connect(manager, 'attacker');
  attacker.send({ type: 'join', code, name: 'Alice', clientId: 'attacker-client-1' });
  const refusal = attacker.ws.last('rejected');
  ok(refusal && refusal.reason === 'in-progress',
    'a stranger using a seated player\'s name mid-game is refused');
  ok(attacker.ws.all('state').length === 0, 'and is sent no state at all');
  ok(attacker.ws.all('welcome').length === 0, 'and no seat');
  ok(room.engine.getPlayer('p1').name === 'Alice' && room.engine.hostId === 'p1',
    "Alice's seat and the host id are unchanged");
  ok(JSON.stringify(room.engine.hands['p1'].map((c) => c.id)) === JSON.stringify(aliceHand),
    "and Alice's hand is untouched");

  // The same attempt with a name nobody is using is refused for the same reason:
  // mid-game there is no path into addPlayer at all.
  attacker.ws.clear();
  attacker.send({ type: 'join', code, name: 'Nobody', clientId: 'attacker-client-2' });
  ok(attacker.ws.last('rejected').reason === 'in-progress', 'no mid-game joins, full stop');
  ok(room.engine.players.length === 4, 'the table is still four');

  // And the owner's chair cannot be taken by claiming to be the owner.
  attacker.ws.clear();
  attacker.send({ type: 'createRoom', name: 'Alice', clientId: 'attacker-client-3' });
  ok(manager.get(code).engine.hostId === 'p1', 'creating a room elsewhere does not touch this one');
}

// ===========================================================================
section('SECURITY: the right device reclaims the right seat, mid-game');
// ===========================================================================
{
  const { manager, code, clients, owner } = table(['Alice', 'Bob']);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });
  const bobHand = JSON.stringify(room.engine.hands['p2'].map((c) => c.id));

  // Bob's phone locks. The seat and the hand are held.
  clients[1].drop();
  ok(room.engine.getPlayer('p2').online === false, 'a mid-game dropout is marked offline');
  ok(room.engine.getPlayer('p2') !== undefined, 'and keeps the seat');
  ok(room.engine.hands['p2'].length > 0, 'and the hand');
  ok(room.sockets.has('p2') === false, 'and the socket is released');

  // Bob comes back on a new socket, with a different name in the box, and gets his
  // own seat back — under his own name, because a reclaim is not a rename.
  const back = connect(manager, 'bob-again');
  back.send({ type: 'join', code, name: 'Robert The Impostor', clientId: cid('Bob') });
  const w = back.ws.last('welcome');
  ok(w && w.playerId === 'p2', 'the returning device gets its own seat back');
  ok(room.engine.getPlayer('p2').name === 'Bob', 'and comes back under the name it left with');
  ok(room.engine.getPlayer('p2').online === true, 'and is online again');
  ok(JSON.stringify(room.engine.hands['p2'].map((c) => c.id)) === bobHand, 'with the same hand');
  ok(back.state.priv.hand.length > 0, 'and is sent that hand immediately');
  ok(room.engine.players.length === 2, 'no extra seat was created');

  // A second device on the same clientId takes over rather than doubling up — and,
  // critically, the OLD socket's close event must not then release the seat the
  // new one just took.
  const third = connect(manager, 'bob-third');
  third.send({ type: 'join', code, name: 'Bob', clientId: cid('Bob') });
  ok(back.ws.last('rejected').reason === 'replaced', 'the displaced socket is told why');
  ok(back.ws.readyState === 3, 'and closed');
  ok(room.sockets.get('p2') === third.ws, 'the seat points at the new socket');
  back.session.detach();
  ok(room.engine.getPlayer('p2').online === true,
    'the displaced socket closing afterwards does NOT knock the seat offline');
  ok(room.sockets.get('p2') === third.ws, 'and does not unbind it');
}

// ===========================================================================
section('SECURITY: a lobby dropout releases the seat but not the claim on it');
// ===========================================================================
{
  const { manager, code, clients, owner } = table(['Alice', 'Bob', 'Cara']);
  const room = manager.get(code);

  // In the lobby a dropout must free the seat outright: Sequence needs an exact
  // player count to split into equal teams, so a ghost seat blocks the start.
  clients[1].drop();
  ok(room.engine.players.length === 2, 'a lobby dropout releases the seat');
  ok(room.engine.players.every((p) => p.id !== 'p2'), 'and the player is gone');
  ok(room.seats.get(cid('Bob')) === 'p2', 'but the device keeps its claim on the seat id');

  // Bob returns to the same seat id, under the name he left with.
  const back = connect(manager, 'bob-again');
  back.send({ type: 'join', code, name: 'Bob', clientId: cid('Bob') });
  ok(back.playerId === 'p2', 'the returning device is re-seated at the same id');
  ok(room.engine.players.length === 3, 'and the table is whole again');

  // The owner leaving the lobby is the interesting case: engine.hostId still names
  // a seat that no longer exists, so the returning owner has to come back AS the
  // host or the room is unstartable.
  owner.drop();
  ok(room.engine.players.length === 2, "the owner's lobby seat was released too");
  ok(room.engine.hostId === 'p1', 'and hostId still names it');
  const ownerBack = connect(manager, 'alice-again');
  ownerBack.send({ type: 'join', code, name: 'Alice', clientId: cid('Alice') });
  ok(ownerBack.playerId === 'p1', 'the owner returns to seat p1');
  ok(ownerBack.ws.last('welcome').owner === true, 'and is told it still owns the room');
  ok(room.engine.hostId === 'p1' && room.engine.getPlayer('p1').isHost === true,
    'and the engine agrees, so the game can still be started');

  // Somebody else taking the name while the seat was empty is refused rather than
  // resolved — the alternative is renaming a stranger or handing the returning
  // device a name that is not its own.
  const cara = manager.get(code);
  cara.engine.players.find((p) => p.id === 'p3').name = 'Bob';
  const clash = connect(manager, 'bob-clash');
  clash.send({ type: 'join', code, name: 'Bob', clientId: 'bob-second-device' });
  ok(clash.ws.last('rejected').reason === 'name-taken', 'a name already at the table is refused');
}

// ===========================================================================
section('SECURITY: owner-only intents are refused for everyone else');
// ===========================================================================
{
  const { manager, code, clients, owner } = table(['Alice', 'Bob', 'Cara', 'Dan']);
  const room = manager.get(code);
  const bob = clients[1];

  // The three that the engine does NOT check for itself — they were unreachable
  // from the wire before server mode existed, so the guard lives in intents.js, at
  // the seam that made them reachable.
  const before = JSON.stringify(room.engine.config);
  bob.ws.clear();
  bob.send({ type: 'setConfig', patch: { showTargets: false, shuffleBoard: true } });
  ok(/host/i.test(bob.ws.last('error').message), 'a non-owner cannot change the setup');
  ok(JSON.stringify(room.engine.config) === before, 'and the config did not move');

  const order = room.engine.players.map((p) => p.id).join(',');
  bob.ws.clear();
  bob.send({ type: 'movePlayer', playerId: 'p1', dir: -1 });
  ok(bob.ws.last('error'), 'a non-owner cannot reseat anybody');
  bob.ws.clear();
  bob.send({ type: 'randomizeOrder' });
  ok(bob.ws.last('error'), 'a non-owner cannot shuffle the seating');
  ok(room.engine.players.map((p) => p.id).join(',') === order, 'and the seating did not move');

  // The four the engine checks on its own account. Belt and braces, and they must
  // agree.
  bob.ws.clear();
  bob.send({ type: 'startGame' });
  ok(bob.ws.last('error'), 'a non-owner cannot start the game');
  ok(room.engine.phase === PHASES.LOBBY, 'and the game did not start');

  owner.send({ type: 'startGame' });
  ok(room.engine.phase === PHASES.PLAY, 'the owner can');

  bob.ws.clear();
  bob.send({ type: 'skipTurn' });
  ok(bob.ws.last('error'), 'a non-owner cannot skip a turn');
  bob.ws.clear();
  bob.send({ type: 'endGame' });
  ok(bob.ws.last('error'), 'a non-owner cannot end the game');
  ok(room.engine.phase === PHASES.PLAY, 'and the game is still on');

  // The owner's own controls still work, and the owner is just a client sending
  // the same wire messages.
  const turnBefore = room.engine.currentPlayer.id;
  owner.send({ type: 'skipTurn' });
  ok(room.engine.currentPlayer.id !== turnBefore, 'the owner can skip a turn');
  owner.send({ type: 'endGame' });
  ok(room.engine.phase === PHASES.GAME_OVER, 'and end the game');
  owner.send({ type: 'playAgain' });
  ok(room.engine.phase === PHASES.LOBBY, 'and call a rematch');
}

// ===========================================================================
section('SECURITY: a player cannot act as another player, or out of turn');
// ===========================================================================
{
  const { manager, code, clients, owner } = table(['Alice', 'Bob']);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });

  const turnId = room.engine.currentPlayer.id;
  const waiting = clients.find((c) => c.playerId !== turnId);
  const actor = clients.find((c) => c.playerId === turnId);

  // The actor id comes from the socket's own seat, never from the message, so
  // there is no field to forge. Spelled out as a test because it is the kind of
  // thing a later refactor could quietly break.
  const card = actor.state.priv.hand.find((c) => c.targets.length > 0);
  const othersCard = waiting.state.priv.hand[0];
  waiting.ws.clear();
  waiting.send({ type: 'playCard', cardId: card.id, cell: card.targets[0], playerId: turnId });
  ok(waiting.ws.last('error'), 'playing out of turn is refused');
  ok(room.engine.chips[card.targets[0]] === null, 'and no chip was placed');
  ok(room.engine.currentPlayer.id === turnId, 'and the turn did not move');

  // A card that is not in your hand.
  actor.ws.clear();
  actor.send({ type: 'playCard', cardId: othersCard.id, cell: 0 });
  ok(actor.ws.last('error'), "playing someone else's card is refused");

  // Junk that passes the frame decoder but means nothing.
  actor.ws.clear();
  actor.send({ type: 'notAnIntent', cell: 0 });
  ok(actor.ws.all('error').length === 0 && actor.ws.all('state').length === 0,
    'an unknown intent is dropped in silence');
  actor.send({ type: 'playCard' });
  actor.send({ type: 'playCard', cardId: null, cell: null });
  actor.send({ type: 'playCard', cardId: 'x'.repeat(9999), cell: 0 });
  actor.send({ type: 'playCard', cardId: card.id, cell: 9999 });
  actor.send({ type: 'setConfig', patch: 'everything' });
  actor.send({ type: 'exchangeDead' });
  actor.send({ type: 'movePlayer', playerId: { nested: true }, dir: 1 });
  ok(room.engine.phase === PHASES.PLAY && room.engine.chips.every((c) => c === null),
    'a barrage of malformed intents changes nothing');

  // An unseated socket has no actor to be, so its intents go nowhere.
  const lurker = connect(manager, 'lurker');
  lurker.send({ type: 'playCard', cardId: card.id, cell: card.targets[0] });
  lurker.send({ type: 'startGame' });
  ok(lurker.ws.sent.length === 0, 'an unseated socket gets no reply to a game intent');
  ok(room.engine.chips.every((c) => c === null), 'and changes nothing');
}

// ===========================================================================
section('SECURITY: a hostile config patch is dropped, not stored');
// ===========================================================================
{
  const { manager, code, owner } = table(['Alice', 'Bob']);
  const room = manager.get(code);

  owner.send({ type: 'setConfig', patch: { __proto__: { polluted: true }, showTargets: false } });
  ok(({}).polluted === undefined, 'a patch cannot pollute Object.prototype');
  ok(room.engine.config.showTargets === false, 'the legitimate key in the same patch applied');
  ok(!('polluted' in room.engine.config), 'the hostile key is not in the config');

  owner.send({ type: 'setConfig', patch: { constructor: 'nope', evil: 1, sequenceLength: 5 } });
  ok(!('evil' in room.engine.config), 'an unknown key is dropped by normalizeConfig');
  ok(typeof room.engine.config.sequenceLength === 'number', 'and the known one survives');

  // Values are clamped rather than trusted: a sequence length of a million would
  // otherwise be handed to the geometry.
  owner.send({ type: 'setConfig', patch: { sequenceLength: 1_000_000 } });
  ok(room.engine.config.sequenceLength <= 6, 'an absurd value is clamped');
  owner.send({ type: 'setConfig', patch: { sequenceLength: -5 } });
  ok(room.engine.config.sequenceLength >= 4, 'so is a negative one');
  owner.send({ type: 'setConfig', patch: { deadCardsPerTurn: 'lots' } });
  ok(typeof room.engine.config.deadCardsPerTurn === 'number', 'a stringy value does not stick');

  const wide = {};
  for (let i = 0; i < 40; i++) wide['k' + i] = i;
  wide.showTargets = true;
  owner.send({ type: 'setConfig', patch: wide });
  ok(room.engine.config.showTargets === false,
    'an oversized patch is refused whole, legitimate keys and all');
}

// ===========================================================================
section('SECURITY: the rate limit refuses a flood without amplifying it');
// ===========================================================================
{
  const { manager, code, clients, owner } = table(['Alice', 'Bob'], undefined);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });

  // A flooder in a room. The bucket sits in FRONT of the dispatch, so a refused
  // message costs the room nothing — no broadcast, and no reply either, because
  // answering "too fast" to every packet of a flood is the amplification the
  // bucket exists to prevent.
  const flooder = connect(manager, 'flooder', { rate: { capacity: 5, refillPerSec: 1, now: 0 } });
  flooder.send({ type: 'join', code, name: 'Flo', clientId: cid('flo') }, 0);
  ok(flooder.ws.all('rejected').length === 1, 'the join itself was refused (game under way)');
  flooder.ws.clear();

  let replies = 0;
  for (let i = 0; i < 500; i++) {
    flooder.send({ type: 'lobbyQuery', code }, 0);
    replies = flooder.ws.sent.length;
  }
  ok(replies <= 5, `500 messages at a frozen clock produced at most 5 replies (got ${replies})`);

  // Persistent refusal is a script, not a slow phone, so the socket eventually
  // goes. 120 refusals past the bucket.
  ok(flooder.ws.readyState === 3, 'a sustained flood gets the socket closed');
  ok(flooder.ws.closes[0].code === 1008, 'with a policy-violation close code');
  const sentBefore = flooder.ws.sent.length;
  flooder.send({ type: 'lobbyQuery', code }, 0);
  ok(flooder.ws.sent.length === sentBefore, 'a closed session ignores everything after');

  // And the flood must not have disturbed the game.
  ok(room.engine.phase === PHASES.PLAY && room.engine.players.length === 2,
    'the game carried on through the flood');

  // A normal player's burst — tap a card, tap a space, tap again — is not a flood.
  const bob = clients[1];
  bob.ws.clear();
  for (let i = 0; i < 20; i++) bob.send({ type: 'lobbyQuery', code }, 1000);
  ok(bob.ws.all('lobbyInfo').length === 20, 'twenty taps in one moment are all served');
}

// ===========================================================================
section('SECURITY: raw frames that are not text JSON objects');
// ===========================================================================
{
  const { manager, code, owner } = table(['Alice', 'Bob']);
  const room = manager.get(code);
  const before = JSON.stringify(room.engine.publicState());

  owner.ws.clear();
  owner.raw(Buffer.from([0xde, 0xad, 0xbe, 0xef]), true);      // binary
  owner.raw('{"type":"startGame"', false);                      // truncated JSON
  owner.raw('[{"type":"startGame"}]', false);                   // array
  owner.raw('"startGame"', false);                              // bare string
  owner.raw('null', false);
  owner.raw(`{"type":"${'x'.repeat(200)}"}`, false);            // type as payload
  owner.raw(Buffer.from(JSON.stringify({ type: 'nonsense' })), false);
  ok(owner.ws.sent.length === 0, 'none of it produced a reply');
  ok(JSON.stringify(room.engine.publicState()) === before, 'and none of it changed the game');

  // A text frame arriving as a Buffer — which is how `ws` delivers it — must still
  // work, or nothing would.
  owner.raw(Buffer.from(JSON.stringify({ type: 'startGame' })), false);
  ok(room.engine.phase === PHASES.PLAY, 'a real intent in a Buffer is honoured');
}

// ===========================================================================
section('SECURITY: the seat map cannot grow without bound');
// ===========================================================================
{
  const { manager, code, owner } = table(['Alice']);
  const room = manager.get(code);

  // 200 devices churn through the lobby: join, then leave. Each one leaves a seat
  // claim behind so that it could come back — but the map has to stay finite.
  for (let i = 0; i < 200; i++) {
    const c = connect(manager, 'churn' + i);
    c.send({ type: 'join', code, name: 'Churn' + i, clientId: `churn-client-${1000 + i}` });
    c.drop();
  }
  ok(room.seats.size <= 48, `the seat map stayed bounded (${room.seats.size} entries)`);
  ok(room.seatNames.size <= 48, 'and so did the recorded names');
  ok(room.seats.get(cid('Alice')) === 'p1', "the owner's claim was never pruned");
  ok(room.engine.hostId === 'p1', 'so the room is still ownable');
  ok(room.engine.players.length === 1, 'and the table is back to just the owner');

  // The owner can still be re-seated after all that.
  owner.drop();
  const back = connect(manager, 'alice-again');
  back.send({ type: 'join', code, name: 'Alice', clientId: cid('Alice') });
  ok(back.ws.last('welcome') && back.ws.last('welcome').owner === true,
    'and the owner comes back as the owner');
}

// ===========================================================================
section('a whole game, played over the wire');
// ===========================================================================
{
  // Not a unit test: this drives four stub sockets through Session.handleFrame()
  // until somebody wins, using nothing but the state messages the server sends
  // back — the same loop a real client runs. It is the proof that the shared
  // engine and the shared intent dispatcher work on this transport, and that the
  // per-socket private state stays correct for hundreds of turns rather than just
  // at the deal.
  for (const s of [1, 2, 3, 11]) {
    seed(s);
    const { manager, code, clients, owner } = table(['Alice', 'Bob', 'Cara', 'Dan']);
    const room = manager.get(code);
    owner.send({ type: 'startGame' });

    const byId = new Map(clients.map((c) => [c.playerId, c]));
    let turns = 0, plays = 0, swaps = 0, passes = 0, errors = 0;
    const cap = 4000;

    while (room.engine.phase === PHASES.PLAY && turns < cap) {
      const pub = clients[0].state.pub;
      const actor = byId.get(pub.turnPlayerId);
      if (!actor) break;
      const priv = actor.state.priv;
      const before = actor.ws.all('error').length;

      const playable = priv.hand.find((c) => c.targets.length > 0);
      if (playable) {
        actor.send({ type: 'playCard', cardId: playable.id, cell: playable.targets[0] });
        plays++;
      } else {
        const dead = priv.hand.find((c) => c.dead);
        if (dead && priv.deadRemaining > 0) {
          actor.send({ type: 'exchangeDead', cardId: dead.id });
          swaps++;
        } else if (priv.canPass) {
          actor.send({ type: 'pass' });
          passes++;
        } else {
          break;      // genuinely stuck: a bug, and the assertions below will say so
        }
      }
      if (actor.ws.all('error').length > before) errors++;
      turns++;
    }

    ok(errors === 0, `seed ${s}: the server never refused a move its own state offered`);
    ok(room.engine.phase === PHASES.GAME_OVER, `seed ${s}: the game finished (${turns} turns)`);
    ok(room.engine.winner !== null, `seed ${s}: with a winner`);
    ok(plays > 0 && (swaps + passes) >= 0, `seed ${s}: cards were actually played`);

    // Privacy held for the whole game, not just at the deal.
    const finalPub = clients[0].state.pub;
    ok(!('hands' in finalPub) && !('deck' in finalPub),
      `seed ${s}: the public state never carried cards`);
    for (const c of clients) {
      ok(c.state.priv.playerId === c.playerId,
        `seed ${s}: ${c.label} only ever received its own private state`);
    }

    // Everyone saw the same board.
    const boards = clients.map((c) => JSON.stringify(c.state.pub.chips));
    ok(new Set(boards).size === 1, `seed ${s}: every device ended on the same board`);

    // And a rematch works over the wire too.
    owner.send({ type: 'playAgain' });
    ok(room.engine.phase === PHASES.LOBBY, `seed ${s}: playAgain returns everyone to the lobby`);
    owner.send({ type: 'startGame' });
    ok(room.engine.phase === PHASES.PLAY, `seed ${s}: and the next game deals`);
    ok(clients[3].state.priv.hand.length === 6, `seed ${s}: with fresh hands for everybody`);
  }
}

// ===========================================================================
section('a dropout and a reconnect in the middle of a real game');
// ===========================================================================
{
  seed(21);
  const { manager, code, clients, owner } = table(['Alice', 'Bob', 'Cara', 'Dan']);
  const room = manager.get(code);
  owner.send({ type: 'startGame' });

  // Play a few turns so there is state worth losing.
  const byId = new Map(clients.map((c) => [c.playerId, c]));
  for (let i = 0; i < 12 && room.engine.phase === PHASES.PLAY; i++) {
    const actor = byId.get(clients[0].state.pub.turnPlayerId);
    const priv = actor.state.priv;
    const card = priv.hand.find((c) => c.targets.length > 0);
    if (card) actor.send({ type: 'playCard', cardId: card.id, cell: card.targets[0] });
    else if (priv.canPass) actor.send({ type: 'pass' });
    else break;
  }
  const chipsBefore = JSON.stringify(room.engine.chips);
  const caraHand = JSON.stringify(room.engine.hands['p3'].map((c) => c.id));

  clients[2].drop();
  ok(room.engine.getPlayer('p3').online === false, 'Cara is offline');
  ok(clients[0].state.pub.players.find((p) => p.id === 'p3').online === false,
    'and the table was told');
  ok(JSON.stringify(room.engine.chips) === chipsBefore, 'the board is untouched');

  // The game carries on around her — the owner can skip her turn.
  if (room.engine.currentPlayer.id === 'p3') {
    owner.send({ type: 'skipTurn' });
    ok(room.engine.currentPlayer.id !== 'p3', 'the owner can skip an absent player');
  }

  const back = connect(manager, 'cara-again');
  back.send({ type: 'join', code, name: 'Cara', clientId: cid('Cara') });
  ok(back.playerId === 'p3', 'Cara reclaims her seat');
  ok(JSON.stringify(back.state.priv.hand.map((c) => c.id)) === caraHand, 'and her exact hand');
  ok(back.state.pub.chips.join() === room.engine.chips.join(), 'and the current board');
  ok(room.engine.getPlayer('p3').online === true, 'and is online');
  ok(room.engine.players.length === 4, 'with no duplicate seat');

  // Everybody is still consistent.
  const boards = [clients[0], clients[1], back, clients[3]].map((c) => JSON.stringify(c.state.pub.chips));
  ok(new Set(boards).size === 1, 'and every device agrees on the board');
}

// ===========================================================================
section('the engine is shared, not copied');
// ===========================================================================
{
  // The whole design rests on the server running the same GameEngine the browser
  // runs. If that ever stopped being true — a vendored copy, a divergent import —
  // these two would drift, so it is asserted rather than assumed.
  const room = new Room('SAME', 0);
  ok(room.engine instanceof GameEngine, 'a Room owns a real GameEngine');
  const direct = new GameEngine();
  ok(Object.getPrototypeOf(room.engine) === Object.getPrototypeOf(direct),
    'and it is the very same class the client imports');
  ok(room.engine.phase === PHASES.LOBBY, 'starting, as always, in the lobby');
}

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
