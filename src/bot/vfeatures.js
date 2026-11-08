// Input encoding for the value net: what `pid` can know at a position, as
//   dense:  the aggregate features of features.js (both sides + turn), 45 numbers
//   sparse: card counts per (zone group, card) - "bags" over the engine's whole card pool, so any
//           deck can be encoded; cards never seen in training just carry untrained weights.
// Never encoded: the Rival's hand cards (only their count, in dense), any deck order, Eddie faces.
'use strict';
const { CARDS } = require('../engine');
const { features } = require('./features');
const { opp } = require('../coach/policy');
const gig = require('./gigfeatures');

// legal cards only: Rebecca: Having a Moment (PRM01-005) is a no-text promo marked legal: false
const VOCAB = CARDS.filter(c => c.legal !== false).map(c => c.number).sort();
const INDEX = new Map(VOCAB.map((n, i) => [n, i]));
const V = VOCAB.length;
const BAGS = ['myHand', 'myField', 'myReady', 'myLegUp', 'myLegDown', 'myGear', 'myDeck',
  'rvField', 'rvReady', 'rvLegUp', 'rvGear', 'myTrash', 'rvTrash'];
const DENSE = 45;
const SIZE = DENSE + BAGS.length * V;
// nets trained with the Gig language (src/bot/gigfeatures.js) take DENSE_GIG dense inputs; the card bags
// then start at DENSE_GIG. encode(b, pid, D) builds whichever the net expects (its `dense` size).
const DENSE_GIG = DENSE + gig.N;

// -> { dense: number[D], sparse: [[index, count], ...] } (index into the full D + bags vector)
function encode(b, pid, D = DENSE) {
  const me = b[pid].zones, rv = b[opp(pid)].zones;
  const counts = new Map();
  const add = (bag, card) => {
    const i = INDEX.get(card);
    if (i === undefined) return;
    const k = D + BAGS.indexOf(bag) * V + i;
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  for (const c of me.hand) add('myHand', c.card_id);
  for (const c of me.deck) add('myDeck', c.card_id);   // contents are known (your own list), order isn't
  for (const c of me.trash) add('myTrash', c.card_id);
  for (const c of rv.trash) add('rvTrash', c.card_id);
  for (const [Z, f, r, up, down, gear] of [[me, 'myField', 'myReady', 'myLegUp', 'myLegDown', 'myGear'], [rv, 'rvField', 'rvReady', 'rvLegUp', null, 'rvGear']]) {
    for (const u of Z.field) {
      add(f, u.card_id);
      if (u.state === 'ready') add(r, u.card_id);
      for (const g of u.equipped_gear || []) add(gear, g.card_id);
    }
    for (const l of Z.legends) {
      if (l.face === 'face_up') add(up, l.card_id);
      else if (down) add(down, l.card_id);             // your own face-down Legends; never the Rival's
      for (const g of l.equipped_gear || []) add(gear, g.card_id);
    }
  }
  return { dense: D > DENSE ? [...features(b, pid), ...gig.gigFeatures(b, pid)] : features(b, pid), sparse: [...counts] };
}

module.exports = { encode, VOCAB, BAGS, DENSE, DENSE_GIG, SIZE, V };
