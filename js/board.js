// ============================================================================
// board.js — The 10x10 Sequence board.
//
// A board cell holds either a CARD CODE (rank + suit, e.g. 'TH' = ten of
// hearts) or FREE for the four corners. Jacks never appear on the board — they
// are the wild / removal cards held in hand, which is why the board holds
// exactly 48 distinct cards (12 ranks x 4 suits) printed TWICE = 96 cells,
// plus 4 free corners = 100.
//
// Cells are addressed by a flat index 0..99, row-major: index = row * 10 + col.
// ============================================================================

export const BOARD_SIZE = 10;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
export const FREE = 'FREE';

// The four free corners. They count as a chip of EVERY team when a line is
// checked, so a sequence through a corner only needs 4 real chips.
export const CORNERS = Object.freeze([0, 9, 90, 99]);
const CORNER_SET = new Set(CORNERS);

export function isCorner(cell) { return CORNER_SET.has(cell); }

// ---------------------------------------------------------------------------
// The classic (retail) board layout, transcribed row by row from the physical
// board. Ranks use 'T' for the ten so every code is exactly two characters;
// suits are S/H/D/C.
//
// Do not "tidy" this data — the arrangement is the published board, and the
// diagonal card runs are what make the real game's geometry work. The test
// harness asserts every one of the 48 non-Jack cards appears exactly twice,
// which is what caught transcription errors in the first place.
// ---------------------------------------------------------------------------
const CLASSIC_ROWS = [
  'FREE AC KC QC TC 9C 8C 7C 6C FREE',
  'AD   7S 8S 9S TS QS KS AS 5C 2S',
  'KD   6S TC 9C 8C 7C 6C 2D 4C 3S',
  'QD   5S QC 8H 7H 6H 5C 3D 3C 4S',
  'TD   4S KC 9H 2H 5H 4C 4D 2C 5S',
  '9D   3S AC TH 3H 4H 3C 5D AH 6S',
  '8D   2S AD QH KH AH 2C 6D KH 7S',
  '7D   2H KD QD TD 9D 8D 7D QH 8S',
  '6D   3H 4H 5H 6H 7H 8H 9H TH 9S',
  'FREE 5D 4D 3D 2D AS KS QS TS FREE',
];

export const CLASSIC_LAYOUT = Object.freeze(
  CLASSIC_ROWS.flatMap((row) => row.trim().split(/\s+/))
);

// ---------------------------------------------------------------------------
// Layout construction
// ---------------------------------------------------------------------------

/**
 * A freshly shuffled board: the same 96 cards in a new arrangement.
 *
 * The two copies of a card are kept out of each other's 8-neighbourhood. Without
 * that, adjacent twins let a single card cover two cells of one line, which
 * plays nothing like the real board. Repair by swapping offenders with a random
 * cell rather than reshuffling wholesale, so a near-valid board isn't thrown away.
 *
 * `shuffleFn` is injected so the engine can supply its own RNG (and tests a
 * deterministic one).
 */
export function randomLayout(shuffleFn) {
  const pool = [];
  for (const code of BOARD_CARD_CODES) { pool.push(code, code); }

  const spots = [];
  for (let i = 0; i < CELL_COUNT; i++) if (!isCorner(i)) spots.push(i);

  const cards = shuffleFn(pool);
  const layout = new Array(CELL_COUNT).fill(FREE);
  spots.forEach((cell, i) => { layout[cell] = cards[i]; });

  // Bounded repair pass. Each offending cell is swapped with a random other
  // cell; the cap keeps this from spinning on a pathological arrangement (in
  // practice it settles in a handful of passes).
  for (let pass = 0; pass < 200; pass++) {
    const bad = spots.filter((cell) => hasTwinNeighbour(layout, cell));
    if (bad.length === 0) break;
    const order = shuffleFn(spots);
    for (const cell of bad) {
      const other = order.find((o) => o !== cell && !isCorner(o));
      if (other == null) break;
      [layout[cell], layout[other]] = [layout[other], layout[cell]];
    }
  }
  return layout;
}

function hasTwinNeighbour(layout, cell) {
  const code = layout[cell];
  if (code === FREE) return false;
  for (const n of neighbours(cell)) if (layout[n] === code) return true;
  return false;
}

function neighbours(cell) {
  const r = Math.floor(cell / BOARD_SIZE), c = cell % BOARD_SIZE;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= BOARD_SIZE || cc < 0 || cc >= BOARD_SIZE) continue;
      out.push(rr * BOARD_SIZE + cc);
    }
  }
  return out;
}

/** The 48 card codes printed on the board (every rank except the Jack). */
export const BOARD_CARD_CODES = Object.freeze(
  ['S', 'H', 'D', 'C'].flatMap((suit) =>
    ['A', 'K', 'Q', 'T', '9', '8', '7', '6', '5', '4', '3', '2'].map((rank) => rank + suit)
  )
);

/**
 * Map of card code -> the cells printed with that card. Built once per game and
 * used for both legal-move lookup and dead-card detection, so those two never
 * disagree about where a card can go.
 */
export function buildCellIndex(layout) {
  const index = new Map();
  layout.forEach((code, cell) => {
    if (code === FREE) return;
    const list = index.get(code);
    if (list) list.push(cell);
    else index.set(code, [cell]);
  });
  return index;
}

// ---------------------------------------------------------------------------
// Naming — the move log needs to say WHERE a chip landed. Columns are lettered
// A-J left to right, rows numbered 1-10 top to bottom, so 'C4' reads the same
// way as it would if someone pointed at the physical board.
// ---------------------------------------------------------------------------
const COLUMN_LETTERS = 'ABCDEFGHIJ';

export function cellName(cell) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) return '?';
  return COLUMN_LETTERS[cell % BOARD_SIZE] + (Math.floor(cell / BOARD_SIZE) + 1);
}

// ---------------------------------------------------------------------------
// Geometry — the four line directions and the N-cell windows through a cell.
// ---------------------------------------------------------------------------
const DIRECTIONS = Object.freeze([[0, 1], [1, 0], [1, 1], [1, -1]]);

/** Five in a row, as printed on the box. A house rule may shorten or lengthen it. */
export const SEQUENCE_LENGTH = 5;

/**
 * Every on-board straight line of `length` cells that passes through `cell`, in
 * all four directions. Up to 4 x length windows; fewer near an edge.
 *
 * `length` defaults to the official 5 so every caller that does not care about
 * the house rule reads as it always did.
 */
export function windowsThrough(cell, length = SEQUENCE_LENGTH) {
  const n = Number.isInteger(length) && length > 1 ? length : SEQUENCE_LENGTH;
  const r = Math.floor(cell / BOARD_SIZE), c = cell % BOARD_SIZE;
  const out = [];
  for (const [dr, dc] of DIRECTIONS) {
    for (let offset = -(n - 1); offset <= 0; offset++) {
      const cells = [];
      for (let k = 0; k < n; k++) {
        const rr = r + (offset + k) * dr;
        const cc = c + (offset + k) * dc;
        if (rr < 0 || rr >= BOARD_SIZE || cc < 0 || cc >= BOARD_SIZE) { cells.length = 0; break; }
        cells.push(rr * BOARD_SIZE + cc);
      }
      if (cells.length === n) out.push(cells);
    }
  }
  return out;
}
