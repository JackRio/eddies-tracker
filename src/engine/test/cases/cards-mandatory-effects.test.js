// Effects without "you may" can't be declined when a legal target exists.
//  Wild in the Streets — FAQ: with only your own spent Unit, you are forced to defeat it.
//  Unlikely Bond — FAQ: no spent rival Unit, you still must bottom-deck a ready friendly Unit.
//  Les Elemens — "Bottom-deck a Rival's lowest-power Unit (If there are multiple, choose 1.)"
//  (Don't Fear) The Reaper — "Then, defeat a spent Unit."
//  The Heist — FAQ: you trash a Gear; you can't choose not to add a Gear to your hand.
//  Three Mouths, One Desire — FAQ: you have to add 1 card from those searched.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, run } = require('./_helpers');

function cast(setup, cardId) {
  const b = mainBoard();
  setup(b);
  b.p1.zones.hand.push({ iid: 'CAST', card_id: cardId });
  let r = { board: b };
  for (const iid of eddies(b, 'p1', 7)) r = E.step(r.board, { step: 'tap_resource', iid });
  return E.step(r.board, { step: 'play_card', iid: 'CAST' });
}
// Try to decline the pending choice; returns the result, or null if the engine refuses.
function decline(r) {
  const cn = r.waitingFor?.choice_needed;
  if (!cn) return r;
  const resp = cn.kind === 'choose_from_top_n' ? { selected_iids: [] } : { iid: null };
  try { return E.step(structuredClone(r.board), { step: 'effect_choice_response', response: resp }); }
  catch { return null; }
}
const finish = r => run(r, x => x.waitingFor?.step === 'main_phase');

// Wild in the Streets: only a spent friendly Unit.
{
  let r = cast(b => unit(b, 'p1', 'WNTC-017', { iid: 'MINE', state: 'spent' }), 'WNTC-105');
  const d = decline(r);
  r = d ? finish(d) : r;
  assert.ok(!r.board.p1.zones.field.some(u => u.iid === 'MINE'), 'Wild in the Streets must defeat your own spent Unit');
}
// Unlikely Bond: two ready friendly Units, no spent rival Unit.
{
  const r = cast(b => { unit(b, 'p1', 'WNTC-017', { iid: 'A' }); unit(b, 'p1', 'WNTC-043', { iid: 'B' }); }, 'WNTC-140');
  const d = decline(r);
  assert.ok(!d || finish(d).board.p1.zones.field.length === 1, 'Unlikely Bond must bottom-deck a ready friendly Unit');
}
// Les Elemens: two rival Units tied for lowest power.
{
  const r = cast(b => { unit(b, 'p2', 'WNTC-017', { iid: 'L1' }); unit(b, 'p2', 'WNTC-017', { iid: 'L2' }); }, 'WNTC-133');
  const d = decline(r);
  assert.ok(!d || finish(d).board.p2.zones.field.length === 1, 'Les Elemens must bottom-deck one of the tied Units');
}
// (Don't Fear) The Reaper: two rival Units, both get spent, then one must be defeated.
{
  const r = cast(b => { unit(b, 'p2', 'WNTC-017', { iid: 'R1' }); unit(b, 'p2', 'WNTC-043', { iid: 'R2' }); }, 'WNTC-098');
  const d = decline(r);
  assert.ok(!d || finish(d).board.p2.zones.field.length === 1, 'The Reaper must defeat a spent Unit');
}
// The Heist: top 4 hold two Gears.
{
  const r = cast(b => {
    b.p1.zones.deck.unshift({ iid: 'G1', card_id: 'WNTC-025' }, { iid: 'G2', card_id: 'WNTC-094' },
                           { iid: 'X1', card_id: 'WNTC-017' }, { iid: 'X2', card_id: 'WNTC-017' });
  }, 'WNTC-070');
  const d = decline(r);
  const hand = d ? finish(d).board.p1.zones.hand : [];
  assert.ok(!d || hand.some(c => c.iid === 'G1' || c.iid === 'G2'), 'The Heist must add a trashed Gear to your hand');
}
// Three Mouths, One Desire: must add at least 1 of the top 3.
{
  const r = cast(b => {
    b.p1.zones.deck.unshift({ iid: 'T1', card_id: 'WNTC-017' }, { iid: 'T2', card_id: 'WNTC-017' }, { iid: 'T3', card_id: 'WNTC-017' });
  }, 'WNTC-137');
  assert.strictEqual(r.waitingFor?.choice_needed?.kind, 'choose_from_top_n', 'setup: Three Mouths shows the top 3');
  const d = decline(r);
  assert.ok(!d || finish(d).board.p1.zones.hand.some(c => /^T[123]$/.test(c.iid)), 'Three Mouths must add 1 card');
}
console.log('ok');
