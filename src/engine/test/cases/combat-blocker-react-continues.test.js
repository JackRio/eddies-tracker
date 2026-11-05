// 9.7 — after a Blocker redirect the React Step continues: the defender may keep
// reacting (here: redirect again with a second Blocker, 11.28.3.1) until they pass.
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig } = require('./_helpers');

const b = mainBoard();
b.p2.zones.gigs.push(gig('g1', 6, 3, 'p2'));
const att = unit(b, 'p1', 'WNTC-018');                 // Screw, P7
const b1  = unit(b, 'p2', 'WNTC-076');                 // Corpo Security, P2, Blocker
const b2  = unit(b, 'p2', 'WNTC-053');                 // Secondhand Bombus, P0, Blocker

let r = E.step(b, { step: 'declare_attack', attacker_iid: att.iid, target: { kind: 'gigs' } });
assert.strictEqual(r.waitingFor.step, 'defensive_step');
r = E.step(r.board, { step: 'blocker', iid: b1.iid });
assert.strictEqual(r.waitingFor.step, 'defensive_step', 'React Step continues after a redirect');
assert.strictEqual(r.waitingFor.target.iid, b1.iid, 'the Blocker is now the target');
assert.ok(r.waitingFor.blocker_iids.includes(b2.iid), 'another Blocker may redirect again');
assert.ok(!r.waitingFor.blocker_iids.includes(b1.iid), 'the current target cannot redirect to itself');

r = E.step(r.board, { step: 'blocker', iid: b2.iid });
r = E.step(r.board, { step: 'pass_defensive' });
assert.strictEqual(r.waitingFor.step, 'main_phase');
const f2 = r.board.p2.zones.field.map(u => u.iid);
assert.ok(f2.includes(b1.iid), 'the first Blocker did not fight');
assert.ok(!f2.includes(b2.iid), 'the second Blocker fought (P7 vs P0) and was defeated');
assert.strictEqual(r.board.p2.zones.gigs.length, 1, 'nothing was stolen');
console.log('ok');
