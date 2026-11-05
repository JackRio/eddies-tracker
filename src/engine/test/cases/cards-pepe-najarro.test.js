// Pepe Najarro: Working Doubles — "{Attack} If you control a value-pair of Gigs, ready up to 2
// MERC Legends in your Legends area."
// A face-down Legend shows no information (rule 5.3.2.3), so it is not a "MERC Legend":
// only face-up Merc Legends qualify. Readying a ready Legend does nothing, so the two picks
// go to spent ones. Here: two spent face-up Mercs and one spent face-down Merc.
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, run, gig, pickFirst } = require('./_helpers');

const b = mainBoard(); b.turn_number = 3;
b.p1.zones.gigs = [gig('A', 6, 4, 'p1'), gig('B', 8, 4, 'p1')];         // value-pair (4, 4)
b.p2.zones.gigs = [gig('C', 6, 2, 'p2')];
b.p1.zones.legends = [
  { iid: 'FD',  card_id: 'WNTC-109', state: 'spent', face: 'face_down', equipped_gear: [] }, // Sasha (Merc)
  { iid: 'FU1', card_id: 'WNTC-073', state: 'spent', face: 'face_up',   equipped_gear: [] }, // Jackie (Merc)
  { iid: 'FU2', card_id: 'WNTC-040', state: 'spent', face: 'face_up',   equipped_gear: [] }, // Rogue (Merc)
];
unit(b, 'p1', 'WNTC-086', { iid: 'PEPE' });

let offeredFD = false;
const chooser = wf => {
  const cn = wf.choice_needed;
  if (wf.step === 'effect_choice' && cn?.kind === 'choose_units') {
    if (cn.available_iids.includes('FD')) offeredFD = true;
    return { step: 'effect_choice_response', response: { selected_iids: cn.available_iids.slice(0, cn.take_up_to) } };
  }
  return pickFirst(wf);
};
let r = E.step(b, { step: 'declare_attack', attacker_iid: 'PEPE', target: { kind: 'gigs' } });
r = run(r, x => x.waitingFor?.step === 'main_phase' && x.board.active_player === 'p1', chooser);
const L = id => r.board.p1.zones.legends.find(l => l.iid === id);
assert.ok(!offeredFD, 'a face-down Legend must not be offered as a MERC Legend');
assert.strictEqual(L('FU1').state, 'ready', 'face-up Merc Legend readied');
assert.strictEqual(L('FU2').state, 'ready', 'face-up Merc Legend readied');
assert.strictEqual(L('FD').state, 'spent', 'face-down Legend stays spent');
console.log('ok');
