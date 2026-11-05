// Rule 11.11.1: you pay a cost by spending Eddies and/or Legends of your choice. The defensive
// Call (11.14.2.2) takes pay_iids; with more than one way to pay, omitting it is an error.
'use strict';
const assert = require('assert');
const { E, newGame, unit, eddies, run } = require('./_helpers');

const b = newGame({ seed: 8 });
b.turn_number = 4;
unit(b, 'p2', 'WNTC-124', { iid: 'A2' });
let r = E.step(b, undefined);                                         // p1 turn 5
if (r.waitingFor.step === 'choose_gig_die') r = E.step(r.board, { step: 'choose_gig_die', sides: 4 });
r = E.step(r.board, { step: 'end_turn' });                            // p2 turn 6
if (r.waitingFor.step === 'choose_gig_die') r = E.step(r.board, { step: 'choose_gig_die', sides: 4 });
const [e0, e1] = eddies(r.board, 'p1', 2);
r = E.step(r.board, { step: 'declare_attack', attacker_iid: 'A2', target: { kind: 'gigs' } });
r = run(r, x => x.waitingFor?.step === 'defensive_step');
assert.strictEqual(r.waitingFor.can_call_legend, true, 'setup: p1 can Call defensively');
const leg = r.board.p1.zones.legends.find(l => l.face !== 'face_up');

const r2 = E.step(r.board, { step: 'call_legend_defensive', iid: leg.iid, pay_iids: [e1] });
const p1 = r2.board.p1;
assert.strictEqual(p1.zones.legends.find(l => l.iid === leg.iid).face, 'face_up');
assert.strictEqual(p1.zones.eddies.find(e => e.iid === e1).state, 'spent', 'the chosen Eddie pays');
assert.strictEqual(p1.zones.eddies.find(e => e.iid === e0).state, 'ready', 'an Eddie the player did not choose stays ready');
assert.throws(() => E.step(r.board, { step: 'call_legend_defensive', iid: leg.iid }),
  /pay_iids/, 'with several ways to pay, the player must choose (pay_iids)');
console.log('ok');
