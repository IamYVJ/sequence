// ============================================================================
// main.js — App controller. Wires the network layer, the host's authoritative
// engine, user intents and the view together.
//
//   HOST  : owns a GameEngine, applies every intent through it, then sends each
//           connection the public state plus that player's own hand.
//   CLIENT: holds the last public+private snapshot received from the host and
//           sends intents over the wire.
// ============================================================================

import { GameEngine } from './state.js';
import {
  createHost, joinHost, createDiscovery,
  describePeerError, isFatalPeerError, peerIdForCode,
} from './net.js';
import { render } from './ui.js';
import {
  generateRoomCode, normalizeCode, copyText, CODE_LENGTH,
  loadName, saveName, loadCode, saveCode,
  saveSession, loadSession, clearSession, saveEngineSnapshot, loadEngineSnapshot,
} from './util.js';

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// App state (everything the view needs to draw).
// ---------------------------------------------------------------------------
const app = {
  screen: 'home',              // home | join | connecting | game | error | hostleft
  me: { id: null, name: loadName(), isHost: false },
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
  switch (msg.type) {
    case 'lobbyQuery':
      net.sendTo(playerId, { type: 'lobbyInfo', info: engine.lobbyInfo(app.me.name) });
      break;

    case 'join': {
      const r = engine.addPlayer(playerId, msg.name, { isHost: false });
      if (!r.ok) { net.sendTo(playerId, { type: 'rejected', message: r.error }); return; }
      // A reconnect reclaimed a seat under a new connection id. Drop the old,
      // now-orphaned connection so it can't later fire a disconnect against the
      // seat we just handed back.
      if (r.reconnected && r.prevId && r.prevId !== playerId) net.dropConnection(r.prevId);
      net.sendTo(playerId, { type: 'welcome', playerId });
      hostSync();
      break;
    }

    case 'playCard': {
      const r = engine.playCard(playerId, msg.cardId, msg.cell);
      if (!r.ok) rejectTo(playerId, r.error);
      hostSync();
      break;
    }

    case 'exchangeDead': {
      const r = engine.exchangeDeadCard(playerId, msg.cardId);
      if (!r.ok) rejectTo(playerId, r.error);
      hostSync();
      break;
    }

    case 'pass': {
      const r = engine.pass(playerId);
      if (!r.ok) rejectTo(playerId, r.error);
      hostSync();
      break;
    }

    default: break;
  }
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
  saveName(name);
  const code = generateRoomCode();
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.isHost = true;
  app.error = '';

  engine = new GameEngine();
  engine.addPlayer(app.me.id, name, { isHost: true });

  saveSession({ mode: 'host', code, name });
  hostReady = false;
  net = createHost(code, hostHandlers());

  app.screen = 'game';
  hostSync();
}

// Rehydrate a game in progress after a HOST reload, re-using the same code.
function resumeHosting(code, snapshot, name) {
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.isHost = true;
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
  if (!reconnect) clearReconnect();
  app.me.name = name; saveName(name);
  app.code = code; saveCode(code);
  app.me.isHost = false;
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
    onOpen: () => net.send({ type: 'join', name }),
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
// CLIENT: reconnect after the host's connection drops.
//
// The host's peer id is derived from the room code, so a host that reloads or
// blips off Wi-Fi comes back at the SAME address — and rejoining by name
// reclaims the seat and the hand. So a dropped connection is worth retrying
// before telling the player their game is over.
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
    startJoining(app.code, app.me.name, { reconnect: true });
  }, delay);
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectTries = 0;
  app.reconnecting = false;
}

// ---------------------------------------------------------------------------
// Intents handed to the view. Player intents route through sendIntent (the host
// applies locally; clients send over the wire). Host-only controls drive the
// engine directly and re-broadcast.
// ---------------------------------------------------------------------------
function sendIntent(msg) {
  app.error = '';
  if (app.me.isHost) handleIntent(app.me.id, msg);
  else if (net) net.send(msg);
}

function hostControl(fn) {
  return (...args) => {
    if (!app.me.isHost || !engine) return;
    app.error = '';
    const r = fn(...args);
    if (r && r.ok === false) app.error = r.error;
    hostSync();
  };
}

const intents = {
  setName: (n) => { app.me.name = n; saveName(n); },
  setCode: (c) => { app.code = normalizeCode(c); saveCode(app.code); },
  gotoJoin: () => { app.screen = 'join'; app.error = ''; startDiscovery(); draw(); },
  goHome: () => {
    teardownNet();
    stopDiscovery();
    clearReconnect();
    clearSession();
    engine = null;
    app.screen = 'home';
    app.pub = null; app.priv = null; app.error = '';
    app.me.isHost = false; app.me.id = null;
    app.selectedCardId = null;
    draw();
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
    const on = !app.peekAll;
    clearPeek();
    app.peekAll = on;
    draw();
  },
  dismissError: () => { app.error = ''; draw(); },

  host: () => startHosting(),
  join: (code, name) => startJoining(code, name),
  // Back out of a connection attempt that is going nowhere. Drops the saved
  // session too, so a reload doesn't walk straight back into the same wait.
  cancelJoin: () => {
    clearReconnect();
    teardownNet();
    clearSession();
    app.screen = 'join';
    app.error = '';
    startDiscovery();
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

  // --- Host lobby + flow controls ---
  setConfig: hostControl((patch) => engine.setConfig(patch)),
  movePlayer: hostControl((playerId, dir) => engine.movePlayer(playerId, dir)),
  randomizeOrder: hostControl(() => engine.randomizeOrder()),
  startGame: hostControl(() => engine.startGame(app.me.id)),
  skipTurn: hostControl(() => engine.skipTurn(app.me.id)),
  armEndGame: (on) => { app.confirmEnd = !!on; app.error = ''; draw(); },
  endGame: hostControl(() => engine.endGame(app.me.id)),
  playAgain: hostControl(() => engine.playAgain(app.me.id)),

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
    // highlights they can't see.
    const card = ((app.priv && app.priv.hand) || []).find((c) => c.id === app.selectedCardId);
    if (card && card.targets && card.targets.length) app.cursor = card.targets[0];
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
  return false;
}

if (!resumeSession()) draw();

window.addEventListener('offline', () => { app.online = false; if (app.screen === 'home') draw(); });
window.addEventListener('online', () => { app.online = true; if (app.screen === 'home') draw(); });

// Service worker (relative path so it works under a GitHub Pages subpath).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell optional */ });
  });
}
