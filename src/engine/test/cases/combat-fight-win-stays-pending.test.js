// 11.4.2.2.1 + 10.15 — "when this wins a fight" becomes pending when the winner is
// declared and still resolves even if the winner has left the field by then.
// p1 Maelstrom Zealots (P0, "when this loses a fight, defeat the opposing Unit")
// attacks p2 Royce wearing Satori ("when this Unit wins a fight, draw 1").
'use strict';
const assert = require('assert');
const { E, mainBoard, unit } = require('./_helpers');

const b = mainBoard();
const z = unit(b, 'p1', 'WNTC-079');
const d = unit(b, 'p2', 'WNTC-016', { state: 'spent', equipped_gear: [{ iid: 'satori', card_id: 'WNTC-026' }] });
const hand0 = b.p2.zones.hand.length;
let r = E.step(b, { step: 'declare_attack', attacker_iid: z.iid, target: { kind: 'unit', iid: d.iid } });
r = E.step(r.board, { step: 'pass_defensive' });
assert.strictEqual(r.waitingFor.step, 'main_phase');
assert.ok(!r.board.p2.zones.field.some(u => u.iid === d.iid), 'Zealots defeated the winner');
assert.strictEqual(r.board.p2.zones.hand.length, hand0 + 1, 'the pending Satori draw still resolved');
console.log('ok');
