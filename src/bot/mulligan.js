// Keep or mulligan for the bots (rule 7.9: one mulligan, the whole hand goes back, shuffle, draw 6).
//
// The search bots can't judge this - their position score only counts cards in hand, so keeping
// and redrawing always tied and every hand was kept. Instead an opening hand is scored by rules a
// player uses, and compared with the hands a mulligan could give:
//   - Eddies: one sale a turn builds them, so a hand needs sellable cards (none = stuck on Legends)
//   - an early board: a Unit castable on your first turn, more Units by your second
//   - clunk: several 6+ cost cards
// Your €$ on your first turn depend on the seat (rule 7.7.4: going first, your 2 left-most Legends
// start spent): first = 1 ready Legend + 1 sale = 2, second = 3 Legends + 1 sale = 4; everyone has
// about 5 on their second turn. So going second a 4-drop is an opening play, going first it isn't.
// The redraw is random, so the bot only mulligans when its hand is clearly below what a fresh 6
// usually looks like (bottom ~25% of sampled hands): a slightly weak hand beats the gamble.
'use strict';
const { CARDS } = require('../engine');

const BY = new Map(CARDS.map(c => [c.number, c]));
const SAMPLES = 400, KEEP_PCT = +(process.env.MULL_PCT ?? 0.25), MARGIN = +(process.env.MULL_MARGIN ?? 1);   // env: tuning runs only

function handScore(ids, first) {
  const cards = ids.map(id => BY.get(id) || {});
  const cost = c => (c.cost ?? 99);
  const R1 = first ? 2 : 4, R2 = 5;
  const units = cards.filter(c => c.type === 'Unit');
  const sell = cards.filter(c => c.eddie).length;
  let s = 0;
  s += sell === 0 ? -6 : sell === 1 ? 2 : sell <= 3 ? 3.5 : 3.5 - (sell - 3);   // all-sell hands do nothing
  const unitT1 = units.some(c => cost(c) <= R1), anyT1 = cards.some(c => cost(c) <= R1);
  s += unitT1 ? 3 : anyT1 ? 1.5 : -2;
  s += Math.min(2, units.filter(c => cost(c) <= R2).length) * 1.5;
  s += units.length === 0 ? -4 : units.length >= 2 ? 1 : 0;
  s -= Math.max(0, cards.filter(c => cost(c) >= 6 && cost(c) < 99).length - 1) * 2;
  return s;
}

// decide for wf.owner on board b; rng = () => [0, 1). Returns { mulligan, score, cut, mean }
function decide(b, wf, rng = Math.random) {
  const pid = wf.owner;
  const Z = b[pid].zones;
  const first = (b.first_player || b.mulligan?.order?.[0]) === pid;
  const hand = Z.hand.map(c => c.card_id);
  const pool = [...hand, ...Z.deck.map(c => c.card_id)];
  const score = handScore(hand, first);
  const xs = [];
  for (let n = 0; n < SAMPLES; n++) {
    const p = pool.slice();
    for (let i = 0; i < 6; i++) { const j = i + Math.floor(rng() * (p.length - i)); [p[i], p[j]] = [p[j], p[i]]; }
    xs.push(handScore(p.slice(0, 6), first));
  }
  xs.sort((a, b2) => a - b2);
  const cut = xs[Math.floor(xs.length * KEEP_PCT)], mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  return { mulligan: score < cut && score < mean - MARGIN, score, cut, mean, first };
}

// the move for a mulligan_decision
const choose = (b, wf, rng) => [{ step: 'mulligan', mulligan: decide(b, wf, rng).mulligan }];

module.exports = { handScore, decide, choose };
