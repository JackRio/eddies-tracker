// 9.21.3 — the attack ends if the target stops being a valid attack target, e.g. the
// spent defending Unit is readied during the React Step (simulated by a board edit).
'use strict';
const assert = require('assert');
const { E, mainBoard, unit } = require('./_helpers');

const b = mainBoard();
const a = unit(b, 'p1', 'WNTC-018');                         // Screw P7
const d = unit(b, 'p2', 'WNTC-016', { state: 'spent' });     // Royce P4
let r = E.step(b, { step: 'declare_attack', attacker_iid: a.iid, target: { kind: 'unit', iid: d.iid } });
assert.strictEqual(r.waitingFor.step, 'defensive_step');
r.board.p2.zones.field.find(u => u.iid === d.iid).state = 'ready';
r = E.step(r.board, { step: 'pass_defensive' });
assert.strictEqual(r.waitingFor.step, 'main_phase');
assert.ok(r.board.p2.zones.field.some(u => u.iid === d.iid), 'no fight: the readied defender survives');
assert.strictEqual(r.board.current_attack, null);
console.log('ok');
