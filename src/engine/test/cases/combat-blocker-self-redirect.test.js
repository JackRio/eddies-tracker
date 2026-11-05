// 11.28.3.1 — a Unit can't redirect an attack to itself if it's already the target.
// Valentino Guerrera (more Street Cred) attacks a READY Augmented Negotiators (Blocker).
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig } = require('./_helpers');

const b = mainBoard();
b.p1.zones.gigs = [gig('ga', 20, 20, 'p1')];
b.p2.zones.gigs = [gig('gb', 4, 1, 'p2')];
b.p1.zones.hand = [{ iid: 'h1', card_id: 'WNTC-016' }, { iid: 'h2', card_id: 'WNTC-019' }];
const val = unit(b, 'p1', 'WNTC-021');
const neg = unit(b, 'p2', 'WNTC-043');                       // ready target
const r = E.step(b, { step: 'declare_attack', attacker_iid: val.iid, target: { kind: 'unit', iid: neg.iid } });
assert.strictEqual(r.waitingFor.step, 'defensive_step');
assert.ok(!r.waitingFor.blocker_iids.includes(neg.iid), 'target not offered as its own Blocker');
assert.throws(() => E.step(r.board, { step: 'blocker', iid: neg.iid }), /itself/i);
console.log('ok');
