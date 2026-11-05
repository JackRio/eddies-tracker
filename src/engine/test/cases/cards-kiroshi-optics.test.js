// Kiroshi Optics: "{Attack} Look at a friendly face-down Legend." FAQ: "do you have to
// look at all your current friendly face-down Legends? Yes." Not optional, no choice.
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig, run } = require('./_helpers');

const b = mainBoard();
b.turn_number = 3;
for (const l of b.p1.zones.legends) { l.face = 'face_down'; l.state = 'ready'; }
b.p2.zones.gigs = [gig('a', 4, 1, 'p2')];
unit(b, 'p1', 'WNTC-077', { iid: 'k', equipped_gear: [{ iid: 'ko', card_id: 'WNTC-061' }] });
let sawLegendChoice = false;
let r = E.step(b, { step: 'declare_attack', attacker_iid: 'k', target: { kind: 'gigs' } });
r = run(r, x => x.board.p1.zones.legends.some(l => l._peeked) || x.waitingFor?.step === 'main_phase', wf => {
  if (wf.step === 'effect_choice' && wf.choice_needed.kind === 'choose_legend') sawLegendChoice = true;
  return null;
});
assert.strictEqual(sawLegendChoice, false, 'no choice of Legend: all of them are looked at');
assert.ok(r.board.p1.zones.legends.every(l => l._peeked), 'every face-down Legend was looked at');
console.log('ok');
