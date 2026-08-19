// ============================================================================
// ui.js — All rendering. Pure view layer: given app state + intent callbacks it
// builds DOM. It never touches the network or the engine directly.
//
//   render(root, app, intents)
//     app     : { screen, me, code, pub, priv, error, selectedCardId, zoom, … }
//     intents : { host, join, setConfig, selectCard, playAt, pass, … }
//
// The board highlights come straight from `priv.hand[].targets`, which the engine
// computed with the SAME legalTargets() it validates moves against — so what
// lights up and what the host accepts can never drift apart.
// ============================================================================

import { el, clear } from './util.js';
import { BOARD_SIZE, FREE, cellName } from './board.js';
import {
  MAX_PLAYERS, SEATINGS, LIMITS, PRESETS,
  teamTheme, allowedTeamCounts, describeSeating, highlightsOn, peeksAllowed,
  presetOf, presetConfig, sequencesToWinFor, sequenceLengthFor, winTargetFor,
  describeHouseRules,
  rankLabel, suitGlyph, isRedSuit, cardLabel,
  isTwoEyedJack, isOneEyedJack, isJack,
} from './rules.js';

export function render(root, app, intents) {
  clear(root);
  let node;
  switch (app.screen) {
    case 'home':       node = homeScreen(app, intents); break;
    case 'join':       node = joinScreen(app, intents); break;
    // Always give the waiting player a way out: a host that is listed on the
    // broker but unreachable over WebRTC produces no error at all, so without
    // this the only escape is a page reload.
    case 'connecting': node = infoScreen(
                                app.reconnecting ? 'Reconnecting…' : 'Connecting…',
                                app.reconnecting
                                  ? `Looking for room ${app.code} again.`
                                  : `Reaching room ${app.code}.`,
                                true,
                                el('button', { class: 'btn btn-ghost', onclick: intents.cancelJoin }, '✕ CANCEL')); break;
    case 'error':      node = errorScreen(app, intents); break;
    case 'hostleft':   node = infoScreen('Host left', 'The host ended the game. Thanks for playing.', false,
                                          el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '‹ BACK HOME')); break;
    case 'game':       node = gameScreen(app, intents); break;
    default:           node = homeScreen(app, intents);
  }
  root.appendChild(node);
  // Sits above whatever screen is showing, so a mid-game drop keeps the board
  // visible underneath instead of yanking the player to a spinner.
  if (app.reconnecting && app.screen === 'game') root.appendChild(reconnectBanner());
  else if (app.netWarning) root.appendChild(netBanner(app, intents));
  // The config, when there is a game to read one from — the sheet also opens from
  // the home screen, where the only honest thing to describe is the official game.
  if (app.showRules) root.appendChild(rulesOverlay(intents, app.pub && app.pub.config));
}

function reconnectBanner() {
  return el('div', { class: 'reconnect-banner', role: 'status', 'aria-live': 'polite' },
    el('span', { class: 'spinner spinner-sm' }),
    el('span', {}, 'Lost the host — reconnecting…'),
  );
}

// The host's connection to the signalling broker is in trouble, but the game is
// not: the links to the players already at the table are direct device-to-device.
// So this is a notice, not an interruption — dismissible, and the board stays put.
function netBanner(app, intents) {
  return el('div', { class: 'reconnect-banner net-banner', role: 'status', 'aria-live': 'polite' },
    el('span', {}, app.netWarning),
    el('button', { class: 'banner-close', 'aria-label': 'Dismiss',
      onclick: intents.dismissNetWarning }, '✕'),
  );
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------
function wordmark(intents) {
  return el('div', { class: 'wordmark' },
    el('span', { class: 'wordmark-dot' }),
    el('span', { class: 'wordmark-text' }, 'SEQUENCE'),
    // data-focus so closing the rules sheet can hand the keyboard back to
    // whichever control opened it.
    el('button', { class: 'help-btn', 'aria-label': 'How to play', title: 'How to play',
      'data-focus': 'help', onclick: () => intents.toggleRules() }, '?'),
  );
}

function plainMark() {
  return el('div', { class: 'wordmark' },
    el('span', { class: 'wordmark-dot' }),
    el('span', { class: 'wordmark-text' }, 'SEQUENCE'));
}

function shell(...children) { return el('main', { class: 'shell' }, ...children); }

// Carries the announcement as an attribute rather than speaking it itself. A
// live region only fires when the text inside an ALREADY-PRESENT node changes,
// and this whole tree is rebuilt on every render — so the real region is the
// persistent #announce node in index.html, which main.js copies this into.
function liveRegion(text) {
  return el('div', { class: 'sr-only', 'data-announce': text || '' });
}

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------
function homeScreen(app, intents) {
  const nameInput = el('input', {
    class: 'field', type: 'text', maxlength: '20', placeholder: 'Your name',
    value: app.me.name || '', 'aria-label': 'Your name', 'data-focus': 'name',
    oninput: (e) => intents.setName(e.target.value),
  });

  return shell(
    wordmark(intents),
    el('h1', { class: 'hero' }, 'Sequence'),
    el('p', { class: 'tagline' },
      'The board-and-cards classic, played on your phones. Cover the card you hold, build ',
      el('span', { class: 'accent' }, 'five in a row'),
      ' — and mind the Jacks.'),
    el('div', { class: 'field-group' }, nameInput),
    app.error ? el('p', { class: 'error-text', role: 'alert' }, app.error) : null,
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.host() }, '+ HOST GAME'),
      el('button', { class: 'btn btn-secondary', onclick: () => intents.gotoJoin() }, '▷ JOIN GAME'),
    ),
    el('button', { class: 'link-btn', 'data-focus': 'help-link', onclick: () => intents.toggleRules() }, 'How to play'),
    el('p', { class: 'fine' },
      'Plays peer-to-peer in your browser on the same Wi-Fi. Everyone plays on their own device, so nobody sees your hand. No accounts, no servers.'),
    app.online ? null : el('p', { class: 'error-text' },
      'You are offline. The first handshake needs internet, even though the app itself is cached.'),
  );
}

// ---------------------------------------------------------------------------
// JOIN
// ---------------------------------------------------------------------------
function joinScreen(app, intents) {
  const nameInput = el('input', {
    class: 'field', type: 'text', maxlength: '20', placeholder: 'Your name',
    value: app.me.name || '', 'aria-label': 'Your name', 'data-focus': 'name',
    oninput: (e) => intents.setName(e.target.value),
  });
  const codeInput = el('input', {
    class: 'field field-code', type: 'text', maxlength: '4', placeholder: 'CODE',
    value: app.code || '', autocapitalize: 'characters', autocomplete: 'off',
    'aria-label': 'Room code', 'data-focus': 'code',
    // Uppercase in place for instant feedback AND mirror into app state, so a
    // discovery-driven redraw (every few seconds) re-renders the typed code
    // instead of wiping it — the value binds to app.code.
    oninput: (e) => { e.target.value = e.target.value.toUpperCase(); intents.setCode(e.target.value); },
  });

  return shell(
    wordmark(intents),
    el('h1', { class: 'hero hero-sm' }, 'Join a game'),
    el('p', { class: 'tagline' }, 'Pick a game on your ', el('span', { class: 'accent' }, 'Wi-Fi'), ' — or enter a code.'),
    el('div', { class: 'field-group' }, nameInput),
    el('div', { class: 'section-label' }, 'GAMES ON THIS NETWORK'),
    discoveryList(app, intents, nameInput),
    el('div', { class: 'section-label' }, 'OR ENTER A CODE'),
    el('div', { class: 'field-group' }, codeInput),
    app.error ? el('p', { class: 'error-text', role: 'alert' }, app.error) : null,
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.join(codeInput.value, nameInput.value) }, '> CONNECT'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '‹ BACK'),
    ),
  );
}

function discoveryList(app, intents, nameInput) {
  const state = app.discoveryState || 'idle';
  const games = app.discovered || [];

  if (state === 'unsupported') {
    return el('p', { class: 'fine' },
      'Automatic discovery isn’t available on the public signaling server — ',
      'enter the 4-character code the host is showing instead. ',
      '(Self-host a PeerServer on your LAN to enable the live list.)');
  }
  if (state === 'searching' && games.length === 0) {
    return el('div', { class: 'discovery-status' },
      el('div', { class: 'spinner spinner-sm' }),
      el('span', { class: 'fine' }, 'Looking for open games…'));
  }
  if (games.length === 0) {
    return el('p', { class: 'fine' },
      'No open games found yet. Make sure you’re on the same Wi-Fi as the host, or enter a code below.');
  }
  return el('ul', { class: 'game-list' },
    ...games.map((g) => el('li', {},
      el('button', {
        class: 'game-row' + (g.joinable ? '' : ' game-row-busy'),
        disabled: g.joinable ? false : true,
        onclick: () => g.joinable && intents.join(g.code, nameInput.value),
      },
        el('span', { class: 'game-code' }, g.code),
        el('span', { class: 'game-meta' },
          el('span', { class: 'game-host' }, (g.hostName || 'Host') + '’s game'),
          el('span', { class: 'game-sub' },
            g.joinable
              ? `${g.playerCount} ${g.playerCount === 1 ? 'player' : 'players'} in lobby`
              : 'In progress — can’t join'),
        ),
        el('span', { class: 'game-go' }, g.joinable ? '▷' : '🔒'),
      ),
    )),
  );
}

function infoScreen(title, body, spinner, ...extra) {
  return shell(
    plainMark(),
    el('h1', { class: 'hero hero-sm' }, title),
    el('p', { class: 'tagline' }, body),
    spinner ? el('div', { class: 'spinner' }) : null,
    ...extra,
    liveRegion(title),
  );
}

function errorScreen(app, intents) {
  return shell(
    plainMark(),
    el('h1', { class: 'hero hero-sm' }, 'Connection problem'),
    el('p', { class: 'error-text', role: 'alert' }, app.error || 'Something went wrong.'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '‹ BACK HOME')),
  );
}

// ---------------------------------------------------------------------------
// GAME (dispatches on phase)
// ---------------------------------------------------------------------------
function gameScreen(app, intents) {
  const pub = app.pub;
  if (!pub) return infoScreen('Loading…', 'Syncing with the host.', true);
  switch (pub.phase) {
    case 'lobby':    return lobbyScreen(app, intents);
    case 'play':     return playScreen(app, intents);
    case 'gameOver': return gameOverScreen(app, intents);
    default:         return infoScreen('Loading…', 'Syncing with the host.', true);
  }
}

// ---------------------------------------------------------------------------
// LOBBY
// ---------------------------------------------------------------------------
function lobbyScreen(app, intents) {
  const pub = app.pub;
  const isHost = app.me.isHost;
  const canStart = pub.startCheck.ok;

  const children = [
    wordmark(intents),
    codeCard(app, intents),
    el('div', { class: 'section-label' }, `TABLE ORDER · ${pub.players.length}/${MAX_PLAYERS}`),
    seatList(app, intents, isHost),
    el('p', { class: 'fine' },
      'Teams alternate around the table, exactly as they do around the real board — ',
      'seat 1 and seat 3 are teammates. ',
      isHost ? 'Use ↑/↓ to reseat someone, which also changes their team.' : ''),
  ];

  if (isHost) {
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-ghost', onclick: () => intents.randomizeOrder() }, '⇅ SHUFFLE SEATS')));
    children.push(configEditor(app, intents));
  }

  children.push(el('div', { class: 'section-label' }, 'THIS GAME'),
    seatingSummary(pub));

  if (!canStart) {
    children.push(el('p', { class: 'fine' }, pub.startCheck.errors[0]));
    children.push(el('p', { class: 'fine' },
      'Supported counts: ', SEATINGS.map((s) => s.players).join(', '), ' players.'));
  }
  if (app.error) children.push(el('p', { class: 'error-text', role: 'alert' }, app.error));

  if (isHost) {
    children.push(el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary' + (canStart ? '' : ' btn-disabled'),
        disabled: canStart ? false : true,
        onclick: () => canStart && intents.startGame(),
      }, '> DEAL & START'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE'),
    ));
  } else {
    children.push(el('p', { class: 'tagline' },
      'Waiting for the host to ', el('span', { class: 'accent' }, 'deal'), '…'));
    children.push(el('div', { class: 'spinner' }));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE')));
  }

  return shell(...children, liveRegion(`${pub.players.length} players in the lobby`));
}

function codeCard(app, intents) {
  return el('div', { class: 'code-card', title: 'Tap to copy', onclick: () => intents.copyCode && intents.copyCode() },
    el('div', { class: 'code-label' }, 'ROOM CODE'),
    el('div', { class: 'code-value' }, app.code || '----'),
    el('div', { class: 'code-hint' }, app.copied ? 'COPIED ✓' : 'TAP TO COPY'),
  );
}

// The seating order IS the team assignment (team = seat % numTeams), so one
// ordered list says everything: who sits where and which team that makes them.
function seatList(app, intents, editable) {
  const pub = app.pub;
  return el('ol', { class: 'seat-list' },
    ...pub.players.map((p, i) => {
      const theme = teamTheme(p.team);
      const isMe = p.id === app.me.id;
      return el('li', {
        class: 'seat' + (isMe ? ' is-me' : '') + (p.online ? '' : ' is-off'),
        style: `--team:${theme.color};--team-dim:${theme.dim}`,
      },
        el('span', { class: 'seat-num' }, String(i + 1)),
        el('span', { class: 'team-dot', 'data-team': String(p.team) }),
        el('span', { class: 'seat-name' }, p.name, isMe ? el('span', { class: 'you-tag' }, 'you') : null),
        el('span', { class: 'seat-team' }, p.online ? theme.name : 'away'),
        editable
          ? el('span', { class: 'seat-moves' },
              moveBtn('↑', `Move ${p.name} up`, i > 0, () => intents.movePlayer(p.id, -1)),
              moveBtn('↓', `Move ${p.name} down`, i < pub.players.length - 1, () => intents.movePlayer(p.id, 1)))
          : null,
      );
    }),
  );
}

// Rendered disabled at the ends of the list rather than hidden, so rows keep a
// stable width as players move around.
function moveBtn(glyph, label, enabled, onclick) {
  return el('button', {
    class: 'tm-move', disabled: enabled ? false : true,
    title: label, 'aria-label': label,
    onclick: enabled ? onclick : null,
  }, glyph);
}

function seatingSummary(pub) {
  const win = pub.sequencesToWin;
  const len = sequenceLengthFor(pub.config);
  // The house rules in force, in the same words the move log uses — the point of
  // listing them here is that a player joining a table with a rule they don't
  // expect finds out BEFORE the deal. Only the ones in force: a line saying the
  // app behaves normally is a line nobody needs to read.
  //
  // Two are dropped because the fixed pills above already say them, and better:
  // the line length and the board layout.
  const house = describeHouseRules(pub.config)
    .filter((s) => !s.startsWith(`${len} in a row`) && s !== 'shuffled board');
  return el('ul', { class: 'summary-list' },
    el('li', {}, el('strong', {}, describeSeating(pub.players.length, pub.config.numTeams))),
    el('li', {}, el('strong', {}, String(pub.handSize)), ' cards each'),
    el('li', {}, el('strong', {}, String(len)), ' in a row'),
    el('li', {}, el('strong', {}, String(win)), ` sequence${win > 1 ? 's' : ''} to win`),
    el('li', {}, pub.config.shuffleBoard ? 'Shuffled board' : 'Classic board'),
    ...house.map((s) => el('li', { class: 'house' }, s)),
  );
}

function configEditor(app, intents) {
  const pub = app.pub;
  const c = pub.config;
  const teamOptions = allowedTeamCounts(pub.players.length);

  return el('section', { class: 'config' },
    el('div', { class: 'section-label' }, 'GAME SETTINGS'),
    teamOptions.length > 1
      ? segmented('Teams', teamOptions.map((n) => ({ value: n, label: `${n} teams` })),
          c.numTeams, (v) => intents.setConfig({ numTeams: v }))
      // With no choice to offer, show the count the engine will actually use —
      // a dash here would contradict the "sequences to win" pill below.
      : el('div', { class: 'stepper' },
          el('span', { class: 'stepper-label' }, 'Teams'),
          el('span', { class: 'stepper-val' }, String(c.numTeams))),
    presetRow(c, intents),

    subLabel('The rules'),
    stepper('Chips in a row', c.sequenceLength, LIMITS.sequenceLength,
      (v) => intents.setConfig({ sequenceLength: v })),
    // A live warning rather than forcing hardCorners on: a toggle that moves
    // another toggle when you touch it is worse than one that explains itself.
    c.sequenceLength < 5 && !c.hardCorners
      ? el('p', { class: 'fine warn-fine' },
          `A corner counts as everyone's chip, so a line through one needs only ${c.sequenceLength - 1} real chips. Turn off free corners below to keep it honest.`)
      : null,
    stepper('Sequences to win', c.sequencesToWin, LIMITS.sequencesToWin,
      (v) => intents.setConfig({ sequencesToWin: v }),
      // 0 is the sentinel for "follow the official table", which is a word rather
      // than a number on screen — nobody wants to win zero sequences.
      { format: (v) => (v === 0 ? 'Auto' : String(v)) }),
    el('p', { class: 'fine' },
      `Auto follows the official table: two sequences for two teams, one for three. This table would race to ${sequencesToWinFor(c.numTeams)}.`),
    toggleRow('Free corners', !c.hardCorners,
      () => intents.setConfig({ hardCorners: !c.hardCorners }),
      // Phrased as the ON state so the switch matches the printed board, where the
      // corners ARE free — "hard corners" would be a switch you turn on to get the
      // official game, which reads backwards.
      'The four ★ corners count as a chip for every team. Switch off and a line through a corner needs a real chip there — and since no card is printed on a corner, only a wild Jack can put one down.'),
    toggleRow('Strict sequences', c.strictSequences,
      () => intents.setConfig({ strictSequences: !c.strictSequences }),
      'Your two sequences may not share a chip at all. The official rule allows exactly one shared chip, which makes the second sequence much cheaper.'),
    toggleRow('Cutthroat Jacks', c.jacksRemoveAny,
      () => intents.setConfig({ jacksRemoveAny: !c.jacksRemoveAny }),
      'A one-eyed Jack lifts ANY chip, including your own team\'s. Chips already locked in a completed sequence stay safe either way.'),
    stepper('Dead cards per turn', c.deadCardsPerTurn, LIMITS.deadCardsPerTurn,
      (v) => intents.setConfig({ deadCardsPerTurn: v })),
    el('p', { class: 'fine' },
      'A card is dead when both its spaces are already covered. The official rule is one swap per turn; set 0 to switch swapping off.'),

    subLabel('The board'),
    toggleRow('Highlight matching spaces', c.showTargets,
      () => intents.setConfig({ showTargets: !c.showTargets }),
      'Lights up every space the card you picked could go. Switch it off to read the board yourself — what is legal does not change, and a wrong tap still says why it was wrong.'),
    toggleRow('Shuffle the board', c.shuffleBoard,
      () => intents.setConfig({ shuffleBoard: !c.shuffleBoard }),
      'Deals the same 96 cards into a fresh arrangement instead of the printed retail layout. Twin cards are kept apart, so the geometry still plays fair.'),
    toggleRow('Memory mode', c.memoryMode,
      () => intents.setConfig({ memoryMode: !c.memoryMode }),
      'A chip keeps the card underneath hidden — no tapping to look, no Peek cards. Remembering what got covered becomes part of the game. What is legal does not change.'),
  );
}

/**
 * The named bundles, above the switches they set. Picking one writes every rule
 * key at once (see presetConfig), so Classic also means "undo my fiddling" and no
 * preset can inherit a leftover from the one before it.
 */
function presetRow(c, intents) {
  const current = presetOf(c);
  const preset = PRESETS.find((p) => p.id === current);
  return el('div', { class: 'preset' },
    el('span', { class: 'stepper-label' }, 'Preset'),
    el('div', { class: 'segmented' },
      ...PRESETS.map((p) => el('button', {
        class: 'seg' + (p.id === current ? ' sel' : ''),
        'aria-pressed': p.id === current ? 'true' : 'false',
        onclick: () => intents.setConfig(presetConfig(p.id)),
      }, p.name)),
      // Not a button — there is nothing to pick. It marks where the settings stand
      // once the host has tuned away from all three, so the row never goes on
      // claiming a preset this table is no longer playing.
      current ? null : el('span', { class: 'seg sel is-custom' }, 'Custom'),
    ),
    el('p', { class: 'fine' }, preset ? preset.blurb : 'Your own mix of the settings below.'),
  );
}

function subLabel(text) {
  return el('div', { class: 'sub-label' }, el('span', {}, text));
}

function segmented(label, options, value, onPick) {
  return el('div', { class: 'stepper' },
    el('span', { class: 'stepper-label' }, label),
    el('div', { class: 'segmented' },
      ...options.map((o) => el('button', {
        class: 'seg' + (o.value === value ? ' sel' : ''),
        onclick: () => onPick(o.value),
      }, o.label)),
    ),
  );
}

/**
 * `format` renders the value for both the display and the screen reader, so a
 * sentinel like "0 means auto" can read as a word without the two disagreeing.
 */
function stepper(label, value, limit, onChange, { format, step = 1 } = {}) {
  const dec = () => onChange(Math.max(limit.min, value - step));
  const inc = () => onChange(Math.min(limit.max, value + step));
  const shown = format ? format(value) : String(value);
  return el('div', { class: 'stepper' },
    el('span', { class: 'stepper-label' }, label),
    el('div', { class: 'stepper-ctrl' },
      el('button', { class: 'step-btn', 'aria-label': 'Decrease ' + label,
        disabled: value <= limit.min ? true : false, onclick: dec }, '−'),
      // Deliberately not a live region. draw() rebuilds the whole tree, so a
      // role="status" here would re-announce on every unrelated render; the label
      // just makes the value readable when a screen reader walks the row.
      el('span', { class: 'stepper-val', 'aria-label': `${label}: ${shown}` }, shown),
      el('button', { class: 'step-btn', 'aria-label': 'Increase ' + label,
        disabled: value >= limit.max ? true : false, onclick: inc }, '+'),
    ),
  );
}

function toggleRow(name, on, onToggle, blurb) {
  return el('label', { class: 'toggle' + (on ? ' on' : '') },
    el('input', { type: 'checkbox', ...(on ? { checked: true } : {}), onchange: onToggle }),
    el('span', { class: 'toggle-box' }),
    el('span', { class: 'toggle-text' },
      el('span', { class: 'toggle-name' }, name),
      blurb ? el('span', { class: 'toggle-blurb' }, blurb) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// PLAY
// ---------------------------------------------------------------------------
function playScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv;
  const myTurn = !!(priv && priv.isTurn);
  const selected = selectedCard(app);

  return shell(
    wordmark(intents),
    turnBanner(app, intents),
    scoreboard(app),
    boardSection(app, intents),
    app.error ? el('p', { class: 'error-text', role: 'alert' }, app.error) : null,
    moveLog(pub),
    // Docked to the bottom of the viewport: the board is tall, and reaching your
    // cards should never mean scrolling away from the space you want to tap.
    el('section', { class: 'hand-dock' },
      el('div', { class: 'section-label' }, `YOUR HAND${myTurn ? '' : ' · WAITING'}`),
      hand(app, intents),
      actionRow(app, intents, selected, myTurn),
    ),
    hostBar(app, intents),
    liveRegion(myTurn ? 'Your turn' : `${turnName(pub)} is playing`),
  );
}

function selectedCard(app) {
  if (!app.priv || !app.selectedCardId) return null;
  return app.priv.hand.find((c) => c.id === app.selectedCardId) || null;
}

function turnName(pub) {
  const p = pub.players.find((x) => x.id === pub.turnPlayerId);
  return p ? p.name : '—';
}

function turnBanner(app, intents) {
  const pub = app.pub;
  const priv = app.priv;
  const current = pub.players.find((p) => p.id === pub.turnPlayerId);
  const theme = teamTheme(current ? current.team : 0);
  const myTurn = !!(priv && priv.isTurn);
  const selected = selectedCard(app);

  // Every line below has to describe the rules THIS table is playing. A hint that
  // names the official rule while the host has changed it is worse than no hint:
  // it sends the player looking for a move the engine will refuse.
  const anyChip = !!pub.config.jacksRemoveAny;

  let hint;
  if (!myTurn) {
    hint = current && !current.online
      ? 'They have dropped out — the host can skip the turn.'
      // No preview to offer when the board is not marking anything, so don't
      // promise one — the waiting player would tap a card and see nothing happen.
      : highlightsOn(pub.config)
        ? 'Tap a card to preview where it could go.'
        : 'Work out your move — the board is not marking spaces this game.';
  } else if (!selected) {
    hint = 'Pick a card from your hand.';
  } else if (selected.targets.length === 0) {
    hint = isOneEyedJack(selected.code)
      ? `No ${anyChip ? '' : 'opponent '}chip can be removed right now — try another card.`
      : `${cardLabel(selected.code)} has no open space. Swap it as a dead card.`;
  } else if (!highlightsOn(pub.config)) {
    // Nothing is marked, so the hint has to describe the rule instead of pointing
    // at the board. It can still say a move exists — the Swap and Pass buttons
    // give that away anyway — just not where.
    hint = isOneEyedJack(selected.code)
      ? `Lift ${anyChip ? 'any' : 'an opponent'} chip that is not already in a sequence.`
      : isTwoEyedJack(selected.code)
        ? `Wild — tap any open space${pub.config.hardCorners ? ', corners included' : ''}.`
        : `Find a ${cardLabel(selected.code)} on the board and tap it.`;
  } else if (isOneEyedJack(selected.code)) {
    // The free reveal is the reason for that second clause, so it goes when memory
    // mode takes the reveal away.
    hint = 'Tap a marked chip to lift it off the board'
      + (peeksAllowed(pub.config) ? ' — their cards are showing.' : '.');
  } else {
    hint = 'Tap a highlighted space to drop your chip.';
  }

  return el('div', { class: 'turn-banner' + (myTurn ? ' mine' : ''), style: `--team:${theme.color};--team-dim:${theme.dim}` },
    el('div', { class: 'turn-eyebrow' }, myTurn ? 'YOUR TURN' : 'NOW PLAYING'),
    el('div', { class: 'turn-name' },
      myTurn ? 'Go.' : (current ? current.name : '—'),
      current && !current.online ? el('span', { class: 'chip-note' }, ' away') : null),
    el('p', { class: 'turn-hint' }, hint),
  );
}

function scoreboard(app) {
  const pub = app.pub;
  const need = pub.sequencesToWin;
  const rows = Array.from({ length: pub.config.numTeams }, (_, t) => {
    const theme = teamTheme(t);
    const members = pub.players.filter((p) => p.team === t);
    const mine = members.some((p) => p.id === app.me.id);
    const done = pub.seqCounts[t] || 0;
    return el('li', {
      class: 'score-row' + (pub.players.find((p) => p.id === pub.turnPlayerId)?.team === t ? ' current' : ''),
      style: `--team:${theme.color};--team-dim:${theme.dim}`,
    },
      el('span', { class: 'score-team' },
        el('span', { class: 'team-dot', 'data-team': String(t) }),
        el('span', { class: 'score-name' }, theme.name),
        mine ? el('span', { class: 'you-tag' }, 'you') : null),
      el('span', { class: 'score-detail' }, members.map((p) => p.name).join(', ')),
      el('span', { class: 'seq-pips', 'aria-label': `${done} of ${need} sequences` },
        ...Array.from({ length: need }, (_, i) =>
          el('span', { class: 'pip' + (i < done ? ' on' : '') }))),
    );
  });
  return el('ul', { class: 'scoreboard' }, ...rows);
}

// --- The board ------------------------------------------------------------
function boardSection(app, intents) {
  const pub = app.pub;
  return el('section', { class: 'board-section' },
    el('div', { class: 'board-bar' },
      el('span', { class: 'section-label' }, 'BOARD'),
      el('span', { class: 'deck-count' }, `${pub.deckCount} cards left`),
      // Gone in memory mode rather than disabled: a greyed-out button invites the
      // table to keep asking the host to un-grey it, and there is nothing here to
      // re-enable mid-game anyway — the setting is locked once the deal happens.
      // aria-pressed rather than a changing label alone, so the toggle reads as a
      // toggle to a screen reader instead of as two different buttons.
      peeksAllowed(pub.config) ? el('button', {
        class: 'link-btn board-peek' + (app.peekAll ? ' on' : ''),
        'aria-pressed': app.peekAll ? 'true' : 'false',
        'data-focus': 'peek-all',
        title: 'Show the card under every chip',
        onclick: () => intents.togglePeekAll(),
      }, app.peekAll ? 'Hide cards' : 'Peek cards') : null,
      el('button', {
        class: 'link-btn board-zoom',
        'data-focus': 'zoom',
        onclick: () => intents.toggleZoom(),
      }, app.zoom ? 'Fit to screen' : 'Zoom in'),
    ),
    el('div', {
      class: 'board-wrap' + (app.zoom ? ' zoom' : ''),
      'data-keep-scroll': 'board',
    }, boardGrid(app, intents)),
  );
}

function boardGrid(app, intents) {
  const pub = app.pub;
  const priv = app.priv;
  const myTurn = !!(priv && priv.isTurn);
  const selected = selectedCard(app);
  const targets = new Set(selected ? selected.targets : []);
  const removing = !!(selected && isOneEyedJack(selected.code));
  // A house rule, and only ever about what the board admits to: `targets` still
  // arrives from the engine and a legal tap still plays. Switching it off withdraws
  // the ring, the one-eyed Jack's free reveal and the screen reader's "press to
  // play here" together — leave any one of them in and the setting just moves the
  // answer somewhere else instead of removing it.
  const showTargets = highlightsOn(pub.config);
  // Memory mode. Same shape of house rule and the same discipline: withdraw every
  // way of seeing under a chip at once, or the setting just moves the answer.
  const canPeek = peeksAllowed(pub.config);
  // With hard corners a ★ is no longer everyone's chip, so it must not go on
  // looking like one — and it becomes a space a wild can actually cover.
  const hardCorners = !!pub.config.hardCorners;

  // Cells inside a completed sequence, and which team owns that line. Locked
  // chips can't be lifted by a one-eyed Jack, so the marker is meaningful, not
  // just celebratory.
  const seqTeam = new Map();
  for (const s of pub.sequences) for (const cell of s.cells) seqTeam.set(cell, s.team);

  const lastCell = pub.lastMove ? pub.lastMove.cell : null;
  const cursor = Math.min(Math.max(app.cursor | 0, 0), pub.layout.length - 1);

  const cells = pub.layout.map((code, cell) => {
    const chip = pub.chips[cell];
    const corner = code === FREE;
    const isTarget = targets.has(cell);
    // Legal, and shown to be legal. Everything visible keys off `marked`; only the
    // click handler is allowed to know about `isTarget`.
    const marked = isTarget && showTargets;
    const seq = seqTeam.get(cell);

    // Fade the chip and show the card printed under it. Three ways in: the space
    // was tapped, the peek-all toggle is on, or — free of charge — a one-eyed Jack
    // is selected and this is one of the chips it could lift, which is the moment
    // the hidden card actually decides the move. That third one is a highlight in
    // all but name, so it goes when the highlights do; tap-to-peek and Peek cards
    // stay, because they only ever show what is printed on the board anyway.
    //
    // Memory mode closes all three, and it is the only setting that does: what is
    // printed under a chip is exactly what it takes away.
    const peeking = chip != null && canPeek
      && (app.peekAll || app.peekCell === cell || (removing && marked));

    const cls = ['cell'];
    if (corner) cls.push(hardCorners ? 'corner hard-corner' : 'corner');
    if (chip != null) cls.push('taken');
    if (peeking) cls.push('peek');
    if (marked) cls.push(removing ? 'target-remove' : 'target');
    if (seq != null) cls.push('in-seq');
    if (cell === lastCell) cls.push('last');

    // The chip colour wins the --team slot; a bare corner inside a sequence
    // borrows the line's colour so the run reads as one unbroken streak.
    const themeIdx = chip != null ? chip : seq;
    const style = themeIdx != null
      ? `--team:${teamTheme(themeIdx).color};--team-dim:${teamTheme(themeIdx).dim}`
      : '';

    // A hollow star for a corner that has to be earned — shape, not colour, so it
    // survives being read in greyscale or by someone who cannot tell the fill from
    // the felt.
    const face = corner
      ? el('span', { class: 'free-mark' }, hardCorners ? '☆' : '★')
      : el('span', { class: 'card-face' + (isRedSuit(code) ? ' red' : '') },
          el('span', { class: 'rank' }, rankLabel(code)),
          el('span', { class: 'suit' }, suitGlyph(code)));

    const playable = myTurn && isTarget;
    // On your turn an ordinary space still answers, so pressing it before picking
    // a card tells you to pick one. With the highlights off every open space answers
    // as well: a guess that does nothing at all is indistinguishable from a broken
    // button, so the host names the reason instead — which is the same thing the
    // ring was saying, only after the guess rather than before it. Off-turn the
    // board is inert but keeps its highlight, so tapping a card while you wait
    // previews your options.
    const responds = myTurn && (isTarget || !selected || !showTargets);

    // Order matters. A legal target always plays or removes — if the peek came
    // first, a one-eyed Jack could never lift anything, because the tap meant to
    // remove would be eaten by the reveal. Peeking therefore only picks up the
    // taps that would otherwise do nothing at all, which is every covered space
    // you can't act on: the whole board while you wait for your turn, and with the
    // highlights off, the chips a one-eyed Jack may not lift — no explanation
    // needed there, since the ✦ and the chip's own colour already give the reason.
    // In memory mode the peek branch drops out, so a covered space you cannot act
    // on falls through to `responds` and gets told it is taken — or goes inert off
    // your turn, which is honest: there is genuinely nothing to do there.
    const onclick = playable ? () => intents.playAt(cell)
      : (chip != null && canPeek) ? () => intents.peekAt(cell)
      : responds ? () => intents.playAt(cell)
      : null;

    return el('button', {
      class: cls.join(' '),
      style,
      'data-cell': String(cell),
      // aria-disabled, not disabled: a disabled button cannot be focused, which
      // would leave the board entirely unreachable by keyboard and unreadable to
      // a screen reader — and these labels are the only way to read the board
      // without seeing it. It tracks whether the space responds at all, since
      // claiming a control is disabled while it still does something is a lie.
      // Outside memory mode there is no peek hint in the label, because the card
      // is already announced and there is nothing under the chip a screen reader
      // hasn't been told. In memory mode the label withholds it instead — see
      // cellLabel.
      'aria-disabled': onclick ? null : 'true',
      // Roving tabindex. A hundred separate tab stops is not navigation, so the
      // grid is ONE stop and the arrow keys move inside it.
      tabindex: cell === cursor ? '0' : '-1',
      'data-focus': cell === cursor ? 'board-cell' : null,
      // `marked`, not `playable`: with the highlights off the label must go quiet
      // too, or the house rule would handicap only the players who can see the
      // board. Nothing is lost — the coordinate, card, occupant and locked state
      // are still announced, which is everything a sighted player is reasoning from.
      'aria-label': cellLabel(cell, code, chip, seq != null, myTurn && marked, removing,
        { hardCorner: corner && hardCorners, hidden: !canPeek }),
      onclick,
    },
      face,
      // data-team drives a per-team inner mark, so the chips stay distinguishable
      // without relying on hue (green and red read almost identically to a
      // red/green colour-blind player). The scoreboard dots carry the same marks.
      chip != null ? el('span', { class: 'chip', 'data-team': String(chip) }) : null,
      seq != null ? el('span', { class: 'lock-mark', 'aria-hidden': 'true' }, '✦') : null,
    );
  });

  return el('div', {
    class: 'board',
    role: 'group',
    'aria-label': `Sequence board, ${BOARD_SIZE} by ${BOARD_SIZE}. Use the arrow keys to move between spaces.`,
    style: `--cols:${BOARD_SIZE}`,
    onkeydown: (e) => {
      const step = BOARD_KEYS[e.key];
      if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const x = cursor % BOARD_SIZE;
      const y = Math.floor(cursor / BOARD_SIZE);
      const nx = Math.min(BOARD_SIZE - 1, Math.max(0, x + step[0]));
      const ny = Math.min(BOARD_SIZE - 1, Math.max(0, y + step[1]));
      intents.setCursor(ny * BOARD_SIZE + nx);
    },
  }, ...cells);
}

// Arrow keys step one space; Home and End run to the ends of the row, PageUp and
// PageDown to the top and bottom of the column. Overshoot is clamped, so the
// oversized steps just mean "as far as this goes".
const BOARD_KEYS = {
  ArrowLeft:  [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp:    [0, -1],
  ArrowDown:  [0, 1],
  Home:       [-BOARD_SIZE, 0],
  End:        [BOARD_SIZE, 0],
  PageUp:     [0, -BOARD_SIZE],
  PageDown:   [0, BOARD_SIZE],
};

function cellLabel(cell, code, chip, locked, playable, removing, { hardCorner, hidden } = {}) {
  const where = cellName(cell);
  // "free corner" would be a false statement under hard corners, and this label is
  // the whole board for a player who cannot see it — the ☆ has to be readable too.
  //
  // A covered space normally names its card, because peeking is one tap away for
  // everybody and making a screen-reader user issue that tap per space would be
  // friction for no gain. Memory mode takes the peek away from everybody, so the
  // label has to go quiet with it: announcing the card here would hand the one
  // scarce thing in that game to some players and not others — and hand it for
  // free, which is worse than the sighted board. An uncovered space still names
  // its card, since that is printed face up for the whole table to see.
  const what = code === FREE
    ? (hardCorner ? 'corner, no card printed' : 'free corner')
    : (hidden && chip != null) ? 'card hidden' : cardLabel(code);
  const who = chip == null ? 'empty' : `${teamTheme(chip).name} chip`;
  const note = locked ? ', in a completed sequence' : '';
  // Whether you can act here is what a sighted player reads instantly off the
  // highlight, and the one thing a screen-reader user has no other way to learn —
  // so the caller passes what the board is showing, not what the engine would
  // accept, and this goes quiet exactly when the highlights do.
  const action = playable
    ? (removing ? ', press to remove this chip' : ', press to play here')
    : '';
  return `${where}, ${what}, ${who}${note}${action}`;
}

// --- Hand ----------------------------------------------------------------
function hand(app, intents) {
  const priv = app.priv;
  if (!priv) return el('p', { class: 'fine' }, 'Waiting for your cards…');
  if (!priv.hand.length) return el('p', { class: 'fine' }, 'No cards left in hand.');

  return el('div', { class: 'hand', 'data-keep-scroll': 'hand' },
    ...priv.hand.map((c) => {
      const cls = ['card'];
      if (c.id === app.selectedCardId) cls.push('selected');
      if (c.dead) cls.push('dead');
      if (isRedSuit(c.code)) cls.push('red');
      return el('button', {
        class: cls.join(' '),
        onclick: () => intents.selectCard(c.id),
        // Selecting a card rebuilds the tree, and without this the keyboard focus
        // it was holding would vanish back to the top of the page.
        'data-focus': `card-${c.id}`,
        'aria-pressed': c.id === app.selectedCardId ? 'true' : 'false',
        'aria-label': cardLabel(c.code) + jackNote(c.code) + (c.dead ? ', dead card' : ''),
      },
        el('span', { class: 'card-rank' }, rankLabel(c.code)),
        el('span', { class: 'card-suit' }, suitGlyph(c.code)),
        isJack(c.code)
          ? el('span', { class: 'card-tag' }, isTwoEyedJack(c.code) ? 'WILD' : 'REMOVE')
          : null,
        c.dead ? el('span', { class: 'card-tag dead-tag' }, 'DEAD') : null,
      );
    }),
  );
}

function jackNote(code) {
  if (isTwoEyedJack(code)) return ', two-eyed Jack, wild';
  if (isOneEyedJack(code)) return ', one-eyed Jack, removes a chip';
  return '';
}

function actionRow(app, intents, selected, myTurn) {
  const priv = app.priv;
  if (!priv) return null;

  const canSwap = myTurn && !!selected && selected.dead && priv.deadRemaining > 0;
  const swapLabel = selected && selected.dead
    ? `↻ SWAP ${cardLabel(selected.code)}`
    : '↻ SWAP DEAD CARD';

  return el('div', { class: 'btn-row action-row' },
    el('button', {
      class: 'btn btn-secondary' + (canSwap ? '' : ' btn-disabled'),
      disabled: canSwap ? false : true,
      title: priv.deadRemaining === 0
        ? 'No dead-card swaps left this turn.'
        : canSwap
          ? 'Discard it and draw a replacement.'
          : 'Pick a card marked DEAD, then swap it for a fresh one.',
      onclick: () => canSwap && intents.exchangeDead(selected.id),
    }, swapLabel),
    el('button', {
      class: 'btn btn-ghost' + (myTurn && priv.canPass ? '' : ' btn-disabled'),
      disabled: (myTurn && priv.canPass) ? false : true,
      title: 'Only available with no legal move and no dead card to swap.',
      onclick: () => intents.pass(),
    }, '⤼ PASS'),
  );
}

function moveLog(pub) {
  const entries = (pub.log || []).slice().reverse();
  if (!entries.length) return null;
  return el('section', { class: 'log-section' },
    el('div', { class: 'section-label' }, 'MOVES'),
    el('ul', { class: 'log-list' },
      ...entries.map((e, i) => el('li', {
        class: 'log-line' + (i === 0 ? ' latest' : ''),
        style: e.team != null ? `--team:${teamTheme(e.team).color}` : '',
      },
        e.team != null
          ? el('span', { class: 'team-dot', 'data-team': String(e.team) })
          : el('span', { class: 'team-dot neutral' }),
        el('span', {}, e.text),
      )),
    ),
  );
}

function hostBar(app, intents) {
  if (!app.me.isHost) {
    return el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-ghost', onclick: intents.goHome }, 'LEAVE'));
  }
  const pub = app.pub;
  const current = pub.players.find((p) => p.id === pub.turnPlayerId);
  // Ending is irreversible and takes the game away from everyone else, so it
  // takes two taps. Inline rather than window.confirm, which is easy to dismiss
  // by reflex and looks nothing like the rest of the app.
  return el('section', { class: 'host-bar' },
    el('div', { class: 'section-label' }, 'HOST CONTROLS'),
    app.confirmEnd
      ? el('div', { class: 'btn-row' },
          el('button', { class: 'btn btn-secondary', onclick: () => intents.armEndGame(false) }, '‹ KEEP PLAYING'),
          el('button', { class: 'btn btn-danger', onclick: () => intents.endGame() }, '■ END IT'))
      : el('div', { class: 'btn-row' },
          el('button', {
            class: 'btn btn-secondary',
            title: current ? `Skip ${current.name}'s turn` : 'Skip the current turn',
            onclick: () => intents.skipTurn(),
          }, '» SKIP TURN'),
          el('button', { class: 'btn btn-ghost', onclick: () => intents.armEndGame(true) }, '■ END GAME')),
    app.confirmEnd
      ? el('p', { class: 'fine danger-text' }, `This ends the game for all ${pub.players.length} players. Nobody wins.`)
      : el('p', { class: 'fine' }, 'Skip is for a player who has dropped out or wandered off.'),
  );
}

// ---------------------------------------------------------------------------
// GAME OVER
// ---------------------------------------------------------------------------
function gameOverScreen(app, intents) {
  const pub = app.pub;
  const isHost = app.me.isHost;
  const won = pub.winner != null;
  const theme = won ? teamTheme(pub.winner) : null;
  const iWon = won && app.priv && app.priv.team === pub.winner;

  const banner = won
    ? el('div', { class: 'win-banner', style: `--team:${theme.color};--team-dim:${theme.dim}` },
        el('div', { class: 'win-eyebrow' }, iWon ? 'YOU WIN' : 'WINNER'),
        el('div', { class: 'win-team' }, theme.name),
        el('div', { class: 'win-score' },
          pub.players.filter((p) => p.team === pub.winner).map((p) => p.name).join(' & ')))
    : el('div', { class: 'win-banner tie' },
        el('div', { class: 'win-eyebrow' }, 'GAME ENDED'),
        el('div', { class: 'win-team' }, 'No winner'),
        el('div', { class: 'win-score' }, 'The host stopped the game.'));

  const children = [
    wordmark(intents),
    banner,
    el('div', { class: 'section-label' }, 'SEQUENCES'),
    scoreboard(app),
    el('div', { class: 'section-label' }, 'FINAL BOARD'),
    el('div', { class: 'board-wrap' }, boardGrid(app, intents)),
    moveLog(pub),
  ];

  if (isHost) {
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.playAgain() }, '> PLAY AGAIN')));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-ghost', onclick: intents.goHome }, 'NEW GAME')));
  } else {
    children.push(el('p', { class: 'fine' }, 'Waiting for the host to start a rematch, or leave to go home.'));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE')));
  }

  return shell(...children, liveRegion(won ? `${theme.name} wins` : 'Game over'));
}

// ---------------------------------------------------------------------------
// RULES overlay
// ---------------------------------------------------------------------------
const NUMBER_WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };

function winSentence(config) {
  const n = winTargetFor(config);
  return `This game takes ${NUMBER_WORDS[n] || n} of them to win.`;
}

/**
 * `config` is null when the sheet is opened from the home screen, and then every
 * line describes the official game. In a game it describes THAT game: a sheet
 * that teaches a rule the host has changed is actively misleading, and this is the
 * one screen a confused player goes to.
 */
function rulesOverlay(intents, config) {
  const len = sequenceLengthFor(config);
  const lenWord = NUMBER_WORDS[len] || String(len);
  const hardCorners = !!(config && config.hardCorners);
  const anyChip = !!(config && config.jacksRemoveAny);
  const strict = !!(config && config.strictSequences);
  const canPeek = peeksAllowed(config);
  const showTargets = highlightsOn(config);
  const house = config ? describeHouseRules(config) : [];

  const jack = (glyphs, name, text) => el('div', { class: 'rule-round' },
    el('span', { class: 'rule-short' }, glyphs),
    el('div', {}, el('div', { class: 'rule-name' }, name), el('p', { class: 'rule-text' }, text)));

  const sheet = el('div', {
    class: 'rules-sheet',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'rules-title',
    // Focusable so main.js can put the keyboard inside the dialog on open, which
    // is also what makes the Escape and Tab handling below reachable.
    tabindex: '-1',
    'data-keep-scroll': 'rules',
    onkeydown: (e) => {
      if (e.key === 'Escape') { e.preventDefault(); intents.toggleRules(); return; }
      if (e.key !== 'Tab') return;
      // Without a trap, Tab walks straight out of the dialog and onto the board
      // behind it — invisible to a keyboard user, who then has no idea where
      // their focus went or how to get back.
      const stops = [...e.currentTarget.querySelectorAll('button')].filter((b) => !b.disabled);
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === e.currentTarget)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus();
      }
    },
  },
    el('div', { class: 'rules-head' },
      el('h2', { id: 'rules-title' }, 'How to play'),
      el('button', { class: 'help-btn close', 'aria-label': 'Close', onclick: () => intents.toggleRules() }, '×')),
    el('p', { class: 'tagline' },
      'The board shows every card except the Jacks, printed twice. Play a card, cover a space that matches it, and build ',
      el('strong', {}, `${lenWord} chips in a row`),
      ' — across, down or diagonally.'),

    house.length
      ? el('div', {},
          el('div', { class: 'section-label' }, 'HOUSE RULES THIS GAME'),
          // Up top, because someone opening this sheet mid-game is usually looking
          // for exactly the thing that surprised them.
          el('ul', { class: 'rule-list' },
            ...house.map((s) => el('li', { class: 'house' }, s))))
      : null,

    el('div', { class: 'section-label' }, 'EACH TURN'),
    el('ul', { class: 'rule-list' },
      // Inside a game the highlight setting is knowable, so say it flatly — the
      // whole point of this sheet is that it describes THIS game, and a player
      // opening it because nothing lit up needs an answer, not a hedge. Opened
      // from the home screen there is no config to read, so the hedge stays:
      // promising a ring a host may already have turned off is the misleading
      // kind of help.
      el('li', {}, 'Tap a card in your hand, then tap a space that matches it. ' + (
        !config ? 'Matching spaces light up unless the host switched that off.'
          : showTargets ? 'Matching spaces light up.'
            : 'Nothing lights up this game — read the board yourself. Tap anyway and you are told why a space is wrong.')),
      el('li', {}, 'The card is discarded and you draw a replacement, then play passes to the left.'),
      el('li', {}, canPeek
        ? 'A chip hides the card under it. Tap the chip to see it for a moment, or use Peek cards to open the whole board at once.'
        : 'A chip hides the card under it, and this game it stays hidden — remembering what got covered is part of the game.'),
      el('li', {}, 'Teammates are never seated next to each other, so play alternates between teams.'),
    ),

    el('div', { class: 'section-label' }, 'THE JACKS'),
    el('div', { class: 'rule-rounds' },
      jack('J♦ J♣', 'Two-eyed Jacks — wild',
        'Place a chip on ANY open space on the board.'
        + (hardCorners ? ' This game that includes the ☆ corners, which no other card can reach.' : '')
        + ' The strongest card in the game.'),
      jack('J♠ J♥', 'One-eyed Jacks — remove',
        `Lift ONE ${anyChip ? 'chip off the board — anyone’s, including your own team’s' : 'opponent chip off the board'}. `
        + 'Chips already inside a completed sequence are safe forever.'),
    ),

    el('div', { class: 'section-label' }, 'SEQUENCES'),
    el('ul', { class: 'rule-list' },
      el('li', {}, `${lenWord[0].toUpperCase()}${lenWord.slice(1)} of your team’s chips in a straight line is a sequence. `
        + (config ? winSentence(config) : 'Two teams race to two sequences; three teams race to one.')),
      el('li', {}, hardCorners
        ? 'The four ☆ corners are NOT free this game. A line through one needs a real chip there, and only a wild Jack can put one down.'
        : `The four ★ corners are free — they count as a chip for every team, so a line through one needs only ${NUMBER_WORDS[len - 1] || len - 1} real chips.`),
      el('li', {}, strict
        ? 'Your sequences may not share a chip at all this game.'
        : 'A second sequence may reuse at most one chip from your first.'),
    ),

    el('div', { class: 'section-label' }, 'DEAD CARDS'),
    el('p', { class: 'fine' },
      'If both spaces for a card are already covered it is DEAD and marked as such in your hand. ',
      'Select it and tap Swap to discard it and draw a fresh one — once per turn by default.'),

    el('p', { class: 'fine' },
      'Everyone plays on their own device, so your hand stays yours. Pass is only offered when you genuinely cannot move.'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.toggleRules() }, 'GOT IT')),
  );

  return el('div', { class: 'rules-overlay', onclick: (e) => { if (e.target.classList.contains('rules-overlay')) intents.toggleRules(); } }, sheet);
}
