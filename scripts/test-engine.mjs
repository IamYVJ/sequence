// Headless end-to-end test of the Sequence engine. No browser, no network.
//   node scripts/test-engine.mjs
//
// Exercises: the board data (every non-Jack card printed exactly twice), the
// lobby and seating table, a full greedy 4-player game, both Jack behaviours,
// dead-card swaps, the shared-chip sequence rule, locked-chip protection, the
// win conditions, hand privacy, serialize/restore and reconnect. Also net.js's
// broker recovery, against a stub peer and fake timers.

import { GameEngine, PHASES } from '../js/state.js';
import { applyGameIntent } from '../js/intents.js';
import {
  TokenBucket, decodePeerFrame, MAX_FRAME_BYTES, MAX_TYPE_LEN,
} from '../js/guards.js';
import {
  BOARD_SIZE, CELL_COUNT, CORNERS, FREE, CLASSIC_LAYOUT, BOARD_CARD_CODES,
  buildCellIndex, randomLayout, cellName, windowsThrough, isCorner,
} from '../js/board.js';
import {
  MAX_PLAYERS, SEATINGS, buildDeck, shuffle, legalTargets, isDeadCard,
  isOneEyedJack, isTwoEyedJack, isJack, newSequencesAt, normalizeConfig,
  validateStart, handSizeFor, sequencesToWinFor, allowedTeamCounts, cleanName,
  describeSeating, highlightsOn, peeksAllowed, DEFAULTS, LIMITS, RULE_KEYS,
  PRESETS, presetOf, presetConfig, winTargetFor, sequenceLengthFor,
  describeHouseRules, claimedCellsFor, SEQUENCE_LENGTH,
} from '../js/rules.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function section(t) { console.log('\n— ' + t); }

// ---------------------------------------------------------------------------
// Deterministic RNG.
//
// The engine shuffles the deck (and optionally the board) through
// crypto.getRandomValues, so an unseeded run deals a different game every time.
// That makes a failure impossible to reproduce, and it hid a real problem: the
// full-game driver below occasionally needed thousands of turns to finish, so a
// turn cap that passed locally would have failed at random later.
//
// rules.js reads `crypto` at call time, so swapping the global here — before any
// engine is constructed — is enough. `seed(n)` restarts the stream.
// ---------------------------------------------------------------------------
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
seed(1);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/**
 * `players` and `start` are the harness's; everything else is config, so a house
 * rule can be switched on without this signature growing a parameter per knob.
 * The four official values are named explicitly rather than left to DEFAULTS, so
 * a test reading `freshGame({ players: 4 })` can see what it is getting.
 */
function freshGame({ players = 4, start = true, ...config } = {}) {
  const eng = new GameEngine();
  eng.addPlayer('host', 'Host', { isHost: true });
  for (let i = 1; i < players; i++) eng.addPlayer('p' + i, 'Player' + i);
  eng.setConfig({
    numTeams: 2, deadCardsPerTurn: 1, shuffleBoard: false, showTargets: true, ...config,
  });
  if (start) eng.startGame('host');
  return eng;
}

/**
 * Replace a player's hand with exactly these cards, and return them.
 *
 * The engine is handed a COPY: it splices played cards out of the live hand, so
 * sharing the array would silently rewrite the caller's handle on every play.
 */
function giveHand(eng, playerId, codes) {
  const cards = codes.map((code, i) => ({ id: `${code}#test${i}`, code }));
  eng.hands[playerId] = cards.slice();
  return cards;
}

/** Force whose turn it is (by seat index), clearing the dead-swap counter. */
function setTurnTo(eng, playerId) {
  eng.turn = eng.players.findIndex((p) => p.id === playerId);
  eng.deadUsed = 0;
}

/** Play the card printed on `cell` onto it. Returns the engine result. */
function coverCell(eng, playerId, cell) {
  const cards = giveHand(eng, playerId, [eng.layout[cell]]);
  return eng.playCard(playerId, cards[0].id, cell);
}

function neighboursOf(cell) {
  const r = Math.floor(cell / BOARD_SIZE), c = cell % BOARD_SIZE;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= BOARD_SIZE || cc < 0 || cc >= BOARD_SIZE) continue;
      out.push(rr * BOARD_SIZE + cc);
    }
  }
  return out;
}

function twinAdjacencies(layout) {
  let n = 0;
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const code = layout[cell];
    if (code === FREE) continue;
    for (const nb of neighboursOf(cell)) if (layout[nb] === code) n++;
  }
  return n;
}

function codeCounts(layout) {
  const counts = new Map();
  for (const code of layout) counts.set(code, (counts.get(code) || 0) + 1);
  return counts;
}

// ===========================================================================
section('Board data — the printed layout');
{
  ok(CLASSIC_LAYOUT.length === CELL_COUNT, 'classic layout has 100 cells');
  ok(BOARD_CARD_CODES.length === 48, '48 distinct cards are printed on the board');

  const counts = codeCounts(CLASSIC_LAYOUT);
  ok(counts.get(FREE) === 4, 'exactly four free corners');
  ok(CORNERS.every((c) => CLASSIC_LAYOUT[c] === FREE), 'the free spaces are the four corners');
  ok(CORNERS.every(isCorner) && !isCorner(1), 'isCorner agrees with CORNERS');

  const wrong = BOARD_CARD_CODES.filter((code) => counts.get(code) !== 2);
  ok(wrong.length === 0, `every non-Jack card appears exactly twice (offenders: ${wrong.join(', ')})`);
  ok(counts.size === 49, 'no card outside the 48 + FREE appears on the board');
  ok(!CLASSIC_LAYOUT.some(isJack), 'no Jack is printed on the board');

  const index = buildCellIndex(CLASSIC_LAYOUT);
  ok(index.size === 48, 'cell index covers all 48 codes');
  ok([...index.values()].every((cells) => cells.length === 2), 'every code indexes exactly two cells');
  ok(twinAdjacencies(CLASSIC_LAYOUT) === 0, 'no card sits next to its own twin');

  ok(cellName(0) === 'A1' && cellName(9) === 'J1', 'top corners name as A1 / J1');
  ok(cellName(90) === 'A10' && cellName(99) === 'J10', 'bottom corners name as A10 / J10');
  ok(cellName(34) === 'E4', 'cell 34 names as E4');
  ok(cellName(-1) === '?' && cellName(100) === '?', 'out-of-range cells name defensively');
}

// ===========================================================================
section('Board geometry — the 5-cell windows');
{
  ok(windowsThrough(0).length === 3, 'a corner sits on 3 windows (row, column, diagonal)');
  const mid = windowsThrough(44);
  ok(mid.length === 20, 'a central cell sits on 20 windows (5 per direction)');
  ok(mid.every((w) => w.length === 5 && w.includes(44)), 'every window is 5 cells and contains the cell');
  ok(windowsThrough(45).every((w) => w.every((c) => c >= 0 && c < CELL_COUNT)),
    'windows never run off the board');
}

// ===========================================================================
section('A shuffled board is still a legal board');
{
  for (let attempt = 0; attempt < 5; attempt++) {
    const layout = randomLayout(shuffle);
    const counts = codeCounts(layout);
    ok(layout.length === CELL_COUNT, 'shuffled layout has 100 cells');
    ok(counts.get(FREE) === 4 && CORNERS.every((c) => layout[c] === FREE),
      'shuffled layout keeps the four corners free');
    ok(BOARD_CARD_CODES.every((code) => counts.get(code) === 2),
      'shuffled layout prints every card exactly twice');
    ok(twinAdjacencies(layout) === 0, 'shuffled layout keeps twins apart');
  }
  ok(randomLayout(shuffle).join() !== randomLayout(shuffle).join(), 'two shuffles differ');
}

// ===========================================================================
section('Deck — two full 52-card decks');
{
  const deck = buildDeck();
  ok(deck.length === 104, 'deck holds 104 cards');
  ok(new Set(deck.map((c) => c.id)).size === 104, 'every card has a unique id');
  ok(deck.filter((c) => isJack(c.code)).length === 8, 'eight Jacks in the deck');
  ok(deck.filter((c) => isTwoEyedJack(c.code)).length === 4, 'four two-eyed Jacks');
  ok(deck.filter((c) => isOneEyedJack(c.code)).length === 4, 'four one-eyed Jacks');
  ok(deck.filter((c) => c.code === 'AS').length === 2, 'each card appears twice');
}

// ===========================================================================
section('Seating table and start validation');
{
  for (const s of SEATINGS) {
    ok(handSizeFor(s.players) === s.handSize, `${s.players} players deal ${s.handSize} cards`);
    for (const teams of s.teams) {
      ok(s.players % teams === 0, `${s.players} players split evenly into ${teams} teams`);
      ok(validateStart(s.players, teams).ok, `${s.players} players / ${teams} teams is a legal table`);
    }
  }
  for (const n of [5, 7, 11]) {
    ok(!validateStart(n, 2).ok, `${n} players cannot split into equal teams`);
    ok(allowedTeamCounts(n).length === 0, `${n} players offers no team count`);
  }
  ok(!validateStart(1, 2).ok, 'one player is not a game');
  ok(!validateStart(4, 3).ok, '4 players cannot play in 3 teams');
  ok(sequencesToWinFor(2) === 2 && sequencesToWinFor(3) === 1,
    'two teams race to two sequences, three teams to one');

  ok(describeSeating(6, 3) === '3 teams of 2', 'an even table is described by its teams');
  ok(describeSeating(4, 2) === '2 teams of 2', '4 players are two pairs');
  // The lobby shows this from the moment the host is alone in the room, so the
  // odd-count branch is the one a host always sees first.
  ok(describeSeating(1, 2) === '1 player', 'a lone host is not "1 players"');
  ok(describeSeating(5, 2) === '5 players', 'an unsupported count falls back to a plain count');
  ok(describeSeating(3, 0) === '3 players', 'a missing team count does not divide by zero');
}

// ===========================================================================
section('Config normalisation');
{
  ok(normalizeConfig({ numTeams: 3 }, 4).numTeams === 2, '4 players are forced to 2 teams');
  ok(normalizeConfig({ numTeams: 3 }, 6).numTeams === 3, '6 players may choose 3 teams');
  ok(normalizeConfig({ deadCardsPerTurn: 99 }, 4).deadCardsPerTurn === 3, 'dead-card limit clamps high');
  ok(normalizeConfig({ deadCardsPerTurn: -4 }, 4).deadCardsPerTurn === 0, 'dead-card limit clamps low');
  ok(normalizeConfig({ deadCardsPerTurn: 'x' }, 4).deadCardsPerTurn === 1, 'garbage falls back to the default');
  ok(normalizeConfig({ shuffleBoard: 'yes' }, 4).shuffleBoard === true, 'shuffleBoard coerces to boolean');

  // showTargets is the one flag that defaults ON, so a missing key must not be
  // read as "off" the way `!!undefined` would have it.
  ok(normalizeConfig({}, 4).showTargets === true, 'highlights are on unless the host says otherwise');
  ok(normalizeConfig({ showTargets: false }, 4).showTargets === false, 'the host can switch highlights off');
  ok(normalizeConfig({ showTargets: 0 }, 4).showTargets === false, 'showTargets coerces to boolean');
  ok(highlightsOn(normalizeConfig({}, 4)), 'highlightsOn agrees with the default');
  ok(!highlightsOn(normalizeConfig({ showTargets: false }, 4)), 'highlightsOn agrees when off');
  // restore() rehydrates a snapshot with Object.assign, so a game already in
  // progress when this setting shipped comes back without the key at all. It has
  // to read as "on" — the alternative silently changes how a live game behaves.
  ok(highlightsOn({ numTeams: 2 }), 'a config from before the setting existed still shows highlights');
  ok(highlightsOn(undefined), 'a missing config does not crash the board');
  ok(cleanName('  Ada \n Lovelace  ') === 'Ada Lovelace', 'names are trimmed and collapsed');
  ok(cleanName('x'.repeat(40)).length === 20, 'names are capped at 20 characters');
  ok(cleanName('') === '', 'an empty name stays empty');
  const bell = String.fromCharCode(7);
  ok(cleanName(`Ada${bell}Lovelace`) === 'AdaLovelace', 'control characters are stripped');
}

// ===========================================================================
// "Presentational" is a claim about the engine, so it gets asserted against the
// engine: two games dealt from the same seed, one with the highlights off, must
// agree on every legal target and accept the same move. If they ever diverge the
// setting has quietly become a rules change, and the host has no way to tell.
section('Highlights off changes nothing the engine does');
{
  seed(77);
  const on = freshGame({ players: 4 });
  seed(77);
  const off = freshGame({ players: 4, showTargets: false });

  const actor = on.currentPlayer;
  ok(off.currentPlayer.id === actor.id, 'the same seed seats the same player first');

  const a = on.privateStateFor(actor.id);
  const b = off.privateStateFor(actor.id);
  ok(a.hand.map((c) => c.code).join() === b.hand.map((c) => c.code).join(), 'the same hand is dealt');
  ok(a.hand.every((c, i) => c.targets.join() === b.hand[i].targets.join()),
    'every card still reports the same legal targets');
  ok(a.hand.every((c, i) => c.dead === b.hand[i].dead),
    'dead cards are still marked — that is a rule, not a hint');
  ok(a.canPass === b.canPass, 'pass is offered on the same terms');

  // The move the board declined to point out still plays.
  const card = b.hand.find((c) => c.targets.length);
  ok(off.playCard(actor.id, card.id, card.targets[0]).ok, 'an unhighlighted legal move is accepted');

  // It has to reach the joiners, not just the host who set it: a player whose
  // board is highlighting spaces in a game the host set up not to is playing a
  // different game from everyone else.
  ok(off.publicState().config.showTargets === false, 'every player is told the highlights are off');
  const back = new GameEngine();
  back.restore(JSON.parse(JSON.stringify(off.serialize())));
  ok(back.publicState().config.showTargets === false, 'the setting survives a host reload');
  ok(!off.setConfig({ showTargets: true }).ok, 'it cannot be switched once the game is under way');
  ok(DEFAULTS.showTargets === true, 'a host who changes nothing gets the highlights');
}

// ===========================================================================
// Every default has to BE the official game. This is the assertion that keeps a
// house rule from becoming the thing a host gets for changing nothing.
section('The defaults are the official game');
{
  const d = normalizeConfig({}, 4);
  ok(d.sequenceLength === SEQUENCE_LENGTH, 'five in a row by default');
  ok(d.sequencesToWin === 0, 'the win target follows the official table by default');
  ok(d.hardCorners === false, 'corners are free by default');
  ok(d.strictSequences === false, 'the official one-shared-chip rule by default');
  ok(d.jacksRemoveAny === false, 'one-eyed Jacks take opponents only by default');
  ok(d.memoryMode === false, 'chips can be peeked under by default');
  ok(describeHouseRules(d).length === 0, 'and nothing is announced as a house rule');
  ok(presetOf(d) === 'classic', 'which is exactly the Classic preset');

  // The tolerant readers exist because restore() rehydrates with Object.assign and
  // never re-normalises, so a game that started before these keys existed comes
  // back without them. Missing has to mean official, not falsy-and-therefore-zero.
  ok(sequenceLengthFor({}) === 5, 'a config with no length reads as five');
  ok(sequenceLengthFor(undefined) === 5, 'and so does no config at all');
  ok(sequenceLengthFor({ sequenceLength: 'nonsense' }) === 5, 'a non-numeric length falls back to five');
  ok(winTargetFor({ numTeams: 2 }) === 2, 'a pre-feature config still races to two');
  ok(winTargetFor({ numTeams: 3 }) === 1, 'and to one with three teams');
  ok(peeksAllowed({}) === true, 'a pre-feature config can still peek');
  ok(peeksAllowed(undefined) === true, 'and a missing config does not crash the board');
}

// ===========================================================================
section('House-rule normalisation');
{
  ok(normalizeConfig({ sequenceLength: '4' }, 4).sequenceLength === 4, 'a length arrives as a string over the wire');
  ok(normalizeConfig({ sequenceLength: 9 }, 4).sequenceLength === LIMITS.sequenceLength.max, 'a length above the limit clamps down');
  ok(normalizeConfig({ sequenceLength: 1 }, 4).sequenceLength === LIMITS.sequenceLength.min, 'and below it clamps up');
  // The tolerant reader and the normaliser must resolve the same input the same
  // way, or a value that skipped normalisation would play a different game from
  // the one the lobby showed.
  for (const raw of [undefined, null, 'x', 0, 1, 4, 5, 6, 9, '4']) {
    ok(sequenceLengthFor({ sequenceLength: raw }) === normalizeConfig({ sequenceLength: raw }, 4).sequenceLength,
      `sequenceLengthFor and normalizeConfig agree on ${JSON.stringify(raw)}`);
    ok(winTargetFor({ numTeams: 2, sequencesToWin: raw })
      === winTargetFor(normalizeConfig({ numTeams: 2, sequencesToWin: raw }, 4)),
      `winTargetFor is stable across normalisation for ${JSON.stringify(raw)}`);
  }
  ok(normalizeConfig({ sequencesToWin: 7 }, 4).sequencesToWin === 3, 'the win target clamps high');
  ok(normalizeConfig({ sequencesToWin: -1 }, 4).sequencesToWin === 0, 'and low, onto the auto sentinel');
  ok(normalizeConfig({ hardCorners: 'yes' }, 4).hardCorners === true, 'hardCorners coerces to boolean');
  ok(normalizeConfig({ memoryMode: 1 }, 4).memoryMode === true, 'memoryMode coerces to boolean');
  ok(RULE_KEYS.every((k) => k in normalizeConfig({}, 4)), 'every rule key survives normalisation');
  ok(!RULE_KEYS.includes('numTeams'), 'numTeams is seating, not a rule the host tunes');

  // The sentinel exists because _resyncSeating re-normalises on every join and
  // leave, so numTeams can change under an already-chosen win target. Auto has to
  // follow it; an absolute number has to be left exactly as the host set it.
  const auto = freshGame({ players: 4, start: false });
  ok(auto.sequencesToWin === 2, 'auto reads two for two teams');
  auto.addPlayer('x1', 'X1'); auto.addPlayer('x2', 'X2');
  auto.setConfig({ numTeams: 3 });
  ok(auto.config.numTeams === 3 && auto.sequencesToWin === 1, 'and follows the table to one when a third team appears');
  auto.setConfig({ sequencesToWin: 3 });
  ok(auto.sequencesToWin === 3, 'an explicit target overrides the table');
  auto.addPlayer('x3', 'X3');
  ok(auto.sequencesToWin === 3, 'and a join does not quietly rewrite it');
}

// ===========================================================================
// A preset is only useful if picking one is a complete statement of the rules.
// The trap it has to avoid: picking Quick after Hard leaving memory mode behind,
// so a table thinks it is playing Quick and is not.
section('Presets');
{
  ok(presetOf(presetConfig('classic')) === 'classic', 'Classic round-trips');
  ok(presetOf(presetConfig('quick')) === 'quick', 'Quick round-trips');
  ok(presetOf(presetConfig('hard')) === 'hard', 'Hard round-trips');
  ok(PRESETS.every((p) => RULE_KEYS.every((k) => k in presetConfig(p.id))),
    'every preset states every rule key, so none can inherit a leftover');
  ok(presetOf({ ...presetConfig('quick'), memoryMode: true }) === null,
    'tuning one switch away from a preset is Custom, not still that preset');
  ok(presetOf({ numTeams: 3 }) === 'classic', 'the team count is not part of a preset');
  ok(presetOf({}) === 'classic', 'and neither is an absent key');

  // Hard is a bundle of affordances, so it must not touch a rule.
  const hard = presetConfig('hard');
  ok(sequenceLengthFor(hard) === 5 && winTargetFor({ ...hard, numTeams: 2 }) === 2
    && !hard.hardCorners && !hard.strictSequences && !hard.jacksRemoveAny,
    'Hard changes nothing about how the game is won');

  // Picked one after another, through the engine, the way a host actually does it.
  const eng = freshGame({ players: 4, start: false });
  eng.setConfig(presetConfig('hard'));
  ok(presetOf(eng.config) === 'hard', 'the host picks Hard');
  eng.setConfig(presetConfig('quick'));
  ok(presetOf(eng.config) === 'quick' && eng.config.memoryMode === false,
    'then Quick, and Hard leaves nothing behind');
  eng.setConfig({ deadCardsPerTurn: 0 });
  ok(presetOf(eng.config) === null, 'one tweak and the row stops claiming a preset');
  eng.setConfig(presetConfig('classic'));
  ok(presetOf(eng.config) === 'classic' && eng.config.deadCardsPerTurn === 1,
    'and Classic puts everything back');
}

// ===========================================================================
section('Sequence length is a house rule');
{
  const chips = new Array(CELL_COUNT).fill(null);
  for (const cell of [51, 52, 53, 54]) chips[cell] = 0;
  ok(newSequencesAt(54, 0, chips, []).length === 0, 'four in a row is nothing by default');
  ok(newSequencesAt(54, 0, chips, [], { sequenceLength: 4 }).length === 1, 'and a sequence at length 4');
  chips[55] = 0;
  ok(newSequencesAt(55, 0, chips, []).length === 1, 'five still wins by default');
  ok(newSequencesAt(55, 0, chips, [], { sequenceLength: 6 }).length === 0, 'but not at length 6');
  chips[56] = 0;
  ok(newSequencesAt(56, 0, chips, [], { sequenceLength: 6 }).length === 1, 'six does');

  ok(windowsThrough(44).length === windowsThrough(44, 5).length, 'the default window length is still five');
  ok(windowsThrough(44, 4).every((w) => w.length === 4), 'length 4 gives 4-cell windows');
  ok(windowsThrough(44, 6).every((w) => w.length === 6), 'length 6 gives 6-cell windows');
  ok(windowsThrough(44, 0).length === windowsThrough(44).length, 'a nonsense length falls back rather than returning nothing');

  // Through the engine: a real four-in-a-row has to actually end the game.
  const eng = freshGame({ players: 2, sequenceLength: 4, sequencesToWin: 1, hardCorners: true });
  const me = eng.currentPlayer;
  for (const cell of [51, 52, 53]) eng.chips[cell] = me.team;
  setTurnTo(eng, me.id);
  ok(coverCell(eng, me.id, 54).ok, 'the fourth chip goes down');
  ok(eng.sequences.length === 1 && eng.sequences[0].cells.length === 4, 'and completes a four-cell sequence');
  ok(eng.phase === PHASES.GAME_OVER && eng.winner === me.team, 'which wins the game at one sequence');
}

// ===========================================================================
// Free corners and a shortened line together make a sequence very cheap, which is
// the whole reason hardCorners exists as a companion to it.
section('Hard corners');
{
  const chips = new Array(CELL_COUNT).fill(null);
  for (const cell of [1, 2, 3, 4]) chips[cell] = 0;
  ok(newSequencesAt(4, 0, chips, []).length === 1, 'a free corner completes a line with only four chips');
  ok(newSequencesAt(4, 0, chips, [], { hardCorners: true }).length === 0, 'a hard corner does not count for anyone');
  chips[0] = 0;
  ok(newSequencesAt(0, 0, chips, [], { hardCorners: true }).length === 1, 'until a chip is actually on it');

  // A corner has no card printed on it, so if it is not free the only card that can
  // ever reach one is a wild. Otherwise every line through a corner is unwinnable.
  const layout = CLASSIC_LAYOUT.slice();
  const view = (config, ch = new Array(CELL_COUNT).fill(null)) => ({
    layout, cellIndex: buildCellIndex(layout), chips: ch, sequences: [], team: 0, config,
  });
  const soft = legalTargets('JD', view({}));
  ok(soft.length === 96 && !soft.some(isCorner), 'a wild ignores free corners — covering one would waste the card');
  const hard = legalTargets('JD', view({ hardCorners: true }));
  ok(hard.length === CELL_COUNT && CORNERS.every((c) => hard.includes(c)),
    'and can cover all four when they are not free');

  // Sharing: a free corner is a space, so it may be reused by both of a team's
  // sequences. A hard corner is a chip, so it counts against the allowance.
  const seq = [{ team: 0, cells: [0, 1, 2, 3, 4] }];
  ok(claimedCellsFor(seq, 0).has(0) === false, 'a free corner is not one of the team\'s chips');
  ok(claimedCellsFor(seq, 0, true).has(0) === true, 'a hard corner is');

  // End to end, including the label the host sends back for a refused tap.
  const eng = freshGame({ players: 2, hardCorners: true });
  const me = eng.currentPlayer;
  setTurnTo(eng, me.id);
  const wild = giveHand(eng, me.id, ['JD']);
  ok(eng.playCard(me.id, wild[0].id, CORNERS[0]).ok, 'a wild covers a corner in play');
  ok(eng.chips[CORNERS[0]] === me.team, 'and the chip is really there');
  setTurnTo(eng, me.id);
  const plain = giveHand(eng, me.id, [eng.layout[55]]);
  const refused = eng.playCard(me.id, plain[0].id, CORNERS[1]);
  ok(!refused.ok && /only a wild Jack/.test(refused.error),
    'a numbered card is told why the corner refused it, in this game\'s terms');

  // And a corner chip is an ordinary chip: liftable, unless the line locked it.
  const jack = legalTargets('JS', {
    ...view({ hardCorners: true }, eng.chips), team: 1,
  });
  ok(jack.includes(CORNERS[0]), 'an opponent can lift a chip off a hard corner');
}

// ===========================================================================
section('Strict sequences');
{
  const chips = new Array(CELL_COUNT).fill(null);
  for (let cell = 50; cell <= 58; cell++) chips[cell] = 0;
  const first = [{ team: 0, cells: [50, 51, 52, 53, 54] }];
  ok(newSequencesAt(58, 0, chips, first).length === 1, 'the official rule allows one shared chip');
  ok(newSequencesAt(58, 0, chips, first, { strictSequences: true }).length === 0, 'strict allows none');

  // Disjoint lines are still fine under strict — it removes the overlap, not the
  // second sequence.
  const wide = new Array(CELL_COUNT).fill(null);
  for (let cell = 50; cell <= 54; cell++) wide[cell] = 0;
  for (let cell = 60; cell <= 64; cell++) wide[cell] = 0;
  ok(newSequencesAt(64, 0, wide, first, { strictSequences: true }).length === 1,
    'a second sequence sharing nothing is still a sequence');

  const eng = freshGame({ players: 2, strictSequences: true });
  const me = eng.currentPlayer;
  for (let cell = 50; cell <= 57; cell++) eng.chips[cell] = me.team;
  eng.sequences.push({ team: me.team, cells: [50, 51, 52, 53, 54] });
  setTurnTo(eng, me.id);
  ok(coverCell(eng, me.id, 58).ok, 'in play, the chip completing the overlapping line goes down');
  ok(eng.sequences.length === 1, 'but no second sequence is credited');
  ok(eng.phase === PHASES.PLAY, 'so the game is not over');
}

// ===========================================================================
section('Cutthroat Jacks');
{
  const chips = new Array(CELL_COUNT).fill(null);
  chips[44] = 0;   // mine
  chips[45] = 1;   // theirs
  const layout = CLASSIC_LAYOUT.slice();
  const view = (config, sequences = []) => ({
    layout, cellIndex: buildCellIndex(layout), chips, sequences, team: 0, config,
  });
  ok(legalTargets('JS', view({})).join() === '45', 'officially a one-eyed Jack sees opponents only');
  const any = legalTargets('JS', view({ jacksRemoveAny: true }));
  ok(any.includes(44) && any.includes(45), 'cutthroat sees its own team\'s chip too');

  // The lock survives, or the ✦ marker would be a lie.
  const locked = legalTargets('JS', view({ jacksRemoveAny: true }, [{ team: 0, cells: [40, 41, 42, 43, 44] }]));
  ok(!locked.includes(44), 'but never a chip inside a completed sequence');

  const eng = freshGame({ players: 2, jacksRemoveAny: true });
  const me = eng.currentPlayer;
  eng.chips[44] = me.team;
  setTurnTo(eng, me.id);
  const jack = giveHand(eng, me.id, ['JS']);
  const res = eng.playCard(me.id, jack[0].id, 44);
  ok(res.ok && eng.chips[44] === null, 'and it really lifts your own chip in play');

  // The refusal has to describe the game being played, not the printed rule. It
  // needs an opponent chip on the board as well, or there would be no legal target
  // at all and the earlier "nothing can be removed" branch would answer instead.
  const strict = freshGame({ players: 2 });
  const actor = strict.currentPlayer;
  strict.chips[44] = actor.team;
  strict.chips[45] = actor.team === 0 ? 1 : 0;
  setTurnTo(strict, actor.id);
  const j2 = giveHand(strict, actor.id, ['JS']);
  const no = strict.playCard(actor.id, j2[0].id, 44);
  ok(!no.ok && /your own team/.test(no.error), 'without the rule, taking your own chip says exactly that');
  ok(strict.playCard(actor.id, j2[0].id, 45).ok, 'while the opponent chip beside it lifts fine');
}

// ===========================================================================
// Memory mode is presentational, and gets the same treatment the highlights got:
// asserted against the engine rather than described in a comment.
section('Memory mode changes nothing the engine does');
{
  seed(91);
  const open = freshGame({ players: 4 });
  seed(91);
  const blind = freshGame({ players: 4, memoryMode: true });
  const actor = open.currentPlayer;
  ok(blind.currentPlayer.id === actor.id, 'the same seed seats the same player first');
  const a = open.privateStateFor(actor.id);
  const b = blind.privateStateFor(actor.id);
  ok(a.hand.map((c) => c.code).join() === b.hand.map((c) => c.code).join(), 'the same hand is dealt');
  ok(a.hand.every((c, i) => c.targets.join() === b.hand[i].targets.join()), 'with the same legal targets');
  ok(a.hand.every((c, i) => c.dead === b.hand[i].dead),
    'and the same dead marks — knowing a card is dead is a rule, not a peek');
  ok(a.canPass === b.canPass, 'pass is offered on the same terms');
  ok(blind.publicState().config.memoryMode === true, 'every player is told chips stay hidden');
  ok(!peeksAllowed(blind.publicState().config), 'so no device offers a peek');
}

// ===========================================================================
// A snapshot is what a host reload rebuilds from, and restore() does a plain
// Object.assign — so anything the host chose has to be inside serialize(), or a
// reload silently drops the table back to the official game mid-play.
section('House rules survive a host reload');
{
  const custom = {
    sequenceLength: 6, sequencesToWin: 3, hardCorners: true,
    strictSequences: true, jacksRemoveAny: true, memoryMode: true,
    shuffleBoard: true, showTargets: false, deadCardsPerTurn: 0,
  };
  const eng = freshGame({ players: 4, ...custom });
  ok(presetOf(eng.config) === null, 'this is a Custom mix, not a preset');
  const back = new GameEngine();
  back.restore(JSON.parse(JSON.stringify(eng.serialize())));
  for (const key of RULE_KEYS) {
    ok(back.config[key] === eng.config[key], `${key} survives the reload`);
  }
  ok(back.sequencesToWin === 3, 'and the win target comes back with it');
  ok(sequenceLengthFor(back.config) === 6, 'as does the line length');

  // The house rules are broadcast, not just held by the host: a joiner reading its
  // own config is the only way its board can draw the right game.
  const pub = eng.publicState();
  ok(RULE_KEYS.every((key) => pub.config[key] === eng.config[key]), 'every rule reaches the joiners');
  ok(describeHouseRules(pub.config).length >= 6, 'and the lobby has something to list for each');
  ok(eng.log.some((l) => /House rules:/.test(l.text)), 'the move log names them when the game starts');
  ok(!freshGame({ players: 4 }).log.some((l) => /House rules:/.test(l.text)),
    'and says nothing at all for an official game');
}

// ===========================================================================
// Names arrive over the wire from a peer we do not control, and cleanName runs
// inside the host's connection callback — so a non-string has to come back as a
// value, not as a thrown TypeError that would take the host's tab down with it.
section('Hostile input from the wire');
{
  for (const junk of [5, null, undefined, {}, [], true, () => {}]) {
    ok(cleanName(junk) === '', `cleanName(${typeof junk}) is empty, not a throw`);
  }

  const eng = new GameEngine();
  eng.addPlayer('host', 'Host', { isHost: true });
  ok(!eng.addPlayer('junk', 42).ok, 'a numeric name is rejected, not accepted as "42"');
  ok(!eng.addPlayer('junk', { name: 'x' }).ok, 'an object name is rejected');
  ok(!eng.addPlayer('junk', null).ok, 'a null name is rejected');
  ok(eng.players.length === 1, 'none of the junk names took a seat');
}

// ===========================================================================
section('Lobby — seating, teams and gates');
{
  const eng = freshGame({ players: 4, start: false });
  ok(eng.phase === PHASES.LOBBY, 'starts in the lobby');
  ok(eng.players.map((p) => p.team).join() === '0,1,0,1', 'teams alternate around the table');
  ok(eng.players[0].team === eng.players[2].team, 'seats 1 and 3 are teammates');

  ok(!eng.addPlayer('dupe', 'host').ok, 'a name already in use is rejected');
  ok(!eng.addPlayer('x', '   ').ok, 'a blank name is rejected');

  const before = eng.players.map((p) => p.id).join();
  ok(eng.movePlayer('p2', -1).ok, 'host can move a player up a seat');
  ok(eng.players.map((p) => p.id).join() !== before, 'the seat order changed');
  ok(eng.players.map((p) => p.team).join() === '0,1,0,1', 'teams still alternate after a move');
  ok(!eng.movePlayer(eng.players[0].id, -1).ok, 'cannot move above the first seat');
  ok(!eng.movePlayer(eng.players[3].id, 1).ok, 'cannot move below the last seat');

  ok(eng.randomizeOrder().ok, 'host can shuffle the seats');
  ok(eng.players.length === 4, 'shuffling keeps everyone seated');

  ok(!eng.startGame('p1').ok, 'only the host may start');
  ok(eng.publicState().startCheck.ok, 'a 4-player table is ready to start');

  // Dropping out of the lobby releases the seat, so the count can still divide.
  eng.markOffline('p3');
  ok(eng.players.length === 3, 'a lobby disconnect releases the seat');
  ok(eng.config.numTeams === 3, '3 players re-clamp to 3 teams');
  ok(eng.publicState().startCheck.ok, '3 players / 3 teams is startable');
}

{
  const eng = new GameEngine();
  eng.addPlayer('host', 'Host', { isHost: true });
  for (let i = 1; i < MAX_PLAYERS; i++) eng.addPlayer('p' + i, 'Player' + i);
  ok(eng.players.length === MAX_PLAYERS, 'twelve players fit');
  ok(!eng.addPlayer('extra', 'Extra').ok, 'a thirteenth player is turned away');
}

// ===========================================================================
section('Dealing');
{
  const eng = freshGame({ players: 4 });
  ok(eng.phase === PHASES.PLAY, 'the game is under way');
  ok(eng.handSize === 6, '4 players hold 6 cards');
  ok(eng.players.every((p) => eng.hands[p.id].length === 6), 'everyone was dealt a full hand');
  const dealt = eng.players.reduce((n, p) => n + eng.hands[p.id].length, 0);
  ok(eng.deck.length === 104 - dealt, 'the deck is short exactly what was dealt');
  ok(eng.chips.every((c) => c === null), 'the board starts empty');
  ok(eng.sequences.length === 0, 'no sequences yet');
  ok(!eng.setConfig({ numTeams: 3 }).ok, 'settings lock once the game starts');
  ok(!eng.addPlayer('late', 'Latecomer').ok, 'nobody joins a game in progress');

  const ids = eng.players.flatMap((p) => eng.hands[p.id].map((c) => c.id));
  ok(new Set(ids).size === ids.length, 'no card was dealt to two players');
}

{
  const eng = freshGame({ players: 2 });
  ok(eng.handSize === 7, '2 players hold 7 cards');
  const eng6 = freshGame({ players: 6, numTeams: 3 });
  ok(eng6.handSize === 5 && eng6.sequencesToWin === 1, '6 players in 3 teams: 5 cards, 1 sequence to win');
}

// ===========================================================================
section('Playing a plain card');
{
  const eng = freshGame({ players: 4 });
  const actor = eng.currentPlayer;
  const other = eng.players.find((p) => p.id !== actor.id);
  const cell = eng.cellIndex.get(eng.layout[45])[0];
  const cards = giveHand(eng, actor.id, [eng.layout[cell]]);

  ok(!eng.playCard(other.id, cards[0].id, cell).ok, 'off-turn play is refused');
  ok(!eng.playCard(actor.id, 'no-such-card', cell).ok, 'a card not in hand is refused');
  ok(!eng.playCard(actor.id, cards[0].id, null).ok, 'a move needs a cell');

  const wrongCell = eng.layout.findIndex((code, i) => code !== FREE && code !== eng.layout[cell] && i !== cell);
  ok(!eng.playCard(actor.id, cards[0].id, wrongCell).ok, 'a card cannot cover a space it does not match');
  ok(!eng.playCard(actor.id, cards[0].id, CORNERS[0]).ok, 'a plain card cannot cover a free corner');

  const res = eng.playCard(actor.id, cards[0].id, cell);
  ok(res.ok, 'a matching space is covered');
  ok(eng.chips[cell] === actor.team, "the chip belongs to the player's team");
  ok(eng.hands[actor.id].length === 1, 'the played card was replaced from the deck');
  ok(eng.hands[actor.id][0].id !== cards[0].id, 'the replacement is a different card');
  ok(eng.discards.length === 1 && eng.discards[0].code === cards[0].code, 'the card went to the discards');
  ok(eng.currentPlayer.id !== actor.id, 'the turn passed on');
  ok(eng.lastMove.action === 'place' && eng.lastMove.cell === cell, 'the move was recorded');

  // The other printed copy of the same card is still open.
  const twin = eng.cellIndex.get(eng.layout[cell]).find((c) => c !== cell);
  ok(eng.chips[twin] === null, "covering one copy leaves the card's other space open");
}

// ===========================================================================
section('Two-eyed Jacks are wild');
{
  const eng = freshGame({ players: 4 });
  const actor = eng.currentPlayer;
  const cards = giveHand(eng, actor.id, ['JD']);
  const board = eng._boardView(actor.team);
  let targets = legalTargets('JD', board);

  ok(targets.length === 96, 'a wild can go on any of the 96 card spaces');
  ok(!targets.some(isCorner), 'a wild is never played on a free corner');
  ok(!isDeadCard('JD', board), 'a wild is never a dead card');

  ok(!eng.playCard(actor.id, cards[0].id, CORNERS[1]).ok, 'a wild cannot cover a corner');
  ok(eng.playCard(actor.id, cards[0].id, 55).ok, 'a wild covers an arbitrary open space');
  ok(eng.chips[55] === actor.team, 'the wild chip landed');
  ok(eng.lastMove.action === 'wild', 'the move was logged as a wild');

  targets = legalTargets('JD', eng._boardView(actor.team));
  ok(targets.length === 95 && !targets.includes(55), 'an occupied space is no longer a wild target');
}

// ===========================================================================
section('One-eyed Jacks remove');
{
  const eng = freshGame({ players: 4 });
  // Seats 0 and 2 are team 0; seats 1 and 3 are team 1.
  const mine = eng.players[0], theirs = eng.players[1];
  eng.chips[33] = mine.team;      // an opponent chip, from the remover's view
  eng.chips[34] = theirs.team;    // the remover's own chip

  setTurnTo(eng, theirs.id);
  const cards = giveHand(eng, theirs.id, ['JS']);
  let targets = legalTargets('JS', eng._boardView(theirs.team));
  ok(targets.includes(33), 'an opponent chip can be removed');
  ok(!targets.includes(34), 'your own chip cannot be removed');
  ok(!targets.includes(50), 'an empty space is not a removal target');
  ok(!isDeadCard('JS', eng._boardView(theirs.team)), 'a one-eyed Jack is never a dead card');

  ok(!eng.playCard(theirs.id, cards[0].id, 34).ok, 'removing your own chip is refused');
  ok(!eng.playCard(theirs.id, cards[0].id, 50).ok, 'removing from an empty space is refused');
  ok(eng.playCard(theirs.id, cards[0].id, 33).ok, 'the opponent chip comes off');
  ok(eng.chips[33] === null, 'the space is open again');
  ok(eng.lastMove.action === 'remove', 'the move was logged as a removal');

  // With nothing of the opponent's on the board, the Jack has nowhere to go.
  eng.chips[34] = null;
  setTurnTo(eng, theirs.id);
  const only = giveHand(eng, theirs.id, ['JS', 'JH']);
  ok(legalTargets('JS', eng._boardView(theirs.team)).length === 0, 'no opponent chip, no removal');
  ok(!eng.playCard(theirs.id, only[0].id, 33).ok, 'the Jack cannot be played into thin air');
  ok(eng.canPass(theirs.id), 'a hand of unplayable one-eyed Jacks may pass');
  ok(eng.pass(theirs.id).ok, 'the pass goes through');
  ok(eng.currentPlayer.id !== theirs.id, 'passing moves the turn along');
}

// ===========================================================================
section('Sequences — corners, and the shared-chip rule');
{
  // Row 0 through the free corner at cell 0: four chips plus the corner.
  const chips = new Array(CELL_COUNT).fill(null);
  chips[1] = chips[2] = chips[3] = 0;
  ok(newSequencesAt(3, 0, chips, []).length === 0, 'four cells (corner + 3 chips) is not yet a sequence');
  chips[4] = 0;
  const first = newSequencesAt(4, 0, chips, []);
  ok(first.length === 1, 'a line through a free corner needs only four chips');
  ok(first[0].join() === '0,1,2,3,4', 'the sequence includes the corner');

  const sequences = [{ team: 0, cells: first[0] }];

  // A sixth chip in the same row shares four chips with the finished line.
  const six = chips.slice();
  six[5] = 0;
  ok(newSequencesAt(5, 0, six, sequences).length === 0,
    'a six-in-a-row does not yield a second sequence');

  // A crossing line reuses exactly one chip from the finished sequence.
  const cross = chips.slice();
  cross[14] = cross[24] = cross[34] = cross[44] = 0;
  const second = newSequencesAt(44, 0, cross, sequences);
  ok(second.length === 1, 'a new sequence may reuse one chip from a completed one');
  ok(second[0].join() === '4,14,24,34,44', 'the crossing column is the new sequence');

  // Two shared chips is one too many.
  const greedy = chips.slice();
  greedy[13] = greedy[22] = greedy[31] = 0;   // diagonal 4,13,22,31,40
  greedy[40] = 0;
  const overlap = newSequencesAt(40, 0, greedy, [{ team: 0, cells: [0, 1, 2, 3, 4] }, { team: 0, cells: [4, 13, 22, 31, 40] }]);
  ok(overlap.length === 0, 'a line already claimed is not counted twice');

  // One chip can complete two fresh lines at once.
  const both = new Array(CELL_COUNT).fill(null);
  for (const c of [51, 52, 53, 54]) both[c] = 1;
  for (const c of [15, 25, 35, 45]) both[c] = 1;
  both[55] = 1;
  const double = newSequencesAt(55, 1, both, []);
  ok(double.length === 2, 'a single chip can complete two sequences at once');
  ok(double.every((cells) => cells.includes(55)), 'both sequences run through the new chip');

  // A line of somebody else's chips is not yours.
  const mixed = new Array(CELL_COUNT).fill(null);
  for (const c of [1, 2, 3, 4]) mixed[c] = 1;
  ok(newSequencesAt(4, 0, mixed, []).length === 0, "an opponent's line is not your sequence");
}

// ===========================================================================
section('Chips in a completed sequence are locked');
{
  const eng = freshGame({ players: 4 });
  const mine = eng.players[0], theirs = eng.players[1];
  eng.chips[1] = eng.chips[2] = eng.chips[3] = mine.team;
  eng.chips[50] = mine.team;                      // a loose chip, outside any line

  setTurnTo(eng, mine.id);
  ok(coverCell(eng, mine.id, 4).ok, 'the fourth chip completes a sequence through the corner');
  ok(eng.sequences.length === 1, 'the sequence was recorded');
  ok(eng.sequences[0].team === mine.team, 'the sequence belongs to the right team');

  setTurnTo(eng, theirs.id);
  const jack = giveHand(eng, theirs.id, ['JH']);
  const targets = legalTargets('JH', eng._boardView(theirs.team));
  ok(!targets.includes(2), 'a chip inside a completed sequence cannot be removed');
  ok(targets.includes(50), 'a chip outside any sequence can still be removed');
  ok(!eng.playCard(theirs.id, jack[0].id, 2).ok, 'removing a locked chip is refused');
  ok(eng.chips[2] === mine.team, 'the locked chip is untouched');
  ok(eng.playCard(theirs.id, jack[0].id, 50).ok, 'the loose chip comes off');
}

// ===========================================================================
section('Dead cards');
{
  const eng = freshGame({ players: 4 });
  const actor = eng.currentPlayer;
  // Bury both printed copies of two different cards under opponents' chips.
  const dead = ['AS', 'KS'];
  for (const code of dead) for (const cell of eng.cellIndex.get(code)) eng.chips[cell] = 1;

  const board = eng._boardView(actor.team);
  ok(dead.every((code) => isDeadCard(code, board)), 'a card with both spaces covered is dead');
  ok(dead.every((code) => legalTargets(code, board).length === 0), 'a dead card has no legal target');

  const live = eng.layout.find((code) => code !== FREE && !dead.includes(code));
  ok(!isDeadCard(live, board), 'a card with an open space is not dead');

  const cards = giveHand(eng, actor.id, [dead[0], dead[1], live]);
  ok(!eng.exchangeDeadCard(actor.id, cards[2].id).ok, 'a live card cannot be swapped');
  ok(eng.exchangeDeadCard(actor.id, cards[0].id).ok, 'a dead card is swapped for a fresh one');
  ok(eng.deadUsed === 1, 'the swap was counted');
  ok(eng.currentPlayer.id === actor.id, 'swapping does not end your turn');
  ok(eng.hands[actor.id].length === 3, 'the hand is back to size');
  ok(!eng.exchangeDeadCard(actor.id, cards[1].id).ok, 'only one swap per turn by default');

  // Playing on ends the turn and resets the allowance.
  eng.hands[actor.id] = [cards[1]];
  setTurnTo(eng, actor.id);
  ok(eng.deadUsed === 0, 'a new turn restores the swap allowance');
  ok(eng.exchangeDeadCard(actor.id, cards[1].id).ok, 'the second dead card can go next turn');
}

{
  const eng = freshGame({ players: 4, deadCardsPerTurn: 0 });
  const actor = eng.currentPlayer;
  for (const cell of eng.cellIndex.get('AS')) eng.chips[cell] = 1;
  const cards = giveHand(eng, actor.id, ['AS']);
  ok(eng.config.deadCardsPerTurn === 0, 'the host can switch swapping off');
  ok(!eng.exchangeDeadCard(actor.id, cards[0].id).ok, 'no swap is allowed when the rule is off');
  ok(!eng.hasDeadCardSwap(actor.id), 'the engine reports no swap available');
  ok(eng.canPass(actor.id), 'a hand of dead cards may pass when swapping is off');
}

// ===========================================================================
section('Pass is only offered when there is nothing to do');
{
  const eng = freshGame({ players: 4 });
  const actor = eng.currentPlayer;
  giveHand(eng, actor.id, [eng.layout[45]]);
  ok(eng.hasLegalMove(actor.id), 'a playable card is a legal move');
  ok(!eng.canPass(actor.id), 'you cannot pass with a legal move in hand');
  ok(!eng.pass(actor.id).ok, 'the pass is refused');
  const other = eng.players.find((p) => p.id !== actor.id);
  ok(!eng.pass(other.id).ok, "you cannot pass on somebody else's turn");
}

// ===========================================================================
section('Winning');
{
  // Two teams: two sequences takes the game.
  const eng = freshGame({ players: 4, numTeams: 2 });
  const mine = eng.players[0];
  ok(eng.sequencesToWin === 2, 'two teams need two sequences');

  eng.chips[1] = eng.chips[2] = eng.chips[3] = mine.team;
  setTurnTo(eng, mine.id);
  ok(coverCell(eng, mine.id, 4).ok, 'the first sequence lands');
  ok(eng.phase === PHASES.PLAY, 'one sequence does not end the game');
  ok(eng.publicState().seqCounts[mine.team] === 1, 'the scoreboard shows one sequence');

  eng.chips[14] = eng.chips[24] = eng.chips[34] = mine.team;
  setTurnTo(eng, mine.id);
  ok(coverCell(eng, mine.id, 44).ok, 'the second sequence lands');
  ok(eng.phase === PHASES.GAME_OVER, 'two sequences end the game');
  ok(eng.winner === mine.team, 'the right team won');
  ok(eng.sequences.length === 2, 'both sequences are on record');
  ok(!eng.playCard(eng.players[1].id, 'anything', 60).ok, 'no more moves after the win');

  ok(eng.playAgain('host').ok, 'the host can call a rematch');
  ok(eng.phase === PHASES.LOBBY, 'a rematch returns to the lobby');
  ok(eng.chips.every((c) => c === null) && eng.sequences.length === 0, 'the board was cleared');
  ok(Object.keys(eng.hands).length === 0, 'hands were cleared');
  eng.startGame('host');
  ok(eng.turn === 1, 'the rematch is led by the next seat along');
}

{
  // Three teams: one sequence takes the game.
  const eng = freshGame({ players: 6, numTeams: 3 });
  const mine = eng.players[0];
  ok(eng.sequencesToWin === 1, 'three teams need one sequence');
  eng.chips[1] = eng.chips[2] = eng.chips[3] = mine.team;
  setTurnTo(eng, mine.id);
  ok(coverCell(eng, mine.id, 4).ok, 'the sequence lands');
  ok(eng.phase === PHASES.GAME_OVER && eng.winner === mine.team, 'one sequence wins a three-team game');
}

// ===========================================================================
section('Host overrides');
{
  const eng = freshGame({ players: 4 });
  const first = eng.currentPlayer.id;
  ok(!eng.skipTurn('p1').ok, 'only the host can skip a turn');
  ok(eng.skipTurn('host').ok, 'the host can skip a stalled player');
  ok(eng.currentPlayer.id !== first, 'the turn moved on');

  ok(!eng.endGame('p2').ok, 'only the host can end the game');
  ok(eng.endGame('host').ok, 'the host can end the game');
  ok(eng.phase === PHASES.GAME_OVER && eng.winner === null, 'an abandoned game has no winner');
  ok(!eng.skipTurn('host').ok, 'nothing to skip once the game is over');
}

// ===========================================================================
section('Hand privacy');
{
  const eng = freshGame({ players: 4 });
  const pub = eng.publicState();
  const serialised = JSON.stringify(pub);
  ok(!('hands' in pub) && !('deck' in pub) && !('discards' in pub),
    'the public state carries no hands, deck or discards');
  ok(pub.players.every((p) => p.handCount === 6 && !('hand' in p)),
    'players expose only how many cards they hold');
  const someoneElsesCard = eng.hands.p1[0].id;
  ok(!serialised.includes(someoneElsesCard), "no other player's card id is in the public state");
  ok(typeof pub.deckCount === 'number' && pub.deckCount === eng.deck.length, 'the deck is a count only');

  const priv = eng.privateStateFor('p1');
  ok(priv.hand.length === 6 && priv.playerId === 'p1', 'a player sees their own six cards');
  ok(priv.team === eng.getPlayer('p1').team, 'the private slice carries their team');
  ok(eng.privateStateFor('nobody') === null, 'a stranger gets nothing');

  // The targets shipped to the view are the same set the engine will accept.
  const board = eng._boardView(priv.team);
  ok(priv.hand.every((c) => c.targets.join() === legalTargets(c.code, board).join()),
    'the highlighted targets are exactly the engine\'s legal targets');
  ok(priv.hand.every((c) => c.dead === isDeadCard(c.code, board)), 'dead flags match the rules');
  ok(priv.isTurn === (eng.currentPlayer.id === 'p1'), 'the turn flag is right');
}

// ===========================================================================
section('Reconnect');
{
  const eng = freshGame({ players: 4 });
  const handBefore = eng.hands.p1.map((c) => c.id).join();
  eng.markOffline('p1');
  ok(eng.players.length === 4, 'a mid-game disconnect keeps the seat');
  ok(eng.getPlayer('p1').online === false, 'the player is marked away');
  ok(eng.hands.p1.length === 6, 'their hand is held for them');

  const res = eng.addPlayer('p1-new-conn', 'player1', { clientId: 'c1' });
  ok(res.ok && res.reconnected, 'rejoining with the same name reclaims the seat');
  ok(res.prevId === 'p1', 'the old connection id was reported');
  ok(eng.players.length === 4, 'no extra seat was created');
  ok(eng.getPlayer('p1-new-conn').online === true, 'the player is back online');
  ok(!eng.hands.p1, 'the hand no longer sits under the stale id');
  ok(eng.hands['p1-new-conn'].map((c) => c.id).join() === handBefore, 'they got their own cards back');
  ok(eng.privateStateFor('p1-new-conn').hand.length === 6, 'the private slice follows the new id');

  // A name in use by someone still connected cannot be taken.
  ok(!eng.addPlayer('impostor', 'Player2').ok, 'an online name cannot be claimed');

  // The host can reconnect too, and keeps host rights.
  eng.markOffline('host');
  const hostBack = eng.addPlayer('host-new', 'Host', { isHost: true });
  ok(hostBack.ok && hostBack.reconnected, 'the host reclaims their seat');
  ok(eng.hostId === 'host-new', 'host rights moved to the new connection');
  ok(eng.skipTurn('host-new').ok, 'the reconnected host can still act as host');
}

// ===========================================================================
section('Seat ownership — a display name is not a credential');
{
  // A game as the transports now build one: every seat bound to the secret
  // clientId of the device sitting in it. The seats in freshGame() deliberately
  // have none, so the tests above cover the other half of this rule — a seat from
  // an older snapshot, which must not be locked out of its own game.
  const owned = () => {
    const eng = new GameEngine();
    eng.addPlayer('host', 'Host', { isHost: true, clientId: 'host-device' });
    eng.addPlayer('p1', 'Alice', { clientId: 'alice-device' });
    eng.addPlayer('p2', 'Bob', { clientId: 'bob-device' });
    eng.addPlayer('p3', 'Carol', { clientId: 'carol-device' });
    eng.setConfig({ numTeams: 2, deadCardsPerTurn: 1, shuffleBoard: false, showTargets: true });
    eng.startGame('host');
    return eng;
  };

  // The attack this closes: Alice's phone sleeps, and someone holding the
  // four-character code types her name and is dealt her hand.
  {
    const eng = owned();
    const hand = eng.hands.p1.map((c) => c.id).join();
    eng.markOffline('p1');

    ok(!eng.addPlayer('intruder', 'Alice').ok,
      'mid-game, a name with no clientId cannot reclaim a seat');
    ok(!eng.addPlayer('intruder', 'Alice', { clientId: 'intruder-device' }).ok,
      'mid-game, the wrong clientId cannot reclaim a seat');
    ok(!eng.addPlayer('intruder', 'alice', { clientId: 'intruder-device' }).ok,
      'and case-folding the name does not get around it');
    ok(eng.getPlayer('p1').online === false, 'the refused attempts left the seat away');
    ok(eng.hands.p1.map((c) => c.id).join() === hand, 'and left the hand where it was');
    ok(!eng.hands.intruder, 'the intruder was never dealt anything');
    ok(eng.players.length === 4, 'and never took a seat');

    const right = eng.addPlayer('p1-again', 'Alice', { clientId: 'alice-device' });
    ok(right.ok && right.reconnected, 'the owning device still gets the seat back');
    ok(eng.hands['p1-again'].map((c) => c.id).join() === hand, 'with its own cards');
  }

  // An online seat is not up for grabs whatever you know about it.
  {
    const eng = owned();
    ok(!eng.addPlayer('intruder', 'Alice', { clientId: 'alice-device' }).ok,
      'a seat whose player is connected cannot be taken over');
  }

  // Identity is the device, so the name on it may change.
  {
    const eng = owned();
    eng.markOffline('p1');
    const r = eng.addPlayer('p1-again', 'Alicia', { clientId: 'alice-device' });
    ok(r.ok && r.reconnected, 'the owning device may come back under a new name');
    ok(eng.getPlayer('p1-again').name === 'Alicia', 'and the table shows the name in use');
    ok(eng.players.length === 4, 'still no extra seat');
  }

  // ...but not to one somebody else is using.
  {
    const eng = owned();
    eng.markOffline('p1');
    const r = eng.addPlayer('p1-again', 'Bob', { clientId: 'alice-device' });
    ok(r.ok, 'the seat comes back');
    ok(eng.getPlayer('p1-again').name === 'Alice', 'under its old name, not a taken one');
    ok(eng.players.filter((p) => p.name === 'Bob').length === 1, 'so there is still one Bob');
  }

  // A seat with no owner recorded binds the first device that claims it, and is
  // owned from then on.
  {
    const eng = owned();
    delete eng.getPlayer('p1').clientId;
    eng.markOffline('p1');

    const first = eng.addPlayer('p1-again', 'Alice', { clientId: 'alice-new-device' });
    ok(first.ok, 'an unowned seat accepts a reclaim by name');
    ok(eng.getPlayer('p1-again').clientId === 'alice-new-device', 'and binds that device to it');

    eng.markOffline('p1-again');
    ok(!eng.addPlayer('intruder', 'Alice', { clientId: 'someone-else' }).ok,
      'after which the name alone stops working');
  }

  // The lobby is exempt: there are no hands to steal yet, and a device that has
  // lost its clientId must still be able to get back in before the deal.
  {
    const eng = new GameEngine();
    eng.addPlayer('host', 'Host', { isHost: true, clientId: 'host-device' });
    eng.addPlayer('p1', 'Alice', { clientId: 'alice-device' });
    eng.getPlayer('p1').online = false;   // a dropout the lobby has not swept yet
    const back = eng.addPlayer('p1-new', 'Alice', { clientId: 'alice-fresh-browser' });
    ok(back.ok && back.reconnected, 'in the lobby a name reclaim still works');
    ok(eng.getPlayer('p1-new').clientId === 'alice-fresh-browser', 'and rebinds the seat');
  }
}

// ===========================================================================
section('Peer frames are bounded before they are believed');
{
  ok(decodePeerFrame('{"type":"pass"}').type === 'pass', 'a normal frame parses');
  ok(decodePeerFrame('not json at all') === null, 'junk text is refused');
  ok(decodePeerFrame('[1,2,3]') === null, 'an array is not a message');
  ok(decodePeerFrame('{"nope":1}') === null, 'an object with no type is not a message');
  ok(decodePeerFrame('null') === null, 'JSON null is not a message');
  ok(decodePeerFrame(JSON.stringify({ type: 'x'.repeat(MAX_TYPE_LEN + 1) })) === null,
    'an absurdly long type is refused');
  ok(decodePeerFrame(`{"type":"pass","pad":"${'x'.repeat(MAX_FRAME_BYTES)}"}`) === null,
    'an oversized frame is refused on its length, before being parsed');
  ok(decodePeerFrame({ type: 'pass' }).type === 'pass',
    'an object from a binary serializer is accepted');
  ok(decodePeerFrame(new ArrayBuffer(8)) === null, 'binary is refused');
  ok(decodePeerFrame(new Uint8Array(8)) === null, 'so is a view onto binary');
  ok(decodePeerFrame(null) === null && decodePeerFrame(undefined) === null,
    'and nothing at all is not a message');

  // The bucket is the server's, exercised here because the browser host now uses
  // the same one — a burst of real play must pass, a script must not.
  const bucket = new TokenBucket({ capacity: 5, refillPerSec: 1, now: 0 });
  let allowed = 0;
  for (let i = 0; i < 50; i++) if (bucket.take(0)) allowed++;
  ok(allowed === 5, 'a flood inside one instant costs exactly the bucket');
  ok(bucket.take(1000) === true, 'and a second later there is a token again');
}

// ===========================================================================
section('The setup patch is bounded for both transports');
{
  const eng = freshGame({ players: 4, start: false });

  const huge = {};
  for (let i = 0; i < 40; i++) huge['key' + i] = i;
  const flood = applyGameIntent(eng, 'host', { type: 'setConfig', patch: huge });
  ok(flood.handled && !flood.result.ok, 'a patch with too many keys is refused, not spread');

  for (const junk of [null, undefined, 'numTeams=3', 42, [], {}]) {
    const r = applyGameIntent(eng, 'host', { type: 'setConfig', patch: junk });
    ok(r.handled && !r.result.ok, `a ${typeof junk} patch is refused`);
  }

  // A knob with no arithmetic behind it: numTeams would be clamped to what the
  // player count can actually split into, which is a different rule being tested
  // elsewhere and would hide whether the patch arrived at all.
  const real = applyGameIntent(eng, 'host', { type: 'setConfig', patch: { shuffleBoard: true } });
  ok(real.handled && real.result.ok, 'a real patch still works');
  ok(eng.config.shuffleBoard === true, 'and took effect');
}

// ===========================================================================
section('Serialize / restore an in-progress game');
{
  const eng = freshGame({ players: 4 });
  const actor = eng.currentPlayer;
  eng.chips[1] = eng.chips[2] = eng.chips[3] = actor.team;
  setTurnTo(eng, actor.id);
  coverCell(eng, actor.id, 4);

  // Round-trip through JSON, exactly as the localStorage snapshot does.
  const snap = JSON.parse(JSON.stringify(eng.serialize()));
  const eng2 = new GameEngine();
  eng2.restore(snap);

  ok(eng2.phase === eng.phase, 'phase restored');
  ok(eng2.chips.join() === eng.chips.join(), 'the board restored');
  ok(eng2.sequences.length === 1 && eng2.sequences[0].team === actor.team, 'sequences restored');
  ok(eng2.turn === eng.turn && eng2.hostId === eng.hostId, 'turn and host restored');
  ok(eng2.deck.length === eng.deck.length, 'the deck restored');
  ok(eng2.players.map((p) => p.name).join() === eng.players.map((p) => p.name).join(), 'the table restored');
  ok(eng2.log.length === eng.log.length, 'the move log restored');

  // The cell index is a Map, so JSON cannot carry it — it must be rebuilt.
  ok(eng2.cellIndex instanceof Map && eng2.cellIndex.size === 48, 'the cell index was rebuilt from the layout');
  ok(eng2.cellIndex.get('AS').join() === eng.cellIndex.get('AS').join(), 'the rebuilt index matches');

  const before = eng.privateStateFor(actor.id);
  const after = eng2.privateStateFor(actor.id);
  ok(after.hand.map((c) => c.id).join() === before.hand.map((c) => c.id).join(), 'hands survived the round trip');
  ok(after.hand.every((c, i) => c.targets.join() === before.hand[i].targets.join()),
    'legal targets recompute identically after a restore');

  // Play continues on the restored engine.
  const next = eng2.currentPlayer;
  const cell = legalTargets(eng2.hands[next.id][0].code, eng2._boardView(next.team))[0];
  if (cell != null) ok(eng2.playCard(next.id, eng2.hands[next.id][0].id, cell).ok, 'the restored game plays on');
  else ok(true, 'the restored game plays on (no target for the probe card)');

  const blank = new GameEngine();
  blank.restore(null);
  ok(blank.phase === PHASES.LOBBY && blank.players.length === 0, 'restoring nothing leaves a fresh engine');
}

// ===========================================================================
// A host reload is a restore PLUS a total loss of every peer connection, so the
// snapshot's `online` flags are all stale. resumeAsHost() clears them, and
// getting that wrong locks every player out of the game just restored — so the
// refusal is asserted too, to show what the method is defending against.
section('Host reload — stale online flags must not block rejoining');
{
  const eng = freshGame({ players: 4 });
  const victim = eng.players.find((p) => p.id !== eng.hostId);
  const handBefore = eng.hands[victim.id].map((c) => c.id).join();
  const snap = JSON.parse(JSON.stringify(eng.serialize()));

  // Restored verbatim, everyone still claims to be online...
  const naive = new GameEngine();
  naive.restore(snap);
  ok(naive.getPlayer(victim.id).online === true, 'the snapshot carries stale online flags');
  const refused = naive.addPlayer('fresh-conn', victim.name);
  ok(!refused.ok, 'rejoining is refused while the dead connection still looks online');
  ok(/already using that name/i.test(refused.error), 'and the reason given is the duplicate name');

  // ...which is why resumeAsHost() marks everyone but the host away first.
  const fixed = new GameEngine();
  fixed.restore(snap);
  const hostId = fixed.hostId;
  fixed.resumeAsHost(hostId);

  const back = fixed.addPlayer('fresh-conn', victim.name);
  ok(back.ok && back.reconnected, 'after clearing the flags the rejoin reclaims the seat');
  ok(back.prevId === victim.id, 'the stale connection id was reported for cleanup');
  ok(fixed.players.length === 4, 'no duplicate seat was created');
  ok((fixed.hands['fresh-conn'] || []).map((c) => c.id).join() === handBefore, 'they got their own hand back');
  ok(fixed.getPlayer(hostId).online === true, 'the host stayed online through the reload');
  ok(fixed.players.filter((p) => p.online).length === 2, 'nobody else is presumed present');
  ok(fixed.privateStateFor('fresh-conn').hand.length === 6, 'the private slice follows the new id');
}

// ===========================================================================
// Broker socket recovery (js/net.js).
//
// This runs only when the signalling socket drops mid-game, which is exactly the
// path nobody will ever exercise by hand again — so it gets a stub peer and fake
// timers instead. Same trick as the crypto shim at the top of this file.
section('Broker socket recovery');
{
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; };
  globalThis.clearTimeout = (t) => { if (t) t.live = false; };
  const fireLast = () => { const t = timers[timers.length - 1]; if (t && t.live) { t.live = false; t.fn(); } };

  class StubPeer {
    constructor(id) { this.id = id; this.destroyed = false; this.disconnected = false; this.h = {}; this.reconnects = 0; }
    on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); }
    emit(ev, ...a) { (this.h[ev] || []).forEach((f) => f(...a)); }
    reconnect() { this.reconnects++; this.disconnected = false; }
    destroy() { this.destroyed = true; }
  }
  let made = null;
  globalThis.window = { Peer: function (id) { made = new StubPeer(id); return made; } };

  const { createHost, isFatalPeerError } = await import('../js/net.js');

  const log = [];
  const host = createHost('TEST', {
    onOpen: () => log.push('open'),
    onBrokerDown: () => log.push('down'),
    onBrokerUp: () => log.push('up'),
    onBrokerLost: () => log.push('lost'),
  });
  const peer = made;
  ok(peer.id === 'localsequence-v1-TEST', 'the host peer id derives from the room code');

  peer.emit('open');
  ok(log.length === 2 && log.includes('open') && log.includes('up'), 'the first open reports onOpen and onBrokerUp');

  // One blip: the drop is reported, a backoff timer reconnects, and a successful
  // open resets the attempt count so the next blip starts from 1s again.
  peer.disconnected = true;
  peer.emit('disconnected');
  ok(log[log.length - 1] === 'down', 'a broker drop reports onBrokerDown');
  ok(timers[timers.length - 1].ms === 1000, 'the first retry waits 1s');
  fireLast();
  ok(peer.reconnects === 1, 'the retry calls peer.reconnect() — PeerJS never does it for us');
  peer.emit('open');
  ok(log.slice(-2).includes('up'), 'a successful reconnect reports onBrokerUp');

  const delays = [];
  for (let i = 0; i < 6; i++) {
    peer.disconnected = true;
    peer.emit('disconnected');
    const t = timers[timers.length - 1];
    if (t.live) { delays.push(t.ms); t.live = false; t.fn(); }
  }
  ok(delays.join() === '1000,2000,4000,8000,8000', `backoff doubles to an 8s cap (got ${delays.join()})`);
  ok(log.filter((x) => x === 'lost').length === 1, 'onBrokerLost fires once, not once per attempt');

  // A pending retry must not outlive the host, or it reconnects a dead peer.
  peer.disconnected = false;
  peer.emit('open');
  peer.disconnected = true;
  peer.emit('disconnected');
  const pending = timers[timers.length - 1];
  host.destroy();
  ok(peer.destroyed, 'destroy() destroys the peer');
  ok(!pending.live, 'destroy() cancels the pending retry');

  // Only a broken peer identity or a browser that cannot do WebRTC is fatal.
  // Signalling failures leave the existing device-to-device links untouched.
  ok(isFatalPeerError({ type: 'browser-incompatible' }), 'browser-incompatible is fatal');
  ok(isFatalPeerError({ type: 'unavailable-id' }), 'unavailable-id is fatal');
  ok(!isFatalPeerError({ type: 'network' }), 'a network error is survivable mid-game');
  ok(!isFatalPeerError({ type: 'socket-closed' }), 'a closed broker socket is survivable mid-game');
  ok(!isFatalPeerError(null), 'a missing error object is not fatal');

  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  delete globalThis.window;
}

// ===========================================================================
section('Full games, played end to end');

/** The best window score for `team` through `cell`: how close that line is. */
function lineStrength(eng, cell, team) {
  let best = 0;
  for (const cells of windowsThrough(cell)) {
    // A line with somebody else's chip in it is already spoiled.
    if (cells.some((i) => !isCorner(i) && eng.chips[i] != null && eng.chips[i] !== team)) continue;
    best = Math.max(best, cells.filter((i) => isCorner(i) || eng.chips[i] === team).length);
  }
  return best;
}

/** Every placement available to a player, with the removals kept aside. */
function candidates(eng, playerId) {
  const player = eng.getPlayer(playerId);
  const board = eng._boardView(player.team);
  const places = [], removals = [];
  for (const card of eng.hands[playerId] || []) {
    for (const cell of legalTargets(card.code, board)) {
      (isOneEyedJack(card.code) ? removals : places).push({ cardId: card.id, cell });
    }
  }
  return { player, places, removals };
}

/** Any placement that finishes a sequence right now. */
function winningPlacement(eng, player, places) {
  for (const move of places) {
    const probe = eng.chips.slice();
    probe[move.cell] = player.team;
    if (newSequencesAt(move.cell, player.team, probe, eng.sequences).length) return move;
  }
  return null;
}

/** Plays to win: finish a line if you can, otherwise extend your best one. */
function buildToWin(eng, playerId) {
  const { player, places, removals } = candidates(eng, playerId);
  const win = winningPlacement(eng, player, places);
  if (win) return win;
  let best = null, score = -1;
  for (const move of places) {
    const s = lineStrength(eng, move.cell, player.team);
    if (s > score) { score = s; best = move; }
  }
  return best || removals[0] || null;
}

/**
 * Plays spite: always covers whichever space most threatens it. Chips end up
 * scattered across the board instead of stacked into lines, which is what
 * actually drives the board to fill up — so this is the driver that exercises
 * dead-card swaps, passes and one-eyed Jacks inside a real game loop.
 */
function blockOpponents(eng, playerId) {
  const { player, places, removals } = candidates(eng, playerId);
  const win = winningPlacement(eng, player, places);
  if (win) return win;
  let best = null, score = -1;
  for (const move of places) {
    let threat = 0;
    for (let team = 0; team < eng.config.numTeams; team++) {
      if (team === player.team) continue;
      threat = Math.max(threat, lineStrength(eng, move.cell, team));
    }
    if (threat > score) { score = threat; best = move; }
  }
  return best || removals[0] || null;
}

// Generous: the slowest seeded game below takes ~3.5k turns, so this only trips
// on a genuine failure to terminate rather than on an unlucky deal.
const TURN_CAP = 20000;

function playOut(eng, chooseMove) {
  const s = { turns: 0, plays: 0, wilds: 0, removals: 0, swaps: 0, passes: 0, rejected: 0 };
  while (eng.phase === PHASES.PLAY && s.turns < TURN_CAP) {
    s.turns++;
    const actor = eng.currentPlayer;
    const move = chooseMove(eng, actor.id);
    let res;
    if (move) {
      const card = eng.hands[actor.id].find((c) => c.id === move.cardId);
      res = eng.playCard(actor.id, move.cardId, move.cell);
      if (res.ok) {
        s.plays++;
        if (isTwoEyedJack(card.code)) s.wilds++;
        if (isOneEyedJack(card.code)) s.removals++;
      }
    } else if (eng.hasDeadCardSwap(actor.id)) {
      const board = eng._boardView(actor.team);
      const card = eng.hands[actor.id].find((c) => isDeadCard(c.code, board));
      res = eng.exchangeDeadCard(actor.id, card.id);
      if (res.ok) s.swaps++;
    } else {
      res = eng.pass(actor.id);
      if (res.ok) s.passes++;
    }
    // A refusal means the driver and the rules disagree; carrying on would just
    // spin on the same turn, so stop and let the assertion report it.
    if (!res.ok) { s.rejected++; break; }
  }
  return s;
}

const SEEDS = [1, 2, 3, 4, 5, 6];
const TABLES = [[2, 2], [4, 2], [6, 3], [12, 2]];

for (const [driverName, driver] of [['build', buildToWin], ['block', blockOpponents]]) {
  const total = { turns: 0, plays: 0, wilds: 0, removals: 0, swaps: 0, passes: 0, rejected: 0 };
  const problems = [];

  for (const [players, numTeams] of TABLES) {
    for (const s of SEEDS) {
      seed(s);
      const eng = freshGame({ players, numTeams });
      const stats = playOut(eng, driver);
      for (const k of Object.keys(total)) total[k] += stats[k];
      const at = `${driverName} ${players}p/${numTeams}t seed ${s}`;

      if (stats.rejected) problems.push(`${at}: engine refused a move the rules offered`);
      if (eng.phase !== PHASES.GAME_OVER) problems.push(`${at}: unfinished after ${stats.turns} turns`);
      if (eng.winner === null) problems.push(`${at}: finished with no winner`);
      if (eng.sequences.filter((q) => q.team === eng.winner).length < eng.sequencesToWin) {
        problems.push(`${at}: winner short of ${eng.sequencesToWin} sequences`);
      }
      if (!eng.sequences.every((q) => q.cells.length === 5)) problems.push(`${at}: a sequence is not five cells`);
      if (!eng.sequences.every((q) => q.cells.every((c) => isCorner(c) || eng.chips[c] === q.team))) {
        problems.push(`${at}: a sequence cell holds no chip of that team`);
      }
      if (!eng.players.every((p) => eng.hands[p.id].length <= eng.handSize)) {
        problems.push(`${at}: somebody held more than a full hand`);
      }
      if (eng.log.length === 0 || eng.log.length > 14) problems.push(`${at}: move log ran to ${eng.log.length}`);
      if (stats.turns !== stats.plays + stats.swaps + stats.passes) problems.push(`${at}: turns unaccounted for`);
      // The public state must stay clean of hands for the whole game, not just
      // at the deal.
      const pub = eng.publicState();
      if ('hands' in pub || 'deck' in pub) problems.push(`${at}: the public state leaked cards`);
    }
  }

  const games = TABLES.length * SEEDS.length;
  ok(problems.length === 0, `${driverName}: ${games} games ran clean\n     ${problems.slice(0, 5).join('\n     ')}`);
  ok(total.plays > 0, `${driverName}: cards were played`);
  ok(total.wilds > 0, `${driverName}: two-eyed Jacks came up`);
  console.log(`  ${driverName}: ${games} games, ${total.turns} turns — ` +
    `${total.plays} plays (${total.wilds} wild, ${total.removals} removals), ` +
    `${total.swaps} swaps, ${total.passes} passes`);
}

// The spiteful driver is the one that crowds the board, so it is where the
// swap / pass / removal paths get their integration coverage. Re-run it alone so
// the assertion names what it is actually proving.
{
  const total = { swaps: 0, passes: 0, removals: 0 };
  let full = 0;
  for (const s of SEEDS) {
    seed(s);
    const eng = freshGame({ players: 6, numTeams: 3 });
    const stats = playOut(eng, blockOpponents);
    total.swaps += stats.swaps; total.passes += stats.passes; total.removals += stats.removals;
    if (eng.chips.filter((c) => c != null).length >= 90) full++;
  }
  ok(full > 0, 'a spiteful game crowds the board past 90 chips');
  ok(total.swaps > 0, 'dead cards got swapped during a real game');
  ok(total.passes > 0, 'players with nothing to do passed during a real game');
  ok(total.removals > 0, 'one-eyed Jacks got used during a real game');
}

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
