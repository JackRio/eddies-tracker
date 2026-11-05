// 11.4.2.2.1 / 11.4.2.3 — fight and {Defeated} triggers become pending and resolve after
// the fight (both losers already defeated), turn player's first (10.15).
// Screw (P7) attacks Screw (P7): tie, both lose and are defeated; each Screw's
// {Defeated} asks its controller to pick a Unit from the trash.
'use strict';
const assert = require('assert');
const { E, mainBoard, unit } = require('./_helpers');

const b = mainBoard();
const a = unit(b, 'p1', 'WNTC-018');
const d = unit(b, 'p2', 'WNTC-018', { state: 'spent' });
for (const p of ['p1', 'p2'])
  b[p].zones.trash.push({ iid: p + 't1', card_id: 'WNTC-016' }, { iid: p + 't2', card_id: 'WNTC-019' });
let r = E.step(b, { step: 'declare_attack', attacker_iid: a.iid, target: { kind: 'unit', iid: d.iid } });
r = E.step(r.board, { step: 'pass_defensive' });
assert.strictEqual(r.waitingFor.step, 'effect_choice');
assert.strictEqual(r.waitingFor.owner, 'p1', 'turn player resolves first');
assert.ok(!r.board.p1.zones.field.some(u => u.iid === a.iid), 'attacker already defeated');
assert.ok(!r.board.p2.zones.field.some(u => u.iid === d.iid), 'defender already defeated');
r = E.step(r.board, { step: 'effect_choice_response', response: { iid: 'p1t1' } });
assert.strictEqual(r.waitingFor.step, 'effect_choice');
assert.strictEqual(r.waitingFor.owner, 'p2', 'then the non-turn player');
r = E.step(r.board, { step: 'effect_choice_response', response: { iid: 'p2t1' } });
assert.strictEqual(r.waitingFor.step, 'main_phase');
assert.ok(r.board.p1.zones.hand.some(c => c.iid === 'p1t1') && r.board.p2.zones.hand.some(c => c.iid === 'p2t1'));
console.log('ok');
