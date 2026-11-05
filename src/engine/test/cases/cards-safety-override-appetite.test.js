// Safety Override: "The next time a friendly Unit loses a fight this turn, defeat the
// opposing rival Unit."  Appetite for Destruction: "The next time a friendly Unit wins a
// fight by 3+ power this turn, it also steals a Gig."
// FAQ (both): you choose a friendly Unit currently in the field when it resolves, and only
// that Unit is affected. FAQ (Appetite): the Unit is the one stealing — its own steal
// triggers fire (here Maelstrom Goons: "When this Unit steals a Gig, if it's equipped, a
// Rival discards 1").
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, run, gig, pickFirst } = require('./_helpers');

const choose = iid => wf => {
  const cn = wf.choice_needed;
  if (wf.step === 'effect_choice' && cn?.kind === 'choose_unit' && cn.available_iids?.includes(iid))
    return { step: 'effect_choice_response', response: { iid } };
  return pickFirst(wf);
};
const toMain = (r, chooser) => run(r, x => x.waitingFor?.step === 'main_phase' && x.board.active_player === 'p1', chooser);
function cast(b, cardId, pickIid) {
  b.p1.zones.hand.push({ iid: 'CAST_' + cardId, card_id: cardId });
  let r = { board: b };
  for (const iid of eddies(b, 'p1', 4, 'E' + cardId)) r = E.step(r.board, { step: 'tap_resource', iid });
  r = E.step(r.board, { step: 'play_card', iid: 'CAST_' + cardId });
  return toMain(r, choose(pickIid));
}
function attack(r, att, def) {
  r = E.step(r.board, { step: 'declare_attack', attacker_iid: att, target: { kind: 'unit', iid: def } });
  return toMain(r);
}

// --- Safety Override: only the chosen Unit ---------------------------------
{
  const b = mainBoard(); b.turn_number = 3;
  unit(b, 'p1', 'WNTC-017', { iid: 'A' });                       // power 4 (chosen)
  unit(b, 'p1', 'WNTC-043', { iid: 'B' });                       // power 2 (not chosen)
  unit(b, 'p2', 'WNTC-007', { iid: 'X', state: 'spent' });       // power 10
  unit(b, 'p2', 'WNTC-007', { iid: 'Y', state: 'spent' });       // power 10
  let r = cast(b, 'WNTC-069', 'A');
  r = attack(r, 'B', 'X');                                        // B loses: not the chosen Unit
  assert.ok(r.board.p2.zones.field.some(u => u.iid === 'X'), "Safety Override must not fire for a Unit you didn't choose");
  r = attack(r, 'A', 'Y');                                        // A loses: chosen
  assert.ok(!r.board.p2.zones.field.some(u => u.iid === 'Y'), 'Safety Override fires when the chosen Unit loses');
}

// --- Appetite for Destruction: the chosen Unit steals (its steal triggers fire) ---
{
  const b = mainBoard(); b.turn_number = 3;
  b.p2.zones.gigs = [gig('G1', 6, 3, 'p2'), gig('G2', 8, 5, 'p2')];
  for (let i = 0; i < 4; i++) b.p2.zones.hand.push({ iid: 'H' + i, card_id: 'WNTC-017' });
  unit(b, 'p1', 'WNTC-049', { iid: 'GOON', _temp_power: 6,       // Maelstrom Goons 3+1+6 = 10, equipped
    equipped_gear: [{ iid: 'MB', card_id: 'WNTC-025' }] });
  unit(b, 'p1', 'WNTC-007', { iid: 'BIG' });                      // power 10, not chosen
  unit(b, 'p2', 'WNTC-017', { iid: 'V1', state: 'spent' });       // power 4
  unit(b, 'p2', 'WNTC-017', { iid: 'V2', state: 'spent' });       // power 4
  let r = cast(b, 'WNTC-028', 'GOON');
  r = attack(r, 'BIG', 'V1');                                     // BIG wins by 6: not chosen, no steal
  assert.strictEqual(r.board.p2.zones.gigs.length, 2, "Appetite must not fire for a Unit you didn't choose");
  r = attack(r, 'GOON', 'V2');                                    // chosen Unit wins by 6: steals a Gig
  assert.strictEqual(r.board.p2.zones.gigs.length, 1, 'the chosen Unit steals a Gig');
  assert.strictEqual(r.board.p2.zones.hand.length, 3, "the Goons' own steal trigger fires (Rival discards 1)");
}
console.log('ok');
