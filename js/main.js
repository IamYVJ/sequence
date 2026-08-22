// ============================================================================
// main.js — App controller. Wires the network layer, the host's authoritative
// engine, user intents and the view together.
//
//   HOST  : owns a GameEngine, applies every intent through it, then sends each
//           connection the public state plus that player's own hand.
//   CLIENT: holds the last public+private snapshot received from the host and
//           sends intents over the wire.
//
// There are two transports, and the CLIENT half above is the same code for both:
//
//   p2p    — WebRTC via PeerJS. One browser is the host. Works on a plane.
//   server — WebSocket to an authoritative server. NO browser is the host, so even
//            the room's owner is a client here.
//
// Peer-to-peer is the default and the fallback, and nothing about it changed to make
// room for the second transport. Server mode exists only if js/config.js names a
// server AND a live health probe answers; otherwise not one pixel of it is drawn.
// ============================================================================

import { GameEngine } from './state.js';
import {
  createHost, joinHost, createDiscovery,
  describePeerError, isFatalPeerError, peerIdForCode,
  serverTransport, probeServer, fetchServerRooms, describeServerRejection,
} from './net.js';
import { render } from './ui.js';
import { applyGameIntent } from './intents.js';
import { validClientId } from './guards.js';
import { highlightsOn, peeksAllowed } from './rules.js';
import { SERVER_URL, SERVER_HEALTH, SERVER_ROOMS, serverConfigured } from './config.js';
import {
  generateRoomCode, normalizeCode, copyText, CODE_LENGTH,
  loadName, saveName, loadCode, saveCode, clientId,
  saveSession, loadSession, clearSession, saveEngineSnapshot, loadEngineSnapshot,
} from './util.js';

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// App state (everything the view needs to draw).
// ---------------------------------------------------------------------------
const app = {
  screen: 'home',              // home | join | connecting | game | error | hostleft

  // Which transport is carrying this game.
  //   'p2p'    — WebRTC star, one browser owns the engine (the original mode).
  //   'server' — WebSocket to the authoritative server; NO browser owns an engine.
  mode: 'p2p',

  // isHost means "this tab runs the engine", and it is what routes an intent
  // locally instead of over the wire. isOwner means "this player holds the room's
  // controls". They are the same person in p2p and different things on the server,
  // where the owner is a client like anyone else — so every control in the UI is
  // gated on isOwner, and only sendIntent looks at isHost.
  me: { id: null, name: loadName(), isHost: false, isOwner: false },
  code: loadCode(),
  pub: null,
  priv: null,
  error: '',
  copied: false,
  showRules: false,
  online: navigator.onLine !== false,
  reconnecting: false,         // client lost the host and is retrying
  // Something is wrong with the connection but the game is still playable —
  // shown as a banner over the board rather than replacing it.
  netWarning: '',

  // Local-network game discovery (Join screen).
  discovered: [],
  discoveryState: 'idle',      // idle | searching | ok | unsupported

  // The optional server. 'off' means no endpoint is configured at all, and the UI
  // then shows nothing server-shaped anywhere — the app is the static P2P game it
  // has always been. Every other value comes from a live /health probe, so a server
  // that is unplugged is never offered.
  server: { state: serverConfigured() ? 'unknown' : 'off', version: '' },
  // Open lobbies on the server (Join screen). null = no list to be had.
  serverRooms: null,

  // Board interaction — purely local, never sent anywhere. Selecting a card
  // lights up the spaces it may legally go on.
  selectedCardId: null,
  zoom: false,                 // scale the board up for precise tapping
  confirmEnd: false,           // host armed END GAME and needs a second tap
  // A chip hides the card printed under it, and that card is exactly what you need
  // to read before choosing which chip to lift with a one-eyed Jack — or to work
  // out whether both spaces for a card in your hand are already gone. peekCell
  // opens one space for a moment; peekAll holds the whole board open.
  peekCell: null,
  peekAll: false,
  // Which board space holds the keyboard's place. The board is a single tab stop
  // and the arrow keys move this, so it is the one cell with tabindex 0.
  cursor: 0,
};

// Host-only runtime.
let engine = null;
let net = null;
// Has the host's peer ever reached the broker? Before it has, an error means we
// never got a room code and there is no game to protect — so it is fatal. After
// it has, the same error is survivable.
let hostReady = false;

// Client-only: background peer used to find games on the Join screen.
let discovery = null;
let discoveryTimer = null;

// Client-only: retry state for reconnecting to a host that went away.
let reconnectTimer = null;
let reconnectTries = 0;
const RECONNECT_TRIES = 6;   // 1+2+4+8+8+8s ≈ 30s before we call it a night

// Client-only: a join attempt that never finishes.
//
// PeerJS reports a missing host promptly, but a host that IS reachable on the
// broker and yet cannot be reached over WebRTC — the two devices are on networks
// that will not route to each other — produces no event at all. Without a
// deadline the joiner watches 'Connecting…' forever with nothing to do about it.
let joinTimer = null;
const JOIN_TIMEOUT = 12000;

function clearJoinTimer() {
  if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
}

// Server-mode runtime.
//
// What a reconnect must do next. A room is created ONCE: if the owner's socket
// blips, retrying with createRoom would open a second, empty room and abandon the
// game — so this remembers to come back with `join`, which is what reclaims the
// existing seat via the device's clientId.
let serverIntent = null;   // { code, name, create } — create only ever true first time
let roomsTimer = null;     // Join-screen poll for the open-lobby list
const ROOMS_POLL_MS = 5000;

// A single-space peek closes itself, so it needs a cancellable timer: tapping a
// second chip must not inherit the first tap's expiry and shut early.
let peekTimer = null;
const PEEK_MS = 1600;

function clearPeek() {
  if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
  app.peekCell = null;
}

// ---------------------------------------------------------------------------
// Render wrapper — keeps local UI bookkeeping in sync first.
// ---------------------------------------------------------------------------
// Which screen the last render showed. A re-render of the SAME screen is a state
// update and should be visually seamless; a different screen is a transition and
// gets the entrance animation and a scroll to the top.
let lastView = null;
let lastMoveKey = null;
// The next render moved the board cursor, so it may need to bring the new cell
// into view. Set by setCursor and consumed once by draw.
let revealCursor = false;
// data-focus key of the control that opened the rules sheet, so closing it can
// return the keyboard there.
let rulesOpener = null;

function viewKey() {
  return app.screen === 'game' && app.pub ? `game:${app.pub.phase}` : app.screen;
}

// Identifies the most recent move. A chip should animate in when it is actually
// played, not every time a rebuild re-creates it — and the cell alone is not
// enough, since a one-eyed Jack can clear a space that is then played again.
function moveKey() {
  const m = app.pub && app.pub.lastMove;
  return m ? `${app.pub.log.length}:${m.cell}` : null;
}

function draw() {
  // Drop a card selection once that card leaves our hand. This is what clears
  // the highlight after a successful play (the replacement card has a new id),
  // while a REJECTED play keeps the selection so the player can just tap again.
  if (app.selectedCardId) {
    const hand = (app.priv && app.priv.hand) || [];
    if (!hand.some((c) => c.id === app.selectedCardId)) app.selectedCardId = null;
  }

  const view = viewKey();
  const sameView = view === lastView;
  lastView = view;
  // Never carry an armed END GAME across a screen change — the button that armed
  // it is gone, so there would be nothing on screen explaining the state. Same
  // reasoning for a peek: the board it was opened on is no longer here.
  if (!sameView) {
    app.confirmEnd = false;
    app.peekAll = false;
    clearPeek();
  }

  // Preserve focus + caret across full re-renders (a state broadcast can redraw
  // the page while someone is typing their name).
  const active = document.activeElement;
  const focusKey = active && active.getAttribute ? active.getAttribute('data-focus') : null;
  let selStart = null, selEnd = null;
  if (focusKey) { try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {} }

  // Scroll survives the same way. Losing it hurts most exactly where it matters:
  // in zoom mode a rebuild would snap the board back to column one, every time
  // anyone anywhere took a turn.
  const scrolls = new Map();
  for (const node of root.querySelectorAll('[data-keep-scroll]')) {
    scrolls.set(node.getAttribute('data-keep-scroll'), [node.scrollLeft, node.scrollTop]);
  }
  const pageY = window.scrollY;

  const move = moveKey();
  const freshMove = move != null && move !== lastMoveKey;
  lastMoveKey = move;

  root.classList.toggle('rerender', sameView);
  root.classList.toggle('fresh-move', freshMove);
  render(root, app, intents);

  if (focusKey) {
    const next = root.querySelector(`[data-focus="${focusKey}"]`);
    if (next) {
      // preventScroll: we restore the scroll position ourselves just below, and
      // the browser's own scroll-into-view would override it.
      next.focus({ preventScroll: true });
      if (selStart != null) { try { next.setSelectionRange(selStart, selEnd); } catch (_) {} }
    }
  }

  for (const node of root.querySelectorAll('[data-keep-scroll]')) {
    const saved = scrolls.get(node.getAttribute('data-keep-scroll'));
    if (saved) { node.scrollLeft = saved[0]; node.scrollTop = saved[1]; }
  }
  if (sameView) { if (pageY) window.scrollTo(0, pageY); }
  else window.scrollTo(0, 0);

  // A cursor move is the one focus change the player drove themselves, so it gets
  // to override the scroll preservation above — otherwise arrowing past the edge
  // of a zoomed board would land focus on a cell nobody can see.
  if (revealCursor) {
    revealCursor = false;
    const cell = root.querySelector('[data-focus="board-cell"]');
    if (cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  announce(root.querySelector('[data-announce]'));
}

// The screen-reader live region lives outside #app (see index.html) because a
// region only fires when text changes in a node the reader already knows about.
// Each screen declares its message as a data-announce attribute; this copies it
// across, and the guard keeps an unchanged message from being repeated.
function announce(source) {
  const region = document.getElementById('announce');
  if (!region) return;
  const text = source ? source.getAttribute('data-announce') : '';
  if (region.textContent !== text) region.textContent = text;
}

// ---------------------------------------------------------------------------
// HOST: push state. Renders the host's own view and sends every client the
// public state plus ONLY that player's private slice.
// ---------------------------------------------------------------------------
function hostSync() {
  app.pub = engine.publicState();
  app.priv = engine.privateStateFor(app.me.id);
  saveEngineSnapshot(engine.serialize());
  draw();

  for (const connId of net.connections.keys()) {
    net.sendTo(connId, {
      type: 'state',
      pub: app.pub,
      priv: engine.privateStateFor(connId),
    });
  }
}

// Deliver a rejection to ONE player, whoever they are.
//
// net.sendTo() resolves connId against the peer-connection map, and the host has
// NO connection to itself — so routing the host's own rejection through it would
// drop the message silently and the host would see nothing happen at all.
function rejectTo(playerId, message) {
  if (playerId === app.me.id) { app.error = message || ''; return; }
  if (net) net.sendTo(playerId, { type: 'error', message });
}

// ---------------------------------------------------------------------------
// HOST: apply one player's intent through the engine (validation lives there).
// Used both for remote clients and for the host's own taps.
// ---------------------------------------------------------------------------
// Everything reaching this function came off the wire from a peer we do not
// control. The engine validates game legality, but a message can still be
// malformed in ways that throw — and an exception here escapes into PeerJS's
// data callback, which would take down the host tab and the game with it.
function handleIntent(playerId, msg) {
  try {
    dispatchIntent(playerId, msg);
  } catch (err) {
    console.warn('Dropped an unprocessable message from', playerId, err);
  }
}

function dispatchIntent(playerId, msg) {
  if (!msg || typeof msg.type !== 'string') return;

  // Identity and connection lifecycle are this transport's business — a peer id
  // is not a server seat — so they stay here rather than in the shared module.
  switch (msg.type) {
    case 'lobbyQuery':
      net.sendTo(playerId, { type: 'lobbyInfo', info: engine.lobbyInfo(app.me.name) });
      return;

    case 'join': {
      // A malformed clientId is dropped rather than rejected: it costs the sender
      // its claim on a seat, which is the sender's problem, and an old client that
      // sends none at all still gets to play.
      const r = engine.addPlayer(playerId, msg.name, {
        isHost: false,
        clientId: validClientId(msg.clientId),
      });
      if (!r.ok) { net.sendTo(playerId, { type: 'rejected', message: r.error }); return; }
      // A reconnect reclaimed a seat under a new connection id. Drop the old,
      // now-orphaned connection so it can't later fire a disconnect against the
      // seat we just handed back.
      if (r.reconnected && r.prevId && r.prevId !== playerId) net.dropConnection(r.prevId);
      net.sendTo(playerId, { type: 'welcome', playerId });
      hostSync();
      return;
    }

    default: break;
  }

  // Everything else is a game intent, and goes through the same dispatcher the
  // server uses — so the two authoritative hosts cannot disagree about what a
  // message means. The owner guard lives in there too.
  const { handled, result } = applyGameIntent(engine, playerId, msg);
  if (!handled) return;
  if (!result.ok) rejectTo(playerId, result.error);
  hostSync();
}

// ---------------------------------------------------------------------------
// Start hosting.
// ---------------------------------------------------------------------------
function hostHandlers() {
  const warn = (text) => { app.netWarning = text; draw(); };
  const clearWarning = () => {
    if (!app.netWarning) return;
    app.netWarning = '';
    draw();
  };

  return {
    onOpen: () => { hostReady = true; },
    onConnect: (connId) => { net.sendTo(connId, { type: 'lobbyInfo', info: engine.lobbyInfo(app.me.name) }); },
    onData: (connId, msg) => handleIntent(connId, msg),
    onDisconnect: (connId) => { engine.markOffline(connId); hostSync(); },

    onBrokerDown: () => warn('Lost the connection server — reconnecting. Players already in the game are unaffected.'),
    onBrokerUp: clearWarning,
    onBrokerLost: () => warn(`Can't reach the connection server, so no new players can join with code ${app.code}. The game itself carries on.`),

    // A broker failure does NOT break the DataConnections we already have: those
    // run device-to-device. Tearing the board down over one would throw away a
    // game that is still perfectly playable, so only a genuinely unrecoverable
    // error — or one that arrives before we ever got a room code — ends things.
    onError: (err) => {
      if (isFatalPeerError(err) || !hostReady) {
        app.screen = 'error';
        app.error = describePeerError(err);
        draw();
        return;
      }
      warn(describePeerError(err));
    },
  };
}

function startHosting() {
  const name = (app.me.name || '').trim();
  if (!name) { app.screen = 'home'; app.error = 'Enter a name first.'; draw(); return; }

  stopDiscovery();
  stopRoomsPoll();
  saveName(name);
  const code = generateRoomCode();
  app.mode = 'p2p';
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.isHost = true;
  app.me.isOwner = true;
  app.error = '';

  engine = new GameEngine();
  // The host's own seat is bound to its clientId as well. The host's peer id is
  // derived from the room code, so it is the one seat an outsider could guess the
  // id of — and binding it means a snapshot that outlives this tab still knows
  // which device the owner was.
  engine.addPlayer(app.me.id, name, { isHost: true, clientId: clientId() });

  saveSession({ mode: 'host', code, name });
  hostReady = false;
  net = createHost(code, hostHandlers());

  app.screen = 'game';
  hostSync();
}

// Rehydrate a game in progress after a HOST reload, re-using the same code.
function resumeHosting(code, snapshot, name) {
  app.mode = 'p2p';
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.isHost = true;
  app.me.isOwner = true;
  app.me.name = name || app.me.name;
  app.error = '';

  engine = new GameEngine();
  engine.restore(snapshot);
  engine.resumeAsHost(app.me.id);

  saveSession({ mode: 'host', code, name: app.me.name });
  hostReady = false;
  net = createHost(code, hostHandlers());

  app.screen = 'game';
  hostSync();
}

// ---------------------------------------------------------------------------
// Join an existing game.
// ---------------------------------------------------------------------------
function startJoining(rawCode, rawName, { reconnect = false } = {}) {
  const name = (rawName || '').trim();
  const code = normalizeCode(rawCode);
  if (!name) { app.error = 'Enter your name.'; app.screen = 'join'; draw(); return; }
  if (code.length !== CODE_LENGTH) {
    app.error = `Enter the full ${CODE_LENGTH}-character code.`;
    app.screen = 'join'; draw(); return;
  }

  stopDiscovery();
  stopRoomsPoll();
  if (!reconnect) clearReconnect();
  app.mode = 'p2p';
  app.me.name = name; saveName(name);
  app.code = code; saveCode(code);
  app.me.isHost = false;
  app.me.isOwner = false;
  app.error = '';
  // On a retry keep the last board on screen behind the reconnect banner —
  // dropping to a spinner mid-game loses the player's place at the table.
  if (!reconnect || !app.pub) app.screen = 'connecting';
  draw();

  saveSession({ mode: 'join', code, name });

  // The deadline only guards the FIRST join. A reconnect already has its own
  // bounded retry loop, and it keeps the board on screen, so there is nothing to
  // rescue the player from.
  clearJoinTimer();
  if (!reconnect) {
    joinTimer = setTimeout(() => {
      joinTimer = null;
      if (app.pub) return;
      giveUpJoining("Couldn't reach that game. Make sure every device is on the same Wi-Fi, then try again.");
    }, JOIN_TIMEOUT);
  }

  net = joinHost(code, {
    // The clientId travels on the peer transport too, not just to the server: it
    // is what gets this device — and only this device — its seat back mid-game.
    onOpen: () => net.send({ type: 'join', name, clientId: clientId() }),
    onData: (msg) => {
      switch (msg.type) {
        case 'welcome':
          app.me.id = msg.playerId;
          break;
        case 'state':
          clearJoinTimer();
          clearReconnect();
          app.pub = msg.pub; app.priv = msg.priv;
          app.screen = 'game';
          draw();
          break;
        case 'rejected':
          clearReconnect();
          clearSession(); teardownNet();
          app.screen = 'join'; app.error = msg.message; startDiscovery(); draw();
          break;
        case 'error':
          app.error = msg.message || ''; draw();
          break;
        default: break;
      }
    },
    // app.pub is only set once the host has actually sent us state, so it marks
    // "we were in a real game" — the case worth retrying rather than abandoning.
    onClose: () => {
      if (app.pub) { scheduleReconnect(); return; }
      giveUpJoining('The host closed the connection.');
    },
    onError: (err) => {
      // Mid-game the broker is irrelevant to us; our link to the host is direct.
      if (app.pub) {
        if (isFatalPeerError(err)) { giveUpJoining(describePeerError(err)); return; }
        scheduleReconnect();
        return;
      }
      if (!net || !net.isOpen()) giveUpJoining(describePeerError(err));
    },
  });
}

// Abandon a join attempt and show why. Kills the retry loop too, so a failure the
// player is reading about on the error screen isn't quietly retried underneath it.
function giveUpJoining(message) {
  clearReconnect();
  teardownNet();
  app.screen = 'error';
  app.error = message;
  draw();
}

// ---------------------------------------------------------------------------
// SERVER MODE — the same game, carried by a WebSocket to an authoritative server.
//
// Structurally this is the JOINING path for everybody, owner included: no browser
// holds a GameEngine here, so app.me.isHost stays false and every tap — including
// the owner's lobby controls — travels over the wire through the untouched
// sendIntent(). What the owner gets instead is app.me.isOwner, which is only ever
// used to decide what to DRAW.
//
// Identity is the device's clientId, not the name typed on the home screen. That is
// the whole reason a seat can't be stolen on a public endpoint, and it is why a
// reconnect can reclaim a hand mid-game without the server trusting anything the
// reconnecting socket says about who it is. See server/session.js.
// ---------------------------------------------------------------------------
function startServerGame({ create = false, code = '', name = '', reconnect = false } = {}) {
  const clean = (name || '').trim();
  if (!clean) {
    app.error = 'Enter a name first.';
    app.screen = create ? 'home' : 'join';
    draw(); return;
  }
  const roomCode = create ? '' : normalizeCode(code);
  if (!create && roomCode.length !== CODE_LENGTH) {
    app.error = `Enter the full ${CODE_LENGTH}-character code.`;
    app.screen = 'join'; draw(); return;
  }

  stopDiscovery();
  stopRoomsPoll();
  if (!reconnect) clearReconnect();

  app.mode = 'server';
  app.me.name = clean; saveName(clean);
  // Never true on this transport: the engine is on the Pi, so there is nothing in
  // this tab for an intent to be applied to.
  app.me.isHost = false;
  if (!reconnect) app.me.isOwner = false;
  // A create has no code until the server mints one and sends it back in `welcome`.
  // Blank it rather than leaving the previous game's code in state, or the waiting
  // screen would name a room this attempt has nothing to do with.
  if (roomCode) { app.code = roomCode; saveCode(roomCode); }
  else if (!reconnect) app.code = '';
  app.error = '';
  serverIntent = { code: roomCode, name: clean, create: !!create };

  if (!reconnect || !app.pub) app.screen = 'connecting';
  draw();

  // Same deadline as the peer-to-peer join, and for the same reason: a socket that
  // hangs rather than failing leaves the player watching 'Connecting…' with nothing
  // to do. A reconnect has its own bounded retry loop and keeps the board up.
  clearJoinTimer();
  if (!reconnect) {
    joinTimer = setTimeout(() => {
      joinTimer = null;
      if (app.pub) return;
      giveUpJoining("The game server didn't answer. It may be switched off — you can still host a game over Wi-Fi.");
    }, JOIN_TIMEOUT);
  }

  net = serverTransport(SERVER_URL, {
    onOpen: () => {
      app.server.state = 'up';
      // createRoom happens once, ever. Every retry after that is a join, or the
      // owner's blip would open a second empty room and orphan the real game.
      if (create) net.send({ type: 'createRoom', name: clean, clientId: clientId() });
      else net.send({ type: 'join', code: app.code, name: clean, clientId: clientId() });
    },
    onData: (msg) => handleServerMessage(msg),

    // app.pub marks "we were in a real game", exactly as on the peer path.
    onClose: ({ everOpened }) => {
      if (app.pub) { scheduleReconnect(); return; }
      if (!everOpened) app.server.state = 'down';
      giveUpJoining(everOpened
        ? 'The server closed the connection before the game started.'
        : "Couldn't reach the game server. It may be switched off — you can still host a game over Wi-Fi.");
    },
    onError: () => { /* a close always follows, and that is where we decide */ },
  });
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      app.me.id = msg.playerId;
      app.me.isOwner = !!msg.owner;
      if (msg.code) { app.code = msg.code; saveCode(app.code); }
      // The room exists from here on, so a later retry must join it.
      if (serverIntent) serverIntent = { ...serverIntent, code: app.code, create: false };
      saveSession({ mode: 'server', code: app.code, name: app.me.name });
      break;

    case 'state':
      clearJoinTimer();
      clearReconnect();
      app.pub = msg.pub; app.priv = msg.priv;
      app.screen = 'game';
      draw();
      break;

    case 'rejected':
      handleServerRejection(msg);
      break;

    case 'error':
      app.error = msg.message || '';
      draw();
      break;

    // lobbyInfo exists for the peer transport's per-code probe. On the server the
    // /rooms list does that job for every room at once, so there is nothing to do.
    default: break;
  }
}

// A refusal is fatal to THIS attempt — the server closes the socket behind it.
function handleServerRejection(msg) {
  const reason = msg && msg.reason;
  const wanted = serverIntent;
  clearReconnect();
  teardownNet();
  app.mode = 'p2p';

  // The server has never heard of this code — but a host on this Wi-Fi might have
  // it. Falling through to the peer-to-peer join is what lets ONE join button cover
  // both kinds of game, so a player never has to know which one their host is
  // running. Only for a code the player actually typed, and only before we had a
  // game: a mid-game 'no-room' means the room was swept, not misaddressed.
  if (reason === 'no-room' && wanted && wanted.code && !app.pub) {
    startJoining(wanted.code, wanted.name);
    return;
  }

  clearSession();
  app.pub = null; app.priv = null;
  app.me.isOwner = false;
  app.screen = 'join';
  app.error = describeServerRejection(reason, msg && msg.message);
  startDiscovery();
  refreshServerRooms();
  draw();
}

// ---------------------------------------------------------------------------
// Is the server there? Asked once at boot, and again whenever the answer could
// have changed. Every server-shaped control in the UI is gated on the result, so a
// Pi that is off, missing or unreachable is simply not offered — which is what
// keeps the app honest about being a static peer-to-peer game by default.
// ---------------------------------------------------------------------------
// The in-flight probe, so two callers can await one request rather than racing two.
let serverProbe = null;

function checkServer() {
  if (!serverConfigured()) { app.server.state = 'off'; return Promise.resolve(); }
  if (serverProbe) return serverProbe;
  app.server.state = 'checking';
  draw();
  serverProbe = (async () => {
    const info = await probeServer(SERVER_HEALTH);
    app.server.state = info ? 'up' : 'down';
    app.server.version = (info && info.version) || '';
    serverProbe = null;
    draw();
  })();
  return serverProbe;
}

// Open lobbies on the server, polled while the Join screen is up.
//
// Codes are not secrets, and this list hands them out — see the note on
// RoomManager#joinable() in server/rooms.js. It is offered because the public
// PeerJS broker has enumeration disabled, so on the server this list is the only
// way to find a game without being told the code.
function refreshServerRooms() {
  stopRoomsPoll();
  if (!serverConfigured()) return;

  const tick = async () => {
    roomsTimer = null;
    const rooms = await fetchServerRooms(SERVER_ROOMS);
    // The player left while the request was in flight.
    if (app.screen !== 'join') return;
    app.serverRooms = rooms;
    if (rooms) app.server.state = 'up';
    draw();
    // Stop on null rather than retrying: that is a server which is down or has the
    // list switched off, and neither is worth a request every few seconds. The
    // health probe already tells the player which it is.
    if (rooms) roomsTimer = setTimeout(tick, ROOMS_POLL_MS);
  };
  tick();
}

function stopRoomsPoll() {
  if (roomsTimer) { clearTimeout(roomsTimer); roomsTimer = null; }
}

// ---------------------------------------------------------------------------
// Discovery lifecycle (Join screen).
// ---------------------------------------------------------------------------
function startDiscovery() {
  stopDiscovery();
  app.discovered = [];
  app.discoveryState = 'searching';
  discovery = createDiscovery();

  const tick = () => {
    if (!discovery) return;
    discovery.list((codes) => {
      if (!discovery) return;
      if (codes === null) { app.discoveryState = 'unsupported'; draw(); return; }
      app.discoveryState = 'ok';
      const targets = codes.filter((c) => c && c !== app.code);
      if (targets.length === 0) {
        app.discovered = [];
        draw();
        discoveryTimer = setTimeout(tick, 3500);
        return;
      }
      const found = [];
      let pending = targets.length;
      const settle = () => {
        if (--pending > 0) return;
        // Probes are on a 4s timeout, so the last one can land after the player
        // has already left the Join screen. Scheduling the next tick then would
        // restart a loop nobody asked for, against a destroyed peer.
        if (!discovery) return;
        app.discovered = found.sort((a, b) => a.code.localeCompare(b.code));
        draw();
        discoveryTimer = setTimeout(tick, 3500);
      };
      targets.forEach((code) => {
        discovery.probe(code, (info) => {
          if (info) found.push({ code, ...info });
          settle();
        });
      });
    });
  };
  tick();
}

function stopDiscovery() {
  if (discoveryTimer) { clearTimeout(discoveryTimer); discoveryTimer = null; }
  if (discovery) { try { discovery.destroy(); } catch (_) {} discovery = null; }
  app.discoveryState = 'idle';
  app.discovered = [];
}

function teardownNet() {
  clearJoinTimer();
  try { if (net) net.destroy(); } catch (_) {}
  net = null;
  hostReady = false;
  app.netWarning = '';
}

// ---------------------------------------------------------------------------
// CLIENT: reconnect after the connection drops. Both transports.
//
// P2P: the host's peer id is derived from the room code, so a host that reloads or
// blips off Wi-Fi comes back at the SAME address — and rejoining by name reclaims
// the seat and the hand.
//
// SERVER: the address never moves, and the seat is reclaimed by this device's
// clientId rather than its name.
//
// Either way a dropped connection is worth retrying before telling the player their
// game is over.
// ---------------------------------------------------------------------------
function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectTries >= RECONNECT_TRIES) {
    clearReconnect();
    app.screen = 'hostleft';
    draw();
    return;
  }
  const delay = Math.min(1000 * 2 ** reconnectTries, 8000);
  reconnectTries += 1;
  app.reconnecting = true;
  draw();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    teardownNet();
    // Note the absent `create`: a returning owner rejoins the room it already made.
    // The server hands the seat back on the strength of this device's clientId.
    if (app.mode === 'server') {
      startServerGame({ code: app.code, name: app.me.name, reconnect: true });
      return;
    }
    startJoining(app.code, app.me.name, { reconnect: true });
  }, delay);
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectTries = 0;
  app.reconnecting = false;
}

// ---------------------------------------------------------------------------
// Intents handed to the view.
//
// EVERY intent — a player's tap and an owner's control alike — goes through this
// one function, and the only thing that varies is who is holding the engine. A
// peer-to-peer host applies its own messages locally; everyone else, including
// the owner of a game running on the server, sends them over the wire.
//
// That uniformity is the point of the server mode: on the server nobody's browser
// runs an engine, so "the host" is just the player whose seat the engine calls
// hostId, and their controls have to travel like any other message.
// ---------------------------------------------------------------------------
function sendIntent(msg) {
  app.error = '';
  if (app.me.isHost) handleIntent(app.me.id, msg);
  else if (net) net.send(msg);
}

const intents = {
  setName: (n) => { app.me.name = n; saveName(n); },
  setCode: (c) => { app.code = normalizeCode(c); saveCode(app.code); },
  gotoJoin: () => {
    app.screen = 'join'; app.error = '';
    startDiscovery();
    refreshServerRooms();
    draw();
  },
  goHome: () => {
    teardownNet();
    stopDiscovery();
    stopRoomsPoll();
    clearReconnect();
    clearSession();
    engine = null;
    serverIntent = null;
    app.screen = 'home';
    app.mode = 'p2p';
    app.pub = null; app.priv = null; app.error = '';
    app.me.isHost = false; app.me.isOwner = false; app.me.id = null;
    app.selectedCardId = null;
    app.serverRooms = null;
    draw();
    // The Pi may have come up (or gone down) while a game was running, and the
    // home screen is where that answer is acted on.
    checkServer();
  },
  // Opening the rules moves the keyboard into the dialog; closing it hands focus
  // back to the control that opened it. Node references don't survive a render,
  // so the opener is remembered by its data-focus key instead.
  toggleRules: () => {
    app.showRules = !app.showRules;
    if (app.showRules) {
      const active = document.activeElement;
      rulesOpener = (active && active.getAttribute) ? active.getAttribute('data-focus') : null;
      draw();
      const sheet = root.querySelector('.rules-sheet');
      if (sheet) sheet.focus();
      return;
    }
    const opener = rulesOpener;
    rulesOpener = null;
    draw();
    const back = opener && root.querySelector(`[data-focus="${opener}"]`);
    if (back) back.focus();
  },
  toggleZoom: () => { app.zoom = !app.zoom; draw(); },
  // Lift the chip off one space for a moment so the card under it can be read.
  // Tapping the same space again shuts it immediately, so a mis-tap doesn't have
  // to be sat out.
  peekAt: (cell) => {
    // Memory mode has no peeking. ui.js already withholds the control, but the
    // rule belongs on the intent too: this is the one place that could reveal a
    // covered card, so a caller that forgets should be refused rather than obeyed.
    if (!peeksAllowed(app.pub && app.pub.config)) return;
    const same = app.peekCell === cell;
    clearPeek();
    app.error = '';
    if (same) { draw(); return; }
    app.peekCell = cell;
    // Let the keyboard follow the eye, so arrowing on from here starts where the
    // player is actually looking.
    app.cursor = cell;
    draw();
    peekTimer = setTimeout(() => {
      peekTimer = null;
      app.peekCell = null;
      draw();
    }, PEEK_MS);
  },
  // Holds every chip open at once. This is the one that answers "are both spaces
  // for this card gone?", which a space-at-a-time peek makes into ten taps.
  togglePeekAll: () => {
    if (!peeksAllowed(app.pub && app.pub.config)) return;
    const on = !app.peekAll;
    clearPeek();
    app.peekAll = on;
    draw();
  },
  dismissError: () => { app.error = ''; draw(); },

  host: () => startHosting(),
  // Host on the server instead of on this device. Only ever offered when the health
  // probe came back — see app.server in this file and the gating in ui.js.
  hostOnline: () => startServerGame({ create: true, name: app.me.name }),

  // ONE join button for both kinds of game.
  //
  // A player is told a four-character code, not a transport, so we try the server
  // first when there is one and fall through to the local network if it has never
  // heard of the code (see handleServerRejection). When no server is configured or
  // it isn't answering, this is the peer-to-peer join it always was.
  join: async (code, name) => {
    // The boot probe may still be in flight. Wait for it rather than guessing: a
    // peer-to-peer attempt at a server-side code costs the player the full join
    // timeout before it admits defeat.
    if (serverConfigured()
        && (app.server.state === 'unknown' || app.server.state === 'checking')) {
      app.screen = 'connecting'; app.error = ''; draw();
      await checkServer();
      // They gave up while we were asking.
      if (app.screen !== 'connecting') return;
    }
    if (app.server.state === 'up') { startServerGame({ code, name }); return; }
    startJoining(code, name);
  },
  // Join a specific server room from the open-lobby list. No fallback: this code
  // came from the server itself, so a refusal is about the room, not the transport.
  joinServerRoom: (code, name) => startServerGame({ code, name: name || app.me.name }),

  // Back out of a connection attempt that is going nowhere. Drops the saved
  // session too, so a reload doesn't walk straight back into the same wait.
  cancelJoin: () => {
    clearReconnect();
    teardownNet();
    clearSession();
    app.mode = 'p2p';
    app.me.isOwner = false;
    app.screen = 'join';
    app.error = '';
    startDiscovery();
    refreshServerRooms();
    draw();
  },
  dismissNetWarning: () => { app.netWarning = ''; draw(); },

  copyCode: async () => {
    if (!app.code) return;
    const ok = await copyText(app.code);
    app.copied = ok;
    draw();
    if (ok) setTimeout(() => { app.copied = false; draw(); }, 1500);
  },

  // --- Owner lobby + flow controls ---
  // Ordinary wire messages, not local engine calls: see sendIntent. The engine's
  // hostId check (and intents.js's guard for the three methods that lack one) is
  // what makes them owner-only, on either transport.
  setConfig: (patch) => sendIntent({ type: 'setConfig', patch }),
  movePlayer: (playerId, dir) => sendIntent({ type: 'movePlayer', playerId, dir }),
  randomizeOrder: () => sendIntent({ type: 'randomizeOrder' }),
  startGame: () => sendIntent({ type: 'startGame' }),
  skipTurn: () => sendIntent({ type: 'skipTurn' }),
  armEndGame: (on) => { app.confirmEnd = !!on; app.error = ''; draw(); },
  endGame: () => sendIntent({ type: 'endGame' }),
  playAgain: () => sendIntent({ type: 'playAgain' }),

  // --- Turn actions (per player) ---
  setCursor: (cell) => {
    if (cell === app.cursor) return;
    app.cursor = cell;
    revealCursor = true;
    draw();
  },
  selectCard: (cardId) => {
    app.selectedCardId = app.selectedCardId === cardId ? null : cardId;
    app.error = '';
    // Park the cursor on the first space this card can go. Without it a keyboard
    // player has to walk the arrow keys across a hundred cells looking for the
    // highlights they can't see. Not when the host turned the highlights off: the
    // cursor would then be the last thing on screen still naming a legal space,
    // and it would name it to keyboard players only.
    const card = ((app.priv && app.priv.hand) || []).find((c) => c.id === app.selectedCardId);
    if (highlightsOn(app.pub && app.pub.config)
        && card && card.targets && card.targets.length) app.cursor = card.targets[0];
    draw();
  },
  playAt: (cell) => {
    if (!app.selectedCardId) { app.error = 'Pick a card from your hand first.'; draw(); return; }
    sendIntent({ type: 'playCard', cardId: app.selectedCardId, cell });
  },
  exchangeDead: (cardId) => sendIntent({ type: 'exchangeDead', cardId }),
  pass: () => sendIntent({ type: 'pass' }),
};

// ---------------------------------------------------------------------------
// Boot — resume the previous session if there is one.
// ---------------------------------------------------------------------------
function resumeSession() {
  const s = loadSession();
  if (!s || !s.code) return false;

  if (s.mode === 'host') {
    const snapshot = loadEngineSnapshot();
    if (!snapshot) return false;
    resumeHosting(s.code, snapshot, s.name);
    return true;
  }
  if (s.mode === 'join' && s.name) {
    startJoining(s.code, s.name);
    return true;
  }
  // A server game needs nothing rehydrated locally — the engine never left the Pi.
  // Rejoining is enough, and the device's clientId is what gets the seat and the
  // hand back. No fallback to the peer path here: the session says which transport
  // this game was on.
  if (s.mode === 'server' && s.name && serverConfigured()) {
    startServerGame({ code: s.code, name: s.name });
    return true;
  }
  return false;
}

if (!resumeSession()) draw();

// Ask the server whether it exists, once, in the background. Deliberately after the
// first paint: the home screen must not wait on a network round-trip to a machine
// that may well be switched off.
checkServer();

window.addEventListener('offline', () => {
  app.online = false;
  // A machine with no network cannot be hosting anything, and saying so at once
  // beats leaving a stale "online games available" on screen for four seconds.
  if (app.server.state === 'up' || app.server.state === 'checking') app.server.state = 'down';
  if (app.screen === 'home') draw();
});
window.addEventListener('online', () => {
  app.online = true;
  if (app.screen === 'home') { checkServer(); return; }
  draw();
});

// Service worker (relative path so it works under a GitHub Pages subpath).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell optional */ });
  });
}
