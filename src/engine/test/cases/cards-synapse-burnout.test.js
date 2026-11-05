// "friendly face-up Legends" includes Legends on the field (Go Solo), not just the Legends area.
// FAQ Synapse Burnout: "+1 power for each friendly face-up Legend in the Legends and Field area? Yes."
// FAQ Panam Palmer: Strength Through Family counts "the field and the Legends area".
// Synapse's bonus is "has +1 ... while fighting": it counts Legends at the fight, so a Legend
// Called after the Program resolved still adds +1.
// Zetatech Berserk: "-1 $ for each friendly face-up Legend" uses the same count.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies } = require('./_helpers');

const b = mainBoard();
const legs = b.p1.zones.legends;
for (const l of legs) l.face = 'face_down';
legs[0].face = 'face_up';                                       // 1 face-up Legend in the Legends area
b.p1.zones.legends.push({ iid: 'JW', card_id: 'WNTC-073', state: 'ready', face: 'face_up', equipped_gear: [] });
let r = { board: b };
for (const iid of eddies(b, 'p1', 6, 'S')) r = E.step(r.board, { step: 'tap_resource', iid });
r = E.step(r.board, { step: 'play_legend_solo', iid: 'JW' });   // Jackie (power 8) now on the field

// Zetatech Berserk (cost 6): 2 face-up Legends (area + field) -> 4.
const zb = { iid: 'ZB', card_id: 'WNTC-096' };
assert.strictEqual(E.effectivePlayCost(r.board, 'p1', zb, E.CARDS.find(c => c.number === 'WNTC-096')), 4,
  'Zetatech Berserk should count the Go Solo Legend on the field');

r.board.p1.zones.hand.push({ iid: 'SB', card_id: 'WNTC-102' });
const [e] = eddies(r.board, 'p1', 1, 'T');
r = E.step(r.board, { step: 'tap_resource', iid: e });
r = E.step(r.board, { step: 'play_card', iid: 'SB' });
while (r.waitingFor?.step === 'effect_choice')
  r = E.step(r.board, { step: 'effect_choice_response', response: { iid: 'JW', accept: true } });

const fightPower = () => {
  const j = r.board.p1.zones.field.find(u => u.iid === 'JW');
  return E.applyStaticPower(r.board, 'p1', j, { role: 'attacker', during_fight: true, opp_type: 'Unit' });
};
assert.strictEqual(fightPower(), 8 + 2, 'Synapse: +1 per face-up Legend, counting the one on the field');

r.board.p1.zones.legends[1].face = 'face_up';                  // another Legend is Called later
assert.strictEqual(fightPower(), 8 + 3, 'Synapse counts face-up Legends at the fight, not at resolution');
console.log('ok');
