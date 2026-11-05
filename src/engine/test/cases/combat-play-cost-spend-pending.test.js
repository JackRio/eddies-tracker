// Rules 10.14.1 / 10.15 — playing a Unit: the "when spent" triggers of what paid its
// cost and the Unit's own {Play} go pending as ONE set, and the controller orders them.
// p1 pays for Field Operator ("{Play} If your Street Cred is even, draw 1.") with a
// face-up River Ward wearing Zetatech Faceplate ("When this Unit or Legend is spent,
// adjust a Gig by up to 1. Then, if you control 3+ Gigs with different values, draw 1.").
// Street Cred starts odd (3+5+9 = 17); Faceplate adds 1 to a Gig (-> 18, even):
//   Faceplate first:      Faceplate draws, then Field Operator sees 18 and draws -> +2
//   Field Operator first: 17 is odd, no draw; then Faceplate draws               -> +1
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig } = require('./_helpers');

const FACEPLATE = 'WNTC-064', FIELD_OP = 'WNTC-078', RIVER = 'WNTC-039';
function play(first) {
  const b = mainBoard();
  b.p1.zones.gigs = [gig('a', 4, 3, 'p1'), gig('c', 6, 5, 'p1'), gig('d', 10, 9, 'p1')];
  const leg = b.p1.zones.legends[0] = { ...b.p1.zones.legends[0], card_id: RIVER, face: 'face_up', state: 'ready',
                                        equipped_gear: [{ iid: 'fp', card_id: FACEPLATE }] };
  b.p1.zones.eddies = [];
  const pay = [leg.iid, ...eddies(b, 'p1', 2)];
  b.p1.zones.hand = [{ iid: 'FO', card_id: FIELD_OP }];
  let r = { board: b };
  for (const iid of pay) r = E.step(r.board, { step: 'tap_resource', iid });
  r = E.step(r.board, { step: 'play_card', iid: 'FO' });
  let asked = null;
  for (let i = 0; i < 15 && r.waitingFor?.step === 'effect_choice'; i++) {
    const cn = r.waitingFor.choice_needed;
    let resp;
    if (cn.kind === 'choose_pending_order') {
      asked = cn.options.map(o => o.card_id).sort();
      resp = { iid: cn.options.find(o => o.card_id === first).id };
    } else if (cn.kind === 'choose_amount') resp = { amount: 1 };
    else resp = { iid: cn.available_iids.includes('a') ? 'a' : cn.available_iids[0] };
    r = E.step(r.board, { step: 'effect_choice_response', response: resp });
  }
  assert.deepStrictEqual(asked, [FACEPLATE, FIELD_OP].sort(), 'cost-spend and {Play} triggers ordered together');
  assert.strictEqual(r.waitingFor.step, 'main_phase');
  return r.board.p1.zones.hand.length;
}

assert.strictEqual(play(FACEPLATE), 2, 'Faceplate first: Street Cred becomes even, both draw');
assert.strictEqual(play(FIELD_OP), 1, 'Field Operator first: odd Street Cred, only Faceplate draws');
console.log('ok');
