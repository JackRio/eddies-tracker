'use strict';

const CARDS        = require('../data/cards.json');
const CARD_SCRIPTS = require('../data/card_scripts.json');
// An amount chosen for a Gig that is already picked (ChooseAmount followed by Increase/Decrease/AdjustGig of
// that amount on a bound Gig): remember the Gig and the direction, so the choice only offers amounts the
// die can take (rule 6.4.4: an adjust to a value not on the die's faces fails). Increase a d4 at 2 by "up to
// 4" offers 1-2, not 1-4.
(function linkAmountsToGigs(node) {
  if (Array.isArray(node)) {
    node.forEach((e, i) => {
      const nx = node[i + 1];
      if (e && e.action === 'ChooseAmount' && nx && /^(Increase|Decrease|Adjust)Gig$/.test(nx.action)
        && nx.target?.from_binding && nx.amount?.op === 'ref' && nx.amount.name === (e.bind_to || e.bind))
        e._gig = { binding: nx.target.from_binding, dir: nx.action === 'IncreaseGig' ? 'up' : nx.action === 'DecreaseGig' ? 'down' : 'adjust' };
      linkAmountsToGigs(e);
    });
  } else if (node && typeof node === 'object') for (const v of Object.values(node)) if (v && typeof v === 'object') linkAmountsToGigs(v);
})(CARD_SCRIPTS);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const DB = {};
for (const c of CARDS) DB[c.number] = deepFreeze(c);
Object.freeze(DB);

const SCRIPTS = {};
for (const s of CARD_SCRIPTS) SCRIPTS[s.card_id] = deepFreeze(s);
Object.freeze(SCRIPTS);

Object.freeze(CARDS);
Object.freeze(CARD_SCRIPTS);

module.exports = { DB, SCRIPTS, CARDS, CARD_SCRIPTS };
