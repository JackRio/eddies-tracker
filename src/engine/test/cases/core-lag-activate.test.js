// Rule 11.3.1.2: "Lagging Units can't activate effects." — no {Spend} abilities and no
// Blocker for a Unit the turn it entered the field.
'use strict';
const assert = require('assert');
const { E, newGame, unit, eddies, run } = require('./_helpers');

// --- {Spend} ability on a Unit played this turn (Kerry Eurodyne: The Last Rockerboy)
const b = newGame({ seed: 3 });
const p = b.p1;
const d12 = p.zones.fixer.find(d => d.sides === 12); p.zones.fixer.splice(p.zones.fixer.indexOf(d12), 1);
d12.value = 10; p.zones.gigs.push(d12);                       // satisfies Kerry's "Gig with 8+"
p.zones.hand.push({ iid: 'K1', card_id: 'WNTC-012' });
const ed = eddies(b, 'p1', 4);
let r = E.step(b, undefined);
r = E.step(r.board, { step: 'choose_gig_die', sides: 4 });
for (const iid of ed) r = E.step(r.board, { step: 'tap_resource', iid });
r = E.step(r.board, { step: 'play_card', iid: 'K1' });
const listed = (r.waitingFor.spend_activatable_iids || []).some(o => o.iid === 'K1');
assert.ok(!listed, 'a lagging Unit must not be offered its {Spend} ability');
assert.throws(() => E.step(r.board, { step: 'activate_anytime_spend', iid: 'K1', ability_idx: 0 }),
  'activating a lagging Unit\'s {Spend} ability must be rejected');

// Control: a Unit that entered on an earlier turn can still activate.
const bc = newGame({ seed: 3 });
const pc = bc.p1;
const d12c = pc.zones.fixer.find(d => d.sides === 12); pc.zones.fixer.splice(pc.zones.fixer.indexOf(d12c), 1);
d12c.value = 10; pc.zones.gigs.push(d12c);
unit(bc, 'p1', 'WNTC-012', { iid: 'K2' });
let rc = E.step(bc, undefined);
rc = E.step(rc.board, { step: 'choose_gig_die', sides: 4 });
assert.ok(rc.waitingFor.spend_activatable_iids.some(o => o.iid === 'K2'), 'non-lagging Unit keeps its {Spend} ability');

// --- Blocker on a Unit that entered the field this turn (e.g. put in play on the rival's turn)
const b3 = newGame({ seed: 5 });
unit(b3, 'p2', 'WNTC-124', { iid: 'ATK' });                  // p2 attacker (vanilla 6 power)
let r3 = E.step(b3, undefined);                              // p1 turn 1
r3 = E.step(r3.board, { step: 'choose_gig_die', sides: 4 });
r3 = E.step(r3.board, { step: 'end_turn' });                 // p2 turn 2
if (r3.waitingFor.step === 'choose_gig_die') r3 = E.step(r3.board, { step: 'choose_gig_die', sides: 4 });
const bb = r3.board;
bb.p1.zones.field.push({ iid: 'BLK', card_id: 'WNTC-013', state: 'ready', equipped_gear: [], entered_play_turn: bb.turn_number });
bb.p2.zones.field.find(u => u.iid === 'ATK').entered_play_turn = 0;
r3 = E.step(bb, { step: 'declare_attack', attacker_iid: 'ATK', target: { kind: 'gigs' } });
r3 = run(r3, x => x.waitingFor?.step === 'defensive_step');
assert.strictEqual(r3.waitingFor.step, 'defensive_step');
assert.ok(!(r3.waitingFor.blocker_iids || []).includes('BLK'), 'a lagging Unit must not be offered Blocker');
assert.throws(() => E.step(r3.board, { step: 'blocker', iid: 'BLK' }), 'Blocker on a lagging Unit must be rejected');
console.log('ok');
