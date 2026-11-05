// Peace Offering: "You may set a Gig's value to the value of another Gig. Then, if you
// control a value-pair, draw 1." Declining the optional set must still check the draw.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig, run } = require('./_helpers');

const b = mainBoard();
b.p1.zones.gigs = [gig('a', 6, 3, 'p1'), gig('b', 8, 3, 'p1')];           // already a value-pair
b.p1.zones.hand = [{ iid: 'po', card_id: 'WNTC-101' }];
b.p1.tapped = eddies(b, 'p1', 1);
let r = E.step(b, { step: 'play_card', iid: 'po' });
r = run(r, x => x.waitingFor?.step === 'main_phase', wf =>
  wf.step === 'effect_choice' && wf.choice_needed.kind === 'confirm_optional'
    ? { step: 'effect_choice_response', response: { accept: false } } : null);
assert.strictEqual(r.board.p1.zones.hand.length, 1, 'declined the set but still drew 1 for the value-pair');
console.log('ok');
