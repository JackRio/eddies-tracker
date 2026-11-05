// Rule 8.6.2: "at the start of your turn" effects resolve BEFORE ready (8.6.3), draw (8.6.4)
// and Gig roll-in (8.6.5). Hanako: Daughter of the Emperor counts value-pairs at that moment,
// so a pair created by this turn's roll must not count.
'use strict';
const assert = require('assert');
const { E, newGame } = require('./_helpers');

const d = require('./_helpers').deck('4-red-2-green-standard');
d.legends = ['WNTC-072', d.legends[1], d.legends[2]];          // Hanako + two other Legends
const b = newGame({ p1: d, seed: 7 });
const p = b.p1;
p.zones.legends.find(l => l.card_id === 'WNTC-072').face = 'face_up';
const d4 = p.zones.fixer.shift(); d4.value = 3; p.zones.gigs.push(d4);  // one Gig (3): no pair yet
b._rngMap = { 'd.p1_d6.t1': 0.40 };                                    // d6 rolls 3 -> pair after roll
const hand0 = p.zones.hand.length;

let r = E.step(b, undefined);
r = E.step(r.board, { step: 'choose_gig_die', sides: 6 });
const gigs = r.board.p1.zones.gigs.map(g => g.value);
assert.deepStrictEqual(gigs, [3, 3], 'setup: roll should create a 3/3 pair');
assert.strictEqual(r.board.p1.zones.hand.length, hand0 + 1,
  `Hanako must count pairs at the start of the turn (none), so only the normal draw happens: ` +
  `hand ${hand0} -> ${r.board.p1.zones.hand.length}, expected ${hand0 + 1}`);

// And a pair that already exists at the start of the turn does draw, before the turn's draw.
const b2 = newGame({ p1: d, seed: 7 });
const p2 = b2.p1;
p2.zones.legends.find(l => l.card_id === 'WNTC-072').face = 'face_up';
for (let i = 0; i < 2; i++) { const g = p2.zones.fixer.shift(); g.value = 2; p2.zones.gigs.push(g); }
const h2 = p2.zones.hand.length;
const r2 = E.step(b2, undefined);
assert.strictEqual(r2.waitingFor.step, 'choose_gig_die');
assert.strictEqual(r2.board.p1.zones.hand.length, h2 + 2, 'existing pair: Hanako draw 1 + turn draw 1 before the roll');
console.log('ok');
