// Pyramid Song: "Choose one effect. If a friendly d4 is a min Gig, choose both instead.
// Give a rival Unit -4 power this turn. // Bottom-deck a rival Unit with power 0."
// The upstream data said -5, so with a min d4 a 5-power Unit (Meredith Stout) dropped to 0 and was
// then bottom-decked. At -4 she is at 1 power and stays on the field.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, gig, run } = require('./_helpers');

const b = mainBoard();
unit(b, 'p2', 'WNTC-014', { iid: 'mer' });                 // Meredith Stout, power 5
b.p1.zones.gigs = [gig('d4', 4, 1, 'p1')];                 // a friendly d4 at its min: both effects
b.p1.zones.hand = [{ iid: 'ps', card_id: 'WNTC-135' }];
b.p1.tapped = eddies(b, 'p1', 3);
const r = run(E.step(b, { step: 'play_card', iid: 'ps' }), x => x.waitingFor?.step === 'main_phase');
const mer = r.board.p2.zones.field.find(u => u.iid === 'mer');
assert.ok(mer, 'Meredith (5 power, -4 = 1) is not a power-0 Unit, so she stays on the field');
assert.strictEqual(mer._temp_power, -4, 'Pyramid Song gives -4 power, not -5');
console.log('ok');
