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
// Hand size and the sequences needed to win are NOT settings: both are fixed by
// the official player-count table (see handSizeFor / sequencesToWinFor), so
// there is nothing for the host to get wrong.
export const DEFAULTS = Object.freeze({
  numTeams: 2,
  shuffleBoard: false,   // false = the classic retail board layout
  deadCardsPerTurn: 1,   // official allowance; 0 disables, higher is a house rule
  // Purely presentational — it changes what the board points out, never what the
  // engine accepts. On (the default) the spaces a selected card can go light up;
  // off, players find their own matches the way they must at a physical table.
  showTargets: true,
});

export const LIMITS = Object.freeze({
  deadCardsPerTurn: { min: 0, max: 3 },
});

export function normalizeConfig(cfg = {}, playerCount = 0) {
  const c = { ...DEFAULTS, ...cfg };
  const allowed = allowedTeamCounts(playerCount);
  let numTeams = parseInt(c.numTeams, 10);
  if (!allowed.includes(numTeams)) numTeams = allowed[0] || DEFAULTS.numTeams;
  return {
    numTeams,
    shuffleBoard: !!c.shuffleBoard,
    // Safe to coerce hard: the DEFAULTS spread above has already turned a missing
    // key into true, so !! only ever sees a value the host actually set.
    showTargets: !!c.showTargets,
    deadCardsPerTurn: clampInt(
      c.deadCardsPerTurn, LIMITS.deadCardsPerTurn.min, LIMITS.deadCardsPerTurn.max,
      DEFAULTS.deadCardsPerTurn
    ),
  };
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

/** Cells inside `team`'s completed sequences, excluding the free corners. */
export function claimedCellsFor(sequences, team) {
  const claimed = new Set();
  for (const seq of sequences) {
    if (seq.team !== team) continue;
    for (const cell of seq.cells) if (!isCorner(cell)) claimed.add(cell);
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
  const { layout, cellIndex, chips, sequences, team } = board;
  if (isTwoEyedJack(code)) {
    // Wild: any open space. Corners are already "everyone's", so they are never
    // a legal target — covering one would waste the card.
    const out = [];
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (!isCorner(cell) && chips[cell] == null && layout[cell] !== FREE) out.push(cell);
    }
    return out;
  }
  if (isOneEyedJack(code)) {
    // Removal: any opponent chip that is not part of a completed sequence.
    const locked = lockedCells(sequences);
    const out = [];
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (chips[cell] != null && chips[cell] !== team && !locked.has(cell)) out.push(cell);
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
 */
export function newSequencesAt(cell, team, chips, sequences) {
  const owns = (i) => isCorner(i) || chips[i] === team;
  const claimed = claimedCellsFor(sequences, team);
  const existing = sequences.filter((s) => s.team === team).map((s) => windowKey(s.cells));
  const accepted = [];

  for (const cells of windowsThrough(cell)) {
    if (!cells.every(owns)) continue;
    if (existing.includes(windowKey(cells))) continue;

    let shared = 0;
    for (const i of cells) if (!isCorner(i) && claimed.has(i)) shared++;
    if (shared > 1) continue;

    accepted.push(cells);
    existing.push(windowKey(cells));
    for (const i of cells) if (!isCorner(i)) claimed.add(i);
  }
  return accepted;
}

function windowKey(cells) {
  return cells.slice().sort((a, b) => a - b).join(',');
}

export { SEQUENCE_LENGTH };
