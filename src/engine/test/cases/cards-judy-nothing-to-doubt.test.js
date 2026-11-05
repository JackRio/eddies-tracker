// Judy Alvarez: Nothing to Doubt — "1 $, {Spend} Reveal the top card of your deck. You may
// play it for free. Otherwise, add it to your hand."
// "Add it to your hand" is not a draw: FAQ says you can activate it with no cards in your
// deck, and doing so must not make you lose. With cards, declining puts that card in hand.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit } = require('./_helpers');

function activateAndDecline(deck) {
  const b = mainBoard();
  unit(b, 'p1', 'WNTC-116', { iid: 'JUDY' });
  b.p1.zones.deck = deck;
  eddies(b, 'p1', 1);
  let r = E.step(b, { step: 'activate_anytime_spend', iid: 'JUDY', ability_idx: 0 });
  for (let i = 0; i < 5 && r.waitingFor?.step === 'effect_choice'; i++) {
    const kind = r.waitingFor.choice_needed.kind;
    const response = kind === 'confirm_optional' ? { accept: false } : { acknowledge: true };
    r = E.step(r.board, { step: 'effect_choice_response', response });
  }
  return r;
}

let r = activateAndDecline([]);
assert.ok(!r.board.winner, 'an empty deck must not lose the game ("add it to your hand" is not a draw)');

r = activateAndDecline([{ iid: 'TOP', card_id: 'WNTC-017' }, { iid: 'NEXT', card_id: 'WNTC-043' }]);
assert.ok(r.board.p1.zones.hand.some(c => c.iid === 'TOP'), 'declining adds the revealed card to hand');
assert.ok(r.board.p1.zones.deck.some(c => c.iid === 'NEXT'), 'only the revealed card moves');
console.log('ok');
