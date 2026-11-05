'use strict';

const { DB } = require('./cards');
const { shuffle } = require('./rng');
const { traceInit } = require('./trace');
const { OPENING_HAND_SIZE, DECK_MIN_CARDS, DECK_MAX_CARDS, LEGEND_COUNT } = require('./constants');

function emptyZones(id) {
  return {
    hand: [], deck: [], trash: [], removed: [],
    legends: [], eddies: [], field: [],
    fixer: [4,6,8,10,12,20].map(s => ({ iid: `${id}_d${s}`, sides: s, value: 0 })),
    gigs: [],
  };
}

function createBoard() {
  const mp = id => ({
    id, zones: emptyZones(id),
    called_legend_this_turn: false,
    sold_card_this_turn: false,
    tapped: [],
    took_gig_this_turn: false,
  });
  const b = {
    p1: mp('p1'), p2: mp('p2'),
    turn_number: 0, active_player: 'p1', first_player: 'p1',
    phase: 'between_turns',
    current_attack: null, effect_stack: [], scheduled_effects: [],
    rate_limits: { p1: {}, p2: {} },
    overtime: false, winner: null, _next_iid: 1,
    _rng_seq: 0, _rngMap: null,
  };
  traceInit(b);
  return b;
}

function legendBaseName(c) {
  const sub = c.subname;
  return sub && c.name.endsWith(`: ${sub}`) ? c.name.slice(0, -(sub.length + 2)) : c.name;
}

function expandDeck(deckDef) {
  const ids = [];
  for (const { card_id, count } of deckDef.cards)
    for (let i = 0; i < count; i++) ids.push(card_id);
  return ids;
}

function validateDeck(deckDef) {
  const { legends = [], cards = [] } = deckDef;
  const errors = [], warnings = [];

  if (legends.length !== LEGEND_COUNT)
    errors.push(`Need exactly ${LEGEND_COUNT} legends, found ${legends.length}`);

  const legendNames = new Set();
  let dupLegendNames = false;
  for (const id of legends) {
    const c = DB[id];
    if (!c) { errors.push(`Unknown legend card "${id}"`); continue; }
    if (c.type !== 'Legend') { errors.push(`"${c.name}" is not a Legend`); continue; }
    if (c.legal === false) errors.push(`"${c.name}" is not legal for play`);
    const base = legendBaseName(c);
    if (legendNames.has(base)) {
      errors.push(`Two Legends named "${base}" — Legends must have different names`);
      dupLegendNames = true;
    }
    legendNames.add(base);
  }

  let total = 0;
  let overCopies = false;
  let badCount = false;
  // 7.3.4: max 3 copies of an identical name + subtitle, summed across list entries
  // and across different card numbers (reprints).
  const copies = new Map();
  for (const { card_id, count } of cards) {
    const c = DB[card_id];
    if (!c) { errors.push(`Unknown card "${card_id}"`); continue; }
    if (!Number.isInteger(count) || count < 1) {
      errors.push(`"${c.name}": count must be a whole number of 1 or more`);
      badCount = true;
      continue;
    }
    if (c.type === 'Legend') errors.push(`"${c.name}" must be in legends list, not deck`);
    if (c.legal === false) errors.push(`"${c.name}" is not legal for play`);
    const key = `${c.name}\u0000${c.subname || ''}`;
    const e = copies.get(key) || { name: c.name, n: 0 };
    e.n += count; copies.set(key, e);
    total += count;
  }
  for (const { name, n } of copies.values())
    if (n > 3) { errors.push(`"${name}": ${n} copies (max 3)`); overCopies = true; }

  if (total < DECK_MIN_CARDS) errors.push(`${total} deck cards (min ${DECK_MIN_CARDS})`);
  if (total > DECK_MAX_CARDS) errors.push(`${total} deck cards (max ${DECK_MAX_CARDS})`);

  const ramPool = {};
  for (const id of legends) {
    const c = DB[id];
    if (!c) continue;
    const color = c.color?.toLowerCase();
    if (color) ramPool[color] = (ramPool[color] || 0) + (c.ram || 0);
  }
  let ramInvalid = false;
  for (const { card_id } of cards) {
    const c = DB[card_id];
    if (!c) continue;
    const color = c.color?.toLowerCase();
    const ram   = c.ram || 0;
    if (!color) { warnings.push(`"${c.name}" has no color — skipping RAM check`); continue; }
    if (!(color in ramPool)) {
      errors.push(`"${c.name}" is ${color} but no Legend provides ${color} RAM`);
      ramInvalid = true; continue;
    }
    const pool = ramPool[color] || 0;
    if (ram > pool) { errors.push(`"${c.name}" needs ${ram} ${color} RAM but legends only provide ${pool}`); ramInvalid = true; }
  }

  return { errors, warnings, total, ramInvalid, legendCount: legends.length, overCopies, dupLegendNames, badCount };
}

function deckIsIllegal(deckDef) {
  const { total, ramInvalid, legendCount, overCopies, dupLegendNames, badCount } = validateDeck(deckDef);
  return total < DECK_MIN_CARDS || total > DECK_MAX_CARDS ||
         ramInvalid || legendCount !== 3 || overCopies || dupLegendNames || badCount;
} 
function setupGame(p1DeckDef, p2DeckDef, firstPlayer = 'p1', opts = {}) {
  const b = createBoard();
  b.first_player = firstPlayer;
  if (opts.seed !== undefined) b._rngState = opts.seed | 0;

  const preShuffled = opts.preShuffled || null;

  const makeZones = (id, deckDef, pre) => {
    const z = emptyZones(id);
    if (pre) {
      const handCards = pre.hand    || [];
      const deckCards = pre.deck    || [];
      const legCards  = pre.legends || deckDef.legends;
      z.deck    = [...handCards, ...deckCards].map(cid => ({ iid: String(b._next_iid++), card_id: cid }));
      z.legends = legCards.map(cid => ({
        iid: String(b._next_iid++), card_id: cid, state: 'ready', face: 'face_down', equipped_gear: [],
      }));

      b._rng_seq += 2;
    } else {
      z.deck    = shuffle(b, expandDeck(deckDef)).map(cid => ({ iid: String(b._next_iid++), card_id: cid }));
      z.legends = shuffle(b, deckDef.legends).map(cid => ({
        iid: String(b._next_iid++), card_id: cid, state: 'ready', face: 'face_down', equipped_gear: [],
      }));
    }
    return z;
  };

  // 7.3 — refuse an illegal deck unless the caller opts out (tests / sandboxes).
  if (!opts.skipValidation) {
    for (const [pid, deckDef] of [['p1', p1DeckDef], ['p2', p2DeckDef]]) {
      const pre = preShuffled?.[pid];
      const eff = pre ? _deckFromPre(pre, deckDef) : deckDef;
      const v = validateDeck(eff || {});
      if (deckIsIllegal(eff || {}))
        throw new Error(`Illegal ${pid} deck: ${v.errors.join('; ') || 'RAM/color limits exceeded'} (pass opts.skipValidation to allow)`);
    }
  }

  b.p1.zones = makeZones('p1', p1DeckDef, preShuffled?.p1);
  b.p2.zones = makeZones('p2', p2DeckDef, preShuffled?.p2);

  if (b[firstPlayer].zones.legends[0]) b[firstPlayer].zones.legends[0].state = 'spent';
  if (b[firstPlayer].zones.legends[1]) b[firstPlayer].zones.legends[1].state = 'spent';

  // A deck shorter than the opening hand deals what it has.
  for (let i = 0; i < OPENING_HAND_SIZE; i++) {
    if (b.p1.zones.deck.length) b.p1.zones.hand.push(b.p1.zones.deck.shift());
    if (b.p2.zones.deck.length) b.p2.zones.hand.push(b.p2.zones.deck.shift());
  }

  b.active_player = firstPlayer;
  // 7.9.2 — one mulligan each, first player decides first. step(board, undefined)
  // prompts 'mulligan_decision'; opts.mulligan === false skips straight to turn 1.
  if (opts.mulligan === false) {
    b.phase = 'between_turns';
  } else {
    b.phase = 'mulligan';
    b.mulligan = { order: [firstPlayer, firstPlayer === 'p1' ? 'p2' : 'p1'], next: 0, taken: { p1: false, p2: false } };
  }
  return b;
}

function _deckFromPre(pre, deckDef) {
  const counts = new Map();
  for (const cid of [...(pre.hand || []), ...(pre.deck || [])]) counts.set(cid, (counts.get(cid) || 0) + 1);
  return {
    legends: pre.legends || deckDef?.legends || [],
    cards: [...counts].map(([card_id, count]) => ({ card_id, count })),
  };
}

// 7.9.3 — return the whole opening hand, shuffle, draw 6. Mutates b.
function applyMulligan(b, pid) {
  const z = b[pid].zones;
  z.deck = shuffle(b, [...z.hand, ...z.deck]);
  z.hand = [];
  for (let i = 0; i < OPENING_HAND_SIZE && z.deck.length; i++) z.hand.push(z.deck.shift());
}

module.exports = { validateDeck, deckIsIllegal, setupGame, applyMulligan };
