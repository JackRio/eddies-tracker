// Trust No One: "Decrease a Gig by up to 3. Then, if you control a min Gig, draw 1."
// "a Gig" is any Gig, yours or a rival's (confirmed by the user; same wording as Dexter
// DeShawn's "Increase a Gig", whose FAQ allows a rival Gig). The draw still checks only
// your own Gigs for a min Gig (a die showing 1).
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig } = require('./_helpers');

const b = mainBoard();
b.p1.zones.gigs = [gig('M1', 4, 1, 'p1')];                  // friendly min Gig -> draw 1
b.p2.zones.gigs = [gig('R9', 12, 9, 'p2')];
b.p1.zones.hand.push({ iid: 'TNO', card_id: 'WNTC-139' });
const [e] = eddies(b, 'p1', 1);
let r = E.step(b, { step: 'tap_resource', iid: e });
r = E.step(r.board, { step: 'play_card', iid: 'TNO' });
const handAfterPlay = r.board.p1.zones.hand.length;

assert.strictEqual(r.waitingFor?.step, 'effect_choice', 'Trust No One should ask which Gig to decrease');
const cn = r.waitingFor.choice_needed;
assert.strictEqual(cn.kind, 'choose_gig');
assert.ok(cn.available_iids.includes('R9'), 'the rival Gig must be a legal target');
r = E.step(r.board, { step: 'effect_choice_response', response: { iid: 'R9' } });
r = E.step(r.board, { step: 'effect_choice_response', response: { amount: 3 } });

assert.strictEqual(r.board.p2.zones.gigs.find(g => g.iid === 'R9').value, 6, 'rival Gig 9 -> 6');
assert.strictEqual(r.board.p1.zones.gigs.find(g => g.iid === 'M1').value, 1, 'own Gig untouched');
assert.strictEqual(r.board.p1.zones.hand.length, handAfterPlay + 1, 'friendly min Gig -> draw 1');
console.log('ok');
