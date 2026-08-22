// ============================================================================
// state.js — The host-authoritative Sequence engine.
//
// One instance lives in the host's tab and owns the whole truth: the board, the
// deck, and every player's hand. Clients send intents and receive two things
// back — a PUBLIC state everyone may see, and a PRIVATE slice holding only that
// player's own cards. No hand ever reaches another device.
//
// Every intent method returns { ok: true } or { ok: false, error } and mutates
// nothing on rejection, so an illegal move from a stale or hostile client can
// never corrupt the game.
// ============================================================================

import {
  CELL_COUNT, CLASSIC_LAYOUT, buildCellIndex, randomLayout, isCorner, cellName,
} from './board.js';
import {
  MAX_PLAYERS, DEFAULTS, buildDeck, shuffle, cleanName, cardLabel,
  normalizeConfig, validateStart, handSizeFor, winTargetFor,
  legalTargets, isDeadCard, isOneEyedJack, isTwoEyedJack, newSequencesAt,
  teamTheme, describeSeating, describeHouseRules,
} from './rules.js';

export const PHASES = {
  LOBBY: 'lobby',
  PLAY: 'play',
  GAME_OVER: 'gameOver',
};

const LOG_LIMIT = 14;

export class GameEngine {
  constructor() { this.reset(); }

  reset() {
    this.phase = PHASES.LOBBY;
    this.hostId = null;
    // Seat order. A player's TEAM is derived from their seat (seat % numTeams),
    // which is how the physical game works — teammates never sit next to each
    // other. Deriving it means an unequal or non-alternating split is simply
    // unrepresentable, so there is no team-assignment state to validate.
    this.players = [];
    this.config = { ...DEFAULTS };

    this.layout = CLASSIC_LAYOUT.slice();
    this.cellIndex = buildCellIndex(this.layout);
    this.chips = new Array(CELL_COUNT).fill(null);   // cell -> team index | null
    this.sequences = [];                             // [{ team, cells: [5 cells] }]

    this.deck = [];
    this.discards = [];
    this.hands = {};                                 // playerId -> [card]

    this.turn = 0;                                   // seat index of the player to act
    this.deadUsed = 0;                               // dead-card swaps used this turn
    this.lastMove = null;
    this.log = [];
    this.winner = null;                              // team index | null
    this.gamesPlayed = 0;                            // rotates who leads a rematch
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  /**
   * Seat a player, or hand a seat back to someone reconnecting.
   *
   * WHO OWNS A SEAT
   *   A seat in progress belongs to a `clientId` — a random string the joining
   *   device keeps in its own localStorage and never shows on screen — and not to
   *   the display name above it. The name is how humans find each other; it is
   *   not a credential, because everyone at the table can see it.
   *
   *   This used to reclaim by name alone, on the reasoning that a P2P host only
   *   ever hears from the same room. That was wrong: PeerJS signalling is a public
   *   broker and the data channel can fall back to a public relay, so a browser
   *   host is reachable by anyone holding a 4-character code. "Type Alice's name
   *   into her game while her phone is asleep, and be dealt her hand" has to be
   *   impossible rather than unlikely, and it has to be impossible on both
   *   transports, so the rule lives in the engine both of them share.
   *
   *   In the LOBBY a name reclaim is still allowed: there are no hands yet, so the
   *   worst case is a seat, and a device that has genuinely lost its clientId
   *   (cleared storage, new browser) can still get back in before the deal.
   *
   *   A seat with no clientId recorded is one from before this rule, or from the
   *   host's own tab; it binds the first clientId it is offered instead of being
   *   locked out of its own game by a snapshot restore.
   */
  addPlayer(id, name, { isHost = false, clientId = null } = {}) {
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'Enter a name first.' };

    // The clientId is checked first and on its own: a returning device is entitled
    // to its seat even if it comes back under a different display name, and that
    // lookup must not be reachable by choosing a name.
    const owned = clientId ? this.players.find((p) => p.clientId === clientId) : null;
    const named = this.players.find((p) => p.name.toLowerCase() === clean.toLowerCase());
    const existing = owned || named;

    if (existing) {
      if (existing.online && existing.id !== id) {
        return { ok: false, error: 'Someone in this game is already using that name.' };
      }
      // Mid-game, a seat that knows whose it is may only be reclaimed by that
      // device. Refused as "already using that name" rather than "wrong device":
      // an attacker learns nothing from it, and the honest case that lands here —
      // two people who typed the same name — is exactly what it says.
      if (this.phase !== PHASES.LOBBY && existing !== owned
          && existing.clientId && existing.clientId !== clientId) {
        return { ok: false, error: 'Someone in this game is already using that name.' };
      }
      const prevId = existing.id;
      if (prevId !== id) this._remapPlayerId(prevId, id);
      existing.online = true;
      if (clientId) existing.clientId = clientId;
      // A reclaim by clientId may arrive under a new name, and the table should
      // show the name the device is actually using — but only if it is free.
      // Two identical names at one table is a worse outcome than a stale one.
      if (!named || named === existing) existing.name = clean;
      if (isHost) { existing.isHost = true; this.hostId = id; }
      return { ok: true, reconnected: true, prevId };
    }

    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: 'That game is already under way.' };
    }
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: `This game is full (${MAX_PLAYERS} players).` };
    }

    this.players.push({ id, name: clean, isHost, clientId, online: true, team: 0 });
    if (isHost) this.hostId = id;
    this._resyncSeating();
    return { ok: true, reconnected: false };
  }

  _remapPlayerId(oldId, newId) {
    const player = this.players.find((p) => p.id === oldId);
    if (player) player.id = newId;
    if (this.hands[oldId]) {
      this.hands[newId] = this.hands[oldId];
      delete this.hands[oldId];
    }
    if (this.hostId === oldId) this.hostId = newId;
  }

  /**
   * A connection dropped. In the lobby the seat is released outright — Sequence
   * needs an exact player count (4, 6, 8...) to split into equal teams, so a
   * ghost seat would block the start for everyone. Once play begins the seat is
   * held so the player can reconnect into their own hand.
   */
  markOffline(id) {
    const player = this.players.find((p) => p.id === id);
    if (!player) return;
    if (this.phase === PHASES.LOBBY) {
      this.players = this.players.filter((p) => p.id !== id);
      delete this.hands[id];
      this._resyncSeating();
      return;
    }
    player.online = false;
  }

  /**
   * Take ownership of a restored snapshot after the host's tab reloaded.
   *
   * The reload destroyed every peer connection, so the snapshot's `online` flags
   * all point at dead peer ids. They have to be cleared: addPlayer() reads
   * `online` to decide whether a name is already taken, so leaving them set
   * makes every genuine rejoin look like an impostor and locks the whole table
   * out of the game we just restored.
   */
  resumeAsHost(hostId) {
    this.hostId = hostId;
    for (const p of this.players) {
      p.online = p.id === hostId;
      if (p.online) p.isHost = true;
    }
  }

  getPlayer(id) { return this.players.find((p) => p.id === id); }

  get currentPlayer() { return this.players[this.turn] || null; }

  /** Teams follow seat order, and the config is re-clamped to the new count. */
  _resyncSeating() {
    this.config = normalizeConfig(this.config, this.players.length);
    this.players.forEach((p, i) => { p.team = i % this.config.numTeams; });
  }

  // -------------------------------------------------------------------------
  // Lobby controls (host only)
  // -------------------------------------------------------------------------

  setConfig(patch) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };
    this.config = normalizeConfig({ ...this.config, ...patch }, this.players.length);
    this._resyncSeating();
    return { ok: true };
  }

  /** Move a player one seat up (-1) or down (+1). Changes their team. */
  movePlayer(playerId, dir) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };
    const from = this.players.findIndex((p) => p.id === playerId);
    const to = from + (dir < 0 ? -1 : 1);
    if (from < 0 || to < 0 || to >= this.players.length) return { ok: false, error: 'Cannot move any further.' };
    [this.players[from], this.players[to]] = [this.players[to], this.players[from]];
    this._resyncSeating();
    return { ok: true };
  }

  randomizeOrder() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };
    this.players = shuffle(this.players);
    this._resyncSeating();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Starting a game
  // -------------------------------------------------------------------------

  startGame(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can start the game.' };
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The game has already started.' };

    const check = validateStart(this.players.length, this.config.numTeams);
    if (!check.ok) return { ok: false, error: check.errors[0] };

    this.layout = this.config.shuffleBoard ? randomLayout(shuffle) : CLASSIC_LAYOUT.slice();
    this.cellIndex = buildCellIndex(this.layout);
    this.chips = new Array(CELL_COUNT).fill(null);
    this.sequences = [];
    this.discards = [];
    this.deck = shuffle(buildDeck());
    this.hands = {};
    this.winner = null;
    this.lastMove = null;
    this.log = [];
    this.deadUsed = 0;

    const handSize = this.handSize;
    for (const p of this.players) this.hands[p.id] = [];
    for (let i = 0; i < handSize; i++) {
      for (const p of this.players) this._draw(p.id);
    }

    // A rematch starts with the next seat along, so the same player doesn't
    // always get the first-move advantage.
    this.turn = this.players.length ? this.gamesPlayed % this.players.length : 0;
    this.phase = PHASES.PLAY;
    this._log(`${describeSeating(this.players.length, this.config.numTeams)} — ${this.sequencesToWin} sequence${this.sequencesToWin > 1 ? 's' : ''} to win.`);
    // House rules go in the log as well as the lobby, so a player who is looking
    // at the board rather than the summary still finds out what game this is —
    // and so does anyone scrolling back to work out why a move was refused.
    const house = describeHouseRules(this.config);
    if (house.length) this._log(`House rules: ${house.join(', ')}.`);
    return { ok: true };
  }

  get handSize() { return handSizeFor(this.players.length); }
  get sequencesToWin() { return winTargetFor(this.config); }

  // -------------------------------------------------------------------------
  // Playing a turn
  // -------------------------------------------------------------------------

  /**
   * Play one card: cover a matching space, drop a wild chip anywhere (two-eyed
   * Jack), or lift an opponent's chip (one-eyed Jack). The card is discarded and
   * replaced from the deck, then the turn passes.
   */
  playCard(playerId, cardId, cell) {
    const guard = this._requireTurn(playerId);
    if (!guard.ok) return guard;

    const hand = this.hands[playerId] || [];
    const index = hand.findIndex((c) => c.id === cardId);
    if (index < 0) return { ok: false, error: 'That card is not in your hand.' };

    const card = hand[index];
    const player = this.getPlayer(playerId);
    const targets = legalTargets(card.code, this._boardView(player.team));
    if (!Number.isInteger(cell) || !targets.includes(cell)) {
      return { ok: false, error: this._illegalMoveReason(card.code, cell, targets) };
    }

    const removal = isOneEyedJack(card.code);
    let sequencesWon = [];

    if (removal) {
      this.chips[cell] = null;
    } else {
      this.chips[cell] = player.team;
      sequencesWon = newSequencesAt(cell, player.team, this.chips, this.sequences, this.config);
      for (const cells of sequencesWon) this.sequences.push({ team: player.team, cells });
    }

    hand.splice(index, 1);
    this.discards.push(card);
    this._draw(playerId);

    this.lastMove = {
      playerId, name: player.name, team: player.team,
      code: card.code, cell,
      action: removal ? 'remove' : (isTwoEyedJack(card.code) ? 'wild' : 'place'),
      cells: sequencesWon.flat(),
    };

    const where = cellName(cell);
    if (removal) {
      this._log(`${player.name} removed a chip from ${where} with ${cardLabel(card.code)}.`, player.team);
    } else if (isTwoEyedJack(card.code)) {
      this._log(`${player.name} played ${cardLabel(card.code)} as a wild on ${where}.`, player.team);
    } else {
      this._log(`${player.name} played ${cardLabel(card.code)} on ${where}.`, player.team);
    }
    for (const _ of sequencesWon) {
      this._log(`${teamTheme(player.team).name} completed a sequence!`, player.team);
    }

    if (this._sequenceCount(player.team) >= this.sequencesToWin) {
      this.winner = player.team;
      this.phase = PHASES.GAME_OVER;
      this.gamesPlayed++;
      this._log(`${teamTheme(player.team).name} wins the game.`, player.team);
      return { ok: true };
    }

    this._advanceTurn();
    return { ok: true };
  }

  /**
   * Swap out a card whose spaces are both covered. Officially one per turn; the
   * host can widen or close that allowance in the lobby.
   */
  exchangeDeadCard(playerId, cardId) {
    const guard = this._requireTurn(playerId);
    if (!guard.ok) return guard;

    if (this.config.deadCardsPerTurn <= 0) {
      return { ok: false, error: 'Dead-card swaps are switched off for this game.' };
    }
    if (this.deadUsed >= this.config.deadCardsPerTurn) {
      return { ok: false, error: `Only ${this.config.deadCardsPerTurn} dead card${this.config.deadCardsPerTurn > 1 ? 's' : ''} per turn.` };
    }

    const hand = this.hands[playerId] || [];
    const index = hand.findIndex((c) => c.id === cardId);
    if (index < 0) return { ok: false, error: 'That card is not in your hand.' };

    const card = hand[index];
    const player = this.getPlayer(playerId);
    if (!isDeadCard(card.code, this._boardView(player.team))) {
      return { ok: false, error: `${cardLabel(card.code)} still has an open space — it is not dead.` };
    }

    hand.splice(index, 1);
    this.discards.push(card);
    this._draw(playerId);
    this.deadUsed++;
    this._log(`${player.name} swapped the dead ${cardLabel(card.code)}.`, player.team);
    return { ok: true };
  }

  /**
   * Give up the turn. Only allowed with genuinely nothing to do: no card can be
   * played and no dead card can be swapped. Without this a hand of one-eyed
   * Jacks with no removable chip on the board would deadlock the game.
   */
  pass(playerId) {
    const guard = this._requireTurn(playerId);
    if (!guard.ok) return guard;
    if (!this.canPass(playerId)) return { ok: false, error: 'You still have a legal move.' };

    const player = this.getPlayer(playerId);
    this._log(`${player.name} had no legal move and passed.`, player.team);
    this._advanceTurn();
    return { ok: true };
  }

  /** Host override for a player who has disconnected or gone away mid-turn. */
  skipTurn(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can skip a turn.' };
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'No turn to skip.' };
    const player = this.currentPlayer;
    if (player) this._log(`Host skipped ${player.name}'s turn.`, player.team);
    this._advanceTurn();
    return { ok: true };
  }

  endGame(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can end the game.' };
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'No game in progress.' };
    this.phase = PHASES.GAME_OVER;
    this.winner = null;
    this.gamesPlayed++;
    this._log('The host ended the game.');
    return { ok: true };
  }

  /** Back to the lobby with the same table, board cleared. */
  playAgain(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can start a rematch.' };
    if (this.phase !== PHASES.GAME_OVER) return { ok: false, error: 'The game is still running.' };
    this.phase = PHASES.LOBBY;
    this.chips = new Array(CELL_COUNT).fill(null);
    this.sequences = [];
    this.deck = [];
    this.discards = [];
    this.hands = {};
    this.winner = null;
    this.lastMove = null;
    this.log = [];
    this.deadUsed = 0;
    // Players who dropped during the finished game shouldn't hold seats in the
    // rematch — the count has to divide into equal teams again.
    this.players = this.players.filter((p) => p.online);
    this._resyncSeating();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Derived queries
  // -------------------------------------------------------------------------

  /**
   * The read-only bundle the pure rule functions need.
   *
   * `config` rides along because the house rules change what is legal, and this
   * is the one place legalTargets is ever handed its board — so a rule added to
   * config reaches validation, the highlights and hasLegalMove together, and
   * cannot end up enforced in one of the three and not the others.
   */
  _boardView(team) {
    return {
      layout: this.layout,
      cellIndex: this.cellIndex,
      chips: this.chips,
      sequences: this.sequences,
      config: this.config,
      team,
    };
  }

  _sequenceCount(team) {
    return this.sequences.filter((s) => s.team === team).length;
  }

  hasLegalMove(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return false;
    const board = this._boardView(player.team);
    return (this.hands[playerId] || []).some((c) => legalTargets(c.code, board).length > 0);
  }

  hasDeadCardSwap(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return false;
    if (this.deadUsed >= this.config.deadCardsPerTurn) return false;
    const board = this._boardView(player.team);
    return (this.hands[playerId] || []).some((c) => isDeadCard(c.code, board));
  }

  canPass(playerId) {
    return !this.hasLegalMove(playerId) && !this.hasDeadCardSwap(playerId);
  }

  _requireTurn(playerId) {
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'The game is not running.' };
    const current = this.currentPlayer;
    if (!current || current.id !== playerId) return { ok: false, error: "It is not your turn." };
    return { ok: true };
  }

  // Each line has to describe the rule THIS table is playing, not the one in the
  // box: with the highlights off this text is the only thing telling a player why
  // their tap did nothing, so a house rule it contradicts would read as a bug.
  _illegalMoveReason(code, cell, targets) {
    const anyChip = !!this.config.jacksRemoveAny;
    const whoseChip = anyChip ? 'chip' : 'opponent chip';
    if (targets.length === 0) {
      if (isOneEyedJack(code)) return `There is no ${whoseChip} that can be removed.`;
      return `${cardLabel(code)} has no open space — swap it as a dead card.`;
    }
    if (!Number.isInteger(cell)) return 'Pick a space on the board.';
    if (isOneEyedJack(code)) {
      if (this.chips[cell] == null) return `That space is empty — a one-eyed Jack removes ${anyChip ? 'a' : 'an opponent\'s'} chip.`;
      const mine = this.currentPlayer ? this.currentPlayer.team : null;
      if (!anyChip && this.chips[cell] === mine) {
        return 'That is your own team\'s chip — a one-eyed Jack only lifts an opponent\'s.';
      }
      return 'That chip is part of a completed sequence, so it cannot be removed.';
    }
    if (this.chips[cell] != null) return 'That space is already taken.';
    if (isCorner(cell)) {
      // Hard corners make a corner an ordinary space, but still one with no card
      // printed on it — so the reason it rejected a numbered card is different.
      return this.config.hardCorners
        ? 'No card is printed on a corner — only a wild Jack can cover one this game.'
        : 'The corners are free spaces — they are already everyone\'s.';
    }
    return `${cardLabel(code)} does not match that space.`;
  }

  _advanceTurn() {
    if (!this.players.length) return;
    this.turn = (this.turn + 1) % this.players.length;
    this.deadUsed = 0;
  }

  /**
   * Draw one card. When the deck runs out the discards are shuffled back into
   * it, exactly as in the physical game. If both are empty (a very long game)
   * hands simply shrink — play continues with fewer cards.
   */
  _draw(playerId) {
    if (!this.deck.length && this.discards.length) {
      this.deck = shuffle(this.discards);
      this.discards = [];
      this._log('Deck ran out — discards reshuffled.');
    }
    const card = this.deck.pop();
    if (!card) return;
    if (!this.hands[playerId]) this.hands[playerId] = [];
    this.hands[playerId].push(card);
  }

  _log(text, team = null) {
    this.log.push({ text, team });
    if (this.log.length > LOG_LIMIT) this.log = this.log.slice(-LOG_LIMIT);
  }

  // -------------------------------------------------------------------------
  // Persistence — a host reload rehydrates the game in progress.
  // -------------------------------------------------------------------------

  serialize() {
    return {
      phase: this.phase,
      hostId: this.hostId,
      players: this.players,
      config: this.config,
      layout: this.layout,
      chips: this.chips,
      sequences: this.sequences,
      deck: this.deck,
      discards: this.discards,
      hands: this.hands,
      turn: this.turn,
      deadUsed: this.deadUsed,
      lastMove: this.lastMove,
      log: this.log,
      winner: this.winner,
      gamesPlayed: this.gamesPlayed,
    };
  }

  restore(s) {
    if (!s) return;
    this.reset();
    Object.assign(this, s);
    // cellIndex is a Map, so it never survives JSON — rebuild it from the layout
    // rather than trusting a serialized copy.
    this.cellIndex = buildCellIndex(this.layout);
  }

  // -------------------------------------------------------------------------
  // Views sent over the wire
  // -------------------------------------------------------------------------

  lobbyInfo(hostName) {
    return {
      hostName: hostName || '',
      playerCount: this.players.length,
      phase: this.phase,
      joinable: this.phase === PHASES.LOBBY && this.players.length < MAX_PLAYERS,
    };
  }

  /**
   * What every device may see. Deliberately excludes `hands`, `deck` and
   * `discards` — only their counts go out, so no device can learn another
   * player's cards or what is left to come.
   */
  publicState() {
    const current = this.currentPlayer;
    return {
      phase: this.phase,
      hostId: this.hostId,
      winner: this.winner,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, team: p.team, online: p.online, isHost: p.isHost,
        handCount: (this.hands[p.id] || []).length,
      })),
      config: this.config,
      handSize: this.handSize,
      sequencesToWin: this.sequencesToWin,
      seatingLabel: describeSeating(this.players.length, this.config.numTeams),
      layout: this.layout,
      chips: this.chips,
      sequences: this.sequences,
      seqCounts: Array.from({ length: this.config.numTeams }, (_, t) => this._sequenceCount(t)),
      turnPlayerId: current ? current.id : null,
      turnSeat: this.turn,
      deckCount: this.deck.length,
      discardCount: this.discards.length,
      deadUsed: this.deadUsed,
      deadLimit: this.config.deadCardsPerTurn,
      lastMove: this.lastMove,
      log: this.log,
      startCheck: validateStart(this.players.length, this.config.numTeams),
    };
  }

  /** One player's own cards, and what they may do with them. */
  privateStateFor(id) {
    const player = this.getPlayer(id);
    if (!player) return null;
    const board = this._boardView(player.team);
    const hand = (this.hands[id] || []).map((c) => ({
      id: c.id,
      code: c.code,
      dead: isDeadCard(c.code, board),
      targets: legalTargets(c.code, board),
    }));
    return {
      playerId: id,
      team: player.team,
      hand,
      isTurn: this.phase === PHASES.PLAY && !!this.currentPlayer && this.currentPlayer.id === id,
      canPass: this.phase === PHASES.PLAY ? this.canPass(id) : false,
      deadRemaining: Math.max(0, this.config.deadCardsPerTurn - this.deadUsed),
    };
  }
}
