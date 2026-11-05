// Zetatech Faceplate (WNTC-064: "When this Unit or Legend is spent, adjust a Gig by up
// to 1. Then, if you control 3+ Gigs with different values, draw 1.") — pending-effect
// timing cases from the official FAQ (Faceplate, Overwatch/Panam).
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, eddies, gig } = require('./_helpers');

const RIPPER = 'WNTC-054', FACEPLATE = 'WNTC-064', REAPER = 'WNTC-098';
const RIVER = 'WNTC-039', PANAM = 'WNTC-075', FLOOR_IT = 'WNTC-132';
const fp = (iid = 'fp') => ({ iid, card_id: FACEPLATE });
const isFaceplate = cn => /Zetatech Faceplate/.test(cn.prompt || '');

// Answer every effect_choice; `onChoice(cn, r)` may observe / override (return a response).
function drive(r, onChoice = () => null) {
  for (let i = 0; i < 30 && r.waitingFor?.step === 'effect_choice'; i++) {
    const cn = r.waitingFor.choice_needed;
    const resp = onChoice(cn, r) || (
      cn.kind === 'confirm_optional'    ? { accept: true } :
      cn.kind === 'choose_amount'       ? { amount: Math.max(cn.min, Math.min(cn.max, 1)) } :
      cn.kind === 'choose_from_top_n'   ? { selected_iids: (cn.eligible_iids || []).slice(0, 1) } :
      cn.kind === 'choose_pending_order'? { iid: cn.available_iids[0] } :
                                          { iid: (cn.available_iids || [])[0] ?? null });
    r = E.step(r.board, { step: 'effect_choice_response', response: resp });
  }
  return r;
}
function faceUp(b, pid, slot, card_id, extra = {}) {
  b[pid].zones.legends[slot] = { ...b[pid].zones.legends[slot], card_id, face: 'face_up', state: 'ready',
                                 equipped_gear: [], ...extra };
  return b[pid].zones.legends[slot];
}

// 1. Ripper + Faceplate attack: the controller orders the two; both resolve before the React Step.
{
  const b = mainBoard();
  b.p2.zones.gigs = [gig('x', 4, 1, 'p2')];
  const rip = unit(b, 'p1', RIPPER, { equipped_gear: [fp()] });
  let r = E.step(b, { step: 'declare_attack', attacker_iid: rip.iid, target: { kind: 'gigs' } });
  let order = null;
  r = drive(r, cn => { if (cn.kind === 'choose_pending_order') order = cn.options.map(o => o.card_id).sort(); });
  assert.deepStrictEqual(order, [RIPPER, FACEPLATE].sort(), '1: order offered');
  assert.strictEqual(r.waitingFor.step, 'defensive_step', '1: both resolved before the React Step');
}

// 2. Ripper with 2 Faceplates: three pending effects, all ordered by the controller; 2 adjusts.
{
  const b = mainBoard();
  b.p2.zones.gigs = [gig('x', 4, 1, 'p2')];
  const rip = unit(b, 'p1', RIPPER, { equipped_gear: [fp('fp1'), fp('fp2')] });
  let r = E.step(b, { step: 'declare_attack', attacker_iid: rip.iid, target: { kind: 'gigs' } });
  let firstOrder = null, adjusts = 0;
  r = drive(r, cn => {
    if (cn.kind === 'choose_pending_order' && !firstOrder) firstOrder = cn.options.length;
    if (cn.kind === 'choose_amount' && isFaceplate(cn)) adjusts++;
  });
  assert.strictEqual(firstOrder, 3, '2: all three pending effects offered');
  assert.strictEqual(adjusts, 2, '2: both Faceplates adjusted');
  assert.strictEqual(r.waitingFor.step, 'defensive_step');
}

// 3. Reaper spends p2's Faceplate-equipped Unit, then defeats it: the pending Faceplate
//    effect still resolves afterwards for p2.
{
  const b = mainBoard();
  b.p2.zones.gigs = [gig('pg', 6, 3, 'p2')];
  const u = unit(b, 'p2', 'WNTC-016', { equipped_gear: [fp()] });
  const pay = eddies(b, 'p1', 7);
  b.p1.zones.hand = [{ iid: 'RP', card_id: REAPER }];
  let r = { board: b };
  for (const e of pay) r = E.step(r.board, { step: 'tap_resource', iid: e });
  r = E.step(r.board, { step: 'play_card', iid: 'RP' });
  let fpAsked = false;
  r = drive(r, (cn, rr) => {
    if (isFaceplate(cn)) {
      fpAsked = true;
      assert.ok(rr.board.p2.zones.trash.some(c => c.iid === u.iid), '3: Unit already defeated');
      if (cn.kind !== 'choose_amount') return { iid: 'pg' };
    }
    return null;
  });
  assert.ok(fpAsked, '3: pending Faceplate still resolved');
  assert.strictEqual(r.board.p2.zones.gigs.find(g => g.iid === 'pg').value, 4, '3: p2 adjusted its Gig');
}

// 4. {Spend} ability of a Faceplate-equipped Legend (River Ward plays a Gear): Faceplate
//    resolves only after River Ward's effect has finished.
{
  const b = mainBoard();
  const river = faceUp(b, 'p1', 0, RIVER, { equipped_gear: [fp()] });
  unit(b, 'p1', 'WNTC-016');
  b.p1.zones.hand = [{ iid: 'MAND', card_id: 'WNTC-062' }];
  let r = E.step(b, { step: 'activate_anytime_spend', iid: river.iid, ability_idx: 0 });
  let fpAsked = false;
  r = drive(r, (cn, rr) => {
    if (isFaceplate(cn) && !fpAsked) {
      fpAsked = true;
      assert.ok(!rr.board.p1.zones.hand.some(c => c.iid === 'MAND'), '4: the Gear was already played');
    }
    return null;
  });
  assert.ok(fpAsked, '4: Faceplate triggered');
  assert.strictEqual(r.waitingFor.step, 'main_phase');
}

// 5. A Faceplate-equipped face-up Legend spent to pay for a Program (Floor It: -1 power,
//    draw 1): Faceplate resolves only after the Program has resolved.
{
  const b = mainBoard();
  const leg = faceUp(b, 'p1', 0, RIVER, { equipped_gear: [fp()] });
  unit(b, 'p2', 'WNTC-016');
  b.p1.zones.hand = [{ iid: 'FLOOR', card_id: FLOOR_IT }];
  b.p1.zones.eddies = [];
  let r = E.step(b, { step: 'tap_resource', iid: leg.iid });
  r = E.step(r.board, { step: 'play_card', iid: 'FLOOR' });
  let fpAsked = false;
  r = drive(r, (cn, rr) => {
    if (isFaceplate(cn) && !fpAsked) {
      fpAsked = true;
      assert.ok(rr.board.p1.zones.trash.some(c => c.iid === 'FLOOR'), '5: Floor It finished resolving');
      assert.strictEqual(rr.board.p1.zones.hand.length, 1, "5: Floor It's draw happened first");
    }
    return null;
  });
  assert.ok(fpAsked, '5: Faceplate triggered');
}

// 6. Panam Palmer: Nomad Cavalry with Faceplate: "2 €$, {Spend} Move a Gear from this
//    Legend to an unequipped friendly Unit". Faceplate goes pending on the spend, the
//    effect moves it, and the pending effect still resolves (Overwatch/Panam FAQ).
{
  const b = mainBoard();
  const panam = faceUp(b, 'p1', 0, PANAM, { equipped_gear: [fp()] });
  const target = unit(b, 'p1', 'WNTC-016', { state: 'spent' });
  eddies(b, 'p1', 2);
  let r = E.step(b, { step: 'activate_anytime_spend', iid: panam.iid, ability_idx: 0 });
  let fpAsked = false;
  r = drive(r, (cn, rr) => {
    if (isFaceplate(cn) && !fpAsked) {
      fpAsked = true;
      const host = rr.board.p1.zones.field.find(u => u.iid === target.iid);
      assert.ok(host.equipped_gear.some(g => g.iid === 'fp'), '6: Faceplate already moved to the Unit');
    }
    return null;
  });
  assert.ok(fpAsked, '6: the moved Faceplate still resolved');
  assert.strictEqual(r.board.p1.zones.field.find(u => u.iid === target.iid).state, 'ready');
}
console.log('ok');
