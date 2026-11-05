// Rules 10.16 / 10.10.1 — a trigger that went pending still resolves after its source
// leaves the field. p1 plays (Don't Fear) The Reaper ("Spend all rival Units. Then,
// defeat a spent Unit."): it spends p2's Rita Wheeler ("The first time this Unit is
// spent each turn, draw 1, then discard 1.") and then defeats Rita. Rita's trigger was
// pending from the spend, so after Reaper finishes p2 still draws 1 and discards 1.
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, eddies } = require('./_helpers');

const REAPER = 'WNTC-098', RITA = 'WNTC-125';
const b = mainBoard();
const rita = unit(b, 'p2', RITA);
b.p2.zones.hand = [{ iid: 'H1', card_id: 'WNTC-074' }, { iid: 'H2', card_id: 'WNTC-132' }];
const pay = eddies(b, 'p1', E.CARDS.find(c => c.number === REAPER).cost);
b.p1.zones.hand = [{ iid: 'RP', card_id: REAPER }];
let r = { board: b };
for (const e of pay) r = E.step(r.board, { step: 'tap_resource', iid: e });
r = E.step(r.board, { step: 'play_card', iid: 'RP' });

let discardAsked = false;
for (let i = 0; i < 10 && r.waitingFor?.step === 'effect_choice'; i++) {
  const cn = r.waitingFor.choice_needed;
  const ids = cn.available_iids || [];
  if (/Rita/.test(cn.prompt || '')) {
    discardAsked = true;
    assert.ok(r.board.p2.zones.trash.some(c => c.iid === rita.iid), "Reaper's defeat happened before Rita's trigger");
    assert.strictEqual(r.board.p2.zones.hand.length, 3, 'Rita drew 1 first');
  }
  r = E.step(r.board, { step: 'effect_choice_response',
    response: cn.kind === 'confirm_optional' ? { accept: true } : { iid: ids.includes(rita.iid) ? rita.iid : ids[0] } });
}
assert.ok(discardAsked, "Rita's pending trigger resolved although Rita left the field");
assert.strictEqual(r.waitingFor.step, 'main_phase');
assert.strictEqual(r.board.p2.zones.hand.length, 2, 'drew 1, discarded 1');
assert.strictEqual(r.board.p2.zones.trash.length, 2, 'Rita + the discarded card');
console.log('ok');
