// "The first time this Unit wins a fight each turn, ready it." (Johnny Silverhand: Never Stop
// Fighting). "Each turn" is per turn: confirmed with Weird Co, it readies after winning a fight on
// the rival's turn even though it already readied on its own turn. All first-per-turn rate
// limits reset for BOTH players at every turn start.
'use strict';
const assert = require('assert');
const { E, newGame, unit, run } = require('./_helpers');

const b = newGame({ seed: 4 });
b.turn_number = 4;                                            // past any early-turn attack limits
unit(b, 'p1', 'WNTC-011', { iid: 'J' });                     // Johnny, power 8
unit(b, 'p2', 'WNTC-124', { iid: 'D1', state: 'spent' });    // Psycho Squad, power 6
unit(b, 'p2', 'WNTC-124', { iid: 'A2' });                    // p2's attacker for its own turn

let r = E.step(b, undefined);
if (r.waitingFor.step === 'choose_gig_die') r = E.step(r.board, { step: 'choose_gig_die', sides: 4 });
r = E.step(r.board, { step: 'declare_attack', attacker_iid: 'J', target: { kind: 'unit', iid: 'D1' } });
r = run(r, x => x.waitingFor?.step === 'main_phase');
const j1 = r.board.p1.zones.field.find(u => u.iid === 'J');
assert.ok(j1 && j1.state === 'ready', 'setup: Johnny should ready after its first fight win on its own turn');

j1.state = 'spent';                                           // Johnny spent going into p2's turn
r = E.step(r.board, { step: 'end_turn' });
if (r.waitingFor.step === 'choose_gig_die') r = E.step(r.board, { step: 'choose_gig_die', sides: 4 });
assert.strictEqual(r.board.active_player, 'p2');
r = E.step(r.board, { step: 'declare_attack', attacker_iid: 'A2', target: { kind: 'unit', iid: 'J' } });
r = run(r, x => x.waitingFor?.step === 'main_phase' && x.board.active_player === 'p2');
const j2 = r.board.p1.zones.field.find(u => u.iid === 'J');
assert.ok(j2, 'Johnny should survive the fight (8 vs 6)');
assert.strictEqual(r.board.p2.zones.field.some(u => u.iid === 'A2'), false, 'setup: p2 attacker should lose');
assert.strictEqual(j2.state, 'ready', 'Johnny must ready after its first fight win on the RIVAL\'s turn too');
console.log('ok');
