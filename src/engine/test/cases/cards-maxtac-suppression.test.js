// MaxTac Suppression Team: "Rival Units can't attack the turn they're played."
// FAQ: "If I played a Legend with Go Solo, can it declare an attack if my rival has a
// MaxTac Suppression Team?" No. Rule 4.2.1: Legends on the field are both Units and
// Legends, so type 'Unit' filters (auras, targets, triggers) must include them.
'use strict';
const assert = require('assert');
const { E, mainBoard, mainWaiting, eddies, gig } = require('./_helpers');

function soloJackie(withMaxTac) {
  const b = mainBoard();
  b.turn_number = 3;                                          // attacks allowed from turn 3
  b.p2.zones.gigs.push(gig('G2', 6, 3, 'p2'));               // something to attack
  if (withMaxTac)
    b.p2.zones.field.push({ iid: 'MT', card_id: 'WNTC-050', state: 'ready', equipped_gear: [], entered_play_turn: 0 });
  b.p1.zones.legends.push({ iid: 'JW', card_id: 'WNTC-073', state: 'ready', face: 'face_up', equipped_gear: [] });
  const ids = eddies(b, 'p1', 6);
  let r = { board: b };
  for (const iid of ids) r = E.step(r.board, { step: 'tap_resource', iid });
  r = E.step(r.board, { step: 'play_legend_solo', iid: 'JW' });
  assert.ok(r.board.p1.zones.field.some(u => u.iid === 'JW'), 'setup: Jackie should be on the field');
  return mainWaiting(r.board).attackable || [];
}

assert.ok(soloJackie(false).includes('JW'), 'setup: a Go Solo Legend can normally attack the turn it is played');
assert.ok(!soloJackie(true).includes('JW'),
  'with a rival MaxTac Suppression Team, a Go Solo Legend must not be able to attack the turn it is played');
console.log('ok');
