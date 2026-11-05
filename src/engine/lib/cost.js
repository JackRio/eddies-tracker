'use strict';

const { SCRIPTS } = require('./cards');
const { evalExpr, evalCondition } = require('./eval');
const { matchCard } = require('./filters');

// Pending one-shot "next play" discounts (DiscountNextPlay) that apply to `card`.
function _applicableDiscounts(b, pid, card) {
  return (b._next_play_discounts || []).filter(pd =>
    pd.pid === pid && matchCard(card, pd.filter, b, { self_pid: pid, bindings: {} }));
}

function effectivePlayCost(b, pid, ref, card) {
  let base = card.cost || 0;
  const mod = SCRIPTS[ref.card_id]?.playCostModifier;
  if (mod) {
    const ctx = {
      self_pid: pid, self_iid: ref.iid, self_card_id: ref.card_id,
      bindings: {},
    };
    // Optional gate: when present and false, the whole modifier is skipped —
    // discount AND floor — so the card just costs its printed price
    // (We Gotta Live Together, Nocturne OP55 N1).
    if (!mod.condition || evalCondition(mod.condition, b, ctx)) {
      const discount = Math.max(0, evalExpr(mod.discount, b, ctx));
      base = Math.max(mod.min ?? 1, base - discount);
    }
  }
  // Applied one after another, each floored at its minimum (a card already
  // cheaper than the minimum is never raised).
  for (const pd of _applicableDiscounts(b, pid, card))
    base = Math.max(Math.min(pd.min ?? 1, base), base - pd.discount);
  for (const st of _firstOfTurnDiscounts(b, pid, card))
    base = Math.max(Math.min(st.min ?? 1, base), base - (st.amount || 0));
  return base;
}

// Static `FirstOfTurnPlayDiscount` on a friendly card in play (Viktor Vektor: Drop
// Your Illusions — "Play your first CYBERWARE Gear each turn for -3 $, min 1 $"),
// on either player's turn. "First" is tracked by the card's own marker ability
// (triggered OnCardPlayed, rate_limit first_per_turn, scope 'controller'), which
// events.js records for every matching play even while the card is not in play —
// so a Cyberware played earlier in the turn uses it up.
function _firstOfTurnDiscounts(b, pid, card) {
  const P = require('./primitives');
  const out = [];
  const zones = b[pid]?.zones;
  if (!zones) return out;
  const refs = [...zones.field, ...zones.legends.filter(l => l.face === 'face_up')];
  for (const ref of refs) {
    for (const st of (SCRIPTS[ref.card_id]?.statics || [])) {
      if (st.kind !== 'FirstOfTurnPlayDiscount') continue;
      if (!matchCard(card, st.filter, b, { self_pid: pid, bindings: {} })) continue;
      if (P.hasTriggered(b, pid, `__controller__:${ref.card_id}`, st.marker_event || 'OnCardPlayed')) continue;
      out.push(st);
    }
  }
  return out;
}

function consumeNextPlayDiscount(b, pid, card) {
  const used = new Set(_applicableDiscounts(b, pid, card));
  if (used.size) b._next_play_discounts = b._next_play_discounts.filter(d => !used.has(d));
}

module.exports = { effectivePlayCost, consumeNextPlayDiscount };
