// Industrial Assembly: "Increase a Gig by up to 4." FAQ: "can you choose a rival's Gig? Yes."
// The only side check is the draw ("If you control a Gig with 8+ value").
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig } = require('./_helpers');

const b = mainBoard();
b.p1.zones.gigs = [gig('mine', 6, 2, 'p1')];
b.p2.zones.gigs = [gig('theirs', 8, 3, 'p2')];
b.p1.zones.hand = [{ iid: 'ia', card_id: 'WNTC-033' }];
b.p1.tapped = eddies(b, 'p1', 1);
let r = E.step(b, { step: 'play_card', iid: 'ia' });
assert.strictEqual(r.waitingFor?.choice_needed?.kind, 'choose_gig');
assert.ok(r.waitingFor.choice_needed.available_iids.includes('theirs'), 'a rival Gig can be chosen');
r = E.step(r.board, { step: 'effect_choice_response', response: { iid: 'theirs' } });
r = E.step(r.board, { step: 'effect_choice_response', response: { amount: 4 } });
assert.strictEqual(r.board.p2.zones.gigs[0].value, 7, 'rival Gig increased by 4');
assert.strictEqual(r.board.p1.zones.hand.length, 0, 'no friendly 8+ Gig, so no draw');
console.log('ok');
