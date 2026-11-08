// "Set a Gig's value to another Gig's value" (Peace Offering, Padre) only offers Gigs that can show that
// value (rule 6.4.4: a die can't be set above its size - the set fails). Found in a user game: Peace
// Offering copied a rival d10 at 9 onto the user's d8 (offered, picked), the d8 stayed at 3.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig, run } = require('./_helpers');

function play(srcIid) {
  const b = mainBoard();
  b.p1.zones.gigs = [gig('d8', 8, 3, 'p1'), gig('d12', 12, 5, 'p1')];
  b.p2.zones.gigs = [gig('d10', 10, 9, 'p2'), gig('d4', 4, 2, 'p2')];
  b.p1.zones.hand = [{ iid: 'po', card_id: 'WNTC-101' }];   // Peace Offering
  b.p1.tapped = eddies(b, 'p1', 3);
  b.ask_single = { p1: true };   // show the pick even when one Gig fits (play page setting)
  let offered = null, step = 0;
  const r = run(E.step(b, { step: 'play_card', iid: 'po' }), x => x.waitingFor?.step === 'main_phase', wf => {
    const cn = wf.step === 'effect_choice' && wf.choice_needed;
    if (!cn) return null;
    if (cn.kind === 'choose_gig') {
      step++;
      if (step === 1) return { step: 'effect_choice_response', response: { iid: srcIid } };
      offered = [...cn.available_iids].sort();
      return { step: 'effect_choice_response', response: { iid: offered.includes('d8') ? 'd8' : offered[0] } };
    }
    return null;
  });
  const val = id => [...r.board.p1.zones.gigs, ...r.board.p2.zones.gigs].find(g => g.iid === id).value;
  return { offered, val };
}

{ const x = play('d10'); assert.deepStrictEqual(x.offered, ['d12'], 'a 9 fits only the d12 (not the d8, d4, or the source)'); assert.strictEqual(x.val('d12'), 9); assert.strictEqual(x.val('d8'), 3); }
{ const x = play('d4'); assert.deepStrictEqual(x.offered, ['d10', 'd12', 'd8'], 'a 2 fits every other die'); assert.strictEqual(x.val('d8'), 2); }
console.log('ok');

// without the setting, a single fitting Gig is picked automatically (bots) - still the d12, never the d8
{ const b = mainBoard();
  b.p1.zones.gigs = [gig('d8', 8, 3, 'p1'), gig('d12', 12, 5, 'p1')]; b.p2.zones.gigs = [gig('d10', 10, 9, 'p2')];
  b.p1.zones.hand = [{ iid: 'po', card_id: 'WNTC-101' }]; b.p1.tapped = eddies(b, 'p1', 3);
  let n = 0;
  const r = run(E.step(b, { step: 'play_card', iid: 'po' }), x => x.waitingFor?.step === 'main_phase', wf => wf.choice_needed?.kind === 'choose_gig' && ++n === 1 ? { step: 'effect_choice_response', response: { iid: 'd10' } } : null);
  assert.strictEqual(r.board.p1.zones.gigs.find(g => g.iid === 'd12').value, 9); }
