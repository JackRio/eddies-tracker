// Viktor Vektor: Drop Your Illusions — "Play your first CYBERWARE Gear each turn for -3 $,
// to a minimum of 1 $."
//  - "first ... each turn": a Cyberware already played this turn (even before Viktor was in
//    play) uses it up.
//  - FAQ: "If you play a CYBERWARE Gear on your rival's turn, will you still get the -3 $
//    effect?" Yes.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, run } = require('./_helpers');

const GORILLA = E.CARDS.find(c => c.number === 'WNTC-060');   // Gorilla Arms, Cyberware, cost 4
const cost = (b, pid) => E.effectivePlayCost(b, pid, { iid: 'GA', card_id: 'WNTC-060' }, GORILLA);

const b = mainBoard();
unit(b, 'p1', 'WNTC-017', { iid: 'HOST' });
b.p1.zones.hand.push({ iid: 'MB', card_id: 'WNTC-025' }, { iid: 'VIK', card_id: 'WNTC-057' });
const ids = eddies(b, 'p1', 6);
let r = E.step(b, { step: 'tap_resource', iid: ids[0] });
r = E.step(r.board, { step: 'play_card', iid: 'MB', equip_to: 'HOST' });         // Mantis Blades: a Cyberware first
r = run(r, x => x.waitingFor?.step === 'main_phase');
for (const iid of ids.slice(1)) r = E.step(r.board, { step: 'tap_resource', iid });
r = E.step(r.board, { step: 'play_card', iid: 'VIK' });                             // then Viktor
r = run(r, x => x.waitingFor?.step === 'main_phase');
assert.ok(r.board.p1.zones.field.some(u => u.iid === 'VIK'), 'setup: Viktor in play');
assert.strictEqual(cost(r.board, 'p1'), 4,
  'a Cyberware was already played this turn, so this one is not the first: no discount');

r = E.step(r.board, { step: 'end_turn' });
r = run(r, x => x.waitingFor?.step === 'main_phase' && x.board.active_player === 'p2',
        wf => wf.step === 'choose_gig_die' ? { step: 'choose_gig_die', sides: wf.available[0] } : null);
assert.strictEqual(r.board.active_player, 'p2');
assert.strictEqual(cost(r.board, 'p1'), 1, "on the rival's turn your first Cyberware still costs -3 $ (4 -> 1)");
console.log('ok');
