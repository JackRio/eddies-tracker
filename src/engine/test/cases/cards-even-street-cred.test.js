// FAQ (Field Operator): "If your Street Cred is 0, is that considered an even number? No."
// Same check on Pacifica Netrunner and Memory Relapse.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, run } = require('./_helpers');

function play(cardId, setup) {
  const b = mainBoard();
  b.p1.zones.gigs = [];                                    // Street Cred 0
  if (setup) setup(b);
  b.p1.zones.hand = [{ iid: 'c', card_id: cardId }];
  b.p1.tapped = eddies(b, 'p1', E.CARDS.find(c => c.number === cardId).cost);
  return run(E.step(b, { step: 'play_card', iid: 'c' }), x => x.waitingFor?.step === 'main_phase');
}

let r = play('WNTC-078');                                   // Field Operator
assert.strictEqual(r.board.p1.zones.hand.length, 0, 'Field Operator: 0 Street Cred is not even, no draw');

r = play('WNTC-100', b => unit(b, 'p2', 'WNTC-077', { iid: 'rv' }));   // Memory Relapse
assert.strictEqual(r.board.p1.zones.hand.length, 0, 'Memory Relapse: no draw at 0 Street Cred');

r = play('WNTC-084', b => unit(b, 'p2', 'WNTC-077', { iid: 'rv' }));   // Pacifica Netrunner
const rv = r.board.p2.zones.field.find(u => u.iid === 'rv');
assert.ok(!(rv._until_keywords || []).some(k => k.kw === 'CANNOT_READY'), 'Pacifica: no lock at 0 Street Cred');
console.log('ok');
