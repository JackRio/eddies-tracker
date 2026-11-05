// Rule 10.14.1 — a player with 2+ pending effects at the same time chooses their order
// (choose_pending_order). Sketchy Ripper wearing Zetatech Faceplate attacks: spending it
// (Faceplate: adjust a Gig, then draw 1 if 3+ different Gig values) and its {Attack}
// (search the top 3 for a Gear, bottom-deck the rest) go pending together (11.25.2.1).
// The order changes which cards end up in hand:
//   Faceplate first: draw X (top), then Ripper finds Gear G in the next 3  -> hand X, G
//   Ripper first:    Ripper takes G from X,G,Y; then Faceplate draws Z      -> hand G, Z
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig } = require('./_helpers');

const RIPPER = 'WNTC-054', FACEPLATE = 'WNTC-064';
function attack(firstCard, viaOrder) {
  const b = mainBoard();
  b.p1.zones.gigs = [gig('a', 4, 2, 'p1'), gig('c', 6, 5, 'p1'), gig('d', 8, 8, 'p1')];
  b.p2.zones.gigs = [gig('x', 4, 1, 'p2')];
  b.p1.zones.deck = [
    { iid: 'X', card_id: 'WNTC-016' }, { iid: 'G', card_id: 'WNTC-094' },
    { iid: 'Y', card_id: 'WNTC-019' }, { iid: 'Z', card_id: 'WNTC-018' },
    { iid: 'W', card_id: 'WNTC-017' }, ...b.p1.zones.deck];
  const rip = unit(b, 'p1', RIPPER, { equipped_gear: [{ iid: 'fp', card_id: FACEPLATE }] });
  let r = E.step(b, { step: 'declare_attack', attacker_iid: rip.iid, target: { kind: 'gigs' } });
  let asked = null;
  for (let i = 0; i < 15 && r.waitingFor?.step === 'effect_choice'; i++) {
    const cn = r.waitingFor.choice_needed;
    let resp;
    if (cn.kind === 'choose_pending_order') {
      asked = cn;
      assert.strictEqual(r.waitingFor.owner, 'p1');
      const pick = cn.options.find(o => o.card_id === firstCard).id;
      resp = viaOrder ? { order: [pick, ...cn.available_iids.filter(id => id !== pick)] } : { iid: pick };
    } else if (cn.kind === 'choose_from_top_n') resp = { selected_iids: ['G'] };
    else if (cn.kind === 'choose_amount') resp = { amount: 0 };
    else resp = { iid: cn.available_iids[0] };
    r = E.step(r.board, { step: 'effect_choice_response', response: resp });
  }
  assert.ok(asked, 'the controller is asked to order the pending effects');
  assert.deepStrictEqual(asked.options.map(o => o.card_id).sort(), [RIPPER, FACEPLATE].sort());
  assert.strictEqual(r.waitingFor.step, 'defensive_step', 'both resolved before the React Step');
  return r.board.p1.zones.hand.map(c => c.iid).sort();
}

assert.deepStrictEqual(attack(FACEPLATE, false), ['G', 'X'], 'Faceplate first: draw X, then find G');
assert.deepStrictEqual(attack(RIPPER, false), ['G', 'Z'], 'Ripper first: find G, then draw Z');
assert.deepStrictEqual(attack(RIPPER, true), ['G', 'Z'], 'full-order response works too');

// Bad responses are refused.
const b = mainBoard();
b.p1.zones.gigs = [gig('a', 4, 2, 'p1')]; b.p2.zones.gigs = [gig('x', 4, 1, 'p2')];
const rip = unit(b, 'p1', RIPPER, { equipped_gear: [{ iid: 'fp', card_id: FACEPLATE }] });
const r = E.step(b, { step: 'declare_attack', attacker_iid: rip.iid, target: { kind: 'gigs' } });
assert.strictEqual(r.waitingFor.choice_needed.kind, 'choose_pending_order');
assert.throws(() => E.step(r.board, { step: 'effect_choice_response', response: { iid: 'nope' } }));
assert.throws(() => E.step(r.board, { step: 'effect_choice_response', response: { order: [r.waitingFor.choice_needed.available_iids[0]] } }));
console.log('ok');
