// Rules 5.7.3 / 11.14.2: Call a Legend once per TURN (not per player-turn). Both players'
// Call flags reset at every turn start, and a defensive Call shares the one limit.
'use strict';
const assert = require('assert');
const { E, newGame, unit, run } = require('./_helpers');

// (a) p1 Calls on turn 1; on p2's turn 2 the limit has reset for p1 too.
const b = newGame({ seed: 3 });
let r = E.step(b, undefined);
r = E.step(r.board, { step: 'choose_gig_die', sides: 4 });
const L = r.board.p1.zones.legends.find(l => l.state === 'ready');
r = E.step(r.board, { step: 'tap_resource', iid: L.iid });
r = E.step(r.board, { step: 'call_legend', iid: L.iid });
r = E.step(r.board, { step: 'end_turn' });
if (r.waitingFor.step === 'choose_gig_die') r = E.step(r.board, { step: 'choose_gig_die', sides: 4 });
assert.strictEqual(r.board.active_player, 'p2');
assert.strictEqual(r.board.p1.called_legend_this_turn, false, 'p1 Call flag must reset at the start of p2\'s turn');

// (b) a Call already made this turn (here: by a card effect) blocks the defensive Call.
const bb = r.board;
unit(bb, 'p2', 'WNTC-124', { iid: 'ATK' });
bb.p1.called_legend_this_turn = true;                        // e.g. Radioport called on this turn
r = E.step(bb, { step: 'declare_attack', attacker_iid: 'ATK', target: { kind: 'gigs' } });
r = run(r, x => x.waitingFor?.step === 'defensive_step');
assert.strictEqual(r.waitingFor.step, 'defensive_step');
assert.strictEqual(r.waitingFor.can_call_legend, false, 'one Call per turn: no defensive Call after another Call this turn');
const fd = r.board.p1.zones.legends.find(l => l.face !== 'face_up');
assert.throws(() => E.step(r.board, { step: 'call_legend_defensive', iid: fd.iid, pay_iids: [] }), 'defensive Call must be rejected');
console.log('ok');
