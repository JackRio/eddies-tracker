// "Increase a Gig by up to N" only offers amounts the chosen die can take (rule 6.4.4: an adjust to a value
// not on its faces fails; FAQ: "up to" means any amount up to N). Found in a user game: Industrial Assembly
// on a rival d4 at 2 offered 1-4, the user picked 4, and the die stayed at 2. Now it offers 1-2.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig, run } = require('./_helpers');

function play(dieValue, pick) {
  const b = mainBoard();
  b.p1.zones.gigs = [gig('mine', 8, 3, 'p1')];
  b.p2.zones.gigs = [gig('d4', 4, dieValue, 'p2')];
  b.p1.zones.hand = [{ iid: 'ia', card_id: 'WNTC-033' }];   // Industrial Assembly: increase a Gig by up to 4
  b.p1.tapped = eddies(b, 'p1', 3);
  let range = null;
  const r = run(E.step(b, { step: 'play_card', iid: 'ia' }), x => x.waitingFor?.step === 'main_phase', wf => {
    const cn = wf.step === 'effect_choice' && wf.choice_needed;
    if (cn && cn.kind === 'choose_gig') return { step: 'effect_choice_response', response: { iid: 'd4' } };
    if (cn && cn.kind === 'choose_amount') { range = [cn.min, cn.max]; return { step: 'effect_choice_response', response: { amount: pick(cn) } }; }
    return null;
  });
  return { range, value: r.board.p2.zones.gigs.find(g => g.iid === 'd4').value };
}

{ const x = play(2, cn => cn.max); assert.deepStrictEqual(x.range, [1, 2], 'd4 at 2: only +1 or +2 fit'); assert.strictEqual(x.value, 4, '+2 takes it to its max'); }
{ const x = play(1, cn => cn.max); assert.deepStrictEqual(x.range, [1, 3], 'd4 at 1: +1..+3'); assert.strictEqual(x.value, 4); }
{ const x = play(4, cn => cn.max); assert.deepStrictEqual(x.range, [1, 1], 'a max d4: nothing fits, the smallest amount stays'); assert.strictEqual(x.value, 4, 'and fails, leaving it at 4'); }
console.log('ok');
