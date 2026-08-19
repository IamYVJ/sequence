// ============================================================================
// rules.js — ALL Sequence rule constants + pure logic. Start reading here.
//
// Sequence: the board shows 96 playing cards (every card except the Jacks,
// printed twice) plus 4 free corners. On your turn you play one card from hand,
// cover a matching board space with your team's chip, and draw a replacement.
// Five chips in a straight line — across, down or diagonally — is a SEQUENCE.
// Two teams race to two sequences; three teams race to one.
//
// The Jacks are the special cards, and which Jack you hold matters:
//   TWO-EYED  (J-diamonds, J-clubs)  — wild: place a chip on ANY open space.
//   ONE-EYED  (J-spades,  J-hearts)  — remove ONE opponent chip from the board.
//
// Everything above is the official game, and it is what every DEFAULT in here
// says. The host may layer house rules on top (see DEFAULTS and PRESETS); the
// pure functions below take those as an optional `config` and behave exactly as
// the box does when it is absent, so official play is never the special case.
//
// This module is pure: constants and functions over plain data. The
// host-authoritative state machine lives in state.js.
// ============================================================================

import {
  FREE, CELL_COUNT, isCorner, windowsThrough, SEQUENCE_LENGTH,
} from './board.js';

// ---- Cards -----------------------------------------------------------------
export const SUITS = Object.freeze(['S', 'H', 'D', 'C']);
export const RANKS = Object.freeze(['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']);

// Two full 52-card decks, Jacks included, are used.
export const DECK_COPIES = 2;

// Named by the artwork on a real Jack: a one-eyed Jack shows a profile (one
// eye), a two-eyed Jack shows a full face. Hence the traditional shorthand.
export const TWO_EYED_JACKS = Object.freeze(['JD', 'JC']);
export const ONE_EYED_JACKS = Object.freeze(['JS', 'JH']);

export function rankOf(code) { return code[0]; }
export function suitOf(code) { return code[1]; }
export function isJack(code) { return rankOf(code) === 'J'; }
export function isTwoEyedJack(code) { return TWO_EYED_JACKS.includes(code); }
export function isOneEyedJack(code) { return ONE_EYED_JACKS.includes(code); }
export function isRedSuit(code) { return suitOf(code) === 'H' || suitOf(code) === 'D'; }

const SUIT_GLYPHS = Object.freeze({ S: '♠', H: '♥', D: '♦', C: '♣' });
export function suitGlyph(code) { return SUIT_GLYPHS[suitOf(code)] || ''; }

/** Display rank — 'T' is stored for the ten so all codes are two characters. */
export function rankLabel(code) { return rankOf(code) === 'T' ? '10' : rankOf(code); }

/** Full human label, e.g. '10♥'. */
export function cardLabel(code) {
  if (code === FREE) return 'Free corner';
  return rankLabel(code) + suitGlyph(code);
}

/** Two decks' worth of cards, each with a stable unique id. */
export function buildDeck() {
  const cards = [];
  for (let copy = 0; copy < DECK_COPIES; copy++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        const code = rank + suit;
        cards.push({ id: `${code}#${copy}`, code });
      }
    }
  }
  return cards;
}

// ---- Seating: who can play, in how many teams, with how many cards ---------
// The official table. Team sizes must be equal, which is why 5, 7 and 11 players
// cannot play — there is no equal split into 2 or 3 teams.
export const SEATINGS = Object.freeze([
  { players: 2,  teams: [2],    handSize: 7 },
  { players: 3,  teams: [3],    handSize: 6 },
  { players: 4,  teams: [2],    handSize: 6 },
  { players: 6,  teams: [2, 3], handSize: 5 },
  { players: 8,  teams: [2],    handSize: 4 },
  { players: 9,  teams: [3],    handSize: 4 },
  { players: 10, teams: [2],    handSize: 3 },
  { players: 12, teams: [2, 3], handSize: 3 },
]);

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 12;

export function seatingFor(playerCount) {
  return SEATINGS.find((s) => s.players === playerCount) || null;
}

export function allowedTeamCounts(playerCount) {
  const seating = seatingFor(playerCount);
  return seating ? seating.teams.slice() : [];
}

/** Cards dealt to each player, from the official player-count table. */
export function handSizeFor(playerCount) {
  const seating = seatingFor(playerCount);
  return seating ? seating.handSize : 6;
}

/** Two teams race to two sequences; three teams race to one. */
export function sequencesToWinFor(numTeams) {
  return numTeams >= 3 ? 1 : 2;
}

/**
 * How many sequences win THIS game: the host's override when they set one, and
 * otherwise the official table above.
 *
 * The override is stored as 0-means-auto rather than as an absolute number on
 * purpose. Seating is re-normalised on every join and leave, which can change
 * numTeams under the host's feet — an absolute 2 chosen while two teams were
 * seated would sit there silently contradicting the rules once a third team
 * appeared, where "auto" just follows.
 */
export function winTargetFor(config) {
  const c = config || {};
  // Same clamp normalizeConfig applies, so a value that arrived unnormalised —
  // from a snapshot, or from a peer — resolves to what the host would have got.
  const n = clampInt(c.sequencesToWin, LIMITS.sequencesToWin.min,
    LIMITS.sequencesToWin.max, DEFAULTS.sequencesToWin);
  return n || sequencesToWinFor(c.numTeams);
}

/**
 * How many chips in a row this game needs. Read through here rather than off
 * config directly: restore() rehydrates a snapshot with a plain Object.assign,
 * so a game that started before this setting existed comes back with the key
 * missing — and missing has to mean the official five.
 */
export function sequenceLengthFor(config) {
  // clampInt, not a range test, so this and normalizeConfig can never resolve the
  // same value two different ways. A missing key is not a number, so it takes the
  // fallback — which is the official five — before any clamping happens.
  const { min, max } = LIMITS.sequenceLength;
  return clampInt((config || {}).sequenceLength, min, max, SEQUENCE_LENGTH);
}

/** e.g. "2 teams of 3" — for the lobby summary. */
export function describeSeating(playerCount, numTeams) {
  if (!numTeams || playerCount % numTeams !== 0) {
    return `${playerCount} player${playerCount === 1 ? '' : 's'}`;
  }
  const per = playerCount / numTeams;
  return `${numTeams} teams of ${per}`;
}

// ---- Team identity (name + colour) -----------------------------------------
// Blue / green / red, matching the chip colours in the box.
export const TEAM_THEMES = Object.freeze([
  { name: 'Blue',  color: '#4DA3FF', dim: 'rgba(77, 163, 255, 0.16)' },
  { name: 'Green', color: '#49D083', dim: 'rgba(73, 208, 131, 0.16)' },
  { name: 'Red',   color: '#FF6B6B', dim: 'rgba(255, 107, 107, 0.16)' },
]);

export function teamTheme(index) {
  return TEAM_THEMES[index % TEAM_THEMES.length];
}

// ---- Host-configurable settings --------------------------------------------
// Hand size is NOT a setting: it is fixed by the official player-count table
// (see handSizeFor), so there is nothing for the host to get wrong.
//
// Every default in here is the official game. A host who touches nothing plays
// Sequence out of the box; each key below is one house rule, opted into.
export const DEFAULTS = Object.freeze({
  numTeams: 2,
  shuffleBoard: false,   // false = the classic retail board layout
  deadCardsPerTurn: 1,   // official allowance; 0 disables, higher is a house rule
  // Purely presentational — it changes what the board points out, never what the
  // engine accepts. On (the default) the spaces a selected card can go light up;
  // off, players find their own matches the way they must at a physical table.
  showTargets: true,

  // ---- House rules -------------------------------------------------------
  // Chips in a row that make a sequence. Shortening it without also hardening
  // the corners makes a corner line very cheap (see hardCorners).
  sequenceLength: SEQUENCE_LENGTH,
  // 0 = follow the official table for the number of teams seated. See
  // winTargetFor for why this is a sentinel and not an absolute number.
  sequencesToWin: 0,
  // The ★ corners stop being everyone's chip: a line through one needs a real
  // chip on it, and since no card is printed there only a wild can put one down.
  hardCorners: false,
  // No shared chip at all between two of your sequences, where the official rule
  // allows exactly one.
  strictSequences: false,
  // A one-eyed Jack may lift ANY chip that is not already locked in a completed
  // sequence — including your own team's.
  jacksRemoveAny: false,
  // Chips never reveal the card underneath: no tap-to-peek, no Peek cards, no
  // free reveal when a one-eyed Jack is selected. Presentational, like
  // showTargets — the engine plays exactly the same game either way.
  memoryMode: false,
});

export const LIMITS = Object.freeze({
  deadCardsPerTurn: { min: 0, max: 3 },
  sequenceLength: { min: 4, max: 6 },
  sequencesToWin: { min: 0, max: 3 },
});

/**
 * Everything except numTeams, which is seating's business rather than the host's.
 * Presets are defined over exactly these keys, so this list is also what decides
 * whether a config still counts as a preset (see presetOf).
 */
export const RULE_KEYS = Object.freeze([
  'shuffleBoard', 'deadCardsPerTurn', 'showTargets', 'sequenceLength',
  'sequencesToWin', 'hardCorners', 'strictSequences', 'jacksRemoveAny', 'memoryMode',
]);

/** Coerce the rule keys. `c` must already have DEFAULTS spread underneath it. */
function normalizeRuleKeys(c) {
  const int = (key) => clampInt(
    c[key], LIMITS[key].min, LIMITS[key].max, DEFAULTS[key]
  );
  return {
    shuffleBoard: !!c.shuffleBoard,
    // Safe to coerce hard: the DEFAULTS spread has already turned a missing key
    // into true, so !! only ever sees a value the host actually set.
    showTargets: !!c.showTargets,
    sequenceLength: int('sequenceLength'),
    sequencesToWin: int('sequencesToWin'),
    hardCorners: !!c.hardCorners,
    strictSequences: !!c.strictSequences,
    jacksRemoveAny: !!c.jacksRemoveAny,
    memoryMode: !!c.memoryMode,
    deadCardsPerTurn: int('deadCardsPerTurn'),
  };
}

export function normalizeConfig(cfg = {}, playerCount = 0) {
  const c = { ...DEFAULTS, ...cfg };
  const allowed = allowedTeamCounts(playerCount);
  let numTeams = parseInt(c.numTeams, 10);
  if (!allowed.includes(numTeams)) numTeams = allowed[0] || DEFAULTS.numTeams;
  return { numTeams, ...normalizeRuleKeys(c) };
}

// ---- Presets ---------------------------------------------------------------
// A named bundle of the rule keys, so a table can pick a way to play without
// reading nine switches. Each preset lists only what it changes; every other key
// comes back to its default, which is what lets "Classic" mean "undo my fiddling"
// and stops a preset inheriting a leftover from the one before it.
export const PRESETS = Object.freeze([
  {
    id: 'classic',
    name: 'Classic',
    blurb: 'The game as it comes in the box.',
    config: Object.freeze({}),
  },
  {
    id: 'quick',
    name: 'Quick',
    // Four in a row and free corners together would win a game on three chips,
    // so this hardens the corners in the same breath.
    blurb: 'Four in a row, one sequence wins, and the corners are no longer free.',
    config: Object.freeze({ sequenceLength: 4, sequencesToWin: 1, hardCorners: true }),
  },
  {
    id: 'hard',
    name: 'Hard',
    // Nothing here changes a rule: it takes away what the app was telling you.
    blurb: 'Shuffled board, no highlights, and chips keep the card underneath hidden.',
    config: Object.freeze({ shuffleBoard: true, showTargets: false, memoryMode: true }),
  },
]);

/**
 * Short phrases for every house rule in force, official play being an empty
 * array. One list, read by the lobby summary and logged when the game starts, so
 * a player who joined late and a player reading the log are told the same thing.
 *
 * Deliberately tolerant of a config from before these keys existed: a missing key
 * is the official rule, which is nothing to announce.
 */
export function describeHouseRules(config) {
  const c = config || {};
  const out = [];
  const length = sequenceLengthFor(c);
  if (length !== SEQUENCE_LENGTH) out.push(`${length} in a row, not ${SEQUENCE_LENGTH}`);
  if (c.hardCorners) out.push('corners are not free');
  if (c.strictSequences) out.push('no shared chip between sequences');
  if (c.jacksRemoveAny) out.push('one-eyed Jacks lift any chip');
  if (c.memoryMode) out.push('chips hide the card underneath');
  if (c.shuffleBoard) out.push('shuffled board');
  if (!highlightsOn(c)) out.push('no highlights');
  const dead = clampInt(c.deadCardsPerTurn, LIMITS.deadCardsPerTurn.min,
    LIMITS.deadCardsPerTurn.max, DEFAULTS.deadCardsPerTurn);
  if (dead !== DEFAULTS.deadCardsPerTurn) {
    out.push(dead === 0 ? 'no dead-card swaps' : `${dead} dead-card swaps a turn`);
  }
  return out;
}

/** The full set of rule keys a preset means: its own, over the defaults. */
export function presetConfig(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return {};
  const out = {};
  for (const key of RULE_KEYS) {
    out[key] = key in preset.config ? preset.config[key] : DEFAULTS[key];
  }
  return out;
}

/**
 * Which preset this config is, or null when the host has tuned away from all of
 * them ("Custom"). Compares normalised values so a config that arrived over the
 * wire, or out of a snapshot saved before these keys existed, still matches.
 */
export function presetOf(config) {
  const mine = normalizeRuleKeys({ ...DEFAULTS, ...(config || {}) });
  for (const preset of PRESETS) {
    const theirs = normalizeRuleKeys({ ...DEFAULTS, ...preset.config });
    if (RULE_KEYS.every((key) => mine[key] === theirs[key])) return preset.id;
  }
  return null;
}

/**
 * Are the board highlights on? Read through this rather than off config directly:
 * restore() rehydrates a saved snapshot with a plain Object.assign, so a game that
 * was already in progress before this setting existed comes back with the key
 * missing — and "missing" means highlights, because that was the only behaviour.
 */
export function highlightsOn(config) {
  return !config || config.showTargets !== false;
}

/**
 * May a player look under a chip? Off in memory mode, where remembering what got
 * covered is the game. Like highlightsOn this is about what the board admits to,
 * not about what is legal — the engine accepts the same moves either way.
 */
export function peeksAllowed(config) {
  return !config || !config.memoryMode;
}

/**
 * Can the game start? Teams are derived from seat order (team = seat % numTeams),
 * so an unequal or non-alternating split is unreachable — the only things left to
 * check are that the player count is one the game supports and that the chosen
 * number of teams divides it.
 */
export function validateStart(playerCount, numTeams) {
  const errors = [];
  if (playerCount < MIN_PLAYERS) {
    errors.push(`Need at least ${MIN_PLAYERS} players.`);
  } else if (!seatingFor(playerCount)) {
    const counts = SEATINGS.map((s) => s.players).join(', ');
    errors.push(`${playerCount} players can't split into equal teams. Supported: ${counts}.`);
  } else if (!allowedTeamCounts(playerCount).includes(numTeams)) {
    const opts = allowedTeamCounts(playerCount).join(' or ');
    errors.push(`${playerCount} players must play in ${opts} teams.`);
  }
  return { ok: errors.length === 0, errors };
}

// ---- Pure helpers ----------------------------------------------------------

/** Fisher-Yates, returns a NEW shuffled array (crypto-seeded when available). */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomBelow(n) {
  try {
    const source = typeof crypto !== 'undefined' ? crypto : globalThis.crypto;
    if (source && source.getRandomValues) {
      const buf = new Uint32Array(1);
      source.getRandomValues(buf);
      return buf[0] % n;
    }
  } catch (_) { /* fall through */ }
  return Math.floor(Math.random() * n);
}

/** Clamp a number into [min, max], coercing non-numbers to the fallback. */
export function clampInt(value, min, max, fallback) {
  let n = parseInt(value, 10);
  if (!Number.isFinite(n)) n = fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Trim and cap a display name. Control characters are stripped.
 *
 * Non-strings become '' rather than throwing: names arrive over the wire from
 * peers we don't control, and `(5).replace` is a TypeError that would escape
 * into the host's connection callback. An empty name is rejected by addPlayer,
 * which is the answer we want anyway.
 */
export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

// ---- Chips, locks and legal moves ------------------------------------------

/**
 * Every cell that belongs to a COMPLETED sequence, of any team. A chip here is
 * safe: a one-eyed Jack can never remove it.
 */
export function lockedCells(sequences) {
  const locked = new Set();
  for (const seq of sequences) for (const cell of seq.cells) locked.add(cell);
  return locked;
}

/**
 * Cells inside `team`'s completed sequences that count as that team's CHIPS, for
 * the shared-chip rule. Free corners are spaces rather than chips, so they are
 * left out — unless the hard-corners house rule has made them ordinary spaces
 * that a team had to cover for itself.
 */
export function claimedCellsFor(sequences, team, hardCorners = false) {
  const claimed = new Set();
  for (const seq of sequences) {
    if (seq.team !== team) continue;
    for (const cell of seq.cells) if (hardCorners || !isCorner(cell)) claimed.add(cell);
  }
  return claimed;
}

/**
 * Where can this card be played right now?
 *
 * Shared by the engine (which validates every move against it) and the view
 * (which highlights the same cells), so what you can tap and what the host will
 * accept are guaranteed to be the same set.
 *
 * Returns board cell indices. An empty array means the card cannot be played at
 * all this turn.
 */
export function legalTargets(code, board) {
  const { layout, cellIndex, chips, sequences, team, config } = board;
  if (isTwoEyedJack(code)) {
    // Wild: any open space. A corner is normally already "everyone's", so
    // covering one would waste the card — but under hard corners it is an
    // ordinary space, and with no card printed there a wild is the ONLY way to
    // ever put a chip on it.
    const hard = !!(config && config.hardCorners);
    const out = [];
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (chips[cell] != null) continue;
      const free = isCorner(cell) || layout[cell] === FREE;
      if (free && !hard) continue;
      out.push(cell);
    }
    return out;
  }
  if (isOneEyedJack(code)) {
    // Removal: any opponent chip that is not part of a completed sequence. The
    // cutthroat house rule drops "opponent" but never the lock — a ✦ that could
    // be lifted would make the marker mean nothing.
    const anyChip = !!(config && config.jacksRemoveAny);
    const locked = lockedCells(sequences);
    const out = [];
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (chips[cell] == null || locked.has(cell)) continue;
      if (!anyChip && chips[cell] === team) continue;
      out.push(cell);
    }
    return out;
  }
  return (cellIndex.get(code) || []).filter((cell) => chips[cell] == null);
}

/**
 * A card is DEAD when both of its board spaces are already covered, so it can
 * never be played. Jacks are never dead — a wild always has somewhere to go and
 * a one-eyed Jack is a removal, not a placement.
 */
export function isDeadCard(code, board) {
  if (isJack(code)) return false;
  const cells = board.cellIndex.get(code) || [];
  return cells.every((cell) => board.chips[cell] != null);
}

// ---- Sequence detection ----------------------------------------------------

/**
 * Sequences newly completed by a chip landing on `cell`.
 *
 * A cell counts toward `team` if the team's chip is on it OR it is a free
 * corner (corners belong to everyone, so a line through one needs just 4 chips).
 *
 * THE SHARED-CHIP RULE: a new sequence may reuse at most ONE chip from a
 * sequence this team has already completed. Free corners are spaces, not chips,
 * so they are exempt and may be shared freely.
 *
 * Accepting a window immediately adds its chips to the claimed set, which is
 * what makes the rule fall out correctly when one chip completes two lines at
 * once: the second line shares exactly the one new chip (allowed), while a
 * six-in-a-row's two overlapping windows share four (rejected). When two
 * candidate lines conflict, the first in scan order wins — an ambiguity the
 * physical game resolves by asking the player, and not worth a prompt here.
 *
 * `config` carries the house rules; left out, this is the official game. Two of
 * them land here:
 *   hardCorners     — a corner counts for nobody until someone's chip is on it,
 *                     and then it is a chip like any other for sharing.
 *   strictSequences — the shared chip allowance drops from one to none.
 */
export function newSequencesAt(cell, team, chips, sequences, config = {}) {
  const hard = !!config.hardCorners;
  // The only place the corner rule lives. Everything below asks this rather than
  // isCorner, so hard corners cannot be honoured in one branch and forgotten in
  // the next.
  const free = (i) => !hard && isCorner(i);
  const owns = (i) => free(i) || chips[i] === team;
  const maxShared = config.strictSequences ? 0 : 1;
  const claimed = claimedCellsFor(sequences, team, hard);
  const existing = sequences.filter((s) => s.team === team).map((s) => windowKey(s.cells));
  const accepted = [];

  for (const cells of windowsThrough(cell, sequenceLengthFor(config))) {
    if (!cells.every(owns)) continue;
    if (existing.includes(windowKey(cells))) continue;

    let shared = 0;
    for (const i of cells) if (!free(i) && claimed.has(i)) shared++;
    if (shared > maxShared) continue;

    accepted.push(cells);
    existing.push(windowKey(cells));
    for (const i of cells) if (!free(i)) claimed.add(i);
  }
  return accepted;
}

function windowKey(cells) {
  return cells.slice().sort((a, b) => a - b).join(',');
}

export { SEQUENCE_LENGTH };
