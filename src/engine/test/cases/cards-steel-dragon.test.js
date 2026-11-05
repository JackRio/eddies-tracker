// Yorinobu Arasaka: Steel Dragon: "The first time an ARASAKA Unit is defeated each turn,
// draw 1." Any ARASAKA Unit (a rival's too), and per FAQ Yorinobu's own defeat counts.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, gig, run } = require('./_helpers');

function overTheEdge(victim) {                       // p1 defeats `victim` with Over the Edge (d20 = 10)
  const b = mainBoard();
  unit(b, 'p1', 'WNTC-022', { iid: 'sd' });          // Steel Dragon, power 9
  unit(b, 'p2', 'WNTC-078', { iid: 'fo' });          // Field Operator (ARASAKA), rival
  b.p1.zones.gigs = [gig('d20', 20, 10, 'p1')];
  b.p1.zones.hand = [{ iid: 'ote', card_id: 'WNTC-034' }];
  b.p1.tapped = eddies(b, 'p1', 3);
  const r = run(E.step(b, { step: 'play_card', iid: 'ote' }), x => x.waitingFor?.step === 'main_phase',
    wf => wf.step === 'effect_choice' && wf.choice_needed.kind === 'choose_unit'
      ? { step: 'effect_choice_response', response: { iid: victim } } : null);
  const all = [...r.board.p1.zones.field, ...r.board.p2.zones.field].map(u => u.iid);
  assert.ok(!all.includes(victim), `${victim} defeated`);
  return r.board.p1.zones.hand.length;
}

assert.strictEqual(overTheEdge('fo'), 1, 'a rival ARASAKA Unit defeated: draw 1');
assert.strictEqual(overTheEdge('sd'), 1, 'Steel Dragon itself defeated: draw 1 (FAQ)');
console.log('ok');
