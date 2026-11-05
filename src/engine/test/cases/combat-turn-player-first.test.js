// Rule 10.15 — when both players have pending effects at once, the TURN player's
// resolve first (not "p1, then p2"). Outside of combat here.
// It is p2's turn. p2 plays Wild in the Streets ("Defeat a spent Unit") on p1's spent,
// equipped Field Operator (ARASAKA). Two triggers go pending together:
//   p1 River Ward: Detective on the Hunt — "When a friendly equipped Unit is defeated,
//      search the top 2 cards of your deck and trash 1." (asks p1 a question)
//   p2 Yorinobu Arasaka: Steel Dragon — "The first time an ARASAKA Unit is defeated
//      each turn, draw 1."
// p2 is the turn player, so Yorinobu's draw must already have happened when River
// Ward asks p1 anything.
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, eddies } = require('./_helpers');

const b = mainBoard();
b.active_player = 'p2';
b.p1.zones.legends[0] = { ...b.p1.zones.legends[0], card_id: 'WNTC-039', face: 'face_up', state: 'ready' };
const op = unit(b, 'p1', 'WNTC-078', { state: 'spent', equipped_gear: [{ iid: 'mand', card_id: 'WNTC-062' }] });
unit(b, 'p2', 'WNTC-022');                                   // Yorinobu: Steel Dragon (ready)
const pay = eddies(b, 'p2', 5);
b.p2.zones.hand = [{ iid: 'WILD', card_id: 'WNTC-105' }];
const hand0 = 0;

let r = { board: b };
for (const e of pay) r = E.step(r.board, { step: 'tap_resource', iid: e });
r = E.step(r.board, { step: 'play_card', iid: 'WILD' });
let sawRiver = false;
for (let i = 0; i < 10 && r.waitingFor?.step === 'effect_choice'; i++) {
  const cn = r.waitingFor.choice_needed;
  if (r.waitingFor.owner === 'p1') {                          // River Ward's search
    sawRiver = true;
    assert.ok(!r.board.p1.zones.field.some(u => u.iid === op.iid), 'Field Operator already defeated');
    assert.strictEqual(r.board.p2.zones.hand.length, hand0 + 1,
      "turn player's Yorinobu draw resolved before the rival's River Ward");
  }
  const ids = cn.available_iids || cn.eligible_iids || [];
  r = E.step(r.board, { step: 'effect_choice_response',
    response: cn.kind === 'confirm_optional' ? { accept: true }
            : cn.kind === 'choose_from_top_n' ? { selected_iids: ids.slice(0, cn.take_min || 0) }
            : { iid: ids.includes(op.iid) ? op.iid : (ids[0]?.iid || ids[0] || null) } });
}
assert.ok(sawRiver, 'River Ward triggered');
assert.strictEqual(r.waitingFor.step, 'main_phase');
assert.strictEqual(r.board.p2.zones.hand.length, hand0 + 1, 'Yorinobu drew once');
console.log('ok');
