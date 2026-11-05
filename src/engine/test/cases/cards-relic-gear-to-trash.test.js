// The Relic: Experimental Biochip — "{Defeated} Play another Unit with cost 9 or less from
// your trash for free. Then, bottom-deck this Unit."  The Unit IS defeated (its own
// {Defeated} fires), its Gear stays in the trash (FAQ: the Relic is not bottom-decked;
// rule 11.23 example), the other Unit comes back, then this Unit is bottom-decked.
// Generally, a Unit leaving the field to hand/deck leaves its Gear in the trash
// (rule 11.9.1.2) — checked with Les Elemens bottom-decking an equipped rival Unit.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, run } = require('./_helpers');

// --- The Relic -------------------------------------------------------------
{
  const b = mainBoard();
  // Caliber (WNTC-044, {Defeated}: a Rival discards 1 ...) equipped with The Relic, spent.
  unit(b, 'p1', 'WNTC-044', { iid: 'CAL', state: 'spent', equipped_gear: [{ iid: 'RELIC', card_id: 'WNTC-063' }] });
  b.p1.zones.trash.push({ iid: 'NEG', card_id: 'WNTC-043' }); // Augmented Negotiators, cost 3
  for (let i = 0; i < 4; i++) b.p2.zones.hand.push({ iid: 'H' + i, card_id: 'WNTC-017' });
  b.p1.zones.hand.push({ iid: 'WILD', card_id: 'WNTC-105' }); // Wild in the Streets: defeat a spent Unit
  let r = { board: b };
  for (const iid of eddies(b, 'p1', 5)) r = E.step(r.board, { step: 'tap_resource', iid });
  r = E.step(r.board, { step: 'play_card', iid: 'WILD' });
  r = run(r, x => x.waitingFor?.step === 'main_phase' && x.board.active_player === 'p1');
  const z = r.board.p1.zones;
  assert.ok(z.field.some(u => u.iid === 'NEG'), 'another Unit is played from the trash');
  assert.strictEqual(z.deck[z.deck.length - 1]?.iid, 'CAL', 'the defeated Unit is bottom-decked');
  assert.ok(z.trash.some(c => c.iid === 'RELIC'), 'The Relic stays in the trash');
  assert.ok(!z.deck.some(c => c.iid === 'RELIC'), 'The Relic must not be bottom-decked');
  assert.ok(r.board.p2.zones.hand.length < 4, "the Unit is really defeated: its own {Defeated} (rival discards) fires");
}

// --- bottom-deck an equipped Unit: its Gear goes to the trash ---------------
{
  const b = mainBoard();
  unit(b, 'p2', 'WNTC-017', { iid: 'LOW', equipped_gear: [{ iid: 'BLADES', card_id: 'WNTC-025' }] }); // power 4+1
  unit(b, 'p2', 'WNTC-007', { iid: 'BIG' });                                                          // power 10
  b.p1.zones.hand.push({ iid: 'LES', card_id: 'WNTC-133' });  // Les Elemens: bottom-deck lowest-power rival Unit
  let r = { board: b };
  for (const iid of eddies(b, 'p1', 5)) r = E.step(r.board, { step: 'tap_resource', iid });
  r = E.step(r.board, { step: 'play_card', iid: 'LES' });
  r = run(r, x => x.waitingFor?.step === 'main_phase' && x.board.active_player === 'p1');
  const z = r.board.p2.zones;
  assert.ok(!z.field.some(u => u.iid === 'LOW'), 'setup: Les Elemens bottom-decks the lowest-power Unit');
  assert.ok(z.trash.some(c => c.iid === 'BLADES'), "the bottom-decked Unit's Gear goes to the trash");
  assert.ok(!z.deck.some(c => c.iid === 'BLADES'), 'Gear must not follow the Unit into the deck');
}
console.log('ok');
