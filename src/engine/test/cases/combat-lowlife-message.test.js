// Ruthless Lowlife ("can only attack rival Units") attacking a Gig area must say so,
// not "only attack spent units the turn it enters play".
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig } = require('./_helpers');

const b = mainBoard();
b.p2.zones.gigs.push(gig('g1', 6, 3, 'p2'));
const lowlife = unit(b, 'p1', 'WNTC-017');
assert.throws(() => E.step(b, { step: 'declare_attack', attacker_iid: lowlife.iid, target: { kind: 'gigs' } }),
  e => /only attack rival Units/.test(e.message), 'error names the real restriction');
console.log('ok');
