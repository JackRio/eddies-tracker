// 9.3.2.2 — an empty rival Gig area is not a valid attack target; 9.3.2.4 — a Unit
// with no valid target can't attack, so it isn't listed in `attackable`.
'use strict';
const assert = require('assert');
const { E, mainBoard, mainWaiting, unit, gig } = require('./_helpers');

const b = mainBoard();
assert.strictEqual(b.p2.zones.gigs.length, 0, 'setup: p2 has no Gigs on turn 1');
const royce = unit(b, 'p1', 'WNTC-016');                         // Royce, P4
assert.throws(() => E.step(b, { step: 'declare_attack', attacker_iid: royce.iid, target: { kind: 'gigs' } }),
  /empty|not a valid/i, 'attacking an empty Gig area must be refused');
assert.ok(!mainWaiting(b).attackable.includes(royce.iid), 'a Unit with no valid target is not attackable');

// With a Gig in the rival area the Unit is listed with the Gig area as a target.
b.p2.zones.gigs.push(gig('g1', 6, 3, 'p2'));
const w = mainWaiting(b);
assert.ok(w.attackable.includes(royce.iid));
assert.strictEqual(w.attack_targets[royce.iid].gigs, true);
console.log('ok');
